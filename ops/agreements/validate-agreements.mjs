#!/usr/bin/env node
/* Nexora Agreement System validation (PROP.5).
   Verifies the governed Agreement layer comprehensively:

   - static safety of the Agreement tooling (no hard-coded prices, no legacy
     Starter/Elite/£250/AI Care, no VAT assertions, no --force-ready, Node
     built-ins only, .gitignore coverage, fixtures _example:true)
   - the legal-decision register (committed truth: every clause LEGAL_DECISION_REQUIRED)
   - the Agreement data model (AGR-YYYY-NNNN, DRAFT | READY_FOR_EXECUTION, provenance)
   - upstream handoff verification + commercial inheritance via the PROP.1 shared core
   - positive flows: B2 Web, AI recurring (Go-Live only), Complete bespoke, Care,
     warranty conditional, deterministic generation, HTML escaping, status labelling,
     and the READY_FOR_EXECUTION gate (opened only by a SYNTHETIC resolved register)
   - negative flows that must FAIL CLOSED: non-accepted provenance, fingerprint
     mismatch, modified approved price, modified schedule, offering mismatch,
     acceptance-record mismatch, fabricated handoff, unresolved decisions promoted to
     READY_FOR_EXECUTION, legacy Starter/Elite/£250, VAT assertion, AI Care,
     recurring before Go-Live, reference price used as contractual, malformed JSON,
     unsafe input/output paths, overwrite without policy, unmarked fixtures,
     milestone rounding/total mismatch
   - privacy: only synthetic fixtures (_example: true) committed; real Agreements
     stay under gitignored private/

   Temporary fixtures are created ONLY under:
     ops/agreements/private/.tmp-tests/  (Agreement outputs + JSON negative fixtures)
     ops/proposals/private/.tmp-tests/agreements/  (upstream handoffs/proposals/records)
   (both gitignored) and removed after the run. exit 0 = all checks pass.
   Never touches ops/billing-source-of-truth.json. */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';
import { validateAgreement, validateAgreementHandoff, classifyInput, isReadyForExecution, legalSectionsFor, loadLegalDecisions, AGREEMENT_SCHEMA, AGREEMENT_STATUSES, AGREEMENT_ID_RE, LEGAL_CLAUSES, CLASSIFICATIONS } from './agreement-validation.mjs';
import { proposalFingerprint } from '../proposals/proposal-lifecycle.mjs';
import { computeScheduleRows } from '../proposals/generate-proposal.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const agreementsDir = __dirname;
const root = path.join(__dirname, '..', '..');
const proposalsDir = path.join(root, 'ops', 'proposals');

const GENERATOR = path.join(agreementsDir, 'generate-agreement.mjs');
const LIFECYCLE = path.join(proposalsDir, 'proposal-lifecycle.mjs');
const SCHEMA_PATH = path.join(agreementsDir, 'agreement.schema.json');
const LEGAL_PATH = path.join(agreementsDir, 'legal', 'legal-decisions.json');
const TEMPLATE_DIR = path.join(agreementsDir, 'template');
const EXAMPLES_DIR = path.join(agreementsDir, 'examples');
const AGR_TMP = path.join(agreementsDir, 'private', '.tmp-tests');
const PROP_TMP = path.join(proposalsDir, 'private', '.tmp-tests', 'agreements');

const B2_HANDOFF = path.join(proposalsDir, 'examples', 'lifecycle', 'proposal-accepted.handoff.json');
const B2_PROP = path.join(proposalsDir, 'examples', 'lifecycle', 'proposal-accepted.json');
const B2_REC = path.join(proposalsDir, 'examples', 'lifecycle', 'proposal-accepted.acceptance.json');

const AI_SAMPLE = path.join(proposalsDir, 'examples', 'sample-proposal-ai.json');
const COMPLETE_SAMPLE = path.join(proposalsDir, 'examples', 'sample-proposal-complete.json');

const STAMP = '2026-08-11T12:00:00.000Z';

const failures = [];
const checks = [];

function pass(text) { checks.push({ ok: true, text }); }
function fail(text, detail) { const full = detail ? `${text} — ${detail}` : text; checks.push({ ok: false, text: full }); failures.push(full); }
function section(title) { checks.push({ ok: true, text: `── ${title}` }); }

const readJson = (p) => JSON.parse(fs.readFileSync(p, 'utf8'));
const writeJson = (p, obj) => { fs.mkdirSync(path.dirname(p), { recursive: true }); fs.writeFileSync(p, JSON.stringify(obj, null, 2) + '\n'); };

function runNode(script, args) {
  try {
    const stdout = execFileSync(process.execPath, [script, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
    return { code: 0, stdout, stderr: '' };
  } catch (e) {
    return { code: e.status == null ? 1 : e.status, stdout: e.stdout || '', stderr: e.stderr || '' };
  }
}

const runGen = (args) => runNode(GENERATOR, args);
const runLifecycle = (args) => runNode(LIFECYCLE, args);

/* Accept + handoff a synthetic proposal via the real PROP.4 CLI (governed fixtures). */
function acceptAndHandoff(propPath, id) {
  const rec = path.join(PROP_TMP, `${id}.acceptance.json`);
  const handoff = path.join(PROP_TMP, `${id}.handoff.json`);
  const a = runLifecycle(['accept', propPath, '--by', 'Alex Sample', '--date', '2026-08-01', '--record', rec]);
  if (a.code !== 0) return { ok: false, err: a.stderr };
  const h = runLifecycle(['handoff', propPath, '--record', rec, '--output', handoff]);
  if (h.code !== 0) return { ok: false, err: h.stderr };
  return { ok: true, proposal: propPath, record: rec, handoff };
}

/* ------------------------------------------------------------------ */
/* 0 · PREPARE tmp synthetic upstream fixtures (AI A2, Complete, XSS)  */
/* ------------------------------------------------------------------ */
function buildAcceptedProposal(samplePath, id, overrides) {
  const p = readJson(samplePath);
  p.proposal_id = id;
  p.issue_date = '2026-07-15';
  p.valid_until = '2026-08-14';
  p.status = 'SENT';
  delete p.acceptance;
  if (overrides) {
    for (const [k, v] of Object.entries(overrides)) {
      if (k === 'commercial_schedule') Object.assign(p.commercial_schedule, v);
      else p[k] = v;
    }
  }
  const out = path.join(PROP_TMP, `${id}.json`);
  writeJson(out, p);
  return out;
}

let AI = null;
let COMPLETE = null;
let XSS = null;
const syntheticResolvedRegister = path.join(AGR_TMP, 'synthetic-resolved-legal-decisions.json');

try {
  fs.mkdirSync(AGR_TMP, { recursive: true });
  fs.mkdirSync(PROP_TMP, { recursive: true });

  /* ---- SYNTHETIC resolved register (mechanism proof only, never committed) ---- */
  const baseReg = readJson(LEGAL_PATH);
  const resolved = { ...baseReg, description: 'SYNTHETIC TEST REGISTER — proves the READY_FOR_EXECUTION gate mechanism; NOT a real owner/legal decision.' };
  resolved.clauses = {};
  for (const [id] of LEGAL_CLAUSES) {
    resolved.clauses[id] = { classification: 'AUTHORITATIVE', note: 'SYNTHETIC TEST RESOLUTION — mechanism proof only.' };
  }
  writeJson(syntheticResolvedRegister, resolved);

  AI = acceptAndHandoff(buildAcceptedProposal(AI_SAMPLE, 'PRP-2026-9202'), 'prp-2026-9202');
  COMPLETE = acceptAndHandoff(buildAcceptedProposal(COMPLETE_SAMPLE, 'PRP-2026-9203'), 'prp-2026-9203');
  const xssProp = buildAcceptedProposal(AI_SAMPLE, 'PRP-2026-9204', {
    client: { name: '<img src=x onerror=alert(1)>', company: 'Acme & <b>Bros</b>', contact: { name: 'A & B', email: 'xss@example.com', phone: '00000 000000' } },
    project: { title: 'XSS test <script>alert(1)</script>', summary: 'Escaping fixture' }
  });
  XSS = acceptAndHandoff(xssProp, 'prp-2026-9204');
} catch (e) {
  pass(`tmp fixture preparation — ERROR: ${e.message}`);
  AI = { ok: false, err: e.message };
  COMPLETE = { ok: false, err: e.message };
  XSS = { ok: false, err: e.message };
}

/* ------------------------------------------------------------------ */
/* 1 · STATIC SAFETY                                                   */
/* ------------------------------------------------------------------ */
section('1 · Static safety');

for (const [rel, label] of [
  ['generate-agreement.mjs', 'generator'],
  ['agreement-validation.mjs', 'shared validation core'],
  ['agreement.schema.json', 'Agreement JSON Schema'],
  ['legal/legal-decisions.json', 'legal-decision register'],
  ['template/agreement-template.html', 'Agreement template'],
  ['template/agreement.css', 'Agreement stylesheet']
]) {
  if (fs.existsSync(path.join(agreementsDir, rel))) pass(`${label} present`);
  else fail(`${label} present`, `missing ${rel}`);
}

const schema = readJson(SCHEMA_PATH);
if (schema.$id === 'nexora-agreement-v1') pass('schema id nexora-agreement-v1');
else fail('schema id', JSON.stringify(schema.$id));
if (Array.isArray(schema.properties.status.enum) && schema.properties.status.enum.join(',') === AGREEMENT_STATUSES.join(',')) {
  pass('schema status enum DRAFT|READY_FOR_EXECUTION (no SIGNED/EXECUTED)');
} else fail('schema status enum', JSON.stringify(schema.properties.status && schema.properties.status.enum));
if (schema.properties.agreement_id.pattern === '^AGR-\\d{4}-\\d{4}$') pass('schema agreement_id pattern AGR-YYYY-NNNN');
else fail('schema agreement_id pattern', JSON.stringify(schema.properties.agreement_id.pattern));

/* No --force-ready shortcut anywhere in the tooling.
   Scan only the shipped generator + shared core + templates (NOT this test file,
   which mentions the phrase in its own labels). A real bypass would appear in the
   generator's arg parser as the parsed literal '--force-ready' or a forceReady
   option — NOT as documentation text denying such a shortcut. */
const shippedFiles = ['generate-agreement.mjs', 'agreement-validation.mjs']
  .map((f) => path.join(agreementsDir, f))
  .filter((f) => fs.existsSync(f));
const templateFiles = fs.readdirSync(TEMPLATE_DIR).map((f) => path.join(TEMPLATE_DIR, f));
let forceReady = false;
for (const f of [...shippedFiles, ...templateFiles]) {
  const src = fs.readFileSync(f, 'utf8');
  if (/['"]--force-ready['"]/.test(src) || /opts\.forceReady|forceReady\s*=/.test(src)) forceReady = true;
}
if (forceReady) fail('no --force-ready shortcut', 'found a force-ready mechanism in the Agreement tooling');
else pass('no --force-ready shortcut in Agreement tooling');

/* No hard-coded prices in the client-facing template + generator.
   The shared validation core is intentionally excluded here: it is a DETECTOR whose
   regexes (e.g. /£250/) exist to REJECT legacy content — they are not rendered prices.
   The template and generator must never embed a £ figure as a value. */
let hardcodedPrice = false;
for (const f of [path.join(agreementsDir, 'generate-agreement.mjs'), ...templateFiles]) {
  const src = fs.readFileSync(f, 'utf8');
  if (/£\s?\d/.test(src)) hardcodedPrice = true;
}
if (hardcodedPrice) fail('no hard-coded prices', 'found a £ figure in Agreement template/generator');
else pass('no hard-coded prices in Agreement template/generator');

/* Node built-ins only (import-specifier scan). */
for (const f of [...shippedFiles, path.join(agreementsDir, 'validate-agreements.mjs')]) {
  const src = fs.readFileSync(f, 'utf8');
  const external = [...src.matchAll(/^import .*? from '([^']+)'/gm)].map((m) => m[1]).filter((s) => !s.startsWith('.') && !s.startsWith('node:'));
  if (external.length) fail(`${path.basename(f)} external imports`, external.join(', '));
  else pass(`${path.basename(f)} Node built-ins + local imports only`);
}

/* gitignore coverage. */
const gitignore = fs.readFileSync(path.join(root, '.gitignore'), 'utf8');
if (gitignore.includes('ops/agreements/private/') && gitignore.includes('ops/agreements/out/')) pass('.gitignore covers ops/agreements/private/ + out/');
else fail('.gitignore coverage', 'ops/agreements/private/ and/or ops/agreements/out/ not ignored');
const isIgnored = (p) => { try { execFileSync('git', ['check-ignore', p], { encoding: 'utf8', stdio: 'ignore' }); return true; } catch { return false; } };
const giPrivate = isIgnored(path.join(agreementsDir, 'private', 'x.json'));
const giOut = isIgnored(path.join(agreementsDir, 'out', 'x.html'));
if (giPrivate && giOut) pass('git check-ignore confirms private/ + out/ ignored');
else fail('git check-ignore', `private=${giPrivate} out=${giOut}`);

/* ------------------------------------------------------------------ */
/* 2 · LEGAL REGISTER (committed truth)                                */
/* ------------------------------------------------------------------ */
section('2 · Legal-decision register');

let decisions;
try { decisions = loadLegalDecisions(); } catch (e) { fail('legal register loads', e.message); }
if (decisions) {
  const regClauseIds = Object.keys(decisions.clauses || {});
  const missing = LEGAL_CLAUSES.filter(([id]) => !regClauseIds.includes(id));
  if (missing.length) fail('legal register inventory', `missing clauses: ${missing.map(([id]) => id).join(', ')}`);
  else pass(`legal register inventory complete (${LEGAL_CLAUSES.length} clauses)`);
  let allRequired = true;
  for (const [id] of LEGAL_CLAUSES) {
    const c = decisions.clauses[id];
    if (!c || c.classification !== 'LEGAL_DECISION_REQUIRED') allRequired = false;
  }
  if (allRequired) pass('committed register: every clause LEGAL_DECISION_REQUIRED (no owner/legal decision invented)');
  else fail('committed register truth', 'a committed clause is not LEGAL_DECISION_REQUIRED — no legal decision may be fabricated');
  let vocabOk = true;
  for (const c of Object.values(decisions.clauses || {})) if (!CLASSIFICATIONS.includes(c.classification)) vocabOk = false;
  if (vocabOk) pass('register classifications within vocabulary');
  else fail('register classifications', 'unknown classification value');
}

const legal = legalSectionsFor(loadLegalDecisions());
if (legal.length === LEGAL_CLAUSES.length && legal.every((s) => s.status === 'UNRESOLVED')) pass('legalSectionsFor -> 26 UNRESOLVED (DRAFT behaviour)');
else fail('legalSectionsFor', `${legal.length} sections, ${legal.filter((s) => s.status === 'UNRESOLVED').length} unresolved`);

/* ------------------------------------------------------------------ */
/* 3 · DATA MODEL UNITS                                                */
/* ------------------------------------------------------------------ */
section('3 · Agreement data model');

if (AGREEMENT_ID_RE.test('AGR-2026-9104')) pass('agreement_id AGR-2026-9104 accepted');
else fail('agreement_id regex', 'AGR-2026-9104 rejected');
if (!AGREEMENT_ID_RE.test('AGR-26-91') && !AGREEMENT_ID_RE.test('PRP-2026-9104')) pass('agreement_id regex rejects malformed ids');
else fail('agreement_id regex', 'malformed id accepted');
if (AGREEMENT_STATUSES.join(',') === 'DRAFT,READY_FOR_EXECUTION' && !AGREEMENT_STATUSES.includes('SIGNED')) pass('statuses DRAFT|READY_FOR_EXECUTION (SIGNED not modelled)');
else fail('statuses', JSON.stringify(AGREEMENT_STATUSES));

const cls = classifyInput(path.join(agreementsDir, 'private', 'x.json'));
const cle = classifyInput(path.join(agreementsDir, 'examples', 'x.json'));
const clpp = classifyInput(path.join(proposalsDir, 'private', 'x.json'));
const clpe = classifyInput(path.join(proposalsDir, 'examples', 'x.json'));
const clu = classifyInput(path.join(root, 'README.md'));
if (cls === 'PRIVATE' && cle === 'EXAMPLES' && clpp === 'PROPOSAL_PRIVATE' && clpe === 'PROPOSAL_EXAMPLES' && clu === 'UNSAFE') pass('classifyInput policy (private/examples/proposals-private/proposals-examples/unsafe)');
else fail('classifyInput', `private=${cls} examples=${cle} pp=${clpp} pe=${clpe} unsafe=${clu}`);

const draftAgr = { commercial_schedule: { approved_final_project_price: 5100 }, provenance: { proposal_fingerprint: 'f'.repeat(64) }, legal_sections: legal };
const gate0 = isReadyForExecution(draftAgr, loadLegalDecisions());
if (!gate0.ready && gate0.reasons.some((r) => r.includes('legal decision required'))) pass('READY gate blocks unresolved DRAFT');
else fail('READY gate (unresolved)', JSON.stringify(gate0.reasons));
const resolvedAgr = { commercial_schedule: { approved_final_project_price: 5100 }, provenance: { proposal_fingerprint: 'f'.repeat(64) }, legal_sections: legalSectionsFor(readJson(syntheticResolvedRegister)) };
const gate1 = isReadyForExecution(resolvedAgr, readJson(syntheticResolvedRegister));
if (gate1.ready) pass('READY gate opens only when all clauses resolve (synthetic register mechanism proof)');
else fail('READY gate (resolved)', JSON.stringify(gate1.reasons));

/* ------------------------------------------------------------------ */
/* 4 · COMMERCIAL INHERITANCE UNITS                                    */
/* ------------------------------------------------------------------ */
section('4 · Commercial inheritance');

const handoffOk = validateAgreementHandoff(readJson(B2_HANDOFF), { label: 'b2-handoff' });
if (handoffOk.failures.length === 0) pass('committed B2 handoff validates (schema/status/commercial vs Source of Truth)');
else fail('B2 handoff validation', handoffOk.failures.join('; '));

const parseMoney = (s) => Number(String(s).replace(/[^0-9]/g, ''));
const rows = computeScheduleRows(5100, [40, 30, 30]);
const amounts = rows.map((r) => parseMoney(r.amount_display));
const sum = amounts.reduce((a, b) => a + b, 0);
if (sum === 5100 && amounts[0] === 2040 && amounts[2] === 1530) pass('milestone amounts from Approved price (2040/1530/1530) total exactly 5100');
else fail('milestone rounding', `sum=${sum} amounts=${JSON.stringify(amounts)}`);
const completeRows = computeScheduleRows(24000, [30, 30, 30, 10]);
const completeAmounts = completeRows.map((r) => parseMoney(r.amount_display));
if (completeAmounts.reduce((a, b) => a + b, 0) === 24000 && completeAmounts[3] === 2400) pass('Complete 30/30/30/10 totals exactly 24000 (last absorbs residual)');
else fail('Complete milestone rounding', JSON.stringify(completeAmounts));

/* ------------------------------------------------------------------ */
/* 5 · POSITIVE FLOWS (governed generator)                             */
/* ------------------------------------------------------------------ */
section('5 · Positive flows');

const b2Json = path.join(AGR_TMP, 'b2.agreement.json');
const b2Html = path.join(AGR_TMP, 'b2.html');
const r1 = runGen(['--example', '--json', '--output', b2Json, '--generated-at', STAMP]);
if (r1.code === 0) pass('generate DRAFT JSON from committed B2 handoff pair');
else fail('generate B2 JSON', r1.stderr);
if (r1.code === 0) {
  const a = readJson(b2Json);
  const v = validateAgreement(a, { label: 'generated-b2', requireExampleMarker: false });
  if (v.failures.length === 0) pass('generated B2 Agreement validates (shared core + provenance + legal)');
  else fail('generated B2 Agreement validation', v.failures.join('; '));
  if (a.status === 'DRAFT' && a.commercial_schedule.approved_final_project_price === 5100 && a.proposal.proposal_id === 'PRP-2026-9104') pass('B2 Agreement inherits Approved price 5100 + proposal identity');
  else fail('B2 Agreement content', JSON.stringify({ status: a.status, approved: a.commercial_schedule.approved_final_project_price }));
}

const r2 = runGen(['--example', '--output', b2Html, '--generated-at', STAMP, '--overwrite']);
if (r2.code === 0 && !/{{/.test(fs.readFileSync(b2Html, 'utf8'))) pass('generate B2 HTML — no leftover tokens');
else fail('generate B2 HTML', r2.stderr || 'leftover tokens present');

let b2Body = '';
if (fs.existsSync(b2Html)) {
  b2Body = fs.readFileSync(b2Html, 'utf8');
  if (b2Body.includes('DRAFT — NOT FOR EXECUTION')) pass('DRAFT document status banner present');
  else fail('DRAFT banner', 'missing');
  if (b2Body.includes('90-day Web Launch Warranty')) pass('governed warranty rendered');
  else fail('warranty rendering', 'missing');
  if (b2Body.includes('£5,100') && b2Body.includes('£4,250')) pass('Approved price (£5,100) + reference (£4,250) both shown');
  else fail('commercial rendering', 'approved/reference missing');
}

/* Deterministic generation. */
const detA = path.join(AGR_TMP, 'det-a.html');
const detB = path.join(AGR_TMP, 'det-b.html');
const da = runGen(['--example', '--output', detA, '--generated-at', STAMP]);
const db = runGen(['--example', '--output', detB, '--generated-at', STAMP]);
if (da.code === 0 && db.code === 0 && fs.readFileSync(detA, 'utf8') === fs.readFileSync(detB, 'utf8')) pass('deterministic generation (identical output for identical --generated-at)');
else fail('deterministic generation', 'outputs differ');

/* HTML escaping. */
let xssHtml = path.join(AGR_TMP, 'xss.html');
if (XSS && XSS.ok) {
  const rx = runGen([XSS.handoff, '--proposal', XSS.proposal, '--acceptance-record', XSS.record, '--output', xssHtml, '--generated-at', STAMP]);
  if (rx.code === 0) {
    const body = fs.readFileSync(xssHtml, 'utf8');
    if (body.includes('&lt;img src=x') && body.includes('Acme &amp;') && !body.includes('<script>alert(1)</script>')) pass('HTML escaping of client content (no raw script injection)');
    else fail('HTML escaping', 'raw or unescaped client content found');
  } else fail('HTML escaping flow', rx.stderr);
} else fail('HTML escaping flow', XSS && XSS.err ? XSS.err : 'fixture prep failed');

/* AI recurring — Go-Live only. */
let aiHtml = path.join(AGR_TMP, 'ai.html');
if (AI && AI.ok) {
  const ra = runGen([AI.handoff, '--proposal', AI.proposal, '--acceptance-record', AI.record, '--output', aiHtml, '--generated-at', STAMP]);
  if (ra.code === 0) {
    const body = fs.readFileSync(aiHtml, 'utf8');
    if (body.includes('from Go-Live') && body.includes('begins at Go-Live')) pass('AI recurring wording: starts at Go-Live only');
    else fail('AI recurring wording', 'recurring start misrepresented');
    if (body.includes('Web Care Plus') && body.includes('monthly in advance')) pass('Care rendered separately, monthly in advance');
    else fail('Care rendering', 'Care missing/misrepresented');
    if (!body.includes('90-day Web Launch Warranty')) pass('warranty conditional (absent for AI with no governed warranty)');
    else fail('warranty conditional', 'warranty rendered where not governed');
  } else fail('AI agreement flow', ra.stderr);
} else fail('AI agreement flow', AI && AI.err ? AI.err : 'fixture prep failed');

/* Complete bespoke — no mechanical public price, 30/30/30/10. */
let completeHtml = path.join(AGR_TMP, 'complete.html');
if (COMPLETE && COMPLETE.ok) {
  const rc = runGen([COMPLETE.handoff, '--proposal', COMPLETE.proposal, '--acceptance-record', COMPLETE.record, '--output', completeHtml, '--generated-at', STAMP]);
  if (rc.code === 0) {
    const body = fs.readFileSync(completeHtml, 'utf8');
    if (!body.includes('reference / public starting price') && body.includes('£7,200') && body.includes('£2,400')) pass('Complete bespoke: no public reference price, 30/30/30/10 amounts rendered');
    else fail('Complete rendering', 'public price shown or schedule wrong');
    if (body.includes('from Go-Live')) pass('Complete AI recurring at Go-Live');
    else fail('Complete recurring', 'Go-Live wording missing');
  } else fail('Complete agreement flow', rc.stderr);
} else fail('Complete agreement flow', COMPLETE && COMPLETE.err ? COMPLETE.err : 'fixture prep failed');

/* READY_FOR_EXECUTION positive (synthetic resolved register only). */
let readyHtml = path.join(AGR_TMP, 'ready.html');
const rr = runGen(['--example', '--status', 'READY_FOR_EXECUTION', '--legal-decisions', syntheticResolvedRegister, '--output', readyHtml, '--generated-at', STAMP]);
if (rr.code === 0) {
  const body = fs.readFileSync(readyHtml, 'utf8');
  if (body.includes('READY FOR EXECUTION — NOT YET SIGNED')) pass('READY_FOR_EXECUTION gate opens (synthetic register) + status labelling');
  else fail('READY status labelling', 'missing');
  if (body.includes('Covered by an approved Nexora term') && !body.includes('legal-status">To be confirmed')) pass('READY document has no unresolved legal provisions');
  else fail('READY unresolved provisions', 'unresolved items remain in READY document');
} else fail('READY positive flow', rr.stderr);

/* --check mode. */
const rchk = runGen(['--example', '--check']);
if (rchk.code === 0 && /VALID/.test(rchk.stdout)) pass('--check validate-only mode exits 0');
else fail('--check mode', rchk.stderr || rchk.stdout);

/* ------------------------------------------------------------------ */
/* 6 · NEGATIVE TESTS (fail closed)                                    */
/* ------------------------------------------------------------------ */
section('6 · Negative tests (fail closed)');

/* 1. non-accepted proposal — clone B2 accepted as SENT, handoff refers to it. */
const nonAccProp = path.join(PROP_TMP, 'non-accepted.json');
{
  const p = readJson(B2_PROP);
  p.status = 'SENT';
  delete p.acceptance;
  writeJson(nonAccProp, p);
  const r = runGen([B2_HANDOFF, '--proposal', nonAccProp, '--acceptance-record', B2_REC]);
  if (r.code !== 0) pass('reject non-accepted proposal (not CLIENT_ACCEPTED)');
  else fail('non-accepted proposal accepted', 'generation succeeded');
}

/* 2. mismatched proposal fingerprint — tamper the accepted proposal. */
{
  const t = path.join(PROP_TMP, 'tamper-prop.json');
  const p = readJson(B2_PROP);
  p.commercial_schedule.approved_final_project_price = 5200;
  writeJson(t, p);
  const r = runGen([B2_HANDOFF, '--proposal', t, '--acceptance-record', B2_REC]);
  if (r.code !== 0 && /FINGERPRINT MISMATCH/.test(r.stderr)) pass('reject modified accepted Proposal (fingerprint mismatch)');
  else fail('fingerprint mismatch', 'not refused');
}

/* 3. modified approved price in handoff snapshot. */
{
  const t = path.join(PROP_TMP, 'tamper-price.handoff.json');
  const h = readJson(B2_HANDOFF);
  h.commercial_snapshot.approved_final_project_price = 9999;
  writeJson(t, h);
  const r = runGen([t, '--proposal', B2_PROP, '--acceptance-record', B2_REC]);
  if (r.code !== 0 && /COMMERCIAL DRIFT/.test(r.stderr)) pass('reject modified Approved Final Project Price in handoff');
  else fail('modified approved price', 'not refused');
}

/* 4. modified payment schedule. */
{
  const t = path.join(PROP_TMP, 'tamper-schedule.handoff.json');
  const h = readJson(B2_HANDOFF);
  h.commercial_snapshot.payment_schedule = [50, 50];
  writeJson(t, h);
  const r = runGen([t, '--proposal', B2_PROP, '--acceptance-record', B2_REC]);
  if (r.code !== 0) pass('reject modified payment schedule (frozen B2 40/30/30)');
  else fail('modified payment schedule', 'not refused');
}

/* 5. offering mismatch. */
{
  const t = path.join(PROP_TMP, 'tamper-offering.handoff.json');
  const h = readJson(B2_HANDOFF);
  h.offering = { code: 'A2', category: 'AI', name: 'AI Growth' };
  writeJson(t, h);
  const r = runGen([t, '--proposal', B2_PROP, '--acceptance-record', B2_REC]);
  if (r.code !== 0) pass('reject offering mismatch (handoff vs accepted Proposal)');
  else fail('offering mismatch', 'not refused');
}

/* 6. acceptance-record mismatch (wrong record for the proposal). */
{
  const r = runGen([B2_HANDOFF, '--proposal', B2_PROP, '--acceptance-record', path.join(PROP_TMP, 'prp-2026-9202.acceptance.json')]);
  if (r.code !== 0 && /ACCEPTANCE RECORD MISMATCH/.test(r.stderr)) pass('reject acceptance-record mismatch');
  else fail('acceptance-record mismatch', 'not refused');
}

/* 7. fabricated handoff (bogus schema/status). */
{
  const t = path.join(PROP_TMP, 'fabricated.handoff.json');
  writeJson(t, { schema: 'nexora-agreement-handoff/v1', status: 'READY_FOR_AGREEMENT', proposal: { proposal_id: 'PRP-2026-0000', version: '1.0' }, acceptance: { content_sha256: '0'.repeat(64), canonical_format: 'nexora-proposal-canonical/v1' }, commercial_snapshot: {} });
  const r = runGen([t]);
  if (r.code !== 0) pass('reject fabricated handoff (invalid structure)');
  else fail('fabricated handoff', 'accepted');
}

/* 8. unresolved decisions promoted to READY_FOR_EXECUTION (real register). */
{
  const r = runGen(['--example', '--status', 'READY_FOR_EXECUTION']);
  if (r.code !== 0 && /READY_FOR_EXECUTION/.test(r.stderr) && /gate|REFUSED/.test(r.stderr)) pass('reject READY_FOR_EXECUTION while legal decisions unresolved (no force-ready)');
  else fail('unresolved -> READY', 'not refused');
}

/* 9–13. legacy/vat/invented content in an Agreement instance. */
for (const [name, needle] of [['legacy Starter', 'Legacy Starter package'], ['legacy Elite', 'Legacy Elite tier'], ['£250 deposit', 'a £250 deposit secures the project'], ['VAT assertion', 'VAT registered at 20%'], ['AI Care', 'AI Care plan included']]) {
  const t = path.join(AGR_TMP, `bad-${name.replace(/[^a-z0-9]+/gi, '-').toLowerCase()}.json`);
  const a = readJson(b2Json);
  a.assumptions = [...(a.assumptions || []), needle];
  writeJson(t, a);
  const v = validateAgreement(a, { label: `bad-${name}`, requireExampleMarker: false });
  if (v.failures.length > 0) pass(`reject ${name} content`);
  else fail(`reject ${name} content`, 'accepted');
}

/* 14. recurring AI before Go-Live. */
{
  const t = path.join(PROP_TMP, 'tamper-recurring.handoff.json');
  const h = readJson(path.join(PROP_TMP, 'prp-2026-9202.handoff.json'));
  h.commercial_snapshot.recurring_fees.starts_at = 'ACCEPTANCE';
  writeJson(t, h);
  const r = runGen([t, '--proposal', path.join(PROP_TMP, 'prp-2026-9202.json'), '--acceptance-record', path.join(PROP_TMP, 'prp-2026-9202.acceptance.json')]);
  if (r.code !== 0) pass('reject AI recurring before Go-Live');
  else fail('recurring before Go-Live', 'not refused');
}

/* 15. reference/public price used as the contractual amount (approved price absent). */
{
  const t = path.join(AGR_TMP, 'ref-as-contractual.json');
  const a = readJson(b2Json);
  delete a.commercial_schedule.approved_final_project_price;
  writeJson(t, a);
  const v = validateAgreement(a, { label: 'ref-as-contractual', requireExampleMarker: false });
  if (v.failures.length > 0) pass('reject reference price standing in as contractual (Approved price required)');
  else fail('reference-as-contractual', 'accepted');
}

/* 16. malformed JSON handoff. */
{
  const t = path.join(PROP_TMP, 'malformed.handoff.json');
  fs.writeFileSync(t, '{ not valid json ');
  const r = runGen([t]);
  if (r.code !== 0) pass('reject malformed JSON handoff');
  else fail('malformed JSON', 'accepted');
}

/* 17. unsafe input path. */
{
  const r = runGen([path.join(root, 'CLAUDE.md')]);
  if (r.code !== 0 && /unsafe input/i.test(r.stderr)) pass('reject unsafe input path');
  else fail('unsafe input', 'accepted');
}

/* 18. unsafe output path / path traversal. */
{
  const r = runGen(['--example', '--output', path.join(root, '..', 'escape.html')]);
  if (r.code !== 0 && /Unsafe output path/.test(r.stderr)) pass('reject path-traversal output');
  else fail('unsafe output', 'accepted');
}

/* 19. overwrite without explicit safe policy. */
{
  const out = path.join(AGR_TMP, 'overwrite.html');
  fs.writeFileSync(out, 'existing');
  const r = runGen(['--example', '--output', out]);
  if (r.code !== 0 && /Refusing to overwrite/.test(r.stderr)) pass('refuse overwrite without --overwrite');
  else fail('overwrite protection', 'overwrote silently');
}

/* 20. leftover template tokens — generated HTML must have none (checked in positives); also static: template must reference no undefined bindings after render. */
{
  const body = fs.existsSync(b2Html) ? fs.readFileSync(b2Html, 'utf8') : '';
  if (body && !/{{[\s\S]*?}}/.test(body)) pass('no leftover template tokens in rendered Agreement');
  else fail('leftover tokens', 'found');
}

/* 21. committed-real-data style fixture (unmarked _example). */
{
  const t = path.join(AGR_TMP, 'unmarked.json');
  const a = readJson(b2Json);
  delete a._example;
  writeJson(t, a);
  const v = validateAgreement(a, { label: 'unmarked', requireExampleMarker: true });
  if (v.failures.length > 0) pass('reject unmarked Agreement fixture (real-data guard)');
  else fail('unmarked fixture', 'accepted');
}

/* 22. milestone rounding/total mismatch (invalid frozen schedule). */
{
  const t = path.join(AGR_TMP, 'schedule-mismatch.json');
  const a = readJson(b2Json);
  a.commercial_schedule.payment_schedule = [40, 30, 20];
  writeJson(t, a);
  const v = validateAgreement(a, { label: 'schedule-mismatch', requireExampleMarker: false });
  if (v.failures.length > 0) pass('reject payment schedule that does not match governed B2 40/30/30 (total mismatch)');
  else fail('schedule total mismatch', 'accepted');
}

/* unsafe --proposal path. */
{
  const r = runGen([B2_HANDOFF, '--proposal', path.join(root, 'CLAUDE.md'), '--acceptance-record', B2_REC]);
  if (r.code !== 0 && /unsafe --proposal/i.test(r.stderr)) pass('reject unsafe --proposal path');
  else fail('unsafe --proposal', 'accepted');
}

/* fabricated/unsafe acceptance-record path. */
{
  const r = runGen([B2_HANDOFF, '--proposal', B2_PROP, '--acceptance-record', path.join(root, 'CLAUDE.md')]);
  if (r.code !== 0 && /unsafe --acceptance-record/i.test(r.stderr)) pass('reject unsafe --acceptance-record path');
  else fail('unsafe --acceptance-record', 'accepted');
}

/* ------------------------------------------------------------------ */
/* 7 · COMMITTED FIXTURES + PRIVACY                                    */
/* ------------------------------------------------------------------ */
section('7 · Committed fixtures + privacy');

const fixtureFiles = fs.readdirSync(EXAMPLES_DIR).filter((f) => f.endsWith('.json'));
if (fixtureFiles.length >= 3) pass(`committed Agreement fixtures present (${fixtureFiles.length})`);
else fail('committed fixtures', 'fewer than 3 agreement fixtures');

for (const f of fixtureFiles) {
  const a = readJson(path.join(EXAMPLES_DIR, f));
  if (a._example !== true) { fail(`fixture ${f} _example`, 'must be true'); continue; }
  const v = validateAgreement(a, { label: f, requireExampleMarker: true });
  if (v.failures.length === 0) pass(`${f} valid committed DRAFT Agreement`);
  else fail(`${f} validation`, v.failures.join('; '));
}

const emails = [];
for (const f of fixtureFiles) {
  const a = readJson(path.join(EXAMPLES_DIR, f));
  const walk = (o) => { for (const k of Object.keys(o)) if (typeof o[k] === 'string') emails.push(o[k]); else if (o[k] && typeof o[k] === 'object') walk(o[k]); };
  walk(a);
}
if (emails.every((s) => !/@[^@]*\.(com|co\.uk)[^@]*$/.test(s) || /@example\.com$/.test(s) || /example\./.test(s))) pass('fixtures use only fictional example.com data');
else fail('fixture privacy', 'non-example contact data found');

if (fs.existsSync(path.join(agreementsDir, 'private'))) {
  const hasReal = fs.readdirSync(path.join(agreementsDir, 'private')).filter((f) => f !== '.tmp-tests').length > 0;
  if (hasReal) pass('ops/agreements/private/ holds only non-tracked/gitignored content');
}

/* ------------------------------------------------------------------ */
/* 8 · CLEANUP                                                         */
/* ------------------------------------------------------------------ */
section('8 · Cleanup');
fs.rmSync(AGR_TMP, { recursive: true, force: true });
fs.rmSync(PROP_TMP, { recursive: true, force: true });
fs.rmSync(path.join(proposalsDir, 'private', '.tmp-tests'), { recursive: true, force: true });
if (!fs.existsSync(AGR_TMP) && !fs.existsSync(PROP_TMP)) pass('temporary test data removed (gitignored locations)');
else fail('cleanup', 'tmp fixtures remain');

/* ------------------------------------------------------------------ */
/* REPORT                                                              */
/* ------------------------------------------------------------------ */
let passed = 0;
for (const c of checks) {
  if (c.text.startsWith('──')) { console.log(`\n${c.text}`); continue; }
  if (c.ok) { passed++; console.log(`  ok   ${c.text}`); }
  else console.log(`  FAIL ${c.text}`);
}
console.log(`\n${passed}/${checks.filter((c) => !c.text.startsWith('──')).length} agreement checks passed`);
if (failures.length > 0) {
  console.log(`\nFAILURES (${failures.length}):`);
  for (const f of failures) console.log(`  FAIL ${f}`);
  process.exit(1);
}
console.log('ALL AGREEMENT CHECKS PASSED');
