/* Pixl File Manager — UI */
(function () {
  'use strict';

  const P = window.Pixl;
  const PP = P.path;
  const withRetry = P.withRetry;
  const PixlError = P.PixlError;

  /* ---------------------------------------------------------------- helpers */

  const $ = (sel, root) => (root || document).querySelector(sel);
  const ESC = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
  const esc = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ESC[c]);
  const icon = (name, cls) => `<svg class="ic ${cls || ''}" aria-hidden="true"><use href="#i-${name}"/></svg>`;
  const params = new URLSearchParams(location.search);
  const collator = new Intl.Collator(undefined, { numeric: true, sensitivity: 'base' });
  const plural = (n, word, many) => `${n} ${n === 1 ? word : many || word + 's'}`;
  const JUNK = /^(desktop\.ini|thumbs\.db|\.ds_store)$/i;

  const store = {
    get(k, d) {
      try {
        const v = localStorage.getItem('pixlfm.' + k);
        return v === null ? d : JSON.parse(v);
      } catch (e) {
        return d;
      }
    },
    set(k, v) {
      try {
        localStorage.setItem('pixlfm.' + k, JSON.stringify(v));
      } catch (e) {
        /* storage unavailable */
      }
    },
  };

  function fmtSize(n) {
    if (n == null) return '';
    if (n < 1024) return `${n} B`;
    if (n < 1024 * 1024) return `${(n / 1024).toFixed(n < 10240 ? 1 : 0)} KB`;
    return `${(n / 1048576).toFixed(n < 10485760 ? 2 : 1)} MB`;
  }
  function fmtTime(d) {
    return d.toLocaleTimeString([], { hour12: false });
  }
  function isAmiibo(it) {
    return !it.isDir && (!!it.meta.amiibo || (/\.bin$/i.test(it.name) && (it.size === 540 || it.size === 532 || it.size === 572)));
  }
  function kindOf(it) {
    return it.isDir ? 'folder' : isAmiibo(it) ? 'tag' : 'file';
  }

  const el = {};
  [
    'app', 'connPill', 'connText', 'themeBtn', 'connectBtn', 'banner', 'bannerText', 'bannerReconnect', 'bannerDisconnect',
    'welcome', 'welcomeConnect', 'demoBtn', 'supportWarn', 'workspace', 'driveList', 'deviceInfo', 'sideDisconnect',
    'backBtn', 'fwdBtn', 'upBtn', 'refreshBtn', 'crumbs', 'filter', 'mobileDrives', 'actions', 'uploadMenuBtn', 'listWrap',
    'listHead', 'checkAll', 'list', 'listState', 'statusLeft', 'clipChip', 'statusRight', 'panel', 'xferBadge', 'logBadge',
    'xferSummary', 'verifyChk', 'clearDone', 'verboseChk', 'copyLog', 'clearLog', 'panelToggle', 'xferList', 'logList',
    'menu', 'dropOverlay', 'dropTarget', 'toasts', 'dlg', 'fileInput', 'folderInput',
  ].forEach((id) => (el[id] = document.getElementById(id)));

  /* ------------------------------------------------------------------ state */

  const S = {
    transport: null,
    client: null,
    demo: false,
    conn: 'off', // off | connecting | on | lost
    reconnecting: false,
    device: {},
    drives: [],
    cwd: null,
    items: [],
    view: [],
    loading: false,
    listError: '',
    listToken: 0,
    sel: new Set(),
    anchor: null,
    focus: null,
    sort: store.get('sort', { key: 'name', dir: 1 }),
    filter: '',
    clipboard: null,
    back: [],
    fwd: [],
    dragging: null,
  };

  /* -------------------------------------------------------------------- log */

  const logs = [];
  let logErrors = 0;
  let activeTab = 'transfers';

  function log(level, msg) {
    const entry = { t: new Date(), level, msg: String(msg) };
    logs.push(entry);
    if (logs.length > 2000) logs.shift();
    if (level === 'error') console.error('[pixl]', entry.msg);
    else if (level === 'warn') console.warn('[pixl]', entry.msg);
    else if (level !== 'debug') console.log('[pixl]', entry.msg);
    if (level === 'debug' && !el.verboseChk.checked) return;
    appendLogLine(entry);
    if (level === 'error' && (activeTab !== 'log' || el.panel.dataset.open !== 'true')) {
      logErrors++;
      el.logBadge.textContent = logErrors;
      el.logBadge.hidden = false;
    }
  }

  function appendLogLine(e) {
    const d = document.createElement('div');
    d.className = 'log-line ' + e.level;
    d.innerHTML = `<span class="lt">${fmtTime(e.t)}</span><span class="ll">${e.level}</span><span class="lm">${esc(e.msg)}</span>`;
    const ll = el.logList;
    const atBottom = ll.scrollTop + ll.clientHeight >= ll.scrollHeight - 24;
    ll.appendChild(d);
    while (ll.childElementCount > 1000) ll.firstChild.remove();
    if (atBottom) ll.scrollTop = ll.scrollHeight;
  }

  function rebuildLog() {
    el.logList.innerHTML = '';
    logs.forEach((e) => {
      if (e.level !== 'debug' || el.verboseChk.checked) appendLogLine(e);
    });
  }

  /* ----------------------------------------------------------------- toasts */

  function toast(msg, kind, ms) {
    kind = kind || 'info';
    const t = document.createElement('div');
    t.className = 'toast ' + kind;
    t.innerHTML = icon(kind === 'ok' ? 'check' : kind === 'error' ? 'alert' : 'info') + `<div>${esc(msg)}</div>`;
    el.toasts.appendChild(t);
    while (el.toasts.childElementCount > 4) el.toasts.firstChild.remove();
    setTimeout(
      () => {
        t.classList.add('leaving');
        setTimeout(() => t.remove(), 220);
      },
      kind === 'error' ? Math.max(ms || 0, 7000) : ms || 3500
    );
  }

  /* ---------------------------------------------------------------- dialogs */

  function modal(opts) {
    return new Promise((resolve) => {
      const d = el.dlg;
      d.innerHTML = `<form method="dialog" novalidate>
        <div class="dlg-head">${opts.icon ? `<div class="dlg-ic ${opts.tone || ''}">${icon(opts.icon)}</div>` : ''}<h2>${esc(opts.title)}</h2></div>
        <div class="dlg-body">${opts.body || ''}</div>
        <div class="dlg-foot">${opts.actions
          .map((a, i) => `<button type="${a.submit ? 'submit' : 'button'}" class="btn ${a.kind || ''}" data-i="${i}">${esc(a.label)}</button>`)
          .join('')}</div>
      </form>`;
      let done = false;
      const finish = (v) => {
        if (done) return;
        done = true;
        if (d.open) d.close();
        resolve(v);
      };
      const choose = (a) => {
        if (a.value === null || a.value === undefined) return finish(null);
        if (a.submit && opts.validate && !opts.validate()) return;
        finish(typeof a.value === 'function' ? a.value() : a.value);
      };
      d.querySelectorAll('.dlg-foot button').forEach((b) =>
        b.addEventListener('click', (ev) => {
          ev.preventDefault();
          choose(opts.actions[+b.dataset.i]);
        })
      );
      d.querySelector('form').addEventListener('submit', (ev) => {
        ev.preventDefault();
        const a = opts.actions.find((x) => x.submit);
        if (a) choose(a);
      });
      d.oncancel = (ev) => {
        ev.preventDefault();
        finish(null);
      };
      d.showModal();
      if (opts.init) opts.init(d);
      else {
        const f = d.querySelector('.dlg-foot .btn.primary, .dlg-foot .btn.danger');
        if (f) f.focus();
      }
    });
  }

  function promptName(o) {
    let input, err;
    return modal({
      title: o.title,
      icon: o.icon || 'rename',
      body: `<label class="field"><span>${esc(o.label)} <em id="dlgCount"></em></span>
        <input type="text" id="dlgInput" value="${esc(o.value || '')}" spellcheck="false" autocomplete="off"></label>
        <div class="field-err" id="dlgErr"></div>`,
      actions: [
        { label: 'Cancel', value: null },
        { label: o.okLabel || 'OK', kind: 'primary', submit: true, value: () => input.value.trim() },
      ],
      init(d) {
        input = d.querySelector('#dlgInput');
        err = d.querySelector('#dlgErr');
        const count = d.querySelector('#dlgCount');
        const budget = o.dir ? PP.nameBudget(o.dir) : P.LIMITS.nameBytes;
        const upd = () => {
          const n = PP.byteLen(input.value.trim());
          count.textContent = `${n} / ${budget} bytes`;
          count.classList.toggle('over', n > budget);
          err.textContent = '';
        };
        input.addEventListener('input', upd);
        upd();
        input.focus();
        const v = input.value;
        const dot = v.lastIndexOf('.');
        if (o.selectBase && dot > 0) input.setSelectionRange(0, dot);
        else input.select();
      },
      validate() {
        const v = input.value.trim();
        const msg = PP.validateName(v, o.dir) || (o.extraValidate && o.extraValidate(v));
        if (msg) {
          err.textContent = msg;
          input.focus();
          return false;
        }
        return true;
      },
    });
  }

  function itemListHtml(names, max) {
    max = max || 40;
    const shown = names.slice(0, max).map((n) => `<li>${esc(n)}</li>`).join('');
    const more = names.length > max ? `<li>…and ${names.length - max} more</li>` : '';
    return `<ul class="item-list">${shown}${more}</ul>`;
  }

  function askConflict(names, destDir) {
    return modal({
      title: names.length === 1 ? `“${names[0]}” already exists` : `${names.length} items already exist`,
      icon: 'alert',
      tone: 'warn',
      body: `<p>${names.length === 1 ? 'An item with this name is' : 'These names are'} already in <b>${esc(destDir)}</b>.</p>
        ${names.length > 1 ? itemListHtml(names) : ''}
        <p>Replacing a folder merges the contents into it.</p>`,
      actions: [
        { label: 'Cancel', value: null },
        { label: 'Skip', value: 'skip' },
        { label: 'Keep both', value: 'rename' },
        { label: 'Replace', kind: 'primary', value: 'replace', submit: true },
      ],
    });
  }

  function askLongNames(names) {
    return modal({
      title: `${plural(names.length, 'name')} too long for the device`,
      icon: 'alert',
      tone: 'warn',
      body: `<p>The Pixl.js allows names up to ${P.LIMITS.nameBytes} bytes and full paths up to ${P.LIMITS.pathBytes} bytes. These don't fit:</p>
        ${itemListHtml(names)}`,
      actions: [
        { label: 'Cancel', value: null },
        { label: 'Skip these', value: 'skip' },
        { label: 'Shorten names', kind: 'primary', value: 'shorten', submit: true },
      ],
    });
  }

  /* ------------------------------------------------------------------- menu */

  function showMenu(x, y, items) {
    const m = el.menu;
    m.innerHTML = items
      .map((it, i) =>
        it === '-'
          ? '<hr>'
          : `<button role="menuitem" data-i="${i}" ${it.disabled ? 'disabled' : ''} class="${it.danger ? 'danger' : ''}">${icon(it.icon)}<span>${esc(it.label)}</span>${
              it.kbd ? `<kbd>${it.kbd}</kbd>` : ''
            }</button>`
      )
      .join('');
    m.hidden = false;
    const r = m.getBoundingClientRect();
    m.style.left = Math.max(8, Math.min(x, innerWidth - r.width - 8)) + 'px';
    m.style.top = Math.max(8, Math.min(y, innerHeight - r.height - 8)) + 'px';
    m.onclick = (ev) => {
      const b = ev.target.closest('button[data-i]');
      if (!b || b.disabled) return;
      hideMenu();
      items[+b.dataset.i].act();
    };
    m.onkeydown = (ev) => {
      const btns = Array.from(m.querySelectorAll('button:not(:disabled)'));
      const i = btns.indexOf(document.activeElement);
      if (ev.key === 'ArrowDown') {
        ev.preventDefault();
        btns[(i + 1) % btns.length].focus();
      } else if (ev.key === 'ArrowUp') {
        ev.preventDefault();
        btns[(i - 1 + btns.length) % btns.length].focus();
      } else if (ev.key === 'Escape') {
        hideMenu();
      }
    };
    const first = m.querySelector('button:not(:disabled)');
    if (first) first.focus({ preventScroll: true });
  }
  function hideMenu() {
    if (el.menu.hidden) return;
    el.menu.hidden = true;
    el.menu.innerHTML = '';
  }

  /* ------------------------------------------------------------- connection */

  const waiters = [];
  function waitConnected(ms) {
    if (S.conn === 'on') return Promise.resolve();
    if (S.conn === 'off') return Promise.reject(new PixlError('Disconnected', { code: 'DISCONNECTED' }));
    return new Promise((res, rej) => {
      const w = { res, rej };
      w.timer = setTimeout(() => {
        const i = waiters.indexOf(w);
        if (i >= 0) waiters.splice(i, 1);
        rej(new PixlError('The device did not reconnect', { code: 'DISCONNECTED' }));
      }, ms || 45000);
      waiters.push(w);
    });
  }
  function settleWaiters(err) {
    while (waiters.length) {
      const w = waiters.shift();
      clearTimeout(w.timer);
      if (err) w.rej(err);
      else w.res();
    }
  }

  const ATTEMPTS = 4;
  function retryOpts(what, extra) {
    return Object.assign(
      {
        attempts: ATTEMPTS,
        waitReady: () => waitConnected(),
        onRetry: (e, i) => log('warn', `${what}: ${e.message} — retrying (${i}/${ATTEMPTS - 1})`),
      },
      extra || {}
    );
  }

  function friendlyBleError(e) {
    const msg = String((e && e.message) || e);
    if (/adapter not available|bluetooth adapter/i.test(msg)) return 'Bluetooth is off or not available on this computer.';
    if (/globally disabled|permission|not allowed/i.test(msg)) return 'Bluetooth access is blocked in this browser. Check the site permissions.';
    if (/GATT|NetworkError|connection|timed out|disconnected/i.test(msg))
      return "The Pixl.js didn't respond. Make sure BLE File Transfer is open on the device, then try again.";
    return msg;
  }

  function setConn(state) {
    S.conn = state;
    el.app.dataset.conn = state;
    const inSession = state === 'on' || state === 'lost';
    el.welcome.hidden = inSession;
    el.workspace.hidden = !inSession;
    const v = S.device.version ? ` · v${S.device.version}` : '';
    el.connText.textContent =
      state === 'on' ? `${S.device.name || 'Pixl.js'}${v}` : state === 'connecting' ? 'Connecting…' : state === 'lost' ? 'Reconnecting…' : 'Not connected';
    el.connectBtn.innerHTML = inSession ? `${icon('power')}<span>Disconnect</span>` : `${icon('bluetooth')}<span>Connect</span>`;
    el.connectBtn.classList.toggle('primary', !inSession);
    el.connectBtn.disabled = state === 'connecting';
    el.welcomeConnect.disabled = state === 'connecting' || !P.BleTransport.supported();
    el.demoBtn.disabled = state === 'connecting';
    el.welcomeConnect.querySelector('span').textContent = state === 'connecting' ? 'Connecting…' : 'Connect device';
    el.banner.hidden = state !== 'lost';
    if (state === 'on') settleWaiters();
    updateActions();
    renderJobsSummary();
  }

  function attach(transport, demo) {
    S.transport = transport;
    S.demo = demo;
    S.client = new P.PixlClient(transport, { log });
    S.client.verbose = el.verboseChk.checked;
    const inner = transport.onDisconnect;
    transport.onDisconnect = () => {
      if (inner) inner();
      onLinkLost(transport);
    };
  }

  async function connect(demo) {
    if (S.conn === 'connecting' || S.conn === 'on' || S.conn === 'lost') return;
    let transport;
    if (demo) {
      transport = new P.MockTransport({
        faults: parseFloat(params.get('faults')) || 0,
        latency: params.has('latency') ? +params.get('latency') : 12,
      });
    } else {
      if (!P.BleTransport.supported()) {
        showSupportWarning();
        return;
      }
      transport = new P.BleTransport({ log });
      try {
        await transport.pick();
      } catch (e) {
        if (!(e && e.name === 'NotFoundError' && /cancel/i.test(e.message))) {
          toast(friendlyBleError(e), 'error');
          log('error', 'Device picker: ' + (e.message || e));
        }
        return;
      }
    }
    setConn('connecting');
    log('info', `Connecting to ${transport.name}…`);
    try {
      await transport.connect();
      attach(transport, demo);
      await onConnected(true);
    } catch (e) {
      log('error', 'Could not connect: ' + (e.message || e));
      toast('Could not connect. ' + friendlyBleError(e), 'error');
      try {
        transport.disconnect();
      } catch (_) {
        /* ignore */
      }
      S.transport = null;
      S.client = null;
      setConn('off');
    }
  }

  async function onConnected(first) {
    const ver = await withRetry(() => S.client.getVersion(), { attempts: 3, onRetry: (e) => log('warn', 'Reading version: ' + e.message) });
    S.device = { name: S.transport.name, version: ver.version, address: ver.address };
    log('ok', `Connected to ${S.device.name} — firmware ${ver.version}${S.demo ? ' (demo device)' : ''}`);
    setConn('on');
    renderDevice();
    await loadDrives();
    const cwdOk = S.cwd && S.drives.some((d) => d.ok && d.label === PP.drive(S.cwd));
    if (first || !cwdOk) {
      const d = S.drives.find((x) => x.ok);
      S.back = [];
      S.fwd = [];
      if (d) await navigate(PP.root(d.label), { push: false });
      else {
        S.cwd = null;
        S.items = [];
        S.listError = 'The device did not report any usable drive.';
        renderAll();
      }
    } else {
      await refresh();
    }
    pump();
  }

  function onLinkLost(transport) {
    if (transport !== S.transport) return;
    if (transport.userClosed || S.conn === 'off') return finishDisconnect();
    if (S.conn === 'connecting' || S.reconnecting) return;
    log('warn', 'Connection to the device was lost');
    reconnect(4);
  }

  async function reconnect(attempts) {
    const t = S.transport;
    if (!t || S.reconnecting) return;
    S.reconnecting = true;
    setConn('lost');
    el.bannerReconnect.hidden = true;
    for (let i = 1; i <= attempts; i++) {
      el.bannerText.textContent = `Connection lost — reconnecting${attempts > 1 ? ` (attempt ${i} of ${attempts})` : ''}…`;
      await P.sleep(i === 1 ? 500 : 1200 * i);
      if (S.transport !== t || t.userClosed) break;
      try {
        await t.connect();
        S.reconnecting = false;
        log('ok', 'Reconnected');
        await onConnected(false);
        return;
      } catch (e) {
        log('warn', `Reconnect attempt ${i} failed: ${e.message || e}`);
      }
    }
    S.reconnecting = false;
    if (S.transport !== t) return;
    if (t.userClosed) return finishDisconnect();
    if (t.connected && S.conn !== 'on') {
      // link is up but the device isn't answering
      try {
        t.disconnect();
        t.userClosed = false;
      } catch (_) {
        /* ignore */
      }
    }
    setConn('lost');
    el.bannerText.textContent = 'Lost the connection. Check that BLE File Transfer is still open on the Pixl.js.';
    el.bannerReconnect.hidden = false;
    renderJobsSummary();
  }

  function finishDisconnect() {
    const wasConnected = S.conn !== 'off';
    S.reconnecting = false;
    cancelAllJobs();
    settleWaiters(new PixlError('Disconnected', { code: 'DISCONNECTED' }));
    S.transport = null;
    S.client = null;
    S.items = [];
    S.view = [];
    S.drives = [];
    S.cwd = null;
    S.sel.clear();
    S.clipboard = null;
    S.back = [];
    S.fwd = [];
    S.listError = '';
    setConn('off');
    renderAll();
    if (wasConnected) log('info', 'Disconnected');
  }

  async function userDisconnect() {
    const active = J.list.filter((j) => j.status === 'queued' || j.status === 'running').length;
    if (active) {
      const ok = await modal({
        title: 'Disconnect now?',
        icon: 'power',
        tone: 'warn',
        body: `<p>${plural(active, 'transfer')} still in progress will be stopped.</p>`,
        actions: [
          { label: 'Keep connected', value: null },
          { label: 'Disconnect', kind: 'danger', submit: true, value: true },
        ],
      });
      if (!ok) return;
    }
    const t = S.transport;
    if (!t) return finishDisconnect();
    t.userClosed = true;
    try {
      t.disconnect();
    } catch (_) {
      /* ignore */
    }
    setTimeout(() => {
      if (S.transport === t) finishDisconnect();
    }, 400);
  }

  function showSupportWarning() {
    const msgs = [];
    if (!window.isSecureContext)
      msgs.push('Bluetooth only works when this page is opened from <b>http://localhost</b> or <b>https</b>. Start it with <b>Start Pixl File Manager.bat</b>.');
    else if (!P.BleTransport.supported())
      msgs.push('This browser can’t use Bluetooth. Open this page in <b>Google Chrome</b> or <b>Microsoft Edge</b>. You can still try the demo.');
    el.supportWarn.innerHTML = msgs.join('<br>');
    el.supportWarn.hidden = !msgs.length;
    el.welcomeConnect.disabled = !P.BleTransport.supported();
  }

  /* ----------------------------------------------------------------- drives */

  async function loadDrives() {
    if (!S.client) return;
    try {
      S.drives = await withRetry(() => S.client.getDrives(), retryOpts('Read drives'));
    } catch (e) {
      log('error', 'Could not read drives: ' + e.message);
    }
    renderDrives();
    renderStatus();
  }

  function renderDrives() {
    const cur = S.cwd && PP.drive(S.cwd);
    el.driveList.innerHTML =
      S.drives
        .map((d) => {
          const pct = d.total ? d.used / d.total : 0;
          return `<div class="drive ${cur === d.label ? 'active' : ''} ${d.ok ? '' : 'unavailable'}" data-drive="${esc(d.label)}" role="button" tabindex="0" title="${esc(d.name)} (${esc(d.label)}:)">
            <span class="drive-ic">${icon('drive')}</span>
            <span class="drive-name">${esc(d.name)}</span>
            <button class="btn ghost icon sm drive-more" data-drive-menu="${esc(d.label)}" aria-label="Drive options">${icon('more')}</button>
            <span class="drive-meta">${d.ok ? `${esc(d.label)}: · ${fmtSize(d.free)} free of ${fmtSize(d.total)}` : `${esc(d.label)}: · not available`}</span>
            ${d.ok ? `<span class="meter ${pct > 0.95 ? 'full' : pct > 0.8 ? 'high' : ''}"><i style="width:${(pct * 100).toFixed(1)}%"></i></span>` : ''}
          </div>`;
        })
        .join('') || '<div class="drive-meta" style="padding:0 8px">No drives reported</div>';
    el.mobileDrives.innerHTML =
      S.drives.length > 1
        ? S.drives
            .filter((d) => d.ok)
            .map((d) => `<button class="btn sm ${cur === d.label ? 'active' : ''}" data-drive="${esc(d.label)}">${icon('drive')}<span>${esc(d.label)}: ${esc(d.name)}</span></button>`)
            .join('')
        : '';
  }

  function renderDevice() {
    const d = S.device;
    el.deviceInfo.innerHTML = `<dt>Name</dt><dd title="${esc(d.name)}">${esc(d.name || '—')}</dd>
      <dt>Firmware</dt><dd title="${esc(d.version)}">${esc(d.version || '—')}</dd>
      ${d.address ? `<dt>Address</dt><dd title="${esc(d.address)}">${esc(d.address)}</dd>` : ''}
      ${S.demo ? '<dt>Mode</dt><dd>Demo</dd>' : ''}`;
  }

  function driveMenu(label, x, y) {
    const d = S.drives.find((v) => v.label === label);
    if (!d) return;
    showMenu(x, y, [
      { label: 'Open', icon: 'folder', act: () => navigate(PP.root(label)), disabled: !d.ok },
      { label: 'Back up whole drive (ZIP)', icon: 'zip', act: () => backupDrive(label), disabled: !d.ok },
      { label: 'Refresh', icon: 'refresh', act: () => loadDrives() },
      '-',
      { label: 'Format drive…', icon: 'erase', danger: true, act: () => formatDrive(label) },
    ]);
  }

  /* ------------------------------------------------------------- navigation */

  async function navigate(dir, opts) {
    opts = opts || {};
    if (opts.push !== false && S.cwd && S.cwd !== dir) {
      S.back.push(S.cwd);
      if (S.back.length > 100) S.back.shift();
      S.fwd = [];
    }
    S.cwd = dir;
    S.sel.clear();
    S.anchor = null;
    S.focus = null;
    S.items = [];
    S.filter = '';
    el.filter.value = '';
    renderCrumbs();
    renderDrives();
    await refresh();
    if (opts.select) {
      S.sel = new Set([opts.select]);
      S.focus = S.anchor = opts.select;
      renderSelection();
      scrollRowIntoView(opts.select);
    }
  }

  async function refresh() {
    if (!S.client || !S.cwd) return;
    const token = ++S.listToken;
    const dir = S.cwd;
    S.loading = true;
    S.listError = '';
    el.refreshBtn.classList.add('spinning');
    renderList();
    try {
      const items = await withRetry(() => S.client.listDir(dir), retryOpts('Open folder'));
      if (token !== S.listToken) return;
      S.items = items;
      const names = new Set(items.map((i) => i.name));
      S.sel.forEach((n) => {
        if (!names.has(n)) S.sel.delete(n);
      });
      if (S.focus && !names.has(S.focus)) S.focus = null;
    } catch (e) {
      if (token !== S.listToken) return;
      if (e.code === 'STATUS' && !PP.isRoot(dir)) {
        log('warn', `Folder ${dir} is gone; going up`);
        S.loading = false;
        el.refreshBtn.classList.remove('spinning');
        return navigate(PP.parent(dir), { push: false });
      }
      S.items = [];
      S.listError = e.message;
      log('error', `Could not open ${dir}: ${e.message}`);
    } finally {
      if (token === S.listToken) {
        S.loading = false;
        el.refreshBtn.classList.remove('spinning');
        renderList();
      }
    }
  }

  function goUp() {
    if (S.cwd && !PP.isRoot(S.cwd)) {
      const from = PP.basename(S.cwd);
      navigate(PP.parent(S.cwd), { select: from });
    }
  }
  function goBack() {
    if (!S.back.length) return;
    S.fwd.push(S.cwd);
    navigate(S.back.pop(), { push: false });
  }
  function goFwd() {
    if (!S.fwd.length) return;
    S.back.push(S.cwd);
    navigate(S.fwd.pop(), { push: false });
  }

  function openItem(it) {
    if (!it) return;
    if (it.isDir) navigate(PP.join(S.cwd, it.name));
    else download([it]);
  }

  function renderCrumbs() {
    if (!S.cwd) {
      el.crumbs.innerHTML = '';
      return;
    }
    const drive = PP.drive(S.cwd);
    const parts = S.cwd.slice(3).split('/').filter(Boolean);
    let acc = PP.root(drive);
    let html = `<button class="crumb ${parts.length ? '' : 'current'}" data-path="${esc(acc)}" title="${esc(acc)}">${esc(drive)}:</button>`;
    parts.forEach((p, i) => {
      acc = PP.join(acc, p);
      html += icon('chev-right', 'crumb-sep') + `<button class="crumb ${i === parts.length - 1 ? 'current' : ''}" data-path="${esc(acc)}" title="${esc(acc)}">${esc(p)}</button>`;
    });
    el.crumbs.innerHTML = html;
    el.crumbs.scrollLeft = el.crumbs.scrollWidth;
  }

  /* ------------------------------------------------------------------- list */

  function visibleItems() {
    const f = S.filter.trim().toLowerCase();
    const items = S.items.filter((it) => !f || it.name.toLowerCase().includes(f) || (it.meta.notes || '').toLowerCase().includes(f));
    const key = S.sort.key;
    const dir = S.sort.dir;
    items.sort((a, b) => {
      if (a.isDir !== b.isDir) return a.isDir ? -1 : 1;
      let r = 0;
      if (key === 'size') r = a.size - b.size;
      else if (key === 'notes') r = collator.compare(a.meta.notes || '', b.meta.notes || '');
      if (r === 0) r = collator.compare(a.name, b.name);
      return r * dir;
    });
    return items;
  }

  function rowHtml(it, cutSet) {
    const sel = S.sel.has(it.name);
    const kind = kindOf(it);
    const full = PP.join(S.cwd, it.name);
    const id = P.amiiboId(it.meta);
    const tip = [it.name, it.isDir ? 'Folder' : fmtSize(it.size), id ? 'Amiibo ID ' + id : '', it.meta.notes].filter(Boolean).join('\n');
    const badges =
      (it.meta.hidden ? `<span class="badge-ic" title="Hidden on the device">${icon('eye-off')}</span>` : '') +
      (it.meta.readonly ? `<span class="badge-ic" title="Read-only">${icon('lock')}</span>` : '');
    return `<div class="row ${sel ? 'sel' : ''} ${it.isDir ? 'is-dir' : ''} ${it.meta.hidden ? 'hidden-file' : ''} ${S.focus === it.name ? 'focus' : ''} ${
      cutSet && cutSet.has(full) ? 'cut-pending' : ''
    }" data-name="${esc(it.name)}" draggable="true" role="row" aria-selected="${sel}" title="${esc(tip)}">
      <span class="c-check"><input type="checkbox" tabindex="-1" ${sel ? 'checked' : ''} aria-label="Select ${esc(it.name)}"></span>
      <span class="c-name"><span class="fi fi-${kind}">${icon(kind)}</span><span class="nm">${esc(it.name)}</span>${badges}</span>
      <span class="c-size">${it.isDir ? '' : fmtSize(it.size)}</span>
      <span class="c-notes">${esc(it.meta.notes || '')}</span>
    </div>`;
  }

  function renderList() {
    const items = (S.view = visibleItems());
    const cutSet = S.clipboard && S.clipboard.mode === 'cut' ? new Set(S.clipboard.items.map((i) => i.path)) : null;
    el.list.innerHTML = items.map((it) => rowHtml(it, cutSet)).join('');

    let state = '';
    if (!S.cwd && S.listError) {
      state = `<div class="state-inner"><div class="big-ic">${icon('alert')}</div><h3>No drive available</h3><p>${esc(S.listError)}</p></div>`;
    } else if (S.loading && !items.length) {
      state = `<div class="state-inner"><div class="spinner"></div><p>Loading folder…</p></div>`;
    } else if (S.listError) {
      state = `<div class="state-inner"><div class="big-ic">${icon('alert')}</div><h3>Couldn’t open this folder</h3><p>${esc(S.listError)}</p>
        <button class="btn sm" data-state-act="retry">${icon('refresh')}<span>Try again</span></button></div>`;
    } else if (!items.length && S.filter) {
      state = `<div class="state-inner"><div class="big-ic">${icon('search')}</div><h3>No matches</h3><p>Nothing here matches “${esc(S.filter)}”.</p></div>`;
    } else if (!items.length && S.cwd) {
      state = `<div class="state-inner"><div class="big-ic">${icon('folder')}</div><h3>This folder is empty</h3><p>Drag files or folders here, or use Upload.</p></div>`;
    }
    el.listState.innerHTML = state;
    el.listState.hidden = !state;
    el.listState.classList.toggle('error', !!S.listError);

    el.listHead.querySelectorAll('.sort').forEach((b) => {
      const active = b.dataset.sort === S.sort.key;
      b.classList.toggle('active', active);
      b.classList.toggle('desc', active && S.sort.dir < 0);
    });
    renderSelectionChrome();
  }

  let listRenderQueued = false;
  function scheduleListRender() {
    if (listRenderQueued) return;
    listRenderQueued = true;
    requestAnimationFrame(() => {
      listRenderQueued = false;
      renderList();
    });
  }

  function renderSelection() {
    el.list.querySelectorAll('.row').forEach((row) => {
      const name = row.dataset.name;
      const sel = S.sel.has(name);
      row.classList.toggle('sel', sel);
      row.classList.toggle('focus', S.focus === name);
      row.setAttribute('aria-selected', sel);
      const cb = row.querySelector('input');
      if (cb) cb.checked = sel;
    });
    renderSelectionChrome();
  }

  function renderSelectionChrome() {
    const total = S.view.length;
    const n = S.view.filter((i) => S.sel.has(i.name)).length;
    el.checkAll.checked = total > 0 && n === total;
    el.checkAll.indeterminate = n > 0 && n < total;
    el.checkAll.disabled = !total;
    updateActions();
    renderStatus();
  }

  function selectedItems() {
    return S.view.filter((it) => S.sel.has(it.name));
  }

  function selectRange(fromName, toName, additive) {
    const names = S.view.map((i) => i.name);
    let a = names.indexOf(fromName);
    const b = names.indexOf(toName);
    if (a < 0) a = b;
    if (!additive) S.sel.clear();
    for (let i = Math.min(a, b); i <= Math.max(a, b); i++) S.sel.add(names[i]);
  }

  function scrollRowIntoView(name) {
    const row = Array.from(el.list.children).find((r) => r.dataset.name === name);
    if (row) row.scrollIntoView({ block: 'nearest' });
  }

  function updateActions() {
    const on = S.conn === 'on' && !!S.cwd;
    const n = S.view.filter((i) => S.sel.has(i.name)).length;
    const dis = {
      'upload-files': !on,
      'new-folder': !on,
      download: !on || !n,
      copy: !on || !n,
      cut: !on || !n,
      paste: !on || !S.clipboard,
      rename: !on || n !== 1,
      props: !on || n !== 1,
      delete: !on || !n,
    };
    el.actions.querySelectorAll('[data-act]').forEach((b) => (b.disabled = !!dis[b.dataset.act]));
    el.uploadMenuBtn.disabled = !on;
    el.backBtn.disabled = !on || !S.back.length;
    el.fwdBtn.disabled = !on || !S.fwd.length;
    el.upBtn.disabled = !on || PP.isRoot(S.cwd || 'E:/');
    el.refreshBtn.disabled = !on;
  }

  function renderStatus() {
    if (!S.cwd) {
      el.statusLeft.textContent = '';
      el.statusRight.textContent = '';
    } else {
      const sel = selectedItems();
      const selSize = sel.reduce((a, i) => a + (i.isDir ? 0 : i.size), 0);
      let left = plural(S.items.length, 'item');
      if (S.filter) left += ` (${S.view.length} shown)`;
      if (sel.length) left += ` · ${sel.length} selected${selSize ? ` (${fmtSize(selSize)})` : ''}`;
      el.statusLeft.textContent = left;
      const d = S.drives.find((v) => v.label === PP.drive(S.cwd));
      el.statusRight.textContent = d && d.ok ? `${d.label}: ${fmtSize(d.free)} free of ${fmtSize(d.total)}` : '';
    }
    if (S.clipboard) {
      const c = S.clipboard;
      el.clipChip.innerHTML = `${icon(c.mode === 'cut' ? 'cut' : 'copy')}<span>${plural(c.items.length, 'item')} ${
        c.mode === 'cut' ? 'ready to move' : 'copied'
      }</span><button title="Clear clipboard" aria-label="Clear clipboard">${icon('x')}</button>`;
      el.clipChip.hidden = false;
    } else {
      el.clipChip.hidden = true;
    }
  }

  function renderAll() {
    renderDrives();
    renderDevice();
    renderCrumbs();
    renderList();
    renderJobs();
  }

  /* --------------------------------------------------------- device helpers */

  async function listingFor(dir) {
    if (dir === S.cwd && !S.loading && !S.listError) return S.items;
    try {
      return await withRetry(() => S.client.listDir(dir), retryOpts('Open folder'));
    } catch (e) {
      toast(`Couldn’t open ${dir}: ${e.message}`, 'error');
      log('error', `Could not open ${dir}: ${e.message}`);
      return null;
    }
  }

  async function ensureDir(p) {
    try {
      await S.client.mkdir(p);
    } catch (e) {
      if (e.code !== 'STATUS') throw e;
      const items = await S.client.listDir(PP.parent(p));
      const it = items.find((i) => i.name === PP.basename(p));
      if (!it || !it.isDir) throw e;
    }
  }

  async function existsIn(dir, name) {
    const items = await S.client.listDir(dir);
    return items.find((i) => i.name === name) || null;
  }

  /** remove that tolerates a lost reply (item already gone counts as success) */
  async function removeSafe(p, opts) {
    try {
      await withRetry(() => S.client.remove(p), opts);
    } catch (e) {
      if (e.code !== 'STATUS') throw e;
      if (await existsIn(PP.parent(p), PP.basename(p))) throw e;
    }
  }

  /** file rename that tolerates a lost reply */
  async function renameSafe(src, dest, opts) {
    try {
      await withRetry(() => S.client.rename(src, dest), opts);
    } catch (e) {
      if (e.code !== 'STATUS') throw e;
      const there = await existsIn(PP.parent(dest), PP.basename(dest));
      const stillHere = await existsIn(PP.parent(src), PP.basename(src));
      if (!there || stillHere) throw e;
    }
  }

  /** Reads a whole file, retrying until it arrives complete (expectedSize, if known). */
  async function readVerified(p, expectedSize, onProgress, opts) {
    return withRetry(async () => {
      const data = await S.client.readFile(p, { onProgress });
      if (expectedSize != null && data.length !== expectedSize) {
        throw new PixlError(`Got ${data.length} of ${expectedSize} bytes for ${PP.basename(p)}`, { code: 'LOST', retryable: true });
      }
      return data;
    }, opts || retryOpts(`Read ${PP.basename(p)}`));
  }

  /**
   * Writes a file and (optionally) reads it back to compare. Write and read-back have
   * their own retries, so a hiccup during verification doesn't force a full re-upload;
   * only a real mismatch does.
   */
  async function writeAndVerify(job, dest, data, verify, onProgress) {
    const name = PP.basename(dest);
    const ro = retryOpts(`Write ${name}`, { signal: job.ctrl.signal });
    for (let round = 1; ; round++) {
      await withRetry(async (attempt) => {
        job.note = attempt > 1 || round > 1 ? 'retrying' : '';
        setPhase(job, `Writing ${name}`);
        onProgress(0);
        await S.client.writeFile(dest, data, { signal: job.ctrl.signal, onProgress });
      }, ro);
      if (!verify) return;
      setPhase(job, `Verifying ${name}`);
      const back = await readVerified(dest, null, (n) => onProgress(data.length + n), retryOpts(`Verify ${name}`, { signal: job.ctrl.signal }));
      if (P.bytesEqual(back, data)) {
        job.note = '';
        return;
      }
      if (round >= 3) throw new PixlError('Verification failed: the copy on the device doesn’t match', { code: 'VERIFY' });
      log('warn', `Verification of ${name} failed — writing it again`);
    }
  }

  function saveBlob(blob, name) {
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = name;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 60000);
  }

  function optimisticAdd(devPath, info) {
    if (PP.parent(devPath) !== S.cwd) return;
    const name = PP.basename(devPath);
    const ex = S.items.find((i) => i.name === name);
    if (ex) {
      if (!info.isDir) ex.size = info.size;
    } else {
      S.items.push({ name, size: info.size || 0, isDir: !!info.isDir, meta: P.parseMeta(null) });
    }
    scheduleListRender();
  }
  function optimisticRemove(devPath) {
    if (PP.parent(devPath) !== S.cwd) return;
    const name = PP.basename(devPath);
    S.items = S.items.filter((i) => i.name !== name);
    S.sel.delete(name);
    scheduleListRender();
  }

  /* ------------------------------------------------------------------- jobs */

  const J = { list: [], running: null, seq: 0, dirty: false, finished: 0, failed: 0 };

  function addJob(spec) {
    const job = Object.assign(
      { id: ++J.seq, status: 'queued', done: 0, span: 0, total: 0, phase: '', note: '', error: '', requeues: 0, ctrl: new AbortController() },
      spec
    );
    J.list.push(job);
    renderJobs();
    openPanel('transfers');
    pump();
    return job;
  }

  async function pump() {
    if (J.running) return;
    if (S.conn !== 'on') {
      renderJobsSummary();
      return;
    }
    const job = J.list.find((j) => j.status === 'queued');
    if (!job) {
      onQueueIdle();
      return;
    }
    J.running = job;
    job.status = 'running';
    job.error = '';
    renderJob(job, true);
    renderJobsSummary();
    try {
      await job.run(job);
      job.status = 'done';
      job.phase = '';
      job.note = '';
      if (job.span) job.done = job.span;
      J.finished++;
      if (job.logDone !== false) log('ok', `${job.title} — done`);
    } catch (e) {
      if (job.ctrl.signal.aborted || (e && e.code === 'ABORTED')) {
        job.status = 'canceled';
        log('info', `${job.title} — canceled`);
      } else if (e && e.code === 'DISCONNECTED' && S.conn !== 'off' && job.requeues < 3) {
        job.requeues++;
        job.status = 'queued';
        job.note = 'Waiting for the device to reconnect…';
        log('warn', `${job.title} — paused until the device reconnects`);
      } else {
        job.status = 'error';
        job.error = (e && e.message) || String(e);
        J.failed++;
        log('error', `${job.title} — ${job.error}`);
      }
    } finally {
      J.running = null;
      if (job.affects) J.dirty = true;
      renderJob(job);
      if (job.after && job.status === 'done') {
        try {
          await job.after();
        } catch (e) {
          log('warn', e.message);
        }
      }
      setTimeout(pump, 0);
    }
  }

  function onQueueIdle() {
    renderJobsSummary();
    if (J.dirty) {
      J.dirty = false;
      refresh();
      loadDrives();
    }
    if (J.finished + J.failed > 1 || J.failed) {
      if (J.failed) toast(`${plural(J.finished, 'task')} finished, ${J.failed} failed. See Transfers for details.`, 'error');
      else toast(`All done — ${plural(J.finished, 'task')} finished.`, 'ok');
    }
    J.finished = 0;
    J.failed = 0;
  }

  function cancelJob(job) {
    if (job.status === 'queued') {
      job.status = 'canceled';
      renderJob(job);
      renderJobsSummary();
    } else if (job.status === 'running') {
      job.ctrl.abort();
      job.phase = 'Canceling…';
      renderJob(job);
    }
  }
  function retryJob(job) {
    Object.assign(job, { status: 'queued', error: '', note: '', phase: '', done: 0, requeues: 0, ctrl: new AbortController() });
    renderJob(job);
    pump();
  }
  function removeJob(job) {
    if (job.status === 'running' || job.status === 'queued') return;
    J.list = J.list.filter((j) => j !== job);
    renderJobs();
  }
  function cancelAllJobs() {
    J.list.forEach((j) => {
      if (j.status === 'queued') j.status = 'canceled';
      else if (j.status === 'running') j.ctrl.abort();
    });
    renderJobs();
  }

  function setPhase(job, phase) {
    job.phase = phase;
    scheduleJobRender(job);
  }
  function setProgress(job, done, span) {
    job.done = done;
    if (span != null) job.span = span;
    scheduleJobRender(job);
  }

  const jobRenderQueue = new Set();
  let jobRenderQueued = false;
  function scheduleJobRender(job) {
    jobRenderQueue.add(job);
    if (jobRenderQueued) return;
    jobRenderQueued = true;
    requestAnimationFrame(() => {
      jobRenderQueued = false;
      jobRenderQueue.forEach((j) => renderJob(j));
      jobRenderQueue.clear();
      renderJobsSummary();
    });
  }

  function jobHtml(j) {
    const pct = j.status === 'done' ? 100 : j.span ? Math.min(100, (j.done / j.span) * 100) : 0;
    const ic = j.status === 'done' ? 'check' : j.status === 'error' ? 'alert' : j.icon || 'file';
    let size = j.total ? fmtSize(j.total) : '';
    if (j.status === 'running' && j.span) size = `${Math.floor(pct)}%${size ? ' · ' + size : ''}`;
    let sub;
    if (j.status === 'error') sub = j.error;
    else if (j.status === 'canceled') sub = 'Canceled';
    else if (j.status === 'queued') sub = j.note || 'Waiting…';
    else if (j.status === 'done') sub = j.doneText || j.detail || 'Done';
    else sub = [j.phase, j.note].filter(Boolean).join(' · ') || j.detail || '';
    let acts = '';
    if (j.status === 'error' || j.status === 'canceled') {
      acts = `<button class="btn ghost icon sm" data-job-act="retry" title="Try again" aria-label="Try again">${icon('retry')}</button>
        <button class="btn ghost icon sm" data-job-act="remove" title="Remove from list" aria-label="Remove from list">${icon('x')}</button>`;
    } else if (j.status === 'queued' || j.status === 'running') {
      acts = `<button class="btn ghost icon sm" data-job-act="cancel" title="Cancel" aria-label="Cancel">${icon('x')}</button>`;
    } else {
      acts = `<button class="btn ghost icon sm" data-job-act="remove" title="Remove from list" aria-label="Remove from list">${icon('x')}</button>`;
    }
    return `<div class="xfer ${j.status}" data-job="${j.id}">
      <div class="xfer-ic">${icon(ic)}</div>
      <div class="xfer-title"><span class="t" title="${esc(j.title)}">${esc(j.title)}</span><span class="s">${esc(size)}</span></div>
      <div class="xfer-sub"><span class="d" title="${esc(sub)}">${esc(sub)}</span><span class="xfer-bar"><i style="width:${pct.toFixed(1)}%"></i></span></div>
      <div class="xfer-act">${acts}</div>
    </div>`;
  }

  function renderJobs() {
    el.xferList.innerHTML = J.list.length
      ? J.list.map(jobHtml).join('')
      : '<div class="xfer-empty">Uploads, downloads, copies and deletes show up here. Drag files onto the window to upload.</div>';
    renderJobsSummary();
  }

  function renderJob(job, scroll) {
    const node = el.xferList.querySelector(`[data-job="${job.id}"]`);
    if (!node) return renderJobs();
    const tmp = document.createElement('div');
    tmp.innerHTML = jobHtml(job);
    const fresh = tmp.firstElementChild;
    node.replaceWith(fresh);
    if (scroll) fresh.scrollIntoView({ block: 'nearest' });
  }

  function renderJobsSummary() {
    const active = J.list.filter((j) => j.status === 'queued' || j.status === 'running');
    const failed = J.list.filter((j) => j.status === 'error').length;
    el.xferBadge.hidden = !active.length;
    el.xferBadge.textContent = active.length;
    let s = '';
    if (J.running) {
      const j = J.running;
      const pct = j.span ? ` · ${Math.floor(Math.min(100, (j.done / j.span) * 100))}%` : '';
      s = `${j.title}${pct}${active.length > 1 ? ` · ${active.length - 1} more queued` : ''}`;
    } else if (active.length && S.conn !== 'on') {
      s = `${plural(active.length, 'task')} waiting for the device`;
    } else if (failed) {
      s = `${failed} failed`;
    } else if (J.list.length) {
      s = 'All finished';
    }
    el.xferSummary.textContent = s;
  }

  function openPanel(tab) {
    el.panel.dataset.open = 'true';
    if (tab) setTab(tab);
  }
  function setTab(tab) {
    activeTab = tab;
    el.panel.querySelectorAll('.tab').forEach((t) => t.classList.toggle('active', t.dataset.tab === tab));
    el.panel.querySelectorAll('.panel-tools').forEach((t) => (t.hidden = t.dataset.for !== tab));
    el.xferList.hidden = tab !== 'transfers';
    el.logList.hidden = tab !== 'log';
    if (tab === 'log') {
      logErrors = 0;
      el.logBadge.hidden = true;
      el.logList.scrollTop = el.logList.scrollHeight;
    }
  }

  /* ---------------------------------------------------------------- uploads */

  async function enqueueUploads(batch, destDir) {
    if (S.conn !== 'on' || !destDir) return;
    const files = batch.files.filter((f) => !JUNK.test(PP.basename(f.rel)));
    const dirSet = new Set((batch.dirs || []).filter(Boolean));
    files.forEach((f) => {
      const segs = f.rel.split('/');
      for (let i = 1; i < segs.length; i++) dirSet.add(segs.slice(0, i).join('/'));
    });
    if (!files.length && !dirSet.size) {
      toast('Nothing to upload', 'info');
      return;
    }

    const existing = await listingFor(destDir);
    if (!existing) return;
    const exMap = new Map(existing.map((i) => [i.name, i]));

    const tops = new Map();
    dirSet.forEach((d) => tops.set(d.split('/')[0], { isDir: true }));
    files.forEach((f) => {
      if (!f.rel.includes('/')) tops.set(f.rel, { isDir: false });
    });

    let policy = 'replace';
    const conflicts = Array.from(tops.keys()).filter((n) => exMap.has(n));
    if (conflicts.length) {
      policy = await askConflict(conflicts, destDir);
      if (!policy) return;
    }

    const destBudget = PP.nameBudget(destDir);
    const topTaken = new Set(exMap.keys());
    const topMap = new Map();
    tops.forEach((info, name) => {
      const ex = exMap.get(name);
      if (ex) {
        if (policy === 'skip') return topMap.set(name, null);
        if (policy === 'rename' || ex.isDir !== info.isDir) {
          const n = PP.unique(name, destBudget, (c) => topTaken.has(c));
          topTaken.add(n);
          return topMap.set(name, n);
        }
      }
      topTaken.add(name);
      topMap.set(name, name);
    });

    const rels = Array.from(dirSet)
      .map((r) => ({ rel: r, isDir: true }))
      .concat(files.map((f) => ({ rel: f.rel, isDir: false, file: f.file })));
    rels.sort((a, b) => a.rel.split('/').length - b.rel.split('/').length || collator.compare(a.rel, b.rel));

    const plan = (mode) => {
      const map = new Map();
      const tooLong = [];
      const taken = new Map();
      for (const r of rels) {
        const segs = r.rel.split('/');
        const parentRel = segs.slice(0, -1).join('/');
        const parentDev = parentRel ? map.get(parentRel) : destDir;
        if (!parentDev) {
          map.set(r.rel, null);
          continue;
        }
        let name = parentRel ? segs[segs.length - 1] : topMap.get(segs[0]);
        if (name == null) {
          map.set(r.rel, null);
          continue;
        }
        const budget = PP.nameBudget(parentDev);
        if (!taken.has(parentDev)) taken.set(parentDev, new Set(parentDev === destDir ? topTaken : []));
        const siblings = taken.get(parentDev);
        if (PP.byteLen(name) > budget || /[\\\x00]/.test(name)) {
          tooLong.push(r.rel);
          if (mode === 'skip' || budget < 5) {
            map.set(r.rel, null);
            continue;
          }
          if (mode === 'shorten') name = PP.unique(name.replace(/[\\\x00]/g, '_'), budget, (c) => siblings.has(c));
        }
        siblings.add(name);
        map.set(r.rel, PP.join(parentDev, name));
      }
      return { map, tooLong };
    };

    let result = plan('check');
    if (result.tooLong.length) {
      const mode = await askLongNames(result.tooLong);
      if (!mode) return;
      result = plan(mode);
    }

    const dirsToCreate = rels.filter((r) => r.isDir && result.map.get(r.rel)).map((r) => result.map.get(r.rel));
    const uploads = rels.filter((r) => !r.isDir && result.map.get(r.rel)).map((r) => ({ file: r.file, dest: result.map.get(r.rel) }));
    if (!dirsToCreate.length && !uploads.length) {
      toast('Nothing to upload', 'info');
      return;
    }

    if (dirsToCreate.length) {
      addJob({
        kind: 'mkdir',
        icon: 'folder-plus',
        title: dirsToCreate.length === 1 ? `Create folder ${PP.basename(dirsToCreate[0])}` : `Create ${dirsToCreate.length} folders`,
        detail: 'in ' + destDir,
        affects: destDir,
        logDone: false,
        run: async (job) => {
          let i = 0;
          for (const d of dirsToCreate) {
            if (job.ctrl.signal.aborted) throw P.abortError();
            setPhase(job, PP.basename(d));
            await withRetry(() => ensureDir(d), retryOpts('Create folder', { signal: job.ctrl.signal }));
            optimisticAdd(d, { isDir: true });
            setProgress(job, ++i, dirsToCreate.length);
          }
        },
      });
    }
    uploads.forEach((u) =>
      addJob({
        kind: 'upload',
        icon: 'upload',
        title: PP.basename(u.dest),
        detail: 'to ' + PP.parent(u.dest),
        doneText: 'Uploaded to ' + PP.parent(u.dest),
        total: u.file.size,
        affects: PP.parent(u.dest),
        dest: u.dest,
        file: u.file,
        logDone: uploads.length <= 20,
        run: runUpload,
      })
    );
    log('info', `Queued ${plural(uploads.length, 'file')} for upload to ${destDir}`);
  }

  async function runUpload(job) {
    let data;
    try {
      data = new Uint8Array(await job.file.arrayBuffer());
    } catch (e) {
      throw new PixlError(`Couldn’t read ${job.file.name} from this computer: ${e.message}`);
    }
    job.total = data.length;
    const verify = el.verifyChk.checked;
    const span = (verify ? data.length * 2 : data.length) || 1;
    try {
      await writeAndVerify(job, job.dest, data, verify, (n) => setProgress(job, n, span));
    } catch (e) {
      if (job.ctrl.signal.aborted || e.code === 'ABORTED') {
        // don't leave a half-written file behind
        if (S.client && S.conn === 'on') await S.client.remove(job.dest).catch(() => {});
        optimisticRemove(job.dest);
      }
      throw e;
    }
    optimisticAdd(job.dest, { size: data.length });
  }

  function collectDropEntries(dt) {
    // Must run synchronously inside the drop event.
    const entries = [];
    const loose = [];
    Array.from(dt.items || []).forEach((item) => {
      if (item.kind !== 'file') return;
      const entry = item.webkitGetAsEntry ? item.webkitGetAsEntry() : null;
      if (entry) entries.push(entry);
      else {
        const f = item.getAsFile();
        if (f) loose.push(f);
      }
    });
    if (!entries.length && !loose.length) Array.from(dt.files || []).forEach((f) => loose.push(f));
    return { entries, loose };
  }

  async function entriesToBatch(collected) {
    const files = collected.loose.map((f) => ({ file: f, rel: f.name }));
    const dirs = [];
    const readAll = (reader) =>
      new Promise((resolve, reject) => {
        const all = [];
        const step = () =>
          reader.readEntries((batch) => {
            if (!batch.length) return resolve(all);
            all.push(...batch);
            step();
          }, reject);
        step();
      });
    async function walk(entry, prefix) {
      if (entry.isFile) {
        const file = await new Promise((res, rej) => entry.file(res, rej));
        files.push({ file, rel: prefix + entry.name });
      } else if (entry.isDirectory) {
        dirs.push(prefix + entry.name);
        const children = await readAll(entry.createReader());
        for (const c of children) await walk(c, prefix + entry.name + '/');
      }
    }
    for (const e of collected.entries) await walk(e, '');
    return { files, dirs };
  }

  /* -------------------------------------------------------------- downloads */

  function download(items) {
    if (!items.length || !S.cwd) return;
    const baseDir = S.cwd;
    if (items.length === 1 && !items[0].isDir) {
      const it = items[0];
      const src = PP.join(baseDir, it.name);
      addJob({
        kind: 'download',
        icon: 'download',
        title: it.name,
        detail: 'Downloading',
        doneText: 'Saved to your Downloads folder',
        total: it.size,
        run: async (job) => {
          setPhase(job, 'Downloading');
          const data = await readVerified(src, it.size, (n) => setProgress(job, n, it.size || 1), retryOpts(`Read ${it.name}`, { signal: job.ctrl.signal }));
          saveBlob(new Blob([data], { type: 'application/octet-stream' }), it.name);
        },
      });
      return;
    }
    const base = items.length === 1 ? items[0].name : PP.isRoot(baseDir) ? `Pixl ${PP.drive(baseDir)}` : PP.basename(baseDir);
    queueZip(baseDir, items, `${base}.zip`);
  }

  function queueZip(baseDir, items, zipName) {
    addJob({
      kind: 'zip',
      icon: 'zip',
      title: zipName,
      detail: plural(items.length, 'item'),
      doneText: 'Saved to your Downloads folder',
      run: (job) => runZip(job, baseDir, items, zipName),
    });
  }

  async function runZip(job, baseDir, items, zipName) {
    const sig = { signal: job.ctrl.signal };
    setPhase(job, 'Scanning folders');
    const entries = [];
    async function walk(devPath, zipPath, it) {
      if (job.ctrl.signal.aborted) throw P.abortError();
      if (!it.isDir) {
        entries.push({ zipPath, devPath, size: it.size });
        return;
      }
      entries.push({ zipPath: zipPath + '/', dir: true });
      const kids = await withRetry(() => S.client.listDir(devPath), retryOpts('Open folder', sig));
      for (const k of kids) await walk(PP.join(devPath, k.name), zipPath + '/' + k.name, k);
    }
    for (const it of items) await walk(PP.join(baseDir, it.name), it.name, it);

    const total = entries.reduce((a, e) => a + (e.size || 0), 0);
    job.total = total;
    const out = [];
    let done = 0;
    let n = 0;
    const fileCount = entries.filter((e) => !e.dir).length;
    for (const e of entries) {
      if (job.ctrl.signal.aborted) throw P.abortError();
      if (e.dir) {
        out.push({ name: e.zipPath, dir: true });
        continue;
      }
      n++;
      setPhase(job, `Reading ${n} of ${fileCount}: ${PP.basename(e.devPath)}`);
      const data = await readVerified(e.devPath, e.size, (k) => setProgress(job, done + k, total || 1), retryOpts(`Read ${PP.basename(e.devPath)}`, sig));
      out.push({ name: e.zipPath, data });
      done += e.size;
      setProgress(job, done, total || 1);
    }
    setPhase(job, 'Saving');
    saveBlob(P.buildZip(out), zipName);
    job.doneText = `${plural(fileCount, 'file')} saved to your Downloads folder`;
  }

  async function backupDrive(label) {
    const root = PP.root(label);
    const items = await listingFor(root);
    if (!items) return;
    if (!items.length) {
      toast('That drive is empty', 'info');
      return;
    }
    const date = new Date().toISOString().slice(0, 10);
    queueZip(root, items, `Pixl ${label}-drive backup ${date}.zip`);
  }

  /* -------------------------------------------------------- copy/move/paste */

  function setClipboard(mode) {
    const items = selectedItems();
    if (!items.length || !S.cwd) return;
    S.clipboard = {
      mode,
      items: items.map((it) => ({ path: PP.join(S.cwd, it.name), name: it.name, isDir: it.isDir, size: it.size, meta: it.meta })),
    };
    toast(`${plural(items.length, 'item')} ${mode === 'cut' ? 'cut' : 'copied'}. Open a folder and press Paste.`, 'info', 2500);
    renderList();
  }

  function paste(destDir) {
    if (!S.clipboard || !destDir) return;
    const clip = S.clipboard;
    return transferItems(clip.items, clip.mode === 'cut', destDir).then((queued) => {
      if (queued && clip.mode === 'cut') {
        S.clipboard = null;
        renderList();
      }
    });
  }

  async function transferItems(items, move, destDir) {
    for (const it of items) {
      if (it.isDir && (destDir === it.path || destDir.startsWith(it.path + '/'))) {
        toast(`Can’t put “${it.name}” inside itself`, 'error');
        return false;
      }
    }
    const work = items.filter((it) => !(move && PP.parent(it.path) === destDir));
    if (!work.length) {
      toast(move ? 'Those items are already in this folder' : 'Nothing to paste', 'info');
      return false;
    }
    const existing = await listingFor(destDir);
    if (!existing) return false;
    const exMap = new Map(existing.map((i) => [i.name, i]));
    const budget = PP.nameBudget(destDir);
    const taken = new Set(exMap.keys());

    const conflicts = work.filter((it) => exMap.has(it.name) && PP.parent(it.path) !== destDir).map((it) => it.name);
    let policy = 'rename';
    if (conflicts.length) {
      policy = await askConflict(conflicts, destDir);
      if (!policy) return false;
    }

    const plan = [];
    for (const it of work) {
      let name = it.name;
      const sameDir = PP.parent(it.path) === destDir;
      if (sameDir) {
        name = PP.unique(it.name, budget, (c) => taken.has(c));
      } else if (exMap.has(name)) {
        const ex = exMap.get(name);
        if (policy === 'skip') continue;
        if (policy === 'rename' || ex.isDir !== it.isDir) name = PP.unique(name, budget, (c) => taken.has(c));
      } else if (PP.byteLen(name) > budget) {
        name = PP.unique(name, budget, (c) => taken.has(c));
      }
      taken.add(name);
      plan.push({ it, dest: PP.join(destDir, name) });
    }
    if (!plan.length) return false;

    const what = plan.length === 1 ? plan[0].it.name : plural(plan.length, 'item');
    addJob({
      kind: move ? 'move' : 'copy',
      icon: move ? 'move' : 'copy',
      title: `${move ? 'Move' : 'Copy'} ${what}`,
      detail: 'to ' + destDir,
      doneText: `${move ? 'Moved' : 'Copied'} to ${destDir}`,
      affects: destDir,
      run: (job) => runTransfer(job, plan, move),
    });
    return true;
  }

  /**
   * Copies or moves items on the device. Folder moves are done item by item,
   * because the firmware's folder rename is broken (it renames to the same name).
   */
  async function runTransfer(job, plan, move) {
    const sig = { signal: job.ctrl.signal };
    const verify = el.verifyChk.checked;
    setPhase(job, 'Scanning');
    const tasks = [];
    let bytes = 0;

    async function scan(src, dest, it) {
      if (job.ctrl.signal.aborted) throw P.abortError();
      if (PP.byteLen(dest) > P.LIMITS.pathBytes) {
        const parent = PP.parent(dest);
        const fitted = PP.join(parent, PP.fit(PP.basename(dest), PP.nameBudget(parent)));
        log('warn', `Shortened ${PP.basename(dest)} to ${PP.basename(fitted)} to fit the device's path limit`);
        dest = fitted;
      }
      if (it.isDir) {
        tasks.push({ op: 'mkdir', dest, meta: it.meta });
        const kids = await withRetry(() => S.client.listDir(src), retryOpts('Open folder', sig));
        for (const k of kids) await scan(PP.join(src, k.name), PP.join(dest, k.name), k);
        if (move) tasks.push({ op: 'rm', src });
      } else if (move && PP.drive(src) === PP.drive(dest)) {
        tasks.push({ op: 'rename', src, dest });
      } else {
        tasks.push({ op: 'copy', src, dest, size: it.size, meta: it.meta });
        bytes += it.size;
        if (move) tasks.push({ op: 'rm', src });
      }
    }
    for (const p of plan) await scan(p.it.path, p.dest, p.it);

    const OP_WEIGHT = 300;
    const span = bytes * (verify ? 2 : 1) + tasks.length * OP_WEIGHT || 1;
    job.total = bytes;
    let doneBytes = 0;
    let doneOps = 0;
    const prog = (extra) => setProgress(job, doneBytes + doneOps * OP_WEIGHT + (extra || 0), span);

    for (const t of tasks) {
      if (job.ctrl.signal.aborted) throw P.abortError();
      const ro = retryOpts(`${t.op} ${PP.basename(t.src || t.dest)}`, sig);
      if (t.op === 'mkdir') {
        setPhase(job, `Creating ${PP.basename(t.dest)}`);
        await withRetry(() => ensureDir(t.dest), ro);
        if (!P.metaIsEmpty(t.meta)) await S.client.updateMeta(t.dest, t.meta).catch((e) => log('warn', `Couldn’t copy folder notes: ${e.message}`));
        optimisticAdd(t.dest, { isDir: true });
      } else if (t.op === 'copy') {
        const name = PP.basename(t.src);
        setPhase(job, `Reading ${name}`);
        const data = await readVerified(t.src, t.size, null, ro);
        await writeAndVerify(job, t.dest, data, verify, (n) => prog(n));
        if (!P.metaIsEmpty(t.meta)) {
          await withRetry(() => S.client.updateMeta(t.dest, t.meta), ro).catch((e) => log('warn', `Couldn’t copy notes for ${name}: ${e.message}`));
        }
        doneBytes += data.length * (verify ? 2 : 1);
        optimisticAdd(t.dest, { size: data.length });
      } else if (t.op === 'rename') {
        setPhase(job, `Moving ${PP.basename(t.src)}`);
        await renameSafe(t.src, t.dest, ro);
        optimisticRemove(t.src);
        optimisticAdd(t.dest, {});
      } else if (t.op === 'rm') {
        setPhase(job, `Removing ${PP.basename(t.src)}`);
        await removeSafe(t.src, ro);
        optimisticRemove(t.src);
      }
      doneOps++;
      prog();
    }
  }

  /* ------------------------------------------------------ rename/delete/etc */

  async function renameItem(it) {
    if (!it) return;
    const dir = S.cwd;
    const src = PP.join(dir, it.name);
    const names = new Set(S.items.map((i) => i.name));
    const name = await promptName({
      title: `Rename ${it.isDir ? 'folder' : 'file'}`,
      label: 'New name',
      value: it.name,
      okLabel: 'Rename',
      dir,
      selectBase: !it.isDir,
      extraValidate: (v) => (v !== it.name && names.has(v) ? 'Something with that name is already here' : null),
    });
    if (!name || name === it.name) return;
    const dest = PP.join(dir, name);
    if (it.isDir) {
      addJob({
        kind: 'move',
        icon: 'rename',
        title: `Rename ${it.name} → ${name}`,
        detail: 'Folder rename',
        doneText: 'Renamed',
        affects: dir,
        run: (job) => runTransfer(job, [{ it: Object.assign({}, it, { path: src }), dest }], true),
        after: async () => {
          S.sel = new Set([name]);
          S.focus = S.anchor = name;
        },
      });
      return;
    }
    try {
      await renameSafe(src, dest, retryOpts('Rename'));
      log('ok', `Renamed ${it.name} → ${name}`);
      S.sel = new Set([name]);
      S.focus = S.anchor = name;
    } catch (e) {
      toast(e.message, 'error');
      log('error', e.message);
    }
    refresh();
  }

  async function deleteItems(items) {
    if (!items.length || !S.cwd) return;
    const dirs = items.filter((i) => i.isDir).length;
    const ok = await modal({
      title: items.length === 1 ? `Delete “${items[0].name}”?` : `Delete ${items.length} items?`,
      icon: 'trash',
      tone: 'danger',
      body: `${items.length > 1 ? itemListHtml(items.map((i) => i.name)) : ''}<p>${
        dirs ? 'Folders are deleted together with everything inside them. ' : ''
      }This can’t be undone.</p>`,
      actions: [
        { label: 'Cancel', value: null },
        { label: 'Delete', kind: 'danger', submit: true, value: true },
      ],
    });
    if (!ok) return;
    const dir = S.cwd;
    addJob({
      kind: 'delete',
      icon: 'trash',
      title: items.length === 1 ? `Delete ${items[0].name}` : `Delete ${items.length} items`,
      detail: 'from ' + dir,
      doneText: 'Deleted from ' + dir,
      affects: dir,
      run: async (job) => {
        const sig = { signal: job.ctrl.signal };
        setPhase(job, 'Scanning');
        const ops = [];
        async function scan(p, isDir) {
          if (job.ctrl.signal.aborted) throw P.abortError();
          if (isDir) {
            const kids = await withRetry(() => S.client.listDir(p), retryOpts('Open folder', sig));
            for (const k of kids) await scan(PP.join(p, k.name), k.isDir);
          }
          ops.push(p);
        }
        for (const it of items) await scan(PP.join(dir, it.name), it.isDir);
        let i = 0;
        for (const p of ops) {
          if (job.ctrl.signal.aborted) throw P.abortError();
          setPhase(job, `Deleting ${PP.basename(p)}`);
          await removeSafe(p, retryOpts('Delete', sig));
          optimisticRemove(p);
          setProgress(job, ++i, ops.length);
        }
        job.doneText = `${plural(ops.length, 'item')} deleted from ${dir}`;
      },
    });
    S.sel.clear();
    renderSelection();
  }

  async function newFolder() {
    if (!S.cwd) return;
    const dir = S.cwd;
    const names = new Set(S.items.map((i) => i.name));
    const suggested = PP.unique('New folder', PP.nameBudget(dir), (n) => names.has(n));
    const name = await promptName({
      title: 'New folder',
      label: 'Folder name',
      value: suggested,
      okLabel: 'Create',
      icon: 'folder-plus',
      dir,
      extraValidate: (v) => (names.has(v) ? 'Something with that name is already here' : null),
    });
    if (!name) return;
    try {
      await withRetry(() => ensureDir(PP.join(dir, name)), retryOpts('Create folder'));
      log('ok', `Created folder ${PP.join(dir, name)}`);
      if (S.cwd === dir) {
        S.sel = new Set([name]);
        S.focus = S.anchor = name;
      }
    } catch (e) {
      toast(e.message, 'error');
      log('error', e.message);
    }
    await refresh();
    scrollRowIntoView(name);
  }

  async function properties(it) {
    if (!it || !S.cwd) return;
    const p = PP.join(S.cwd, it.name);
    const id = P.amiiboId(it.meta);
    const kind = kindOf(it);
    let notesEl, hidEl, roEl, errEl;
    const res = await modal({
      title: it.name,
      icon: kind,
      body: `<dl class="kv">
          <dt>Location</dt><dd>${esc(PP.parent(p))}</dd>
          <dt>Type</dt><dd>${it.isDir ? 'Folder' : kind === 'tag' ? 'Amiibo data' : 'File'}</dd>
          ${it.isDir ? '' : `<dt>Size</dt><dd>${fmtSize(it.size)} (${it.size.toLocaleString()} bytes)</dd>`}
          ${id ? `<dt>Amiibo ID</dt><dd class="mono">${id}</dd>` : ''}
        </dl>
        <label class="field"><span>Notes <em id="notesCount"></em></span>
          <input type="text" id="notesIn" value="${esc(it.meta.notes || '')}" placeholder="Shown on the device" autocomplete="off"></label>
        <label class="check-row"><input type="checkbox" id="hidIn" ${it.meta.hidden ? 'checked' : ''}>
          <span>Hidden<small>Hide it from the amiibo list on the device. It still shows here.</small></span></label>
        <label class="check-row"><input type="checkbox" id="roIn" ${it.meta.readonly ? 'checked' : ''}>
          <span>Read-only<small>Mark it read-only on the device.</small></span></label>
        <div class="field-err" id="propErr"></div>`,
      actions: [
        { label: 'Cancel', value: null },
        {
          label: 'Save',
          kind: 'primary',
          submit: true,
          value: () => ({ notes: notesEl.value.trim(), hidden: hidEl.checked, readonly: roEl.checked }),
        },
      ],
      init(d) {
        notesEl = d.querySelector('#notesIn');
        hidEl = d.querySelector('#hidIn');
        roEl = d.querySelector('#roIn');
        errEl = d.querySelector('#propErr');
        const count = d.querySelector('#notesCount');
        const upd = () => {
          const n = PP.byteLen(notesEl.value.trim());
          count.textContent = `${n} / ${P.LIMITS.notesBytes} bytes`;
          count.classList.toggle('over', n > P.LIMITS.notesBytes);
          errEl.textContent = '';
        };
        notesEl.addEventListener('input', upd);
        upd();
        notesEl.focus();
      },
      validate() {
        if (PP.byteLen(notesEl.value.trim()) > P.LIMITS.notesBytes) {
          errEl.textContent = `Notes can be at most ${P.LIMITS.notesBytes} bytes`;
          return false;
        }
        return true;
      },
    });
    if (!res) return;
    if (res.notes === (it.meta.notes || '') && res.hidden === it.meta.hidden && res.readonly === it.meta.readonly) return;
    try {
      await withRetry(() => S.client.updateMeta(p, Object.assign({}, it.meta, res)), retryOpts('Save properties'));
      log('ok', `Saved properties of ${it.name}`);
      toast('Saved', 'ok', 1800);
    } catch (e) {
      toast(e.message, 'error');
      log('error', e.message);
    }
    refresh();
  }

  async function formatDrive(label) {
    const d = S.drives.find((x) => x.label === label);
    let input;
    const ok = await modal({
      title: `Format ${d ? d.name : label + ':'}?`,
      icon: 'erase',
      tone: 'danger',
      body: `<p>Every file and folder on <b>${esc(label)}:</b> will be erased permanently. Back up the drive first if you want to keep anything.</p>
        <label class="field"><span>Type ${esc(label)} to confirm</span><input type="text" id="fmtIn" autocomplete="off" spellcheck="false"></label>`,
      actions: [
        { label: 'Cancel', value: null },
        { label: 'Format drive', kind: 'danger', submit: true, value: true },
      ],
      init(dl) {
        input = dl.querySelector('#fmtIn');
        input.focus();
      },
      validate() {
        if (input.value.trim().toUpperCase() !== label.toUpperCase()) {
          input.focus();
          input.select();
          return false;
        }
        return true;
      },
    });
    if (!ok) return;
    addJob({
      kind: 'format',
      icon: 'erase',
      title: `Format ${label}:`,
      detail: d ? d.name : '',
      doneText: 'Drive formatted',
      run: async (job) => {
        setPhase(job, 'Formatting — this can take a minute');
        await S.client.formatDrive(label);
      },
      after: async () => {
        await loadDrives();
        await navigate(PP.root(label), { push: false });
      },
    });
  }

  /* ---------------------------------------------------------------- theming */

  function currentTheme() {
    return document.documentElement.dataset.theme || (matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light');
  }
  function applyTheme(t) {
    if (t) document.documentElement.dataset.theme = t;
    else delete document.documentElement.dataset.theme;
    el.themeBtn.innerHTML = icon(currentTheme() === 'dark' ? 'sun' : 'moon');
  }

  /* ----------------------------------------------------------------- events */

  function itemByName(name) {
    return S.items.find((i) => i.name === name);
  }

  const actions = {
    'upload-files': () => el.fileInput.click(),
    'upload-folder': () => el.folderInput.click(),
    'new-folder': newFolder,
    download: () => download(selectedItems()),
    copy: () => setClipboard('copy'),
    cut: () => setClipboard('cut'),
    paste: () => paste(S.cwd),
    rename: () => renameItem(selectedItems()[0]),
    props: () => properties(selectedItems()[0]),
    delete: () => deleteItems(selectedItems()),
  };

  function rowMenu(it, x, y) {
    const sel = selectedItems();
    const multi = sel.length > 1;
    const dir = PP.join(S.cwd, it.name);
    showMenu(x, y, [
      it.isDir && !multi
        ? { label: 'Open', icon: 'folder', act: () => openItem(it) }
        : { label: multi || it.isDir ? 'Download as ZIP' : 'Download', icon: 'download', act: actions.download },
      it.isDir && !multi ? { label: 'Download as ZIP', icon: 'zip', act: actions.download } : null,
      '-',
      { label: 'Copy', icon: 'copy', kbd: 'Ctrl+C', act: actions.copy },
      { label: 'Cut', icon: 'cut', kbd: 'Ctrl+X', act: actions.cut },
      it.isDir && !multi ? { label: 'Paste into folder', icon: 'paste', disabled: !S.clipboard, act: () => paste(dir) } : null,
      '-',
      { label: 'Rename', icon: 'rename', kbd: 'F2', disabled: multi, act: actions.rename },
      { label: 'Properties', icon: 'info', kbd: 'Alt+Enter', disabled: multi, act: actions.props },
      '-',
      { label: multi ? `Delete ${sel.length} items` : 'Delete', icon: 'trash', kbd: 'Del', danger: true, act: actions.delete },
    ].filter(Boolean));
  }

  function emptyMenu(x, y) {
    showMenu(x, y, [
      { label: 'Upload files…', icon: 'upload', act: actions['upload-files'] },
      { label: 'Upload folder…', icon: 'folder', act: actions['upload-folder'] },
      { label: 'New folder', icon: 'folder-plus', kbd: 'Ctrl+Shift+N', act: actions['new-folder'] },
      '-',
      { label: 'Paste', icon: 'paste', kbd: 'Ctrl+V', disabled: !S.clipboard, act: actions.paste },
      { label: 'Refresh', icon: 'refresh', kbd: 'F5', act: () => refresh() },
      { label: 'Select all', icon: 'check', kbd: 'Ctrl+A', disabled: !S.view.length, act: selectAll },
    ]);
  }

  function selectAll() {
    S.view.forEach((i) => S.sel.add(i.name));
    renderSelection();
  }

  function bind() {
    el.connectBtn.addEventListener('click', () => (S.conn === 'on' || S.conn === 'lost' ? userDisconnect() : connect(false)));
    el.welcomeConnect.addEventListener('click', () => connect(false));
    el.demoBtn.addEventListener('click', () => connect(true));
    el.sideDisconnect.addEventListener('click', userDisconnect);
    el.bannerDisconnect.addEventListener('click', userDisconnect);
    el.bannerReconnect.addEventListener('click', () => reconnect(2));
    el.themeBtn.addEventListener('click', () => {
      const next = currentTheme() === 'dark' ? 'light' : 'dark';
      applyTheme(next);
      store.set('theme', next);
    });

    el.backBtn.addEventListener('click', goBack);
    el.fwdBtn.addEventListener('click', goFwd);
    el.upBtn.addEventListener('click', goUp);
    el.refreshBtn.addEventListener('click', () => {
      refresh();
      loadDrives();
    });
    el.crumbs.addEventListener('click', (ev) => {
      const b = ev.target.closest('.crumb');
      if (b && b.dataset.path !== S.cwd) navigate(b.dataset.path);
    });
    el.filter.addEventListener('input', () => {
      S.filter = el.filter.value;
      renderList();
    });

    const driveClick = (ev) => {
      const more = ev.target.closest('[data-drive-menu]');
      if (more) {
        ev.stopPropagation();
        const r = more.getBoundingClientRect();
        driveMenu(more.dataset.driveMenu, r.left, r.bottom + 4);
        return;
      }
      const d = ev.target.closest('[data-drive]');
      if (!d) return;
      const drive = S.drives.find((x) => x.label === d.dataset.drive);
      if (drive && drive.ok && PP.drive(S.cwd || '') !== drive.label) navigate(PP.root(drive.label));
      else if (drive && drive.ok && !PP.isRoot(S.cwd)) navigate(PP.root(drive.label));
    };
    el.driveList.addEventListener('click', driveClick);
    el.mobileDrives.addEventListener('click', driveClick);
    el.driveList.addEventListener('keydown', (ev) => {
      if ((ev.key === 'Enter' || ev.key === ' ') && ev.target.matches('[data-drive]')) {
        ev.preventDefault();
        driveClick(ev);
      }
    });
    el.driveList.addEventListener('contextmenu', (ev) => {
      const d = ev.target.closest('[data-drive]');
      if (!d) return;
      ev.preventDefault();
      driveMenu(d.dataset.drive, ev.clientX, ev.clientY);
    });

    el.actions.addEventListener('click', (ev) => {
      const b = ev.target.closest('[data-act]');
      if (b && !b.disabled && actions[b.dataset.act]) actions[b.dataset.act]();
    });
    el.uploadMenuBtn.addEventListener('click', (ev) => {
      ev.stopPropagation();
      const r = el.uploadMenuBtn.getBoundingClientRect();
      showMenu(r.left - 80, r.bottom + 4, [
        { label: 'Upload files…', icon: 'file', act: actions['upload-files'] },
        { label: 'Upload a folder…', icon: 'folder', act: actions['upload-folder'] },
      ]);
    });

    el.fileInput.addEventListener('change', () => {
      const files = Array.from(el.fileInput.files).map((f) => ({ file: f, rel: f.name }));
      el.fileInput.value = '';
      if (files.length) enqueueUploads({ files, dirs: [] }, S.cwd);
    });
    el.folderInput.addEventListener('change', () => {
      const files = Array.from(el.folderInput.files).map((f) => ({ file: f, rel: f.webkitRelativePath || f.name }));
      el.folderInput.value = '';
      if (files.length) enqueueUploads({ files, dirs: [] }, S.cwd);
    });

    // list: selection
    el.list.addEventListener('mousedown', () => el.list.focus({ preventScroll: true }));
    el.list.addEventListener('click', (ev) => {
      const row = ev.target.closest('.row');
      const mod = ev.ctrlKey || ev.metaKey;
      if (!row) {
        if (!mod && !ev.shiftKey && S.sel.size) {
          S.sel.clear();
          renderSelection();
        }
        return;
      }
      const name = row.dataset.name;
      if (ev.shiftKey && S.anchor != null) selectRange(S.anchor, name, mod);
      else if (mod || ev.target.closest('.c-check')) {
        if (S.sel.has(name)) S.sel.delete(name);
        else S.sel.add(name);
        S.anchor = name;
      } else {
        S.sel = new Set([name]);
        S.anchor = name;
      }
      S.focus = name;
      renderSelection();
    });
    el.list.addEventListener('dblclick', (ev) => {
      const row = ev.target.closest('.row');
      if (!row || ev.target.closest('.c-check')) return;
      openItem(itemByName(row.dataset.name));
    });
    el.list.addEventListener('contextmenu', (ev) => {
      if (S.conn !== 'on') return;
      ev.preventDefault();
      const row = ev.target.closest('.row');
      if (!row) return emptyMenu(ev.clientX, ev.clientY);
      const name = row.dataset.name;
      if (!S.sel.has(name)) {
        S.sel = new Set([name]);
        S.anchor = name;
      }
      S.focus = name;
      renderSelection();
      rowMenu(itemByName(name), ev.clientX, ev.clientY);
    });
    el.list.addEventListener('keydown', (ev) => {
      const items = S.view;
      if (!items.length) return;
      let idx = items.findIndex((i) => i.name === S.focus);
      let next = null;
      if (ev.key === 'ArrowDown') next = idx < 0 ? 0 : Math.min(items.length - 1, idx + 1);
      else if (ev.key === 'ArrowUp' && !ev.altKey) next = idx < 0 ? 0 : Math.max(0, idx - 1);
      else if (ev.key === 'Home') next = 0;
      else if (ev.key === 'End') next = items.length - 1;
      else if (ev.key === ' ' && S.focus) {
        ev.preventDefault();
        if (S.sel.has(S.focus)) S.sel.delete(S.focus);
        else S.sel.add(S.focus);
        renderSelection();
        return;
      }
      if (next == null) return;
      ev.preventDefault();
      const name = items[next].name;
      if (ev.shiftKey) selectRange(S.anchor != null ? S.anchor : name, name, false);
      else if (!(ev.ctrlKey || ev.metaKey)) {
        S.sel = new Set([name]);
        S.anchor = name;
      }
      S.focus = name;
      renderSelection();
      scrollRowIntoView(name);
    });

    el.checkAll.addEventListener('change', () => {
      if (el.checkAll.checked) S.view.forEach((i) => S.sel.add(i.name));
      else S.sel.clear();
      renderSelection();
    });
    el.listHead.addEventListener('click', (ev) => {
      const b = ev.target.closest('.sort');
      if (!b) return;
      const key = b.dataset.sort;
      S.sort = S.sort.key === key ? { key, dir: -S.sort.dir } : { key, dir: 1 };
      store.set('sort', S.sort);
      renderList();
    });
    el.listState.addEventListener('click', (ev) => {
      if (ev.target.closest('[data-state-act="retry"]')) refresh();
    });
    el.clipChip.addEventListener('click', (ev) => {
      if (ev.target.closest('button')) {
        S.clipboard = null;
        renderList();
      }
    });

    // panel
    el.panelToggle.addEventListener('click', () => {
      el.panel.dataset.open = el.panel.dataset.open === 'true' ? 'false' : 'true';
      if (el.panel.dataset.open === 'true' && activeTab === 'log') setTab('log');
    });
    el.panel.querySelector('.panel-head').addEventListener('dblclick', (ev) => {
      if (!ev.target.closest('button, input, label')) el.panelToggle.click();
    });
    el.panel.querySelectorAll('.tab').forEach((t) =>
      t.addEventListener('click', () => {
        openPanel(t.dataset.tab);
      })
    );
    el.xferList.addEventListener('click', (ev) => {
      const b = ev.target.closest('[data-job-act]');
      if (!b) return;
      const job = J.list.find((j) => j.id === +b.closest('[data-job]').dataset.job);
      if (!job) return;
      const act = b.dataset.jobAct;
      if (act === 'cancel') cancelJob(job);
      else if (act === 'retry') retryJob(job);
      else if (act === 'remove') removeJob(job);
    });
    el.clearDone.addEventListener('click', () => {
      J.list = J.list.filter((j) => j.status === 'queued' || j.status === 'running' || j.status === 'error');
      renderJobs();
    });
    el.verifyChk.addEventListener('change', () => store.set('verify', el.verifyChk.checked));
    el.verboseChk.addEventListener('change', () => {
      if (S.client) S.client.verbose = el.verboseChk.checked;
      rebuildLog();
    });
    el.copyLog.addEventListener('click', async () => {
      const text = logs.map((e) => `${e.t.toISOString()} ${e.level.toUpperCase()} ${e.msg}`).join('\n');
      try {
        await navigator.clipboard.writeText(text);
        toast('Log copied to the clipboard', 'ok', 1800);
      } catch (e) {
        saveBlob(new Blob([text], { type: 'text/plain' }), 'pixl-log.txt');
      }
    });
    el.clearLog.addEventListener('click', () => {
      logs.length = 0;
      el.logList.innerHTML = '';
    });

    // menus close
    document.addEventListener('mousedown', (ev) => {
      if (!el.menu.hidden && !el.menu.contains(ev.target)) hideMenu();
    });
    window.addEventListener('resize', hideMenu);
    el.list.addEventListener('scroll', hideMenu);
    window.addEventListener('blur', hideMenu);

    // keyboard shortcuts
    document.addEventListener('keydown', onKey);

    // drag & drop
    bindDragDrop();

    window.addEventListener('beforeunload', (ev) => {
      if (J.list.some((j) => j.status === 'running' || j.status === 'queued')) {
        ev.preventDefault();
        ev.returnValue = '';
      }
    });
  }

  function onKey(ev) {
    if (el.dlg.open) return;
    if (!el.menu.hidden) {
      if (ev.key === 'Escape') hideMenu();
      return;
    }
    if (S.conn !== 'on' || !S.cwd) return;
    const tag = ev.target.tagName;
    const typing = tag === 'INPUT' || tag === 'TEXTAREA';
    const mod = ev.ctrlKey || ev.metaKey;
    const k = ev.key.length === 1 ? ev.key.toLowerCase() : ev.key;
    if (typing) {
      if (ev.target === el.filter) {
        if (k === 'Escape') {
          el.filter.value = '';
          S.filter = '';
          renderList();
          el.list.focus();
        } else if (k === 'ArrowDown' || k === 'Enter') {
          ev.preventDefault();
          el.list.focus();
        }
      }
      return;
    }
    if (k === 'F5' || (mod && k === 'r')) {
      ev.preventDefault();
      refresh();
      loadDrives();
    } else if (mod && k === 'a') {
      ev.preventDefault();
      selectAll();
    } else if (mod && k === 'c') {
      ev.preventDefault();
      setClipboard('copy');
    } else if (mod && k === 'x') {
      ev.preventDefault();
      setClipboard('cut');
    } else if (mod && k === 'v') {
      ev.preventDefault();
      paste(S.cwd);
    } else if (mod && ev.shiftKey && k === 'n') {
      ev.preventDefault();
      newFolder();
    } else if (mod && k === 'f') {
      ev.preventDefault();
      el.filter.focus();
      el.filter.select();
    } else if (k === 'Delete') {
      ev.preventDefault();
      deleteItems(selectedItems());
    } else if (k === 'F2') {
      ev.preventDefault();
      const s = selectedItems();
      if (s.length === 1) renameItem(s[0]);
    } else if (k === 'Enter' && ev.altKey) {
      ev.preventDefault();
      const s = selectedItems();
      if (s.length === 1) properties(s[0]);
    } else if (k === 'Enter') {
      const s = selectedItems();
      const it = (S.focus && itemByName(S.focus)) || (s.length === 1 ? s[0] : null);
      if (it) {
        ev.preventDefault();
        openItem(it);
      }
    } else if (k === 'Backspace' || (ev.altKey && k === 'ArrowUp')) {
      ev.preventDefault();
      goUp();
    } else if (ev.altKey && k === 'ArrowLeft') {
      ev.preventDefault();
      goBack();
    } else if (ev.altKey && k === 'ArrowRight') {
      ev.preventDefault();
      goFwd();
    } else if (k === 'Escape' && S.sel.size) {
      S.sel.clear();
      renderSelection();
    }
  }

  function bindDragDrop() {
    let depth = 0;
    let hoverEl = null;
    const isFiles = (ev) => !!ev.dataTransfer && Array.from(ev.dataTransfer.types || []).includes('Files');
    const canDrop = () => S.conn === 'on' && !!S.cwd;
    const setHover = (node) => {
      if (hoverEl === node) return;
      if (hoverEl) hoverEl.classList.remove('drop-hover');
      hoverEl = node;
      if (hoverEl) hoverEl.classList.add('drop-hover');
    };
    const folderTarget = (ev) => {
      const t = ev.target;
      if (!(t instanceof Element)) return null;
      const row = t.closest('#list .row.is-dir');
      if (row) {
        if (S.dragging && S.dragging.names.includes(row.dataset.name)) return null;
        return { node: row, path: PP.join(S.cwd, row.dataset.name) };
      }
      const crumb = t.closest('.crumb');
      if (crumb && crumb.dataset.path !== S.cwd) return { node: crumb, path: crumb.dataset.path };
      const drive = t.closest('[data-drive]');
      if (drive && S.drives.some((d) => d.ok && d.label === drive.dataset.drive)) {
        const root = PP.root(drive.dataset.drive);
        if (root !== S.cwd) return { node: drive, path: root };
      }
      return null;
    };

    window.addEventListener('dragenter', (ev) => {
      if (!isFiles(ev) || !canDrop()) return;
      ev.preventDefault();
      depth++;
      el.dropOverlay.hidden = false;
    });
    window.addEventListener('dragleave', (ev) => {
      if (!isFiles(ev)) return;
      depth = Math.max(0, depth - 1);
      if (!depth) {
        el.dropOverlay.hidden = true;
        setHover(null);
      }
    });
    window.addEventListener('dragover', (ev) => {
      if (isFiles(ev)) {
        if (!canDrop()) return;
        ev.preventDefault();
        ev.dataTransfer.dropEffect = 'copy';
        const t = folderTarget(ev);
        setHover(t ? t.node : null);
        el.dropTarget.textContent = t ? t.path : S.cwd;
        return;
      }
      if (S.dragging) {
        const t = folderTarget(ev);
        setHover(t ? t.node : null);
        if (t) {
          ev.preventDefault();
          ev.dataTransfer.dropEffect = ev.ctrlKey || PP.drive(t.path) !== PP.drive(S.dragging.from) ? 'copy' : 'move';
        }
      }
    });
    window.addEventListener('drop', (ev) => {
      if (isFiles(ev)) {
        ev.preventDefault();
        depth = 0;
        el.dropOverlay.hidden = true;
        const t = folderTarget(ev);
        setHover(null);
        if (!canDrop()) return;
        const dest = t ? t.path : S.cwd;
        const collected = collectDropEntries(ev.dataTransfer);
        entriesToBatch(collected)
          .then((batch) => enqueueUploads(batch, dest))
          .catch((e) => {
            toast('Couldn’t read the dropped files: ' + e.message, 'error');
            log('error', 'Drop: ' + e.message);
          });
        return;
      }
      if (S.dragging) {
        const t = folderTarget(ev);
        setHover(null);
        if (!t) return;
        ev.preventDefault();
        const drag = S.dragging;
        S.dragging = null;
        const items = drag.names
          .map((n) => S.items.find((i) => i.name === n))
          .filter(Boolean)
          .map((it) => ({ path: PP.join(drag.from, it.name), name: it.name, isDir: it.isDir, size: it.size, meta: it.meta }));
        const move = !ev.ctrlKey;
        transferItems(items, move, t.path);
      }
    });

    el.list.addEventListener('dragstart', (ev) => {
      const row = ev.target.closest && ev.target.closest('.row');
      if (!row || S.conn !== 'on') return ev.preventDefault();
      const name = row.dataset.name;
      if (!S.sel.has(name)) {
        S.sel = new Set([name]);
        S.anchor = S.focus = name;
        renderSelection();
      }
      S.dragging = { from: S.cwd, names: selectedItems().map((i) => i.name) };
      ev.dataTransfer.effectAllowed = 'copyMove';
      ev.dataTransfer.setData('application/x-pixl-items', S.dragging.names.join('\n'));
    });
    el.list.addEventListener('dragend', () => {
      S.dragging = null;
      setHover(null);
    });
  }

  /* ------------------------------------------------------------------- init */

  function init() {
    applyTheme(store.get('theme', null));
    matchMedia('(prefers-color-scheme: dark)').addEventListener('change', () => applyTheme(document.documentElement.dataset.theme || null));
    el.verifyChk.checked = store.get('verify', true);
    bind();
    showSupportWarning();
    setConn('off');
    renderAll();
    log('info', P.BleTransport.supported() ? 'Ready. Web Bluetooth is available.' : 'Ready. Web Bluetooth is not available in this browser (demo still works).');
    if (params.has('demo')) connect(true);
  }

  // test hooks
  window.PixlApp = {
    S,
    J,
    logs,
    connect,
    navigate,
    refresh,
    enqueueUploads,
    transferItems,
    download,
    deleteItems,
    renameItem,
    get client() {
      return S.client;
    },
  };

  init();
})();
