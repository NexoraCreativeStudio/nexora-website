#!/usr/bin/env node
/* Nexora Governed Payment Collection & Reconciliation (PROP.9) — local CLI.
   TEST/SANDBOX-FIRST. Connects a governed ISSUED Invoice (PROP.8) to governed
   payment-request, provider-abstraction, webhook, idempotency, and
   reconciliation machinery — without ever collecting payment, calling a
   provider, deploying a webhook, or marking PAID without reconciled evidence.

   Flow:
     ISSUED Invoice (PROP.8)
       -> request      : build a governed Payment Request (amount from invoice)
       -> pay          : create a payment record from the request
       -> record-event : record a normalised provider/webhook event (NOT payment)
       -> reconcile    : run reconciliation; settle only on governed outcome
       -> refund-record: record a provider-backed refund (links to payment)
       -> verify / status : inspection

   Boundaries (explicit):
     - PAYMENT REQUEST != PAID. CHECKOUT SESSION != PAID. WEBHOOK RECEIVED !=
       PAID. INVOICE ISSUED != PAID. AGREEMENT EXECUTED != PAID.
     - There is NO mark-paid / --force-paid / --fake-paid / --assume-paid.
       PAID requires governed reconciled payment evidence.
     - No network calls, no live keys, no live charges, no Production activation.
     - Fake Production evidence from the TEST adapter is rejected.
     - This CLI never touches the Commercial Source of Truth or public pricing.

   Usage:
     node ops/payment/payment.mjs request <invoice.json> --amount <n> --currency GBP [options]
     node ops/payment/payment.mjs pay <request.json> [options]
     node ops/payment/payment.mjs record-event <payment.json> --event <event.json> [options]
     node ops/payment/payment.mjs reconcile <payment.json> <invoice.json> --event <webhook.json> [options]
     node ops/payment/payment.mjs refund-record <payment.json> --refund <refund.json> [options]
     node ops/payment/payment.mjs verify <file.json>
     node ops/payment/payment.mjs status <payment.json>

   request options:
     --amount <n>       must equal the invoice total (no override allowed)
     --currency <code>  must equal the invoice currency
     --provider <id>    STRIPE | PAYPAL | BANK_TRANSFER | TEST_ADAPTER (default TEST_ADAPTER)
     --environment <e>  TEST | SANDBOX | PRODUCTION (default TEST)
     --generated-at <ISO> deterministic timestamp override (tests)
     --output <dir>     write into <dir> (default ops/payment/out)
     --example          mark the request "_example": true (committed fixtures)
     --overwrite        allow replacing a non-settled request for the same id

   pay options:
     --generated-at <ISO> deterministic timestamp override (tests)
     --output <dir>     write into <dir> (default ops/payment/out)
     --example          mark the payment "_example": true
     --overwrite        allow replacing a non-settled payment for the same id

   record-event options:
     --event <path>     normalised webhook/provider event JSON
     --generated-at <ISO> deterministic timestamp override (tests)
     --out <path>       explicit output path
     --overwrite        allow replacing a non-settled target record

   reconcile options:
     --event <path>     normalised webhook/provider event JSON
     --provider <id>    adapter id (default TEST_ADAPTER)
     --environment <e>  adapter environment (default TEST)
     --generated-at <ISO> deterministic timestamp override (tests)
     --out <path>       explicit output path
     --overwrite        allow replacing a non-settled target record

   refund-record options:
     --refund <path>    governed refund detail JSON (links to original payment)
     --generated-at <ISO> deterministic timestamp override (tests)
     --out <path>       explicit output path
     --overwrite        allow replacing a non-settled target record

   Input safety:
     Invoices      -> ops/billing/out|private|examples (else REFUSED)
     Payment files -> ops/payment/out|private|examples (else REFUSED)
     Committed examples must be marked "_example": true. */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import {
  OUT_DIR,
  PRIVATE_DIR,
  PAYMENT_SCHEMA,
  PAYMENT_REQUEST_SCHEMA,
  WEBHOOK_EVENT_SCHEMA,
  RECONCILIATION_SCHEMA,
  classifyPaymentInput,
  assertSafePaymentOutput,
  buildPaymentRequest,
  validatePaymentRequest,
  buildPaymentRecord,
  validatePaymentRecord,
  applyPaymentEvent,
  applyReconciliation,
  buildReconciliation,
  validateWebhookEvent,
  verifyRequestFingerprint,
  verifyPaymentFingerprint,
  verifyWebhookFingerprint,
  TestPaymentAdapter,
  PROVIDER_TEST,
  PAYMENT_ENVIRONMENTS,
  PROVIDER_IDS,
  paymentFilename,
  requestFilename,
  reconciliationFilename,
  webhookFilename
} from './payment-validation.mjs';
import { classifyBillingInput } from '../billing/billing-validation.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.join(__dirname, '..', '..');

export class PaymentError extends Error {}

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
  if (opts.generatedAt) throw new PaymentError(`Invalid --generated-at "${opts.generatedAt}" — ISO-8601 required`);
  return new Date().toISOString();
}
function requireExample(req, opts) {
  return opts.example === true;
}
const IMMUTABLE_PAYMENT_STATUSES = ['PAID', 'REFUNDED', 'PARTIALLY_REFUNDED', 'CANCELLED', 'DISPUTED'];
function refuseOverwrite(target, opts) {
  if (!fs.existsSync(target)) return;
  if (opts.overwrite) {
    let existing = null;
    try { existing = JSON.parse(fs.readFileSync(target, 'utf8')); } catch { existing = null; }
    if (existing && existing.schema === PAYMENT_SCHEMA && IMMUTABLE_PAYMENT_STATUSES.includes(existing.status)) {
      throw new PaymentError(`Refusing to overwrite settled payment: ${path.relative(root, target)}\n` +
        `${existing.payment_id} is ${existing.status} — settled payment records are immutable and are never overwritten.`);
    }
    return;
  }
  throw new PaymentError(`Refusing to overwrite existing output: ${path.relative(root, target)}\n` +
    'An artifact already exists for this id + version. Use --overwrite to replace a non-settled artifact.');
}

/* ------------------------------------------------------------------ */
/* request                                                             */
/* ------------------------------------------------------------------ */
async function runRequest(opts) {
  const invoicePath = path.resolve(opts.positional[1]);
  if (!invoicePath) { usage(process.stderr); process.stderr.write('request requires <invoice.json>\n'); return 2; }
  if (classifyBillingInput(invoicePath) === 'UNSAFE') {
    process.stderr.write(`Refusing unsafe invoice input: ${invoicePath}\nInvoices must come from ops/billing/out|private|examples.\n`); return 1;
  }
  const invoice = readJson(invoicePath);
  const amount = Number(opts.amount);
  const currency = opts.currency || invoice.currency;
  if (!Number.isFinite(amount)) { process.stderr.write('request requires --amount <n>\n'); return 2; }
  const built = buildPaymentRequest(invoice, {
    amount, currency,
    provider: opts.provider || PROVIDER_TEST,
    environment: opts.environment || 'TEST',
    createdAt: nextStamp(opts),
    example: opts.example === true
  });
  if (!built.ok) {
    process.stderr.write(`PAYMENT REQUEST REFUSED — ${built.reasons.length} issue(s).\n`);
    for (const r of built.reasons) process.stderr.write(`  FAIL ${r}\n`);
    return 1;
  }
  const req = built.request;
  const v = await validatePaymentRequest(req, { requireExampleMarker: opts.example === true });
  if (v.failures.length > 0) {
    process.stderr.write(`PAYMENT REQUEST INVALID — ${v.failures.length} issue(s).\n`);
    for (const f of v.failures) process.stderr.write(`  FAIL ${f}\n`);
    return 1;
  }
  const outDir = path.resolve(opts.output || OUT_DIR);
  const unsafe = assertSafePaymentOutput(outDir);
  if (!unsafe.ok) { process.stderr.write(unsafe.reason + '\n'); return 1; }
    const target = path.join(outDir, requestFilename(req.request_id));
  try { refuseOverwrite(target, opts); } catch (e) { process.stderr.write(e.message + '\n'); return 1; }
  writeJson(target, req);
  process.stdout.write(`Payment request created: ${req.request_id} for ${req.invoice_id} — ${req.amount_requested} ${req.currency} (${req.provider}/${req.environment})\n`);
  process.stdout.write(`Record written: ${path.relative(root, target)}\n`);
  process.stdout.write('NOTE: PAYMENT REQUEST != PAID.\n');
  return 0;
}

/* ------------------------------------------------------------------ */
/* pay (create payment record from request)                            */
/* ------------------------------------------------------------------ */
async function runPay(opts) {
  const reqPath = path.resolve(opts.positional[1]);
  if (!reqPath) { usage(process.stderr); process.stderr.write('pay requires <request.json>\n'); return 2; }
  if (classifyPaymentInput(reqPath) === 'UNSAFE') {
    process.stderr.write(`Refusing unsafe payment input: ${reqPath}\nPayment files must come from ops/payment/out|private|examples.\n`); return 1;
  }
  const req = readJson(reqPath);
  const built = await buildPaymentRecord(req, { createdAt: nextStamp(opts), example: opts.example === true });
  if (!built.ok) {
    process.stderr.write(`PAYMENT RECORD REFUSED — ${built.reasons.length} issue(s).\n`);
    for (const r of built.reasons) process.stderr.write(`  FAIL ${r}\n`);
    return 1;
  }
  const payment = built.payment;
  const v = await validatePaymentRecord(payment, { requireExampleMarker: opts.example === true });
  if (v.failures.length > 0) {
    process.stderr.write(`PAYMENT RECORD INVALID — ${v.failures.length} issue(s).\n`);
    for (const f of v.failures) process.stderr.write(`  FAIL ${f}\n`);
    return 1;
  }
  const outDir = path.resolve(opts.output || OUT_DIR);
  const unsafe = assertSafePaymentOutput(outDir);
  if (!unsafe.ok) { process.stderr.write(unsafe.reason + '\n'); return 1; }
    const target = path.join(outDir, paymentFilename(payment.payment_id));
  try { refuseOverwrite(target, opts); } catch (e) { process.stderr.write(e.message + '\n'); return 1; }
  writeJson(target, payment);
  process.stdout.write(`Payment record created: ${payment.payment_id} (CREATED) for ${payment.invoice_id} — ${payment.amount_expected} ${payment.currency}\n`);
  process.stdout.write(`Record written: ${path.relative(root, target)}\n`);
  return 0;
}

/* ------------------------------------------------------------------ */
/* record-event (normalised webhook/provider event; NOT payment)       */
/* ------------------------------------------------------------------ */
async function runRecordEvent(opts) {
  const paymentPath = path.resolve(opts.positional[1]);
  const eventPath = opts.event ? path.resolve(opts.event) : null;
  if (!paymentPath || !eventPath) { usage(process.stderr); process.stderr.write('record-event requires <payment.json> --event <webhook.json>\n'); return 2; }
  if (classifyPaymentInput(paymentPath) === 'UNSAFE') {
    process.stderr.write(`Refusing unsafe payment input: ${paymentPath}\n`); return 1;
  }
  if (classifyPaymentInput(eventPath) === 'UNSAFE') {
    process.stderr.write(`Refusing unsafe webhook input: ${eventPath}\n`); return 1;
  }
  const payment = readJson(paymentPath);
  const ev = readJson(eventPath);
  const evv = validateWebhookEvent(ev, { requireExampleMarker: false });
  if (evv.failures.length > 0) {
    process.stderr.write(`WEBHOOK EVENT INVALID — ${evv.failures.length} issue(s).\n`);
    for (const f of evv.failures) process.stderr.write(`  FAIL ${f}\n`);
    return 1;
  }
  const applied = applyPaymentEvent(payment, { event_type: 'RECORD_EVENT', at: nextStamp(opts), evidence_ref: ev.event_id });
  if (!applied.ok) {
    process.stderr.write(`EVENT REJECTED — ${applied.reasons.join('; ')}\n`);
    return 1;
  }
  const v = await validatePaymentRecord(applied.record, { requireExampleMarker: false });
  if (v.failures.length > 0) {
    process.stderr.write(`PAYMENT RECORD INVALID AFTER EVENT — ${v.failures.join('; ')}\n`);
    return 1;
  }
  const outDir = path.resolve(opts.output || OUT_DIR);
  const unsafe = assertSafePaymentOutput(outDir);
  if (!unsafe.ok) { process.stderr.write(unsafe.reason + '\n'); return 1; }
    const target = opts.out ? path.resolve(opts.out) : path.join(outDir, paymentFilename(applied.record.payment_id));
  const tUnsafe = assertSafePaymentOutput(target);
  if (!tUnsafe.ok) { process.stderr.write(tUnsafe.reason + '\n'); return 1; }
  try { refuseOverwrite(target, opts); } catch (e) { process.stderr.write(e.message + '\n'); return 1; }
  writeJson(target, applied.record);
  process.stdout.write(`Event recorded: ${applied.record.payment_id} -> ${applied.record.status} (evidence ${ev.event_id}). WEBHOOK RECEIVED != PAID.\n`);
  process.stdout.write(`Record written: ${path.relative(root, target)}\n`);
  return 0;
}

/* ------------------------------------------------------------------ */
/* reconcile                                                           */
/* ------------------------------------------------------------------ */
async function runReconcile(opts) {
  const paymentPath = path.resolve(opts.positional[1]);
  const invoicePath = path.resolve(opts.positional[2]);
  const eventPath = opts.event ? path.resolve(opts.event) : null;
  if (!paymentPath || !invoicePath || !eventPath) { usage(process.stderr); process.stderr.write('reconcile requires <payment.json> <invoice.json> --event <webhook.json>\n'); return 2; }
  if (classifyPaymentInput(paymentPath) === 'UNSAFE') { process.stderr.write(`Refusing unsafe payment input: ${paymentPath}\n`); return 1; }
  if (classifyBillingInput(invoicePath) === 'UNSAFE') { process.stderr.write(`Refusing unsafe invoice input: ${invoicePath}\n`); return 1; }
  if (classifyPaymentInput(eventPath) === 'UNSAFE') { process.stderr.write(`Refusing unsafe webhook input: ${eventPath}\n`); return 1; }

  const payment = readJson(paymentPath);
  const invoice = readJson(invoicePath);
  const evidence = readJson(eventPath);
  const evv = validateWebhookEvent(evidence, { requireExampleMarker: false });
  if (evv.failures.length > 0) {
    process.stderr.write(`WEBHOOK EVENT INVALID — ${evv.failures.join('; ')}\n`);
    return 1;
  }
  const adapter = new (opts.provider && opts.provider !== PROVIDER_TEST ? PaymentProviderAdapterShim : TestPaymentAdapter)();
  const adapterOutcome = adapter.reconcilePayment(evidence, { invoice, request: { request_id: payment.request_id }, seenEventIds: new Set(payment.evidence || []) });
  const rec = buildReconciliation({ invoice, request: { request_id: payment.request_id }, evidence, adapterOutcome, opts: { at: nextStamp(opts), paymentId: payment.payment_id, example: opts.example === true } });
  if (!rec.ok) { process.stderr.write(`RECONCILIATION BUILD FAILED — ${rec.reasons.join('; ')}\n`); return 1; }
  const applied = applyReconciliation(payment, invoice, rec.reconciliation, { at: nextStamp(opts) });
  if (!applied.ok) {
    process.stderr.write(`RECONCILIATION REJECTED — ${applied.reasons.join('; ')}\n`);
    return 1;
  }
  const v = await validatePaymentRecord(applied.record, { requireExampleMarker: false });
  if (v.failures.length > 0) {
    process.stderr.write(`PAYMENT RECORD INVALID AFTER RECONCILIATION — ${v.failures.join('; ')}\n`);
    return 1;
  }
  const outDir = path.resolve(opts.output || OUT_DIR);
  const unsafe = assertSafePaymentOutput(outDir);
  if (!unsafe.ok) { process.stderr.write(unsafe.reason + '\n'); return 1; }
  const recPath = path.join(outDir, reconciliationFilename(invoice.invoice_id));
  writeJson(recPath, rec.reconciliation);
  const target = opts.out ? path.resolve(opts.out) : path.join(outDir, paymentFilename(applied.record.payment_id));
  const tUnsafe = assertSafePaymentOutput(target);
  if (!tUnsafe.ok) { process.stderr.write(tUnsafe.reason + '\n'); return 1; }
  try { refuseOverwrite(target, opts); } catch (e) { process.stderr.write(e.message + '\n'); return 1; }
  writeJson(target, applied.record);
  process.stdout.write(`Reconciliation: ${rec.reconciliation.outcome} for ${payment.payment_id}. Status -> ${applied.record.status}.\n`);
  if (applied.record.status === 'PAID') process.stdout.write(`PAID requires governed reconciled payment evidence — settled ${applied.record.amount_received} ${applied.record.currency}.\n`);
  process.stdout.write(`Record written: ${path.relative(root, target)}\n`);
  process.stdout.write(`Reconciliation written: ${path.relative(root, recPath)}\n`);
  return 0;
}

/* Adapter shim for non-test providers (no real API; reconciliation fails closed). */
class PaymentProviderAdapterShim {
  reconcilePayment(evidence, ctx) {
    return { ok: false, outcome: 'UNKNOWN_PROVIDER_REF', reasons: ['non-TEST provider adapter is not operational in PROP.9 (OWNER DECISION REQUIRED — PAYMENT PROVIDER)'], amount: evidence.amount, currency: evidence.currency };
  }
}

/* ------------------------------------------------------------------ */
/* refund-record                                                       */
/* ------------------------------------------------------------------ */
function runRefundRecord(opts) {
  const paymentPath = path.resolve(opts.positional[1]);
  const refundPath = opts.refund ? path.resolve(opts.refund) : null;
  if (!paymentPath || !refundPath) { usage(process.stderr); process.stderr.write('refund-record requires <payment.json> --refund <refund.json>\n'); return 2; }
  if (classifyPaymentInput(paymentPath) === 'UNSAFE') { process.stderr.write(`Refusing unsafe payment input: ${paymentPath}\n`); return 1; }
  if (classifyPaymentInput(refundPath) === 'UNSAFE') { process.stderr.write(`Refusing unsafe refund input: ${refundPath}\n`); return 1; }
  const payment = readJson(paymentPath);
  const refundDetail = readJson(refundPath);
  const rec = {
    schema: RECONCILIATION_SCHEMA,
    reconciliation_id: `REC-${payment.invoice_id}-refund-${refundDetail.refund_id || 'x'}`,
    invoice_id: payment.invoice_id,
    request_id: payment.request_id,
    payment_id: payment.payment_id,
    provider: payment.provider,
    environment: payment.environment,
    event_id: refundDetail.refund_id || 'refund',
    provider_ref: refundDetail.provider_ref || null,
    outcome: refundDetail.partial ? 'PARTIAL_REFUND' : 'REFUND',
    amount: refundDetail.amount,
    currency: payment.currency,
    reconciled_at: nextStamp(opts),
    refund_detail: refundDetail,
    audit_events: [],
    _example: opts.example === true ? true : undefined
  };
  if (rec._example === undefined) delete rec._example;
  const applied = applyReconciliation(payment, { invoice_id: payment.invoice_id, currency: payment.currency, status: 'ISSUED' }, rec, { at: nextStam(opts) });
  if (!applied.ok) {
    process.stderr.write(`REFUND RECORD REJECTED — ${applied.reasons.join('; ')}\n`);
    return 1;
  }
  const v = await validatePaymentRecord(applied.record, { requireExampleMarker: false });
  if (v.failures.length > 0) {
    process.stderr.write(`PAYMENT RECORD INVALID AFTER REFUND — ${v.failures.join('; ')}\n`);
    return 1;
  }
  const outDir = path.resolve(opts.output || OUT_DIR);
  const unsafe = assertSafePaymentOutput(outDir);
  if (!unsafe.ok) { process.stderr.write(unsafe.reason + '\n'); return 1; }
  const target = opts.out ? path.resolve(opts.out) : path.join(outDir, paymentFilename(applied.record.payment_id));
  const tUnsafe = assertSafePaymentOutput(target);
  if (!tUnsafe.ok) { process.stderr.write(tUnsafe.reason + '\n'); return 1; }
  try { refuseOverwrite(target, opts); } catch (e) { process.stderr.write(e.message + '\n'); return 1; }
  writeJson(target, applied.record);
  process.stdout.write(`Refund recorded: ${applied.record.payment_id} -> ${applied.record.status} (${rec.outcome}). Linked to original payment.\n`);
  process.stdout.write(`Record written: ${path.relative(root, target)}\n`);
  return 0;
}
function nextStam(opts) { return nextStamp(opts); }

/* ------------------------------------------------------------------ */
/* verify / status                                                     */
/* ------------------------------------------------------------------ */
async function runVerify(opts) {
  const p = path.resolve(opts.positional[1]);
  if (!p) { usage(process.stderr); process.stderr.write('verify requires <file.json>\n'); return 2; }
  if (classifyPaymentInput(p) === 'UNSAFE') { process.stderr.write(`Refusing unsafe payment input: ${p}\n`); return 1; }
  const rec = readJson(p);
  let failures = [];
  if (rec.schema === PAYMENT_SCHEMA) {
    const v = await validatePaymentRecord(rec, { requireExampleMarker: false });
    failures = v.failures;
    if (failures.length === 0) { process.stdout.write(`OK — payment ${rec.payment_id} (${rec.status}) ${rec.amount_received}/${rec.amount_expected} ${rec.currency} fingerprint valid.\n`); return 0; }
  } else if (rec.schema === PAYMENT_REQUEST_SCHEMA) {
    const v = await validatePaymentRequest(rec, { requireExampleMarker: false });
    failures = v.failures;
    if (failures.length === 0) { process.stdout.write(`OK — payment request ${rec.request_id} for ${rec.invoice_id} fingerprint valid.\n`); return 0; }
  } else if (rec.schema === WEBHOOK_EVENT_SCHEMA) {
    failures = validateWebhookEvent(rec, { requireExampleMarker: false }).failures;
    if (failures.length === 0) { process.stdout.write(`OK — webhook event ${rec.event_id} (${rec.provider}/${rec.environment}) fingerprint valid.\n`); return 0; }
  } else {
    process.stderr.write('Not a payment / request / webhook record (schema mismatch).\n');
    return 1;
  }
  process.stderr.write(`INVALID — ${failures.length} issue(s).\n`);
  for (const f of failures) process.stderr.write(`  FAIL ${f}\n`);
  return 1;
}

function runStatus(opts) {
  const p = path.resolve(opts.positional[1]);
  if (!p) { usage(process.stderr); process.stderr.write('status requires <payment.json>\n'); return 2; }
  if (classifyPaymentInput(p) === 'UNSAFE') { process.stderr.write(`Refusing unsafe payment input: ${p}\n`); return 1; }
  const rec = readJson(p);
  if (rec.schema !== PAYMENT_SCHEMA) { process.stderr.write('Not a payment record (schema mismatch).\n'); return 1; }
  process.stdout.write(`Payment ${rec.payment_id}\n`);
  process.stdout.write(`  invoice: ${rec.invoice_id} (${rec.invoice_number})\n`);
  process.stdout.write(`  status: ${rec.status}\n`);
  process.stdout.write(`  expected: ${rec.amount_expected} ${rec.currency} · received: ${rec.amount_received} · remaining: ${rec.amount_remaining}\n`);
  process.stdout.write(`  provider: ${rec.provider}/${rec.environment}\n`);
  process.stdout.write(`  evidence events: ${(rec.evidence || []).length}\n`);
  process.stdout.write(`  PAID requires governed reconciled payment evidence — this is a status inspection only.\n`);
  return 0;
}

/* ------------------------------------------------------------------ */
/* CLI                                                                 */
/* ------------------------------------------------------------------ */
function usage(out) {
  out.write(`Nexora Governed Payment Collection & Reconciliation (PROP.9) — TEST/SANDBOX-FIRST
Connects a governed ISSUED Invoice (PROP.8) to governed payment-request, provider-abstraction,
webhook, idempotency and reconciliation machinery. NO payment is collected, no provider is called,
no webhook is deployed, and PAID requires governed reconciled evidence.

Boundaries: PAYMENT REQUEST != PAID · CHECKOUT SESSION != PAID · WEBHOOK RECEIVED != PAID ·
INVOICE ISSUED != PAID · AGREEMENT EXECUTED != PAID · No mark-paid / --force-paid / --fake-paid ·
No network/payment calls · No live keys · No Production activation.

Commands:
  node ops/payment/payment.mjs request <invoice.json> --amount <n> --currency GBP [options]
  node ops/payment/payment.mjs pay <request.json> [options]
  node ops/payment/payment.mjs record-event <payment.json> --event <webhook.json> [options]
  node ops/payment/payment.mjs reconcile <payment.json> <invoice.json> --event <webhook.json> [options]
  node ops/payment/payment.mjs refund-record <payment.json> --refund <refund.json> [options]
  node ops/payment/payment.mjs verify <file.json>
  node ops/payment/payment.mjs status <payment.json>

request options:
  --amount <n>        must equal the invoice total (no override)
  --currency <code>   must equal the invoice currency
  --provider <id>     STRIPE | PAYPAL | BANK_TRANSFER | TEST_ADAPTER (default TEST_ADAPTER)
  --environment <e>   TEST | SANDBOX | PRODUCTION (default TEST)
  --generated-at <ISO> deterministic timestamp override (tests)
  --output <dir>      write into <dir> (default ops/payment/out)
  --example           mark the request "_example": true
  --overwrite         allow replacing a non-settled request

pay options:
  --generated-at <ISO> deterministic timestamp override (tests)
  --output <dir>      write into <dir> (default ops/payment/out)
  --example           mark the payment "_example": true
  --overwrite         allow replacing a non-settled payment

record-event options:
  --event <path>      normalised webhook/provider event JSON
  --generated-at <ISO> deterministic timestamp override (tests)
  --out <path>        explicit output path
  --overwrite         allow replacing a non-settled target

reconcile options:
  --event <path>      normalised webhook/provider event JSON
  --provider <id>     adapter id (default TEST_ADAPTER)
  --environment <e>   adapter environment (default TEST)
  --generated-at <ISO> deterministic timestamp override (tests)
  --out <path>        explicit output path
  --overwrite         allow replacing a non-settled target

refund-record options:
  --refund <path>     governed refund detail JSON (links to original payment)
  --generated-at <ISO> deterministic timestamp override (tests)
  --out <path>        explicit output path
  --overwrite         allow replacing a non-settled target

Input safety:
  Invoices      -> ops/billing/out|private|examples (else refused)
  Payment files -> ops/payment/out|private|examples (else refused)
  Committed examples must be marked "_example": true.`);
}

function parseArgs(args) {
  const opts = { positional: [] };
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === '--amount') opts.amount = args[++i];
    else if (a === '--currency') opts.currency = args[++i];
    else if (a === '--provider') opts.provider = args[++i];
    else if (a === '--environment') opts.environment = args[++i];
    else if (a === '--event') opts.event = args[++i];
    else if (a === '--refund') opts.refund = args[++i];
    else if (a === '--output') opts.output = args[++i];
    else if (a === '--out') opts.out = args[++i];
    else if (a === '--generated-at') opts.generatedAt = args[++i];
    else if (a === '--example') opts.example = true;
    else if (a === '--overwrite') opts.overwrite = true;
    else if (a === '--help' || a === '-h') opts.help = true;
    else if (a.startsWith('-')) { opts.bad = a; }
    else opts.positional.push(a);
  }
  return opts;
}

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  const cmd = opts.positional[0];
  if (opts.bad) { usage(process.stderr); process.stderr.write(`Unknown option: ${opts.bad}\n`); return 2; }
  if (opts.help) { usage(process.stdout); return 0; }
  switch (cmd) {
    case 'request': return runRequest(opts);
    case 'pay': return runPay(opts);
    case 'record-event': return runRecordEvent(opts);
    case 'reconcile': return runReconcile(opts);
    case 'refund-record': return runRefundRecord(opts);
    case 'verify': return runVerify(opts);
    case 'status': return runStatus(opts);
    default:
      usage(process.stderr);
      return cmd ? 2 : 0;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().then((code) => process.exit(code || 0)).catch((e) => {
    process.stderr.write('CRASH: ' + (e && e.stack || e) + '\n');
    process.exit(1);
  });
}
