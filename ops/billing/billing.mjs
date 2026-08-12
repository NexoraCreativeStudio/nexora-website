#!/usr/bin/env node
/* Nexora Governed Invoice & Billing Engine (PROP.8) — local CLI.
   Turns an EXECUTED Agreement Execution (PROP.7) + the governed READY
   Agreement (PROP.5) into a billing schedule, governed invoice records,
   Go-Live modelling and recurring-billing readiness.

   Flow:
     EXECUTED Agreement Execution (PROP.7)
       -> schedule          : derive the governed billing schedule (NOT issuance)
       -> create            : build a governed invoice record (gate-driven)
       -> issue / void / cancel : evidence-driven status transitions
       -> verify / list-due : integrity + inspection
       -> record-go-live    : explicit operational Go-Live record (never inferred)
       -> recurring-status  : recurring-billing readiness inspection

   Boundaries (explicit):
     - Invoice != Payment. ISSUED != PAID. EXECUTED Agreement != PAID.
       Invoice created != payment collected.
     - There is NO mark-paid, NO --force-paid, NO --fake-payment. Payment
       status stays UNPAID/UNKNOWN; PAID requires evidence from a future
       reconciliation layer.
     - Invoices derive ONLY from the Approved Final Project Price (and the
       governed setup/recurring/Care fees) — never the public/reference price.
     - AI recurring billing begins ONLY at a recorded Go-Live; it is NEVER
       inferred from the execution date, proposal acceptance or project start.
     - Care is billed monthly in advance and never silently activated.
     - Due date = issue date + 7 calendar days (governed invoice term).
     - VAT is UNDETERMINED — no tax determination is ever made or claimed.
     - This CLI makes NO network calls, sends no emails, creates no Payment
       Intents / Checkout Sessions / Payment Links, and does not collect
       payment of any kind.

   Usage:
     node ops/billing/billing.mjs schedule <agreement.json> <execution-record.json> [options]
     node ops/billing/billing.mjs create <schedule.json> --item <index> [options]
     node ops/billing/billing.mjs issue <invoice.json> [options]
     node ops/billing/billing.mjs void <invoice.json> [options]
     node ops/billing/billing.mjs cancel <invoice.json> [options]
     node ops/billing/billing.mjs verify <schedule-or-invoice.json>
     node ops/billing/billing.mjs list-due <dir> [--as-of <YYYY-MM-DD>]
     node ops/billing/billing.mjs record-go-live --execution <record.json> --occurred-at <YYYY-MM-DD> --evidence-ref <ref> [options]
     node ops/billing/billing.mjs recurring-status <schedule.json> [--go-live <go-live.json>]

   schedule options:
     --generated-at <ISO>   deterministic timestamp override (tests)
     --output <dir>         write into <dir> (default ops/billing/out)
     --example              mark the schedule "_example": true (committed fixtures)
     --overwrite            allow replacing an existing schedule for the same id
     --check                validate only (no write)

   create options:
     --item <index>         schedule item index (0-based)
     --go-live <path>       Go-Live record (required for AI recurring items)
     --care-start <date>    governed Care start date (required for Care items)
     --milestone-evidence <ref>  governed milestone trigger evidence (required
                            for milestone > 1 — OWNER/OPERATIONS DECISION)
     --client-name <name>   client name
     --client-company <c>   client company
     --project-title <t>    project title
     --issue                create directly as ISSUED (satisfies gate + due date)
     --issue-date <date>    issue date (default: today); due = +7 days
     --generated-at <ISO>   deterministic timestamp override (tests)
     --output <dir>         write into <dir> (default ops/billing/out)
     --example              mark the invoice "_example": true (committed fixtures)
     --overwrite            allow replacing a non-issued invoice for the same id

   issue/void/cancel options:
     --generated-at <ISO>   deterministic timestamp override (tests)
     --out <path>           explicit output path
     --overwrite            allow replacing a non-issued target record
     --issue-date <date>    issue date (issue only)

   record-go-live options:
     --execution <path>     EXECUTED execution record (proves completion)
     --occurred-at <date>   Go-Live date (YYYY-MM-DD)
     --evidence-ref <ref>   explicit operational evidence reference (required)
     --output <dir>         write into <dir> (default ops/billing/out)
     --generated-at <ISO>   deterministic timestamp override (tests)
     --example              mark the record "_example": true (committed fixtures)
     --overwrite            allow replacing an existing Go-Live record

   Input safety:
     Agreements    -> ops/agreements/private|examples and
                      ops/proposals/private|examples (else REFUSED)
     Executions    -> ops/execution/out|private|examples (else REFUSED)
     Billing files -> ops/billing/out|private|examples (else REFUSED)
     Committed examples must be marked "_example": true. */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import {
  OUT_DIR,
  BILLING_SCHEMA,
  INVOICE_SCHEMA,
  classifyBillingInput,
  assertSafeBillingOutput,
  scheduleFilename,
  invoiceFilename,
  goLiveFilename,
  deriveInvoiceSchedule,
  buildInvoiceRecord,
  validateInvoiceRecord,
  verifyScheduleFingerprint,
  validateGoLiveRecord,
  buildGoLiveRecord,
  applyInvoiceEvent
} from './billing-validation.mjs';
import { classifyInput as classifyAgreementInput } from '../agreements/agreement-validation.mjs';
import { classifyExecutionInput, validateExecutionRecord, verifyExecutionFingerprint } from '../execution/execution-validation.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.join(__dirname, '..', '..');

export class BillingError extends Error {}

/* ------------------------------------------------------------------ */
/* Helpers                                                             */
/* ------------------------------------------------------------------ */
function readJson(p) {
  return JSON.parse(fs.readFileSync(p, 'utf8'));
}
function writeJson(p, obj) {
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, JSON.stringify(obj, null, 2) + '\n');
}
function isIso(t) {
  return typeof t === 'string' && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/.test(t);
}
function nextStamp(opts) {
  if (opts.generatedAt && isIso(opts.generatedAt)) return opts.generatedAt;
  if (opts.generatedAt) throw new BillingError(`Invalid --generated-at "${opts.generatedAt}" — ISO-8601 required`);
  return new Date().toISOString();
}
const IMMUTABLE_INVOICE_STATUSES = ['ISSUED', 'DUE'];
function refuseOverwrite(target, opts) {
  if (!fs.existsSync(target)) return;
  if (opts.overwrite) {
    /* Even with --overwrite, issued invoices are immutable — never replaced. */
    let existing = null;
    try { existing = JSON.parse(fs.readFileSync(target, 'utf8')); } catch { existing = null; }
    if (existing && existing.schema === INVOICE_SCHEMA && IMMUTABLE_INVOICE_STATUSES.includes(existing.status)) {
      throw new BillingError(`Refusing to overwrite issued invoice: ${path.relative(root, target)}\n` +
        `${existing.invoice_id} is ${existing.status} — issued invoices are immutable and are never overwritten. ` +
        'Corrections require VOID + a new governed invoice, never an edit.');
    }
    return;
  }
  throw new BillingError(`Refusing to overwrite existing output: ${path.relative(root, target)}\n` +
    'An artifact already exists for this id + version. Use --overwrite to replace a non-issued artifact.\n' +
    'Issued invoices are immutable and are never overwritten.');
}

/* ------------------------------------------------------------------ */
/* schedule                                                            */
/* ------------------------------------------------------------------ */
function runSchedule(opts) {
  const agreementPath = path.resolve(opts.positional[1]);
  const executionPath = path.resolve(opts.positional[2]);
  if (!agreementPath || !executionPath) { usage(process.stderr); process.stderr.write('schedule requires <agreement.json> <execution-record.json>\n'); return 2; }
  if (classifyAgreementInput(agreementPath) === 'UNSAFE') {
    process.stderr.write(`Refusing unsafe agreement input: ${agreementPath}\nAgreements must come from ops/agreements/private|examples or ops/proposals/private|examples.\n`); return 1;
  }
  if (classifyExecutionInput(executionPath) === 'UNSAFE') {
    process.stderr.write(`Refusing unsafe execution input: ${executionPath}\nExecution records must come from ops/execution/out|private|examples.\n`); return 1;
  }
  const agreement = readJson(agreementPath);
  const executionRecord = readJson(executionPath);
  const derived = deriveInvoiceSchedule(agreement, executionRecord, {
    generatedAt: nextStamp(opts),
    example: opts.example === true
  });
  if (!derived.ok) {
    process.stderr.write(`SCHEDULE REFUSED — ${derived.reasons.length} issue(s). No billing schedule derived.\n`);
    for (const r of derived.reasons) process.stderr.write(`  FAIL ${r}\n`);
    return 1;
  }
  const schedule = derived.schedule;
  const outDir = path.resolve(opts.output || OUT_DIR);
  const unsafe = assertSafeBillingOutput(outDir);
  if (!unsafe.ok) { process.stderr.write(unsafe.reason + '\n'); return 1; }
  if (opts.check) {
    process.stdout.write(`CHECK OK — billing schedule would be derived: ${schedule.billing_schedule_id}\n`);
    printSchedule(schedule);
    return 0;
  }
  const target = path.join(outDir, scheduleFilename(schedule.billing_schedule_id, schedule.version));
  try { refuseOverwrite(target, opts); } catch (e) { process.stderr.write(e.message + '\n'); return 1; }
  writeJson(target, schedule);
  process.stdout.write(`Billing schedule derived: ${schedule.billing_schedule_id} v${schedule.version}\n`);
  process.stdout.write(`Record written: ${path.relative(root, target)}\n`);
  printSchedule(schedule);
  return 0;
}

function printSchedule(schedule) {
  for (const item of schedule.items) {
    process.stdout.write(`  ${item.invoice_type} · ${item.amount} ${schedule.currency} · gate ${item.issuance.gate}\n`);
  }
  const rec = schedule.recurring || {};
  if (rec.ai) process.stdout.write(`  recurring ai: ${rec.ai.monthly_fee} ${schedule.currency}/month · starts at GO_LIVE · state ${rec.ai.state}\n`);
  if (rec.care) process.stdout.write(`  recurring care: ${rec.care.monthly_fee} ${schedule.currency}/month (in advance) · state ${rec.care.state}\n`);
  process.stdout.write('  NOTE: schedule generation is NOT invoice issuance.\n');
}

/* ------------------------------------------------------------------ */
/* create                                                              */
/* ------------------------------------------------------------------ */
function runCreate(opts) {
  const schedulePath = path.resolve(opts.positional[1]);
  if (!schedulePath) { usage(process.stderr); process.stderr.write('create requires <schedule.json>\n'); return 2; }
  if (classifyBillingInput(schedulePath) === 'UNSAFE') {
    process.stderr.write(`Refusing unsafe billing input: ${schedulePath}\nBilling files must come from ops/billing/out|private|examples.\n`); return 1;
  }
  if (typeof opts.item !== 'string' || !/^\d+$/.test(opts.item)) {
    process.stderr.write('create requires --item <index> (0-based schedule item index)\n'); return 2;
  }
  const itemIndex = Number(opts.item);
  const schedule = readJson(schedulePath);
  if (!schedule || schedule.schema !== BILLING_SCHEMA) {
    process.stderr.write('Not a billing schedule (schema mismatch).\n'); return 1;
  }
  const fp = verifyScheduleFingerprint(schedule);
  if (!fp.ok) {
    process.stderr.write(`SCHEDULE TAMPERED — ${fp.reasons.join('; ')}\n`); return 1;
  }
  const item = schedule.items && schedule.items[itemIndex];
  if (!item) { process.stderr.write(`Schedule item ${itemIndex} not found.\n`); return 1; }

  let goLive = null;
  if (opts.goLive) {
    if (classifyBillingInput(path.resolve(opts.goLive)) === 'UNSAFE') {
      process.stderr.write(`Refusing unsafe Go-Live input: ${opts.goLive}\n`); return 1;
    }
    goLive = readJson(path.resolve(opts.goLive));
    const gl = validateGoLiveRecord(goLive);
    if (!gl.ok) { process.stderr.write(`GO-LIVE RECORD INVALID — ${gl.reasons.join('; ')}\n`); return 1; }
  }
  const built = buildInvoiceRecord(schedule, itemIndex, {
    createdAt: nextStamp(opts),
    goLive,
    careStart: opts.careStart || null,
    milestoneEvidence: opts.milestoneEvidence || null,
    issue: opts.issue === true,
    issueDate: opts.issueDate || null,
    client: (opts.clientName || opts.clientCompany)
      ? { name: opts.clientName || null, company: opts.clientCompany || null, billing_email: null, billing_address: null }
      : null,
    project: opts.projectTitle ? { title: opts.projectTitle } : null,
    example: opts.example === true
  });
  if (!built.ok) {
    process.stderr.write(`INVOICE REFUSED — ${built.reasons.length} issue(s). No invoice created.\n`);
    for (const r of built.reasons) process.stderr.write(`  FAIL ${r}\n`);
    return 1;
  }
  const record = built.record;
  if (opts.issue === true && !opts.clientName && !opts.clientCompany) {
    process.stderr.write('create --issue requires --client-name and --client-company (an issued invoice must carry the governed client identity)\n');
    return 1;
  }
  const v = validateInvoiceRecord(record, { requireExampleMarker: opts.example === true });
  if (v.failures.length > 0) {
    process.stderr.write(`INVOICE INVALID — ${v.failures.length} issue(s). No invoice written.\n`);
    for (const f of v.failures) process.stderr.write(`  FAIL ${f}\n`);
    return 1;
  }
  const outDir = path.resolve(opts.output || OUT_DIR);
  const unsafe = assertSafeBillingOutput(outDir);
  if (!unsafe.ok) { process.stderr.write(unsafe.reason + '\n'); return 1; }
  const target = path.join(outDir, invoiceFilename(record.invoice_id, record.invoice_version));
  try { refuseOverwrite(target, opts); } catch (e) { process.stderr.write(e.message + '\n'); return 1; }
  writeJson(target, record);
  process.stdout.write(`Invoice created: ${record.invoice_id} (${record.invoice_type}) ${record.total} ${record.currency} — ${record.status}\n`);
  process.stdout.write(`Record written: ${path.relative(root, target)}\n`);
  if (record.issue_date) process.stdout.write(`Issue date ${record.issue_date} · due date ${record.due_date} (due = issue + 7 calendar days)\n`);
  if (record.recurring && record.recurring.billing_start_date) {
    process.stdout.write(`AI recurring billing starts ${record.recurring.billing_start_date} (recorded Go-Live ${record.recurring.go_live_at})\n`);
  }
  return 0;
}

/* ------------------------------------------------------------------ */
/* transitions: issue / void / cancel                                  */
/* ------------------------------------------------------------------ */
function runTransition(opts, eventType) {
  const pathArg = path.resolve(opts.positional[1]);
  if (!pathArg) { usage(process.stderr); process.stderr.write(`${opts.positional[0]} requires <invoice.json>\n`); return 2; }
  if (classifyBillingInput(pathArg) === 'UNSAFE') {
    process.stderr.write(`Refusing unsafe billing input: ${pathArg}\nBilling files must come from ops/billing/out|private|examples.\n`); return 1;
  }
  const record = readJson(pathArg);
  if (!record || record.schema !== INVOICE_SCHEMA) {
    process.stderr.write('Not an invoice record (schema mismatch).\n'); return 1;
  }
  const event = { event_type: eventType, at: nextStamp(opts) };
  if (eventType === 'ISSUE') event.issue_date = opts.issueDate || event.at.slice(0, 10);
  const applied = applyInvoiceEvent(record, event);
  if (!applied.ok) {
    process.stderr.write(`TRANSITION REJECTED — ${applied.reasons.join('; ')}\n`);
    return 1;
  }
  const outDir = path.resolve(opts.output || OUT_DIR);
  const unsafe = assertSafeBillingOutput(outDir);
  if (!unsafe.ok) { process.stderr.write(unsafe.reason + '\n'); return 1; }
  const recordPath = opts.out
    ? path.resolve(opts.out)
    : path.join(outDir, invoiceFilename(applied.record.invoice_id, applied.record.invoice_version));
  const targetUnsafe = assertSafeBillingOutput(recordPath);
  if (!targetUnsafe.ok) { process.stderr.write(targetUnsafe.reason + '\n'); return 1; }
  try { refuseOverwrite(recordPath, opts); } catch (e) { process.stderr.write(e.message + '\n'); return 1; }
  writeJson(recordPath, applied.record);
  process.stdout.write(`${record.status} -> ${applied.record.status} (${applied.record.invoice_id})\n`);
  if (applied.record.issue_date) process.stdout.write(`Issue date ${applied.record.issue_date} · due date ${applied.record.due_date} (due = issue + 7 calendar days)\n`);
  process.stdout.write(`Record written: ${path.relative(root, recordPath)}\n`);
  return 0;
}

/* ------------------------------------------------------------------ */
/* verify                                                              */
/* ------------------------------------------------------------------ */
function runVerify(opts) {
  const p = path.resolve(opts.positional[1]);
  if (!p) { usage(process.stderr); process.stderr.write('verify requires <schedule-or-invoice.json>\n'); return 2; }
  if (classifyBillingInput(p) === 'UNSAFE') {
    process.stderr.write(`Refusing unsafe billing input: ${p}\nBilling files must come from ops/billing/out|private|examples.\n`); return 1;
  }
  const record = readJson(p);
  let failures = [];
  if (record && record.schema === BILLING_SCHEMA) {
    const fp = verifyScheduleFingerprint(record);
    failures = fp.ok ? [] : fp.reasons;
    if (!fp.ok) {
      process.stderr.write(`SCHEDULE INVALID — ${failures.length} issue(s).\n`);
      for (const f of failures) process.stderr.write(`  FAIL ${f}\n`);
      return 1;
    }
    process.stdout.write(`OK — billing schedule ${record.billing_schedule_id} v${record.version} fingerprint valid.\n`);
    return 0;
  }
  if (record && record.schema === INVOICE_SCHEMA) {
    const v = validateInvoiceRecord(record, { requireExampleMarker: false });
    failures = v.failures;
    if (failures.length > 0) {
      process.stderr.write(`INVOICE INVALID — ${failures.length} issue(s).\n`);
      for (const f of failures) process.stderr.write(`  FAIL ${f}\n`);
      return 1;
    }
    process.stdout.write(`OK — invoice ${record.invoice_id} (${record.status}) ${record.total} ${record.currency} fingerprint valid.\n`);
    if (record.issue_date) process.stdout.write(`Issue ${record.issue_date} · due ${record.due_date}\n`);
    return 0;
  }
  process.stderr.write('Not a billing schedule or invoice record (schema mismatch).\n');
  return 1;
}

/* ------------------------------------------------------------------ */
/* list-due                                                            */
/* ------------------------------------------------------------------ */
function runListDue(opts) {
  const dir = path.resolve(opts.positional[1]);
  if (!dir) { usage(process.stderr); process.stderr.write('list-due requires <dir>\n'); return 2; }
  if (!fs.existsSync(dir) || !fs.statSync(dir).isDirectory()) {
    process.stderr.write(`Not a directory: ${dir}\n`); return 1;
  }
  const asOf = opts.asOf || new Date().toISOString().slice(0, 10);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(asOf)) {
    process.stderr.write(`Invalid --as-of "${asOf}" — YYYY-MM-DD required\n`); return 1;
  }
  let found = 0;
  for (const f of fs.readdirSync(dir).sort()) {
    if (!f.endsWith('.invoice.json')) continue;
    let record;
    try { record = JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8')); } catch { continue; }
    if (!record || record.schema !== INVOICE_SCHEMA) continue;
    if (record.status !== 'ISSUED') continue;
    if (!record.due_date || record.due_date > asOf) continue;
    found++;
    process.stdout.write(`DUE ${record.due_date} · ${record.invoice_id} · ${record.invoice_type} · ${record.total} ${record.currency} · ${record.client && record.client.company || '(no company)'}\n`);
  }
  process.stdout.write(`${found} invoice(s) due by ${asOf}. ISSUED != PAID — this is a due-date list only, not a payment or reconciliation report.\n`);
  return 0;
}

/* ------------------------------------------------------------------ */
/* record-go-live                                                      */
/* ------------------------------------------------------------------ */
function runRecordGoLive(opts) {
  if (!opts.execution || !opts.occurredAt || !opts.evidenceRef) {
    usage(process.stderr);
    process.stderr.write('record-go-live requires --execution <record.json> --occurred-at <YYYY-MM-DD> --evidence-ref <ref>\n');
    return 2;
  }
  if (!/^\d{4}-\d{2}-\d{2}$/.test(opts.occurredAt)) {
    process.stderr.write(`Invalid --occurred-at "${opts.occurredAt}" — YYYY-MM-DD required\n`); return 1;
  }
  const executionPath = path.resolve(opts.execution);
  if (classifyExecutionInput(executionPath) === 'UNSAFE') {
    process.stderr.write(`Refusing unsafe execution input: ${executionPath}\nExecution records must come from ops/execution/out|private|examples.\n`); return 1;
  }
  const executionRecord = readJson(executionPath);
  const ev = validateExecutionRecord(executionRecord, { requireExampleMarker: false });
  if (ev.failures.length > 0) {
    process.stderr.write(`EXECUTION RECORD INVALID — ${ev.failures.slice(0, 3).join('; ')}\n`); return 1;
  }
  const fp = verifyExecutionFingerprint(executionRecord);
  if (!fp.ok) { process.stderr.write(`EXECUTION TAMPERED — ${fp.reasons.join('; ')}\n`); return 1; }
  if (executionRecord.status !== 'EXECUTED') {
    process.stderr.write(`Go-Live requires an EXECUTED Agreement — execution status is ${executionRecord.status}. Go-Live is NEVER inferred.\n`); return 1;
  }
  const record = buildGoLiveRecord({
    agreementId: executionRecord.agreement_id,
    executionId: executionRecord.execution_id,
    occurredAt: opts.occurredAt,
    recordedAt: nextStamp(opts),
    evidenceRef: opts.evidenceRef,
    example: opts.example === true
  });
  const outDir = path.resolve(opts.output || OUT_DIR);
  const unsafe = assertSafeBillingOutput(outDir);
  if (!unsafe.ok) { process.stderr.write(unsafe.reason + '\n'); return 1; }
  const target = path.join(outDir, goLiveFilename(executionRecord.agreement_id));
  try { refuseOverwrite(target, opts); } catch (e) { process.stderr.write(e.message + '\n'); return 1; }
  writeJson(target, record);
  process.stdout.write(`Go-Live recorded: ${record.agreement_id} · ${record.occurred_at} · evidence ${record.evidence_ref}\n`);
  process.stdout.write(`Record written: ${path.relative(root, target)}\n`);
  return 0;
}

/* ------------------------------------------------------------------ */
/* recurring-status                                                    */
/* ------------------------------------------------------------------ */
function runRecurringStatus(opts) {
  const p = path.resolve(opts.positional[1]);
  if (!p) { usage(process.stderr); process.stderr.write('recurring-status requires <schedule.json>\n'); return 2; }
  if (classifyBillingInput(p) === 'UNSAFE') {
    process.stderr.write(`Refusing unsafe billing input: ${p}\nBilling files must come from ops/billing/out|private|examples.\n`); return 1;
  }
  const schedule = readJson(p);
  if (!schedule || schedule.schema !== BILLING_SCHEMA) {
    process.stderr.write('Not a billing schedule (schema mismatch).\n'); return 1;
  }
  const fp = verifyScheduleFingerprint(schedule);
  if (!fp.ok) { process.stderr.write(`SCHEDULE TAMPERED — ${fp.reasons.join('; ')}\n`); return 1; }
  let goLive = null;
  if (opts.goLive) {
    if (classifyBillingInput(path.resolve(opts.goLive)) === 'UNSAFE') {
      process.stderr.write(`Refusing unsafe Go-Live input: ${opts.goLive}\n`); return 1;
    }
    goLive = readJson(path.resolve(opts.goLive));
    const gl = validateGoLiveRecord(goLive);
    if (!gl.ok) { process.stderr.write(`GO-LIVE RECORD INVALID — ${gl.reasons.join('; ')}\n`); return 1; }
  }
  const rec = schedule.recurring || {};
  process.stdout.write(`Recurring-billing readiness for ${schedule.billing_schedule_id}:\n`);
  if (rec.ai) {
    const goLiveReady = goLive && goLive.agreement_id === schedule.source.agreement_id;
    const firstOfNext = goLiveReady ? goLive.occurred_at : null;
    const billingStart = goLiveReady ? firstOfNext : null;
    process.stdout.write(`  AI monthly service: ${rec.ai.monthly_fee} ${schedule.currency}/month\n`);
    process.stdout.write(`    starts at GO_LIVE (never inferred) — recorded Go-Live: ${goLiveReady ? goLive.occurred_at : 'NONE'}\n`);
    if (goLiveReady) {
      const start = billingStartFor(goLive.occurred_at);
      process.stdout.write(`    billing start: ${start} (first of month after Go-Live) · next billing: ${start ? nextBillingFor(start) : 'n/a'}\n`);
    } else {
      process.stdout.write(`    state: AWAITING_GO_LIVE — recurring billing is BLOCKED until a Go-Live is recorded\n`);
    }
  }
  if (rec.care) {
    process.stdout.write(`  Care monthly service: ${rec.care.monthly_fee} ${schedule.currency}/month (billed in advance)\n`);
    process.stdout.write(`    care start: ${rec.care.care_start || 'not recorded — requires an explicit governed Care start, never silent activation'}\n`);
  }
  if (!rec.ai && !rec.care) process.stdout.write('  (no recurring services in this schedule)\n');
  return 0;
}

function billingStartFor(goLiveDate) {
  const [y, m] = goLiveDate.split('-').map(Number);
  return m === 12 ? `${y + 1}-01-01` : `${y}-${String(m + 1).padStart(2, '0')}-01`;
}
function nextBillingFor(start) {
  const [y, m] = start.split('-').map(Number);
  return m === 12 ? `${y + 1}-01-01` : `${y}-${String(m + 1).padStart(2, '0')}-01`;
}

/* ------------------------------------------------------------------ */
/* CLI                                                                */
/* ------------------------------------------------------------------ */
function usage(out) {
  out.write(`Nexora Governed Invoice & Billing Engine (PROP.8)
Turns an EXECUTED Agreement Execution (PROP.7) + the governed READY Agreement
(PROP.5) into a billing schedule, governed invoice records, Go-Live modelling
and recurring-billing readiness. Evidence-driven only.

Boundaries: Invoice != Payment · ISSUED != PAID · EXECUTED != PAID ·
No mark-paid / --force-paid / --fake-payment · No network/payment calls ·
VAT UNDETERMINED · Due date = issue + 7 days · AI recurring starts ONLY at a
recorded Go-Live (never inferred) · Care billed monthly in advance.

Commands:
  node ops/billing/billing.mjs schedule <agreement.json> <execution-record.json> [options]
  node ops/billing/billing.mjs create <schedule.json> --item <index> [options]
  node ops/billing/billing.mjs issue <invoice.json> [options]
  node ops/billing/billing.mjs void <invoice.json> [options]
  node ops/billing/billing.mjs cancel <invoice.json> [options]
  node ops/billing/billing.mjs verify <schedule-or-invoice.json>
  node ops/billing/billing.mjs list-due <dir> [--as-of <YYYY-MM-DD>]
  node ops/billing/billing.mjs record-go-live --execution <record.json> --occurred-at <YYYY-MM-DD> --evidence-ref <ref> [options]
  node ops/billing/billing.mjs recurring-status <schedule.json> [--go-live <go-live.json>]

schedule options:
  --generated-at <ISO>  deterministic timestamp override (tests)
  --output <dir>        write into <dir> (default ops/billing/out)
  --example             mark the schedule "_example": true
  --overwrite           allow replacing an existing schedule for the same id
  --check               validate only (no write)

create options:
  --item <index>        schedule item index (0-based)
  --go-live <path>      Go-Live record (required for AI recurring items)
  --care-start <date>   governed Care start date (required for Care items)
  --milestone-evidence <ref>  governed milestone trigger evidence
                        (required for milestone > 1 — OWNER/OPERATIONS DECISION)
  --client-name <name>  client name
  --client-company <c>  client company
  --project-title <t>   project title
  --issue               create directly as ISSUED (satisfies gate + due date)
  --issue-date <date>   issue date (default: today); due = +7 days
  --generated-at <ISO>  deterministic timestamp override (tests)
  --output <dir>        write into <dir> (default ops/billing/out)
  --example             mark the invoice "_example": true
  --overwrite           allow replacing a non-issued invoice for the same id

issue/void/cancel options:
  --generated-at <ISO>  deterministic timestamp override (tests)
  --out <path>          explicit output path
  --overwrite           allow replacing a non-issued target record
  --issue-date <date>   issue date (issue only)

record-go-live options:
  --execution <path>    EXECUTED execution record (proves completion)
  --occurred-at <date>  Go-Live date (YYYY-MM-DD)
  --evidence-ref <ref>  explicit operational evidence reference (required)
  --output <dir>        write into <dir> (default ops/billing/out)
  --generated-at <ISO>  deterministic timestamp override (tests)
  --example             mark the record "_example": true
  --overwrite           allow replacing an existing Go-Live record

Input safety:
  Agreements    -> ops/agreements/private|examples and
                   ops/proposals/private|examples (else refused)
  Executions    -> ops/execution/out|private|examples (else refused)
  Billing files -> ops/billing/out|private|examples (else refused)
  Committed examples must be marked "_example": true.`);
}

function parseArgs(args) {
  const opts = { positional: [] };
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === '--item') opts.item = args[++i];
    else if (a === '--go-live') opts.goLive = args[++i];
    else if (a === '--care-start') opts.careStart = args[++i];
    else if (a === '--milestone-evidence') opts.milestoneEvidence = args[++i];
    else if (a === '--client-name') opts.clientName = args[++i];
    else if (a === '--client-company') opts.clientCompany = args[++i];
    else if (a === '--project-title') opts.projectTitle = args[++i];
    else if (a === '--issue') opts.issue = true;
    else if (a === '--issue-date') opts.issueDate = args[++i];
    else if (a === '--occurred-at') opts.occurredAt = args[++i];
    else if (a === '--evidence-ref') opts.evidenceRef = args[++i];
    else if (a === '--execution') opts.execution = args[++i];
    else if (a === '--as-of') opts.asOf = args[++i];
    else if (a === '--output') opts.output = args[++i];
    else if (a === '--generated-at') opts.generatedAt = args[++i];
    else if (a === '--example') opts.example = true;
    else if (a === '--overwrite') opts.overwrite = true;
    else if (a === '--check') opts.check = true;
    else if (a === '--out') opts.out = args[++i];
    else if (a === '--help' || a === '-h') opts.help = true;
    else if (a.startsWith('-')) { opts.bad = a; }
    else opts.positional.push(a);
  }
  return opts;
}

function main() {
  const opts = parseArgs(process.argv.slice(2));
  const cmd = opts.positional[0];
  if (opts.bad) {
    usage(process.stderr);
    process.stderr.write(`Unknown option: ${opts.bad}\n`);
    return 2;
  }
  if (opts.help) { usage(process.stdout); return 0; }
  switch (cmd) {
    case 'schedule': return runSchedule(opts);
    case 'create': return runCreate(opts);
    case 'issue': return runTransition(opts, 'ISSUE');
    case 'void': return runTransition(opts, 'VOID');
    case 'cancel': return runTransition(opts, 'CANCEL');
    case 'verify': return runVerify(opts);
    case 'list-due': return runListDue(opts);
    case 'record-go-live': return runRecordGoLive(opts);
    case 'recurring-status': return runRecurringStatus(opts);
    default:
      usage(process.stderr);
      return cmd ? 2 : 0;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exit(main());
}
