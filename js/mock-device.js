/*
 * Demo device: an in-memory emulation of the Pixl.js firmware's file protocol,
 * byte-for-byte (frame sizes, chunk streaming, error codes, and its quirks such as
 * folder rename being a no-op and non-empty folders refusing deletion).
 * Lets you try the app without hardware, and lets us test the protocol code.
 *
 * URL options: ?demo  ?demo&faults=0.05 (drop 5% of device replies)  ?demo&latency=20
 */
(function (global) {
  'use strict';

  const Pixl = (global.Pixl = global.Pixl || {});
  const enc = new TextEncoder();
  const dec = new TextDecoder();
  const PAYLOAD_MAX = 243;
  const BLOCK = 4096;
  const TOTAL = 4 * 1024 * 1024;
  const ERR = 1;

  function dir() {
    return { type: 'dir', children: new Map(), meta: new Uint8Array(0) };
  }
  function file(data, meta) {
    return { type: 'file', data: data || new Uint8Array(0), meta: meta || new Uint8Array(0) };
  }

  function seeded(n, seed) {
    const out = new Uint8Array(n);
    let x = seed * 2654435761 + 1;
    for (let i = 0; i < n; i++) {
      x ^= x << 13;
      x ^= x >>> 17;
      x ^= x << 5;
      out[i] = x & 0xff;
    }
    return out;
  }

  function amiiboMeta(head, tail, notes, hidden) {
    return Pixl.encodeMeta({ notes: notes || '', hidden: !!hidden, amiibo: { head, tail } });
  }

  /** A fake but structurally valid 540-byte amiibo dump carrying a real amiibo ID. */
  function amiiboDump(idHex, seed) {
    const d = seeded(540, seed);
    d.set([0x04, 0x11, 0x22, 0xa7], 0); // UID start
    d.set([0xf1, 0x10, 0xff, 0xee], 12); // capability container used by amiibo
    for (let i = 0; i < 8; i++) d[0x54 + i] = parseInt(idHex.substr(i * 2, 2), 16);
    return d;
  }
  function idMeta(idHex, notes) {
    return amiiboMeta(parseInt(idHex.slice(0, 8), 16), parseInt(idHex.slice(8), 16), notes);
  }

  // [file name, amiibo id, notes, store the id in metadata like the device's amiibo DB does?]
  const DEMO_SETS = {
    'Super Smash Bros.': [
      ['Mario.bin', '0000000000000002', 'My first amiibo', true],
      ['Link.bin', '0100000000040002', '', true],
      ['Pikachu.bin', '1919000000090002', '', false],
      ['Kirby.bin', '1f000000000a0002', '', false],
      ['Samus.bin', '05c0000000060002', '', true],
      ['Fox.bin', '0580000000050002', '', false],
    ],
    'Animal Crossing': [
      ['Isabelle.bin', '0181000100440502', 'Summer outfit', true],
      ['Celeste.bin', '0193000103ae0502', '', false],
      ['Isabelle (2).bin', '0181000100440502', '', false],
    ],
  };

  class MockFS {
    constructor() {
      this.drives = { E: dir() };
      this.seed();
    }

    seed() {
      const root = this.drives.E;
      const amiibo = dir();
      root.children.set('amiibo', amiibo);
      let seed = 1;
      Object.keys(DEMO_SETS).forEach((folder) => {
        const d = dir();
        amiibo.children.set(folder, d);
        DEMO_SETS[folder].forEach(([name, id, notes, withMeta]) => {
          const data = amiiboDump(id, seed++);
          d.children.set(name, file(data, withMeta ? idMeta(id, notes) : notes ? Pixl.encodeMeta({ notes }) : undefined));
        });
      });
      // the same Isabelle twice as an identical copy, for the duplicate finder
      const isa = amiibo.children.get('Animal Crossing').children.get('Isabelle.bin');
      amiibo.children.set('Isabelle copy.bin', file(isa.data.slice()));
      amiibo.children.set('Zelda.bin', file(amiiboDump('0101000003560902', 50)));
      amiibo.children.set('Empty folder', dir());

      const player = dir();
      root.children.set('player', player);
      player.children.set('demo-clip.bin', file(seeded(18 * 1024 + 77, 7)));
      player.children.set('exactly-3-chunks.bin', file(seeded(PAYLOAD_MAX * 3, 8)));

      root.children.set('settings.bin', file(seeded(96, 3), Pixl.encodeMeta({ hidden: true })));
      root.children.set('readme.txt', file(enc.encode('This is the demo device.\nNothing here touches real hardware.\n')));
    }

    split(p) {
      const drive = p[0];
      const rest = p.slice(2).split('/').filter(Boolean);
      return { root: this.drives[drive], parts: rest };
    }

    lookup(p) {
      const { root, parts } = this.split(p);
      if (!root) return null;
      let node = root;
      for (const part of parts) {
        if (node.type !== 'dir') return null;
        node = node.children.get(part);
        if (!node) return null;
      }
      return node;
    }

    parentOf(p) {
      const { root, parts } = this.split(p);
      if (!root || !parts.length) return null;
      let node = root;
      for (const part of parts.slice(0, -1)) {
        node = node.children.get(part);
        if (!node || node.type !== 'dir') return null;
      }
      return { parent: node, name: parts[parts.length - 1] };
    }

    used() {
      let blocks = 2;
      const walk = (n) => {
        if (n.type === 'dir') {
          blocks += 1;
          n.children.forEach(walk);
        } else blocks += Math.max(1, Math.ceil(n.data.length / BLOCK));
      };
      walk(this.drives.E);
      return Math.min(TOTAL, blocks * BLOCK);
    }
  }

  class Buf {
    constructor(u8) {
      this.b = u8;
      this.p = 0;
    }
    u8() {
      return this.b[this.p++] || 0;
    }
    u16() {
      return this.u8() | (this.u8() << 8);
    }
    u32() {
      return (this.u8() | (this.u8() << 8) | (this.u8() << 16) | (this.u8() << 24)) >>> 0;
    }
    bytes(n) {
      const s = this.b.subarray(this.p, this.p + n);
      this.p += n;
      return s;
    }
    str() {
      return dec.decode(this.bytes(this.u16()));
    }
    rest() {
      return this.b.subarray(this.p);
    }
  }

  class MockTransport {
    constructor(opts) {
      opts = opts || {};
      this.latency = opts.latency != null ? opts.latency : 12;
      this.faults = opts.faults || 0;
      this.rng = opts.rng || Math.random;
      // shared across reconnects within the page (and with the demo bootloader)
      const st = (Pixl.mockState = Pixl.mockState || { version: '2.13.0-demo', inDfu: false });
      this.state = opts.fresh ? { version: '2.13.0-demo', inDfu: false } : st;
      this.fs = opts.fresh ? new MockFS() : st.fs || (st.fs = new MockFS());
      this._connected = false;
      this.onData = null;
      this.onDisconnect = null;
      this.userClosed = false;
      this.open = null; // { node, path, write: bool, buf: [] }
      this.stream = null;
      this._busy = false;
    }

    static supported() {
      return true;
    }
    get connected() {
      return this._connected;
    }
    get name() {
      return 'Demo Pixl.js';
    }
    async pick() {}
    async connect() {
      await new Promise((r) => setTimeout(r, 350));
      if (this.state.inDfu) throw new Error('GATT connection failed: the demo device is in firmware update mode');
      this.userClosed = false;
      this._connected = true;
    }
    disconnect() {
      this.userClosed = true;
      this._drop();
    }
    /** Simulates the link dropping (used for testing reconnect). */
    simulateDrop() {
      this._drop();
    }
    _drop() {
      if (!this._connected) return;
      this._connected = false;
      this.stream = null;
      setTimeout(() => this.onDisconnect && this.onDisconnect(), 0);
    }

    async write(frame) {
      if (!this._connected) throw new Error('GATT Server is disconnected. Cannot perform GATT operations.');
      if (this._busy) throw new Error('GATT operation already in progress.');
      this._busy = true;
      try {
        await new Promise((r) => setTimeout(r, this.latency));
      } finally {
        this._busy = false;
      }
      if (!this._connected) throw new Error('GATT Server is disconnected.');
      this._handle(frame.slice());
    }

    _notify(cmd, status, chunk, payload) {
      const f = new Uint8Array(4 + (payload ? payload.length : 0));
      f[0] = cmd;
      f[1] = status & 0xff;
      f[2] = chunk & 0xff;
      f[3] = (chunk >> 8) & 0xff;
      if (payload) f.set(payload, 4);
      return f;
    }

    _deliver(frames) {
      // Frames go out one by one, like the firmware's TX-ready driven chunking.
      let i = 0;
      const token = {};
      this.stream = token;
      const next = () => {
        if (!this._connected || this.stream !== token || i >= frames.length) return;
        const f = frames[i++];
        if (!(this.faults && this.rng() < this.faults)) {
          if (this.onData) this.onData(f);
        }
        setTimeout(next, Math.max(2, this.latency / 2));
      };
      setTimeout(next, this.latency);
    }

    _reply(cmd, status, payload) {
      this._deliver([this._notify(cmd, status, 0, payload)]);
    }

    _handle(frame) {
      const cmd = frame[0];
      const chunk = frame[2] | (frame[3] << 8);
      const b = new Buf(frame.subarray(4));
      const fs = this.fs;
      const okDrive = (p) => (p[0] === 'E' && p[1] === ':' && p[2] === '/' ? true : false);

      switch (cmd) {
        case 0x01: {
          const w = new Pixl.Writer().str(this.state.version).str('DE:M0:00:00:00:01');
          return this._reply(cmd, 0, w.done());
        }
        case 0x02: {
          // enter update mode: answer, then "reboot" into the bootloader
          this._reply(cmd, 0);
          setTimeout(() => {
            this.state.inDfu = true;
            this._drop();
          }, 120);
          return;
        }
        case 0x10: {
          const used = fs.used();
          const w = new Pixl.Writer().u8(1).u8(0).u8('E'.charCodeAt(0)).str('External Flash').u32(TOTAL).u32(TOTAL - used);
          return this._reply(cmd, 0, w.done());
        }
        case 0x11: {
          const label = String.fromCharCode(b.u8());
          if (label !== 'E') return this._reply(cmd, ERR);
          fs.drives.E = dir();
          setTimeout(() => this._reply(cmd, 0), 600);
          return;
        }
        case 0x12: {
          const p = b.str();
          const flags = b.u32();
          if (!okDrive(p)) return this._reply(cmd, ERR);
          this.open = null;
          if (flags & 0x08) {
            const node = fs.lookup(p);
            if (!node || node.type !== 'file') return this._reply(cmd, ERR);
            this.open = { node, path: p, write: false, pos: 0 };
          } else {
            const loc = fs.parentOf(p);
            if (!loc || Pixl.path.byteLen(loc.name) > 47) return this._reply(cmd, ERR);
            let node = loc.parent.children.get(loc.name);
            if (node && node.type === 'dir') return this._reply(cmd, ERR);
            if (!node) {
              if (!(flags & 0x04)) return this._reply(cmd, ERR);
              node = file();
              loc.parent.children.set(loc.name, node);
            }
            const keep = !(flags & 0x02) && node.data.length; // no TRUNC: keep contents (we only emulate append)
            this.open = { node, path: p, write: true, parts: keep ? [node.data.slice()] : [], size: keep ? node.data.length : 0 };
          }
          return this._reply(cmd, 0, Uint8Array.of(0));
        }
        case 0x13: {
          if (!this.open) return this._reply(cmd, this.everOpened ? 0 : ERR); // firmware: closing twice is OK
          this.everOpened = true;
          if (this.open.write) {
            const data = new Uint8Array(this.open.size);
            let o = 0;
            for (const part of this.open.parts) {
              data.set(part, o);
              o += part.length;
            }
            this.open.node.data = data; // littlefs commits on close
          }
          this.open = null;
          return this._reply(cmd, 0);
        }
        case 0x14: {
          if (!this.open || this.open.write) return this._reply(cmd, ERR);
          const data = this.open.node.data;
          const frames = [];
          let seq = 0;
          let pos = 0;
          for (;;) {
            const n = Math.min(PAYLOAD_MAX, data.length - pos);
            const piece = data.slice(pos, pos + n);
            pos += n;
            const eof = n < PAYLOAD_MAX;
            frames.push(this._notify(cmd, 0, eof ? seq : seq | 0x8000, piece));
            seq++;
            if (eof) break;
          }
          return this._deliver(frames);
        }
        case 0x15: {
          b.u8(); // file id
          const data = b.rest().slice();
          const eof = !(chunk & 0x8000);
          if (this.open && this.open.write) {
            this.open.parts.push(data);
            this.open.size += data.length;
          }
          if (eof) this._reply(cmd, this.open && this.open.write ? 0 : ERR);
          return;
        }
        case 0x16: {
          const p = b.str();
          if (!okDrive(p)) return this._reply(cmd, ERR);
          const node = fs.lookup(p);
          if (!node || node.type !== 'dir') return this._reply(cmd, ERR);
          const entries = [];
          node.children.forEach((child, name) => {
            const w = new Pixl.Writer().str(name).u32(child.type === 'dir' ? 0 : child.data.length).u8(child.type === 'dir' ? 1 : 0);
            w.u8(child.meta.length).bytes(child.meta);
            entries.push(w.done());
          });
          const frames = [];
          let cur = [];
          let curLen = 0;
          let seq = 0;
          for (const e of entries) {
            if (curLen + e.length > PAYLOAD_MAX) {
              frames.push({ seq: seq++, parts: cur, len: curLen });
              cur = [];
              curLen = 0;
            }
            cur.push(e);
            curLen += e.length;
          }
          frames.push({ seq: seq++, parts: cur, len: curLen });
          const out = frames.map((f, i) => {
            const payload = new Uint8Array(f.len);
            let o = 0;
            for (const part of f.parts) {
              payload.set(part, o);
              o += part.length;
            }
            const last = i === frames.length - 1;
            return this._notify(cmd, 0, last ? f.seq : f.seq | 0x8000, payload);
          });
          return this._deliver(out);
        }
        case 0x17: {
          const p = b.str();
          if (!okDrive(p)) return this._reply(cmd, ERR);
          const loc = fs.parentOf(p);
          if (!loc || loc.parent.children.has(loc.name) || Pixl.path.byteLen(loc.name) > 47) return this._reply(cmd, ERR);
          loc.parent.children.set(loc.name, dir());
          return this._reply(cmd, 0);
        }
        case 0x18: {
          const p = b.str();
          const loc = fs.parentOf(p);
          if (!loc) return this._reply(cmd, ERR);
          const node = loc.parent.children.get(loc.name);
          if (!node) return this._reply(cmd, ERR);
          if (node.type === 'dir' && node.children.size) return this._reply(cmd, ERR); // LFS_ERR_NOTEMPTY
          loc.parent.children.delete(loc.name);
          return this._reply(cmd, 0);
        }
        case 0x19: {
          const from = b.str();
          const to = b.str();
          if (!okDrive(from) || !okDrive(to)) return this._reply(cmd, ERR);
          const a = fs.parentOf(from);
          const node = a && a.parent.children.get(a.name);
          if (!node) return this._reply(cmd, ERR);
          if (node.type === 'dir') return this._reply(cmd, 0); // firmware bug: lfs_rename(old, old)
          const c = fs.parentOf(to);
          if (!c) return this._reply(cmd, ERR);
          const existing = c.parent.children.get(c.name);
          if (existing && existing.type === 'dir') return this._reply(cmd, ERR);
          a.parent.children.delete(a.name);
          c.parent.children.set(c.name, node);
          return this._reply(cmd, 0);
        }
        case 0x1a: {
          const p = b.str();
          const size = b.u8();
          const meta = b.bytes(size).slice();
          const node = fs.lookup(p);
          if (!node) return this._reply(cmd, ERR);
          node.meta = meta;
          return this._reply(cmd, 0);
        }
        default:
          return this._reply(cmd, 0xff);
      }
    }
  }

  Pixl.MockTransport = MockTransport;
})(window);
