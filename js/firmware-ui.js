/* Firmware update flow (UI). Protocol lives in dfu.js. */
(function (global) {
  'use strict';

  const Pixl = (global.Pixl = global.Pixl || {});
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  let busy = false;

  function open(ctx) {
    if (busy) return;
    busy = true;
    flow(ctx)
      .catch((e) => {
        ctx.log('error', 'Firmware update: ' + (e.message || e));
        ctx.toast('Firmware update: ' + (e.message || e), 'error');
      })
      .then(() => (busy = false));
  }

  function isDemo(ctx) {
    return !!ctx.S.demo || new URLSearchParams(location.search).has('demo');
  }

  async function choosePackage(ctx) {
    const { esc, icon } = ctx;
    const demo = isDemo(ctx);
    let pkg = null;
    let errEl;
    return ctx.modal({
      title: 'Update firmware',
      icon: 'chip',
      wide: true,
      body: `<p>Install new Pixl.js firmware over Bluetooth, using the same update method as the official tools.</p>
        <div class="field"><span>Firmware package</span>
          <div class="pick-row"><span class="pick-name" id="fwName">None chosen</span>
            <button type="button" class="btn sm" id="fwPick">${icon('file')}<span>Choose…</span></button>
            ${demo ? `<button type="button" class="btn sm" id="fwDemo">${icon('play')}<span>Demo package</span></button>` : ''}
          </div>
          <input type="file" id="fwFile" accept=".zip,application/zip" hidden></div>
        <p class="muted-line" id="fwInfo"></p>
        <div class="notice warn fw-warn"><b>Before you start</b><ul>
          <li>Use the <b>OTA package</b> (<code>pixjs_ota_vXXX.zip</code>) from the firmware download that matches your screen, <b>LCD</b> or <b>OLED</b>. The wrong one leaves the screen blank until you update again with the right one.</li>
          <li>Keep the Pixl.js close and charged, and keep this window open until the update finishes.</li>
          <li>If the update is interrupted, the old firmware keeps working. To try again, open <b>Settings → Firmware Update</b> on the device.</li>
        </ul></div>
        <div class="field-err" id="fwErr"></div>`,
      actions: [
        { label: 'Cancel', value: null },
        { label: 'Start update', kind: 'primary', submit: true, value: () => pkg },
      ],
      init(d) {
        const name = d.querySelector('#fwName');
        const info = d.querySelector('#fwInfo');
        const input = d.querySelector('#fwFile');
        errEl = d.querySelector('#fwErr');
        const show = (p) => {
          if (p.images.length > 1) {
            pkg = null;
            name.textContent = p.name;
            info.textContent = '';
            errEl.textContent = 'This package also updates the bootloader/SoftDevice, which this updater doesn’t handle. Use nRF Connect for this one.';
            return;
          }
          pkg = p;
          name.textContent = p.name;
          info.textContent = `${p.version ? 'Version ' + p.version + ' · ' : ''}${p.images.map((i) => i.type).join(' + ')} · ${ctx.fmtSize(p.size)}`;
          errEl.textContent = '';
        };
        d.querySelector('#fwPick').onclick = () => input.click();
        input.onchange = async () => {
          const f = input.files[0];
          input.value = '';
          if (!f) return;
          errEl.textContent = '';
          info.textContent = 'Reading the package…';
          try {
            show(await Pixl.dfu.loadPackage(f));
          } catch (e) {
            pkg = null;
            name.textContent = f.name;
            info.textContent = '';
            errEl.textContent = e.message;
          }
        };
        const demoBtn = d.querySelector('#fwDemo');
        if (demoBtn) demoBtn.onclick = () => show(Pixl.demoFirmwarePackage());
      },
      validate() {
        if (!pkg) {
          if (!errEl.textContent) errEl.textContent = 'Choose a firmware package first';
          return false;
        }
        return true;
      },
    });
  }

  /** A dialog that shows progress; returns controls. */
  function progressDialog(ctx, title) {
    const d = ctx.el.dlg;
    const { esc, icon } = ctx;
    let onCancel = null;
    d.classList.add('wide');
    d.innerHTML = `<form method="dialog"><div class="dlg-head"><div class="dlg-ic">${icon('chip')}</div><h2>${esc(title)}</h2></div>
      <div class="dlg-body"><p class="pg-text" id="pgText">Starting…</p>
      <div class="pg-bar"><i id="pgBar"></i></div><p class="muted-line" id="pgSub">&nbsp;</p></div>
      <div class="dlg-foot" id="pgFoot"><button type="button" class="btn" id="pgCancel">Cancel</button></div></form>`;
    d.oncancel = (ev) => ev.preventDefault();
    if (!d.open) d.showModal();
    const text = d.querySelector('#pgText');
    const bar = d.querySelector('#pgBar');
    const sub = d.querySelector('#pgSub');
    d.querySelector('#pgCancel').onclick = () => onCancel && onCancel();
    return {
      set(t, frac, s) {
        if (t != null) text.textContent = t;
        if (frac != null) bar.style.width = `${Math.max(0, Math.min(1, frac)) * 100}%`;
        if (s != null) sub.textContent = s || ' ';
      },
      onCancel(fn) {
        onCancel = fn;
      },
      close() {
        if (d.open) d.close();
      },
    };
  }

  async function flow(ctx) {
    const pkg = await choosePackage(ctx);
    if (!pkg) return;
    const demo = isDemo(ctx);
    const image = pkg.images[0];

    // 1. ask the running firmware to reboot into the bootloader
    if (ctx.connected) {
      const pg = progressDialog(ctx, 'Updating firmware');
      pg.set('Switching the Pixl.js to update mode…', 0.02, '');
      pg.onCancel(() => {});
      try {
        await ctx.client.enterDfu();
      } catch (e) {
        /* it may reboot before the reply arrives */
      }
      ctx.disconnectQuietly();
      await sleep(2500);
      pg.close();
    }

    for (;;) {
      const result = await attempt(ctx, pkg, image, demo);
      if (result === 'done' || result === 'cancel') return;
      // failed: offer to retry
      const again = await ctx.modal({
        title: 'Update didn’t finish',
        icon: 'alert',
        tone: 'danger',
        body: `<p>${ctx.esc(result)}</p>
          <p>Your old firmware is still installed; the device goes back to it about 20 seconds after the update stops.
          To try again, put it in update mode (<b>Settings → Firmware Update</b>) and click <b>Try again</b>.</p>`,
        actions: [
          { label: 'Close', value: null },
          { label: 'Try again', kind: 'primary', submit: true, value: true },
        ],
      });
      if (!again) return;
    }
  }

  /** One connect + transfer attempt. Returns 'done', 'cancel', or an error message. */
  async function attempt(ctx, pkg, image, demo) {
    const transport = demo ? new Pixl.MockDfuTransport({ latency: 1 }) : new Pixl.dfu.BleDfuTransport({ log: ctx.log });

    // 2. pick the "pixl dfu" device (needs a click for the browser's device chooser)
    let note = '';
    for (;;) {
      const picked = await ctx.modal({
        title: 'Connect to the Pixl.js in update mode',
        icon: 'bluetooth',
        body: `<p>The Pixl.js screen should now show that it’s in update mode. Click <b>Connect</b> and pick <b>pixl dfu</b>.</p>
          <p class="muted-line">Not showing up? On the device open <b>Settings → Firmware Update</b>, then try again.</p>
          ${note ? `<div class="field-err">${ctx.esc(note)}</div>` : ''}`,
        actions: [
          { label: 'Cancel', value: null },
          { label: 'Connect', kind: 'primary', submit: true, value: () => transport.pick().then(() => true, (e) => e) },
        ],
      });
      if (!picked) return 'cancel';
      const r = await picked;
      if (r === true) break;
      if (r && r.name === 'NotFoundError' && /cancel/i.test(r.message)) {
        note = '';
        continue;
      }
      note = (r && r.message) || String(r);
    }

    // 3. transfer
    const pg = progressDialog(ctx, `Updating firmware${pkg.version ? ' to ' + pkg.version : ''}`);
    let wake = null;
    try {
      if (navigator.wakeLock) wake = await navigator.wakeLock.request('screen');
    } catch (e) {
      wake = null;
    }
    const started = performance.now();
    const dfu = new Pixl.dfu.SecureDfu(transport, { log: ctx.log });
    let canceled = false;
    pg.onCancel(() => {
      canceled = true;
      dfu.abort();
    });
    try {
      pg.set('Connecting…', 0, '');
      await transport.connect();
      ctx.log('info', `Connected to ${transport.name}; sending ${pkg.name}`);
      pg.set('Sending firmware…', 0, '');
      await dfu.update(image, (sent, total) => {
        const secs = (performance.now() - started) / 1000;
        const rate = sent / Math.max(secs, 0.1);
        const left = rate > 0 ? Math.round((total - sent) / rate) : 0;
        pg.set(
          `Sending firmware… ${Math.floor((sent / total) * 100)}%`,
          sent / total,
          `${ctx.fmtSize(sent)} of ${ctx.fmtSize(total)} · ${ctx.fmtSize(Math.round(rate))}/s${left > 1 ? ` · about ${left < 60 ? left + ' s' : Math.round(left / 60) + ' min'} left` : ''}`
        );
      });
      pg.set('Finishing: the device is checking and installing the update…', 1, '');
      await sleep(1500);
      try {
        transport.disconnect();
      } catch (e) {
        /* already gone */
      }
      pg.close();
      ctx.log('ok', `Firmware update ${pkg.version ? 'to ' + pkg.version + ' ' : ''}finished`);
      const reconnect = await ctx.modal({
        title: 'Firmware updated',
        icon: 'check',
        body: `<p>The Pixl.js is restarting${pkg.version ? ' with firmware <b>' + ctx.esc(pkg.version) + '</b>' : ''}. When it’s back, open <b>BLE File Transfer</b> on it and reconnect.</p>`,
        actions: [
          { label: 'Close', value: null },
          { label: 'Reconnect', kind: 'primary', submit: true, value: true },
        ],
      });
      if (reconnect) ctx.connect(demo);
      return 'done';
    } catch (e) {
      pg.close();
      try {
        transport.disconnect();
      } catch (_) {
        /* ignore */
      }
      if (canceled || e.code === 'ABORTED') {
        ctx.log('warn', 'Firmware update canceled');
        ctx.toast('Update canceled. The old firmware stays installed.', 'info');
        return 'cancel';
      }
      ctx.log('error', 'Firmware update failed: ' + e.message);
      return e.message;
    } finally {
      if (wake) wake.release().catch(() => {});
    }
  }

  Pixl.firmwareUI = { open };
})(typeof window !== 'undefined' ? window : globalThis);
