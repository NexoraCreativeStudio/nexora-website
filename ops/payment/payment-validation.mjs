/* Nexora Governed Payment Collection & Reconciliation (PROP.9) — shared core.
   Consumes a governed ISSUED Invoice (PROP.8) and provides a governed payment
   layer that can safely connect that invoice to real payment-provider evidence
   in the future.

   THIS IS A TEST/SANDBOX-FIRST GOVERNED PAYMENT LAYER. It does NOT:
     - collect payment, call Stripe/PayPal/SumUp, or make any network call;
     - activate Production payment collection;
     - deploy payment endpoints or webhooks;
     - insert live payment links into the website;
     - use live API keys or make live charges;
     - mark an invoice PAID without reconciled payment evidence;
     - change public pricing, the Commercial Source of Truth, or any
       Proposal/Agreement/Execution/Invoice status outside the payment layer.

   The system NEVER equates a payment request, checkout session, redirect,
   webhook receipt, or provider status with confirmed payment unless governed
   evidence passes reconciliation.

   Key boundaries (explicit):
     - PAYMENT REQUEST != PAID. CHECKOUT SESSION != PAID.
       WEBHOOK RECEIVED != PAID. INVOICE ISSUED != PAID.
       AGREEMENT EXECUTED != PAID.
     - PAID requires governed reconciled payment evidence.
     - A fingerprint is an integrity aid, NOT a bank confirmation, digital
       signature, or proof of payment.
     - Fake Production evidence from the TEST adapter is rejected.
     - No secrets, no live credentials, no provider account IDs.

   Node built-ins only. No printing, no process.exit — CLI tools decide. */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import {
  scanLegacy,
  scanVatAssertions,
  scanSecrets,
  scanBankDetails,
  scanPaymentLink,
  scanFinancialClaims,
  scanPathLeakage,
  collectStrings
} from '../billing/billing-validation.mjs';
import {
  INVOICE_SCHEMA,
  INVOICE_ID_RE,
  INVOICE_NUMBER_RE,
  loadSourceOfTruth,
  CURRENCY,
  verifyInvoiceFingerprint
} from '../billing/billing-validation.mjs';

/* Re-export Worker-safe core symbols for Node/ops/test compatibility */
import {
  PAYMENT_SCHEMA,
  PAYMENT_REQUEST_SCHEMA,
  WEBHOOK_EVENT_SCHEMA,
  RECONCILIATION_SCHEMA,
  PAYMENT_STATUSES,
  PAYMENT_ENVIRONMENTS,
  PROVIDER_IDS,
  PROVIDER_TEST,
  RECONCILIATION_OUTCOMES,
  validatePaymentRequest,
  buildPaymentRecord,
  buildWebhookFingerprint,
  verifyWebhookFingerprint,
  sha256hex,
  applyPaymentEvent,
  applyReconciliation,
  TestPaymentAdapter,
  PaymentProviderAdapter,
  sortKeys,
  canonicalSerialise,
  buildPaymentFingerprint,
  verifyPaymentFingerprint,
  buildRequestFingerprint,
  verifyRequestFingerprint,
  paymentIdFor,
  allowedPaymentTransition,
  round2,
  buildReconciliation,
  validatePaymentRecord,
  validateWebhookEvent,
} from './payment-validation-core.mjs';

export {
  PAYMENT_SCHEMA,
  PAYMENT_REQUEST_SCHEMA,
  WEBHOOK_EVENT_SCHEMA,
  RECONCILIATION_SCHEMA,
  PAYMENT_STATUSES,
  PAYMENT_ENVIRONMENTS,
  PROVIDER_IDS,
  PROVIDER_TEST,
  RECONCILIATION_OUTCOMES,
  validatePaymentRequest,
  buildPaymentRecord,
  buildWebhookFingerprint,
  verifyWebhookFingerprint,
  sha256hex,
  applyPaymentEvent,
  applyReconciliation,
  TestPaymentAdapter,
  PaymentProviderAdapter,
  sortKeys,
  canonicalSerialise,
  buildPaymentFingerprint,
  verifyPaymentFingerprint,
  buildRequestFingerprint,
  verifyRequestFingerprint,
  paymentIdFor,
  allowedPaymentTransition,
  round2,
  buildReconciliation,
  validatePaymentRecord,
  validateWebhookEvent,
  scanSecrets,
  scanBankDetails,
  scanPaymentLink,
  scanLegacy,
  scanVatAssertions,
  scanFinancialClaims,
  collectStrings
};

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const paymentDir = __dirname;
const root = path.join(__dirname, '..', '..');

export const OUT_DIR = path.join(paymentDir, 'out');
export const PRIVATE_DIR = path.join(paymentDir, 'private');
export const EXAMPLES_DIR = path.join(paymentDir, 'examples');

/* ------------------------------------------------------------------ */
/* Source of truth (consumed, never modified)                         */
/* ------------------------------------------------------------------ */
export const SOT = loadSourceOfTruth();
export const SOURCE_CURRENCY = SOT.currency; /* GBP */

/* ------------------------------------------------------------------ */
/* Invoice input gate — ISSUED only, with valid fingerprint           */
/* ------------------------------------------------------------------ */
export function validateInvoiceForPayment(invoice) {
  const reasons = [];
  if (!invoice || typeof invoice !== 'object') { reasons.push('invoice must be an object'); return { ok: false, reasons }; }
  if (invoice.schema !== INVOICE_SCHEMA) reasons.push(`invoice schema must be ${INVOICE_SCHEMA}`);
  if (typeof invoice.invoice_id !== 'string' || !INVOICE_ID_RE.test(invoice.invoice_id)) reasons.push(`invoice_id must match ${INVOICE_ID_RE}`);
  if (invoice.status !== 'ISSUED') {
    if (invoice.status === 'VOID' || invoice.status === 'CANCELLED') {
      reasons.push(`invoice ${invoice.invoice_id} is ${invoice.status} — payment may not be collected against a ${invoice.status} invoice`);
    } else {
      reasons.push(`invoice must be ISSUED to be paid — got ${JSON.stringify(invoice.status || '(missing)')} (DRAFT/READY_TO_ISSUE cannot be paid)`);
    }
  }
  if (invoice.currency !== SOURCE_CURRENCY) reasons.push(`invoice currency must be ${SOURCE_CURRENCY}`);
  const fp = verifyInvoiceFingerprint(invoice);
  if (!fp.ok) reasons.push(...fp.reasons);
  return { ok: reasons.length === 0, reasons };
}

/* ------------------------------------------------------------------ */
/* Payment Request model                                              */
/* ------------------------------------------------------------------ */
export function buildPaymentRequest(invoice, opts = {}) {
  const reasons = [];
  const inv = validateInvoiceForPayment(invoice);
  if (!inv.ok) return { ok: false, reasons: inv.reasons };

  const amountExpected = invoice.total;
  const requestedAmount = opts.amount != null ? opts.amount : amountExpected;
  if (typeof requestedAmount !== 'number' || !Number.isFinite(requestedAmount) || requestedAmount <= 0) {
    reasons.push('payment request amount must be a positive number');
    return { ok: false, reasons };
  }
  if (requestedAmount !== amountExpected) {
    reasons.push(`payment request amount ${requestedAmount} conflicts with the governed invoice amount ${amountExpected} — a request may not invent or override the invoice amount`);
    return { ok: false, reasons };
  }
  if (invoice.currency !== opts.currency) {
    reasons.push(`payment request currency ${opts.currency} conflicts with invoice currency ${invoice.currency}`);
    return { ok: false, reasons };
  }

  const createdAt = opts.createdAt || '1970-01-01T00:00:00.000Z';
  const ordinal = opts.ordinal != null ? opts.ordinal : 1;
  const requestId = paymentRequestIdFor(invoice.invoice_id, ordinal);
  if (!requestId) return { ok: false, reasons: ['cannot derive request_id from invoice lineage'] };

  const env = opts.environment || 'TEST';
  if (!PAYMENT_ENVIRONMENTS.includes(env)) return { ok: false, reasons: [`environment must be one of ${PAYMENT_ENVIRONMENTS.join(', ')}`] };
  const provider = opts.provider || PROVIDER_TEST;
  if (!PROVIDER_IDS.includes(provider)) return { ok: false, reasons: [`provider must be one of ${PROVIDER_IDS.join(', ')}`] };

  const purpose = invoice.invoice_type || 'UNKNOWN';

  const record = {
    schema: PAYMENT_REQUEST_SCHEMA,
    request_id: requestId,
    invoice_id: invoice.invoice_id,
    invoice_version: invoice.invoice_version,
    invoice_number: invoice.invoice_number,
    invoice_fingerprint: invoice.invoice_fingerprint,
    currency: invoice.currency,
    amount_expected: amountExpected,
    amount_requested: requestedAmount,
    payment_purpose: purpose,
    milestone: invoice.milestone ? { index: invoice.milestone.index, total_milestones: invoice.milestone.total_milestones } : null,
    recurring: invoice.recurring ? { service: invoice.recurring.service || null, cadence: invoice.recurring.cadence || null } : null,
    care: invoice.care ? { code: invoice.care.code, plan: invoice.care.plan || null } : null,
    provider: provider,
    environment: env,
    source: invoice.source,
    created_at: createdAt,
    status: 'CREATED',
    audit_events: [
      { event: 'request_created', at: createdAt, event_id: sha256hex(`nexora-payment-request:${requestId}:${createdAt}`).slice(0, 16), detail: `Payment request created for invoice ${invoice.invoice_id}. PAYMENT REQUEST != PAID.` }
    ],
    _example: opts.example === true ? true : undefined
  };
  if (record._example === undefined) delete record._example;
  record.request_fingerprint = buildRequestFingerprint(record);
  return { ok: true, request: record };
}

export function paymentRequestIdFor(invoiceId, ordinal) {
  if (!INVOICE_ID_RE.test(invoiceId)) return null;
  const m = invoiceId.match(/^INV-(\d{4})-(\d{4})-(\d{3})$/);
  if (!m) return null;
  return `REQ-${m[1]}-${m[2]}-${String(ordinal).padStart(3, '0')}`;
}

/* ------------------------------------------------------------------ */
/* Input classification (PROP.9 output areas)                         */
/* ------------------------------------------------------------------ */
export function classifyPaymentInput(filePath) {
  const p = path.resolve(filePath);
  const rel = path.relative(root, p);
  if (rel.startsWith('ops' + path.sep + 'payment' + path.sep + 'out' + path.sep)) return 'OUT';
  if (rel.startsWith('ops' + path.sep + 'payment' + path.sep + 'private' + path.sep)) return 'PRIVATE';
  if (rel.startsWith('ops' + path.sep + 'payment' + path.sep + 'examples' + path.sep)) return 'EXAMPLES';
  return 'UNSAFE';
}
export function assertSafePaymentOutput(dir) {
  const resolved = path.resolve(dir);
  const rel = path.relative(root, resolved);
  if (rel.startsWith('..') || path.isAbsolute(rel)) return { ok: false, reason: `Unsafe output directory: ${dir} — output must stay within the repository root.` };
  return { ok: true };
}
export function defaultPaymentOutputDir() { return OUT_DIR; }

export function paymentFilename(paymentId) {
  const clean = String(paymentId).replace(/[^A-Za-z0-9._-]/g, '-');
  return `${clean}.payment.json`;
}
export function requestFilename(requestId) {
  const clean = String(requestId).replace(/[^A-Za-z0-9._-]/g, '-');
  return `${clean}.payment-request.json`;
}
export function webhookFilename(eventId) {
  const clean = String(eventId).replace(/[^A-Za-z0-9._-]/g, '-');
  return `${clean}.webhook-event.json`;
}
export function reconciliationFilename(invoiceId) {
  const clean = String(invoiceId).replace(/[^A-Za-z0-9._-]/g, '-');
  return `${clean}.reconciliation.json`;
}

/* ------------------------------------------------------------------ */
/* Deterministic helpers (no Date.now — pure arithmetic)              */
/* ------------------------------------------------------------------ */
export function addDaysIso(isoDate, days) {
  if (typeof isoDate !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(isoDate)) return null;
  const [y, m, d] = isoDate.split('-').map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d + days));
  return dt.toISOString().slice(0, 10);
}