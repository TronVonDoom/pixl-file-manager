/*
 * Where amiibo files belong: <root>/<Series or Game>/<Amiibo name>.bin
 * Shared by "Organize" (tidy files already on the device), library "Send" and
 * "Save to library". Pure logic, no UI.
 */
(function (global) {
  'use strict';

  const Pixl = (global.Pixl = global.Pixl || {});

  /** Safe file/folder name. forPc: also drop trailing dots, which Windows doesn't allow. */
  function clean(s, forPc) {
    let out = String(s == null ? '' : s)
      .replace(/[\\/:*?"<>|\x00-\x1f]/g, ' ')
      .replace(/\s+/g, ' ')
      .trim();
    if (forPc) out = out.replace(/[. ]+$/, '');
    return out || 'Unnamed';
  }

  /**
   * @param info   amiibo info from AmiiboDb.lookup (or null)
   * @param opts   { group: 'series' | 'game' | 'none', naming: 'name' | 'keep', pc: true when writing to a PC folder }
   * @param currentName  file name to keep when naming is 'keep' or the name is unknown
   */
  function targetFor(info, opts, currentName) {
    opts = opts || {};
    const group = opts.group || 'series';
    let folder = '';
    if (group === 'series') folder = clean((info && info.series) || 'Other amiibo', opts.pc);
    else if (group === 'game') folder = clean((info && info.game) || 'Other amiibo', opts.pc);
    if (folder) folder = Pixl.path.fit(folder, 30);
    let name = currentName || 'amiibo.bin';
    if (opts.naming !== 'keep' && info && info.name) name = clean(info.name, opts.pc) + '.bin';
    else if (!/\.bin$/i.test(name)) name = name.replace(/\.[^.]*$/, '') + '.bin';
    return { folder, name };
  }

  /** "Mario (2).bin" is an acceptable spelling of "Mario.bin" (a numbered duplicate). */
  function isVariantOf(current, wanted) {
    const strip = (n) => n.replace(/\.[^.]*$/, '');
    const base = strip(wanted).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    return new RegExp(`^${base}( \\(\\d+\\))?$`, 'i').test(strip(current)) && /\.bin$/i.test(current);
  }

  /**
   * Decides where each item goes.
   * @param items    [{ path?, name, id, info }]  path = current device path (for organize), absent for new files
   * @param occupied iterable of paths that already exist (every existing file, including the items themselves)
   * @param root     e.g. "E:/amiibo"
   * @returns { moves: [{ item, to }], inPlace: [item], unknown: [item] }
   */
  function place(items, occupied, root, opts) {
    const PP = Pixl.path;
    const taken = new Set();
    for (const p of occupied) taken.add(p.toLowerCase());
    const moves = [];
    const inPlace = [];
    const unknown = [];
    for (const it of items) {
      if (!it.info || !it.id) {
        unknown.push(it);
        continue;
      }
      const current = it.path ? PP.basename(it.path) : it.name;
      const t = targetFor(it.info, opts, current);
      const dir = t.folder ? PP.join(root, t.folder) : root;
      if (it.path && PP.parent(it.path) === dir && (it.path === PP.join(dir, t.name) || isVariantOf(current, t.name))) {
        inPlace.push(it);
        continue;
      }
      const budget = PP.nameBudget(dir);
      if (budget < 6) {
        unknown.push(it);
        continue;
      }
      const name = PP.unique(t.name, budget, (n) => taken.has(PP.join(dir, n).toLowerCase()));
      const to = PP.join(dir, name);
      taken.add(to.toLowerCase());
      moves.push({ item: it, to });
    }
    return { moves, inPlace, unknown };
  }

  Pixl.organize = { clean, targetFor, place, isVariantOf };
})(typeof window !== 'undefined' ? window : globalThis);
