/*
 * Amiibo knowledge: identify dumps, look up names/series/pictures, and
 * convert other dump formats (Flipper Zero .nfc, Proxmark .eml) to .bin.
 *
 * Names come from the open AmiiboAPI database (github.com/N3evin/AmiiboAPI),
 * fetched once and cached locally. Only the public database file and picture
 * files are requested; nothing about your files or device is sent anywhere.
 */
(function (global) {
  'use strict';

  const Pixl = (global.Pixl = global.Pixl || {});

  const DB_URL = 'https://raw.githubusercontent.com/N3evin/AmiiboAPI/master/database/amiibo.json';
  const IMG_BASE = 'https://raw.githubusercontent.com/N3evin/AmiiboAPI/master/images/';
  const CACHE_KEY = 'pixlfm.amiibodb.v1';
  const MAX_AGE = 7 * 24 * 3600 * 1000;

  const AMIIBO_SIZES = [532, 540, 572]; // NTAG215 dumps: TagMo, standard, with signature
  const DEVICE_SIZES = [532, 540, 572, 2048]; // what Pixl.js firmware loads (2048 = NTAG I2C 2K)

  const hex2 = (b) => (b < 16 ? '0' : '') + b.toString(16);

  /** 16-hex-digit amiibo ID from a raw dump, or null. Bytes 0x54..0x5B, last byte is always 0x02. */
  function idFromDump(u8) {
    if (!u8 || u8.length < 92 || u8[0x5b] !== 0x02) return null;
    let s = '';
    for (let i = 0x54; i < 0x5c; i++) s += hex2(u8[i]);
    if (s === '0000000000000002' && u8[0x54] === 0 && !u8.subarray(0x10, 0x54).some((b) => b)) return null; // blank tag
    return s;
  }

  function idFromMeta(meta) {
    if (!meta || !meta.amiibo || (!meta.amiibo.head && !meta.amiibo.tail)) return null;
    return meta.amiibo.head.toString(16).padStart(8, '0') + meta.amiibo.tail.toString(16).padStart(8, '0');
  }

  function imageUrl(id) {
    return `${IMG_BASE}icon_${id.slice(0, 8)}-${id.slice(8, 16)}.png`;
  }

  function prettyId(id) {
    return id ? id.toUpperCase().replace(/(.{8})/, '$1 ') : '';
  }

  /* ------------------------------------------------------------- database */

  class AmiiboDb {
    constructor(opts) {
      opts = opts || {};
      this.log = opts.log || function () {};
      this.fetch = opts.fetch || (global.fetch ? global.fetch.bind(global) : null);
      this.storage = opts.storage !== undefined ? opts.storage : safeStorage();
      this.data = null; // { t, a: {id: name}, s: {}, g: {}, c: {}, y: {} }
      this.listeners = [];
      this._loading = null;
    }

    get ready() {
      return !!this.data;
    }

    onChange(fn) {
      this.listeners.push(fn);
    }

    /** Loads from cache, and from the network if allowed and the cache is missing/stale. */
    load(allowNetwork) {
      if (!this.data) {
        try {
          const raw = this.storage && this.storage.getItem(CACHE_KEY);
          if (raw) this.data = JSON.parse(raw);
        } catch (e) {
          this.data = null;
        }
      }
      const stale = !this.data || Date.now() - (this.data.t || 0) > MAX_AGE;
      if (allowNetwork && stale && this.fetch && !this._loading) {
        this._loading = this.refresh()
          .catch((e) => this.log('warn', `Couldn’t download the amiibo name list: ${e.message}`))
          .then(() => (this._loading = null));
      }
      return this._loading || Promise.resolve();
    }

    async refresh() {
      const res = await this.fetch(DB_URL, { cache: 'no-cache' });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      this.ingest(await res.json());
      try {
        if (this.storage) this.storage.setItem(CACHE_KEY, JSON.stringify(this.data));
      } catch (e) {
        /* storage full or blocked: keep it in memory */
      }
      this.log('info', `Amiibo name list loaded (${Object.keys(this.data.a).length} figures)`);
      this.listeners.forEach((fn) => fn());
    }

    /** Accepts the AmiiboAPI database JSON. */
    ingest(json) {
      const strip = (o) => {
        const out = {};
        Object.keys(o || {}).forEach((k) => (out[k.replace(/^0x/i, '').toLowerCase()] = o[k]));
        return out;
      };
      const a = {};
      Object.keys(json.amiibos || {}).forEach((k) => {
        a[k.replace(/^0x/i, '').toLowerCase()] = json.amiibos[k].name;
      });
      this.data = {
        t: Date.now(),
        a,
        s: strip(json.amiibo_series),
        g: strip(json.game_series),
        c: strip(json.characters),
        y: strip(json.types),
      };
    }

    /** Info for an ID (16 hex). Works partially even for figures newer than the list. */
    lookup(id) {
      if (!id) return null;
      id = id.toLowerCase();
      const d = this.data;
      const info = { id, name: null, series: null, game: null, character: null, type: null, image: imageUrl(id) };
      if (!d) return info;
      info.name = d.a[id] || null;
      info.series = d.s[id.slice(12, 14)] || null;
      info.game = d.g[id.slice(0, 3)] || null;
      info.character = d.c[id.slice(0, 4)] || null;
      info.type = d.y[id.slice(6, 8)] || null;
      if (!info.name && info.character) info.name = info.character;
      return info;
    }
  }

  function safeStorage() {
    try {
      return global.localStorage || null;
    } catch (e) {
      return null;
    }
  }

  /* -------------------------------------------------------------- formats */

  const dec = new TextDecoder();

  function parseFlipper(text) {
    if (!/^Filetype:\s*Flipper NFC device/m.test(text)) return null;
    const pages = [];
    const re = /^Page\s+(\d+):\s*([0-9A-Fa-f?]{2}(?:\s+[0-9A-Fa-f?]{2}){3})\s*$/gm;
    let m;
    while ((m = re.exec(text))) {
      pages[+m[1]] = m[2].split(/\s+/).map((h) => (h.includes('?') ? 0 : parseInt(h, 16)));
    }
    return pagesToBytes(pages);
  }

  function parseEml(text) {
    const lines = text
      .split(/\r?\n/)
      .map((l) => l.trim())
      .filter(Boolean);
    if (!lines.length || !lines.every((l) => /^[0-9A-Fa-f]{8}$/.test(l))) return null;
    return pagesToBytes(lines.map((l) => [0, 2, 4, 6].map((i) => parseInt(l.slice(i, i + 2), 16))));
  }

  function pagesToBytes(pages) {
    if (!pages.length) return null;
    for (let i = 0; i < pages.length; i++) if (!pages[i]) return null; // gaps
    const out = new Uint8Array(pages.length * 4);
    pages.forEach((p, i) => out.set(p, i * 4));
    return out;
  }

  function looksLikeText(u8) {
    const n = Math.min(u8.length, 256);
    for (let i = 0; i < n; i++) {
      const b = u8[i];
      if (b < 32 && b !== 9 && b !== 10 && b !== 13) return false;
    }
    return true;
  }

  function withExt(name, ext) {
    const dot = name.lastIndexOf('.');
    return (dot > 0 ? name.slice(0, dot) : name) + ext;
  }

  /**
   * Inspects a file about to be uploaded.
   * @returns {{ name, data, kind: 'amiibo'|'tag'|'other', id, converted, warning }}
   */
  function analyze(name, data, opts) {
    opts = opts || {};
    const ext = (name.match(/\.[^.]+$/) || [''])[0].toLowerCase();
    const res = { name, data, kind: 'other', id: null, converted: null, warning: null };

    if ((ext === '.nfc' || ext === '.eml' || ext === '.txt') && data.length < 64 * 1024 && looksLikeText(data)) {
      const text = dec.decode(data);
      let bytes = null;
      let from = null;
      if (ext !== '.eml' && (bytes = parseFlipper(text))) from = 'Flipper Zero .nfc';
      else if ((bytes = parseEml(text))) from = 'Proxmark .eml';
      if (bytes) {
        if (DEVICE_SIZES.indexOf(bytes.length) < 0) {
          res.warning = `${from} file isn’t an NTAG215 dump (${bytes.length} bytes), so it wasn’t converted`;
          return res;
        }
        res.data = bytes;
        res.name = withExt(name, '.bin');
        res.converted = from;
      } else if (/Flipper NFC device/.test(text)) {
        res.warning = 'Flipper file has no complete page data, so it wasn’t converted';
        return res;
      }
    }

    const d = res.data;
    if (AMIIBO_SIZES.indexOf(d.length) >= 0) {
      res.id = idFromDump(d);
      res.kind = res.id ? 'amiibo' : 'tag';
      if (!res.id && (ext === '.bin' || res.converted)) res.warning = 'No amiibo ID inside; this looks like a blank or non-amiibo tag';
    } else if (d.length === 2048) {
      res.kind = 'tag';
    } else if ((ext === '.bin' || res.converted) && opts.amiiboContext) {
      res.warning = `Not a tag dump (${d.length} bytes); the Pixl.js expects 540-byte amiibo files`;
    }
    return res;
  }

  Pixl.amiibo = {
    AmiiboDb,
    AMIIBO_SIZES,
    DEVICE_SIZES,
    idFromDump,
    idFromMeta,
    imageUrl,
    prettyId,
    analyze,
    parseFlipper,
    parseEml,
    DB_URL,
  };
})(typeof window !== 'undefined' ? window : globalThis);
