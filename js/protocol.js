/*
 * Pixl.js file-transfer protocol client.
 *
 * Talks the binary request/response protocol the Pixl.js firmware exposes over the
 * Nordic UART Service (see fw/application/src/mod/df in the pixl.js repo).
 *
 * Frame:  cmd u8 | status u8 | chunk u16 LE | payload (<= 243 bytes)
 * chunk bit 15 set = more frames follow; low 15 bits = sequence number.
 *
 * Reliability features the stock web app lacks:
 *  - every request has a timeout, so a dropped packet can never freeze the queue
 *  - chunk sequence numbers are checked, so lost frames are detected instead of
 *    silently producing corrupt files
 *  - after a timeout we wait for the link to go quiet before the next request, so a
 *    late reply can't be mistaken for the answer to a different question
 *  - file open/read/write/close run under one lock so nothing can interleave with
 *    the firmware's single open-file slot
 *  - transient GATT errors are retried; open flags are sent as the u32 the firmware
 *    expects; every drive in the drive list is parsed
 */
(function (global) {
  'use strict';

  const Pixl = (global.Pixl = global.Pixl || {});

  const CMD = {
    VERSION: 0x01,
    ENTER_DFU: 0x02,
    DRIVE_LIST: 0x10,
    DRIVE_FORMAT: 0x11,
    FILE_OPEN: 0x12,
    FILE_CLOSE: 0x13,
    FILE_READ: 0x14,
    FILE_WRITE: 0x15,
    DIR_READ: 0x16,
    DIR_CREATE: 0x17,
    REMOVE: 0x18,
    RENAME: 0x19,
    UPDATE_META: 0x1a,
  };
  const CMD_NAMES = {};
  Object.keys(CMD).forEach((k) => (CMD_NAMES[CMD[k]] = k));

  // vfs_mode_t in firmware
  const MODE_APPEND = 1 << 0;
  const MODE_TRUNC = 1 << 1;
  const MODE_CREATE = 1 << 2;
  const MODE_READONLY = 1 << 3;
  const MODE_WRITEONLY = 1 << 4;
  const OPEN_READ = MODE_READONLY;
  const OPEN_WRITE = MODE_TRUNC | MODE_CREATE | MODE_WRITEONLY;

  const HEADER_LEN = 4;
  const PAYLOAD_MAX = 243;
  const SAFE_WRITE_DATA = 15; // fits the 20-byte default BLE MTU: 4 header + 1 file id + 15

  const LIMITS = { pathBytes: 63, nameBytes: 47, notesBytes: 90 };

  const VFS_ERRORS = {
    '-1': 'general failure',
    '-2': 'out of memory',
    '-3': 'end of file',
    '-4': 'already exists',
    '-5': 'name too long',
    '-6': 'drive not available',
    '-7': 'file system corrupt',
    '-90': 'not found',
    '-91': 'drive is full',
    '-99': 'not supported',
  };

  const enc = new TextEncoder();
  const dec = new TextDecoder();
  const EMPTY = new Uint8Array(0);
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  /* ------------------------------------------------------------------ errors */

  class PixlError extends Error {
    constructor(message, opts) {
      super(message);
      opts = opts || {};
      this.name = 'PixlError';
      this.code = opts.code || 'ERROR';
      this.retryable = !!opts.retryable;
      this.status = opts.status;
      if (opts.cause) this.cause = opts.cause;
    }
  }

  function abortError() {
    return new PixlError('Canceled', { code: 'ABORTED' });
  }

  /* -------------------------------------------------------------- byte utils */

  class Writer {
    constructor() {
      this.buf = new Uint8Array(64);
      this.len = 0;
    }
    _grow(n) {
      if (this.len + n <= this.buf.length) return;
      let cap = this.buf.length * 2;
      while (cap < this.len + n) cap *= 2;
      const nb = new Uint8Array(cap);
      nb.set(this.buf.subarray(0, this.len));
      this.buf = nb;
    }
    u8(v) {
      this._grow(1);
      this.buf[this.len++] = v & 0xff;
      return this;
    }
    u16(v) {
      return this.u8(v).u8(v >>> 8);
    }
    u32(v) {
      return this.u8(v).u8(v >>> 8).u8(v >>> 16).u8(v >>> 24);
    }
    bytes(arr) {
      this._grow(arr.length);
      this.buf.set(arr, this.len);
      this.len += arr.length;
      return this;
    }
    str(s) {
      const b = enc.encode(s);
      return this.u16(b.length).bytes(b);
    }
    done() {
      return this.buf.slice(0, this.len);
    }
  }

  class Reader {
    constructor(u8) {
      this.b = u8;
      this.p = 0;
    }
    remaining() {
      return this.b.length - this.p;
    }
    need(n) {
      if (this.p + n > this.b.length) throw new PixlError('Reply from device was cut short', { code: 'PROTOCOL', retryable: true });
    }
    u8() {
      this.need(1);
      return this.b[this.p++];
    }
    u16() {
      this.need(2);
      const v = this.b[this.p] | (this.b[this.p + 1] << 8);
      this.p += 2;
      return v;
    }
    u32() {
      this.need(4);
      const v = (this.b[this.p] | (this.b[this.p + 1] << 8) | (this.b[this.p + 2] << 16) | (this.b[this.p + 3] << 24)) >>> 0;
      this.p += 4;
      return v;
    }
    bytes(n) {
      this.need(n);
      const s = this.b.subarray(this.p, this.p + n);
      this.p += n;
      return s;
    }
    str() {
      return dec.decode(this.bytes(this.u16()));
    }
  }

  function concat(parts, total) {
    const out = new Uint8Array(total);
    let o = 0;
    for (const p of parts) {
      out.set(p, o);
      o += p.length;
    }
    return out;
  }

  function hex(u8, max) {
    max = max || 48;
    let s = '';
    const n = Math.min(u8.length, max);
    for (let i = 0; i < n; i++) s += (u8[i] < 16 ? '0' : '') + u8[i].toString(16) + ' ';
    if (u8.length > max) s += `… (+${u8.length - max})`;
    return s.trim();
  }

  /* ------------------------------------------------------------------ paths */

  const path = {
    byteLen(s) {
      return enc.encode(s).length;
    },
    drive(p) {
      return p.slice(0, 1).toUpperCase();
    },
    isRoot(p) {
      return /^[A-Za-z]:\/?$/.test(p);
    },
    root(drive) {
      return drive + ':/';
    },
    join(dir, name) {
      return dir.endsWith('/') ? dir + name : dir + '/' + name;
    },
    parent(p) {
      if (path.isRoot(p)) return p;
      const trimmed = p.replace(/\/+$/, '');
      const i = trimmed.lastIndexOf('/');
      const par = trimmed.slice(0, i);
      return /^[A-Za-z]:$/.test(par) ? par + '/' : par;
    },
    basename(p) {
      const trimmed = p.replace(/\/+$/, '');
      return trimmed.slice(trimmed.lastIndexOf('/') + 1);
    },
    /** How many bytes a file name may use inside `dir`. */
    nameBudget(dir) {
      const prefix = dir.endsWith('/') ? dir : dir + '/';
      return Math.max(0, Math.min(LIMITS.nameBytes, LIMITS.pathBytes - path.byteLen(prefix)));
    },
    /** Returns an error string or null. */
    validateName(name, dir) {
      if (!name || !name.trim()) return 'Name cannot be empty';
      if (name === '.' || name === '..') return 'That name is reserved';
      if (/[\/\\\x00]/.test(name)) return 'Name cannot contain / or \\';
      const bytes = path.byteLen(name);
      if (bytes > LIMITS.nameBytes) return `Name is too long for the device (${bytes} of ${LIMITS.nameBytes} bytes)`;
      if (dir) {
        const budget = path.nameBudget(dir);
        if (bytes > budget) return `Full path is too long for the device (name can use ${budget} bytes here, this one is ${bytes})`;
      }
      return null;
    },
    /** Shortens a name (keeping its extension) so it fits `budget` bytes. */
    fit(name, budget) {
      if (path.byteLen(name) <= budget) return name;
      const dot = name.lastIndexOf('.');
      const ext = dot > 0 && name.length - dot <= 8 ? name.slice(dot) : '';
      let base = ext ? name.slice(0, dot) : name;
      const extBytes = path.byteLen(ext);
      const chars = Array.from(base);
      while (chars.length && path.byteLen(chars.join('')) + extBytes > budget) chars.pop();
      base = chars.join('').trimEnd();
      if (!base) base = '_';
      return base + ext;
    },
    /** Produces "name (2).ext" style variants until `taken(name)` is false. */
    unique(name, budget, taken) {
      let candidate = path.fit(name, budget);
      if (!taken(candidate)) return candidate;
      const dot = name.lastIndexOf('.');
      const ext = dot > 0 && name.length - dot <= 8 ? name.slice(dot) : '';
      const base = ext ? name.slice(0, dot) : name;
      for (let i = 2; i < 1000; i++) {
        const suffix = ` (${i})`;
        const room = budget - path.byteLen(suffix + ext);
        candidate = path.fit(base, Math.max(1, room)) + suffix + ext;
        if (path.byteLen(candidate) <= budget && !taken(candidate)) return candidate;
      }
      throw new PixlError('Could not find a free name for ' + name, { code: 'VALIDATION' });
    },
  };

  /* ------------------------------------------------------------------- meta */

  function parseMeta(bytes) {
    const meta = { notes: '', hidden: false, readonly: false, amiibo: null, flags: 0 };
    if (!bytes || !bytes.length) return meta;
    const r = new Reader(bytes);
    try {
      while (r.remaining() > 0) {
        const type = r.u8();
        if (type === 1) {
          meta.notes = dec.decode(r.bytes(r.u8()));
        } else if (type === 2) {
          meta.flags = r.u8();
          meta.hidden = !!(meta.flags & 1);
          meta.readonly = !!(meta.flags & 4);
        } else if (type === 3) {
          meta.amiibo = { head: r.u32(), tail: r.u32() };
        } else {
          break; // unknown type: length unknown, stop rather than misparse
        }
      }
    } catch (e) {
      /* tolerate truncated meta */
    }
    return meta;
  }

  function encodeMeta(meta) {
    const w = new Writer();
    const notes = enc.encode(meta.notes || '');
    if (notes.length > LIMITS.notesBytes) {
      throw new PixlError(`Notes are too long (${notes.length} of ${LIMITS.notesBytes} bytes)`, { code: 'VALIDATION' });
    }
    if (notes.length) w.u8(1).u8(notes.length).bytes(notes);
    let flags = (meta.flags || 0) & ~0x05;
    if (meta.hidden) flags |= 1;
    if (meta.readonly) flags |= 4;
    w.u8(2).u8(flags);
    if (meta.amiibo && (meta.amiibo.head || meta.amiibo.tail)) w.u8(3).u32(meta.amiibo.head).u32(meta.amiibo.tail);
    return w.done();
  }

  function metaIsEmpty(meta) {
    return !meta || (!meta.notes && !meta.flags && !meta.hidden && !meta.readonly && !meta.amiibo);
  }

  function amiiboId(meta) {
    if (!meta || !meta.amiibo) return '';
    const h = (n) => n.toString(16).padStart(8, '0');
    return (h(meta.amiibo.head) + h(meta.amiibo.tail)).toUpperCase();
  }

  /* ----------------------------------------------------------------- client */

  class PixlClient {
    /**
     * @param transport object with: connected (bool), write(Uint8Array) -> Promise,
     *        and settable onData(Uint8Array) / onDisconnect() callbacks.
     */
    constructor(transport, opts) {
      opts = opts || {};
      this.t = transport;
      this.log = opts.log || function () {};
      this.verbose = false;
      this.timeout = opts.timeout || 5000;
      this.writeChunk = PAYLOAD_MAX - 1;
      this._lock = Promise.resolve();
      this._pending = null;
      this._needQuiet = false;
      this._lastRx = 0;
      transport.onData = (u8) => this._onData(u8);
      transport.onDisconnect = () => this._onDisconnect();
    }

    get connected() {
      return !!this.t.connected;
    }

    /* -- low level ------------------------------------------------------- */

    _withLock(fn) {
      const run = this._lock.then(() => fn());
      this._lock = run.then(
        () => {},
        () => {}
      );
      return run;
    }

    async _waitQuiet() {
      const start = performance.now();
      while (performance.now() - start < 3000) {
        const now = performance.now();
        if (now - start >= 350 && now - this._lastRx >= 350) break;
        await sleep(60);
      }
      this._needQuiet = false;
    }

    async _send(frame) {
      for (let attempt = 0; ; attempt++) {
        try {
          if (this.verbose) this.log('debug', `→ ${CMD_NAMES[frame[0]] || frame[0]} ${hex(frame)}`);
          await this.t.write(frame);
          return;
        } catch (e) {
          if (!this.t.connected) throw new PixlError('Device disconnected', { code: 'DISCONNECTED', retryable: true, cause: e });
          const msg = String((e && e.message) || e);
          if (attempt < 5 && /in progress|busy|not ready|unknown/i.test(msg)) {
            await sleep(80 * (attempt + 1));
            continue;
          }
          throw new PixlError('Bluetooth write failed: ' + msg, { code: 'GATT', retryable: true, cause: e });
        }
      }
    }

    _onData(u8) {
      this._lastRx = performance.now();
      if (this.verbose) this.log('debug', `← ${CMD_NAMES[u8[0]] || u8[0]} ${hex(u8)}`);
      if (u8.length < HEADER_LEN) return;
      const cmd = u8[0];
      const status = u8[1];
      const chunk = u8[2] | (u8[3] << 8);
      const p = this._pending;
      if (!p || p.done || cmd !== p.cmd) {
        this.log('debug', `Ignored stray ${CMD_NAMES[cmd] || cmd} reply`);
        return;
      }
      const seq = chunk & 0x7fff;
      const more = (chunk & 0x8000) !== 0;
      if (p.onChunk) {
        // collect mode (file reads): keep every packet by sequence number, gaps allowed
        p.gotAny = true;
        if (status === 0) p.onChunk(seq, u8.slice(HEADER_LEN), !more);
        if (more && status === 0) p.arm();
        else p.finish(status);
        return;
      }
      if (seq !== p.next) {
        p.fail(new PixlError(`Lost a packet from the device (expected #${p.next}, got #${seq})`, { code: 'LOST', retryable: true }));
        return;
      }
      p.next++;
      if (u8.length > HEADER_LEN) {
        const payload = u8.slice(HEADER_LEN);
        p.parts.push(payload);
        p.received += payload.length;
      }
      if (p.onProgress) {
        try {
          p.onProgress(p.received);
        } catch (e) {
          /* ignore UI errors */
        }
      }
      if (more && status === 0) {
        p.arm();
        return;
      }
      p.finish(status);
    }

    _onDisconnect() {
      const p = this._pending;
      if (p && !p.done) p.fail(new PixlError('Device disconnected', { code: 'DISCONNECTED', retryable: true }));
      this._needQuiet = false;
    }

    async _req(cmd, payload, opts) {
      opts = opts || {};
      if (!this.t.connected) throw new PixlError('Not connected', { code: 'DISCONNECTED', retryable: true });
      if (this._needQuiet) await this._waitQuiet();
      payload = payload || EMPTY;
      if (payload.length > PAYLOAD_MAX) throw new PixlError('Request too large', { code: 'PROTOCOL' });
      const frame = new Uint8Array(HEADER_LEN + payload.length);
      const chunk = opts.chunk || 0;
      frame[0] = cmd;
      frame[1] = 0;
      frame[2] = chunk & 0xff;
      frame[3] = (chunk >> 8) & 0xff;
      frame.set(payload, HEADER_LEN);
      const timeoutMs = opts.timeout || this.timeout;
      const label = opts.label || CMD_NAMES[cmd] || 'Request';

      return new Promise((resolve, reject) => {
        const p = {
          cmd,
          parts: [],
          received: 0,
          next: 0,
          done: false,
          timer: null,
          onProgress: opts.onProgress,
          onChunk: opts.onChunk,
          gotAny: false,
        };
        p.fail = (err) => {
          if (p.done) return;
          p.done = true;
          clearTimeout(p.timer);
          if (this._pending === p) this._pending = null;
          if (err.code === 'TIMEOUT' || err.code === 'LOST' || err.code === 'GATT') this._needQuiet = true;
          reject(err);
        };
        p.finish = (status) => {
          if (p.done) return;
          p.done = true;
          clearTimeout(p.timer);
          if (this._pending === p) this._pending = null;
          resolve({ status, data: concat(p.parts, p.received) });
        };
        p.arm = () => {
          clearTimeout(p.timer);
          p.timer = setTimeout(() => {
            if (p.onChunk && p.gotAny) {
              // stream went quiet (its last packet was probably lost): return what we have
              this._needQuiet = true;
              p.finish(0);
              return;
            }
            p.fail(new PixlError(`${label}: device stopped responding`, { code: 'TIMEOUT', retryable: true }));
          }, timeoutMs);
        };
        this._pending = p;
        p.arm();
        this._send(frame).catch((e) => p.fail(e));
      });
    }

    _check(res, what) {
      if (res.status === 0) return res.data;
      if (res.status === 0xff) throw new PixlError(`${what}: not supported by this firmware`, { code: 'UNSUPPORTED', status: res.status });
      const signed = res.status > 127 ? res.status - 256 : res.status;
      const reason = VFS_ERRORS[String(signed)];
      throw new PixlError(reason ? `${what}: ${reason}` : `${what}: the device refused (error ${signed})`, {
        code: 'STATUS',
        status: res.status,
      });
    }

    /* -- commands -------------------------------------------------------- */

    getVersion() {
      return this._withLock(async () => {
        const r = new Reader(this._check(await this._req(CMD.VERSION), 'Read version'));
        const version = r.str();
        const address = r.remaining() >= 2 ? r.str() : '';
        return { version, address };
      });
    }

    getDrives() {
      return this._withLock(async () => {
        const r = new Reader(this._check(await this._req(CMD.DRIVE_LIST), 'Read drives'));
        const count = r.u8();
        const drives = [];
        for (let i = 0; i < count && r.remaining() > 0; i++) {
          const status = r.u8();
          const label = String.fromCharCode(r.u8());
          const name = r.str();
          const total = r.u32();
          const free = r.u32(); // firmware sends free bytes here (the stock app labels it "used")
          drives.push({ label, name, status, ok: status === 0, total, free: Math.min(free, total), used: Math.max(0, total - free) });
        }
        return drives;
      });
    }

    formatDrive(label) {
      return this._withLock(async () => {
        this._check(await this._req(CMD.DRIVE_FORMAT, new Writer().u8(label.charCodeAt(0)).done(), { timeout: 90000, label: 'Format' }), 'Format drive');
      });
    }

    listDir(dir) {
      return this._withLock(async () => {
        const data = this._check(await this._req(CMD.DIR_READ, new Writer().str(dir).done(), { label: 'List folder' }), `Open folder ${dir}`);
        const r = new Reader(data);
        const items = [];
        while (r.remaining() > 0) {
          const name = r.str();
          const size = r.u32();
          const type = r.u8();
          const metaBytes = r.bytes(r.u8());
          if (name === '.' || name === '..') continue;
          items.push({ name, size, isDir: type === 1, meta: parseMeta(metaBytes) });
        }
        return items;
      });
    }

    mkdir(p) {
      return this._withLock(async () => {
        this._check(await this._req(CMD.DIR_CREATE, new Writer().str(p).done()), `Create folder ${path.basename(p)}`);
      });
    }

    remove(p) {
      return this._withLock(async () => {
        this._check(await this._req(CMD.REMOVE, new Writer().str(p).done(), { timeout: 15000 }), `Delete ${path.basename(p)}`);
      });
    }

    /** Raw rename. NOTE: firmware renames folders to themselves (bug), so only use for files. */
    rename(from, to) {
      return this._withLock(async () => {
        this._check(await this._req(CMD.RENAME, new Writer().str(from).str(to).done()), `Rename ${path.basename(from)}`);
      });
    }

    updateMeta(p, meta) {
      const bytes = encodeMeta(meta);
      return this._withLock(async () => {
        const w = new Writer().str(p).u8(bytes.length).bytes(bytes);
        this._check(await this._req(CMD.UPDATE_META, w.done()), `Save properties of ${path.basename(p)}`);
      });
    }

    readFile(p, opts) {
      opts = opts || {};
      const name = path.basename(p);
      return this._withLock(async () => {
        // The firmware streams the whole file per read and can't seek. Every stream
        // carries the same bytes, so packets from several attempts are merged by
        // sequence number: a retry only needs to fill in the packets that went missing.
        const chunks = new Map();
        let lastSeq = -1;
        let have = 0;
        const complete = () => {
          if (lastSeq < 0) return false;
          for (let i = 0; i <= lastSeq; i++) if (!chunks.has(i)) return false;
          return true;
        };
        const MAX_PASSES = 6;
        for (let pass = 1; pass <= MAX_PASSES; pass++) {
          if (opts.signal && opts.signal.aborted) throw abortError();
          const open = this._check(await this._reqIdempotent(CMD.FILE_OPEN, new Writer().str(p).u32(OPEN_READ).done()), `Open ${name}`);
          const fid = open.length ? open[0] : 0;
          let res = null;
          try {
            res = await this._req(CMD.FILE_READ, Uint8Array.of(fid), {
              timeout: 3000,
              label: `Read ${name}`,
              onChunk: (seq, payload, last) => {
                if (last) lastSeq = seq;
                if (!chunks.has(seq)) {
                  chunks.set(seq, payload);
                  have += payload.length;
                  if (opts.onProgress) opts.onProgress(have);
                }
              },
            });
          } catch (e) {
            if (!e.retryable || !this.t.connected || pass === MAX_PASSES) throw e;
          } finally {
            await this._reqIdempotent(CMD.FILE_CLOSE, Uint8Array.of(fid)).catch(() => {});
          }
          if (res) this._check(res, `Read ${name}`);
          if (complete()) {
            const parts = [];
            let total = 0;
            for (let i = 0; i <= lastSeq; i++) {
              parts.push(chunks.get(i));
              total += chunks.get(i).length;
            }
            return concat(parts, total);
          }
          this.log('warn', `Read of ${name}: some packets went missing; reading again to fill the gaps (pass ${pass + 1})`);
        }
        throw new PixlError(`Read ${name}: too many packets lost`, { code: 'LOST', retryable: true });
      });
    }

    /** Retries a request that is safe to repeat (close, list, open, meta). */
    async _reqIdempotent(cmd, payload, opts, tries) {
      tries = tries || 3;
      for (let i = 1; ; i++) {
        try {
          return await this._req(cmd, payload, opts);
        } catch (e) {
          if (!e.retryable || i >= tries || !this.t.connected) throw e;
        }
      }
    }

    async _sizeOnDevice(p) {
      const dir = path.parent(p);
      const data = this._check(await this._reqIdempotent(CMD.DIR_READ, new Writer().str(dir).done(), { label: 'List folder' }), `Open folder ${dir}`);
      const r = new Reader(data);
      const want = path.basename(p);
      while (r.remaining() > 0) {
        const name = r.str();
        const size = r.u32();
        r.u8();
        r.bytes(r.u8());
        if (name === want) return size;
      }
      return -1;
    }

    /**
     * Writes a whole file. If a packet or reply goes missing mid-way, the file is
     * closed (so the firmware commits what it has), its size on the device is read,
     * and writing resumes from exactly that byte in append mode. That way a hiccup
     * costs one round trip instead of restarting the file.
     */
    writeFile(p, data, opts) {
      opts = opts || {};
      const name = path.basename(p);
      const MAX_STALLS = 6; // resumes in a row without any forward progress
      return this._withLock(async () => {
        if (opts.signal && opts.signal.aborted) throw abortError();
        const open = this._check(await this._reqIdempotent(CMD.FILE_OPEN, new Writer().str(p).u32(OPEN_WRITE).done()), `Create ${name}`);
        let fid = open.length ? open[0] : 0;
        let wrote = false;
        let stalls = 0;
        let lastResumeAt = -1;
        try {
          let off = 0;
          while (off < data.length) {
            if (opts.signal && opts.signal.aborted) throw abortError();
            const n = Math.min(this.writeChunk, data.length - off);
            const payload = new Uint8Array(1 + n);
            payload[0] = fid;
            payload.set(data.subarray(off, off + n), 1);
            try {
              this._check(await this._req(CMD.FILE_WRITE, payload, { label: `Write ${name}`, timeout: 3000 }), `Write ${name}`);
              off += n;
              if (opts.onProgress) opts.onProgress(off);
              continue;
            } catch (e) {
              stalls = off > lastResumeAt ? 1 : stalls + 1;
              lastResumeAt = off;
              if (!e.retryable || !this.t.connected || stalls > MAX_STALLS) throw e;
              // Some PCs negotiate a tiny BLE packet size; switch to small frames.
              if (e.code === 'GATT' && this.writeChunk > SAFE_WRITE_DATA) {
                this.writeChunk = SAFE_WRITE_DATA;
                this.log('warn', 'Large Bluetooth packets were rejected; switching to small packets (slower but compatible).');
              }
              this.log('warn', `Write of ${name} interrupted at ${off} bytes (${e.message}); resuming`);
            }
            // Resume: commit, measure, reopen for append.
            await this._reqIdempotent(CMD.FILE_CLOSE, Uint8Array.of(fid)).catch(() => {});
            const size = await this._sizeOnDevice(p);
            if (size !== off && size !== off + n) {
              throw new PixlError(`Couldn't resume ${name} (device has ${size} bytes, expected ${off})`, { code: 'LOST', retryable: true });
            }
            const reopen = this._check(
              await this._reqIdempotent(CMD.FILE_OPEN, new Writer().str(p).u32(MODE_APPEND | MODE_WRITEONLY).done()),
              `Reopen ${name}`
            );
            fid = reopen.length ? reopen[0] : 0;
            off = size;
            if (opts.onProgress) opts.onProgress(off);
          }
          wrote = true;
        } finally {
          let closed;
          try {
            closed = await this._reqIdempotent(CMD.FILE_CLOSE, Uint8Array.of(fid));
          } catch (e) {
            closed = e;
          }
          if (wrote) {
            // littlefs commits data on close, so the close must be confirmed. If its
            // reply got lost, check the size on the device instead.
            if (closed instanceof Error || closed.status !== 0) {
              const size = this.t.connected ? await this._sizeOnDevice(p).catch(() => -1) : -1;
              if (size !== data.length) {
                if (closed instanceof Error) throw closed;
                this._check(closed, `Save ${name}`);
              }
            }
          }
        }
      });
    }

    enterDfu() {
      return this._withLock(async () => {
        this._check(await this._req(CMD.ENTER_DFU), 'Enter update mode');
      });
    }
  }

  /* ------------------------------------------------------------- utilities */

  /** Runs fn, retrying on retryable errors. `waitReady` (optional) is awaited before each retry. */
  async function withRetry(fn, opts) {
    opts = opts || {};
    const attempts = opts.attempts || 3;
    let lastErr;
    for (let i = 1; i <= attempts; i++) {
      if (opts.signal && opts.signal.aborted) throw abortError();
      try {
        return await fn(i);
      } catch (e) {
        lastErr = e;
        if (!e || !e.retryable || i === attempts) throw e;
        if (opts.onRetry) opts.onRetry(e, i);
        await sleep(400 * i);
        if (opts.waitReady) await opts.waitReady();
      }
    }
    throw lastErr;
  }

  function bytesEqual(a, b) {
    if (a.length !== b.length) return false;
    for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
    return true;
  }

  Pixl.CMD = CMD;
  Pixl.LIMITS = LIMITS;
  Pixl.PixlError = PixlError;
  Pixl.PixlClient = PixlClient;
  Pixl.Writer = Writer;
  Pixl.Reader = Reader;
  Pixl.path = path;
  Pixl.parseMeta = parseMeta;
  Pixl.encodeMeta = encodeMeta;
  Pixl.metaIsEmpty = metaIsEmpty;
  Pixl.amiiboId = amiiboId;
  Pixl.withRetry = withRetry;
  Pixl.bytesEqual = bytesEqual;
  Pixl.abortError = abortError;
  Pixl.sleep = sleep;
  Pixl.hex = hex;
  Pixl.OPEN_READ = OPEN_READ;
  Pixl.OPEN_WRITE = OPEN_WRITE;
})(window);
