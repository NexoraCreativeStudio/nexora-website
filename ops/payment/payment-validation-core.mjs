/* Nexora Governed Payment Collection & Reconciliation — Worker-Safe Core (PROP.17 HOTFIX12)
   Subset of payment-validation.mjs containing only Worker-runtime-required symbols.
   No filesystem access, no Node-only module-scope side effects.
   Imports governed currency + invoice id regex from ./currency-bridge.mjs (build-time JSON import).
   Imports pure scanners / sha256hex from ../shared/scanners.mjs. */

import { SOURCE_CURRENCY, INVOICE_ID_RE } from './currency-bridge.mjs';
import { sha256hex, scanSecrets, scanBankDetails, scanPaymentLink, scanLegacy, scanVatAssertions, scanFinancialClaims, collectStrings } from '../shared/scanners.mjs';

/* Re-export Worker-safe scanners for Worker runtime consumers (e.g., stripe-adapter.mjs, payment-validation.mjs) */
export { sha256hex, scanSecrets, scanBankDetails, scanPaymentLink, scanLegacy, scanVatAssertions, scanFinancialClaims, collectStrings } from '../shared/scanners.mjs';

/* ------------------------------------------------------------------ */
/* Payment layer schemas (constants)                                  */
/* ------------------------------------------------------------------ */
export const PAYMENT_SCHEMA = 'nexora-payment/v1';
export const PAYMENT_REQUEST_SCHEMA = 'nexora-payment-request/v1';
export const WEBHOOK_EVENT_SCHEMA = 'nexora-payment-webhook/v1';
export const RECONCILIATION_SCHEMA = 'nexora-reconciliation/v1';

/* ------------------------------------------------------------------ */
/* Payment lifecycle states. Forward-controlled, evidence-driven.     */
/* PAID requires reconciled evidence; it is never reachable without it. */
/* ------------------------------------------------------------------ */
export const PAYMENT_STATUSES = [
  'CREATED', 'PENDING', 'PROCESSING', 'PARTIALLY_PAID', 'PAID',
  'FAILED', 'CANCELLED', 'REFUNDED', 'PARTIALLY_REFUNDED', 'DISPUTED'
];

/* ------------------------------------------------------------------ */
/* Provider environments. TEST/SANDBOX evidence must never be accepted */
/* as Production evidence.                                            */
/* ------------------------------------------------------------------ */
export const PAYMENT_ENVIRONMENTS = ['TEST', 'SANDBOX', 'PRODUCTION'];

/* ------------------------------------------------------------------ */
/* Governed provider identities. None are operationally configured.   */
/* ------------------------------------------------------------------ */
export const PROVIDER_IDS = ['STRIPE', 'PAYPAL', 'BANK_TRANSFER', 'TEST_ADAPTER'];
export const PROVIDER_TEST = 'TEST_ADAPTER';

/* ------------------------------------------------------------------ */
/* Reconciliation outcome categories.                                 */
/* ------------------------------------------------------------------ */
export const RECONCILIATION_OUTCOMES = [
  'EXACT', 'PARTIAL', 'OVERPAYMENT', 'DUPLICATE_EVIDENCE',
  'WRONG_CURRENCY', 'WRONG_INVOICE', 'WRONG_AMOUNT',
  'UNKNOWN_PROVIDER_REF', 'VOID_INVOICE', 'REFUND',
  'PARTIAL_REFUND', 'DISPUTE', 'PENDING', 'UNVERIFIED'
];

/* ------------------------------------------------------------------ */
/* Internal fingerprint exclusion sets                                */
/* ------------------------------------------------------------------ */
const PAYMENT_FP_EXCLUDED = new Set(['payment_fingerprint', 'status', 'audit_events', 'updated_at', '_example']);
const REQUEST_FP_EXCLUDED = new Set(['request_fingerprint', 'status', 'audit_events', 'updated_at', '_example']);
const WEBHOOK_FP_EXCLUDED = new Set(['webhook_fingerprint', 'audit_events', 'updated_at', '_example']);

/* ------------------------------------------------------------------ */
/* Canonical serialisation + fingerprints (deterministic SHA-256)      */
/* ------------------------------------------------------------------ */
export function sortKeys(value) {
  if (Array.isArray(value)) return value.map(sortKeys);
  if (value && typeof value === 'object') {
    const out = {};
    for (const k of Object.keys(value).sort()) out[k] = sortKeys(value[k]);
    return out;
  }
  return value;
}
export function canonicalSerialise(value) {
  return JSON.stringify(sortKeys(value));
}

function canonicalExcluding(obj, excluded) {
  const clone = (function pick(value) {
    if (Array.isArray(value)) return value.map(pick);
    if (value && typeof value === 'object') {
      const out = {};
      for (const k of Object.keys(value)) if (!excluded.has(k)) out[k] = pick(value[k]);
      return out;
    }
    return value;
  })(obj);
  return canonicalSerialise(clone);
}

export function buildPaymentFingerprint(record) {
  return sha256hex('nexora-payment:' + canonicalExcluding(record, PAYMENT_FP_EXCLUDED));
}
export function verifyPaymentFingerprint(record) {
  const stored = record && record.payment_fingerprint;
  if (typeof stored !== 'string' || stored.length !== 64) return { ok: false, reasons: ['payment_fingerprint missing or malformed'] };
  if (stored !== buildPaymentFingerprint(record)) return { ok: false, reasons: ['payment fingerprint mismatch — payment record has been changed'] };
  return { ok: true, reasons: [] };
}

export function buildRequestFingerprint(req) {
  return sha256hex('nexora-payment-request:' + canonicalExcluding(req, REQUEST_FP_EXCLUDED));
}
export function verifyRequestFingerprint(req) {
  const stored = req && req.request_fingerprint;
  if (typeof stored !== 'string' || stored.length !== 64) return { ok: false, reasons: ['request_fingerprint missing or malformed'] };
  if (stored !== buildRequestFingerprint(req)) return { ok: false, reasons: ['payment request fingerprint mismatch — request has been changed'] };
  return { ok: true, reasons: [] };
}

export function buildWebhookFingerprint(ev) {
  return sha256hex('nexora-payment-webhook:' + canonicalExcluding(ev, WEBHOOK_FP_EXCLUDED));
}
export function verifyWebhookFingerprint(ev) {
  const stored = ev && ev.webhook_fingerprint;
  if (typeof stored !== 'string' || stored.length !== 64) return { ok: false, reasons: ['webhook_fingerprint missing or malformed'] };
  if (stored !== buildWebhookFingerprint(ev)) return { ok: false, reasons: ['webhook fingerprint mismatch — event has been changed'] };
  return { ok: true, reasons: [] };
}

/* ------------------------------------------------------------------ */
/* Identity derivation                                                */
/* ------------------------------------------------------------------ */
export function paymentIdFor(invoiceId, ordinal) {
  if (!INVOICE_ID_RE.test(invoiceId)) return null;
  const m = invoiceId.match(/^INV-(\d{4})-(\d{4})-(\d{3})$/);
  if (!m) return null;
  return `PAY-${m[1]}-${m[2]}-${String(ordinal).padStart(3, '0')}`;
}

/* ------------------------------------------------------------------ */
/* Payment Request validation (Worker runtime subset)                 */
/* ------------------------------------------------------------------ */
export function validatePaymentRequest(req, opts = {}) {
  const reasons = [];
  if (!req || typeof req !== 'object') return { failures: ['payment request must be an object'], checks: [] };
  if (opts.requireExampleMarker !== false && req._example !== true) reasons.push('_example: fixture must be marked "_example": true — real payment requests belong in ops/payment/private/ (gitignored), never committed');
  if (req.schema !== PAYMENT_REQUEST_SCHEMA) reasons.push(`schema must be ${PAYMENT_REQUEST_SCHEMA}`);
  if (typeof req.request_id !== 'string' || !/^REQ-\d{4}-\d{4}-\d{3}$/.test(req.request_id)) reasons.push('request_id must match /^REQ-YYYY-NNNN-NNN$/');
  if (typeof req.invoice_id !== 'string' || !INVOICE_ID_RE.test(req.invoice_id)) reasons.push('invoice_id required (INV-YYYY-NNNN-NNN)');
  if (req.currency !== SOURCE_CURRENCY) reasons.push(`currency must be ${SOURCE_CURRENCY}`);
  if (typeof req.amount_expected !== 'number' || req.amount_expected <= 0) reasons.push('amount_expected must be a positive number');
  if (req.amount_requested !== req.amount_expected) reasons.push('amount_requested must equal amount_expected (a request may not override the invoice)');
  if (!PAYMENT_ENVIRONMENTS.includes(req.environment)) reasons.push('environment must be a governed value');
  if (!PROVIDER_IDS.includes(req.provider)) reasons.push('provider must be a governed value');
  if (!PAYMENT_STATUSES.includes(req.status) && req.status !== 'CREATED') reasons.push('status must be a governed payment status');
  if (!req.request_fingerprint || !/^[0-9a-f]{64}$/.test(req.request_fingerprint)) reasons.push('request_fingerprint (64-hex) required');
  else if (!verifyRequestFingerprint(req).ok) reasons.push('request_fingerprint mismatch — request has been changed');
  const allText = collectStrings(req).join('\n');
  for (const v of scanSecrets(allText)) reasons.push(`secret-like: ${v}`);
  for (const v of scanBankDetails(allText)) reasons.push(`bank detail: ${v}`);
  for (const v of scanPaymentLink(allText)) reasons.push(`payment-link: ${v}`);
  for (const v of scanFinancialClaims(allText)) reasons.push(`financial claim: ${v}`);
  for (const v of scanLegacy(allText)) reasons.push(`legacy: ${v}`);
  for (const v of scanVatAssertions(allText)) reasons.push(`VAT assertion: ${v}`);
  return { failures: reasons, checks: [] };
}

/* ------------------------------------------------------------------ */
/* Provider abstraction (TEST/SANDBOX adapter built-in)               */
/* ------------------------------------------------------------------ */
export const PAYMENT_ADAPTER_NOTE = 'OWNER DECISION REQUIRED — PAYMENT PROVIDER (Stripe/PayPal account ownership, Production credentials, webhook endpoint, signature config, refund/dispute policy, tax treatment).';

/* A payment provider adapter must be provider-neutral and must NOT own
   pricing logic. It exposes normalisation + verification + reconciliation
   against governed invoice evidence. */
export class PaymentProviderAdapter {
  constructor({ id, environment }) {
    this.id = id;
    this.environment = environment;
  }

  /* Returns a provider-scoped event id for idempotency. */
  deriveEventId(providerRef) {
    return sha256hex(`nexora-evt:${this.id}:${providerRef}`).slice(0, 24);
  }

  /* Validates that a webhook/event comes from this provider + environment.
     TEST/SANDBOX adapters must never emit Production-labelled evidence. */
  validateProviderEvent(providerEvent) {
    const reasons = [];
    if (!providerEvent || typeof providerEvent !== 'object') return { ok: false, reasons: ['provider event must be an object'] };
    if (providerEvent.provider !== this.id) reasons.push(`provider mismatch: event provider ${providerEvent.provider} != adapter ${this.id}`);
    if (providerEvent.environment !== this.environment) reasons.push(`environment mismatch: event environment ${providerEvent.environment} != adapter ${this.environment}`);
    if (this.environment === 'PRODUCTION' && providerEvent._test_only === true) {
      reasons.push('TEST/SANDBOX evidence (marked _test_only) is NOT accepted as Production evidence');
    }
    if (!providerEvent.provider_ref) reasons.push('provider_ref required');
    if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/.test(providerEvent.event_time || '')) reasons.push('event_time ISO datetime required');
    if (!providerEvent.event_type) reasons.push('event_type required');
    return { ok: reasons.length === 0, reasons };
  }

  /* Normalises a provider event into a governed internal webhook record. */
  normalizePaymentEvidence(providerEvent, opts = {}) {
    const v = this.validateProviderEvent(providerEvent);
    if (!v.ok) return { ok: false, reasons: v.reasons };
    const eventId = opts.eventId || this.deriveEventId(providerEvent.provider_ref);
    const now = opts.recordedAt || (providerEvent.event_time || '1970-01-01T00:00:00.000Z');
    const record = {
      schema: WEBHOOK_EVENT_SCHEMA,
      event_id: eventId,
      provider: providerEvent.provider,
      environment: providerEvent.environment,
      provider_ref: providerEvent.provider_ref,
      event_type: providerEvent.event_type,
      event_time: providerEvent.event_time,
      recorded_at: now,
      invoice_id: providerEvent.invoice_id || null,
      payment_request_id: providerEvent.payment_request_id || null,
      amount: providerEvent.amount,
      currency: providerEvent.currency,
      signature_verified: providerEvent.signature_verified === true,
      normalized_evidence: {
        provider_ref: providerEvent.provider_ref,
        status: providerEvent.status || providerEvent.event_type,
        amount: providerEvent.amount,
        currency: providerEvent.currency
      },
      idempotency_key: eventId,
      _test_only: providerEvent.environment !== 'PRODUCTION' ? (providerEvent._test_only !== false) : false,
      audit_events: [
        { event: 'webhook_received', at: now, event_id: sha256hex(`nexora-payment-webhook:${eventId}:${now}`).slice(0, 16), detail: `Provider event normalised from ${providerEvent.provider} (${providerEvent.environment}). WEBHOOK RECEIVED != PAID.` }
      ],
      _example: opts.example === true ? true : undefined
    };
    if (record._example === undefined) delete record._example;
    record.webhook_fingerprint = buildWebhookFingerprint(record);
    return { ok: true, event: record };
  }

  /* Reconcile normalised evidence against the governed invoice + request.
     Returns a governed reconciliation outcome. Never marks PAID itself. */
  reconcilePayment(evidence, { invoice, request, seenEventIds = new Set() }) {
    const reasons = [];
    if (evidence.environment !== this.environment) reasons.push(`evidence environment ${evidence.environment} != adapter ${this.environment}`);
    if (evidence.signature_verified !== true) reasons.push('signature_verified must be true for reconciliation (unverified event fails closed)');
    if (!invoice || invoice.invoice_id !== evidence.invoice_id) reasons.push(`evidence invoice_id ${evidence.invoice_id} does not match the governed invoice ${invoice && invoice.invoice_id}`);
    if (seenEventIds.has(evidence.event_id)) return { ok: false, outcome: 'DUPLICATE_EVIDENCE', reasons: ['duplicate provider event ignored (idempotency)'] };

    const invAmount = invoice.total;
    const evAmount = evidence.amount;
    const invCurrency = invoice.currency;
    const evCurrency = evidence.currency;

    if (evCurrency !== invCurrency) return { ok: false, outcome: 'WRONG_CURRENCY', reasons: [`evidence currency ${evCurrency} != invoice currency ${invCurrency}`] };
    if (Math.abs(evAmount - invAmount) < 1e-6) {
      return { ok: true, outcome: 'EXACT', amount: evAmount, currency: evCurrency, reasons: [] };
    }
    if (evAmount > invAmount) {
      return { ok: false, outcome: 'OVERPAYMENT', reasons: [`overpayment ${evAmount} vs invoice ${invAmount} — not silently classified as PAID; surfaced for review`], amount: evAmount, currency: evCurrency };
    }
    return { ok: false, outcome: 'WRONG_AMOUNT', reasons: [`evidence amount ${evAmount} != invoice amount ${invAmount}`], amount: evAmount, currency: evCurrency };
  }
}

/* Built-in TEST/SANDBOX adapter — deterministic, no network, no secrets. */
export class TestPaymentAdapter extends PaymentProviderAdapter {
  constructor() {
    super({ id: PROVIDER_TEST, environment: 'TEST' });
  }

  /* Synthetic checkout/request lifecycle — labelled TEST ONLY. */
  createCheckoutIntent({ request, amount, currency }) {
    const intentId = sha256hex(`nexora-test-intent:${request.request_id}:${amount}:${currency}`).slice(0, 20);
    return {
      provider: this.id,
      environment: this.environment,
      intent_id: `test_intent_${intentId}`,
      request_id: request.request_id,
      invoice_id: request.invoice_id,
      amount,
      currency,
      _test_only: true,
      status: 'CREATED',
      note: 'TEST ONLY — NOT REAL PAYMENT — NOT FOR PRODUCTION'
    };
  }

  /* Synthetic provider evidence — explicitly labelled, never Production. */
  makeTestEvidence({ request, invoice, amount, eventType = 'payment_succeeded', eventTime }) {
    return {
      provider: this.id,
      environment: this.environment,
      provider_ref: `test_ref_${sha256hex(`nexora-test-evt:${request.request_id}:${amount}`).slice(0, 16)}`,
      event_type: eventType,
      event_time: eventTime || '2026-09-01T12:00:00.000Z',
      invoice_id: invoice.invoice_id,
      payment_request_id: request.request_id,
      amount,
      currency: invoice.currency,
      status: 'succeeded',
      signature_verified: true,
      _test_only: true
    };
  }
}

/* ------------------------------------------------------------------ */
/* Payment record model                                              */
/* ------------------------------------------------------------------ */
export function buildPaymentRecord(request, opts = {}) {
  const reasons = [];
  const req = validatePaymentRequest(request, { requireExampleMarker: opts.example === true });
  if (req.failures.length) return { ok: false, reasons: req.failures };

  const createdAt = opts.createdAt || request.created_at || '1970-01-01T00:00:00.000Z';
  const ordinal = opts.ordinal != null ? opts.ordinal : 1;
  const paymentId = paymentIdFor(request.invoice_id, ordinal);
  if (!paymentId) return { ok: false, reasons: ['cannot derive payment_id from invoice lineage'] };

  const record = {
    schema: PAYMENT_SCHEMA,
    payment_id: paymentId,
    request_id: request.request_id,
    invoice_id: request.invoice_id,
    invoice_version: request.invoice_version,
    invoice_number: request.invoice_number,
    invoice_fingerprint: request.invoice_fingerprint,
    currency: request.currency,
    amount_expected: request.amount_expected,
    amount_received: 0,
    amount_remaining: request.amount_expected,
    payment_purpose: request.payment_purpose,
    milestone: request.milestone,
    recurring: request.recurring,
    care: request.care,
    provider: request.provider,
    environment: request.environment,
    source: request.source,
    status: 'CREATED',
    evidence: [],
    refunds: [],
    disputes: [],
    created_at: createdAt,
    audit_events: [
      { event: 'payment_created', at: createdAt, event_id: sha256hex(`nexora-payment:${paymentId}:${createdAt}`).slice(0, 16), detail: `Payment record created from request ${request.request_id}. PAYMENT REQUEST != PAID.` }
    ],
    _example: opts.example === true ? true : undefined
  };
  if (record._example === undefined) delete record._example;
  record.payment_fingerprint = buildPaymentFingerprint(record);
  return { ok: true, payment: record };
}

/* ------------------------------------------------------------------ */
/* Payment state transitions (evidence-driven, forward-controlled)    */
/* ------------------------------------------------------------------ */
export function allowedPaymentTransition(from, eventType) {
  if (eventType === 'RECORD_EVENT') {
    if (['CREATED', 'PENDING', 'PROCESSING', 'PARTIALLY_PAID', 'PAID', 'FAILED', 'CANCELLED', 'REFUNDED', 'PARTIALLY_REFUNDED', 'DISPUTED'].includes(from)) return true;
    return false;
  }
  if (eventType === 'CANCEL') return ['CREATED', 'PENDING', 'PROCESSING'].includes(from);
  if (eventType === 'MARK_PAID') return false; /* PAID only via reconciliation */
  if (eventType === 'FORCE_PAID') return false;
  if (eventType === 'ASSUME_PAID') return false;
  if (eventType === 'FAKE_PAID') return false;
  return false;
}

/* Core transition applier — returns a NEW record, never mutates. */
export function applyPaymentEvent(record, event) {
  const reasons = [];
  const from = record.status;
  const type = event.event_type;
  if (!allowedPaymentTransition(from, type)) {
    reasons.push(`payment transition ${from} -> ${type} not allowed`);
    if (['MARK_PAID', 'FORCE_PAID', 'ASSUME_PAID', 'FAKE_PAID'].includes(type)) reasons.push('PAID requires governed reconciled payment evidence — PROP.9 never fakes PAID');
    return { ok: false, reasons };
  }
  const next = JSON.parse(JSON.stringify(record));
  next.audit_events = [...(record.audit_events || [])];
  next.updated_at = event.at || record.created_at;
  if (type === 'RECORD_EVENT') {
    next.evidence = [...(next.evidence || []), event.evidence_ref];
    const prev = from;
    next.status = nextEventStatus(next, prev);
    next.audit_events.push({ event: 'evidence_recorded', at: event.at || record.created_at, event_id: sha256hex(`nexora-payment:${record.payment_id}:evt:${event.at}`).slice(0, 16), detail: `Provider evidence recorded (${event.evidence_ref}). Reconciliation required before PAID.` });
  } else if (type === 'CANCEL') {
    next.status = 'CANCELLED';
    next.audit_events.push({ event: 'payment_cancelled', at: event.at || record.created_at, event_id: sha256hex(`nexora-payment:${record.payment_id}:cancel:${event.at}`).slice(0, 16), detail: 'Payment request cancelled.' });
  }
  next.payment_fingerprint = buildPaymentFingerprint(next);
  return { ok: true, record: next };
}

/* Derive next status from accumulated evidence — never PAID without
   an explicit reconciled settlement event. */
function nextEventStatus(record, prev) {
  if (prev === 'CANCELLED' || prev === 'REFUNDED' || prev === 'PARTIALLY_REFUNDED' || prev === 'DISPUTED') return prev;
  if (record.evidence && record.evidence.length > 0 && prev !== 'PAID') return 'PROCESSING';
  return prev === 'CREATED' ? 'PENDING' : prev;
}

/* ------------------------------------------------------------------ */
/* Reconciliation application                                         */
/* ------------------------------------------------------------------ */
export function applyReconciliation(payment, invoice, reconciliation, opts = {}) {
  const reasons = [];
  const rec = reconciliation;
  if (!rec || rec.schema !== RECONCILIATION_SCHEMA) return { ok: false, reasons: ['reconciliation must carry schema ' + RECONCILIATION_SCHEMA] };
  if (rec.outcome === 'UNVERIFIED' || rec.outcome === 'PENDING') {
    return { ok: false, reasons: [`reconciliation outcome ${rec.outcome} does not satisfy settlement`] };
  }
  if (rec.outcome === 'DUPLICATE_EVIDENCE' || rec.outcome === 'WRONG_CURRENCY' || rec.outcome === 'WRONG_INVOICE' || rec.outcome === 'WRONG_AMOUNT' || rec.outcome === 'UNKNOWN_PROVIDER_REF') {
    return { ok: false, reasons: [`reconciliation outcome ${rec.outcome} — mismatch not settled`] };
  }
  if (rec.outcome === 'VOID_INVOICE') {
    return { ok: false, reasons: ['cannot settle against a VOID invoice'] };
  }

  const next = JSON.parse(JSON.stringify(payment));
  next.audit_events = [...(payment.audit_events || [])];
  const at = opts.at || (rec.reconciled_at || payment.created_at);

  if (rec.outcome === 'EXACT') {
    next.amount_received = rec.amount;
    next.amount_remaining = round2(next.amount_expected - next.amount_received);
    next.status = 'PAID';
    next.settled_at = at;
    next.audit_events.push({ event: 'reconciled_exact', at, event_id: sha256hex(`nexora-payment:${payment.payment_id}:rec:${at}`).slice(0, 16), detail: `Reconciled EXACT ${rec.amount} ${rec.currency}. PAID requires governed reconciled payment evidence.` });
  } else if (rec.outcome === 'PARTIAL') {
    next.amount_received = round2((next.amount_received || 0) + rec.amount);
    next.amount_remaining = round2(next.amount_expected - next.amount_received);
    if (next.amount_remaining <= 0) {
      next.status = 'PAID';
      next.settled_at = at;
      next.audit_events.push({ event: 'reconciled_partial_complete', at, event_id: sha256hex(`nexora-payment:${payment.payment_id}:recpart:${at}`).slice(0, 16), detail: `Partial payments completed — now PAID ${next.amount_received} ${next.currency}.` });
    } else {
      next.status = 'PARTIALLY_PAID';
      next.audit_events.push({ event: 'reconciled_partial', at, event_id: sha256hex(`nexora-payment:${payment.payment_id}:recpart:1:${at}`).slice(0, 16), detail: `Partial payment ${rec.amount} ${rec.currency} received; ${next.amount_remaining} remaining.` });
    }
  } else if (rec.outcome === 'OVERPAYMENT') {
    /* Never silently classify as PAID — surface for review. */
    next.amount_received = round2((next.amount_received || 0) + rec.amount);
    next.amount_remaining = round2(next.amount_expected - next.amount_received);
    next.status = 'PARTIALLY_PAID';
    next.overpayment_review = { flagged_at: at, excess: round2(next.amount_received - next.amount_expected), outcome: 'OVERPAYMENT_REVIEW_REQUIRED' };
    next.audit_events.push({ event: 'overpayment_flagged', at, event_id: sha256hex(`nexora-payment:${payment.payment_id}:over:${at}`).slice(0, 16), detail: `Overpayment ${rec.amount} vs expected ${next.amount_expected} — flagged for review, NOT silently PAID.` });
  } else if (rec.outcome === 'REFUND') {
    if (payment.status !== 'PAID') return { ok: false, reasons: ['cannot record a refund against a non-PAID payment'] };
    next.status = 'REFUNDED';
    next.refunds = [...(next.refunds || []), { ...rec.refund_detail, reconciled_at: at }];
    next.audit_events.push({ event: 'refund_recorded', at, event_id: sha256hex(`nexora-payment:${payment.payment_id}:refund:${at}`).slice(0, 16), detail: `Refund recorded ${rec.refund_detail && rec.refund_detail.amount} ${rec.currency}. Linked to original payment.` });
  } else if (rec.outcome === 'PARTIAL_REFUND') {
    if (payment.status !== 'PAID' && payment.status !== 'REFUNDED') return { ok: false, reasons: ['cannot record a partial refund against a non-PAID payment'] };
    next.status = 'PARTIALLY_REFUNDED';
    next.refunds = [...(next.refunds || []), { ...rec.refund_detail, reconciled_at: at }];
    next.audit_events.push({ event: 'partial_refund_recorded', at, event_id: sha256hex(`nexora-payment:${payment.payment_id}:prefund:${at}`).slice(0, 16), detail: `Partial refund recorded ${rec.refund_detail && rec.refund_detail.amount} ${rec.currency}.` });
  } else if (rec.outcome === 'DISPUTE') {
    next.status = 'DISPUTED';
    next.disputes = [...(next.disputes || []), { ...rec.dispute_detail, recorded_at: at }];
    next.audit_events.push = next.audit_events; // no-op guard
    next.audit_events.push({ event: 'dispute_recorded', at, event_id: sha256hex(`nexora-payment:${payment.payment_id}:dispute:${at}`).slice(0, 16), detail: `Disputed payment evidence recorded. No automated legal/accounting conclusion.` });
  } else {
    return { ok: false, reasons: [`unsupported reconciliation outcome ${rec.outcome}`] };
  }
  next.payment_fingerprint = buildPaymentFingerprint(next);
  return { ok: true, record: next };
}

export function round2(n) { return Math.round((n + Number.EPSILON) * 100) / 100; }

/* ------------------------------------------------------------------ */
/* Reconciliation builder (Worker runtime subset)                     */
/* ------------------------------------------------------------------ */
export function buildReconciliation({ invoice, request, evidence, adapterOutcome, opts = {} }) {
  const reasons = [];
  if (!adapterOutcome || !adapterOutcome.outcome) return { ok: false, reasons: ['adapterOutcome required'] };
  const at = opts.at || (evidence && evidence.recorded_at) || '1970-01-01T00:00:00.000Z';
  const record = {
    schema: RECONCILIATION_SCHEMA,
    reconciliation_id: `REC-${invoice.invoice_id}-${sha256hex(`nexora-reconcile:${invoice.invoice_id}:${evidence.event_id}`).slice(0, 8)}`,
    invoice_id: invoice.invoice_id,
    request_id: request.request_id,
    payment_id: opts.paymentId || null,
    provider: evidence.provider,
    environment: evidence.environment,
    event_id: evidence.event_id,
    provider_ref: evidence.provider_ref,
    outcome: adapterOutcome.outcome,
    amount: adapterOutcome.amount != null ? adapterOutcome.amount : evidence.amount,
    currency: adapterOutcome.currency || evidence.currency,
    reconciled_at: at,
    detail: adapterOutcome.reasons ? adapterOutcome.reasons.join('; ') : '',
    audit_events: [
      { event: 'reconciliation_run', at, event_id: sha256hex(`nexora-reconcile:${invoice.invoice_id}:${at}`).slice(0, 16), detail: `Reconciliation outcome ${adapterOutcome.outcome} for ${invoice.invoice_id}.` }
    ],
    _example: opts.example === true ? true : undefined
  };
  if (record._example === undefined) delete record._example;
  return { ok: true, reconciliation: record };
}

/* ------------------------------------------------------------------ */
/* Validation of payment record                                       */
/* ------------------------------------------------------------------ */
export function validatePaymentRecord(record, opts = {}) {
  const reasons = [];
  if (!record || typeof record !== 'object') return { failures: ['payment record must be an object'], checks: [] };
  if (opts.requireExampleMarker !== false && record._example !== true) reasons.push('_example: fixture must be marked "_example": true — real payment records belong in ops/payment/private/ (gitignored), never committed');
  if (record.schema !== PAYMENT_SCHEMA) reasons.push(`schema must be ${PAYMENT_SCHEMA}`);
  if (typeof record.payment_id !== 'string' || !/^PAY-\d{4}-\d{4}-\d{3}$/.test(record.payment_id)) reasons.push('payment_id must match /^PAY-YYYY-NNNN-NNN$/');
  if (typeof record.invoice_id !== 'string' || !INVOICE_ID_RE.test(record.invoice_id)) reasons.push('invoice_id required (INV-YYYY-NNNN-NNN)');
  if (record.currency !== SOURCE_CURRENCY) reasons.push(`currency must be ${SOURCE_CURRENCY}`);
  if (!PAYMENT_STATUSES.includes(record.status)) reasons.push(`status must be one of ${PAYMENT_STATUSES.join(', ')}`);
  if (record.amount_expected == null || record.amount_expected <= 0) reasons.push('amount_expected must be positive');
  if (typeof record.amount_received !== 'number') reasons.push('amount_received must be a number');
  if (typeof record.amount_remaining !== 'number') reasons.push('amount_remaining must be a number');
  /* Settlement integrity: remaining + received must equal expected. */
  if (typeof record.amount_expected === 'number' && typeof record.amount_received === 'number' && typeof record.amount_remaining === 'number') {
    if (Math.abs((record.amount_received + record.amount_remaining) - record.amount_expected) > 1e-6) {
      reasons.push(`amount_received + amount_remaining (${record.amount_received + record.amount_remaining}) must equal amount_expected (${record.amount_expected})`);
    }
  }
  /* PAID requires reconciled evidence — never fabricated. */
  if (record.status === 'PAID' && !record.settled_at) reasons.push('PAID requires a settled_at timestamp from governed reconciliation');
  if (!record.payment_fingerprint || !/^[0-9a-f]{64}$/.test(record.payment_fingerprint)) reasons.push('payment_fingerprint (64-hex) required');
  else if (!verifyPaymentFingerprint(record).ok) reasons.push('payment_fingerprint mismatch — payment record has been changed');

  const allText = collectStrings(record).join('\n');
  for (const v of scanSecrets(allText)) reasons.push(`secret-like: ${v}`);
  for (const v of scanBankDetails(allText)) reasons.push(`bank detail: ${v}`);
  for (const v of scanPaymentLink(allText)) reasons.push(`payment-link: ${v}`);
  for (const v of scanLegacy(allText)) reasons.push(`legacy: ${v}`);
  for (const v of scanVatAssertions(allText)) reasons.push(`VAT assertion: ${v}`);
  return { failures: reasons, checks: [] };
}

/* ------------------------------------------------------------------ */
/* Webhook/event validation                                           */
/* ------------------------------------------------------------------ */
export function validateWebhookEvent(ev, opts = {}) {
  const reasons = [];
  if (!ev || typeof ev !== 'object') return { failures: ['webhook event must be an object'], checks: [] };
  if (opts.requireExampleMarker !== false && ev._example !== true) reasons.push('_example: fixture must be marked "_example": true — real webhook events belong in ops/payment/private/ (gitignored)');
  if (ev.schema !== WEBHOOK_EVENT_SCHEMA) reasons.push(`schema must be ${WEBHOOK_EVENT_SCHEMA}`);
  if (typeof ev.event_id !== 'string' || !/^[0-9a-f]{24}$/.test(ev.event_id)) reasons.push('event_id must be 24-hex');
  if (!PROVIDER_IDS.includes(ev.provider)) reasons.push('provider must be a governed value');
  if (!PAYMENT_ENVIRONMENTS.includes(ev.environment)) reasons.push('environment must be a governed value');
  if (ev.environment === 'PRODUCTION' && ev._test_only === true) reasons.push('TEST/SANDBOX evidence may not be labelled Production');
  if (typeof ev.provider_ref !== 'string' || !ev.provider_ref.trim()) reasons.push('provider_ref required');
  if (ev.signature_verified !== true) reasons.push('signature_verified must be true (unverified events fail closed)');
  if (ev.webhook_fingerprint && !verifyWebhookFingerprint(ev).ok) reasons.push('webhook_fingerprint mismatch — event has been changed');
  const allText = collectStrings(ev).join('\n');
  for (const v of scanSecrets(allText)) reasons.push(`secret-like: ${v}`);
  return { failures: reasons, checks: [] };
}

/* ------------------------------------------------------------------ */
/* Identity derivation (request id)                                   */
/* ------------------------------------------------------------------ */
export function paymentRequestIdFor(invoiceId, ordinal) {
  if (!INVOICE_ID_RE.test(invoiceId)) return null;
  const m = invoiceId.match(/^INV-(\d{4})-(\d{4})-(\d{3})$/);
  if (!m) return null;
  return `REQ-${m[1]}-${m[2]}-${String(ordinal).padStart(3, '0')}`;
}
