/* Minimal ZIP reader (stored + deflate) for restoring backups and reading firmware packages. */
(function (global) {
  'use strict';

  const Pixl = (global.Pixl = global.Pixl || {});

  function u16(b, o) {
    return b[o] | (b[o + 1] << 8);
  }
  function u32(b, o) {
    return (b[o] | (b[o + 1] << 8) | (b[o + 2] << 16) | (b[o + 3] << 24)) >>> 0;
  }

  async function inflateRaw(u8) {
    if (typeof DecompressionStream === 'undefined') throw new Error('This browser can’t unpack compressed ZIP files');
    const stream = new Blob([u8]).stream().pipeThrough(new DecompressionStream('deflate-raw'));
    return new Uint8Array(await new Response(stream).arrayBuffer());
  }

  function decodeName(bytes, utf8) {
    if (utf8) return new TextDecoder().decode(bytes);
    // CP437 approximation: ASCII stays, other bytes as Latin-1
    let s = '';
    for (const b of bytes) s += String.fromCharCode(b);
    return s;
  }

  /**
   * @param src Blob | ArrayBuffer | Uint8Array
   * @returns Promise<Array<{ name, dir, size, read(): Promise<Uint8Array> }>>
   */
  async function readZip(src) {
    const buf = src instanceof Uint8Array ? src : new Uint8Array(src instanceof ArrayBuffer ? src : await src.arrayBuffer());
    let eocd = -1;
    for (let i = buf.length - 22; i >= Math.max(0, buf.length - 65557); i--) {
      if (u32(buf, i) === 0x06054b50) {
        eocd = i;
        break;
      }
    }
    if (eocd < 0) throw new Error('Not a ZIP file (or it is damaged)');
    const count = u16(buf, eocd + 10);
    let off = u32(buf, eocd + 16);
    if (off === 0xffffffff || count === 0xffff) throw new Error('ZIP64 archives aren’t supported');

    const entries = [];
    for (let i = 0; i < count; i++) {
      if (u32(buf, off) !== 0x02014b50) throw new Error('ZIP directory is damaged');
      const flags = u16(buf, off + 8);
      const method = u16(buf, off + 10);
      const crc = u32(buf, off + 16);
      const csize = u32(buf, off + 20);
      const size = u32(buf, off + 24);
      const nlen = u16(buf, off + 28);
      const xlen = u16(buf, off + 30);
      const clen = u16(buf, off + 32);
      const local = u32(buf, off + 42);
      const name = decodeName(buf.subarray(off + 46, off + 46 + nlen), (flags & 0x0800) !== 0).replace(/\\/g, '/');
      off += 46 + nlen + xlen + clen;
      const dir = name.endsWith('/');
      entries.push({
        name,
        dir,
        size,
        async read() {
          if (dir) return new Uint8Array(0);
          if (flags & 1) throw new Error(`${name} is encrypted`);
          if (u32(buf, local) !== 0x04034b50) throw new Error(`${name}: damaged entry`);
          const start = local + 30 + u16(buf, local + 26) + u16(buf, local + 28);
          const comp = buf.subarray(start, start + csize);
          let data;
          if (method === 0) data = comp.slice();
          else if (method === 8) data = await inflateRaw(comp);
          else throw new Error(`${name}: unsupported compression (method ${method})`);
          if (data.length !== size || (Pixl.crc32 && Pixl.crc32(data) !== crc)) throw new Error(`${name}: checksum mismatch, the ZIP is damaged`);
          return data;
        },
      });
    }
    return entries;
  }

  /** True for junk entries that archivers add (macOS resource forks etc.) */
  function isJunkEntry(name) {
    return /(^|\/)__MACOSX\//.test(name) || /(^|\/)(\.DS_Store|Thumbs\.db|desktop\.ini)$/i.test(name);
  }

  Pixl.readZip = readZip;
  Pixl.isJunkZipEntry = isJunkEntry;
})(typeof window !== 'undefined' ? window : globalThis);
