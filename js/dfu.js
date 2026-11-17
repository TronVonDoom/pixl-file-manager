/*
 * Nordic Secure DFU (Device Firmware Update) over Web Bluetooth.
 *
 * Pixl.js uses Nordic's standard secure bootloader (nRF5 SDK): in update mode it
 * advertises as "pixl dfu" with service 0xFE59, requires a signed package
 * (pixjs_ota_vXXX.zip), and keeps the old firmware until the new one is fully
 * received and verified (dual bank), so an interrupted update is recoverable.
 *
 * Protocol: for the init packet (.dat, "command" object) and then the firmware
 * (.bin, "data" objects of up to ~4 KB each): Create object -> stream packets ->
 * Calculate checksum (CRC32 of everything sent so far) -> Execute.
 */
(function (global) {
  'use strict';

  const Pixl = (global.Pixl = global.Pixl || {});

  const SERVICE = '0000fe59-0000-1000-8000-00805f9b34fb';
  const CONTROL = '8ec90001-f315-4f60-9fb8-838830daea50';
  const PACKET = '8ec90002-f315-4f60-9fb8-838830daea50';

  const OP = { CREATE: 0x01, SET_PRN: 0x02, CRC: 0x03, EXECUTE: 0x04, SELECT: 0x06, RESPONSE: 0x60 };
  const OBJ = { COMMAND: 1, DATA: 2 };
  const RESULT = {
    0x00: 'invalid opcode',
    0x01: 'success',
    0x02: 'command not supported',
    0x03: 'invalid parameter',
    0x04: 'not enough resources',
    0x05: 'invalid object',
    0x07: 'unsupported type',
    0x08: 'operation not permitted',
    0x0a: 'operation failed',
    0x0b: 'extended error',
  };
  const EXT = {
    0x02: 'wrong command format',
    0x03: 'unknown command',
    0x04: 'the package’s init data is invalid',
    0x05: 'firmware version check failed (the package may be older than the installed firmware)',
    0x06: 'hardware version mismatch (this package is for a different device)',
    0x07: 'SoftDevice version mismatch',
    0x08: 'the package isn’t signed',
    0x09: 'wrong hash type',
    0x0a: 'hash calculation failed',
    0x0b: 'wrong signature type',
    0x0c: 'signature check failed (the package isn’t signed for Pixl.js)',
    0x0d: 'not enough space on the device',
  };

  class DfuError extends Error {
    constructor(message, opts) {
      super(message);
      opts = opts || {};
      this.name = 'DfuError';
      this.retryable = !!opts.retryable;
      this.code = opts.code || 'DFU';
    }
  }

  /* ---------------------------------------------------------------- crc32 */

  let TABLE = null;
  function table() {
    if (TABLE) return TABLE;
    TABLE = new Uint32Array(256);
    for (let n = 0; n < 256; n++) {
      let c = n;
      for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
      TABLE[n] = c >>> 0;
    }
    return TABLE;
  }
  const crcInit = () => 0xffffffff;
  function crcUpdate(c, u8) {
    const t = table();
    for (let i = 0; i < u8.length; i++) c = t[(c ^ u8[i]) & 0xff] ^ (c >>> 8);
    return c >>> 0;
  }
  const crcFinal = (c) => (c ^ 0xffffffff) >>> 0;

  const u32le = (v) => [v & 0xff, (v >>> 8) & 0xff, (v >>> 16) & 0xff, (v >>> 24) & 0xff];
  const rd32 = (b, o) => (b[o] | (b[o + 1] << 8) | (b[o + 2] << 16) | (b[o + 3] << 24)) >>> 0;
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  /* -------------------------------------------------------------- package */

  /** Reads an nrfutil DFU package (.zip with manifest.json, .dat and .bin). */
  async function loadPackage(file) {
    let entries;
    try {
      entries = await Pixl.readZip(file);
    } catch (e) {
      throw new DfuError(`That isn’t a firmware package (${e.message})`);
    }
    const base = (n) => n.replace(/^.*\//, '');
    const byName = new Map(entries.filter((e) => !e.dir).map((e) => [base(e.name), e]));
    const man = entries.find((e) => base(e.name) === 'manifest.json');
    if (!man) {
      throw new DfuError('No manifest.json inside. Use the OTA package (pixjs_ota_vXXX.zip) that comes inside the firmware download, not the outer ZIP.');
    }
    let manifest;
    try {
      manifest = JSON.parse(new TextDecoder().decode(await man.read())).manifest;
    } catch (e) {
      throw new DfuError('The package’s manifest.json is damaged');
    }
    const images = [];
    for (const type of ['softdevice_bootloader', 'softdevice', 'bootloader', 'application']) {
      const m = manifest && manifest[type];
      if (!m) continue;
      const dat = byName.get(base(m.dat_file || ''));
      const bin = byName.get(base(m.bin_file || ''));
      if (!dat || !bin) throw new DfuError(`The package is missing ${m.dat_file || m.bin_file}`);
      images.push({ type, init: await dat.read(), firmware: await bin.read() });
    }
    if (!images.length) throw new DfuError('The package doesn’t contain any firmware');
    const v = (file.name || '').match(/v(\d+(?:\.\d+)*)/i);
    return {
      name: file.name || 'package.zip',
      version: v ? v[1] : '',
      images,
      size: images.reduce((n, i) => n + i.firmware.length, 0),
    };
  }

  /* ------------------------------------------------------- BLE transport */

  class BleDfuTransport {
    constructor(opts) {
      opts = opts || {};
      this.log = opts.log || function () {};
      this.device = null;
      this.cp = null;
      this.pk = null;
      this.onNotify = null;
      this.onDisconnect = null;
      this._notify = (e) => {
        const v = e.target.value;
        if (this.onNotify) this.onNotify(new Uint8Array(v.buffer.slice(v.byteOffset, v.byteOffset + v.byteLength)));
      };
      this._disc = () => {
        this.cp = null;
        if (this.onDisconnect) this.onDisconnect();
      };
    }
    static supported() {
      return !!(global.navigator && navigator.bluetooth);
    }
    get connected() {
      return !!(this.device && this.device.gatt.connected && this.cp);
    }
    get name() {
      return (this.device && this.device.name) || 'pixl dfu';
    }
    /** Must run from a click. */
    async pick() {
      this.device = await navigator.bluetooth.requestDevice({
        filters: [{ services: [SERVICE] }, { name: 'pixl dfu' }, { namePrefix: 'Pixl' }, { namePrefix: 'DfuTarg' }],
        optionalServices: [SERVICE],
      });
      this.device.addEventListener('gattserverdisconnected', this._disc);
    }
    async connect() {
      let last;
      for (let i = 1; i <= 3; i++) {
        try {
          const server = await this.device.gatt.connect();
          const svc = await server.getPrimaryService(SERVICE);
          this.pk = await svc.getCharacteristic(PACKET);
          const cp = await svc.getCharacteristic(CONTROL);
          cp.addEventListener('characteristicvaluechanged', this._notify);
          await cp.startNotifications();
          this.cp = cp;
          return;
        } catch (e) {
          last = e;
          this.log('warn', `Update-mode connect attempt ${i} failed: ${e.message}`);
          await sleep(800 * i);
        }
      }
      if (/service/i.test(String(last && last.message))) {
        throw new DfuError('That device isn’t in update mode. Pick the one named “pixl dfu”.');
      }
      throw last;
    }
    writeControl(u8) {
      return this.cp.writeValueWithResponse ? this.cp.writeValueWithResponse(u8) : this.cp.writeValue(u8);
    }
    writePacket(u8) {
      return this.pk.writeValueWithoutResponse ? this.pk.writeValueWithoutResponse(u8) : this.pk.writeValue(u8);
    }
    disconnect() {
      if (this.device && this.device.gatt.connected) this.device.gatt.disconnect();
    }
  }

  /* ------------------------------------------------------------ DFU client */

  class SecureDfu {
    /**
     * @param transport { writeControl(u8), writePacket(u8), onNotify=, onDisconnect=, connected }
     * @param opts { log, prn (packets between receipts, default 8), packetSize (default 244) }
     */
    constructor(transport, opts) {
      opts = opts || {};
      this.t = transport;
      this.log = opts.log || function () {};
      this.prn = opts.prn != null ? opts.prn : 8;
      this.packetSize = opts.packetSize || 244;
      this.queue = [];
      this.waiter = null;
      this.aborted = false;
      this.disconnected = false;
      transport.onNotify = (u8) => this._onNotify(u8);
      const prevDisc = transport.onDisconnect;
      transport.onDisconnect = () => {
        this.disconnected = true;
        if (this.waiter) this.waiter.reject(new DfuError('The device disconnected', { code: 'DISCONNECTED' }));
        if (prevDisc) prevDisc();
      };
    }

    abort() {
      this.aborted = true;
      if (this.waiter) this.waiter.reject(new DfuError('Canceled', { code: 'ABORTED' }));
    }

    _onNotify(u8) {
      if (u8[0] !== OP.RESPONSE) return;
      if (this.waiter && this.waiter.op === u8[1]) {
        const w = this.waiter;
        this.waiter = null;
        clearTimeout(w.timer);
        w.resolve(u8);
      } else {
        this.queue.push(u8);
      }
    }

    _next(op, timeout) {
      const i = this.queue.findIndex((n) => n[1] === op);
      if (i >= 0) return Promise.resolve(this.queue.splice(i, 1)[0]);
      if (this.disconnected) return Promise.reject(new DfuError('The device disconnected', { code: 'DISCONNECTED' }));
      return new Promise((resolve, reject) => {
        const w = { op, resolve, reject };
        w.timer = setTimeout(() => {
          if (this.waiter === w) this.waiter = null;
          reject(new DfuError('The device stopped responding', { code: 'TIMEOUT', retryable: true }));
        }, timeout || 6000);
        this.waiter = w;
      });
    }

    _checkResult(n, what) {
      const result = n[2];
      if (result === 0x01) return n;
      if (result === 0x0b) throw new DfuError(`${what}: ${EXT[n[3]] || 'extended error ' + n[3]}`);
      throw new DfuError(`${what}: ${RESULT[result] || 'error ' + result}`);
    }

    async _cmd(bytes, what, timeout) {
      if (this.aborted) throw new DfuError('Canceled', { code: 'ABORTED' });
      await this.t.writeControl(Uint8Array.from(bytes));
      return this._checkResult(await this._next(bytes[0], timeout), what);
    }

    async _crc() {
      this.queue = this.queue.filter((n) => n[1] !== OP.CRC); // drop stale receipts
      const n = await this._cmd([OP.CRC], 'Checksum');
      return { offset: rd32(n, 3), crc: rd32(n, 7) };
    }

    /**
     * Sends one image. onProgress(bytesOfFirmwareSent, total).
     */
    async update(image, onProgress) {
      this.queue = [];
      await this._cmd([OP.SET_PRN, this.prn & 0xff, (this.prn >> 8) & 0xff], 'Set up');
      this.log('info', `Sending init packet (${image.init.length} bytes)`);
      await this._sendObject(OBJ.COMMAND, image.init, null, false);
      this.log('info', `Sending firmware (${image.firmware.length} bytes)`);
      await this._sendObject(OBJ.DATA, image.firmware, onProgress, true);
    }

    async _sendObject(type, data, onProgress, isFirmware) {
      const sel = this._checkResult(await (async () => {
        await this.t.writeControl(Uint8Array.of(OP.SELECT, type));
        return this._next(OP.SELECT);
      })(), 'Select');
      const maxSize = rd32(sel, 3) || 4096;
      let crcState = crcInit();
      for (let start = 0; start < data.length; ) {
        const end = Math.min(start + maxSize, data.length);
        const startState = crcState;
        for (let attempt = 1; ; attempt++) {
          try {
            await this._cmd([OP.CREATE, type, ...u32le(end - start)], 'Create object');
            crcState = await this._writePackets(data, start, end, startState, onProgress);
            const c = await this._crc();
            const want = crcFinal(crcState);
            if (c.offset !== end || c.crc !== want) {
              throw new DfuError(`Checksum mismatch at ${c.offset} of ${end}`, { retryable: true, code: 'CRC' });
            }
            break;
          } catch (e) {
            if (!e.retryable || this.aborted || this.disconnected || attempt >= 6) throw e;
            if (e.code === 'CRC') {
              // data got lost: the device's buffers overflowed, so wait for receipts more often
              if (this.prn !== 1) {
                this.prn = this.prn > 2 ? this.prn >> 1 : 1;
                await this._cmd([OP.SET_PRN, this.prn & 0xff, (this.prn >> 8) & 0xff], 'Set up');
                this.log('warn', `Some update packets were lost; slowing down (receipt every ${this.prn} packets).`);
              }
            } else if (this.packetSize > 20) {
              // writes themselves were refused: the link only takes small packets
              this.packetSize = 20;
              this.log('warn', 'Large update packets were refused; switching to small ones (slower).');
            }
            this.log('warn', `${e.message}; resending this block (attempt ${attempt + 1})`);
            crcState = startState;
          }
        }
        const last = isFirmware && end === data.length;
        try {
          await this._cmd([OP.EXECUTE], last ? 'Finish update' : 'Save block', last ? 20000 : 8000);
        } catch (e) {
          // After the last block the device validates, then reboots; it may drop the link first.
          if (last && (this.disconnected || e.code === 'DISCONNECTED')) return;
          throw e;
        }
        start = end;
      }
    }

    async _writePackets(data, start, end, crcState, onProgress) {
      let since = 0;
      for (let p = start; p < end; ) {
        if (this.aborted) throw new DfuError('Canceled', { code: 'ABORTED' });
        if (this.disconnected) throw new DfuError('The device disconnected', { code: 'DISCONNECTED' });
        const chunk = data.subarray(p, Math.min(p + this.packetSize, end));
        try {
          await this.t.writePacket(chunk);
        } catch (e) {
          if (this.disconnected) throw new DfuError('The device disconnected', { code: 'DISCONNECTED' });
          throw new DfuError('Bluetooth write failed: ' + e.message, { retryable: true });
        }
        crcState = crcUpdate(crcState, chunk);
        p += chunk.length;
        if (this.prn && ++since >= this.prn) {
          since = 0;
          // packet receipt: flow control, and an early check that nothing was lost
          try {
            const n = this._checkResult(await this._next(OP.CRC, 4000), 'Receipt');
            if (rd32(n, 3) !== p || rd32(n, 7) !== crcFinal(crcState)) {
              throw new DfuError(`Packets were lost around byte ${rd32(n, 3)}`, { retryable: true, code: 'CRC' });
            }
          } catch (e) {
            if (e.code !== 'TIMEOUT') throw e; // a missing receipt is checked at the end of the block anyway
          }
        }
        if (onProgress) onProgress(p, data.length);
      }
      return crcState;
    }
  }

  Pixl.dfu = { SERVICE, CONTROL, PACKET, OP, OBJ, DfuError, SecureDfu, BleDfuTransport, loadPackage, crcInit, crcUpdate, crcFinal };
})(typeof window !== 'undefined' ? window : globalThis);
