#!/usr/bin/env node
/* Nexora Governed Invoice & Billing Engine (PROP.8) — validation harness.
   Validates the governed invoice/billing layer:
     - static safety (modules present, Node built-ins only, no payment/network
       calls, no hard-coded prices, no mark-paid / --force-paid / --fake-payment,
       gitignore, Source-of-Truth consumption)
     - positive QA: EXECUTED Agreement (PROP.7) -> billing schedule -> governed
       invoice records -> ISSUED with governed due dates; B1/B2/B3/C1/C2/C3/
       Complete milestone schedules (residual-to-last rounding, total == Approved
       Final Project Price exactly); A1/A2/A3 setup + AI recurring Go-Live gate;
       Care monthly-in-advance; fingerprints; immutability; VAT UNDETERMINED
     - 36 fail-closed negative tests (spec section 32)
     - privacy sweep + cleanup of all tmp fixtures (gitignored locations)

   PROP.8 is GOVERNANCE + RECORD MODELLING ONLY. This harness never touches
   ops/billing-source-of-truth.json, the Commercial Constitution, pricing, the
   legal register, or any Proposal/Agreement/Execution status. All fixtures are
   synthetic (fictional example.com clients only). */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';
import {
  OUT_DIR,
  PRIVATE_DIR,
  BILLING_SCHEMA,
  INVOICE_SCHEMA,
  GO_LIVE_SCHEMA,
  INVOICE_ID_RE,
  PAYMENT_ONLY_STATUSES,
  CARE_CODES,
  classifyBillingInput,
  assertSafeBillingOutput,
  computeMilestoneAmounts,
  validateSchedulePercentages,
  dueDateFor,
  firstOfNextMonth,
  buildInvoiceFingerprint,
  verifyInvoiceFingerprint,
  verifyScheduleFingerprint,
  deriveInvoiceSchedule,
  buildInvoiceRecord,
  validateInvoiceRecord,
  validateGoLiveRecord,
  buildGoLiveRecord,
  applyInvoiceEvent,
  allowedInvoiceTransition,
  validateExecutionForBilling,
  validateAgreementForBilling,
  loadSourceOfTruth,
  scanBankDetails,
  scanPaymentLink,
  scanFinancialClaims,
  PAYMENT_TERM_DAYS
} from './billing-validation.mjs';
import {
  EXECUTION_SCHEMA,
  EXECUTION_VERSION,
  validateExecutionRecord,
  verifyExecutionFingerprint,
  agreementChecksum,
  scanSecrets,
  classifyExecutionInput,
  sha256hex
} from '../execution/execution-validation.mjs';
import { classifyInput as classifyAgreementInput } from '../agreements/agreement-validation.mjs';
import { scanLegacy, scanVatAssertions } from '../documents/document-output.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const billingDir = __dirname;
const root = path.join(__dirname, '..', '..');
const agreementsDir = path.join(root, 'ops', 'agreements');
const proposalsDir = path.join(root, 'ops', 'proposals');
const executionDir = path.join(root, 'ops', 'execution');
const BILL_CLI = path.join(billingDir, 'billing.mjs');
const AGREEMENT_GEN = path.join(agreementsDir, 'generate-agreement.mjs');
const EXEC_CLI = path.join(executionDir, 'execution.mjs');

const B2_DRAFT = path.join(agreementsDir, 'examples', 'agreement-draft-b2.json');
const A2_DRAFT = path.join(agreementsDir, 'examples', 'agreement-draft-ai-a2.json');
const COMPLETE_DRAFT = path.join(agreementsDir, 'examples', 'agreement-draft-complete.json');

const AGR_TMP = path.join(agreementsDir, 'private', '.tmp-tests', 'billing-validation');
const EXEC_TMP = path.join(executionDir, 'private', '.tmp-tests', 'billing-validation');
const BILL_TMP = path.join(billingDir, 'private', '.tmp-tests', 'validation');
const RESOLVED = path.join(AGR_TMP, 'synthetic-resolved-legal-decisions.json');

const T0 = '2026-08-11T10:00:00.000Z';
const T1 = '2026-08-11T11:00:00.000Z';
const T2 = '2026-08-11T12:00:00.000Z';
const T3 = '2026-08-11T12:30:00.000Z';
const T4 = '2026-08-11T13:00:00.000Z';
const T5 = '2026-08-11T14:00:00.000Z';
const ISSUE_DATE = '2026-08-15';
const GO_LIVE_DATE = '2026-08-25';

/* Per-offering synthetic commercial shapes (all values mirror the Source of
   Truth moneyValue rules; approved prices are client-approved figures). */
const OFFERINGS = {
  B1: { category: 'WEB', name: 'Launch', reference_price: { from: 2250 }, approved: 2600, schedule: [50, 50], setup_fee: null, recurring: null, care: null },
  B2: { category: 'WEB', name: 'Grow', reference_price: { from: 4250 }, approved: 5100, schedule: [40, 30, 30], setup_fee: null, recurring: null, care: null },
  B3: { category: 'WEB', name: 'Scale', reference_price: { from: 8500 }, approved: 9800, schedule: [55, 25, 20], setup_fee: null, recurring: null, care: null },
  C1: { category: 'BRAND', name: 'Brand Foundation', reference_price: 2250, approved: 2700, schedule: [50, 50], setup_fee: null, recurring: null, care: null },
  C2: { category: 'BRAND', name: 'Brand System', reference_price: { from: 5250 }, approved: 6400, schedule: [40, 30, 30], setup_fee: null, recurring: null, care: null },
  C3: { category: 'BRAND', name: 'Signature Brand', reference_price: { from: 8500 }, approved: 10200, schedule: [40, 30, 20, 10], setup_fee: null, recurring: null, care: null },
  COMPLETE: { category: 'ADDITIONAL', name: 'Nexora Complete', reference_price: null, approved: 24000, schedule: [30, 30, 30, 10], setup_fee: null, recurring: 697, care: null },
  A1: { category: 'AI', name: 'AI Reception', reference_price: null, approved: 900, schedule: null, setup_fee: 497, recurring: 297, care: null },
  A2: { category: 'AI', name: 'AI Growth', reference_price: null, approved: 1100, schedule: null, setup_fee: 997, recurring: 697, care: { code: 'WEB_CARE_PLUS', plan: 'Web Care Plus', monthly_fee: 329 } },
  A3: { category: 'AI', name: 'AI Scale', reference_price: null, approved: 2100, schedule: null, setup_fee: 1995, recurring: 1495, care: null }
};

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
function runCli(exe, args) {
  try {
    const stdout = execFileSync(process.execPath, [exe, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
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
/* 0. PREPARE — synthetic READY Agreements + genuine EXECUTED records  */
/* ------------------------------------------------------------------ */
function resolveLegalSections(draft, resolved) {
  return draft.legal_sections.map((s) => ({
    ...s,
    classification: 'AUTHORITATIVE',
    status: 'RESOLVED',
    note: 'SYNTHETIC TEST RESOLUTION — mechanism proof only.'
  }));
}

function buildReadyAgreements() {
  fs.rmSync(AGR_TMP, { recursive: true, force: true });
  fs.rmSync(EXEC_TMP, { recursive: true, force: true });
  fs.rmSync(BILL_TMP, { recursive: true, force: true });
  fs.mkdirSync(AGR_TMP, { recursive: true });

  const baseReg = readJson(path.join(agreementsDir, 'legal', 'legal-decisions.json'));
  const resolved = { ...baseReg, description: 'SYNTHETIC TEST REGISTER — mechanism proof only.' };
  resolved.clauses = {};
  for (const id of Object.keys(baseReg.clauses)) resolved.clauses[id] = { classification: 'AUTHORITATIVE', note: 'SYNTHETIC TEST RESOLUTION — mechanism proof only.' };
  writeJson(RESOLVED, resolved);

  const bases = { B2: readJson(B2_DRAFT), A2: readJson(A2_DRAFT), COMPLETE: readJson(COMPLETE_DRAFT) };
  const agreementPaths = {};
  let seq = 101;
  for (const code of Object.keys(OFFERINGS)) {
    const spec = OFFERINGS[code];
    const base = code === 'COMPLETE' ? bases.COMPLETE : (spec.category === 'AI' ? bases.A2 : bases.B2);
    const a = JSON.parse(JSON.stringify(base));
    a.status = 'READY_FOR_EXECUTION';
    a._example = true;
    a._comment = 'SYNTHETIC READY agreement for PROP.8 validation — mechanism proof only.';
    a.agreement_id = `AGR-2026-9${seq.toString().padStart(3, '0')}`;
    a.offering = { code, category: spec.category, name: spec.name };
    a.legal_sections = resolveLegalSections(a, resolved);
    const cs = a.commercial_schedule;
    cs.approved_final_project_price = spec.approved;
    cs.reference_price = spec.reference_price;
    cs.setup_fee = spec.setup_fee;
    cs.payment_schedule = spec.schedule;
    cs.recurring_fees = spec.recurring != null ? { monthly_fee: spec.recurring, starts_at: 'GO_LIVE' } : null;
    cs.care = spec.care ? { ...spec.care, billed_in_advance: true } : null;
    const p = path.join(AGR_TMP, code, `${a.agreement_id}-v1.0.json`);
    writeJson(p, a);
    agreementPaths[code] = p;
    seq++;
  }
  return agreementPaths;
}

function runExecutionChain(agreementPath, code, seq) {
  const execOut = path.join(EXEC_TMP, 'exec', code);
  fs.mkdirSync(execOut, { recursive: true });
  const execId = `EXE-2026-9${seq.toString().padStart(3, '0')}`;
  const run = (args) => runCli(EXEC_CLI, args);
  let r = run(['prepare', agreementPath, '--execution-id', execId, '--legal-decisions', RESOLVED, '--output', execOut, '--generated-at', T0, '--overwrite']);
  if (r.status !== 0) throw new Error(`prepare failed for ${code}: ${r.stderr}`);
  const find = (status) => fs.readdirSync(execOut).filter((f) => f.includes(execId) && f.includes(status) && !f.includes('bundle') && !f.includes('package')).sort().pop();
  const ev = (name, obj) => { const p = path.join(execOut, `${code}-${name}.json`); writeJson(p, obj); return p; };
  r = run(['record-event', path.join(execOut, find('PREPARED')), '--event', ev('dispatch', {
    event_type: 'EXECUTION_REQUESTED', event_time: T1, provider: 'MANUAL', evidence_type: 'MANUAL_RECORD',
    note: 'Synthetic manual dispatch by PROP.8 validator.', detail: 'Synthetic dispatch request.'
  }), '--output', execOut, '--generated-at', T1, '--overwrite']);
  if (r.status !== 0) throw new Error(`dispatch failed for ${code}: ${r.stderr}`);
  r = run(['record-event', path.join(execOut, find('SENT_FOR_SIGNATURE')), '--event', ev('client', {
    event_type: 'SIGNER_COMPLETED', signer_role: 'CLIENT', event_time: T2, evidence_type: 'MANUAL_RECORD',
    note: 'Synthetic client signer record by PROP.8 validator.', detail: 'Synthetic client completion.'
  }), '--output', execOut, '--generated-at', T2, '--overwrite']);
  if (r.status !== 0) throw new Error(`client event failed for ${code}: ${r.stderr}`);
  r = run(['record-event', path.join(execOut, find('PARTIALLY_SIGNED')), '--event', ev('nexora', {
    event_type: 'SIGNER_COMPLETED', signer_role: 'NEXORA', event_time: T3, evidence_type: 'MANUAL_RECORD',
    note: 'Synthetic nexora signer record by PROP.8 validator.', detail: 'Synthetic nexora completion.'
  }), '--output', execOut, '--generated-at', T3, '--overwrite']);
  if (r.status !== 0) throw new Error(`nexora event failed for ${code}: ${r.stderr}`);
  r = run(['finalize', path.join(execOut, find('PARTIALLY_SIGNED')), '--agreement', agreementPath, '--output', execOut, '--generated-at', T4, '--overwrite']);
  if (r.status !== 0) throw new Error(`finalize failed for ${code}: ${r.stderr}`);
  const executed = path.join(execOut, find('EXECUTED'));
  const record = readJson(executed);
  if (record.status !== 'EXECUTED') throw new Error(`${code} not EXECUTED`);
  return { execId, executedPath: executed, record };
}

function buildSchedules(agreementPaths, executions) {
  const schedules = {};
  for (const code of Object.keys(OFFERINGS)) {
    const agreement = readJson(agreementPaths[code]);
    const derived = deriveInvoiceSchedule(agreement, executions[code].record, { generatedAt: T0 });
    if (!derived.ok) throw new Error(`schedule failed for ${code}: ${derived.reasons.join('; ')}`);
    schedules[code] = derived.schedule;
  }
  return schedules;
}

/* ------------------------------------------------------------------ */
/* 1. STATIC SAFETY                                                    */
/* ------------------------------------------------------------------ */
function staticSafety() {
  section('STATIC SAFETY');
  const files = ['billing.mjs', 'billing-validation.mjs', 'validate-billing.mjs'];
  for (const f of files) {
    if (fs.existsSync(path.join(billingDir, f))) ok(`module present: ${f}`);
    else bad(`module present: ${f}`, 'missing');
  }

  const src = files.filter((f) => f !== 'validate-billing.mjs').map((f) => fs.readFileSync(path.join(billingDir, f), 'utf8')).join('\n');
  const banned = [
    ['fetch(', /fetch\s*\(/],
    ['https://', /https?:\/\//],
    ['node:https', /node:https/],
    ['node:net', /node:net/],
    ['node:http', /node:http/],
    ['axios', /\baxios\b/],
    ['XMLHttpRequest', /XMLHttpRequest/],
    ['node_modules dependency', /from\s+['"](?!node:)[^.][^'"]*['"]/],
    ['PaymentIntent API call', /\bPaymentIntent\b/],
    ['CheckoutSession API call', /\bCheckoutSession\b/],
    ['PaymentLink API call', /\bPaymentLink\b/],
    ['createCheckoutSession', /createCheckoutSession/],
    ['Stripe SDK', /@stripe|stripe-node|api\.stripe\.com/],
    ['PayPal SDK', /@paypal|paypal\.com/]
  ];
  for (const [name, re] of banned) {
    if (re.test(src)) bad(`no external network/payment: ${name}`, 'found');
    else ok(`no external network/payment: ${name}`);
  }
  if (!/execFileSync/.test(src)) ok('billing layer does not spawn subprocesses (pure Node core)');
  else bad('billing layer does not spawn subprocesses', 'execFileSync present in billing core/CLI');

  /* No hard-coded commercial prices / fees in the billing layer. */
  const priceHit = [];
  for (const re of [/\b£\s*\d/, /5\s?100/, /24\s?000/, /9\s?97/, /69\s?7/, /4\s?250/, /2\s?250/, /1995/, /1495/]) if (re.test(src)) priceHit.push(String(re));
  if (priceHit.length === 0) ok('no hard-coded commercial prices (Source of Truth is the single authority)');
  else bad('no hard-coded commercial prices', priceHit.join(', '));

  /* No mark-paid / --force-paid / --fake-payment flags bound in the CLI parser. */
  const parserBranches = src.match(/else if \(a === '[^']+'\)/g) || [];
  const parserFlags = parserBranches.map((s) => (s.match(/'([^']+)'/) || [])[1]);
  const forbidden = ['--force-paid', '--mark-paid', '--fake-payment', 'mark-paid'];
  const flagHit = forbidden.filter((f) => parserFlags.includes(f));
  const badPath = /opts\.bad/.test(src) && /a\.startsWith\('-'\)/.test(src);
  if (flagHit.length === 0 && badPath) ok('no payment-shortcut flags bound (mark-paid / --force-paid / --fake-payment) + unknown flags rejected');
  else bad('no payment-shortcut flags', (flagHit.length ? flagHit.join(', ') + ' bound in parser; ' : '') + (badPath ? '' : 'no opts.bad rejection path'));

  /* Status model: PAID/OVERDUE/REFUNDED/CREDITED must never be reachable inside PROP.8. */
  if (PAYMENT_ONLY_STATUSES.length === 4) ok('payment-only statuses reserved (PAID/OVERDUE/REFUNDED/CREDITED) — not reachable in PROP.8');
  else bad('payment-only statuses', `expected 4, got ${PAYMENT_ONLY_STATUSES.length}`);
  if (!allowedInvoiceTransition('DRAFT', 'MARK_PAID') && !allowedInvoiceTransition('ISSUED', 'MARK_PAID')) ok('no transition can reach PAID inside PROP.8');
  else bad('no transition can reach PAID', 'MARK_PAID allowed');

  /* Gitignore covers private + out. */
  const gi = fs.readFileSync(path.join(root, '.gitignore'), 'utf8');
  for (const pat of ['ops/billing/private/', 'ops/billing/out/']) {
    if (gi.includes(pat)) ok(`gitignored: ${pat}`);
    else bad(`gitignored: ${pat}`, 'missing from .gitignore');
  }

  /* Source of Truth is consumed, not duplicated. */
  const sot = loadSourceOfTruth();
  if (sot.currency === 'GBP' && PAYMENT_TERM_DAYS === 7) ok(`Source of Truth consumed (currency ${sot.currency}, project_invoice_due_days ${PAYMENT_TERM_DAYS})`);
  else bad('Source of Truth consumed', `currency=${sot.currency} dueDays=${PAYMENT_TERM_DAYS}`);
}

/* ------------------------------------------------------------------ */
/* 2. POSITIVE QA                                                      */
/* ------------------------------------------------------------------ */
function positiveSchedules(schedules) {
  section('POSITIVE — billing schedules per offering');
  const expectAmounts = {
    B1: [1300, 1300], B2: [2040, 1530, 1530], B3: [5390, 2450, 1960],
    C1: [1350, 1350], C2: [2560, 1920, 1920], C3: [4080, 3060, 2040, 1020],
    COMPLETE: [7200, 7200, 7200, 2400]
  };
  for (const code of Object.keys(expectAmounts)) {
    const s = schedules[code];
    const got = s.items.filter((i) => i.invoice_type !== 'SETUP_IMPLEMENTATION' && !i.recurring && !i.care).map((i) => i.amount);
    if (JSON.stringify(got) === JSON.stringify(expectAmounts[code])) ok(`${code} milestone amounts ${JSON.stringify(got)} (Approved Final Project Price × governed schedule, residual-to-last)`);
    else bad(`${code} milestone amounts`, `expected ${JSON.stringify(expectAmounts[code])}, got ${JSON.stringify(got)}`);
    const total = s.items.filter((i) => i.invoice_type !== 'SETUP_IMPLEMENTATION' && !i.recurring && !i.care).reduce((a, i) => a + i.amount, 0);
    if (total === OFFERINGS[code].approved) ok(`${code} milestone total == Approved Final Project Price (${OFFERINGS[code].approved})`);
    else bad(`${code} milestone total`, `${total} != ${OFFERINGS[code].approved}`);
    if (verifyScheduleFingerprint(s).ok) ok(`${code} schedule fingerprint valid`);
    else bad(`${code} schedule fingerprint`, verifyScheduleFingerprint(s).reasons.join('; '));
    const ref = s.commercial_basis.reference_price_from;
    if (s.items.every((i) => i.amount !== ref)) ok(`${code} schedule never uses the public/reference price (${ref})`);
    else bad(`${code} reference-price independence`, 'an item equals the reference price');
  }
}

function positiveInvoices(schedules) {
  section('POSITIVE — governed invoice records + issuance');
  const issued = {};
  for (const code of ['B1', 'B2', 'C1', 'C3', 'COMPLETE']) {
    const s = schedules[code];
    const inv = buildInvoiceRecord(s, 0, {
      createdAt: T0, client: clientFor(), project: projectFor(code), example: true, issue: true, issueDate: ISSUE_DATE
    });
    if (!inv.ok) { bad(`${code} milestone-1 invoice created`, inv.reasons.join('; ')); continue; }
    const r = inv.record;
    const v = validateInvoiceRecord(r, { requireExampleMarker: true });
    if (v.failures.length === 0) ok(`${code} milestone-1 invoice valid + fingerprint clean (${r.total})`);
    else bad(`${code} milestone-1 invoice valid`, v.failures.join('; '));
    if (r.status === 'ISSUED' && r.issue_date === ISSUE_DATE) ok(`${code} invoice issued with issue_date ${ISSUE_DATE}`);
    else bad(`${code} invoice issued`, `status=${r.status}`);
    if (r.due_date === dueDateFor(ISSUE_DATE)) ok(`${code} due date = issue + 7 calendar days (${r.due_date})`);
    else bad(`${code} due date`, `${r.due_date} != ${dueDateFor(ISSUE_DATE)}`);
    if (r.payment.status === 'UNPAID') ok(`${code} ISSUED != PAID (payment.status UNPAID)`);
    else bad(`${code} ISSUED != PAID`, `payment.status=${r.payment.status}`);
    if (r.tax_status === 'UNDETERMINED' && r.tax_amount === null) ok(`${code} tax_status UNDETERMINED (VAT gate)`);
    else bad(`${code} tax_status`, `${r.tax_status}/${r.tax_amount}`);
    issued[code] = r;
  }

  /* Issue via the transition path (DRAFT -> ISSUED). */
  const s = schedules.B2;
  const draft = buildInvoiceRecord(s, 0, { createdAt: T0, client: clientFor(), project: projectFor('B2'), example: true });
  if (draft.ok && draft.record.status === 'DRAFT') ok('invoice created as DRAFT (schedule generation != invoice issuance; creation != issuance)');
  else bad('invoice created as DRAFT', draft.ok ? draft.record.status : draft.reasons.join('; '));
  const tr = applyInvoiceEvent(draft.record, { event_type: 'ISSUE', issue_date: ISSUE_DATE, at: T1 });
  if (tr.ok && tr.record.status === 'ISSUED' && tr.record.due_date === dueDateFor(ISSUE_DATE)) ok('DRAFT -> ISSUED transition sets issue date + governed due date');
  else bad('DRAFT -> ISSUED transition', tr.ok ? `${tr.record.status}` : tr.reasons.join('; '));
  if (tr.ok) {
    const v = validateInvoiceRecord(tr.record, { requireExampleMarker: true });
    if (v.failures.length === 0) ok('ISSUED record validates (fingerprint recomputed on transition)');
    else bad('ISSUED record validates', v.failures.join('; '));
  }

  /* Milestone > 1 requires trigger evidence (unresolved policy). */
  const m2 = buildInvoiceRecord(s, 1, { createdAt: T0, client: clientFor(), project: projectFor('B2'), example: true });
  if (!m2.ok && /MILESTONE INVOICE TRIGGER/.test(m2.reasons.join(' '))) ok('milestone 2 invoice gated on trigger evidence (OWNER/OPERATIONS DECISION)');
  else bad('milestone 2 gate', m2.ok ? 'created without evidence' : m2.reasons.join('; '));
  const m2ok = buildInvoiceRecord(s, 1, { createdAt: T0, milestoneEvidence: 'm2-signoff-2026-09-01', client: clientFor(), project: projectFor('B2'), example: true });
  if (m2ok.ok && m2ok.record.milestone.trigger_evidence === 'm2-signoff-2026-09-01') ok('milestone 2 created with governed trigger evidence');
  else bad('milestone 2 created with evidence', m2ok.ok ? 'ok' : m2ok.reasons.join('; '));

  /* Final balance absorbs residual. */
  const fin = buildInvoiceRecord(s, 2, { createdAt: T0, milestoneEvidence: 'final-signoff-2026-10-01', client: clientFor(), project: projectFor('B2'), example: true });
  if (fin.ok && fin.record.invoice_type === 'FINAL_BALANCE' && fin.record.total === 1530) ok('FINAL_BALANCE invoice absorbs residual (1530)');
  else bad('FINAL_BALANCE invoice', fin.ok ? `${fin.record.invoice_type}:${fin.record.total}` : fin.reasons.join('; '));
  return issued;
}

function clientFor() {
  return { name: 'Example Client', company: 'Example Clinic Ltd', billing_email: 'billing@example.com', billing_address: '1 Example Street, London' };
}
function projectFor(code) {
  const n = OFFERINGS[code] ? OFFERINGS[code].name : code;
  return { title: `${n} — Example Clinic` };
}

function positiveAI(schedules) {
  section('POSITIVE — AI implementation + recurring Go-Live gate');
  const setups = { A1: 497, A2: 997, A3: 1995 };
  for (const code of ['A1', 'A2', 'A3']) {
    const s = schedules[code];
    const si = buildInvoiceRecord(s, 0, { createdAt: T0, client: clientFor(), project: projectFor(code), example: true, issue: true, issueDate: ISSUE_DATE });
    if (si.ok && si.record.invoice_type === 'SETUP_IMPLEMENTATION' && si.record.total === setups[code]) ok(`${code} setup/implementation invoice ${setups[code]} (EXECUTED gate)`);
    else bad(`${code} setup invoice`, si.ok ? `${si.record.invoice_type}:${si.record.total}` : si.reasons.join('; '));

    const rec = buildInvoiceRecord(s, 1, { createdAt: T0, client: clientFor(), project: projectFor(code), example: true });
    if (!rec.ok && /Go-Live|GO_LIVE/.test(rec.reasons.join(' '))) ok(`${code} AI recurring BLOCKED before a recorded Go-Live`);
    else bad(`${code} AI recurring pre-Go-Live`, rec.ok ? 'created' : rec.reasons.join('; '));

    if (rec.ok) {
      /* Try again "inferring" Go-Live from the execution date — must still fail. */
      const fake = { agreement_id: s.source.agreement_id, occurred_at: T4.slice(0, 10) };
      const fake2 = buildInvoiceRecord(s, 1, { createdAt: T0, goLive: fake, client: clientFor(), project: projectFor(code), example: true });
      if (!fake2.ok && /evidence_ref|GO_LIVE/.test(fake2.reasons.join(' '))) ok(`${code} Go-Live is NEVER inferred from the execution date (explicit evidence record required)`);
      else bad(`${code} Go-Live never inferred`, fake2.ok ? 'created from inferred go-live' : fake2.reasons.join('; '));
    }
  }

  /* Go-Live record + recurring readiness. */
  const gl = buildGoLiveRecord({ agreementId: schedules.A2.source.agreement_id, executionId: schedules.A2.source.execution_id, occurredAt: GO_LIVE_DATE, recordedAt: T1, evidenceRef: 'go-live-handover-2026-08-25', example: true });
  if (validateGoLiveRecord(gl).ok) ok('Go-Live record validates (schema, evidence_ref, ISO dates)');
  else bad('Go-Live record validates', validateGoLiveRecord(gl).reasons.join('; '));

  const recOk = buildInvoiceRecord(schedules.A2, 1, { createdAt: T0, goLive: gl, client: clientFor(), project: projectFor('A2'), example: true, issue: true, issueDate: '2026-09-01' });
  if (recOk.ok) {
    const r = recOk.record;
    if (r.recurring && r.recurring.billing_start_date === firstOfNextMonth(GO_LIVE_DATE)) ok(`AI recurring billing starts ${r.recurring.billing_start_date} (first of month after Go-Live ${GO_LIVE_DATE})`);
    else bad('AI recurring billing start', r.recurring && r.recurring.billing_start_date);
    if (r.recurring && r.recurring.next_billing_date === firstOfNextMonth(r.recurring.billing_start_date)) ok(`AI recurring next billing ${r.recurring.next_billing_date}`);
    else bad('AI recurring next billing', r.recurring && r.recurring.next_billing_date);
    const v = validateInvoiceRecord(r, { requireExampleMarker: true });
    if (v.failures.length === 0) ok('AI recurring invoice valid (issued, recurring-ready, fingerprint clean)');
    else bad('AI recurring invoice valid', v.failures.join('; '));
    if (r.total === 697) ok('AI recurring invoice amount = governed monthly fee (697)');
    else bad('AI recurring invoice amount', r.total);
  } else {
    bad('AI recurring post-Go-Live', recOk.reasons.join('; '));
  }
  return gl;
}

function positiveCare(schedules) {
  section('POSITIVE — Care recurring (monthly in advance, never silent)');
  const s = schedules.A2;
  const careItem = s.items.find((i) => i.invoice_type === 'CARE_RECURRING');
  if (!careItem) { bad('Care recurring item present', 'missing from A2 schedule'); return; }
  if (careItem.care.billed_in_advance === true && careItem.amount === 329) ok('Care billed monthly in advance at governed fee (329)');
  else bad('Care billed in advance', JSON.stringify(careItem.care));

  const blocked = buildInvoiceRecord(s, 2, { createdAt: T0, client: clientFor(), project: projectFor('A2'), example: true });
  if (!blocked.ok && /care start|Care/i.test(blocked.reasons.join(' '))) ok('Care recurring BLOCKED without an explicit governed Care start (never silent activation)');
  else bad('Care recurring blocked', blocked.ok ? 'created' : blocked.reasons.join('; '));

  const ok2 = buildInvoiceRecord(s, 2, { createdAt: T0, careStart: '2026-09-01', client: clientFor(), project: projectFor('A2'), example: true });
  if (ok2.ok) {
    if (ok2.record.care.care_start === '2026-09-01' && ok2.record.total === 329) ok('Care recurring created with governed Care start (2026-09-01) + monthly fee 329');
    else bad('Care recurring created', JSON.stringify({ care_start: ok2.record.care.care_start, total: ok2.record.total }));
    const v = validateInvoiceRecord(ok2.record, { requireExampleMarker: true });
    if (v.failures.length === 0) ok('Care recurring invoice valid (fingerprint clean)');
    else bad('Care recurring invoice valid', v.failures.join('; '));
  } else {
    bad('Care recurring created', ok2.reasons.join('; '));
  }
}

function positiveDueDateVatImmutability(schedules, gl) {
  section('POSITIVE — due date, VAT boundary, immutability');
  const s = schedules.B2;
  const inv = buildInvoiceRecord(s, 0, { createdAt: T0, client: clientFor(), project: projectFor('B2'), example: true, issue: true, issueDate: '2026-08-31' });
  if (inv.ok && inv.record.due_date === '2026-09-07') ok('due date computed across month boundary (2026-08-31 + 7 = 2026-09-07)');
  else bad('due date across month boundary', inv.ok ? inv.record.due_date : inv.reasons.join('; '));

  /* Fingerprint protects the commercial terms + provenance. */
  const base = buildInvoiceRecord(s, 0, { createdAt: T0, client: clientFor(), project: projectFor('B2'), example: true, issue: true, issueDate: ISSUE_DATE }).record;
  if (verifyInvoiceFingerprint(base).ok) ok('issued invoice fingerprint valid (commercial terms + provenance + dates)');
  else bad('issued invoice fingerprint', verifyInvoiceFingerprint(base).reasons.join('; '));

  const tamper = JSON.parse(JSON.stringify(base));
  tamper.total = tamper.total + 1;
  if (!verifyInvoiceFingerprint(tamper).ok) ok('altered invoice amount -> fingerprint fails');
  else bad('altered invoice amount -> fingerprint fails', 'still valid');
  const tamper2 = JSON.parse(JSON.stringify(base));
  tamper2.due_date = '2026-08-30';
  if (!verifyInvoiceFingerprint(tamper2).ok) ok('altered due date -> fingerprint fails');
  else bad('altered due date -> fingerprint fails', 'still valid');
  const tamper3 = JSON.parse(JSON.stringify(base));
  tamper3.source.execution_fingerprint = '0'.repeat(64);
  if (!verifyInvoiceFingerprint(tamper3).ok) ok('altered execution linkage -> fingerprint fails');
  else bad('altered execution linkage -> fingerprint fails', 'still valid');

  /* Fingerprint is NOT an accounting signature (boundary). */
  if (typeof base.invoice_fingerprint === 'string' && base.invoice_fingerprint.length === 64) ok('invoice fingerprint is a deterministic SHA-256 integrity aid (NOT an accounting signature)');
  else bad('invoice fingerprint sha256', 'malformed');

  /* VAT stays UNDETERMINED everywhere. */
  const allText = [JSON.stringify(schedules.B2.vat_note), JSON.stringify(schedules.A2.vat_note)].join(' ');
  if (scanVatAssertions(allText).length === 0) ok('no VAT determination is claimed (VAT UNDETERMINED)');
  else bad('no VAT determination claimed', scanVatAssertions(allText).join('; '));
  if (gl && validateGoLiveRecord(gl).ok) ok('Go-Live record remains valid after schedule issuance');
}

/* ------------------------------------------------------------------ */
/* 3. NEGATIVE TESTS (spec section 32)                                 */
/* ------------------------------------------------------------------ */
function negativeTests(agreementPaths, executions, schedules) {
  section('NEGATIVE — fail-closed tests (36)');
  const B2 = 'B2';
  const agreementPath = agreementPaths[B2];
  const agreement = readJson(agreementPath);
  const exec = executions[B2];
  const schedule = schedules[B2];
  const invoice = () => buildInvoiceRecord(schedule, 0, { createdAt: T0, client: clientFor(), project: projectFor(B2), example: true }).record;

  /* 1. non-EXECUTED execution input. */
  const preparedPath = fs.readdirSync(path.dirname(exec.executedPath)).filter((f) => f.includes(exec.execId) && f.includes('PREPARED')).pop();
  const prepared = readJson(path.join(path.dirname(exec.executedPath), preparedPath));
  const d1 = deriveInvoiceSchedule(agreement, prepared);
  if (!d1.ok && /EXECUTED required/.test(d1.reasons.join(' '))) ok('1. non-EXECUTED execution (PREPARED) refused');
  else bad('1. non-EXECUTED execution refused', d1.ok ? 'schedule derived' : d1.reasons.join('; '));

  /* 2. DRAFT Agreement input. */
  const draftAgr = JSON.parse(JSON.stringify(agreement));
  draftAgr.status = 'DRAFT';
  const d2 = deriveInvoiceSchedule(draftAgr, exec.record);
  if (!d2.ok && /READY_FOR_EXECUTION required/.test(d2.reasons.join(' '))) ok('2. DRAFT Agreement refused (no billing from a DRAFT)');
  else bad('2. DRAFT Agreement refused', d2.ok ? 'schedule derived' : d2.reasons.join('; '));

  /* 3. wrong Agreement linkage (execution references a different agreement). */
  const wrongExec = JSON.parse(JSON.stringify(exec.record));
  wrongExec.agreement_id = 'AGR-2026-9199';
  const d3 = deriveInvoiceSchedule(agreement, wrongExec);
  if (!d3.ok && /does not match|linkage/.test(d3.reasons.join(' '))) ok('3. wrong Agreement linkage refused');
  else bad('3. wrong Agreement linkage refused', d3.ok ? 'schedule derived' : d3.reasons.join('; '));

  /* 4. wrong Execution fingerprint (tampered execution record). */
  const tamperedExec = JSON.parse(JSON.stringify(exec.record));
  tamperedExec.evidence.events[0].note = 'tampered';
  const d4 = deriveInvoiceSchedule(agreement, tamperedExec);
  if (!d4.ok && /fingerprint/i.test(d4.reasons.join(' '))) ok('4. tampered execution fingerprint refused');
  else bad('4. tampered execution fingerprint refused', d4.ok ? 'schedule derived' : d4.reasons.join('; '));

  /* 5. changed Approved Final Project Price (amount no longer matches). */
  const chg = invoice();
  chg.line_items[0].line_total = 2500;
  chg.subtotal = 2500;
  chg.total = 2500;
  chg.invoice_fingerprint = buildInvoiceFingerprint(chg);
  const v5 = validateInvoiceRecord(chg, { requireExampleMarker: true });
  if (v5.failures.some((x) => /milestone invoice amount/.test(x))) ok('5. changed amount vs Approved Final Project Price refused');
  else bad('5. changed amount refused', v5.failures.join('; ') || 'no refusal');

  /* 6. public/reference price used as the invoice amount. */
  const ref = invoice();
  ref.line_items[0].line_total = 4250; /* B2 public reference price */
  ref.subtotal = 4250;
  ref.total = 4250;
  ref.invoice_fingerprint = buildInvoiceFingerprint(ref);
  const v6 = validateInvoiceRecord(ref, { requireExampleMarker: true });
  if (v6.failures.some((x) => /milestone invoice amount|reference price/.test(x))) ok('6. public/reference price as invoice amount refused');
  else bad('6. reference-price amount refused', v6.failures.join('; ') || 'no refusal');

  /* 7. invalid milestone percentage (out of 1..100). */
  const p7 = validateSchedulePercentages([0, 100]);
  if (!p7.ok && /1\.\.100/.test(p7.reasons.join(' '))) ok('7. invalid milestone percentage refused');
  else bad('7. invalid milestone percentage refused', p7.ok ? 'accepted' : p7.reasons.join('; '));

  /* 8. percentages that do not sum to 100. */
  const p8 = validateSchedulePercentages([40, 30, 20]);
  if (!p8.ok && /sum to 100/.test(p8.reasons.join(' '))) ok('8. percentages not summing to 100 refused');
  else bad('8. percentages not summing to 100 refused', p8.ok ? 'accepted' : p8.reasons.join('; '));

  /* 9. incorrect rounding (amount off by a pound). */
  const rnd = invoice();
  rnd.line_items[0].line_total = 2041; /* 5100 x 40% = 2040 */
  rnd.subtotal = 2041;
  rnd.total = 2041;
  rnd.invoice_fingerprint = buildInvoiceFingerprint(rnd);
  const v9 = validateInvoiceRecord(rnd, { requireExampleMarker: true });
  if (v9.failures.some((x) => /milestone invoice amount/.test(x))) ok('9. incorrect rounding (off-by-one) refused');
  else bad('9. incorrect rounding refused', v9.failures.join('; ') || 'no refusal');

  /* 10. B3 invented schedule that does not sum to 100. */
  const b3bad = JSON.parse(JSON.stringify(readJson(agreementPaths.B3)));
  b3bad.commercial_schedule.payment_schedule = [60, 30]; /* sums to 90 — invented */
  const d10 = deriveInvoiceSchedule(b3bad, executions.B3.record);
  if (!d10.ok && (/sum to 100|B3|payment_schedule/.test(d10.reasons.join(' ')))) ok('10. B3 invented/incomplete bespoke schedule refused');
  else bad('10. B3 invented schedule refused', d10.ok ? 'schedule derived' : d10.reasons.join('; '));

  /* 11. COMPLETE with a wrong (non-governed) schedule. */
  const compBad = JSON.parse(JSON.stringify(readJson(agreementPaths.COMPLETE)));
  compBad.commercial_schedule.payment_schedule = [40, 30, 30];
  const d11 = deriveInvoiceSchedule(compBad, executions.COMPLETE.record);
  if (!d11.ok && /COMPLETE|payment_schedule|must be/.test(d11.reasons.join(' '))) ok('11. COMPLETE wrong schedule refused');
  else bad('11. COMPLETE wrong schedule refused', d11.ok ? 'schedule derived' : d11.reasons.join('; '));

  /* 12. AI recurring pre-Go-Live (already proven positive; negative via CLI-equivalent). */
  const a2 = schedules.A2;
  const r12 = buildInvoiceRecord(a2, 1, { createdAt: T0, client: clientFor(), project: projectFor('A2'), example: true });
  if (!r12.ok && /recorded Go-Live/.test(r12.reasons.join(' '))) ok('12. AI recurring pre-Go-Live refused');
  else bad('12. AI recurring pre-Go-Live refused', r12.ok ? 'created' : r12.reasons.join('; '));

  /* 13. fake Go-Live inferred from the execution date. */
  const fakeGl = { agreement_id: a2.source.agreement_id, occurred_at: T4.slice(0, 10), recorded_at: T4, evidence_ref: null };
  const r13 = buildInvoiceRecord(a2, 1, { createdAt: T0, goLive: fakeGl, client: clientFor(), project: projectFor('A2'), example: true });
  if (!r13.ok && (/evidence_ref|Go-Live|GO_LIVE/.test(r13.reasons.join(' ')))) ok('13. inferred/fabricated Go-Live refused (explicit evidence record required)');
  else bad('13. inferred Go-Live refused', r13.ok ? 'created' : r13.reasons.join('; '));

  /* 14. AI Care does not exist (D2) — refused. */
  const aiCare = JSON.parse(JSON.stringify(readJson(agreementPaths.A1)));
  aiCare.commercial_schedule.care = { code: 'AI_CARE', plan: 'AI Care', monthly_fee: 199, billed_in_advance: true };
  const d14 = deriveInvoiceSchedule(aiCare, executions.A1.record);
  if (!d14.ok && /AI Care|unknown Care plan|governed Care product/.test(d14.reasons.join(' '))) ok('14. AI Care refused (no such governed product)');
  else bad('14. AI Care refused', d14.ok ? 'schedule derived' : d14.reasons.join('; '));

  /* 15-17. legacy Starter / Elite / £250 sweep. */
  const legacySamples = [['Starter', 'Starter'], ['Elite', 'Elite'], ['£250 deposit', '£250']];
  for (const [needle, fragment] of legacySamples) {
    const rec = invoice();
    rec.audit_events[0].detail = `legacy: ${needle}`;
    const v = validateInvoiceRecord(rec, { requireExampleMarker: true });
    if (v.failures.some((x) => x.includes(fragment))) ok(`legacy content refused (${needle})`);
    else bad(`legacy content refused (${needle})`, v.failures.join('; ') || 'no refusal');
  }

  /* 18. unsupported VAT assertion refused. */
  const vat = invoice();
  vat.audit_events[0].detail = 'VAT included at 20%';
  const v18 = validateInvoiceRecord(vat, { requireExampleMarker: true });
  if (v18.failures.some((x) => /VAT/.test(x))) ok('18. unsupported VAT assertion refused');
  else bad('18. unsupported VAT assertion refused', v18.failures.join('; ') || 'no refusal');

  /* 19. invented late fee refused. */
  const lf = invoice();
  lf.audit_events[0].detail = 'A late fee of £50 applies after 14 days.';
  const v19 = validateInvoiceRecord(lf, { requireExampleMarker: true });
  if (v19.failures.some((x) => /late fee|uninventable financial claim/.test(x))) ok('19. invented late fee refused');
  else bad('19. invented late fee refused', v19.failures.join('; ') || 'no refusal');

  /* 20. invented penalty refused. */
  const pn = invoice();
  pn.audit_events[0].detail = 'Penalty interest accrues monthly.';
  const v20 = validateInvoiceRecord(pn, { requireExampleMarker: true });
  if (v20.failures.some((x) => /financial claim|penalt/.test(x))) ok('20. invented penalty refused');
  else bad('20. invented penalty refused', v20.failures.join('; ') || 'no refusal');

  /* 21. fake PAID refused. */
  const paid = invoice();
  paid.status = 'PAID';
  paid.payment.status = 'PAID';
  paid.invoice_fingerprint = buildInvoiceFingerprint(paid);
  const v21 = validateInvoiceRecord(paid, { requireExampleMarker: true });
  if (v21.failures.some((x) => /PAID|payment\/reconciliation/.test(x))) ok('21. fake PAID refused (payment evidence required from a future layer)');
  else bad('21. fake PAID refused', v21.failures.join('; ') || 'no refusal');

  /* 22. --force-paid / --mark-paid absent from the CLI parser (static). */
  const cliSrc = fs.readFileSync(path.join(billingDir, 'billing.mjs'), 'utf8');
  const branchFlags = (cliSrc.match(/else if \(a === '[^']+'\)/g) || []).map((s) => (s.match(/'([^']+)'/) || [])[1]);
  if (!branchFlags.includes('--force-paid') && !branchFlags.includes('--mark-paid') && !branchFlags.includes('--fake-payment')) ok('22. no --force-paid / --mark-paid / --fake-payment flags exist');
  else bad('22. payment-shortcut flags', 'bound in parser');
  const badFlag = runCli(BILL_CLI, ['issue', '--force-paid', 'whatever.json']);
  if (badFlag.status !== 0 && (badFlag.stderr + badFlag.stdout).includes('Unknown option')) ok('22b. --force-paid rejected as an unknown option');
  else bad('22b. --force-paid rejected', `exit ${badFlag.status}`);

  /* 23. Stripe/payment-provider API usage refused (static). */
  if (!/\brequire\s*\(\s*['"]stripe|from\s+['"]stripe|fetch\(/.test(cliSrc)) ok('23. no Stripe/payment-provider API usage');
  else bad('23. no Stripe/payment-provider API usage', 'found');

  /* 24. unsafe input path refused (billing CLI). */
  const unsafeIn = path.join(root, '..', 'unsafe-billing.json');
  writeJson(unsafeIn, { schema: BILLING_SCHEMA, billing_schedule_id: 'SCH-X', version: '1.0', schedule_fingerprint: '0'.repeat(64) });
  const u24 = runCli(BILL_CLI, ['verify', unsafeIn]);
  if (u24.status !== 0 && (u24.stdout + u24.stderr).includes('unsafe')) ok('24. unsafe billing input path refused');
  else bad('24. unsafe billing input path refused', `exit ${u24.status}`);

  /* 25. unsafe output path refused (control first: genuine CLI schedule + verify). */
  const cliOut = path.join(BILL_TMP, 'cli');
  fs.mkdirSync(cliOut, { recursive: true });
  const u25ctl = runCli(BILL_CLI, ['schedule', agreementPath, exec.executedPath, '--output', cliOut]);
  if (u25ctl.status === 0) {
    ok('25. (control) billing CLI schedule runs on genuine EXECUTED input');
    const schedFile = fs.readdirSync(cliOut).find((f) => f.includes('schedule'));
    const u25v = runCli(BILL_CLI, ['verify', path.join(cliOut, schedFile)]);
    expectPass('25. (control) generated schedule verifies', u25v);
  } else {
    bad('25. (control) billing CLI schedule runs', (u25ctl.stderr || u25ctl.stdout).trim());
  }
  const unsafeOut = path.join(root, '..', 'unsafe-out');
  const u25b = runCli(BILL_CLI, ['schedule', agreementPath, exec.executedPath, '--output', unsafeOut]);
  if (u25b.status !== 0 && (u25b.stdout + u25b.stderr).includes('repo')) ok('25. unsafe output path (outside repository) refused');
  else bad('25. unsafe output path refused', `exit ${u25b.status}`);

  /* 26. overwrite of an issued invoice refused (immutability).
     The transition ISSUED -> ISSUE is rejected by the state machine first;
     the overwrite guard also blocks any attempt to replace an ISSUED file. */
  const issuedPath = path.join(BILL_TMP, 'issued-immutability.json');
  const issuedRec = buildInvoiceRecord(schedule, 0, { createdAt: T0, client: clientFor(), project: projectFor(B2), example: true, issue: true, issueDate: ISSUE_DATE }).record;
  writeJson(issuedPath, issuedRec);
  const u26 = runCli(BILL_CLI, ['issue', issuedPath, '--out', issuedPath, '--overwrite', '--generated-at', T1]);
  if (u26.status !== 0 && ((u26.stdout + u26.stderr).includes('immutable') || (u26.stdout + u26.stderr).includes('TRANSITION REJECTED'))) ok('26. issued invoice never overwritten/re-issued (transition rejected or overwrite blocked)');
  else bad('26. issued invoice immutable', `exit ${u26.status}: ${(u26.stdout + u26.stderr).trim()}`);
  const u26b = runCli(BILL_CLI, ['issue', issuedPath, '--overwrite']);
  if (u26b.status !== 0 && (u26b.stdout + u26b.stderr).includes('transition')) ok('26b. re-issue of an ISSUED invoice refused (no silent re-issue)');
  else bad('26b. re-issue refused', `exit ${u26b.status}: ${(u26b.stdout + u26b.stderr).trim()}`);

  /* 27. real-client-style unmarked fixture refused. */
  const real = JSON.parse(JSON.stringify(invoice()));
  delete real._example;
  real.client = { name: 'Emma Whitfield', company: 'Real Clinic Ltd', billing_email: 'emma@realclinic.co.uk', billing_address: '22 Harley Street, London' };
  const v27 = validateInvoiceRecord(real, { requireExampleMarker: true });
  if (v27.failures.some((x) => /_example/.test(x))) ok('27. real-client-style unmarked fixture refused (_example required for committed fixtures)');
  else bad('27. unmarked real-style fixture refused', v27.failures.join('; ') || 'no refusal');

  /* 28. secret-like credential refused. */
  const sec = invoice();
  sec.audit_events[0].detail = 'sk_test_TESTING12345678901234';
  const v28 = validateInvoiceRecord(sec, { requireExampleMarker: true });
  if (v28.failures.some((x) => /secret/.test(x))) ok('28. secret-like credential refused');
  else bad('28. secret-like credential refused', v28.failures.join('; ') || 'no refusal');

  /* 29. altered invoice fingerprint refused (validate-time). */
  const tam = invoice();
  tam.total = tam.total + 5;
  tam.subtotal = tam.total;
  tam.line_items[0].line_total = tam.total;
  const v29 = validateInvoiceRecord(tam, { requireExampleMarker: true });
  if (v29.failures.some((x) => /fingerprint mismatch/.test(x))) ok('29. altered invoice fingerprint refused');
  else bad('29. altered invoice fingerprint refused', v29.failures.join('; ') || 'no refusal');

  /* 30. altered schedule fingerprint refused. */
  const tamS = JSON.parse(JSON.stringify(schedule));
  tamS.items[0].amount = 9999;
  if (!verifyScheduleFingerprint(tamS).ok) ok('30. altered schedule fingerprint refused');
  else bad('30. altered schedule fingerprint refused', 'still valid');

  /* 31. invoice without provenance (no execution linkage) refused. */
  const orphan = invoice();
  delete orphan.source;
  const v31 = validateInvoiceRecord(orphan, { requireExampleMarker: true });
  if (v31.failures.some((x) => /source|execution_id/.test(x))) ok('31. invoice without execution provenance refused');
  else bad('31. invoice without provenance refused', v31.failures.join('; ') || 'no refusal');

  /* 32. recurring Care not accepted/activated (no Care start) refused. */
  const careBlocked = buildInvoiceRecord(a2, 2, { createdAt: T0, client: clientFor(), project: projectFor('A2'), example: true });
  if (!careBlocked.ok && /Care/.test(careBlocked.reasons.join(' '))) ok('32. recurring Care without accepted/activated start refused');
  else bad('32. Care not activated refused', careBlocked.ok ? 'created' : careBlocked.reasons.join('; '));

  /* 33. milestone out of sequence (later milestone without trigger evidence) refused. */
  const seqBlocked = buildInvoiceRecord(schedule, 2, { createdAt: T0, client: clientFor(), project: projectFor(B2), example: true });
  if (!seqBlocked.ok && /MILESTONE INVOICE TRIGGER/.test(seqBlocked.reasons.join(' '))) ok('33. milestone out of sequence (no trigger evidence) refused');
  else bad('33. milestone out of sequence refused', seqBlocked.ok ? 'created' : seqBlocked.reasons.join('; '));

  /* 34. invoice issue before its gate is satisfied refused. */
  const unSat = buildInvoiceRecord(a2, 1, { createdAt: T0, goLive: fakeGl, issue: true, issueDate: '2026-09-01' });
  if (!unSat.ok && /Go-Live|GO_LIVE|evidence_ref/.test(unSat.reasons.join(' '))) ok('34. invoice cannot be ISSUED before its issuance gate is satisfied');
  else bad('34. issue before gate refused', unSat.ok ? 'issued' : unSat.reasons.join('; '));

  /* 35. fake bank details refused. */
  const bank = invoice();
  bank.audit_events[0].detail = 'Sort code 12-34-56, account number 87654321';
  const v35 = validateInvoiceRecord(bank, { requireExampleMarker: true });
  if (v35.failures.some((x) => /bank detail/.test(x))) ok('35. fake bank details refused');
  else bad('35. fake bank details refused', v35.failures.join('; ') || 'no refusal');

  /* 36. payment-link generation refused. */
  const pl = invoice();
  pl.audit_events[0].detail = 'Pay via payment link: https://buy.stripe.com/xyz';
  const v36 = validateInvoiceRecord(pl, { requireExampleMarker: true });
  if (v36.failures.some((x) => /payment-link|payment link/.test(x))) ok('36. payment-link generation refused');
  else bad('36. payment-link generation refused', v36.failures.join('; ') || 'no refusal');
}

/* ------------------------------------------------------------------ */
/* 4. PRIVACY + governance safety                                      */
/* ------------------------------------------------------------------ */
function privacy() {
  section('PRIVACY + GOVERNANCE SAFETY');
  /* No real client data anywhere under the billing layer's committed/private areas
     beyond synthetic fixtures (example.com / fictional names only). */
  const walk = (dir) => {
    const out = [];
    if (!fs.existsSync(dir)) return out;
    for (const f of fs.readdirSync(dir, { withFileTypes: true })) {
      const p = path.join(dir, f.name);
      if (f.isDirectory()) out.push(...walk(p));
      else if (f.name.endsWith('.json')) out.push(p);
    }
    return out;
  };
  const suspicious = [
    [/@(?!example\.com)\b[\w.-]+\.(co\.uk|com|org)\b/, 'non-example.com email/domain'],
    [/sk_live_|pk_live_|AKIA[0-9A-Z]{16}/, 'live credential'],
    [/\b(\d{8})\b/, '8-digit account number'],
    [/\b\d{2}-\d{2}-\d{2}\b/, 'sort code'],
    [/\b[A-Z]{2}\d{2}[A-Z0-9]{11,}\b/, 'IBAN'],
    [/stripe\.com|paypal|buy\.stripe|checkout/, 'payment-provider reference']
  ];
  for (const p of walk(BILL_TMP)) {
    if (p.endsWith('issued-immutability.json')) continue; /* handled by negative tests */
    const text = fs.readFileSync(p, 'utf8');
    for (const [re, label] of suspicious) {
      if (re.test(text)) { bad(`privacy: ${path.relative(root, p)} contains ${label}`, String(re)); break; }
    }
  }
  ok('privacy sweep over generated fixtures (no real client data / secrets / bank / payment refs)');

  const protectedFiles = [
    path.join(root, 'docs', 'constitution', 'COMMERCIAL-CONSTITUTION.md'),
    path.join(root, 'ops', 'billing-source-of-truth.json'),
    path.join(root, 'ops', 'INVOICE-FLOW.md')
  ];
  for (const p of protectedFiles) {
    if (fs.existsSync(p)) ok(`governance source untouched (exists): ${path.relative(root, p)}`);
  }
}

function cleanup() {
  fs.rmSync(BILL_TMP, { recursive: true, force: true });
  fs.rmSync(EXEC_TMP, { recursive: true, force: true });
  fs.rmSync(AGR_TMP, { recursive: true, force: true });
  fs.rmSync(OUT_DIR, { recursive: true, force: true });
  fs.rmSync(PRIVATE_DIR, { recursive: true, force: true });
  ok('temporary billing fixtures cleaned up (all under gitignored locations)');
}

/* ------------------------------------------------------------------ */
/* MAIN                                                               */
/* ------------------------------------------------------------------ */
function main() {
  console.log('NEXORA PROP.8 — Governed Invoice & Billing Engine validation');
  try {
    section('PREPARE');
    const agreementPaths = buildReadyAgreements();
    const executions = {};
    let seq = 101;
    for (const code of Object.keys(OFFERINGS)) {
      executions[code] = runExecutionChain(agreementPaths[code], code, seq);
      seq++;
    }
    ok(`synthetic READY agreements + genuine EXECUTED records built for ${Object.keys(OFFERINGS).length} offerings`);
    const schedules = buildSchedules(agreementPaths, executions);
    ok('billing schedules derived from genuine EXECUTED records');

    staticSafety();
    positiveSchedules(schedules);
    const issued = positiveInvoices(schedules);
    const gl = positiveAI(schedules);
    positiveCare(schedules);
    positiveDueDateVatImmutability(schedules, gl);
    negativeTests(agreementPaths, executions, schedules);
    privacy();
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
    console.log('ALL BILLING CHECKS PASSED');
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
