/*
 * Visual helpers for amiibo: series/game emblems and badges (color-coded, since
 * official logos aren't freely available), placeholder figure art, and the
 * right-hand info panel. Pure HTML builders.
 */
(function (global) {
  'use strict';

  const Pixl = (global.Pixl = global.Pixl || {});
  const ESC = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
  const esc = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ESC[c]);
  const icon = (name, cls) => `<svg class="ic ${cls || ''}" aria-hidden="true"><use href="#i-${name}"/></svg>`;

  function hue(s) {
    let h = 7;
    for (const ch of String(s || '')) h = (h * 31 + ch.codePointAt(0)) >>> 0;
    return h % 360;
  }

  const SMALL = /^(the|of|and|a|an|de|la|le|el|y|no)$/i;
  function initials(s) {
    const words = String(s || '')
      .replace(/[^\p{L}\p{N}]+/gu, ' ')
      .split(' ')
      .filter((w) => w && !SMALL.test(w));
    if (!words.length) return '?';
    if (words.length === 1) return words[0].slice(0, 2).toUpperCase();
    return words
      .slice(0, 3)
      .map((w) => (/^\d/.test(w) ? w : w[0]))
      .join('')
      .slice(0, 3)
      .toUpperCase();
  }

  /** A small color-coded monogram that stands in for a series or game logo. */
  function emblem(name, cls) {
    if (!name) return '';
    return `<span class="emblem ${cls || ''}" style="--h:${hue(name)}" aria-hidden="true">${esc(initials(name))}</span>`;
  }

  function badge(name, label) {
    if (!name) return '';
    return `<span class="sbadge" style="--h:${hue(name)}" title="${esc(label ? label + ': ' + name : name)}">${emblem(name, 'xs')}<span>${esc(name)}</span></span>`;
  }

  /** Original placeholder art: a figure on a stand, or a card. */
  function placeholder(type, h) {
    const style = h != null ? ` style="--h:${h}"` : '';
    if (/card/i.test(type || '')) {
      return `<svg class="ph" viewBox="0 0 120 120"${style} aria-hidden="true">
        <rect x="30" y="14" width="60" height="92" rx="8" class="ph-card"/>
        <circle cx="60" cy="50" r="16" class="ph-fig"/>
        <rect x="42" y="76" width="36" height="5" rx="2.5" class="ph-fig"/>
        <rect x="48" y="86" width="24" height="5" rx="2.5" class="ph-fig"/>
        <text x="60" y="56" class="ph-q">?</text></svg>`;
    }
    return `<svg class="ph" viewBox="0 0 120 120"${style} aria-hidden="true">
      <ellipse cx="60" cy="104" rx="38" ry="9" class="ph-side"/>
      <path d="M22 98v6a38 9 0 0 0 76 0v-6" class="ph-side"/>
      <ellipse cx="60" cy="98" rx="38" ry="9" class="ph-top"/>
      <circle cx="60" cy="36" r="15" class="ph-fig"/>
      <path d="M38 94c0-19 9-38 22-38s22 19 22 38z" class="ph-fig"/>
      <text x="60" y="42" class="ph-q">?</text></svg>`;
  }

  /**
   * Picture of an amiibo with the placeholder underneath until the image loads
   * (or for good, if there is no image).
   */
  function art(info, opts) {
    opts = opts || {};
    const h = info && (info.series || info.game) ? hue(info.series || info.game) : null;
    const ph = placeholder(info && info.type, h);
    const img =
      info && info.image && opts.online !== false
        ? `<img src="${esc(info.image)}" alt="" loading="lazy" decoding="async" referrerpolicy="no-referrer"
            onload="this.parentNode.classList.add('loaded')" onerror="this.remove()">`
        : '';
    return `<span class="art ${opts.cls || ''}">${ph}${img}</span>`;
  }

  const REGIONS = [
    ['na', 'North America'],
    ['eu', 'Europe'],
    ['jp', 'Japan'],
    ['au', 'Australia'],
  ];
  function fmtDate(s) {
    if (!s) return '';
    const d = new Date(s + 'T00:00:00');
    return isNaN(d) ? s : d.toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' });
  }
  function releaseHtml(rel) {
    if (!rel) return '';
    const rows = REGIONS.filter(([k]) => rel[k]).map(([k, label]) => `<span class="rel"><b>${k.toUpperCase()}</b> ${esc(fmtDate(rel[k]))}</span>`);
    if (!rows.length) return '';
    return rows.join('');
  }
  function firstRelease(rel) {
    if (!rel) return null;
    const dates = REGIONS.map(([k]) => rel[k]).filter(Boolean).sort();
    return dates[0] || null;
  }

  function gamesHtml(list) {
    if (list == null) return '<p class="ip-muted">Loading the game list…</p>';
    if (!list.length) return '<p class="ip-muted">No games are listed for this amiibo yet.</p>';
    const writers = list.filter((g) => g.writes).length;
    const groups = {};
    list.forEach((g) => (groups[g.platform] = groups[g.platform] || []).push(g));
    const order = ['Switch 2', 'Switch', 'Wii U', '3DS'];
    let html = writers
      ? `<p class="ip-note">${icon('alert')}<span>${writers} game${writers === 1 ? '' : 's'} save data onto this amiibo, so the copy on your Pixl.js can change when you play.</span></p>`
      : '';
    order
      .filter((p) => groups[p])
      .forEach((p, i) => {
        const items = groups[p]
          .map(
            (g) => `<li><div class="g-name">${esc(g.game)}${g.writes ? '<span class="chip warn" title="This game writes data to the amiibo">Saves data</span>' : ''}</div>
            ${g.usage ? `<div class="g-use">${esc(g.usage)}</div>` : ''}</li>`
          )
          .join('');
        html += `<details class="g-group" ${i === 0 ? 'open' : ''}><summary><span class="plat">${esc(p)}</span><span class="g-count">${groups[p].length}</span></summary><ul>${items}</ul></details>`;
      });
    return html;
  }

  /**
   * @param m model:
   *   { kind: 'amiibo', id, info, file?: { name, path, size, notes, hidden, readonly }, source, actions }
   *   { kind: 'file' | 'folder', file, actions }
   *   { kind: 'multi', count, size, thumbs: [info], amiibo }
   *   { kind: 'overview', title, path, items, amiibo, series: [[name, count]] }
   *   { kind: 'empty', title, text }
   * @param o { online, fmtSize }
   */
  function panelHtml(m, o) {
    o = o || {};
    const fmtSize = o.fmtSize || ((n) => n + ' B');
    const acts = (list) =>
      list && list.length
        ? `<div class="ip-actions">${list
            .map((a) => `<button class="btn sm ${a.kind || ''}" data-ip-act="${esc(a.act)}" ${a.disabled ? 'disabled' : ''}>${icon(a.icon)}<span>${esc(a.label)}</span></button>`)
            .join('')}</div>`
        : '';
    const fileRows = (f) =>
      f
        ? `<dl class="ip-kv">
          <dt>File</dt><dd class="wrap">${esc(f.name)}</dd>
          ${f.path ? `<dt>Location</dt><dd class="wrap">${esc(f.path)}</dd>` : ''}
          ${f.size != null ? `<dt>Size</dt><dd>${fmtSize(f.size)}</dd>` : ''}
          ${f.notes ? `<dt>Notes</dt><dd class="wrap">${esc(f.notes)}</dd>` : ''}
          ${f.hidden ? '<dt>Hidden</dt><dd>Yes, on the device’s amiibo list</dd>' : ''}
          ${f.status ? `<dt>Status</dt><dd>${f.status}</dd>` : ''}
        </dl>`
        : '';

    if (m.kind === 'amiibo') {
      const info = m.info || {};
      const h = hue(info.series || info.game || 'amiibo');
      const title = info.name || 'Unknown amiibo';
      const first = firstRelease(info.release);
      return `<div class="ip-hero" style="--h:${h}">${art(info, { online: o.online, cls: 'xl' })}</div>
        <div class="ip-body">
          <h2 class="ip-title">${esc(title)}</h2>
          ${info.character && info.character !== title ? `<div class="ip-sub">${esc(info.character)}</div>` : ''}
          ${!info.known ? '<div class="ip-sub">Not in the amiibo list yet (new release or custom dump)</div>' : ''}
          <div class="ip-badges">${badge(info.series, 'Amiibo series')}${info.game && info.game !== info.series ? badge(info.game, 'Game') : ''}${
            info.type ? `<span class="chip">${esc(info.type)}</span>` : ''
          }</div>
          <dl class="ip-kv">
            ${info.series ? `<dt>Series</dt><dd>${esc(info.series)}</dd>` : ''}
            ${info.game ? `<dt>Game</dt><dd>${esc(info.game)}</dd>` : ''}
            ${info.character ? `<dt>Character</dt><dd>${esc(info.character)}</dd>` : ''}
            ${first ? `<dt>Released</dt><dd>${esc(fmtDate(first))}<div class="rels">${releaseHtml(info.release)}</div></dd>` : ''}
            <dt>Amiibo ID</dt><dd class="mono">${esc(Pixl.amiibo ? Pixl.amiibo.prettyId(m.id) : m.id)}</dd>
          </dl>
          ${acts(m.actions)}
          ${m.file ? `<div class="ip-section"><div class="ip-h">${m.source === 'library' ? 'In your library' : 'On the Pixl.js'}</div>${fileRows(m.file)}</div>` : ''}
          <div class="ip-section"><div class="ip-h">Works with</div><div class="ip-games" data-games-for="${esc(m.id)}">${gamesHtml(m.games)}</div></div>
        </div>`;
    }
    if (m.kind === 'file' || m.kind === 'folder') {
      return `<div class="ip-hero plain"><span class="art xl">${icon(m.kind === 'folder' ? 'folder' : 'file', 'ip-big-ic')}</span></div>
        <div class="ip-body"><h2 class="ip-title">${esc(m.file.name)}</h2>
        <div class="ip-sub">${m.kind === 'folder' ? 'Folder' : m.file.tagKind || 'File'}</div>
        ${fileRows(Object.assign({}, m.file, { name: null }))}${acts(m.actions)}</div>`;
    }
    if (m.kind === 'multi') {
      const thumbs = (m.thumbs || [])
        .slice(0, 12)
        .map((info) => (info ? art(info, { online: o.online, cls: 'sm' }) : `<span class="art sm">${placeholder()}</span>`))
        .join('');
      return `<div class="ip-body"><h2 class="ip-title">${m.count} selected</h2>
        <div class="ip-sub">${m.amiibo ? `${m.amiibo} amiibo · ` : ''}${fmtSize(m.size || 0)}</div>
        ${thumbs ? `<div class="ip-mosaic">${thumbs}</div>` : ''}${acts(m.actions)}</div>`;
    }
    if (m.kind === 'overview') {
      const series = (m.series || [])
        .map(([name, n]) => `<li>${emblem(name, 'sm')}<span class="s-name">${esc(name)}</span><span class="s-n">${n}</span></li>`)
        .join('');
      return `<div class="ip-body"><h2 class="ip-title">${esc(m.title)}</h2>
        ${m.path ? `<div class="ip-sub">${esc(m.path)}</div>` : ''}
        <dl class="ip-kv"><dt>Items</dt><dd>${m.items}</dd><dt>Amiibo</dt><dd>${m.amiibo}</dd></dl>
        ${series ? `<div class="ip-section"><div class="ip-h">By series</div><ul class="ip-series">${series}</ul></div>` : ''}
        <p class="ip-muted">Select an amiibo to see its picture, release dates and the games it works with.</p>${acts(m.actions)}</div>`;
    }
    return `<div class="ip-body ip-empty">${placeholder()}<h2 class="ip-title">${esc(m.title || 'Nothing selected')}</h2><p class="ip-muted">${esc(m.text || '')}</p></div>`;
  }

  Pixl.amiiboUI = { hue, initials, emblem, badge, placeholder, art, panelHtml, gamesHtml, fmtDate, firstRelease };
})(typeof window !== 'undefined' ? window : globalThis);
