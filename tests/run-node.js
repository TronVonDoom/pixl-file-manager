#!/usr/bin/env node
/* Runs the test suite in Node: `node tests/run-node.js` (exit code 1 on failure). */
'use strict';

const fs = require('fs');
const path = require('path');
const vm = require('vm');

globalThis.window = globalThis;
const root = path.join(__dirname, '..');
const load = (rel) => vm.runInThisContext(fs.readFileSync(path.join(root, rel), 'utf8'), { filename: rel });

['js/protocol.js', 'js/mock-device.js', 'js/zip.js', 'js/unzip.js', 'js/amiibo.js', 'js/organize.js', 'js/dfu.js', 'js/mock-dfu.js', 'js/sync.js', 'tests/harness.js', 'tests/suite.js'].forEach(load);

const green = (s) => `\x1b[32m${s}\x1b[0m`;
const red = (s) => `\x1b[31m${s}\x1b[0m`;

globalThis.T.run((r) => {
  if (r.ok) console.log(`${green('✓')} ${r.name} ${r.ms > 500 ? `(${r.ms} ms)` : ''}`);
  else console.log(`${red('✗')} ${r.name}\n    ${r.error.split('\n').slice(0, 4).join('\n    ')}`);
}).then((s) => {
  console.log(`\n${s.failed ? red(`${s.failed} failed`) : green('all passed')} · ${s.passed}/${s.total} in ${(s.ms / 1000).toFixed(1)} s`);
  process.exit(s.failed ? 1 : 0);
});
