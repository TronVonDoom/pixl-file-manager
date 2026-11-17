/*
 * Sync a device folder with a folder on this computer (File System Access API,
 * Chrome/Edge desktop). Compares both sides, shows what differs, then copies
 * only the changes in the chosen direction.
 */
(function (global) {
  'use strict';

  const Pixl = (global.Pixl = global.Pixl || {});
  const JUNK = /^(desktop\.ini|thumbs\.db|\.ds_store)$/i;

  /* ------------------------------------------------------------ pure logic */

  /**
   * @param local  Map rel -> { isDir, size }
   * @param device Map rel -> { isDir, size }
   * @param same   optional Map rel -> boolean (content comparison result for equal-size files)
   * @returns [{ rel, isDir, status, local, device }]
   *   status: 'local-only' | 'device-only' | 'differs' | 'same' | 'conflict' (file vs folder)
   */
  function diffTrees(local, device, same) {
    const out = [];
    const keys = new Set([...local.keys(), ...device.keys()]);
    keys.forEach((rel) => {
      const l = local.get(rel);
      const d = device.get(rel);
      let status;
      if (l && !d) status = 'local-only';
      else if (d && !l) status = 'device-only';
      else if (l.isDir !== d.isDir) status = 'conflict';
      else if (l.isDir) status = 'same';
      else if (l.size !== d.size) status = 'differs';
      else if (same && same.has(rel)) status = same.get(rel) ? 'same' : 'differs';
      else status = 'same';
      out.push({ rel, isDir: !!(l || d).isDir, status, local: l || null, device: d || null });
    });
    out.sort((a, b) => a.rel.localeCompare(b.rel, undefined, { numeric: true }));
    return out;
  }

  /**
   * Default action per entry for a mode.
   * mode: 'two-way' | 'to-device' | 'to-pc'
   * @returns action: 'upload' | 'download' | 'delete-device' | 'delete-pc' | 'skip'
   */
  function defaultAction(entry, mode, deleteExtras) {
    const s = entry.status;
    if (s === 'same' || s === 'conflict') return 'skip';
    if (mode === 'two-way') {
      if (s === 'local-only') return 'upload';
      if (s === 'device-only') return 'download';
      return 'skip'; // differs: no reliable timestamps on the device, let the user choose
    }
    if (mode === 'to-device') {
      if (s === 'local-only' || s === 'differs') return 'upload';
      if (s === 'device-only') return deleteExtras ? 'delete-device' : 'skip';
    }
    if (mode === 'to-pc') {
      if (s === 'device-only' || s === 'differs') return 'download';
      if (s === 'local-only') return deleteExtras ? 'delete-pc' : 'skip';
    }
    return 'skip';
  }

  /** Children of a folder that will be deleted don't need their own action. */
  function collapse(actions) {
    const delDirs = actions.filter((a) => a.isDir && (a.action === 'delete-device' || a.action === 'delete-pc')).map((a) => a.rel + '/');
    const copiedDirs = new Set(actions.filter((a) => a.isDir && (a.action === 'upload' || a.action === 'download')).map((a) => a.rel));
    return actions.filter((a) => {
      if (delDirs.some((d) => a.rel.startsWith(d))) return false;
      // folders being created don't need a row of their own when a file inside is copied
      if (a.isDir && copiedDirs.has(a.rel) && actions.some((b) => !b.isDir && b.rel.startsWith(a.rel + '/') && b.action === a.action)) return false;
      return true;
    });
  }

  /* --------------------------------------------------------------- storage */

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
      d.transaction('handles', 'readwrite').objectStore('handles').put(h, 'sync');
    } catch (e) {
      /* ignore */
    }
  }
  async function loadHandle() {
    try {
      const d = await idb();
      return await new Promise((resolve) => {
        const r = d.transaction('handles').objectStore('handles').get('sync');
        r.onsuccess = () => resolve(r.result || null);
        r.onerror = () => resolve(null);
      });
    } catch (e) {
      return null;
    }
  }

  /* --------------------------------------------------------------- scanning */

  async function scanLocal(root, signal) {
    const out = new Map();
    async function walk(dir, prefix) {
      for await (const [name, h] of dir.entries()) {
        if (signal && signal.aborted) throw Pixl.abortError();
        if (JUNK.test(name)) continue;
        const rel = prefix ? `${prefix}/${name}` : name;
        if (h.kind === 'directory') {
          out.set(rel, { isDir: true, handle: h });
          await walk(h, rel);
        } else {
          const f = await h.getFile();
          out.set(rel, { isDir: false, size: f.size, handle: h });
        }
      }
    }
    await walk(root, '');
    return out;
  }

  async function scanDevice(ctx, rootDir, job) {
    const out = new Map();
    const PP = ctx.PP;
    async function walk(dir, prefix) {
      if (job.ctrl.signal.aborted) throw Pixl.abortError();
      ctx.setPhase(job, `Scanning ${dir}`);
      const items = await ctx.withRetry(() => ctx.client.listDir(dir), ctx.retryOpts('Open folder', { signal: job.ctrl.signal }));
      for (const it of items) {
        const rel = prefix ? `${prefix}/${it.name}` : it.name;
        out.set(rel, { isDir: it.isDir, size: it.size, meta: it.meta });
        if (it.isDir) await walk(PP.join(dir, it.name), rel);
      }
    }
    await walk(rootDir, '');
    return out;
  }

  async function localDir(root, relDir, create) {
    let h = root;
    for (const seg of relDir.split('/').filter(Boolean)) h = await h.getDirectoryHandle(seg, { create });
    return h;
  }

  /* --------------------------------------------------------------------- UI */

  const STATUS_LABEL = {
    'local-only': 'Only on PC',
    'device-only': 'Only on Pixl',
    differs: 'Different',
    conflict: 'File vs folder',
  };
  const ACTION_LABEL = {
    upload: 'Copy to Pixl',
    download: 'Copy to PC',
    'delete-device': 'Delete from Pixl',
    'delete-pc': 'Delete from PC',
    skip: 'Skip',
  };

  function supported() {
    return typeof global.showDirectoryPicker === 'function';
  }

  async function open(ctx) {
    if (!supported()) return ctx.toast('Folder sync needs Chrome or Edge on a computer', 'error');
    if (!ctx.connected || !ctx.S.cwd) return;
    const deviceDir = ctx.S.cwd;
    const esc = ctx.esc;
    let handle = await loadHandle();
    const saved = JSON.parse(localStorage.getItem('pixlfm.syncopts') || '{}');
    let modeEl, delEl, cmpEl, folderLabel, errEl;

    const setup = await ctx.modal({
      title: 'Sync with a PC folder',
      icon: 'sync',
      wide: true,
      body: `<p>Compare <b>${esc(deviceDir)}</b> on the Pixl.js with a folder on this computer, then copy only what changed.</p>
        <div class="field"><span>Folder on this computer</span>
          <div class="pick-row"><span class="pick-name" id="syPick">${handle ? esc(handle.name) : 'None chosen'}</span>
          <button type="button" class="btn sm" id="syChoose">${ctx.icon('folder')}<span>${handle ? 'Change…' : 'Choose…'}</span></button></div></div>
        <div class="field"><span>Direction</span>
          <div class="radio-col" id="syMode">
            <label class="check-row"><input type="radio" name="sym" value="two-way" ${saved.mode !== 'to-device' && saved.mode !== 'to-pc' ? 'checked' : ''}><span>Both ways<small>Copy what’s missing on each side. Files that differ are left for you to decide.</small></span></label>
            <label class="check-row"><input type="radio" name="sym" value="to-device" ${saved.mode === 'to-device' ? 'checked' : ''}><span>PC → Pixl.js<small>Make the Pixl.js folder match the PC folder.</small></span></label>
            <label class="check-row"><input type="radio" name="sym" value="to-pc" ${saved.mode === 'to-pc' ? 'checked' : ''}><span>Pixl.js → PC<small>Make the PC folder match the Pixl.js folder (a backup).</small></span></label>
          </div></div>
        <label class="check-row"><input type="checkbox" id="syDel" ${saved.del ? 'checked' : ''}><span>Also delete files that aren’t on the source side<small>Only for the one-way directions. You’ll see the list before anything is deleted.</small></span></label>
        <label class="check-row"><input type="checkbox" id="syCmp" ${saved.cmp !== false ? 'checked' : ''}><span>Compare file contents<small>Recommended: amiibo files are all 540 bytes, so sizes alone can’t tell them apart. Slower, since each file is read from the Pixl.js.</small></span></label>
        <div class="field-err" id="syErr"></div>`,
      actions: [
        { label: 'Cancel', value: null },
        {
          label: 'Compare',
          kind: 'primary',
          submit: true,
          value: () => ({
            mode: modeEl.querySelector('input:checked').value,
            del: delEl.checked,
            cmp: cmpEl.checked,
          }),
        },
      ],
      init(d) {
        modeEl = d.querySelector('#syMode');
        delEl = d.querySelector('#syDel');
        cmpEl = d.querySelector('#syCmp');
        folderLabel = d.querySelector('#syPick');
        errEl = d.querySelector('#syErr');
        d.querySelector('#syChoose').onclick = async () => {
          try {
            const h = await global.showDirectoryPicker({ id: 'pixl-sync', mode: 'readwrite' });
            handle = h;
            saveHandle(h);
            folderLabel.textContent = h.name;
            errEl.textContent = '';
          } catch (e) {
            if (e.name !== 'AbortError') errEl.textContent = e.message;
          }
        };
        d.querySelector('.dlg-foot .btn.primary').focus();
      },
      validate() {
        if (!handle) {
          errEl.textContent = 'Choose a folder on this computer first';
          return false;
        }
        return true;
      },
    });
    if (!setup || !handle) return;
    localStorage.setItem('pixlfm.syncopts', JSON.stringify(setup));

    // Re-confirm access (needed when the folder was remembered from an earlier visit)
    try {
      let perm = await handle.queryPermission({ mode: 'readwrite' });
      if (perm !== 'granted') perm = await handle.requestPermission({ mode: 'readwrite' });
      if (perm !== 'granted') return ctx.toast('No permission to use that folder', 'error');
    } catch (e) {
      return ctx.toast('Couldn’t access that folder: ' + e.message, 'error');
    }

    ctx.addJob({
      kind: 'scan',
      icon: 'sync',
      title: `Compare ${deviceDir} with ${handle.name}`,
      detail: 'Scanning',
      doneText: 'Comparison finished',
      run: async (job) => {
        ctx.setPhase(job, `Scanning ${handle.name} on this computer`);
        const local = await scanLocal(handle, job.ctrl.signal);
        const device = await scanDevice(ctx, deviceDir, job);
        const same = new Map();
        if (setup.cmp) {
          const both = [...local.keys()].filter((k) => device.has(k) && !local.get(k).isDir && !device.get(k).isDir && local.get(k).size === device.get(k).size);
          let i = 0;
          for (const rel of both) {
            if (job.ctrl.signal.aborted) throw Pixl.abortError();
            ctx.setPhase(job, `Comparing ${++i} of ${both.length}: ${rel}`);
            ctx.setProgress(job, i, both.length);
            const devPath = ctx.PP.join(deviceDir, rel);
            const [a, b] = await Promise.all([
              ctx.readVerified(devPath, device.get(rel).size, null, ctx.retryOpts('Read', { signal: job.ctrl.signal })),
              local
                .get(rel)
                .handle.getFile()
                .then((f) => f.arrayBuffer())
                .then((x) => new Uint8Array(x)),
            ]);
            same.set(rel, Pixl.bytesEqual(a, b));
            if (Pixl.amiibo && Pixl.amiibo.AMIIBO_SIZES.indexOf(a.length) >= 0) ctx.idCache.set(devPath, a.length, Pixl.amiibo.idFromDump(a));
          }
        }
        job.result = { local, device, entries: diffTrees(local, device, same) };
      },
      after: async function () {
        await review(ctx, this.result, setup, handle, deviceDir);
      },
    });
  }

  async function review(ctx, result, setup, handle, deviceDir) {
    const esc = ctx.esc;
    const PP = ctx.PP;
    const entries = result.entries;
    const counts = { same: 0, 'local-only': 0, 'device-only': 0, differs: 0, conflict: 0 };
    entries.forEach((e) => counts[e.status]++);
    let rows = entries
      .filter((e) => e.status !== 'same')
      .map((e) => Object.assign({}, e, { action: defaultAction(e, setup.mode, setup.del) }));
    // names the device can't store
    rows.forEach((r) => {
      if (r.action === 'upload') {
        const parent = PP.parent(PP.join(deviceDir, r.rel));
        const err = PP.validateName(PP.basename(r.rel), parent);
        if (err) {
          r.action = 'skip';
          r.note = err;
        }
      }
    });
    rows = collapse(rows);
    const summary = [
      counts.same ? `${counts.same} identical` : '',
      counts['local-only'] ? `${counts['local-only']} only on PC` : '',
      counts['device-only'] ? `${counts['device-only']} only on Pixl` : '',
      counts.differs ? `${counts.differs} different` : '',
      counts.conflict ? `${counts.conflict} file/folder clashes` : '',
    ]
      .filter(Boolean)
      .join(' · ');
    if (!rows.length) {
      ctx.toast(`Everything matches (${summary || 'both folders are empty'})`, 'ok');
      return;
    }
    const opts = (r) => {
      if (r.status === 'conflict') return ['skip'];
      const choices = [];
      if (r.local) choices.push('upload');
      if (r.device) choices.push('download');
      if (r.status === 'device-only') choices.push('delete-device');
      if (r.status === 'local-only') choices.push('delete-pc');
      choices.push('skip');
      return choices;
    };
    const list = rows
      .slice(0, 500)
      .map(
        (r, i) => `<li class="sy-row"><span class="fi fi-${r.isDir ? 'folder' : 'file'}">${ctx.icon(r.isDir ? 'folder' : 'file')}</span>
        <div class="rv-main"><div class="rv-title" title="${esc(r.rel)}">${esc(r.rel)}</div>
        <div class="rv-file">${esc(STATUS_LABEL[r.status] || r.status)}${r.local && r.device && !r.isDir ? ` · PC ${ctx.fmtSize(r.local.size)}, Pixl ${ctx.fmtSize(r.device.size)}` : ''}${
          r.note ? ` · ${esc(r.note)}` : ''
        }</div></div>
        <select data-i="${i}" ${r.note ? 'disabled' : ''}>${opts(r)
          .map((a) => `<option value="${a}" ${a === r.action ? 'selected' : ''}>${ACTION_LABEL[a]}</option>`)
          .join('')}</select></li>`
      )
      .join('');
    let picked = null;
    const go = await ctx.modal({
      title: 'Review changes',
      icon: 'sync',
      wide: true,
      body: `<p class="muted-line">${esc(summary)}. Pixl folder <b>${esc(deviceDir)}</b> ↔ PC folder <b>${esc(handle.name)}</b></p>
        <ul class="review-list sync-list">${list}</ul>${rows.length > 500 ? `<p class="muted-line">Showing the first 500 of ${rows.length}.</p>` : ''}`,
      actions: [
        { label: 'Cancel', value: null },
        { label: 'Sync', kind: 'primary', submit: true, value: () => picked },
      ],
      init(d) {
        const btn = d.querySelector('.dlg-foot .btn.primary');
        const upd = () => {
          d.querySelectorAll('select[data-i]').forEach((s) => (rows[+s.dataset.i].action = s.value));
          picked = rows.filter((r) => r.action !== 'skip');
          const dels = picked.filter((r) => r.action.startsWith('delete')).length;
          btn.textContent = picked.length ? `Sync ${picked.length} change${picked.length === 1 ? '' : 's'}${dels ? ` (${dels} deletion${dels === 1 ? '' : 's'})` : ''}` : 'Nothing selected';
          btn.disabled = !picked.length;
        };
        d.addEventListener('change', upd);
        upd();
      },
    });
    if (!go || !go.length) return;
    const dels = go.filter((r) => r.action.startsWith('delete'));
    if (dels.length) {
      const ok = await ctx.modal({
        title: `Delete ${ctx.plural(dels.length, 'item')}?`,
        icon: 'trash',
        tone: 'danger',
        body: `<ul class="item-list">${dels
          .slice(0, 40)
          .map((r) => `<li>${esc(r.action === 'delete-pc' ? 'PC: ' : 'Pixl: ')}${esc(r.rel)}${r.isDir ? '/' : ''}</li>`)
          .join('')}</ul><p>Folders are deleted with everything in them. This can’t be undone.</p>`,
        actions: [
          { label: 'Cancel', value: null },
          { label: 'Delete and sync', kind: 'danger', submit: true, value: true },
        ],
      });
      if (!ok) return;
    }
    run(ctx, go, result, handle, deviceDir);
  }

  function run(ctx, actions, result, handle, deviceDir) {
    const PP = ctx.PP;
    const order = { upload: 1, download: 2, 'delete-device': 3, 'delete-pc': 4 };
    actions = actions.slice().sort((a, b) => order[a.action] - order[b.action] || a.rel.localeCompare(b.rel));
    const bytes = actions.reduce((n, a) => n + (!a.isDir && (a.action === 'upload' || a.action === 'download') ? (a.local || a.device).size : 0), 0);
    ctx.addJob({
      kind: 'sync',
      icon: 'sync',
      title: `Sync ${deviceDir} ↔ ${handle.name}`,
      detail: ctx.plural(actions.length, 'change'),
      doneText: `${ctx.plural(actions.length, 'change')} synced`,
      total: bytes,
      affects: deviceDir,
      run: async (job) => {
        const sig = { signal: job.ctrl.signal };
        const W = 200;
        const span = bytes * (ctx.verify ? 2 : 1) + actions.length * W || 1;
        let done = 0;
        let ops = 0;
        const failures = [];
        const prog = (extra) => ctx.setProgress(job, done + ops * W + (extra || 0), span);
        const deviceFolders = async (rel) => {
          const segs = rel.split('/');
          for (let i = 1; i < segs.length; i++) {
            const d = PP.join(deviceDir, segs.slice(0, i).join('/'));
            await ctx.withRetry(() => ctx.ensureDir(d), ctx.retryOpts('Create folder', sig));
          }
        };
        // deepest first for deletions
        const delDevice = async (rel, isDir) => {
          const p = PP.join(deviceDir, rel);
          if (isDir) {
            const kids = await ctx.withRetry(() => ctx.client.listDir(p), ctx.retryOpts('Open folder', sig));
            for (const k of kids) await delDevice(`${rel}/${k.name}`, k.isDir);
          }
          await ctx.removeSafe(p, ctx.retryOpts('Delete', sig));
        };
        for (const a of actions) {
          if (job.ctrl.signal.aborted) throw Pixl.abortError();
          try {
            if (a.action === 'upload') {
              ctx.setPhase(job, `Copying ${a.rel} to Pixl`);
              await deviceFolders(a.rel);
              if (a.isDir) await ctx.withRetry(() => ctx.ensureDir(PP.join(deviceDir, a.rel)), ctx.retryOpts('Create folder', sig));
              else {
                const f = await a.local.handle.getFile();
                const data = new Uint8Array(await f.arrayBuffer());
                await ctx.writeAndVerify(job, PP.join(deviceDir, a.rel), data, ctx.verify, (n) => prog(n));
                done += data.length * (ctx.verify ? 2 : 1);
              }
            } else if (a.action === 'download') {
              ctx.setPhase(job, `Copying ${a.rel} to PC`);
              const relDir = a.rel.split('/').slice(0, -1).join('/');
              if (a.isDir) await localDir(handle, a.rel, true);
              else {
                const data = await ctx.readVerified(PP.join(deviceDir, a.rel), a.device.size, (n) => prog(n), ctx.retryOpts('Read', sig));
                const dir = await localDir(handle, relDir, true);
                const fh = await dir.getFileHandle(a.rel.split('/').pop(), { create: true });
                const w = await fh.createWritable();
                await w.write(data);
                await w.close();
                done += data.length * (ctx.verify ? 2 : 1);
              }
            } else if (a.action === 'delete-device') {
              ctx.setPhase(job, `Deleting ${a.rel} from Pixl`);
              await delDevice(a.rel, a.isDir);
            } else if (a.action === 'delete-pc') {
              ctx.setPhase(job, `Deleting ${a.rel} from PC`);
              const segs = a.rel.split('/');
              const dir = await localDir(handle, segs.slice(0, -1).join('/'), false);
              await dir.removeEntry(segs[segs.length - 1], { recursive: true });
            }
          } catch (e) {
            if (job.ctrl.signal.aborted || e.code === 'ABORTED' || e.code === 'DISCONNECTED') throw e;
            failures.push(`${a.rel}: ${e.message}`);
            ctx.log('error', `Sync ${a.rel}: ${e.message}`);
          }
          ops++;
          prog();
        }
        if (failures.length) {
          throw new Pixl.PixlError(`${failures.length} of ${actions.length} changes failed (see Activity log). First: ${failures[0]}`);
        }
      },
    });
  }

  Pixl.sync = { diffTrees, defaultAction, collapse };
  Pixl.syncUI = { supported, open };
})(typeof window !== 'undefined' ? window : globalThis);
