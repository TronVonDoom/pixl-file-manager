/*
 * Amiibo library: a folder of amiibo on this computer (your whole collection)
 * side by side with what's on the Pixl.js.
 *   Send →    copies selected library amiibo to the Pixl, filed as <Series>/<Name>.bin
 *   ← Save    copies selected Pixl amiibo into the library (backups, new save data)
 *   Remove    deletes from the Pixl, after checking the library has an identical copy
 */
(function (global) {
  'use strict';

  const Pixl = (global.Pixl = global.Pixl || {});
  const JUNK = /^(desktop\.ini|thumbs\.db|\.ds_store)$/i;
  const BLOCK = 4096; // every file takes at least one flash block on the Pixl.js
  let ctx = null;

  const L = {
    built: false,
    handle: null, // FileSystemDirectoryHandle (Chrome/Edge desktop)
    files: null, // fallback: File[] from a folder <input>
    name: '',
    writable: false,
    pendingHandle: null, // remembered folder that needs permission again
    items: [],
    skipped: 0,
    loading: false,
    error: '',
    q: '',
    series: '',
    sel: new Set(),
    anchor: null,
    dev: { items: [], paths: [], scanned: false, scanning: false, error: '', others: 0 },
    dq: '',
    dseries: '',
    dsel: new Set(),
    danchor: null,
    focus: null, // { side: 'lib' | 'dev', key }
  };

  const $ = (sel) => ctx.el.library.querySelector(sel);
  const fsaSupported = () => typeof global.showDirectoryPicker === 'function';

  /* ------------------------------------------------------------ storage */

  function idb() {
    return new Promise((resolve, reject) => {
      const req = indexedDB.open('pixlfm', 1);
      req.onupgradeneeded = () => req.result.createObjectStore('handles');
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
  }
  async function saveHandle(h) {
    try {
      const d = await idb();
      d.transaction('handles', 'readwrite').objectStore('handles').put(h, 'library');
    } catch (e) {
      /* not storable (e.g. in tests) */
    }
  }
  async function loadHandle() {
    try {
      const d = await idb();
      return await new Promise((resolve) => {
        const r = d.transaction('handles').objectStore('handles').get('library');
        r.onsuccess = () => resolve(r.result || null);
        r.onerror = () => resolve(null);
      });
    } catch (e) {
      return null;
    }
  }

  /* ------------------------------------------------------------ helpers */

  const info = (id) => ctx.db.lookup(id);
  const libIds = () => new Set(L.items.map((i) => i.id));
  const devIds = () => new Set(L.dev.items.map((i) => i.id));
  function seriesOf(id) {
    const i = info(id);
    return (i && i.series) || 'Unknown series';
  }
  function matches(it, q) {
    if (!q) return true;
    const i = info(it.id) || {};
    q = q.toLowerCase();
    return [it.name, i.name, i.series, i.game, i.character].some((v) => v && v.toLowerCase().includes(q));
  }
  function sortItems(list) {
    const col = new Intl.Collator(undefined, { numeric: true, sensitivity: 'base' });
    return list.slice().sort((a, b) => col.compare(seriesOf(a.id), seriesOf(b.id)) || col.compare((info(a.id) || {}).name || a.name, (info(b.id) || {}).name || b.name));
  }
  function visibleLib() {
    return sortItems(L.items.filter((it) => matches(it, L.q) && (!L.series || seriesOf(it.id) === L.series)));
  }
  function visibleDev() {
    return sortItems(L.dev.items.filter((it) => matches(it, L.dq) && (!L.dseries || seriesOf(it.id) === L.dseries)));
  }
  const selectedLib = () => L.items.filter((i) => L.sel.has(i.key));
  const selectedDev = () => L.dev.items.filter((i) => L.dsel.has(i.key));

  async function dirFor(root, rel, create) {
    let h = root;
    for (const seg of rel.split('/').filter(Boolean)) h = await h.getDirectoryHandle(seg, { create });
    return h;
  }

  /* -------------------------------------------------------- the library */

  async function chooseFolder() {
    if (fsaSupported()) {
      try {
        const h = await global.showDirectoryPicker({ id: 'pixl-library', mode: 'readwrite' });
        await useHandle(h, true);
      } catch (e) {
        if (e.name !== 'AbortError') ctx.toast('Couldn’t open that folder: ' + e.message, 'error');
      }
    } else {
      $('#libInput').click();
    }
  }

  async function useHandle(h, remember) {
    L.handle = h;
    L.files = null;
    L.name = h.name;
    L.pendingHandle = null;
    let perm = 'granted';
    try {
      perm = await h.queryPermission({ mode: 'readwrite' });
    } catch (e) {
      /* older API */
    }
    L.writable = perm === 'granted';
    if (remember) saveHandle(h);
    await scanLibrary();
  }

  async function reconnectFolder() {
    const h = L.pendingHandle;
    if (!h) return chooseFolder();
    try {
      const perm = await h.requestPermission({ mode: 'readwrite' });
      if (perm !== 'granted') return ctx.toast('No permission to use that folder', 'error');
      await useHandle(h, false);
    } catch (e) {
      ctx.toast('Couldn’t open that folder: ' + e.message, 'error');
    }
  }

  async function scanLibrary() {
    if (!L.handle && !L.files) return;
    L.loading = true;
    L.error = '';
    render();
    const AM = Pixl.amiibo;
    const items = [];
    let skipped = 0;
    const add = async (rel, file) => {
      const name = rel.split('/').pop();
      const ext = (name.match(/\.[^.]+$/) || [''])[0].toLowerCase();
      if (file.size > 65536 || !(AM.AMIIBO_SIZES.indexOf(file.size) >= 0 || ['.bin', '.nfc', '.eml'].indexOf(ext) >= 0)) {
        skipped++;
        return;
      }
      const data = new Uint8Array(await file.arrayBuffer());
      const a = AM.analyze(name, data);
      if (a.kind !== 'amiibo') {
        skipped++;
        return;
      }
      items.push({ key: rel, rel, name: a.name, srcName: name, size: a.data.length, data: a.data, id: a.id, crc: Pixl.crc32(a.data), converted: a.converted });
    };
    try {
      if (L.handle) {
        const walk = async (dir, prefix) => {
          for await (const [name, h] of dir.entries()) {
            if (JUNK.test(name) || name.startsWith('.')) continue;
            const rel = prefix ? `${prefix}/${name}` : name;
            if (h.kind === 'directory') await walk(h, rel);
            else await add(rel, await h.getFile());
          }
        };
        await walk(L.handle, '');
      } else {
        for (const f of L.files) {
          const rel = (f.webkitRelativePath || f.name).split('/').slice(1).join('/') || f.name;
          if (!JUNK.test(f.name)) await add(rel, f);
        }
      }
      L.items = items;
      L.skipped = skipped;
      const keys = new Set(items.map((i) => i.key));
      L.sel.forEach((k) => !keys.has(k) && L.sel.delete(k));
      ctx.log('info', `Library “${L.name}”: ${items.length} amiibo${skipped ? `, ${skipped} other files ignored` : ''}`);
    } catch (e) {
      L.error = e.message;
      ctx.log('error', 'Library: ' + e.message);
    }
    L.loading = false;
    render();
  }

  /* -------------------------------------------------------- the device */

  function scanDevice() {
    if (L.dev.scanning || !ctx.connected) return;
    const S = ctx.S;
    const PP = ctx.PP;
    const AM = Pixl.amiibo;
    const drive = PP.drive(ctx.amiiboRoot());
    L.dev.scanning = true;
    L.dev.error = '';
    render();
    ctx.addJob({
      kind: 'scan',
      icon: 'logo',
      title: 'Read amiibo on the Pixl.js',
      detail: 'Scanning',
      doneText: 'Pixl.js contents read',
      logDone: false,
      run: async (job) => {
        try {
          const sig = { signal: job.ctrl.signal };
          const files = [];
          const paths = [];
          const walk = async (d) => {
            if (job.ctrl.signal.aborted) throw Pixl.abortError();
            ctx.setPhase(job, `Scanning ${d}`);
            const items = await ctx.withRetry(() => S.client.listDir(d), ctx.retryOpts('Open folder', sig));
            for (const it of items) {
              const p = PP.join(d, it.name);
              if (it.isDir) await walk(p);
              else {
                paths.push(p);
                if (AM.AMIIBO_SIZES.indexOf(it.size) >= 0) files.push({ path: p, name: it.name, size: it.size, meta: it.meta });
              }
            }
          };
          await walk(PP.root(drive));
          let n = 0;
          for (const f of files) {
            f.id = AM.idFromMeta(f.meta) || ctx.idCache.get(f.path, f.size);
            if (f.id === undefined) {
              if (job.ctrl.signal.aborted) throw Pixl.abortError();
              ctx.setPhase(job, `Identifying ${++n}: ${f.name}`);
              const data = await ctx.readVerified(f.path, f.size, null, ctx.retryOpts('Read', sig));
              f.id = AM.idFromDump(data);
              f.crc = Pixl.crc32(data);
              ctx.idCache.set(f.path, f.size, f.id);
            }
          }
          L.dev.items = files.filter((f) => f.id).map((f) => Object.assign(f, { key: f.path }));
          L.dev.others = files.length - L.dev.items.length;
          L.dev.paths = paths;
          L.dev.scanned = true;
          const keys = new Set(L.dev.items.map((i) => i.key));
          L.dsel.forEach((k) => !keys.has(k) && L.dsel.delete(k));
        } catch (e) {
          if (e.code !== 'ABORTED') L.dev.error = e.message;
          throw e;
        } finally {
          L.dev.scanning = false;
          render();
        }
      },
    });
  }

  /* -------------------------------------------------------------- send */

  function spaceLeft() {
    const PP = ctx.PP;
    const d = ctx.S.drives.find((x) => x.label === PP.drive(ctx.amiiboRoot()));
    return d && d.ok ? d.free : null;
  }

  async function send(list) {
    list = (list || selectedLib()).slice();
    if (!list.length) return;
    if (!L.dev.scanned) return ctx.toast('Still reading what’s on your Pixl.js. Try again in a moment.', 'info');
    const PP = ctx.PP;
    const onDev = devIds();
    const dupes = list.filter((it) => onDev.has(it.id));
    if (dupes.length) {
      const how = await ctx.modal({
        title: `${dupes.length === list.length ? (list.length === 1 ? 'It’s' : 'They’re') : ctx.plural(dupes.length, 'amiibo', 'amiibo')} already on your Pixl.js`,
        icon: 'dupe',
        tone: 'warn',
        body: `<p>${dupes
          .slice(0, 8)
          .map((it) => ctx.esc((info(it.id) || {}).name || it.name))
          .join(', ')}${dupes.length > 8 ? ` and ${dupes.length - 8} more` : ''} ${dupes.length === 1 ? 'is' : 'are'} already on the device.</p>`,
        actions: [
          { label: 'Cancel', value: null },
          { label: 'Send another copy', value: 'all' },
          { label: dupes.length === list.length ? 'Skip' : 'Skip those', kind: 'primary', submit: true, value: 'skip' },
        ],
      });
      if (!how) return;
      if (how === 'skip') list = list.filter((it) => !onDev.has(it.id));
      if (!list.length) return;
    }
    const root = ctx.amiiboRoot();
    const plan = Pixl.organize.place(
      list.map((it) => ({ name: it.name, id: it.id, info: info(it.id), src: it })),
      L.dev.paths,
      root,
      ctx.organizeOpts()
    );
    let moves = plan.moves;
    const free = spaceLeft();
    if (free != null) {
      const folders = new Set(moves.map((m) => PP.parent(m.to)).filter((d) => !L.dev.paths.some((p) => p.startsWith(d + '/'))));
      const need = (moves.length + folders.size) * BLOCK;
      if (need > free) {
        const fit = Math.max(0, Math.floor(free / BLOCK) - folders.size - 2);
        const ok = await ctx.modal({
          title: 'Not enough space on the Pixl.js',
          icon: 'alert',
          tone: 'warn',
          body: `<p>Each amiibo takes a 4 KB block of flash. There’s room for about <b>${fit}</b> more, and you picked ${moves.length}.</p>`,
          actions: [
            { label: 'Cancel', value: null },
            fit > 0 ? { label: `Send the first ${fit}`, kind: 'primary', submit: true, value: true } : { label: 'OK', value: null },
          ],
        });
        if (!ok) return;
        moves = moves.slice(0, fit);
      }
    }
    if (!moves.length) return;
    const total = moves.reduce((n, m) => n + m.item.src.size, 0);
    ctx.addJob({
      kind: 'upload',
      icon: 'send',
      title: `Send ${moves.length === 1 ? (info(moves[0].item.id) || {}).name || moves[0].item.name : ctx.plural(moves.length, 'amiibo', 'amiibo')} to the Pixl.js`,
      detail: 'into ' + root,
      doneText: `Sent to ${root}`,
      total,
      affects: root,
      run: async (job) => {
        const sig = { signal: job.ctrl.signal };
        const made = new Set();
        const ensureChain = async (d) => {
          const parts = [];
          for (let p = d; !PP.isRoot(p) && !made.has(p); p = PP.parent(p)) parts.unshift(p);
          for (const p of parts) {
            await ctx.withRetry(() => ctx.ensureDir(p), ctx.retryOpts('Create folder', sig));
            made.add(p);
          }
        };
        const span = total * (ctx.verify ? 2 : 1) || 1;
        let done = 0;
        for (const m of moves) {
          if (job.ctrl.signal.aborted) throw Pixl.abortError();
          const src = m.item.src;
          ctx.setPhase(job, `${(info(src.id) || {}).name || src.name} → ${m.to.slice(root.length + 1)}`);
          await ensureChain(PP.parent(m.to));
          await ctx.writeAndVerify(job, m.to, src.data, ctx.verify, (n) => ctx.setProgress(job, done + n, span));
          done += src.size * (ctx.verify ? 2 : 1);
          ctx.idCache.set(m.to, src.size, src.id);
          L.dev.paths.push(m.to);
          L.dev.items.push({ key: m.to, path: m.to, name: PP.basename(m.to), size: src.size, meta: Pixl.parseMeta(null), id: src.id, crc: src.crc });
          render();
        }
        ctx.loadDrives();
      },
    });
  }

  /* -------------------------------------------- save to library / remove */

  /** Reads device copies and compares with the library. */
  function checkDevice(list, then) {
    const libByCrc = new Set(L.items.map((i) => i.id + ':' + i.crc));
    ctx.addJob({
      kind: 'scan',
      icon: 'logo',
      title: `Check ${ctx.plural(list.length, 'amiibo', 'amiibo')} on the Pixl.js`,
      detail: 'Reading',
      doneText: 'Checked',
      logDone: false,
      run: async (job) => {
        const sig = { signal: job.ctrl.signal };
        const out = [];
        let i = 0;
        for (const d of list) {
          if (job.ctrl.signal.aborted) throw Pixl.abortError();
          ctx.setPhase(job, `Reading ${d.name}`);
          ctx.setProgress(job, ++i, list.length);
          const data = await ctx.readVerified(d.path, d.size, null, ctx.retryOpts('Read', sig));
          d.crc = Pixl.crc32(data);
          const inLib = libByCrc.has(d.id + ':' + d.crc);
          const sameId = L.items.some((x) => x.id === d.id);
          out.push({ d, data, inLib, changed: !inLib && sameId });
        }
        job.result = out;
      },
      after: async function () {
        await then(this.result);
      },
    });
  }

  async function writeToLibrary(entries) {
    // entries: [{ d, data }] → files in the library, filed like the device, never overwriting
    const taken = L.items.map((i) => 'L:/' + i.rel);
    const plan = Pixl.organize.place(
      entries.map((e) => ({ name: e.d.name, id: e.d.id, info: info(e.d.id), src: e })),
      taken,
      'L:/',
      Object.assign({}, ctx.organizeOpts(), { pc: true })
    );
    const moves = plan.moves;
    for (const m of moves) {
      const rel = m.to.slice(3);
      const parts = rel.split('/');
      const dir = await dirFor(L.handle, parts.slice(0, -1).join('/'), true);
      const fh = await dir.getFileHandle(parts[parts.length - 1], { create: true });
      const w = await fh.createWritable();
      await w.write(m.item.src.data);
      await w.close();
      const data = m.item.src.data;
      L.items.push({ key: rel, rel, name: parts[parts.length - 1], srcName: parts[parts.length - 1], size: data.length, data, id: m.item.id, crc: Pixl.crc32(data) });
    }
    return moves.length;
  }

  function canWriteLibrary() {
    return !!(L.handle && L.writable);
  }

  function saveToLibrary(list) {
    list = (list || selectedDev()).slice();
    if (!list.length) return;
    if (!canWriteLibrary()) {
      return ctx.toast(L.handle ? 'The library folder is read-only here' : 'Choose a library folder first (on a computer with Chrome or Edge)', 'error');
    }
    checkDevice(list, async (rows) => {
      const fresh = rows.filter((r) => !r.inLib);
      if (!fresh.length) return ctx.toast('Your library already has identical copies of these', 'ok');
      try {
        const n = await writeToLibrary(fresh);
        ctx.toast(`${ctx.plural(n, 'amiibo', 'amiibo')} saved to “${L.name}”`, 'ok');
        ctx.log('ok', `Saved ${n} amiibo from the Pixl.js to the library`);
      } catch (e) {
        ctx.toast('Couldn’t save to the library: ' + e.message, 'error');
      }
      render();
    });
  }

  function remove(list) {
    list = (list || selectedDev()).slice();
    if (!list.length) return;
    checkDevice(list, async (rows) => {
      const esc = ctx.esc;
      const unsafe = rows.filter((r) => !r.inLib);
      let saveFirst = false;
      if (unsafe.length) {
        const lines = unsafe
          .slice(0, 30)
          .map((r) => `<li>${esc((info(r.d.id) || {}).name || r.d.name)} <span class="muted">· ${r.changed ? 'differs from your library copy (new save data?)' : 'not in your library'}</span></li>`)
          .join('');
        const how = await ctx.modal({
          title: `${ctx.plural(unsafe.length, 'amiibo', 'amiibo')} would be lost`,
          icon: 'alert',
          tone: 'warn',
          wide: true,
          body: `<p>Your library doesn’t have an identical copy of:</p><ul class="item-list">${lines}</ul>
            ${canWriteLibrary() ? '<p>Save them to the library first, so nothing is lost. A changed copy is saved next to the old one, never over it.</p>' : '<p>Choose a writable library folder to save them first, or remove anyway.</p>'}`,
          actions: [
            { label: 'Cancel', value: null },
            { label: 'Remove anyway', kind: 'danger', value: 'anyway' },
            canWriteLibrary() ? { label: 'Save to library, then remove', kind: 'primary', submit: true, value: 'save' } : null,
          ].filter(Boolean),
        });
        if (!how) return;
        saveFirst = how === 'save';
      } else {
        const ok = await ctx.modal({
          title: `Remove ${ctx.plural(rows.length, 'amiibo', 'amiibo')} from the Pixl.js?`,
          icon: 'trash',
          body: '<p>Your library has an identical copy of each, so you can send them back any time.</p>',
          actions: [
            { label: 'Cancel', value: null },
            { label: 'Remove', kind: 'danger', submit: true, value: true },
          ],
        });
        if (!ok) return;
      }
      if (saveFirst) {
        try {
          await writeToLibrary(unsafe);
        } catch (e) {
          return ctx.toast('Couldn’t save to the library, so nothing was removed: ' + e.message, 'error');
        }
      }
      const PP = ctx.PP;
      const root = ctx.amiiboRoot();
      ctx.addJob({
        kind: 'delete',
        icon: 'trash',
        title: `Remove ${ctx.plural(rows.length, 'amiibo', 'amiibo')} from the Pixl.js`,
        doneText: 'Removed',
        affects: root,
        run: async (job) => {
          const sig = { signal: job.ctrl.signal };
          const parents = new Set();
          let i = 0;
          for (const r of rows) {
            if (job.ctrl.signal.aborted) throw Pixl.abortError();
            ctx.setPhase(job, `Removing ${r.d.name}`);
            await ctx.removeSafe(r.d.path, ctx.retryOpts('Delete', sig));
            parents.add(PP.parent(r.d.path));
            L.dev.items = L.dev.items.filter((x) => x.key !== r.d.key);
            L.dev.paths = L.dev.paths.filter((p) => p !== r.d.path);
            L.dsel.delete(r.d.key);
            ctx.setProgress(job, ++i, rows.length);
            render();
          }
          // tidy series folders that are now empty
          for (const p of parents) {
            if (p === root || PP.isRoot(p) || !p.startsWith(root + '/')) continue;
            const left = await ctx.client.listDir(p).catch(() => null);
            if (left && !left.length) await ctx.removeSafe(p, ctx.retryOpts('Delete', sig)).catch(() => {});
          }
          ctx.loadDrives();
        },
      });
    });
  }

  /* ------------------------------------------------------------ render */

  function build() {
    const icon = ctx.icon;
    ctx.el.library.innerHTML = `
      <div class="lib-cols">
        <section class="lib-pane" data-side="lib" aria-label="Your library">
          <div class="lib-head">
            <div class="lib-title">${icon('books')}<span>Your library</span><span class="lib-count" id="libCount"></span></div>
            <div class="lib-src" id="libSrc"></div>
          </div>
          <div class="lib-tools">
            <label class="search"><svg class="ic"><use href="#i-search"/></svg><input type="search" id="libQ" placeholder="Search name, series, game" autocomplete="off"></label>
            <select id="libSeries" aria-label="Series"></select>
            <label class="check"><input type="checkbox" id="libAll"> All</label>
          </div>
          <div class="lib-grid" id="libGrid"></div>
        </section>
        <div class="lib-mid">
          <button class="btn primary" id="libSend" title="Copy the selected library amiibo to the Pixl.js">${icon('send')}<span>Send</span></button>
          <button class="btn" id="libSave" title="Copy the selected Pixl.js amiibo into your library">${icon('save')}<span>Save</span></button>
          <button class="btn danger-ghost" id="libRemove" title="Delete the selected amiibo from the Pixl.js (checks your library first)">${icon('trash')}<span>Remove</span></button>
          <div class="lib-dest" id="libDest"></div>
        </div>
        <section class="lib-pane" data-side="dev" aria-label="On your Pixl.js">
          <div class="lib-head">
            <div class="lib-title">${icon('logo')}<span>On your Pixl.js</span><span class="lib-count" id="devCount"></span></div>
            <div class="lib-src" id="devSrc"></div>
          </div>
          <div class="lib-tools">
            <label class="search"><svg class="ic"><use href="#i-search"/></svg><input type="search" id="devQ" placeholder="Search name, series, game" autocomplete="off"></label>
            <select id="devSeries" aria-label="Series"></select>
            <label class="check"><input type="checkbox" id="devAll"> All</label>
          </div>
          <div class="lib-grid" id="devGrid"></div>
        </section>
      </div>
      <input type="file" id="libInput" webkitdirectory multiple hidden>`;

    $('#libQ').oninput = (e) => {
      L.q = e.target.value;
      renderGrid('lib');
    };
    $('#devQ').oninput = (e) => {
      L.dq = e.target.value;
      renderGrid('dev');
    };
    $('#libSeries').onchange = (e) => {
      L.series = e.target.value;
      renderGrid('lib');
    };
    $('#devSeries').onchange = (e) => {
      L.dseries = e.target.value;
      renderGrid('dev');
    };
    $('#libAll').onchange = (e) => {
      visibleLib().forEach((i) => (e.target.checked ? L.sel.add(i.key) : L.sel.delete(i.key)));
      paintSel('lib');
    };
    $('#devAll').onchange = (e) => {
      visibleDev().forEach((i) => (e.target.checked ? L.dsel.add(i.key) : L.dsel.delete(i.key)));
      paintSel('dev');
    };
    $('#libSend').onclick = () => send();
    $('#libSave').onclick = () => saveToLibrary();
    $('#libRemove').onclick = () => remove();
    $('#libInput').onchange = (e) => {
      const files = Array.from(e.target.files);
      e.target.value = '';
      if (!files.length) return;
      L.files = files;
      L.handle = null;
      L.writable = false;
      L.name = (files[0].webkitRelativePath || '').split('/')[0] || 'Folder';
      scanLibrary();
    };
    ctx.el.library.addEventListener('click', onClick);
    ctx.el.library.addEventListener('dblclick', (ev) => {
      const card = ev.target.closest('.lcard');
      if (card && card.closest('[data-side="lib"]')) {
        const it = L.items.find((i) => i.key === card.dataset.key);
        if (it) send([it]);
      }
    });
    L.built = true;
  }

  function onClick(ev) {
    const t = ev.target;
    const btn = t.closest('[data-lib-act]');
    if (btn) {
      const a = btn.dataset.libAct;
      if (a === 'choose') chooseFolder();
      else if (a === 'reconnect') reconnectFolder();
      else if (a === 'reload') scanLibrary();
      else if (a === 'rescan') scanDevice();
      return;
    }
    const card = t.closest('.lcard');
    if (!card) return;
    const side = card.closest('[data-side]').dataset.side;
    const key = card.dataset.key;
    const set = side === 'lib' ? L.sel : L.dsel;
    const list = side === 'lib' ? visibleLib() : visibleDev();
    const anchorKey = side === 'lib' ? 'anchor' : 'danchor';
    if (ev.shiftKey && L[anchorKey]) {
      const keys = list.map((i) => i.key);
      const a = keys.indexOf(L[anchorKey]);
      const b = keys.indexOf(key);
      if (a >= 0 && b >= 0) for (let i = Math.min(a, b); i <= Math.max(a, b); i++) set.add(keys[i]);
    } else if (set.has(key)) set.delete(key);
    else set.add(key);
    L[anchorKey] = key;
    L.focus = { side, key };
    paintSel(side);
    showInfo();
  }

  function cardHtml(it, side, ids) {
    const i = info(it.id) || {};
    const sel = (side === 'lib' ? L.sel : L.dsel).has(it.key);
    let chip = '';
    if (side === 'lib' && ids.has(it.id)) chip = '<span class="chip ok">On Pixl</span>';
    if (side === 'dev' && (L.handle || L.files)) chip = ids.has(it.id) ? '<span class="chip">In library</span>' : '<span class="chip warn">Not in library</span>';
    const sub = side === 'dev' ? it.path.split('/').slice(-2, -1)[0] || '' : it.converted ? `from ${it.srcName}` : it.srcName;
    return `<div class="lcard ${sel ? 'sel' : ''}" data-key="${ctx.esc(it.key)}" title="${ctx.esc([i.name || it.name, i.series, side === 'dev' ? it.path : it.rel].filter(Boolean).join('\n'))}">
      <input type="checkbox" tabindex="-1" ${sel ? 'checked' : ''} aria-label="Select">
      <div class="lcard-art">${ctx.AUI.art(i, { online: ctx.settings.online })}</div>
      <div class="lcard-name">${ctx.esc(i.name || it.name)}</div>
      <div class="lcard-sub">${ctx.esc(sub)}</div>
      ${chip ? `<div class="lcard-chip">${chip}</div>` : ''}
    </div>`;
  }

  function gridHtml(list, side) {
    const ids = side === 'lib' ? devIds() : libIds();
    let html = '';
    let cur = null;
    for (const it of list) {
      const s = seriesOf(it.id);
      if (s !== cur) {
        cur = s;
        const n = list.filter((x) => seriesOf(x.id) === s).length;
        html += `<div class="lib-group">${ctx.AUI.emblem(s, 'sm')}<span>${ctx.esc(s)}</span><span class="g-count">${n}</span></div>`;
      }
      html += cardHtml(it, side, ids);
    }
    return html;
  }

  function seriesOptions(items, current) {
    const counts = new Map();
    items.forEach((it) => counts.set(seriesOf(it.id), (counts.get(seriesOf(it.id)) || 0) + 1));
    const opts = Array.from(counts.entries()).sort((a, b) => a[0].localeCompare(b[0]));
    return `<option value="">All series (${items.length})</option>` + opts.map(([s, n]) => `<option value="${ctx.esc(s)}" ${s === current ? 'selected' : ''}>${ctx.esc(s)} (${n})</option>`).join('');
  }

  function renderGrid(side) {
    const icon = ctx.icon;
    const esc = ctx.esc;
    if (side === 'lib') {
      const grid = $('#libGrid');
      if (!L.handle && !L.files) {
        const pend = L.pendingHandle;
        grid.innerHTML = `<div class="lib-empty">${ctx.AUI.placeholder()}<h3>Your amiibo library</h3>
          <p>Pick the folder on this computer where you keep your amiibo files. The app reads it right here in the browser; nothing is uploaded anywhere.</p>
          ${
            pend
              ? `<button class="btn primary" data-lib-act="reconnect">${icon('folder')}<span>Open “${esc(pend.name)}” again</span></button><button class="btn sm ghost" data-lib-act="choose">Choose a different folder</button>`
              : `<button class="btn primary" data-lib-act="choose">${icon('folder')}<span>${fsaSupported() ? 'Choose folder…' : 'Load a folder…'}</span></button>`
          }
          ${fsaSupported() ? '' : '<p class="muted-line">This browser can only read the folder for this visit, so saving back to it isn’t available. Chrome or Edge on a computer can do both.</p>'}
        </div>`;
      } else if (L.loading) {
        grid.innerHTML = '<div class="lib-empty"><div class="spinner"></div><p>Reading your library…</p></div>';
      } else if (L.error) {
        grid.innerHTML = `<div class="lib-empty"><h3>Couldn’t read the folder</h3><p>${esc(L.error)}</p><button class="btn" data-lib-act="reload">Try again</button></div>`;
      } else if (!L.items.length) {
        grid.innerHTML = `<div class="lib-empty"><h3>No amiibo in “${esc(L.name)}”</h3><p>Put .bin (or Flipper .nfc) amiibo files in that folder, then reload.</p><button class="btn" data-lib-act="reload">Reload</button></div>`;
      } else {
        const vis = visibleLib();
        grid.innerHTML = vis.length ? gridHtml(vis, 'lib') : '<div class="lib-empty"><p>Nothing matches.</p></div>';
      }
      $('#libSeries').innerHTML = seriesOptions(L.items, L.series);
    } else {
      const grid = $('#devGrid');
      if (L.dev.scanning && !L.dev.items.length) {
        grid.innerHTML = '<div class="lib-empty"><div class="spinner"></div><p>Reading what’s on your Pixl.js…</p></div>';
      } else if (L.dev.error && !L.dev.items.length) {
        grid.innerHTML = `<div class="lib-empty"><h3>Couldn’t read the Pixl.js</h3><p>${esc(L.dev.error)}</p><button class="btn" data-lib-act="rescan">Try again</button></div>`;
      } else if (!L.dev.items.length) {
        grid.innerHTML = `<div class="lib-empty">${ctx.AUI.placeholder()}<h3>No amiibo on the Pixl.js yet</h3><p>Select some in your library and click <b>Send</b>.</p></div>`;
      } else {
        const vis = visibleDev();
        grid.innerHTML = vis.length ? gridHtml(vis, 'dev') : '<div class="lib-empty"><p>Nothing matches.</p></div>';
      }
      $('#devSeries').innerHTML = seriesOptions(L.dev.items, L.dseries);
    }
    paintSel(side, true);
  }

  function paintSel(side, skipCards) {
    const set = side === 'lib' ? L.sel : L.dsel;
    if (!skipCards) {
      $(side === 'lib' ? '#libGrid' : '#devGrid')
        .querySelectorAll('.lcard')
        .forEach((c) => {
          const on = set.has(c.dataset.key);
          c.classList.toggle('sel', on);
          c.querySelector('input').checked = on;
        });
    }
    const vis = side === 'lib' ? visibleLib() : visibleDev();
    const all = $(side === 'lib' ? '#libAll' : '#devAll');
    const n = vis.filter((i) => set.has(i.key)).length;
    all.checked = vis.length > 0 && n === vis.length;
    all.indeterminate = n > 0 && n < vis.length;
    renderChrome();
  }

  function renderChrome() {
    const esc = ctx.esc;
    const nl = L.sel.size;
    const nd = L.dsel.size;
    $('#libCount').textContent = L.items.length ? L.items.length : '';
    $('#devCount').textContent = L.dev.items.length ? L.dev.items.length : '';
    $('#libSrc').innerHTML =
      L.handle || L.files
        ? `<span class="pick-name" title="${esc(L.name)}">${ctx.icon('folder')}${esc(L.name)}${L.handle && !L.writable ? ' (read-only)' : ''}</span>
           <button class="btn sm ghost" data-lib-act="reload" title="Read the folder again">${ctx.icon('refresh')}</button>
           <button class="btn sm ghost" data-lib-act="choose">Change…</button>`
        : '';
    const free = spaceLeft();
    $('#devSrc').innerHTML = `<span class="muted">${free != null ? `${ctx.fmtSize(free)} free · room for about ${Math.max(0, Math.floor(free / BLOCK) - 2)} more` : ''}</span>
      <button class="btn sm ghost" data-lib-act="rescan" title="Read the Pixl.js again" ${L.dev.scanning ? 'disabled' : ''}>${ctx.icon('refresh')}</button>`;
    const send = $('#libSend');
    send.disabled = !nl || !ctx.connected || !L.dev.scanned;
    send.querySelector('span').textContent = nl ? `Send ${nl}` : 'Send';
    const save = $('#libSave');
    save.disabled = !nd || !canWriteLibrary();
    save.querySelector('span').textContent = nd ? `Save ${nd}` : 'Save';
    const rem = $('#libRemove');
    rem.disabled = !nd || !ctx.connected;
    rem.querySelector('span').textContent = nd ? `Remove ${nd}` : 'Remove';
    const o = ctx.organizeOpts();
    $('#libDest').innerHTML = `Sends to<br><b>${esc(ctx.amiiboRoot())}/</b>${o.group === 'none' ? '' : `<br><b>${o.group === 'game' ? '&lt;Game&gt;' : '&lt;Series&gt;'}/</b>`}${
      o.naming === 'keep' ? '' : '<br>named after the amiibo'
    }`;
  }

  function render() {
    if (!L.built || ctx.el.library.hidden) return;
    renderGrid('lib');
    renderGrid('dev');
    showInfo();
  }

  function showInfo() {
    const f = L.focus;
    if (!f) return ctx.setInfo(null);
    if (f.side === 'lib') {
      const it = L.items.find((i) => i.key === f.key);
      if (!it) return ctx.setInfo(null);
      const onPixl = devIds().has(it.id);
      ctx.setInfo({
        kind: 'amiibo',
        id: it.id,
        info: info(it.id),
        source: 'library',
        file: { name: it.srcName, path: `${L.name}/${it.rel.split('/').slice(0, -1).join('/')}`.replace(/\/$/, ''), size: it.size, status: onPixl ? 'Already on your Pixl.js' : 'Not on your Pixl.js' },
        actions: [{ act: 'send', icon: 'send', label: onPixl ? 'Send another copy' : 'Send to Pixl.js', kind: 'primary', disabled: !L.dev.scanned }],
      });
    } else {
      const d = L.dev.items.find((i) => i.key === f.key);
      if (!d) return ctx.setInfo(null);
      const inLib = libIds().has(d.id);
      ctx.setInfo({
        kind: 'amiibo',
        id: d.id,
        info: info(d.id),
        source: 'device',
        file: {
          name: d.name,
          path: ctx.PP.parent(d.path),
          size: d.size,
          notes: d.meta && d.meta.notes,
          status: L.handle || L.files ? (inLib ? 'In your library' : 'Not in your library') : '',
        },
        actions: [
          { act: 'save', icon: 'save', label: 'Save to library', disabled: !canWriteLibrary() },
          { act: 'remove', icon: 'trash', label: 'Remove from Pixl.js', kind: 'danger-ghost' },
        ],
      });
    }
  }

  function panelAction(act) {
    const f = L.focus;
    if (!f) return;
    if (f.side === 'lib') {
      const it = L.items.find((i) => i.key === f.key);
      if (it && act === 'send') send([it]);
    } else {
      const d = L.dev.items.find((i) => i.key === f.key);
      if (!d) return;
      if (act === 'save') saveToLibrary([d]);
      if (act === 'remove') remove([d]);
    }
  }

  /* --------------------------------------------------------------- api */

  async function show(c) {
    ctx = c;
    if (!L.built) build();
    if (!L.handle && !L.files && !L.pendingHandle && fsaSupported()) {
      const h = await loadHandle();
      if (h) {
        let perm = 'prompt';
        try {
          perm = await h.queryPermission({ mode: 'readwrite' });
        } catch (e) {
          /* ignore */
        }
        if (perm === 'granted') await useHandle(h, false);
        else L.pendingHandle = h;
      }
    }
    // re-read every time: files may have changed in the Files view (IDs are cached, so it's quick)
    if (!L.dev.scanning) scanDevice();
    render();
  }

  function hide() {
    L.focus = null;
  }

  function refreshView() {
    if (ctx && L.built && !ctx.el.library.hidden) render();
  }

  /** Forget device contents (e.g. after reconnecting to another device). */
  function resetDevice() {
    L.dev = { items: [], paths: [], scanned: false, scanning: false, error: '', others: 0 };
    L.dsel.clear();
  }

  Pixl.libraryUI = { show, hide, refreshView, panelAction, resetDevice, _state: L, _send: send, _remove: remove, _save: saveToLibrary, _useHandle: useHandle };
})(typeof window !== 'undefined' ? window : globalThis);
