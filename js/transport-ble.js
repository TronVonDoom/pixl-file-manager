/* Web Bluetooth transport for Pixl.js (Nordic UART Service). */
(function (global) {
  'use strict';

  const Pixl = (global.Pixl = global.Pixl || {});

  const NUS_SERVICE = '6e400001-b5a3-f393-e0a9-e50e24dcca9e';
  const NUS_TX = '6e400002-b5a3-f393-e0a9-e50e24dcca9e'; // we write here
  const NUS_RX = '6e400003-b5a3-f393-e0a9-e50e24dcca9e'; // device notifies here

  class BleTransport {
    constructor(opts) {
      opts = opts || {};
      this.log = opts.log || function () {};
      this.device = null;
      this.tx = null;
      this.rx = null;
      this.onData = null;
      this.onDisconnect = null;
      this.userClosed = false;
      this._onNotify = this._onNotify.bind(this);
      this._onGattDisconnected = this._onGattDisconnected.bind(this);
    }

    static supported() {
      return !!(global.navigator && navigator.bluetooth && navigator.bluetooth.requestDevice);
    }

    get connected() {
      return !!(this.device && this.device.gatt && this.device.gatt.connected && this.tx);
    }

    get name() {
      return (this.device && this.device.name) || 'Pixl.js';
    }

    /** Shows the browser's device picker. Must be called from a user gesture. */
    async pick() {
      const device = await navigator.bluetooth.requestDevice({
        filters: [{ services: [NUS_SERVICE] }, { namePrefix: 'Pixl' }],
        optionalServices: [NUS_SERVICE],
      });
      if (this.device && this.device !== device) this.device.removeEventListener('gattserverdisconnected', this._onGattDisconnected);
      this.device = device;
      device.removeEventListener('gattserverdisconnected', this._onGattDisconnected);
      device.addEventListener('gattserverdisconnected', this._onGattDisconnected);
      return device;
    }

    /** Connects (or reconnects) to the picked device. Retries a few times: Windows often fails the first attempt. */
    async connect() {
      if (!this.device) throw new Error('No device selected');
      this.userClosed = false;
      let lastErr;
      for (let attempt = 1; attempt <= 3; attempt++) {
        try {
          this.tx = null;
          const server = await this.device.gatt.connect();
          const service = await server.getPrimaryService(NUS_SERVICE);
          const tx = await service.getCharacteristic(NUS_TX);
          const rx = await service.getCharacteristic(NUS_RX);
          if (this.rx) this.rx.removeEventListener('characteristicvaluechanged', this._onNotify);
          this.rx = rx;
          rx.addEventListener('characteristicvaluechanged', this._onNotify);
          await rx.startNotifications();
          this.tx = tx;
          return;
        } catch (e) {
          lastErr = e;
          this.log('warn', `Connect attempt ${attempt} failed: ${e.message || e}`);
          if (this.userClosed) break;
          try {
            if (this.device.gatt.connected) this.device.gatt.disconnect();
          } catch (_) {
            /* ignore */
          }
          await new Promise((r) => setTimeout(r, 700 * attempt));
        }
      }
      throw lastErr;
    }

    disconnect() {
      this.userClosed = true;
      if (this.device && this.device.gatt.connected) this.device.gatt.disconnect();
    }

    write(u8) {
      if (!this.tx) return Promise.reject(new Error('GATT Server is disconnected'));
      if (this.tx.writeValueWithResponse) return this.tx.writeValueWithResponse(u8);
      return this.tx.writeValue(u8);
    }

    _onNotify(e) {
      const v = e.target.value;
      const u8 = new Uint8Array(v.buffer.slice(v.byteOffset, v.byteOffset + v.byteLength));
      if (this.onData) this.onData(u8);
    }

    _onGattDisconnected() {
      this.tx = null;
      if (this.onDisconnect) this.onDisconnect();
    }
  }

  Pixl.BleTransport = BleTransport;
  Pixl.NUS_SERVICE = NUS_SERVICE;
})(window);
