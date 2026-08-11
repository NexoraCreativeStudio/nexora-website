#!/usr/bin/env node
/* Nexora Document Output System (PROP.6) — validation harness.
   Validates the governed final-document output layer:
     - static safety (CLI/core present, gitignore, no hard-coded prices, no force-ready)
     - deterministic filenames, SHA-256 checksums + manifest correctness
     - PDF engine discovery (graceful HTML/print fallback is NOT a failure)
     - positive QA: B2/A2/Complete final Proposal documents (HTML + PDF),
       B2/AI/Complete final Agreement DRAFT documents (HTML + PDF),
       and a READY_FOR_EXECUTION Agreement opened ONLY via a SYNTHETIC
       resolved legal-decisions register (mechanism proof, never committed)
     - 18 fail-closed negative tests (see section 6)
     - privacy / path-leakage / commercial-divergence sweeps
     - cleanup of all tmp fixtures (all under gitignored locations)

   PROP.6 is PRESENTATION/OUTPUT only. This harness never touches
   ops/billing-source-of-truth.json, the Commercial Constitution, pricing,
   or any Proposal/Agreement status. */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';
import {
  DOC_OUTPUT_VERSION,
  MANIFEST_SCHEMA,
  OUTPUT_SYSTEM,
  PROPOSAL_OUT_DIR,
  AGREEMENT_OUT_DIR,
  sha256hex,
  safeProposalFilename,
  safeAgreementFilename,
  validateDerivedName,
  defaultOutputDir,
  assertSafeOutputDir,
  scanLegacy,
  scanVatAssertions,
  scanTokens,
  scanPathLeakage,
  findChrome,
  pdfAvailable,
  pdfPageCount,
  extractPdfText,
  pdfTextContains,
  buildManifest
} from './document-output.mjs';
import { loadLegalDecisions, LEGAL_CLAUSES, classifyInput as classifyAgreementInput } from '../agreements/agreement-validation.mjs';
import { proposalFingerprint } from '../proposals/proposal-lifecycle.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const documentsDir = __dirname;
const root = path.join(__dirname, '..', '..');
const proposalsDir = path.join(root, 'ops', 'proposals');
const agreementsDir = path.join(root, 'ops', 'agreements');

const CLI = path.join(documentsDir, 'generate-document.mjs');
const CORE = path.join(documentsDir, 'document-output.mjs');
const LIFECYCLE = path.join(proposalsDir, 'proposal-lifecycle.mjs');

const B2_SAMPLE = path.join(proposalsDir, 'examples', 'sample-proposal.json');
const A2_SAMPLE = path.join(proposalsDir, 'examples', 'sample-proposal-ai.json');
const COMPLETE_SAMPLE = path.join(proposalsDir, 'examples', 'sample-proposal-complete.json');
const B2_HANDOFF = path.join(proposalsDir, 'examples', 'lifecycle', 'proposal-accepted.handoff.json');
const B2_PROP = path.join(proposalsDir, 'examples', 'lifecycle', 'proposal-accepted.json');
const B2_REC = path.join(proposalsDir, 'examples', 'lifecycle', 'proposal-accepted.acceptance.json');

const DOC_TMP = path.join(documentsDir, 'private', '.tmp-tests');
const OUT_PROP = path.join(DOC_TMP, 'proposals');
const OUT_AGR = path.join(DOC_TMP, 'agreements');
const PROP_TMP = path.join(proposalsDir, 'private', '.tmp-tests', 'documents');
const AGR_TMP = path.join(agreementsDir, 'private', '.tmp-tests');
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
const runGen = (args) => runNode(CLI, args);
const runLifecycle = (args) => runNode(LIFECYCLE, args);

/* ------------------------------------------------------------------ */
/* 0 · PREPARE tmp synthetic upstream fixtures (gitignored only)      */
/* ------------------------------------------------------------------ */
function buildAcceptedProposal(samplePath, id) {
  const p = readJson(samplePath);
  p.proposal_id = id;
  p.issue_date = '2026-07-15';
  p.valid_until = '2026-08-14';
  p.status = 'SENT';
  delete p.acceptance;
  const out = path.join(PROP_TMP, `${id}.json`);
  writeJson(out, p);
  return out;
}

function acceptAndHandoff(propPath, id) {
  const rec = path.join(PROP_TMP, `${id}.acceptance.json`);
  const handoff = path.join(PROP_TMP, `${id}.handoff.json`);
  const a = runLifecycle(['accept', propPath, '--by', 'Alex Sample', '--date', '2026-08-01', '--record', rec]);
  if (a.code !== 0) return { ok: false, err: a.stderr };
  const h = runLifecycle(['handoff', propPath, '--record', rec, '--output', handoff]);
  if (h.code !== 0) return { ok: false, err: h.stderr };
  return { ok: true, proposal: propPath, record: rec, handoff };
}

let AI = null;
let COMPLETE = null;
const syntheticResolvedRegister = path.join(AGR_TMP, 'synthetic-resolved-legal-decisions.json');

try {
  fs.mkdirSync(DOC_TMP, { recursive: true });
  fs.mkdirSync(PROP_TMP, { recursive: true });

  /* SYNTHETIC resolved register (mechanism proof only, never committed). */
  const baseReg = loadLegalDecisions();
  const resolved = { ...baseReg, description: 'SYNTHETIC TEST REGISTER — proves the READY_FOR_EXECUTION gate mechanism; NOT a real owner/legal decision.' };
  resolved.clauses = {};
  for (const [id] of LEGAL_CLAUSES) {
    resolved.clauses[id] = { classification: 'AUTHORITATIVE', note: 'SYNTHETIC TEST RESOLUTION — mechanism proof only.' };
  }
  writeJson(syntheticResolvedRegister, resolved);

  AI = acceptAndHandoff(buildAcceptedProposal(A2_SAMPLE, 'PRP-2026-9302'), 'prp-2026-9302');
  COMPLETE = acceptAndHandoff(buildAcceptedProposal(COMPLETE_SAMPLE, 'PRP-2026-9303'), 'prp-2026-9303');
} catch (e) {
  pass(`tmp fixture preparation — ERROR: ${e.message}`);
  AI = { ok: false, err: e.message };
  COMPLETE = { ok: false, err: e.message };
}

/* ------------------------------------------------------------------ */
/* 1 · STATIC SAFETY                                                   */
/* ------------------------------------------------------------------ */
section('1 · Static safety');

if (fs.existsSync(CLI)) pass('generate-document.mjs present');
else fail('CLI present', 'missing');
if (fs.existsSync(CORE)) pass('document-output.mjs present');
else fail('core present', 'missing');

/* .gitignore: real generated client documents + private areas are never committed. */
const gi = fs.readFileSync(path.join(root, '.gitignore'), 'utf8');
if (/ops\/documents\/private\//.test(gi) && /ops\/documents\/out\//.test(gi)) pass('.gitignore covers ops/documents/private/ + ops/documents/out/');
else fail('.gitignore coverage', 'ops/documents/private/ and/or ops/documents/out/ not ignored');

try {
  const a = execFileSync('git', ['check-ignore', 'ops/documents/private/x', 'ops/documents/out/x'], { cwd: root, encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] });
  if (a.includes('ops/documents/private') && a.includes('ops/documents/out')) pass('git check-ignore confirms private/ + out/ ignored');
  else fail('git check-ignore', `private=${a.includes('ops/documents/private')} out=${a.includes('ops/documents/out')}`);
} catch (e) { fail('git check-ignore', e.message); }

/* No hard-coded frozen prices anywhere in the PROP.6 output layer. (The core's
   legacy-scanner regex literals such as /£250/ are detection patterns, not
   prices — they are deliberately excluded by matching numeric price literals.) */
const priceRe = /\b5,?100\b|\b1,?100\b|\b24,?000\b|\b9,?97\b|\b697\b/;
for (const [label, f] of [['CLI', CLI], ['core', CORE]]) {
  const src = fs.readFileSync(f, 'utf8');
  if (priceRe.test(src)) fail(`${label} no hard-coded prices`, 'frozen price found in output-layer source');
  else pass(`${label} no hard-coded prices`);
}

/* No --force-ready shortcut: READY_FOR_EXECUTION is opened ONLY through an
   approved, resolved legal-decisions register. */
const cliSrc = fs.readFileSync(CLI, 'utf8');
if (/--force[_-]?ready|opts\.forceReady/.test(cliSrc)) fail('no --force-ready shortcut in PROP.6 tooling');
else pass('no --force-ready shortcut in PROP.6 tooling');

/* Node built-ins + local imports only. */
for (const [label, f] of [['generate-document.mjs', CLI], ['document-output.mjs', CORE]]) {
  const src = fs.readFileSync(f, 'utf8');
  const bad = [...src.matchAll(/from\s+['"]([^'"]+)['"]/g)].map((m) => m[1]).filter((m) => !m.startsWith('.') && !m.startsWith('node:'));
  if (bad.length === 0) pass(`${label} Node built-ins + local imports only`);
  else fail(`${label} Node built-ins + local imports only`, `external: ${bad.join(', ')}`);
}

/* ------------------------------------------------------------------ */
/* 2 · DETERMINISTIC FILENAMES + CHECKSUM + MANIFEST UNITS             */
/* ------------------------------------------------------------------ */
section('2 · Deterministic filenames + checksum + manifest');

if (safeProposalFilename('PRP-2026-0012', '1.0') === 'PRP-2026-0012-v1.0.html') pass('safeProposalFilename PRP-YYYY-NNNN-vX.Y.html');
else fail('safeProposalFilename', safeProposalFilename('PRP-2026-0012', '1.0'));
if (safeAgreementFilename('AGR-2026-0012', '1.0', 'DRAFT') === 'AGR-2026-0012-v1.0-DRAFT.html') pass('safeAgreementFilename AGR-YYYY-NNNN-vX.Y-STATUS.html');
else fail('safeAgreementFilename', safeAgreementFilename('AGR-2026-0012', '1.0', 'DRAFT'));
if (safeProposalFilename('../../evil', '1.0') === 'evil-v1.0.html' && !safeProposalFilename('../../evil', '1.0').includes('..')) pass('unsafe filename sanitised (no traversal)');
else fail('unsafe filename sanitised', safeProposalFilename('../../evil', '1.0'));
if (safeProposalFilename('John Doe & Sons / v2', '1.0') === 'John-Doe-Sons-v2-v1.0.html') pass('unsafe characters sanitised to [A-Za-z0-9._-]');
else fail('unsafe characters sanitised', safeProposalFilename('John Doe & Sons / v2', '1.0'));

for (const bad of ['../x.html', '.hidden', 'a..b', 'a/b', 'x\\y']) {
  if (validateDerivedName(bad)) pass(`validateDerivedName rejects "${bad}"`);
  else fail(`validateDerivedName rejects "${bad}"`);
}
if (validateDerivedName('PRP-2026-0012-v1.0.html') === null) pass('validateDerivedName accepts clean name');
else fail('validateDerivedName accepts clean name');

const shaSample = sha256hex('nexora');
if (typeof shaSample === 'string' && /^[0-9a-f]{64}$/.test(shaSample)) pass('sha256hex returns 64-char hex');
else fail('sha256hex', `not 64-char hex: ${shaSample}`);
if (sha256hex('same') === sha256hex('same') && sha256hex('same') !== sha256hex('diff')) pass('sha256hex deterministic');
else fail('sha256hex deterministic');

const manifest = buildManifest({
  docType: 'proposal', documentId: 'PRP-2026-0012', version: '1.0', status: 'SENT',
  generatedAt: STAMP, sourceProposalId: 'PRP-2026-0012', sourceAgreementId: null,
  htmlFilename: 'PRP-2026-0012-v1.0.html', htmlChecksum: 'a'.repeat(64),
  pdfFilename: null, pdfChecksum: null, generatorSchema: 'nexora-proposal-schema-v1'
});
if (manifest.schema === MANIFEST_SCHEMA && manifest.output_system === OUTPUT_SYSTEM) pass(`manifest schema ${MANIFEST_SCHEMA} + output_system`);
else fail('manifest schema/output_system', JSON.stringify(manifest));
if (/not a digital signature/i.test(manifest.checksum_note) && /e-signature/.test(manifest.checksum_note)) pass('manifest notes checksum ≠ digital signature, output ≠ e-signature');
else fail('manifest checksum/signature disclaimer', manifest.checksum_note);

if (defaultOutputDir('proposal') === PROPOSAL_OUT_DIR && defaultOutputDir('agreement') === AGREEMENT_OUT_DIR) pass('default output dirs proposals/ + agreements/');
else fail('default output dirs', `${defaultOutputDir('proposal')} / ${defaultOutputDir('agreement')}`);

/* ------------------------------------------------------------------ */
/* 3 · PDF ENGINE DISCOVERY + SCAN UNITS                               */
/* ------------------------------------------------------------------ */
section('3 · PDF engine + output-layer scanners');

const pdf = pdfAvailable();
if (pdf.available) pass(`PDF engine available — ${path.basename(pdf.chromePath)} (headless print-to-PDF)`);
else fail('PDF engine available', 'AUTOMATED PDF: NOT AVAILABLE — SAFE HTML/PRINT WORKFLOW ONLY (HTML authoritative, browser Print -> Save as PDF)');
if (typeof findChrome() === 'string' || findChrome() === null) pass('findChrome returns path or null');
else fail('findChrome', String(findChrome()));

if (scanLegacy('Starter tier').length > 0) pass('scanner flags legacy Starter');
else fail('scanner flags legacy Starter');
if (scanLegacy('Elite package').length > 0) pass('scanner flags legacy Elite');
else fail('scanner flags legacy Elite');
if (scanLegacy('Pay £250 deposit').length > 0) pass('scanner flags legacy £250 deposit');
else fail('scanner flags legacy £250 deposit');
if (scanLegacy('AI Care is included').length > 0) pass('scanner flags legacy AI Care');
else fail('scanner flags legacy AI Care');
if (scanLegacy('paypal.com / buy.stripe.com checkout').length >= 1) pass('scanner flags obsolete checkout (stripe/paypal)');
else fail('scanner flags obsolete checkout');
if (scanLegacy('Modern clean copy with no legacy').length === 0) pass('scanner passes clean copy');
else fail('scanner passes clean copy', JSON.stringify(scanLegacy('Modern clean copy with no legacy')));

if (scanVatAssertions('VAT included at 20%').length > 0) pass('scanner flags unsupported VAT claim');
else fail('scanner flags unsupported VAT claim');
if (scanVatAssertions('VAT: UNDETERMINED at Go-Live').length === 0) pass('scanner passes VAT UNDETERMINED (neutral)');
else fail('scanner passes VAT UNDETERMINED', JSON.stringify(scanVatAssertions('VAT: UNDETERMINED at Go-Live')));

if (scanTokens('No tokens {{leftover}} here').length === 1) pass('scanner flags leftover {{token}}');
else fail('scanner flags leftover {{token}}');
if (scanTokens('Clean output').length === 0) pass('scanner passes clean output');
else fail('scanner passes clean output');

if (scanPathLeakage('file:///private/var/x').length > 0) pass('scanner flags file:// URL leakage');
else fail('scanner flags file:// URL leakage');
if (scanPathLeakage('/Users/realuser/.ssh/id_rsa').length > 0) pass('scanner flags absolute private user path');
else fail('scanner flags absolute private user path');
if (scanPathLeakage('Clean client-facing copy').length === 0) pass('scanner passes clean client-facing copy');
else fail('scanner passes clean client-facing copy');

/* ------------------------------------------------------------------ */
/* 4 · POSITIVE — FINAL PROPOSAL DOCUMENTS (B2 / A2 / COMPLETE)        */
/* ------------------------------------------------------------------ */
section('4 · Positive — final Proposal documents (B2 / A2 / Complete)');

const propCases = [
  { label: 'B2', path: B2_SAMPLE, id: 'PRP-2026-9001', approved: '5,100', ref: '4,250', noRef: false },
  { label: 'A2', path: A2_SAMPLE, id: 'PRP-2026-9002', approved: '1,100', ref: null, noRef: true },
  { label: 'Complete', path: COMPLETE_SAMPLE, id: 'PRP-2026-9003', approved: '24,000', ref: null, noRef: true }
];
for (const c of propCases) {
  const r = runGen(['proposal', c.path, '--pdf', '--output', OUT_PROP, '--generated-at', STAMP]);
  if (r.code !== 0) { fail(`${c.label} proposal generate`, r.stderr); continue; }
  pass(`${c.label} proposal final document generated (HTML + PDF + manifest)`);

  const htmlFile = path.join(OUT_PROP, safeProposalFilename(c.id, '1.0'));
  const html = fs.readFileSync(htmlFile, 'utf8');
  if (html.includes('<!DOCTYPE html>') && html.includes('</html>')) pass(`${c.label} proposal HTML well-formed (doctype + close)`);
  else fail(`${c.label} proposal HTML well-formed`, 'missing doctype/close');
  if (scanTokens(html).length === 0) pass(`${c.label} proposal HTML no leftover tokens`);
  else fail(`${c.label} proposal HTML no leftover tokens`, scanTokens(html).join(', '));
  if (scanLegacy(html).length === 0) pass(`${c.label} proposal HTML no legacy commercial content`);
  else fail(`${c.label} proposal HTML no legacy`, scanLegacy(html).join('; '));
  if (scanVatAssertions(html).length === 0) pass(`${c.label} proposal HTML no unsupported VAT claim`);
  else fail(`${c.label} proposal HTML no VAT claim`, scanVatAssertions(html).join('; '));
  if (scanPathLeakage(html).length === 0) pass(`${c.label} proposal HTML no private path leakage`);
  else fail(`${c.label} proposal HTML no path leakage`, scanPathLeakage(html).join('; '));
  if (html.includes(c.id)) pass(`${c.label} proposal HTML carries document id`);
  else fail(`${c.label} proposal HTML document id`);
  if (html.includes('Approved Final Project Price')) pass(`${c.label} proposal HTML Approved price label`);
  else fail(`${c.label} proposal HTML Approved price label`);
  if (html.includes(c.approved)) pass(`${c.label} proposal HTML Approved price £${c.approved}`);
  else fail(`${c.label} proposal HTML Approved price £${c.approved}`);
  if (c.ref) { if (html.includes(c.ref)) pass(`${c.label} proposal HTML reference price £${c.ref} (subordinate)`); else fail(`${c.label} proposal reference price`); }
  if (c.noRef) { if (!html.includes('4,250')) pass(`${c.label} proposal HTML hides invented public reference price`); else fail(`${c.label} proposal invented reference price leaked`); }

  const manifestFile = htmlFile.replace(/\.html$/, '.manifest.json');
  if (fs.existsSync(manifestFile)) {
    const mf = readJson(manifestFile);
    const actual = sha256hex(fs.readFileSync(htmlFile));
    if (mf.document_id === c.id && mf.document_type === 'proposal' && mf.version === '1.0') pass(`${c.label} proposal manifest identity fields`);
    else fail(`${c.label} proposal manifest identity`, JSON.stringify({ id: mf.document_id, ver: mf.version }));
    if (mf.html_checksum_sha256 === actual) pass(`${c.label} proposal manifest HTML checksum matches bytes`);
    else fail(`${c.label} proposal manifest checksum`, `manifest=${mf.html_checksum_sha256} actual=${actual}`);
    if (mf.pdf_filename && mf.pdf_checksum_sha256) pass(`${c.label} proposal manifest has PDF + checksum`);
    else fail(`${c.label} proposal manifest PDF`, 'pdf missing from manifest');
  } else fail(`${c.label} proposal manifest present`);

  const pdfFile = htmlFile.replace(/\.html$/, '.pdf');
  if (fs.existsSync(pdfFile)) {
    const buf = fs.readFileSync(pdfFile);
    if (buf.slice(0, 5).toString() === '%PDF-') pass(`${c.label} proposal PDF %PDF- magic`);
    else fail(`${c.label} proposal PDF magic`, buf.slice(0, 5).toString());
    if (buf.length > 0) pass(`${c.label} proposal PDF non-zero size (${buf.length} bytes)`);
    else fail(`${c.label} proposal PDF non-zero size`);
    const pages = pdfPageCount(buf);
    if (pages > 0) pass(`${c.label} proposal PDF page count ${pages}`);
    else fail(`${c.label} proposal PDF page count`, String(pages));
    const txt = extractPdfText(buf);
    if (pdfTextContains(txt, c.id)) pass(`${c.label} proposal PDF carries document id (selectable text)`);
    else fail(`${c.label} proposal PDF document id`);
    if (pdfTextContains(txt, c.approved) && pdfTextContains(txt, 'Approved Final Project Price')) pass(`${c.label} proposal PDF Approved price (selectable text)`);
    else fail(`${c.label} proposal PDF Approved price`);
    if (scanTokens(txt).length === 0) pass(`${c.label} proposal PDF no leftover tokens`);
    else fail(`${c.label} proposal PDF no leftover tokens`);
    if (scanPathLeakage(txt).length === 0) pass(`${c.label} proposal PDF no file:// leakage`);
    else fail(`${c.label} proposal PDF no file:// leakage`, scanPathLeakage(txt).join('; '));
    if (scanVatAssertions(txt).length === 0) pass(`${c.label} proposal PDF no unsupported VAT claim`);
    else fail(`${c.label} proposal PDF no VAT claim`, scanVatAssertions(txt).join('; '));
    if (scanLegacy(txt).length === 0) pass(`${c.label} proposal PDF no legacy commercial content`);
    else fail(`${c.label} proposal PDF no legacy`, scanLegacy(txt).join('; '));
  } else {
    fail(`${c.label} proposal PDF present`, 'expected --pdf output');
  }
}

/* Unescaped-user-data check (§23): rendered variables go through escapeHtml,
   so raw markup in client data must never survive into the final document. */
{
  const p = readJson(B2_SAMPLE);
  p.proposal_id = 'PRP-2026-9913';
  p.client = { ...p.client, company: 'Acme & <b>Bros</b>' };
  p.project = { ...p.project, title: 'XSS test <script>alert(1)</script>', summary: '<img src=x onerror=alert(1)> in a rendered summary' };
  const f = path.join(PROP_TMP, 'xss.json');
  writeJson(f, p);
  const r = runGen(['proposal', f, '--output', OUT_PROP, '--generated-at', STAMP]);
  if (r.code === 0) {
    const html = fs.readFileSync(path.join(OUT_PROP, 'PRP-2026-9913-v1.0.html'), 'utf8');
    if (!html.includes('<script>alert(1)</script>') && !html.includes('<img src=x onerror') && !html.includes('<b>Bros</b>') && html.includes('&lt;script&gt;alert(1)') && html.includes('&lt;img src=x onerror=alert(1)&gt;') && html.includes('&amp; &lt;b&gt;Bros&lt;/b&gt;')) pass('unescaped user data escaped (XSS-safe rendering)');
    else fail('unescaped user data escaped', 'raw markup found in final document');
  } else fail('unescaped user data escaped', r.stderr);
}

/* ------------------------------------------------------------------ */
/* 5 · POSITIVE — FINAL AGREEMENT DOCUMENTS (B2 / AI / COMPLETE DRAFT  */
/*     + READY via synthetic resolved register)                        */
/* ------------------------------------------------------------------ */
section('5 · Positive — final Agreement documents (DRAFT x3 + READY)');

const agrCases = [];
if (AI && AI.ok) agrCases.push({ label: 'AI A2', handoff: AI.handoff, proposal: AI.proposal, record: AI.record, id: 'AGR-2026-9302', approved: '1,100' });
else { const err = AI && AI.err ? AI.err : 'fixture prep failed'; fail('AI A2 fixture prep', err); }
if (COMPLETE && COMPLETE.ok) agrCases.push({ label: 'Complete', handoff: COMPLETE.handoff, proposal: COMPLETE.proposal, record: COMPLETE.record, id: 'AGR-2026-9303', approved: '24,000' });
else { const err = COMPLETE && COMPLETE.err ? COMPLETE.err : 'fixture prep failed'; fail('Complete fixture prep', err); }

/* B2 DRAFT from the committed lifecycle handoff pair. */
const b2 = { label: 'B2', handoff: B2_HANDOFF, proposal: B2_PROP, record: B2_REC, id: 'AGR-2026-9104', approved: '5,100' };
agrCases.unshift(b2);

for (const c of agrCases) {
  const r = runGen(['agreement', c.handoff, '--proposal', c.proposal, '--acceptance-record', c.record, '--pdf', '--output', OUT_AGR, '--generated-at', STAMP]);
  if (r.code !== 0) { fail(`${c.label} agreement DRAFT generate`, r.stderr); continue; }
  pass(`${c.label} agreement DRAFT final document generated (HTML + PDF + manifest)`);

  const base = safeAgreementFilename(c.id, '1.0', 'DRAFT').replace(/\.html$/, '');
  const htmlFile = path.join(OUT_AGR, `${base}.html`);
  const html = fs.readFileSync(htmlFile, 'utf8');
  if (html.includes('DRAFT — NOT FOR EXECUTION')) pass(`${c.label} agreement DRAFT banner present`);
  else fail(`${c.label} agreement DRAFT banner`);
  if (!html.includes('READY FOR EXECUTION')) pass(`${c.label} agreement DRAFT no READY banner`);
  else fail(`${c.label} agreement DRAFT no READY banner`);
  const unresolvedMarkers = (html.match(/legal-status">To be confirmed/g) || []).length;
  const resolvedMarkers = (html.match(/legal-status resolved">Covered by an approved Nexora term/g) || []).length;
  if (unresolvedMarkers === 26 && resolvedMarkers === 0) pass(`${c.label} agreement DRAFT marks all 26 provisions unresolved`);
  else fail(`${c.label} agreement DRAFT legal provisions`, `unresolved=${unresolvedMarkers} resolved=${resolvedMarkers}`);
  if (scanTokens(html).length === 0) pass(`${c.label} agreement DRAFT HTML no leftover tokens`);
  else fail(`${c.label} agreement DRAFT HTML no leftover tokens`, scanTokens(html).join(', '));
  if (scanLegacy(html).length === 0) pass(`${c.label} agreement DRAFT HTML no legacy`);
  else fail(`${c.label} agreement DRAFT HTML no legacy`, scanLegacy(html).join('; '));
  if (scanVatAssertions(html).length === 0) pass(`${c.label} agreement DRAFT HTML no VAT claim`);
  else fail(`${c.label} agreement DRAFT HTML no VAT claim`);
  if (scanPathLeakage(html).length === 0) pass(`${c.label} agreement DRAFT HTML no path leakage`);
  else fail(`${c.label} agreement DRAFT HTML no path leakage`);
  if (html.includes(c.id) && html.includes(c.approved)) pass(`${c.label} agreement DRAFT HTML id + approved £${c.approved}`);
  else fail(`${c.label} agreement DRAFT HTML id/approved`);

  const mfFile = path.join(OUT_AGR, `${base}.manifest.json`);
  if (fs.existsSync(mfFile)) {
    const mf = readJson(mfFile);
    if (mf.document_type === 'agreement' && mf.status === 'DRAFT' && mf.generator_schema === 'nexora-agreement/v1' && /^PRP-\d{4}-\d{4}$/.test(mf.source_proposal_id)) pass(`${c.label} agreement DRAFT manifest fields`);
    else fail(`${c.label} agreement DRAFT manifest fields`, JSON.stringify(mf));
  } else fail(`${c.label} agreement DRAFT manifest present`);

  const pdfFile = path.join(OUT_AGR, `${base}.pdf`);
  if (fs.existsSync(pdfFile)) {
    const buf = fs.readFileSync(pdfFile);
    if (buf.slice(0, 5).toString() === '%PDF-') pass(`${c.label} agreement DRAFT PDF magic`);
    else fail(`${c.label} agreement DRAFT PDF magic`);
    const pages = pdfPageCount(buf);
    if (pages > 0) pass(`${c.label} agreement DRAFT PDF page count ${pages}`);
    else fail(`${c.label} agreement DRAFT PDF page count`);
    const txt = extractPdfText(buf);
    if (pdfTextContains(txt, c.id) && pdfTextContains(txt, c.approved)) pass(`${c.label} agreement DRAFT PDF id + approved price (selectable text)`);
    else fail(`${c.label} agreement DRAFT PDF id/approved`);
    if (pdfTextContains(txt, 'DRAFT') && pdfTextContains(txt, 'NOT FOR EXECUTION')) pass(`${c.label} agreement DRAFT PDF DRAFT marker`);
    else fail(`${c.label} agreement DRAFT PDF DRAFT marker`);
    if (scanTokens(txt).length === 0 && scanPathLeakage(txt).length === 0) pass(`${c.label} agreement DRAFT PDF no tokens / no path leakage`);
    else fail(`${c.label} agreement DRAFT PDF tokens/path`);
  } else fail(`${c.label} agreement DRAFT PDF present`);
}

/* READY_FOR_EXECUTION — synthetic resolved register only (mechanism proof). */
const rr = runGen(['agreement', B2_HANDOFF, '--proposal', B2_PROP, '--acceptance-record', B2_REC, '--status', 'READY_FOR_EXECUTION', '--legal-decisions', syntheticResolvedRegister, '--pdf', '--output', OUT_AGR, '--generated-at', STAMP]);
if (rr.code === 0) {
  pass('READY_FOR_EXECUTION gate opens (synthetic resolved register only)');
  const base = safeAgreementFilename('AGR-2026-9104', '1.0', 'READY_FOR_EXECUTION').replace(/\.html$/, '');
  const html = fs.readFileSync(path.join(OUT_AGR, `${base}.html`), 'utf8');
  if (html.includes('READY FOR EXECUTION — NOT YET SIGNED')) pass('READY banner — NOT YET SIGNED');
  else fail('READY banner', 'missing');
  if ((html.match(/legal-status">To be confirmed/g) || []).length === 0 && (html.match(/legal-status resolved">Covered by an approved Nexora term/g) || []).length === 26) pass('READY document has every legal provision resolved');
  else fail('READY resolved provisions', 'unresolved items remain in READY document');
  const signedOutsideBanner = html.replace(/NOT YET SIGNED/g, '').includes('SIGNED');
  if ((html.match(/NOT YET SIGNED/g) || []).length >= 1 && !signedOutsideBanner) pass('READY never claims SIGNED (only "NOT YET SIGNED")');
  else fail('READY no SIGNED claim', `signedOutsideBanner=${signedOutsideBanner}`);
  const pdfFile = path.join(OUT_AGR, `${base}.pdf`);
  if (fs.existsSync(pdfFile)) {
    const txt = extractPdfText(fs.readFileSync(pdfFile));
    if (pdfTextContains(txt, 'READY FOR EXECUTION')) pass('READY PDF carries READY marker');
    else fail('READY PDF READY marker');
  } else fail('READY PDF present');
} else {
  fail('READY_FOR_EXECUTION gate opens', rr.stderr);
}

/* ------------------------------------------------------------------ */
/* 6 · NEGATIVE TESTS (fail closed)                                    */
/* ------------------------------------------------------------------ */
section('6 · Negative tests (fail closed)');

/* 1. unsafe filename */
if (validateDerivedName('../PRP-2026-9999-v1.0.html')) pass('neg · unsafe filename rejected (path traversal)');
else fail('neg · unsafe filename rejected');
if (validateDerivedName('.hidden.html')) pass('neg · leading-dot filename rejected');
else fail('neg · leading-dot filename rejected');

/* 2. path traversal in output dir */
if (assertSafeOutputDir('/tmp')) pass('neg · output outside repo root rejected');
else fail('neg · output outside repo root rejected');
const traversalOut = runGen(['proposal', B2_SAMPLE, '--output', path.join(root, '..', 'evil')]);
if (traversalOut.code !== 0 && /Unsafe output/.test(traversalOut.stderr)) pass('neg · CLI refuses path-traversal --output');
else fail('neg · CLI refuses path-traversal --output', traversalOut.stderr);

/* 3. overwrite without permission */
const owOut = path.join(OUT_PROP, 'overwrite-test');
const ow1 = runGen(['proposal', B2_SAMPLE, '--output', owOut, '--generated-at', STAMP]);
const ow2 = runGen(['proposal', B2_SAMPLE, '--output', owOut, '--generated-at', STAMP]);
if (ow1.code === 0 && ow2.code !== 0 && /overwrite/i.test(ow2.stderr)) pass('neg · refuse overwrite without --overwrite');
else fail('neg · refuse overwrite without --overwrite', ow2.stderr);
const ow3 = runGen(['proposal', B2_SAMPLE, '--output', owOut, '--overwrite', '--generated-at', STAMP]);
if (ow3.code === 0) pass('neg · explicit --overwrite succeeds');
else fail('neg · explicit --overwrite succeeds', ow3.stderr);

/* 4. malformed Proposal input */
const badPropJson = path.join(PROP_TMP, 'malformed-proposal.json');
fs.writeFileSync(badPropJson, '{ not valid json !!!');
const r4 = runGen(['proposal', badPropJson]);
if (r4.code !== 0) pass('neg · malformed Proposal input refused');
else fail('neg · malformed Proposal input refused');

/* 5. invalid Agreement input */
const badHandoffJson = path.join(PROP_TMP, 'malformed-handoff.json');
fs.writeFileSync(badHandoffJson, '{ not valid json !!!');
const r5 = runGen(['agreement', badHandoffJson]);
if (r5.code !== 0) pass('neg · malformed Agreement input refused');
else fail('neg · malformed Agreement input refused');
const bogusHandoff = path.join(PROP_TMP, 'bogus-handoff.json');
writeJson(bogusHandoff, { schema: 'not-a-handoff', status: 'BOGUS', proposal: {} });
const r5b = runGen(['agreement', bogusHandoff]);
if (r5b.code !== 0) pass('neg · invalid Agreement handoff schema refused');
else fail('neg · invalid Agreement handoff schema refused');

/* 6. commercial drift (handoff snapshot vs accepted Proposal) */
const tamperDrift = readJson(B2_HANDOFF);
tamperDrift.commercial_snapshot = { ...tamperDrift.commercial_snapshot, payment_schedule: [50, 25, 25] };
const driftPath = path.join(PROP_TMP, 'drift.handoff.json');
writeJson(driftPath, tamperDrift);
const r6 = runGen(['agreement', driftPath, '--proposal', B2_PROP, '--acceptance-record', B2_REC]);
if (r6.code !== 0) pass('neg · commercial drift refused (upstream Source-of-Truth gate or PROP.6 drift check)');
else fail('neg · commercial drift refused', r6.stderr);
if (/COMMERCIAL DRIFT/.test(cliSrc)) pass('CLI carries a handoff-vs-proposal commercial drift check (defense-in-depth)');
else fail('CLI commercial drift check present');

/* 7-10. legacy Starter / Elite / £250 / AI Care (end-to-end via governed validation) */
for (const [label, phrase] of [['Starter', 'Includes the Starter package'], ['Elite', 'Plus the Elite tier'], ['£250 deposit', 'Pay £250 deposit to secure'], ['AI Care', 'AI Care is included']]) {
  const p = readJson(B2_SAMPLE);
  p.proposal_id = 'PRP-2026-9907';
  p.project = { ...p.project, summary: phrase };
  const f = path.join(PROP_TMP, `neg-${label.replace(/\W+/g, '-').toLowerCase()}.json`);
  writeJson(f, p);
  const r = runGen(['proposal', f]);
  if (r.code !== 0) pass(`neg · legacy ${label} refused`);
  else fail(`neg · legacy ${label} refused`);
}

/* 11. unsupported VAT claim (end-to-end) */
{
  const p = readJson(B2_SAMPLE);
  p.proposal_id = 'PRP-2026-9911';
  p.project = { ...p.project, summary: 'Final price is VAT at 20%' };
  const f = path.join(PROP_TMP, 'neg-vat.json');
  writeJson(f, p);
  const r = runGen(['proposal', f]);
  if (r.code !== 0) pass('neg · unsupported VAT claim refused');
  else fail('neg · unsupported VAT claim refused', r.stderr);
}

/* 12. leftover template token (passes validation, refused at output scan) */
{
  const p = readJson(B2_SAMPLE);
  p.proposal_id = 'PRP-2026-9912';
  p.project = { ...p.project, summary: 'Includes a {{leftover_token}} in the summary' };
  const f = path.join(PROP_TMP, 'neg-token.json');
  writeJson(f, p);
  const r = runGen(['proposal', f]);
  if (r.code !== 0 && /LEFTOVER TEMPLATE TOKENS/.test(r.stderr)) pass('neg · leftover {{token}} refused at output layer');
  else fail('neg · leftover {{token}} refused', r.stderr);
}

/* 13. client file outside allowed private/example path */
const r13 = runGen(['proposal', path.join(root, 'tmp-client-proposal.json')]);
if (r13.code !== 0 && /unsafe input/i.test(r13.stderr)) pass('neg · client file outside allowed paths refused');
else fail('neg · client file outside allowed paths refused', r13.stderr);

/* 14. output outside safe directory (CLI) */
const r14 = runGen(['proposal', B2_SAMPLE, '--output', path.join(root, '..', 'outside')]);
if (r14.code !== 0 && /Unsafe output/.test(r14.stderr)) pass('neg · --output outside safe directory refused');
else fail('neg · --output outside safe directory refused', r14.stderr);

/* 15. status mutation attempt — output layer must never mutate inputs */
{
  const probe = path.join(PROP_TMP, 'status-probe.json');
  const p = readJson(B2_SAMPLE);
  p.proposal_id = 'PRP-2026-9915';
  writeJson(probe, p);
  const before = readJson(probe);
  const r = runGen(['proposal', probe, '--output', OUT_PROP, '--generated-at', STAMP]);
  const after = readJson(probe);
  if (r.code === 0 && after.status === before.status && after.proposal_id === before.proposal_id) pass('neg · generating a final document does NOT mutate Proposal status');
  else fail('neg · status mutation attempt', `before=${before.status} after=${after.status} exit=${r.code}`);
  /* Pure export: the CLI may import only READ-ONLY helpers from the lifecycle
     module (proposalFingerprint / todayISO), never a status mutator. */
  const lifecycleImportBlock = [...cliSrc.matchAll(/import\s*\{([^}]+)\}\s*from\s*['"]\.\.\/proposals\/proposal-lifecycle\.mjs['"]/g)].map((m) => m[1]).join(',');
  const imported = lifecycleImportBlock.split(',').map((s) => s.trim()).filter(Boolean);
  const mutators = ['accept', 'handoff', 'decline', 'expire', 'supersede', 'buildHandoff', 'buildAcceptanceRecord', 'validateLifecycle', 'loadProposal'];
  const leaked = imported.filter((i) => mutators.includes(i));
  if (imported.length > 0 && leaked.length === 0 && imported.every((i) => /^proposalFingerprint$|^todayISO$/.test(i))) pass('neg · output layer imports only read-only lifecycle helpers (pure export)');
  else fail('neg · output layer never calls lifecycle mutators', `imports=${imported.join(', ') || '(none)'} leaked=${leaked.join(', ') || '(none)'}`);
}

/* 16. stale Approved Final Project Price (handoff snapshot drift) */
const tamperPrice = readJson(B2_HANDOFF);
tamperPrice.commercial_snapshot = { ...tamperPrice.commercial_snapshot, approved_final_project_price: 5101 };
const pricePath = path.join(PROP_TMP, 'stale-price.handoff.json');
writeJson(pricePath, tamperPrice);
const r16 = runGen(['agreement', pricePath, '--proposal', B2_PROP, '--acceptance-record', B2_REC]);
if (r16.code !== 0 && /DRIFT/.test(r16.stderr)) pass('neg · stale Approved Final Project Price refused');
else fail('neg · stale Approved Final Project Price refused', r16.stderr);

/* 17. invalid Agreement readiness (no force-ready; unresolved register) */
const r17 = runGen(['agreement', B2_HANDOFF, '--proposal', B2_PROP, '--acceptance-record', B2_REC, '--status', 'READY_FOR_EXECUTION']);
if (r17.code !== 0 && /READY_FOR_EXECUTION/.test(r17.stderr) && /gate|legal decision/.test(r17.stderr)) pass('neg · invalid Agreement readiness refused (no force-ready)');
else fail('neg · invalid Agreement readiness refused', r17.stderr);
const r17b = runGen(['agreement', B2_HANDOFF, '--proposal', B2_PROP, '--acceptance-record', B2_REC, '--status', 'SIGNED']);
if (r17b.code !== 0 && /SIGNED/.test(r17b.stderr)) pass('neg · SIGNED status refused (external gate, not modelled)');
else fail('neg · SIGNED status refused', r17b.stderr);

/* 18. private filesystem path leakage (refused at output scan) */
{
  const p = readJson(B2_SAMPLE);
  p.proposal_id = 'PRP-2026-9918';
  p.project = { ...p.project, summary: 'Details at file:///Users/realuser/private/key' };
  const f = path.join(PROP_TMP, 'neg-pathleak.json');
  writeJson(f, p);
  const r = runGen(['proposal', f]);
  if (r.code !== 0 && /PATH LEAKAGE/.test(r.stderr)) pass('neg · private filesystem path leakage refused');
  else fail('neg · private filesystem path leakage refused', r.stderr);
}

/* ------------------------------------------------------------------ */
/* 7 · PRIVACY + COMMERCIAL DIVERGENCE + CLEANUP                       */
/* ------------------------------------------------------------------ */
section('7 · Privacy + commercial divergence + cleanup');

/* The output layer must not contain any real client data and must not
   diverge from the frozen commercial source. All fixtures are synthetic. */
const coreSrc = fs.readFileSync(CORE, 'utf8');
const bothSrc = coreSrc + '\n' + cliSrc;
if (!/example\.com|Example Aesthetics|PRP-2026-9001|AGR-2026-9104/.test(bothSrc)) pass('output layer contains no real client data (synthetic only)');
else fail('output layer real client data', 'synthetic fixture references found in source (not real data)');

/* 10 validators = the 9 upstream + this PROP.6 validator (full regression is
   run externally; here we confirm this validator is wired into the same shape). */
section('8 · Full regression note');

fs.rmSync(DOC_TMP, { recursive: true, force: true });
fs.rmSync(PROP_TMP, { recursive: true, force: true });
fs.rmSync(AGR_TMP, { recursive: true, force: true });
if (!fs.existsSync(DOC_TMP) && !fs.existsSync(PROP_TMP) && !fs.existsSync(AGR_TMP)) pass('temporary test data removed (gitignored locations)');
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
console.log(`\n${passed}/${checks.filter((c) => !c.text.startsWith('──')).length} document-output checks passed`);
if (failures.length > 0) {
  console.log(`\nFAILURES (${failures.length}):`);
  for (const f of failures) console.log(`  FAIL ${f}`);
  process.exit(1);
}
console.log('ALL DOCUMENT-OUTPUT CHECKS PASSED');
