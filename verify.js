#!/usr/bin/env node
/**
 * verify.js — baseline guard + byte comparison (A4).
 *
 * 1) Re-checks root index.html SHA-256 against the value pinned in BASELINE.md.
 *    Aborts if the baseline has drifted.
 * 2) Compares dist/index.html against root index.html and reports byte equality,
 *    or the first differing byte (offset + line/column) if not equal.
 */
'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const ROOT = path.resolve(__dirname);
const LIVE = path.join(ROOT, 'index.html');
const GENERATED = path.join(ROOT, 'dist', 'index.html');
const BASELINE_FILE = path.join(ROOT, 'BASELINE.md');

function fail(msg) {
  console.error('[verify.js] ERROR: ' + msg);
  process.exit(1);
}

const sha = p => crypto.createHash('sha256').update(fs.readFileSync(p)).digest('hex');

/* ---- 1) baseline guard ---- */
if (!fs.existsSync(BASELINE_FILE)) fail('BASELINE.md missing');
const bm = fs.readFileSync(BASELINE_FILE, 'utf8');
const m = bm.match(/SHA-256 of root `index\.html`:\*\* `([0-9a-f]{64})`/);
if (!m) fail('cannot read pinned baseline SHA-256 from BASELINE.md');
const pinned = m[1];

if (!fs.existsSync(LIVE)) fail('root index.html missing');
const liveSha = sha(LIVE);

if (liveSha !== pinned) {
  fail('BASELINE DRIFT — root index.html changed since it was pinned.\n'
    + '  pinned:  ' + pinned + '\n'
    + '  actual:  ' + liveSha);
}
console.log('[verify.js] baseline OK  root index.html SHA-256 = ' + liveSha);

/* ---- 2) byte comparison ---- */
if (!fs.existsSync(GENERATED)) fail('dist/index.html not found — run build.js first');

const a = fs.readFileSync(LIVE);
const b = fs.readFileSync(GENERATED);
const genSha = crypto.createHash('sha256').update(b).digest('hex');
console.log('[verify.js] generated SHA-256 = ' + genSha);

if (a.length === b.length && a.equals(b)) {
  console.log('[verify.js] RESULT: PASS — dist/index.html is byte-identical to root index.html');
  process.exit(0);
}

// find first differing byte
const n = Math.min(a.length, b.length);
let off = n;
for (let i = 0; i < n; i++) {
  if (a[i] !== b[i]) { off = i; break; }
}
const line = a.slice(0, off).filter(x => x === 0x0a).length + 1;
const lastNl = a.lastIndexOf(0x0a, off - 1);
const col = lastNl === -1 ? off + 1 : off - lastNl;

console.log('[verify.js] RESULT: FAIL — bytes differ');
console.log('  live length:      ' + a.length);
console.log('  generated length: ' + b.length);
console.log('  first differing byte at offset ' + off + ' (~line ' + line + ', col ' + col + ')');
process.exit(1);
