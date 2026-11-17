/* Test suite: protocol (against the firmware emulator), amiibo tools, ZIP, firmware update, sync logic. */
(function (global) {
  'use strict';

  const { test, assert, seededRng } = global.T;
  const P = global.Pixl;
  const PP = P.path;

  const pattern = (n, seed) => {
    const out = new Uint8Array(n);
    for (let i = 0; i < n; i++) out[i] = (i * 31 + seed * 7 + (i >> 8)) & 255;
    return out;
  };

  async function rig(opts) {
    const t = new P.MockTransport(Object.assign({ fresh: true, latency: 1 }, opts || {}));
    await t.connect();
    const c = new P.PixlClient(t, { timeout: 500, ioTimeout: 250, quietMs: 40 });
    return { t, c, fs: t.fs };
  }

  /* --------------------------------------------------------------- paths */

  test('paths: join, parent, basename, root', () => {
    assert.equal(PP.join('E:/', 'a'), 'E:/a');
    assert.equal(PP.join('E:/a', 'b.bin'), 'E:/a/b.bin');
    assert.equal(PP.parent('E:/a/b.bin'), 'E:/a');
    assert.equal(PP.parent('E:/a'), 'E:/');
    assert.equal(PP.parent('E:/'), 'E:/');
    assert.equal(PP.basename('E:/a/b.bin'), 'b.bin');
    assert.ok(PP.isRoot('E:/'));
  });

  test('paths: device name limits, fitting and unique names', () => {
    assert.equal(PP.nameBudget('E:/'), 47);
    assert.equal(PP.nameBudget('E:/' + 'x'.repeat(30)), 63 - 34);
    assert.ok(PP.validateName('a'.repeat(48)), 'too long name rejected');
    assert.equal(PP.validateName('ok.bin', 'E:/'), null);
    assert.ok(PP.validateName('a/b'), 'slash rejected');
    const fitted = PP.fit('A very long amiibo file name that will not fit.bin', 20);
    assert.ok(PP.byteLen(fitted) <= 20 && fitted.endsWith('.bin'), fitted);
    const taken = new Set(['Mario.bin', 'Mario (2).bin']);
    assert.equal(PP.unique('Mario.bin', 47, (n) => taken.has(n)), 'Mario (3).bin');
    assert.ok(PP.byteLen(PP.fit('日本語の名前がとても長いファイル名です.bin', 20)) <= 20, 'multi-byte names fit by bytes');
  });

  /* ------------------------------------------------------------ protocol */

  test('protocol: version and drive list', async () => {
    const { c } = await rig();
    const v = await c.getVersion();
    assert.ok(v.version.length > 0);
    const drives = await c.getDrives();
    assert.equal(drives.length, 1);
    assert.equal(drives[0].label, 'E');
    assert.ok(drives[0].free > 0 && drives[0].free <= drives[0].total, 'free space is free, not used');
  });

  test('protocol: files of every boundary size round-trip byte-exact', async () => {
    const { c } = await rig();
    for (const n of [0, 1, 242, 243, 244, 485, 486, 729, 540, 5000, 20011]) {
      const data = pattern(n, n);
      await c.writeFile(`E:/t${n}.bin`, data);
      assert.bytes(await c.readFile(`E:/t${n}.bin`), data, `size ${n}`);
    }
  });

  test('protocol: large folder listing spans several packets', async () => {
    const { c } = await rig();
    await c.mkdir('E:/many');
    for (let i = 0; i < 40; i++) await c.writeFile(`E:/many/file-with-a-longish-name-${i}.bin`, Uint8Array.of(i));
    const items = await c.listDir('E:/many');
    assert.equal(items.length, 40);
    assert.ok(items.every((i) => i.size === 1 && !i.isDir));
  });

  test('protocol: notes, hidden flag and amiibo id survive a round trip', async () => {
    const { c } = await rig();
    await c.writeFile('E:/m.bin', pattern(540, 1));
    await c.updateMeta('E:/m.bin', { notes: 'héllo 🌟', hidden: true, readonly: false, amiibo: { head: 0x01020304, tail: 0x0a0b0c02 } });
    const m = (await c.listDir('E:/')).find((i) => i.name === 'm.bin').meta;
    assert.equal(m.notes, 'héllo 🌟');
    assert.equal(m.hidden, true);
    assert.equal(P.amiibo.idFromMeta(m), '010203040a0b0c02');
  });

  test('protocol: device errors become clear messages', async () => {
    const { c } = await rig();
    await assert.rejects(c.readFile('E:/nope.bin'), /Open nope\.bin/);
    await c.mkdir('E:/full');
    await c.writeFile('E:/full/x.bin', Uint8Array.of(1));
    const e = await assert.rejects(c.remove('E:/full'), /Delete full/);
    assert.equal(e.code, 'STATUS');
  });

  test('protocol: emulator reproduces the firmware folder-rename bug', async () => {
    const { c } = await rig();
    await c.mkdir('E:/old');
    await c.rename('E:/old', 'E:/new'); // firmware reports success...
    const names = (await c.listDir('E:/')).map((i) => i.name);
    assert.ok(names.includes('old') && !names.includes('new'), '...but nothing changes');
  });

  test('protocol: survives 10% lost replies (resumable writes, gap-filling reads)', async () => {
    const { c, fs } = await rig({ faults: 0.1, rng: seededRng(42) });
    const data = pattern(9000, 3);
    await P.withRetry(() => c.writeFile('E:/lossy.bin', data), { attempts: 6 });
    assert.bytes(fs.lookup('E:/lossy.bin').data, data, 'flash contents');
    const back = await P.withRetry(() => c.readFile('E:/lossy.bin'), { attempts: 6 });
    assert.bytes(back, data, 'read back');
  }, { timeout: 60000 });

  test('protocol: fast writes batch frames and still land byte-exact', async () => {
    const { c, t, fs } = await rig();
    let frames = 0;
    let replies = 0;
    const w = t.write.bind(t);
    t.write = (f) => {
      frames++;
      return w(f);
    };
    t.writeFast = t.write;
    const onData = t.onData;
    t.onData = (u8) => {
      if (u8[0] === 0x15) replies++;
      onData(u8);
    };
    c.fastWrites = true;
    const data = pattern(20000, 9);
    await c.writeFile('E:/fast.bin', data);
    assert.bytes(fs.lookup('E:/fast.bin').data, data);
    assert.ok(replies <= Math.ceil(83 / c.fastWindow) + 1, `only one reply per batch (got ${replies})`);
    assert.ok(frames >= 83);
  });

  test('protocol: fast writes recover from lost replies too', async () => {
    const { c, fs } = await rig({ faults: 0.08, rng: seededRng(5) });
    c.fastWrites = true;
    const data = pattern(15000, 4);
    await P.withRetry(() => c.writeFile('E:/fastlossy.bin', data), { attempts: 6 });
    assert.bytes(fs.lookup('E:/fastlossy.bin').data, data);
  }, { timeout: 60000 });

  test('protocol: a dropped link fails fast with a retryable error', async () => {
    const { c, t } = await rig();
    const p = c.writeFile('E:/drop.bin', pattern(20000, 1));
    setTimeout(() => t.simulateDrop(), 30);
    const e = await assert.rejects(p);
    assert.equal(e.code, 'DISCONNECTED');
    assert.ok(e.retryable);
  });

  /* -------------------------------------------------------------- amiibo */

  function dump(idHex) {
    const d = pattern(540, 2);
    d.set([0xf1, 0x10, 0xff, 0xee], 12);
    for (let i = 0; i < 8; i++) d[0x54 + i] = parseInt(idHex.substr(i * 2, 2), 16);
    return d;
  }

  test('amiibo: ID is read from a dump; blanks are rejected', () => {
    assert.equal(P.amiibo.idFromDump(dump('0000000000340102')), '0000000000340102');
    const notAmiibo = pattern(540, 1);
    notAmiibo[0x5b] = 0x99;
    assert.equal(P.amiibo.idFromDump(notAmiibo), null);
    assert.equal(P.amiibo.idFromDump(new Uint8Array(540)), null);
  });

  test('amiibo: Flipper Zero .nfc converts to a 540-byte .bin', () => {
    const d = dump('1919000000090002');
    let text = 'Filetype: Flipper NFC device\nVersion: 4\nDevice type: NTAG/Ultralight\nUID: 04 11 22 33 44 55 66\nPages total: 135\n';
    for (let p = 0; p < 135; p++) {
      text += `Page ${p}: ${Array.from(d.subarray(p * 4, p * 4 + 4), (b) => b.toString(16).padStart(2, '0').toUpperCase()).join(' ')}\n`;
    }
    const a = P.amiibo.analyze('Pikachu.nfc', new TextEncoder().encode(text));
    assert.equal(a.converted, 'Flipper Zero .nfc');
    assert.equal(a.name, 'Pikachu.bin');
    assert.equal(a.kind, 'amiibo');
    assert.equal(a.id, '1919000000090002');
    assert.bytes(a.data, d);
  });

  test('amiibo: Proxmark .eml converts too', () => {
    const d = dump('0100000000040002');
    let text = '';
    for (let p = 0; p < 135; p++) text += Array.from(d.subarray(p * 4, p * 4 + 4), (b) => b.toString(16).padStart(2, '0')).join('') + '\n';
    const a = P.amiibo.analyze('link.eml', new TextEncoder().encode(text));
    assert.equal(a.converted, 'Proxmark .eml');
    assert.equal(a.id, '0100000000040002');
  });

  test('amiibo: wrong-size .bin is flagged only where amiibo are expected', () => {
    assert.ok(P.amiibo.analyze('x.bin', pattern(100, 1), { amiiboContext: true }).warning);
    assert.equal(P.amiibo.analyze('x.bin', pattern(100, 1), { amiiboContext: false }).warning, null);
    assert.equal(P.amiibo.analyze('tag.bin', pattern(2048, 1)).kind, 'tag');
  });

  test('amiibo: database lookup resolves name, series, game, picture', () => {
    const db = new P.amiibo.AmiiboDb({ storage: null, fetch: null });
    db.ingest({
      amiibos: { '0x0000000000340102': { name: 'Mario' } },
      amiibo_series: { '0x01': 'Super Mario Bros.' },
      game_series: { '0x000': 'Super Mario' },
      characters: { '0x0000': 'Mario' },
      types: { '0x00': 'Figure' },
    });
    const info = db.lookup('0000000000340102');
    assert.equal(info.name, 'Mario');
    assert.equal(info.series, 'Super Mario Bros.');
    assert.equal(info.game, 'Super Mario');
    assert.equal(info.type, 'Figure');
    assert.ok(info.image.endsWith('icon_00000000-00340102.png'));
    assert.equal(db.lookup('00000000ffff0102').name, 'Mario', 'unknown figure falls back to character');
  });

  test('amiibo: release dates and game list are parsed', () => {
    const db = new P.amiibo.AmiiboDb({ storage: null, fetch: null });
    db.ingest({ amiibos: { '0x0000000000000002': { name: 'Mario', release: { na: '2014-11-21', eu: '2014-11-28', jp: '2014-12-06', au: null } } } });
    assert.deepEqual(db.lookup('0000000000000002').release, { na: '2014-11-21', eu: '2014-11-28', jp: '2014-12-06', au: '' });
    assert.equal(db.games('0000000000000002'), null, 'not loaded yet');
    db.ingestGames({
      amiibos: {
        '0x0000000000000002': {
          games3DS: [{ gameName: 'Old game', amiiboUsage: [{ Usage: 'Unlock a hat', write: false }] }],
          gamesSwitch: [{ gameName: 'New game', amiiboUsage: [{ Usage: 'Save progress', write: true }, { Usage: 'Costume', write: false }] }],
        },
      },
    });
    const g = db.games('0000000000000002');
    assert.equal(g.length, 2);
    assert.equal(g[0].platform, 'Switch', 'newest platform first');
    assert.equal(g[0].writes, true);
    assert.equal(g[0].usage, 'Save progress · Costume');
    assert.deepEqual(db.games('ffffffffffffffff'), []);
  });

  /* ------------------------------------------------------------ organize */

  const mario = { name: 'Mario', series: 'Super Smash Bros.', game: 'Super Mario' };
  const isabelle = { name: 'Isabelle', series: 'Animal Crossing', game: 'Animal Crossing' };

  test('organize: files go to <Series>/<Name>.bin; trailing dots kept on the device, dropped on a PC', () => {
    const o = P.organize;
    assert.deepEqual(o.targetFor(mario, { group: 'series', naming: 'name' }, 'x.bin'), { folder: 'Super Smash Bros.', name: 'Mario.bin' });
    assert.deepEqual(o.targetFor(mario, { group: 'series', naming: 'name', pc: true }, 'x.bin'), { folder: 'Super Smash Bros', name: 'Mario.bin' });
    assert.deepEqual(o.targetFor(mario, { group: 'game', naming: 'keep' }, 'x.bin'), { folder: 'Super Mario', name: 'x.bin' });
    assert.deepEqual(o.targetFor(mario, { group: 'none' }, 'x.bin'), { folder: '', name: 'Mario.bin' });
    assert.equal(o.clean('A/B: "C"?'), 'A B C', 'characters files can’t have are removed');
    assert.ok(o.isVariantOf('Mario (2).bin', 'Mario.bin'));
    assert.ok(!o.isVariantOf('Mario Kart.bin', 'Mario.bin'));
  });

  test('organize: placement never overwrites and leaves tidy files alone', () => {
    const items = [
      { path: 'E:/amiibo/Super Smash Bros./Mario.bin', id: '1', info: mario },
      { path: 'E:/amiibo/Super Smash Bros./Mario (2).bin', id: '1', info: mario },
      { path: 'E:/amiibo/loose.bin', id: '1', info: mario },
      { path: 'E:/amiibo/isa.bin', id: '2', info: isabelle },
      { path: 'E:/amiibo/what.bin', id: null, info: null },
    ];
    const occupied = items.map((i) => i.path).concat(['E:/amiibo/Animal Crossing/Isabelle.bin']);
    const r = P.organize.place(items, occupied, 'E:/amiibo', { group: 'series', naming: 'name' });
    assert.equal(r.inPlace.length, 2, 'Mario.bin and Mario (2).bin are already right');
    assert.equal(r.unknown.length, 1);
    assert.deepEqual(
      r.moves.map((m) => m.to),
      ['E:/amiibo/Super Smash Bros./Mario (3).bin', 'E:/amiibo/Animal Crossing/Isabelle (2).bin']
    );
    // new files (library "Send") go next to existing ones without clashing
    const send = P.organize.place([{ name: 'm.bin', id: '1', info: mario }], occupied, 'E:/amiibo', { group: 'series' });
    assert.equal(send.moves[0].to, 'E:/amiibo/Super Smash Bros./Mario (3).bin');
  });

  /* ----------------------------------------------------------------- zip */

  test('zip: write then read back (stored, UTF-8 names, folders)', async () => {
    const files = [
      { name: 'amiibo/', dir: true },
      { name: 'amiibo/Mario.bin', data: pattern(540, 1) },
      { name: 'amiibo/ポケモン.bin', data: pattern(540, 2) },
      { name: 'readme.txt', data: new TextEncoder().encode('hi') },
    ];
    const blob = P.buildZip(files);
    const entries = await P.readZip(blob);
    assert.deepEqual(
      entries.map((e) => e.name),
      files.map((f) => f.name)
    );
    assert.bytes(await entries[2].read(), files[2].data);
  });

  async function deflateZip(name, data) {
    const comp = new Uint8Array(await new Response(new Blob([data]).stream().pipeThrough(new CompressionStream('deflate-raw'))).arrayBuffer());
    const n = new TextEncoder().encode(name);
    const crc = P.crc32(data);
    const local = new DataView(new ArrayBuffer(30));
    local.setUint32(0, 0x04034b50, true);
    local.setUint16(4, 20, true);
    local.setUint16(8, 8, true);
    local.setUint32(14, crc, true);
    local.setUint32(18, comp.length, true);
    local.setUint32(22, data.length, true);
    local.setUint16(26, n.length, true);
    const cd = new DataView(new ArrayBuffer(46));
    cd.setUint32(0, 0x02014b50, true);
    cd.setUint16(10, 8, true);
    cd.setUint32(16, crc, true);
    cd.setUint32(20, comp.length, true);
    cd.setUint32(24, data.length, true);
    cd.setUint16(28, n.length, true);
    cd.setUint32(42, 0, true);
    const cdOff = 30 + n.length + comp.length;
    const end = new DataView(new ArrayBuffer(22));
    end.setUint32(0, 0x06054b50, true);
    end.setUint16(8, 1, true);
    end.setUint16(10, 1, true);
    end.setUint32(12, 46 + n.length, true);
    end.setUint32(16, cdOff, true);
    const parts = [new Uint8Array(local.buffer), n, comp, new Uint8Array(cd.buffer), n, new Uint8Array(end.buffer)];
    return new Uint8Array(await new Blob(parts).arrayBuffer());
  }

  test('zip: reads compressed (deflate) archives and catches corruption', async () => {
    const data = new TextEncoder().encode('amiibo '.repeat(500));
    const zip = await deflateZip('notes.txt', data);
    const [e] = await P.readZip(zip);
    assert.bytes(await e.read(), data);
    const broken = zip.slice();
    broken[40] ^= 0xff; // flip a byte inside the compressed data
    const [e2] = await P.readZip(broken);
    await assert.rejects(e2.read());
  });

  /* ----------------------------------------------------- firmware update */

  function dfuRig(opts) {
    const t = new P.MockDfuTransport(Object.assign({ requireDfuMode: false, latency: 0 }, opts || {}));
    return t.connect().then(() => t);
  }

  test('firmware: full Secure DFU transfer installs the new version', async () => {
    const before = P.mockState.version;
    const pkg = P.demoFirmwarePackage('9.9.9-test', 30000);
    const t = await dfuRig();
    const dfu = new P.dfu.SecureDfu(t, {});
    let last = 0;
    await dfu.update(pkg.images[0], (sent) => (last = sent));
    assert.equal(last, 30000);
    assert.bytes(t.executed[2], pkg.images[0].firmware);
    await new Promise((r) => setTimeout(r, 250));
    assert.equal(P.mockState.version, '9.9.9-test');
    assert.equal(t.connected, false, 'device rebooted');
    P.mockState.version = before;
  });

  test('firmware: falls back to small packets when large ones are rejected', async () => {
    const pkg = P.demoFirmwarePackage('1.0.1', 9000);
    const t = await dfuRig({ maxPacket: 20 });
    const dfu = new P.dfu.SecureDfu(t, {});
    await dfu.update(pkg.images[0]);
    assert.equal(dfu.packetSize, 20);
    assert.bytes(t.executed[2], pkg.images[0].firmware);
  });

  test('firmware: lost packets are detected by CRC and resent', async () => {
    const pkg = P.demoFirmwarePackage('1.0.2', 20000);
    const t = await dfuRig({ dropRate: 0.01, rng: seededRng(11) });
    const dfu = new P.dfu.SecureDfu(t, {});
    await dfu.update(pkg.images[0]);
    assert.ok(t.stats.dropped > 0, 'some packets really were dropped');
    assert.bytes(t.executed[2], pkg.images[0].firmware);
  }, { timeout: 60000 });

  test('firmware: an unsigned package is refused with a clear reason', async () => {
    const pkg = P.demoFirmwarePackage('1.0.3', 5000);
    pkg.images[0].init[0] = 0x58; // corrupt the "signature"
    const t = await dfuRig();
    await assert.rejects(new P.dfu.SecureDfu(t, {}).update(pkg.images[0]), /signature/i);
  });

  test('firmware: nrfutil package ZIP is parsed; wrong ZIPs are explained', async () => {
    const manifest = JSON.stringify({ manifest: { application: { bin_file: 'pixljs.bin', dat_file: 'pixljs.dat' } } });
    const zip = P.buildZip([
      { name: 'manifest.json', data: new TextEncoder().encode(manifest) },
      { name: 'pixljs.bin', data: pattern(4000, 1) },
      { name: 'pixljs.dat', data: pattern(141, 2) },
    ]);
    const file = new File([zip], 'pixjs_ota_v237.zip');
    const pkg = await P.dfu.loadPackage(file);
    assert.equal(pkg.version, '237');
    assert.equal(pkg.images.length, 1);
    assert.equal(pkg.images[0].type, 'application');
    assert.equal(pkg.images[0].firmware.length, 4000);
    const outer = new File([P.buildZip([{ name: 'pixljs_all.hex', data: pattern(10, 1) }])], 'pixljs_v237.zip');
    await assert.rejects(P.dfu.loadPackage(outer), /OTA package/);
  });

  /* ----------------------------------------------------------- sync logic */

  test('sync: differences are classified and actions follow the direction', () => {
    const local = new Map([
      ['a.bin', { isDir: false, size: 540 }],
      ['b.bin', { isDir: false, size: 540 }],
      ['c.bin', { isDir: false, size: 10 }],
      ['new', { isDir: true }],
      ['new/x.bin', { isDir: false, size: 1 }],
    ]);
    const device = new Map([
      ['a.bin', { isDir: false, size: 540 }],
      ['b.bin', { isDir: false, size: 540 }],
      ['c.bin', { isDir: false, size: 11 }],
      ['old.bin', { isDir: false, size: 5 }],
    ]);
    const same = new Map([
      ['a.bin', true],
      ['b.bin', false],
    ]);
    const d = P.sync.diffTrees(local, device, same);
    const st = Object.fromEntries(d.map((e) => [e.rel, e.status]));
    assert.deepEqual(st, { 'a.bin': 'same', 'b.bin': 'differs', 'c.bin': 'differs', new: 'local-only', 'new/x.bin': 'local-only', 'old.bin': 'device-only' });
    const act = (mode, del) => Object.fromEntries(d.map((e) => [e.rel, P.sync.defaultAction(e, mode, del)]));
    assert.equal(act('two-way')['b.bin'], 'skip', 'two-way never overwrites');
    assert.equal(act('two-way')['old.bin'], 'download');
    assert.equal(act('to-device')['b.bin'], 'upload');
    assert.equal(act('to-device')['old.bin'], 'skip');
    assert.equal(act('to-device', true)['old.bin'], 'delete-device');
    assert.equal(act('to-pc', true)['new'], 'delete-pc');
    const rows = d.map((e) => Object.assign({}, e, { action: P.sync.defaultAction(e, 'to-pc', true) })).filter((r) => r.action !== 'skip');
    const collapsed = P.sync.collapse(rows).map((r) => r.rel);
    assert.ok(collapsed.includes('new') && !collapsed.includes('new/x.bin'), 'children of a deleted folder are folded in');
  });
})(typeof window !== 'undefined' ? window : globalThis);
