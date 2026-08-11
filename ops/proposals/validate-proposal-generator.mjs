#!/usr/bin/env node
/* Nexora Proposal Generator validation (PROP.3).
   Verifies the generator is present and safe, that every committed synthetic
   fixture generates cleanly with no leftover template tokens, that milestone
   rounding is deterministic (total == Approved Final Project Price), that
   overwrite protection works, that outputs carry no unsupported VAT claim,
   and that generation FAILS CLOSED for every known invalid input.

   Temporary invalid fixtures are written under ops/proposals/private/.tmp-tests/
   (gitignored) and removed after the run. Generated test outputs go to
   ops/proposals/out/.tmp-tests/ (gitignored) and are removed too.

   Usage:  node ops/proposals/validate-proposal-generator.mjs
   exit 0 = all checks pass. Never touches Source of Truth. */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';
import {
  computeScheduleRows,
  safeOutputFilename,
  classifyInput,
  renderProposalDocument
} from './generate-proposal.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const proposalsDir = __dirname;
const root = path.join(__dirname, '..', '..');

const GENERATOR = path.join(proposalsDir, 'generate-proposal.mjs');
const EXAMPLES_DIR = path.join(proposalsDir, 'examples');
const PRIVATE_TMP = path.join(proposalsDir, 'private', '.tmp-tests');
const OUT_TMP = path.join(proposalsDir, 'out', '.tmp-tests');

const failures = [];
const pass = (l) => console.log(`  ok   ${l}`);
const fail = (l, d) => { failures.push(l); console.log(`  FAIL ${l}${d ? ' — ' + d : ''}`); };

const vatAssertions = [
  /\bVAT\s+registered\b/i, /\bregistered\s+for\s+VAT\b/i,
  /\b20\s*%\s*VAT\b/i, /\bVAT\s+at\s+\d+\s*%/i,
  /\bVAT\s+included\b/i, /\bVAT\s+excluded\b/i, /\bVAT\s+inclusive\b/i, /\bVAT\s+exclusive\b/i,
  /\btax\s+amount\b/i
];

const run = (args) => {
  try {
    const stdout = execFileSync(process.execPath, [GENERATOR, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
    return { status: 0, stdout };
  } catch (e) {
    return { status: typeof e.status === 'number' ? e.status : 1, stdout: String(e.stdout || '') + String(e.stderr || '') };
  }
};

const fixture = (name) => JSON.parse(fs.readFileSync(path.join(EXAMPLES_DIR, name), 'utf8'));
const genSource = fs.readFileSync(GENERATOR, 'utf8');

console.log('Validating proposal generator layer (PROP.3)…');

/* ---- 1 · static safety ---- */

if (fs.existsSync(GENERATOR)) pass('generator · file present');
else fail('generator · file present', 'generate-proposal.mjs missing');

const SHARED = path.join(proposalsDir, 'proposal-validation.mjs');
if (fs.existsSync(SHARED)) pass('generator · shared validation core present');
else fail('generator · shared validation core present', 'proposal-validation.mjs missing');

if (/£\s*\d/.test(genSource)) fail('generator · no hard-coded prices', 'generate-proposal.mjs must contain no literal £ amounts');
else pass('generator · no hard-coded prices');

for (const re of [/\bStarter\b/i, /\bElite\b/i, /£250/i, /\bbuy\.stripe\.com/i, /\bpaypal\.com/i, /\bAI\s+Care\b/i]) {
  if (re.test(genSource)) fail('generator · legacy content', `matched ${re}`);
}
if (!/(Starter|Elite|£250|buy\.stripe|paypal|AI Care)/i.test(genSource)) pass('generator · no legacy / obsolete commercial content');

const gitignore = fs.readFileSync(path.join(root, '.gitignore'), 'utf8');
if (gitignore.includes('ops/proposals/private/') && gitignore.includes('ops/proposals/out/')) pass('generator · output + private dirs git-ignored');
else fail('generator · output + private dirs git-ignored', 'ops/proposals/private/ and ops/proposals/out/ must both be ignored');

/* Every committed fixture must be a synthetic example. */
const exampleFiles = fs.readdirSync(EXAMPLES_DIR).filter((f) => f.endsWith('.json'));
if (exampleFiles.length === 0) fail('fixtures · found', 'no example fixtures');
for (const f of exampleFiles) {
  const data = JSON.parse(fs.readFileSync(path.join(EXAMPLES_DIR, f), 'utf8'));
  (data._example === true ? pass : fail)(`fixture · ${f} _example`);
}

/* ---- 2 · helper behaviour (naming, classification, rounding) ---- */

if (safeOutputFilename('PRP-2026-9001', '1.0') === 'PRP-2026-9001-v1.0.html') pass('naming · PRP-2026-9001-v1.0.html');
else fail('naming · safe filename', safeOutputFilename('PRP-2026-9001', '1.0'));
if (safeOutputFilename('PRP-2026-9001', '1.0') === safeOutputFilename('PRP-2026-9001', '1.0')) {
  pass('naming · deterministic for proposal_id + version');
}
if (!/[^A-Za-z0-9._-]/.test(safeOutputFilename('PRP-2026-9001', '1.0'))) pass('naming · sanitised (no unsafe chars)');
else fail('naming · sanitised', safeOutputFilename('PRP-2026-9001', '1.0'));

if (classifyInput(path.join(proposalsDir, 'private', 'PRP-2026-1001.json')) === 'PRIVATE') pass('input · private/ allowed');
else fail('input · private/ allowed', 'classifyInput PRIVATE failed');
if (classifyInput(path.join(EXAMPLES_DIR, 'sample-proposal.json')) === 'EXAMPLES') pass('input · examples/ classified');
else fail('input · examples/ classified', 'classifyInput EXAMPLES failed');
if (classifyInput(path.join(root, 'index.html')) === 'UNSAFE') pass('input · tracked/arbitrary path refused');
else fail('input · tracked/arbitrary path refused', 'classifyInput UNSAFE failed');

/* Milestone rounding: residual-to-last; total must equal the approved price exactly. */
const roundTest = computeScheduleRows(9999, [30, 30, 30, 10]);
const roundSum = roundTest.map((r) => Number(r.amount_display.replace(/[£,]/g, ''))).reduce((a, b) => a + b, 0);
if (roundSum === 9999 && roundTest.length === 4) pass('rounding · total equals Approved Final Project Price (residual-to-last)');
else fail('rounding · total', `sum ${roundSum} != 9999`);
if (roundTest[3].amount_display === '£999') pass('rounding · final tranche absorbs residual (£999)');
else fail('rounding · final tranche', roundTest[3].amount_display);
if (computeScheduleRows(5100, [40, 30, 30]).map((r) => r.amount_display).join('|') === '£2,040|£1,530|£1,530') {
  pass('rounding · B2 amounts from approved price (not reference)');
} else {
  fail('rounding · B2 amounts', 'milestone amounts must derive from the Approved Final Project Price');
}

/* ---- 3 · positive generation ---- */

const GENERATED = {};

for (const f of exampleFiles) {
  const data = fixture(f);
  const out = path.join(OUT_TMP, f.replace(/\.json$/, '.html'));
  const res = run([path.join(EXAMPLES_DIR, f), '--output', out, '--overwrite']);
  if (res.status !== 0) {
    fail(`generate · ${f}`, `exit ${res.status}\n${res.stdout}`);
    continue;
  }
  const html = fs.readFileSync(out, 'utf8');
  const leftover = (html.match(/\{\{[\s\S]*?\}\}/g) || []);
  if (leftover.length > 0) fail(`generate · ${f}`, `leftover tokens: ${leftover.join(', ')}`);
  else pass(`generate · ${f} · no leftover tokens`);
  if (!html.includes('Approved Final Project Price')) fail(`generate · ${f}`, 'missing Approved Final Project Price block');
  else pass(`generate · ${f} · approved price prominent`);
  if (!html.includes('Nexora Client Proposal')) fail(`generate · ${f}`, 'missing document identity');
  for (const re of vatAssertions) {
    if (re.test(html)) fail(`generate · ${f} · VAT assertion`, `unsupported tax claim: ${re}`);
  }
  GENERATED[data.offering.code] = html;
}

/* Per-offering content assertions (validated synthetic fixtures only). */
const b2 = GENERATED['B2'] || '';
const a2 = GENERATED['A2'] || '';
const complete = GENERATED['COMPLETE'] || '';
const b3 = GENERATED['B3'] || '';

(b2.includes('£5,100') ? pass : fail)('render · B2 shows Approved Final Project Price £5,100');
(b2.includes('From £4,250') ? pass : fail)('render · B2 shows reference From £4,250 (subordinate)');
(b2.includes('does not automatically equal') ? pass : fail)('render · B2 reference distinct from final');
(b2.includes('90-day Web Launch Warranty') ? pass : fail)('render · B2 warranty');
(!b2.includes('Starter') && !b2.includes('Elite') ? pass : fail)('render · B2 no legacy tiers');
(!b2.includes('VAT included') && !b2.includes('VAT registered') ? pass : fail)('render · B2 neutral VAT (no assertion)');

(a2.includes('£697') ? pass : fail)('render · A2 monthly £697');
(a2.includes('£997') ? pass : fail)('render · A2 setup/implementation fee £997');
(a2.includes('Go-Live') ? pass : fail)('render · A2 recurring starts at Go-Live');
(a2.includes('Web Care Plus') ? pass : fail)('render · A2 Care separate');
(!a2.includes('Reference / public starting price') ? pass : fail)('render · A2 hides invented reference price');

(complete.includes('£24,000') ? pass : fail)('render · COMPLETE approved £24,000');
(complete.includes('£7,200') ? pass : fail)('render · COMPLETE 30% tranche £7,200');
(complete.includes('£2,400') ? pass : fail)('render · COMPLETE 10% tranche £2,400');
(!complete.includes('Reference / public starting price') ? pass : fail)('render · COMPLETE no invented public reference price');
(complete.includes('Go-Live') ? pass : fail)('render · COMPLETE AI recurring at Go-Live');

(b3.includes('£9,600') ? pass : fail)('render · B3 approved £9,600');
(b3.includes('From £8,500') ? pass : fail)('render · B3 reference From £8,500');
(b3.includes('£3,840') ? pass : fail)('render · B3 bespoke 40% tranche £3,840');
(b3.includes('Web Care Plus') ? pass : fail)('render · B3 Care attached and separate');
(b3.includes('90-day Web Launch Warranty') ? pass : fail)('render · B3 warranty');

/* Audit metadata present and safe (basename only, no private paths). */
const b2Audit = b2.match(/<!--\n([\s\S]*?)\n-->/);
if (b2Audit && b2Audit[1].includes('Nexora Proposal Generator v1.0') && b2Audit[1].includes('PRP-2026-9001')) {
  pass('render · audit metadata present');
} else {
  fail('render · audit metadata', 'generator audit comment missing');
}
if (!/ops\/proposals\/private/.test(b2)) pass('render · no private path in client-facing output');
else fail('render · no private path in client-facing output');

/* ---- 4 · overwrite / immutability ---- */

const ovrPath = path.join(OUT_TMP, 'overwrite-test.html');
run(['--example', '--output', ovrPath, '--overwrite']);
const second = run(['--example', '--output', ovrPath]);
if (second.status !== 0) pass('overwrite · refuses silent replacement without --overwrite');
else fail('overwrite · refuses silent replacement', 'second generation unexpectedly succeeded');
const third = run(['--example', '--output', ovrPath, '--overwrite']);
if (third.status === 0) pass('overwrite · explicit --overwrite succeeds');
else fail('overwrite · explicit --overwrite succeeds', `exit ${third.status}`);

/* ---- 5 · negative tests — generation must FAIL CLOSED ---- */

fs.mkdirSync(PRIVATE_TMP, { recursive: true });
const base = fixture('sample-proposal.json');
const baseAI = fixture('sample-proposal-ai.json');
const baseComplete = fixture('sample-proposal-complete.json');
const baseB3 = fixture('sample-proposal-b3.json');

const negatives = [
  ['unknown offering', { ...base, offering: { ...base.offering, code: 'XX9', category: 'WEB' } }],
  ['stale reference price', { ...base, commercial_schedule: { ...base.commercial_schedule, reference_price: { from: 9999 } } }],
  ['invalid setup fee', { ...base, commercial_schedule: { ...base.commercial_schedule, setup_fee: 500 } }],
  ['invalid schedule', { ...base, commercial_schedule: { ...base.commercial_schedule, payment_schedule: [50, 50] } }],
  ['missing approved final price', (() => { const c = { ...base.commercial_schedule }; delete c.approved_final_project_price; return { ...base, commercial_schedule: c }; })()],
  ['invalid proposal validity', { ...base, valid_until: '2026-09-11' }],
  ['unsupported VAT assertion', { ...base, commercial_schedule: { ...base.commercial_schedule, vat: { status: 'INCLUDED', note: 'VAT included' } } }],
  ['legacy Starter tier', { ...base, assumptions: [...(base.assumptions || []), 'Legacy Starter package option'] }],
  ['legacy £250 deposit language', { ...base, assumptions: [...(base.assumptions || []), 'Pay £250 deposit to secure the project'] }],
  ['AI recurring before Go-Live', { ...baseAI, commercial_schedule: { ...baseAI.commercial_schedule, recurring_fees: { monthly_fee: 697, starts_at: 'ACCEPTANCE' } } }],
  ['Complete with invented reference price', { ...baseComplete, commercial_schedule: { ...baseComplete.commercial_schedule, reference_price: { from: 12000 } } }],
  ['B3 unrecorded bespoke schedule', { ...baseB3, commercial_schedule: { ...baseB3.commercial_schedule, payment_schedule: null } }]
];

for (let i = 0; i < negatives.length; i++) {
  const [name, data] = negatives[i];
  const file = path.join(PRIVATE_TMP, `neg-${String(i + 1).padStart(2, '0')}.json`);
  fs.writeFileSync(file, JSON.stringify(data, null, 2));
  const out = path.join(OUT_TMP, `neg-${String(i + 1).padStart(2, '0')}.html`);
  const res = run([file, '--output', out, '--overwrite']);
  if (res.status !== 0) pass(`negative · ${name} (refused)`);
  else fail(`negative · ${name}`, 'generation unexpectedly succeeded for invalid input');
}

/* ---- 6 · render via shared renderer (unit) has no leftover tokens ---- */

for (const f of exampleFiles) {
  const data = fixture(f);
  const html = renderProposalDocument(data, { sourceLabel: f });
  const leftover = (html.match(/\{\{[\s\S]*?\}\}/g) || []);
  (leftover.length === 0 ? pass : fail)(`render-unit · ${f} · no leftover tokens`);
}

/* ---- 7 · cleanup (gitignored temp dirs only) ---- */

fs.rmSync(PRIVATE_TMP, { recursive: true, force: true });
fs.rmSync(OUT_TMP, { recursive: true, force: true });

console.log(failures.length === 0 ? '\nALL GENERATOR CHECKS PASSED' : `\n${failures.length} GENERATOR CHECK(S) FAILED`);
process.exit(failures.length === 0 ? 0 : 1);
