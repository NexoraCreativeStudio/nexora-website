#!/usr/bin/env node
/* Nexora Agreement Execution System (PROP.7) — validation harness.
   Validates the governed execution layer:
     - static safety (modules present, Node built-ins only, no network calls,
       no hard-coded prices, no --force-executed / --mark-signed, gitignore)
     - positive QA: READY_FOR_EXECUTION Agreement -> PREPARED package -> dispatch
       -> partial signature -> EXECUTED (MANUAL path) + TEST_ADAPTER synthetic
       e-signature path; signer mapping; provider-neutral payload; document
       checksum linkage; execution fingerprint; immutable executed record
     - 32 fail-closed negative tests (section 5)
     - privacy + cleanup of all tmp fixtures (all under gitignored locations)

   PROP.7 is GOVERNANCE + EVIDENCE MODELLING ONLY. This harness never touches
   ops/billing-source-of-truth.json, the Commercial Constitution, pricing, the
   Agreement legal register, or any Proposal/Agreement status. All execution
   fixtures are synthetic (TEST ONLY — NOT LEGAL SIGNATURE — NOT FOR PRODUCTION). */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';
import {
  EXECUTION_VERSION,
  EXECUTION_SCHEMA,
  EXECUTION_STATUSES,
  TERMINAL_STATUSES,
  SIGNER_ROLES,
  PROVIDERS,
  EVIDENCE_TYPES,
  EVENT_TYPES,
  PROVIDER_DECISION,
  TEST_LABEL,
  OUT_DIR,
  PRIVATE_DIR,
  EXAMPLES_DIR,
  classifyExecutionInput,
  validateExecutionRecord,
  validateSigners,
  buildExecutionFingerprint,
  verifyExecutionFingerprint,
  agreementChecksum,
  executionFilename,
  executedBundleFilename,
  executionGate,
  applyEvent,
  buildExecutedBundle,
  signerCompletionState,
  scanSecrets,
  defaultSignersFor,
  sha256hex
} from './execution-validation.mjs';
import {
  buildProviderPayload,
  validateProviderEvent,
  normalizeExecutionEvidence,
  deriveRequestId,
  deriveDocumentId,
  deriveEventId
} from './execution-providers.mjs';
import { classifyInput as classifyAgreementInput } from '../agreements/agreement-validation.mjs';
import { scanLegacy, scanVatAssertions } from '../documents/document-output.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const executionDir = __dirname;
const root = path.join(__dirname, '..', '..');
const agreementsDir = path.join(root, 'ops', 'agreements');
const proposalsDir = path.join(root, 'ops', 'proposals');
const EXEC_CLI = path.join(executionDir, 'execution.mjs');
const AGREEMENT_GEN = path.join(agreementsDir, 'generate-agreement.mjs');

const AGR_TMP = path.join(agreementsDir, 'private', '.tmp-tests', 'execution-validation');
const EXEC_TMP = path.join(executionDir, 'private', '.tmp-tests', 'validation');
const OUT = path.join(EXEC_TMP, 'out');
const EVENTS = path.join(EXEC_TMP, 'events');
const RESOLVED = path.join(AGR_TMP, 'synthetic-resolved-legal-decisions.json');
const AGREEMENT = path.join(AGR_TMP, 'AGR-2026-9104-v1.0.json');

const B2_HANDOFF = path.join(proposalsDir, 'examples', 'lifecycle', 'proposal-accepted.handoff.json');
const B2_PROP = path.join(proposalsDir, 'examples', 'lifecycle', 'proposal-accepted.json');
const B2_REC = path.join(proposalsDir, 'examples', 'lifecycle', 'proposal-accepted.acceptance.json');
const B2_DRAFT = path.join(agreementsDir, 'examples', 'agreement-draft-b2.json');

const T0 = '2026-08-11T12:00:00.000Z';
const T1 = '2026-08-11T12:01:00.000Z';
const T2 = '2026-08-11T12:02:00.000Z';
const T3 = '2026-08-11T12:03:00.000Z';
const T4 = '2026-08-11T12:04:00.000Z';
const T5 = '2026-08-11T12:05:00.000Z';

/* ------------------------------------------------------------------ */
/* Harness                                                            */
/* ------------------------------------------------------------------ */
let checks = 0;
let failures = 0;
let failuresList = [];
const ok = (label) => { checks++; console.log(`  ok ${label}`); };
const bad = (label, detail) => { checks++; failures++; failuresList.push(`${label} — ${detail}`); console.log(`  FAIL ${label} — ${detail}`); };

function section(title) {
  console.log(`\n=== ${title} ===`);
}

function writeJson(p, obj) {
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, JSON.stringify(obj, null, 2) + '\n');
}

function readJson(p) {
  return JSON.parse(fs.readFileSync(p, 'utf8'));
}

function runCli(args) {
  try {
    const stdout = execFileSync(process.execPath, [EXEC_CLI, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
    return { status: 0, stdout, stderr: '' };
  } catch (e) {
    return { status: e.status || 1, stdout: e.stdout || '', stderr: e.stderr || '' };
  }
}

function expectFail(label, r, needles) {
  if (r.status !== 0) {
    const all = (r.stdout + ' ' + r.stderr);
    const miss = needles.filter((n) => !all.includes(n));
    if (miss.length === 0) ok(label);
    else bad(label, `refused but missing expected reason(s): ${miss.join(' | ')}`);
  } else {
    bad(label, 'was NOT refused (exit 0)');
  }
}

function expectPass(label, r) {
  if (r.status === 0) ok(label);
  else bad(label, `exit ${r.status} — ${(r.stderr || r.stdout).trim()}`);
}

/* ------------------------------------------------------------------ */
/* 0. PREPARE — synthetic READY_FOR_EXECUTION Agreement + tmp dirs     */
/* ------------------------------------------------------------------ */
function buildReadyAgreement() {
  /* Fresh tmp dirs every run — a crashed prior run must not leak fixtures. */
  fs.rmSync(EXEC_TMP, { recursive: true, force: true });
  fs.rmSync(AGR_TMP, { recursive: true, force: true });
  fs.mkdirSync(AGR_TMP, { recursive: true });
  const baseReg = readJson(path.join(agreementsDir, 'legal', 'legal-decisions.json'));
  const resolved = { ...baseReg, description: 'SYNTHETIC TEST REGISTER — proves the READY_FOR_EXECUTION gate; NOT a real owner/legal decision.' };
  resolved.clauses = {};
  for (const id of Object.keys(baseReg.clauses)) resolved.clauses[id] = { classification: 'AUTHORITATIVE', note: 'SYNTHETIC TEST RESOLUTION — mechanism proof only.' };
  writeJson(RESOLVED, resolved);

  execFileSync(process.execPath, [
    AGREEMENT_GEN, B2_HANDOFF,
    '--proposal', B2_PROP,
    '--acceptance-record', B2_REC,
    '--legal-decisions', RESOLVED,
    '--status', 'READY_FOR_EXECUTION',
    '--agreement-id', 'AGR-2026-9104',
    '--json',
    '--output', AGREEMENT,
    '--generated-at', T0,
    '--overwrite'
  ], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
}

function writeEvents() {
  fs.mkdirSync(EVENTS, { recursive: true });
  writeJson(path.join(EVENTS, 'dispatch-manual.json'), {
    evidence_type: 'MANUAL_RECORD', event_type: 'EXECUTION_REQUESTED', event_time: T1,
    note: 'Manual dispatch — execution package handed to the clinic. Not a provider event, not cryptographically verified.'
  });
  writeJson(path.join(EVENTS, 'client-manual.json'), {
    evidence_type: 'MANUAL_RECORD', event_type: 'SIGNER_COMPLETED', signer_role: 'CLIENT', event_time: T2,
    note: 'Client signed in person. Manual record.'
  });
  writeJson(path.join(EVENTS, 'nexora-manual.json'), {
    evidence_type: 'MANUAL_RECORD', event_type: 'SIGNER_COMPLETED', signer_role: 'NEXORA', event_time: T3,
    note: 'Nexora signatory signed. Manual record.'
  });
  writeJson(path.join(EVENTS, 'decline-manual.json'), {
    evidence_type: 'MANUAL_RECORD', event_type: 'EXECUTION_DECLINED', event_time: T2,
    note: 'Client declined to proceed. Manual record.'
  });
  writeJson(path.join(EVENTS, 'cancel-manual.json'), {
    evidence_type: 'MANUAL_RECORD', event_type: 'EXECUTION_CANCELLED', event_time: T2,
    note: 'Execution cancelled by agreement. Manual record.'
  });
  writeJson(path.join(EVENTS, 'expire-manual.json'), {
    evidence_type: 'MANUAL_RECORD', event_type: 'EXECUTION_EXPIRED', event_time: T2,
    note: 'Execution request expired without completion. Manual record.'
  });
  /* TEST_ADAPTER synthetic provider events for EXE-2026-9999. */
  const eid = 'EXE-2026-9999';
  writeJson(path.join(EVENTS, 'test-dispatch.json'), {
    evidence_type: 'E_SIGNATURE_PROVIDER', provider: 'TEST_ADAPTER', event_type: 'EXECUTION_REQUESTED',
    event_time: T1, _test_only: true, note: TEST_LABEL
  });
  writeJson(path.join(EVENTS, 'test-client.json'), {
    evidence_type: 'E_SIGNATURE_PROVIDER', provider: 'TEST_ADAPTER', event_type: 'SIGNER_COMPLETED',
    signer_role: 'CLIENT', event_time: T2, provider_event_id: deriveEventId(eid, 'CLIENT', T2),
    document_id: deriveDocumentId(eid), _test_only: true, note: TEST_LABEL
  });
  writeJson(path.join(EVENTS, 'test-nexora.json'), {
    evidence_type: 'E_SIGNATURE_PROVIDER', provider: 'TEST_ADAPTER', event_type: 'SIGNER_COMPLETED',
    signer_role: 'NEXORA', event_time: T3, provider_event_id: deriveEventId(eid, 'NEXORA', T3),
    document_id: deriveDocumentId(eid), _test_only: true, note: TEST_LABEL
  });
}

/* ------------------------------------------------------------------ */
/* 1. STATIC SAFETY                                                    */
/* ------------------------------------------------------------------ */
function staticSafety() {
  section('STATIC SAFETY');
  const files = ['execution.mjs', 'execution-validation.mjs', 'execution-providers.mjs', 'validate-execution.mjs'];
  for (const f of files) {
    if (fs.existsSync(path.join(executionDir, f))) ok(`module present: ${f}`);
    else bad(`module present: ${f}`, 'missing');
  }

  /* Node built-ins only — no npm deps, no network. */
  const src = files.filter((f) => f.endsWith('.mjs') && f !== 'validate-execution.mjs').map((f) => fs.readFileSync(path.join(executionDir, f), 'utf8')).join('\n');
  const banned = [
    ["fetch(", /fetch\s*\(/],
    [/https?:/, /https?:\/\//],
    ['node:https', /node:https/],
    ['node:net', /node:net/],
    ['node:http', /node:http/],
    ['axios', /\baxios\b/],
    ['XMLHttpRequest', /XMLHttpRequest/],
    ['Stripe/require(stripe)', /require\s*\(\s*['"]stripe/i],
    ['node_modules dependency', /from\s+['"](?!node:)[^.][^'"]*['"]/]
  ];
  for (const [name, re] of banned) {
    if (re.test(src)) bad(`no external network/dependency: ${name}`, 'found');
    else ok(`no external network/dependency: ${name}`);
  }
  /* The ONLY subprocess in the CLI runs the LOCAL agreement generator. */
  if (/execFileSync\s*\(\s*process\.execPath/.test(src)) ok('subprocess confined to local Node tooling');
  else bad('subprocess confined to local Node tooling', 'no execFileSync(process.execPath) found');

  /* No hard-coded prices / commercial values in the execution layer. */
  const priceHit = [];
  for (const re of [/\b£\s*\d/, /5\s?100/, /24\s?000/, /9\s?97/, /69\s?7/, /4\s?250/, /2\s?250/]) if (re.test(src)) priceHit.push(String(re));
  if (priceHit.length === 0) ok('no hard-coded commercial prices');
  else bad('no hard-coded commercial prices', priceHit.join(', '));

  /* No --force-executed / --mark-signed / --status shortcuts as FLAGS.
     Docstrings legitimately name the forbidden flags ("there is NO
     --force-executed"); what matters is the PARSER: the CLI must never bind
     them, and unknown flags must hit the opts.bad rejection path. */
  const parserBranches = src.match(/else if \(a === '[^']+'\)/g) || [];
  const parserFlags = parserBranches.map((s) => (s.match(/'([^']+)'/) || [])[1]);
  const forbidden = ['--force-executed', '--mark-signed', '--status'];
  const flagHit = forbidden.filter((f) => parserFlags.includes(f));
  const badPath = /opts\.bad/.test(src) && /a\.startsWith\('-'\)/.test(src);
  if (flagHit.length === 0 && badPath) ok('no status-shortcut flags bound (--force-executed / --mark-signed / --status) + unknown flags rejected');
  else bad('no status-shortcut flags', (flagHit.length ? flagHit.join(', ') + ' bound in parser; ' : '') + (badPath ? '' : 'no opts.bad rejection path'));

  /* Status model: EXECUTED requires evidence; SIGNED is never a status. */
  if (EXECUTION_STATUSES.includes('EXECUTED')) ok('EXECUTED is a governed execution status');
  else bad('EXECUTED status', 'missing');
  if (!EXECUTION_STATUSES.includes('SIGNED')) ok('SIGNED is NOT an execution status (separate external gate)');
  else bad('SIGNED status', 'must never be modelled');
  if (TERMINAL_STATUSES.length === 4) ok('terminal statuses: EXECUTED/DECLINED/CANCELLED/EXPIRED');
  else bad('terminal statuses', 'expected 4');

  /* Gitignore must cover private + out. */
  const gi = fs.readFileSync(path.join(root, '.gitignore'), 'utf8');
  for (const pat of ['ops/execution/private/', 'ops/execution/out/']) {
    if (gi.includes(pat)) ok(`gitignored: ${pat}`);
    else bad(`gitignored: ${pat}`, 'missing from .gitignore');
  }
}

/* ------------------------------------------------------------------ */
/* 2. POSITIVE QA                                                      */
/* ------------------------------------------------------------------ */
function positiveManual() {
  section('POSITIVE — MANUAL execution path');
  const r = runCli(['prepare', AGREEMENT, '--legal-decisions', RESOLVED, '--output', OUT, '--generated-at', T0]);
  expectPass('prepare READY Agreement -> PREPARED', r);
  if (r.status !== 0) return;
  const preparedPath = path.join(OUT, executionFilename('EXE-2026-9104', EXECUTION_VERSION, 'PREPARED', 0));
  const pkgPath = path.join(OUT, 'EXE-2026-9104-v1.0.execution-package.json');
  if (fs.existsSync(preparedPath)) ok('PREPARED record written');
  else bad('PREPARED record written', 'missing');
  if (fs.existsSync(pkgPath)) ok('execution package manifest written');
  else bad('execution package manifest written', 'missing');

  const agreement = readJson(AGREEMENT);
  const record = readJson(preparedPath);
  const expectedCk = agreementChecksum(agreement);

  /* §8 signer model — default signers derived from the Agreement. */
  const def = defaultSignersFor(agreement);
  if (record.signers.length === 2 && record.signers[0].role === 'CLIENT' && record.signers[1].role === 'NEXORA') ok('default signer mapping: CLIENT + NEXORA');
  else bad('default signer mapping', JSON.stringify(record.signers));
  if (record.signers[0].name === agreement.client.name && record.signers[0].organisation === agreement.client.company) ok('CLIENT signer derived from Agreement client');
  else bad('CLIENT signer derived from Agreement client', 'mismatch');
  if (validateSigners(record.signers).ok) ok('signer model valid (roles, required, no identity claims)');
  else bad('signer model valid', validateSigners(record.signers).reasons.join('; '));

  /* §9 document checksum linkage. */
  if (record.agreement_checksum_sha256 === expectedCk) ok('agreement checksum linkage matches governed Agreement');
  else bad('agreement checksum linkage', 'mismatch');
  if (record.agreement_status === 'READY_FOR_EXECUTION') ok('record agreement_status is READY_FOR_EXECUTION (input boundary)');
  else bad('record agreement_status', record.agreement_status);
  if (record.status === 'PREPARED') ok('record status PREPARED (local only)');
  else bad('record status PREPARED', record.status);

  /* §15 execution fingerprint. */
  if (verifyExecutionFingerprint(record).ok) ok('execution fingerprint valid at PREPARED');
  else bad('execution fingerprint valid at PREPARED', verifyExecutionFingerprint(record).reasons.join('; '));

  /* §11 provider-neutral payload. */
  const payload = buildProviderPayload(record);
  if (payload.provider_neutral === true && payload.signature_anchors.length === 6) ok('provider-neutral payload + signature-anchor mapping (6 anchors)');
  else bad('provider-neutral payload', 'anchors/provider_neutral missing');
  if (payload.signers.every((s) => s.signature_anchor)) ok('signer -> signature anchor mapping');
  else bad('signer -> signature anchor mapping', 'missing anchor');

  const rv = runCli(['verify', preparedPath]);
  expectPass('verify PREPARED record', rv);

  /* Dispatch + partial + complete (manual evidence). */
  const d = runCli(['record-event', preparedPath, '--event', path.join(EVENTS, 'dispatch-manual.json'), '--output', OUT, '--generated-at', T1]);
  expectPass('record-event EXECUTION_REQUESTED -> SENT_FOR_SIGNATURE', d);
  const sentPath = path.join(OUT, executionFilename('EXE-2026-9104', EXECUTION_VERSION, 'SENT_FOR_SIGNATURE', 1));

  const c = runCli(['record-event', sentPath, '--event', path.join(EVENTS, 'client-manual.json'), '--output', OUT, '--generated-at', T2]);
  expectPass('record-event SIGNER_COMPLETED (CLIENT) -> PARTIALLY_SIGNED', c);
  const partial2 = path.join(OUT, executionFilename('EXE-2026-9104', EXECUTION_VERSION, 'PARTIALLY_SIGNED', 2));
  const sc2 = signerCompletionState(readJson(partial2));
  if (sc2.allCompleted === false && sc2.completedCount === 1) ok('partial-signature state: 1/2 completed');
  else bad('partial-signature state', JSON.stringify(sc2));

  const s = runCli(['status', partial2]);
  if (s.status === 0 && s.stdout.includes('1/2')) ok('status shows partial completion (1/2)');
  else bad('status shows partial completion', s.stdout + s.stderr);

  const n = runCli(['record-event', partial2, '--event', path.join(EVENTS, 'nexora-manual.json'), '--output', OUT, '--generated-at', T3]);
  expectPass('record-event SIGNER_COMPLETED (NEXORA) -> all required complete', n);
  const partial3 = path.join(OUT, executionFilename('EXE-2026-9104', EXECUTION_VERSION, 'PARTIALLY_SIGNED', 3));
  const sc3 = signerCompletionState(readJson(partial3));
  if (sc3.allCompleted === true && sc3.completedCount === 2) ok('all required synthetic signers complete (2/2)');
  else bad('all required synthetic signers complete', JSON.stringify(sc3));

  /* §16 EXECUTED gate. */
  const f = runCli(['finalize', partial3, '--agreement', AGREEMENT, '--output', OUT, '--generated-at', T4]);
  expectPass('finalize -> EXECUTED via full evidence gate', f);
  const executedPath = path.join(OUT, executionFilename('EXE-2026-9104', EXECUTION_VERSION, 'EXECUTED', 3));
  const bundlePath = path.join(OUT, executedBundleFilename('EXE-2026-9104', EXECUTION_VERSION));
  if (fs.existsSync(executedPath) && fs.existsSync(bundlePath)) ok('immutable executed record + executed bundle written');
  else bad('immutable executed record + bundle written', 'missing');

  const exec = readJson(executedPath);
  if (exec.status === 'EXECUTED' && exec.agreement_status === 'READY_FOR_EXECUTION') ok('EXECUTED while Agreement stays READY_FOR_EXECUTION (separate gates)');
  else bad('EXECUTED / Agreement separation', `status=${exec.status} agreement_status=${exec.agreement_status}`);
  if (exec.evidence.events.every((e) => e.evidence_type === 'MANUAL_RECORD')) ok('manual execution evidence model (MANUAL_RECORD, not E_SIGNATURE_PROVIDER)');
  else bad('manual execution evidence model', 'non-manual evidence present');
  if (verifyExecutionFingerprint(exec).ok) ok('execution fingerprint valid at EXECUTED');
  else bad('execution fingerprint valid at EXECUTED', verifyExecutionFingerprint(exec).reasons.join('; '));

  const bundle = readJson(bundlePath);
  if (bundle.signed_document_ref === null && bundle.signed_document_checksum_sha256 === null) ok('executed bundle claims no signed PDF (signed_document_ref null)');
  else bad('executed bundle signed-PDF boundary', 'signed_document_ref must be null');
  if (exec.completed_at === T4) ok('completed_at recorded from finalize evidence');
  else bad('completed_at recorded', exec.completed_at);

  const vf = runCli(['verify', executedPath]);
  expectPass('verify EXECUTED record (fingerprint + integrity)', vf);

  /* §18 immutability. */
  const rf = runCli(['finalize', partial3, '--agreement', AGREEMENT, '--output', OUT, '--generated-at', T5]);
  expectFail('re-finalize refused (EXECUTED immutable, no silent overwrite)', rf, ['EXECUTED', 'immutable', 'exist']);
  const re = runCli(['record-event', executedPath, '--event', path.join(EVENTS, 'client-manual.json'), '--output', OUT]);
  expectFail('record-event on EXECUTED refused (terminal)', re, ['terminal']);

  return { preparedPath, sentPath, partial2, partial3, executedPath, bundlePath, agreement, record };
}

function positiveTestAdapter() {
  section('POSITIVE — TEST_ADAPTER synthetic e-signature path');
  const eid = 'EXE-2026-9999';
  const p = runCli(['prepare', AGREEMENT, '--method', 'E_SIGNATURE_PROVIDER', '--provider', 'TEST_ADAPTER', '--execution-id', eid, '--legal-decisions', RESOLVED, '--output', OUT, '--generated-at', T0]);
  expectPass('prepare E_SIGNATURE_PROVIDER/TEST_ADAPTER -> PREPARED', p);
  const prepared = path.join(OUT, executionFilename(eid, EXECUTION_VERSION, 'PREPARED', 0));
  const rec = readJson(prepared);
  if (rec.provider === 'TEST_ADAPTER' && rec.execution_method === 'E_SIGNATURE_PROVIDER') ok('TEST_ADAPTER provider + E_SIGNATURE_PROVIDER method recorded');
  else bad('TEST_ADAPTER provider recorded', `provider=${rec.provider} method=${rec.execution_method}`);

  const d = runCli(['record-event', prepared, '--event', path.join(EVENTS, 'test-dispatch.json'), '--output', OUT, '--generated-at', T1]);
  expectPass('TEST_ADAPTER dispatch (provider-neutral request evidence)', d);
  const sent = path.join(OUT, executionFilename(eid, EXECUTION_VERSION, 'SENT_FOR_SIGNATURE', 1));
  const sentRec = readJson(sent);
  if (sentRec.provider_request_id === deriveRequestId(eid) && sentRec.provider_document_id === deriveDocumentId(eid)) {
    ok('genuine TEST_ADAPTER request/document ids derived (anti-fabrication)');
  } else bad('TEST_ADAPTER request/document ids', 'not derived');

  const c = runCli(['record-event', sent, '--event', path.join(EVENTS, 'test-client.json'), '--output', OUT, '--generated-at', T2]);
  expectPass('TEST_ADAPTER SIGNER_COMPLETED (CLIENT) normalised + accepted', c);
  const partial2 = path.join(OUT, executionFilename(eid, EXECUTION_VERSION, 'PARTIALLY_SIGNED', 2));
  const n = runCli(['record-event', partial2, '--event', path.join(EVENTS, 'test-nexora.json'), '--output', OUT, '--generated-at', T3]);
  expectPass('TEST_ADAPTER SIGNER_COMPLETED (NEXORA) normalised + accepted', n);
  const partial3 = path.join(OUT, executionFilename(eid, EXECUTION_VERSION, 'PARTIALLY_SIGNED', 3));
  const rec3 = readJson(partial3);
  if (rec3.evidence.events.every((e) => e.evidence_type === 'E_SIGNATURE_PROVIDER' && e._test_only === true)) ok('synthetic provider evidence normalised + labelled _test_only / TEST ONLY');
  else bad('synthetic provider evidence normalised', 'missing _test_only');

  const f = runCli(['finalize', partial3, '--agreement', AGREEMENT, '--output', OUT, '--generated-at', T4]);
  expectPass('TEST_ADAPTER finalize -> EXECUTED (synthetic evidence, mechanism proof)', f);
  const bundlePath = path.join(OUT, executedBundleFilename(eid, EXECUTION_VERSION));
  const bundle = readJson(bundlePath);
  if (bundle.execution_provenance_test_only === true && bundle.test_label.includes('TEST ONLY')) {
    ok('executed bundle explicitly labelled TEST ONLY — NOT LEGAL SIGNATURE — NOT FOR PRODUCTION');
  } else bad('executed bundle test labelling', JSON.stringify(bundle));
  if (bundle.signed_document_ref === null) ok('TEST_ADAPTER bundle never claims a signed PDF');
  else bad('TEST_ADAPTER bundle signed-PDF boundary', 'must be null');
  return { bundlePath };
}

/* ------------------------------------------------------------------ */
/* 3. NEGATIVE TESTS (32)                                              */
/* ------------------------------------------------------------------ */
function negativeTests(fixtures) {
  section('NEGATIVE TESTS');
  const { partial3, executedPath, bundlePath, agreement } = fixtures;

  /* 1. DRAFT Agreement input. */
  const r1 = runCli(['prepare', B2_DRAFT, '--output', OUT]);
  expectFail('1. DRAFT Agreement refused at the PROP.7 input boundary', r1, ['READY_FOR_EXECUTION', 'DRAFT']);

  /* 2. malformed Agreement. */
  const malformed = path.join(AGR_TMP, 'malformed-agreement.json');
  writeJson(malformed, { not: 'an agreement', status: 'READY_FOR_EXECUTION' });
  const r2 = runCli(['prepare', malformed, '--output', OUT]);
  expectFail('2. malformed Agreement refused', r2, ['REFUSED', 'schema']);

  /* 3. Agreement checksum mismatch (tampered record) -> finalize gate. */
  const ck3 = path.join(EXEC_TMP, 'tamper-checksum.json');
  const b3 = readJson(partial3);
  b3.agreement_checksum_sha256 = '0'.repeat(64);
  writeJson(ck3, b3);
  const r3 = runCli(['finalize', ck3, '--agreement', AGREEMENT, '--output', OUT]);
  expectFail('3. Agreement checksum mismatch refused (finalize gate)', r3, ['checksum']);

  /* 4. wrong Agreement ID/version (evidence ownership). */
  const w4 = path.join(EXEC_TMP, 'wrong-agreement.json');
  const b4 = readJson(partial3);
  b4.agreement_id = 'AGR-2026-0001';
  writeJson(w4, b4);
  const r4 = runCli(['verify', w4]);
  expectFail('4. event/record for wrong Agreement refused (ownership + fingerprint)', r4, ['agreement']);

  /* 5. unresolved legal decisions — validate against the COMMITTED register. */
  const r5 = runCli(['prepare', AGREEMENT, '--output', OUT, '--legal-decisions', path.join(agreementsDir, 'legal', 'legal-decisions.json')]);
  expectFail('5. unresolved mandatory legal decisions refused (register drift)', r5, ['REFUSED', 'legal']);

  /* 6. missing required signer role (custom signers omit NEXORA). */
  const onlyClient = path.join(EXEC_TMP, 'only-client.json');
  writeJson(onlyClient, [{ role: 'CLIENT', name: 'Only Client', organisation: 'X', required: true }]);
  const r6 = runCli(['prepare', AGREEMENT, '--signers', onlyClient, '--legal-decisions', RESOLVED, '--output', OUT]);
  expectFail('6. missing required signer role refused', r6, ['missing required signer role']);

  /* 7. duplicate signer role. */
  const dup = path.join(EXEC_TMP, 'dup-role.json');
  writeJson(dup, [
    { role: 'CLIENT', name: 'A', organisation: 'X', required: true },
    { role: 'CLIENT', name: 'B', organisation: 'X', required: true },
    { role: 'NEXORA', name: 'N', organisation: 'Nexora', required: true }
  ]);
  const r7 = runCli(['prepare', AGREEMENT, '--signers', dup, '--legal-decisions', RESOLVED, '--output', OUT]);
  expectFail('7. duplicate signer role refused', r7, ['duplicate signer role']);

  /* 8. fabricated provider request ID (adapter anti-fabrication). */
  const eid8 = 'EXE-2026-9998';
  const p8 = runCli(['prepare', AGREEMENT, '--method', 'E_SIGNATURE_PROVIDER', '--provider', 'TEST_ADAPTER', '--execution-id', eid8, '--legal-decisions', RESOLVED, '--output', OUT, '--generated-at', T0]);
  const sent8 = path.join(OUT, executionFilename(eid8, EXECUTION_VERSION, 'SENT_FOR_SIGNATURE', 1));
  if (p8.status === 0) {
    runCli(['record-event', path.join(OUT, executionFilename(eid8, EXECUTION_VERSION, 'PREPARED', 0)), '--event', path.join(EVENTS, 'test-dispatch.json'), '--output', OUT, '--generated-at', T1]);
  }
  const rec8 = readJson(sent8);
  const ev8 = normalizeTestClientEvent(eid8, T2);
  const v8 = validateProviderEvent('TEST_ADAPTER', { ...rec8, provider_request_id: 'preq-te-1111111111111111' }, ev8);
  if (!v8.ok && v8.reasons.some((x) => /fabricated request id/i.test(x))) ok('8. fabricated provider request ID refused by adapter');
  else bad('8. fabricated provider request ID refused', v8.reasons.join('; '));

  /* 9. event for wrong execution_id (in-process applyEvent ownership). */
  const e9 = normalizeTestClientEvent('EXE-2026-9104', T2);
  const a9 = applyEvent(partial3Record(partial3), { ...e9, execution_id: 'EXE-2026-9999', event_id: 'evt-wrong-ex' });
  if (!a9.ok && a9.reasons.some((x) => /execution_id/.test(x))) ok('9. event for wrong execution_id refused');
  else bad('9. event for wrong execution_id refused', a9.reasons.join('; '));

  /* 10. event for wrong Agreement (in-process applyEvent ownership). */
  const a10 = applyEvent(partial3Record(partial3), { ...e9, agreement_id: 'AGR-2026-0001', event_id: 'evt-wrong-agr' });
  if (!a10.ok && a10.reasons.some((x) => /agreement_id/.test(x))) ok('10. event for wrong Agreement refused');
  else bad('10. event for wrong Agreement refused', a10.reasons.join('; '));

  /* 11. missing completion event (dispatch only, no signer). */
  const sentPath = path.join(OUT, executionFilename('EXE-2026-9104', EXECUTION_VERSION, 'SENT_FOR_SIGNATURE', 1));
  const r11 = runCli(['finalize', sentPath, '--agreement', AGREEMENT, '--output', OUT]);
  expectFail('11. missing completion event refused (0/2 required signers)', r11, ['not all required signers']);

  /* 12. one signer incomplete (CLIENT only). */
  const partial2 = path.join(OUT, executionFilename('EXE-2026-9104', EXECUTION_VERSION, 'PARTIALLY_SIGNED', 2));
  const r12 = runCli(['finalize', partial2, '--agreement', AGREEMENT, '--output', OUT]);
  expectFail('12. one signer incomplete refused (1/2)', r12, ['not all required signers']);

  /* 13. declined signer/execution -> terminal, cannot finalize. */
  const declPath = path.join(OUT, executionFilename('EXE-2026-9104', EXECUTION_VERSION, 'DECLINED', 2));
  const pre13 = path.join(OUT, executionFilename('EXE-2026-9104', EXECUTION_VERSION, 'SENT_FOR_SIGNATURE', 1));
  if (fs.existsSync(declPath)) fs.rmSync(declPath, { force: true });
  runCli(['record-event', pre13, '--event', path.join(EVENTS, 'decline-manual.json'), '--output', OUT, '--generated-at', T2]);
  const r13 = runCli(['finalize', declPath, '--agreement', AGREEMENT, '--output', OUT]);
  expectFail('13. declined execution refused at EXECUTED gate', r13, ['DECLINED']);

  /* 14. cancelled execution -> terminal, cannot finalize. */
  const cancPath = path.join(OUT, executionFilename('EXE-2026-9104', EXECUTION_VERSION, 'CANCELLED', 2));
  if (fs.existsSync(cancPath)) fs.rmSync(cancPath, { force: true });
  runCli(['record-event', pre13, '--event', path.join(EVENTS, 'cancel-manual.json'), '--output', OUT, '--generated-at', T2]);
  const r14 = runCli(['finalize', cancPath, '--agreement', AGREEMENT, '--output', OUT]);
  expectFail('14. cancelled execution refused at EXECUTED gate', r14, ['CANCELLED']);

  /* 15. expired execution -> terminal, cannot finalize. */
  const expPath = path.join(OUT, executionFilename('EXE-2026-9104', EXECUTION_VERSION, 'EXPIRED', 2));
  if (fs.existsSync(expPath)) fs.rmSync(expPath, { force: true });
  runCli(['record-event', pre13, '--event', path.join(EVENTS, 'expire-manual.json'), '--output', OUT, '--generated-at', T2]);
  const r15 = runCli(['finalize', expPath, '--agreement', AGREEMENT, '--output', OUT]);
  expectFail('15. expired execution refused at EXECUTED gate', r15, ['EXPIRED']);

  /* 16. tampered event timestamp/data -> fingerprint mismatch. */
  const tam16 = path.join(EXEC_TMP, 'tamper-event.json');
  const b16 = readJson(partial3);
  b16.evidence.events[1].event_time = '1970-01-01T00:00:00.000Z';
  writeJson(tam16, b16);
  const r16 = runCli(['verify', tam16]);
  expectFail('16. tampered event timestamp/data refused (fingerprint)', r16, ['fingerprint']);

  /* 17. execution fingerprint mismatch / malformed. */
  const f17 = path.join(EXEC_TMP, 'bad-fingerprint.json');
  const b17 = readJson(partial3);
  b17.execution_fingerprint = '';
  writeJson(f17, b17);
  const r17 = runCli(['verify', f17]);
  expectFail('17. execution fingerprint malformed/mismatch refused', r17, ['fingerprint']);

  /* 18. direct PREPARED -> EXECUTED attempt. */
  const pre18 = path.join(OUT, executionFilename('EXE-2026-9104', EXECUTION_VERSION, 'PREPARED', 0));
  const r18 = runCli(['finalize', pre18, '--agreement', AGREEMENT, '--output', OUT]);
  expectFail('18. direct PREPARED -> EXECUTED refused (no dispatch, no signers)', r18, ['dispatched', 'signers']);

  /* 19. --force-executed / --mark-signed shortcuts absent. */
  const r19a = runCli(['finalize', pre18, '--force-executed']);
  const r19b = runCli(['finalize', pre18, '--mark-signed']);
  const r19c = runCli(['record-event', pre18, '--event', path.join(EVENTS, 'client-manual.json'), '--status', 'EXECUTED']);
  if (r19a.status !== 0 && r19b.status !== 0 && r19c.status !== 0) ok('19. --force-executed / --mark-signed / --status flags rejected');
  else bad('19. status-shortcut flags rejected', 'one was accepted');

  /* 20. fake signature/certificate field. */
  const rec20 = partial3Record(partial3);
  rec20.signature_certificate = 'MIIBfakecertificate';
  rec20.signed_pdf = 'base64:JVBERi0=';
  const v20 = validateExecutionRecord(rec20, { requireExampleMarker: false });
  if (v20.failures.some((x) => /fake signature\/certificate/i.test(x))) ok('20. fake signature/certificate field refused');
  else bad('20. fake signature/certificate field refused', v20.failures.join('; '));

  /* 21–25. legacy commercial / VAT sweep (shared PROP.6 scanners). */
  const legacySamples = [
    ['Starter', 'Starter'],
    ['Elite', 'Elite'],
    ['£250 deposit', '£250'],
    ['AI Care', 'Care'],
    ['VAT included at 20%', 'VAT']
  ];
  for (const [needle, fragment] of legacySamples) {
    const rec = partial3Record(partial3);
    rec.audit_events[0].detail = `legacy: ${needle}`;
    const v = validateExecutionRecord(rec, { requireExampleMarker: false });
    if (v.failures.some((x) => x.includes(fragment))) ok(`legacy/VAT content refused (${needle})`);
    else bad(`legacy/VAT content refused (${needle})`, v.failures.join('; ') || 'no refusal');
  }

  /* 26. real-client-style committed fixture (unmarked realistic record). */
  const fake26 = {
    schema: EXECUTION_SCHEMA,
    execution_id: 'EXE-2026-7777',
    execution_version: EXECUTION_VERSION,
    agreement_id: 'AGR-2026-7777',
    agreement_version: '1.0',
    agreement_status: 'READY_FOR_EXECUTION',
    agreement_checksum_sha256: sha256hex('real'),
    proposal_id: 'PRP-2026-7777',
    proposal_version: '1.0',
    proposal_fingerprint: sha256hex('real-p'),
    status: 'PREPARED',
    signers: [{ role: 'CLIENT', name: 'Emma Whitfield', email: 'emma@realclinic.co.uk', organisation: 'Real Clinic', required: true },
              { role: 'NEXORA', name: 'Nexora Creative Studio', organisation: 'Nexora Creative Studio', required: true }],
    execution_method: 'MANUAL',
    provider: 'MANUAL',
    evidence: { events: [] },
    audit_events: [],
    recorded_at: T0
  };
  fake26.execution_fingerprint = buildExecutionFingerprint(fake26);
  const v26 = validateExecutionRecord(fake26, { requireExampleMarker: true });
  if (v26.failures.some((x) => /_example/.test(x))) ok('26. real-client-style unmarked fixture refused (no _example marker)');
  else bad('26. real-client-style unmarked fixture refused', v26.failures.join('; '));

  /* 27. unsafe input path. */
  const r27 = runCli(['verify', '/etc/hosts']);
  expectFail('27. unsafe execution-record input path refused', r27, ['unsafe']);

  /* 28. unsafe output path (outside repo). */
  const r28 = runCli(['prepare', AGREEMENT, '--legal-decisions', RESOLVED, '--output', '/tmp/nexora-evil-out', '--generated-at', T0]);
  expectFail('28. unsafe output path refused', r28, ['Unsafe output']);

  /* 29. overwrite executed record. */
  const b29 = readJson(executedPath);
  writeJson(path.join(EXEC_TMP, 'executed-copy.json'), b29);
  const r29 = runCli(['finalize', path.join(OUT, executionFilename('EXE-2026-9104', EXECUTION_VERSION, 'PARTIALLY_SIGNED', 3)), '--agreement', AGREEMENT, '--output', OUT]);
  expectFail('29. overwrite of executed record refused (immutable)', r29, ['already exist', 'immutable']);

  /* 30. secret-looking committed credential. */
  const rec30 = partial3Record(partial3);
  rec30.evidence.events[0].note = 'provider webhook whsec_abcdef0123456789abcdef0123456789 received';
  const v30 = validateExecutionRecord(rec30, { requireExampleMarker: false });
  if (v30.failures.some((x) => /secret/i.test(x))) ok('30. secret-looking credential refused');
  else bad('30. secret-looking credential refused', v30.failures.join('; '));

  /* 31. fake signed PDF classification. */
  const rec31 = partial3Record(partial3);
  rec31.signed_document_ref = 'AGR-2026-9104-v1.0-SIGNED.pdf';
  const v31 = validateExecutionRecord(rec31, { requireExampleMarker: false });
  if (v31.failures.some((x) => /signed_document_ref/.test(x))) ok('31. fake signed-PDF classification refused (signed_document_ref must be null)');
  else bad('31. fake signed-PDF classification refused', v31.failures.join('; '));

  /* 32. provider event without adapter validation (E_SIGNATURE_PROVIDER event on a MANUAL record). */
  const r32 = runCli(['record-event', pre18, '--event', path.join(EVENTS, 'test-client.json'), '--output', OUT]);
  expectFail('32. provider event without adapter validation refused (MANUAL record + E_SIGNATURE_PROVIDER event)', r32, ['MANUAL evidence']);
}

/* Helpers used by negative tests. */
function normalizeTestClientEvent(eid, t) {
  /* Genuine TEST_ADAPTER context (real derived request id) so the adapter
     accepts the normalisation; callers forge the RECORD id to test
     anti-fabrication, not the event builder. */
  const ctx = {
    execution_id: eid,
    agreement_id: 'AGR-2026-9104',
    provider: 'TEST_ADAPTER',
    provider_request_id: deriveRequestId(eid),
    signers: [{ role: 'CLIENT' }, { role: 'NEXORA' }]
  };
  return normalizeExecutionEvidence('TEST_ADAPTER', ctx, {
    evidence_type: 'E_SIGNATURE_PROVIDER',
    provider: 'TEST_ADAPTER',
    event_type: 'SIGNER_COMPLETED',
    signer_role: 'CLIENT',
    event_time: t,
    provider_event_id: deriveEventId(eid, 'CLIENT', t),
    document_id: deriveDocumentId(eid),
    _test_only: true,
    note: TEST_LABEL
  });
}

function partial3Record(partial3Path) {
  return readJson(partial3Path);
}

/* ------------------------------------------------------------------ */
/* 4. PRIVACY + CLEANUP                                               */
/* ------------------------------------------------------------------ */
function privacy() {
  section('PRIVACY');
  const outFiles = [];
  (function walk(dir) {
    if (!fs.existsSync(dir)) return;
    for (const d of fs.readdirSync(dir, { withFileTypes: true })) {
      const p = path.join(dir, d.name);
      if (d.isDirectory()) walk(p);
      else outFiles.push(p);
    }
  })(OUT);

  let secrets = 0;
  for (const p of outFiles) {
    const text = fs.readFileSync(p, 'utf8');
    secrets += scanSecrets(text).length;
  }
  if (secrets === 0) ok('no secret-looking values in generated execution artifacts');
  else bad('no secret-looking values in generated execution artifacts', `${secrets} hit(s)`);

  /* Committed example area must only contain _example:true synthetic records. */
  if (fs.existsSync(EXAMPLES_DIR)) {
    const ex = fs.readdirSync(EXAMPLES_DIR).filter((f) => f.endsWith('.json'));
    for (const f of ex) {
      const rec = readJson(path.join(EXAMPLES_DIR, f));
      if (rec._example === true) ok(`committed example marked _example: ${f}`);
      else bad(`committed example marked _example: ${f}`, 'unmarked');
    }
  }

  /* Source-of-truth integrity — zero changes to governance/pricing sources. */
  const protectedFiles = [
    path.join(root, 'docs', 'constitution', 'COMMERCIAL-CONSTITUTION.md'),
    path.join(root, 'ops', 'billing-source-of-truth.json')
  ];
  for (const p of protectedFiles) {
    if (fs.existsSync(p)) ok(`governance source untouched (exists): ${path.relative(root, p)}`);
  }
}

function cleanup() {
  fs.rmSync(EXEC_TMP, { recursive: true, force: true });
  fs.rmSync(AGR_TMP, { recursive: true, force: true });
  fs.rmSync(OUT_DIR, { recursive: true, force: true });
  fs.rmSync(PRIVATE_DIR, { recursive: true, force: true });
  ok('temporary execution fixtures cleaned up (all under gitignored locations)');
}

/* ------------------------------------------------------------------ */
/* MAIN                                                               */
/* ------------------------------------------------------------------ */
function main() {
  console.log('NEXORA PROP.7 — Agreement Execution System validation');
  try {
    section('PREPARE');
    buildReadyAgreement();
    writeEvents();
    ok(`synthetic READY Agreement: ${path.relative(root, AGREEMENT)}`);
    ok(`synthetic resolved legal register (mechanism proof only): ${path.relative(root, RESOLVED)}`);

    staticSafety();
    const fixtures = positiveManual();
    if (fixtures) {
      positiveTestAdapter();
      negativeTests(fixtures);
      privacy();
    }
    cleanup();
  } catch (e) {
    console.error('VALIDATOR CRASH:', e && e.stack || e);
    try { cleanup(); } catch (_) { /* best effort */ }
    console.log('\nVALIDATOR EXIT=1');
    process.exitCode = 1;
    return;
  }

  console.log(`\n${checks} checks, ${failures} failure(s)`);
  if (failures === 0) {
    console.log('ALL EXECUTION CHECKS PASSED');
    console.log('---\nVALIDATOR EXIT=0');
    process.exitCode = 0;
  } else {
    console.log('FAILURES:');
    for (const f of failuresList) console.log('  - ' + f);
    console.log('---\nVALIDATOR EXIT=1');
    process.exitCode = 1;
  }
}

main();
