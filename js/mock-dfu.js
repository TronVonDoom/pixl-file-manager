/*
 * Demo/test stand-in for the Pixl.js bootloader in update mode ("pixl dfu").
 * Implements the Secure DFU control point the way nRF5 SDK does: objects,
 * packet receipts (PRN), cumulative CRC32, execute, then a reboot.
 */
(function (global) {
  'use strict';

  const Pixl = (global.Pixl = global.Pixl || {});
  const state = (Pixl.mockState = Pixl.mockState || { version: '2.13.0-demo', inDfu: false });

  const OK = 0x01;
  const NOT_PERMITTED = 0x08;
  const INVALID_PARAM = 0x03;
  const EXT_ERROR = 0x0b;

  /** Builds a package object the mock bootloader accepts (no ZIP needed). */
  function demoPackage(version, size) {
    version = version || '2.14.0-demo';
    size = size || 48 * 1024 + 123;
    const fw = new Uint8Array(size);
    let x = 12345;
    for (let i = 0; i < size; i++) {
      x = (x * 1103515245 + 12345) >>> 0;
      fw[i] = x >>> 24;
    }
    const v = new TextEncoder().encode(version);
    const init = new Uint8Array(12 + v.length + 64);
    init.set(new TextEncoder().encode('MOCKINIT'), 0);
    new DataView(init.buffer).setUint32(8, size, true);
    init.set(v, 12);
    return { name: `pixjs_ota_${version}.zip`, version, size, images: [{ type: 'application', init, firmware: fw }], demo: true };
  }

  class MockDfuTransport {
    constructor(opts) {
      opts = opts || {};
      this.latency = opts.latency != null ? opts.latency : 2;
      this.maxPacket = opts.maxPacket || 244; // pretend the link negotiated a 247-byte MTU
      this.dropRate = opts.dropRate || 0;
      this.rng = opts.rng || Math.random;
      this.requireDfuMode = opts.requireDfuMode !== false;
      this.onNotify = null;
      this.onDisconnect = null;
      this._connected = false;
      this.prn = 0;
      this.prnCount = 0;
      this.objMax = { 1: 256, 2: 4096 };
      this.executed = { 1: new Uint8Array(0), 2: new Uint8Array(0) };
      this.current = null; // { type, size, data: [] }
      this.fwSize = 0;
      this.newVersion = '';
      this.stats = { packets: 0, dropped: 0, rejected: 0 };
    }
    static supported() {
      return true;
    }
    get connected() {
      return this._connected;
    }
    get name() {
      return 'pixl dfu (demo)';
    }
    async pick() {
      if (this.requireDfuMode && !state.inDfu) {
        const e = new Error('No “pixl dfu” device found. The demo device isn’t in update mode yet.');
        e.name = 'NotFoundError';
        throw e;
      }
    }
    async connect() {
      await new Promise((r) => setTimeout(r, 200));
      this._connected = true;
    }
    disconnect() {
      this._drop();
    }
    _drop() {
      if (!this._connected) return;
      this._connected = false;
      setTimeout(() => this.onDisconnect && this.onDisconnect(), 0);
    }

    _respond(op, result, payload) {
      const out = new Uint8Array(3 + (payload ? payload.length : 0));
      out[0] = 0x60;
      out[1] = op;
      out[2] = result;
      if (payload) out.set(payload, 3);
      setTimeout(() => this._connected && this.onNotify && this.onNotify(out), this.latency);
    }

    _received(type) {
      const base = this.executed[type];
      const cur = this.current && this.current.type === type ? this.current.data : [];
      const out = new Uint8Array(base.length + cur.length);
      out.set(base, 0);
      out.set(cur, base.length);
      return out;
    }

    _crcPayload(type) {
      const all = this._received(type);
      const crc = Pixl.dfu.crcFinal(Pixl.dfu.crcUpdate(Pixl.dfu.crcInit(), all));
      const b = new Uint8Array(8);
      const dv = new DataView(b.buffer);
      dv.setUint32(0, all.length, true);
      dv.setUint32(4, crc, true);
      return b;
    }

    async writeControl(u8) {
      if (!this._connected) throw new Error('GATT Server is disconnected.');
      await new Promise((r) => setTimeout(r, this.latency));
      const op = u8[0];
      const dv = new DataView(u8.buffer, u8.byteOffset, u8.byteLength);
      switch (op) {
        case 0x02:
          this.prn = dv.getUint16(1, true);
          return this._respond(op, OK);
        case 0x06: {
          const type = u8[1];
          const p = new Uint8Array(12);
          const pdv = new DataView(p.buffer);
          pdv.setUint32(0, this.objMax[type], true);
          p.set(this._crcPayload(type), 4);
          return this._respond(op, OK, p);
        }
        case 0x01: {
          const type = u8[1];
          const size = dv.getUint32(2, true);
          if (!size || size > this.objMax[type]) return this._respond(op, INVALID_PARAM);
          if (type === 2 && !this.fwSize) return this._respond(op, NOT_PERMITTED); // init packet first
          this.current = { type, size, data: [] };
          this.prnCount = 0;
          return this._respond(op, OK);
        }
        case 0x03: {
          const type = this.current ? this.current.type : 2;
          return this._respond(op, OK, this._crcPayload(type));
        }
        case 0x04: {
          const c = this.current;
          if (!c || c.data.length !== c.size) return this._respond(op, NOT_PERMITTED);
          if (c.type === 1) {
            const init = Uint8Array.from(c.data);
            if (new TextDecoder().decode(init.subarray(0, 8)) !== 'MOCKINIT') {
              return this._respond(op, EXT_ERROR, Uint8Array.of(0x0c)); // signature check failed
            }
            this.fwSize = new DataView(init.buffer).getUint32(8, true);
            this.newVersion = new TextDecoder().decode(init.subarray(12)).replace(/\0+$/, '').trim();
            this.executed[1] = init;
            this.current = null;
            return this._respond(op, OK);
          }
          this.executed[2] = this._received(2);
          this.current = null;
          this._respond(op, OK);
          if (this.executed[2].length === this.fwSize) {
            // validate + reboot into the new firmware
            setTimeout(() => {
              state.version = this.newVersion || state.version;
              state.inDfu = false;
              this._drop();
            }, 150);
          }
          return;
        }
        default:
          return this._respond(op, 0x02);
      }
    }

    async writePacket(u8) {
      if (!this._connected) throw new Error('GATT Server is disconnected.');
      if (u8.length > this.maxPacket) {
        this.stats.rejected++;
        throw new Error('GATT operation failed: value too long');
      }
      this.stats.packets++;
      if (this.dropRate && this.rng() < this.dropRate) {
        this.stats.dropped++;
        return;
      }
      const c = this.current;
      if (!c) return;
      for (const b of u8) if (c.data.length < c.size) c.data.push(b);
      if (this.prn && ++this.prnCount >= this.prn) {
        this.prnCount = 0;
        this._respond(0x03, OK, this._crcPayload(c.type));
      }
    }
  }

  Pixl.MockDfuTransport = MockDfuTransport;
  Pixl.demoFirmwarePackage = demoPackage;
})(typeof window !== 'undefined' ? window : globalThis);
