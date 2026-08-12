/* Nexora — Production Webhook Contract (PROP.10)
   Governed ingestion contract for Stripe webhook events.
   Signature verification is MANDATORY — fail closed if not verified. */

import { sha256hex } from './payment-validation.mjs';

export const WEBHOOK_CONTRACT_SCHEMA = 'nexora-webhook-contract/v1';

/* Required fields in normalized webhook evidence for PRODUCTION */
export const PRODUCTION_WEBHOOK_REQUIRED = [
  'schema',              // nexora-payment-webhook/v1
  'event_id',            // 24-hex governed ID
  'provider',            // 'STRIPE'
  'environment',         // 'PRODUCTION'
  'provider_ref',        // Stripe event/object ID
  'event_type',          // Stripe event type
  'event_time',          // ISO timestamp from Stripe
  'recorded_at',         // ISO timestamp of receipt
  'invoice_id',          // Governed invoice ID
  'payment_request_id',  // Governed payment request ID
  'amount',              // Major units (GBP)
  'currency',            // 'GBP'
  'signature_verified',  // MUST be true
  'normalized_evidence', // Structured Stripe object
  'idempotency_key',     // Governed dedup key
  'webhook_fingerprint', // SHA-256 fingerprint
];

/* Supported Stripe event types for payment reconciliation */
export const SUPPORTED_PAYMENT_EVENT_TYPES = [
  'checkout.session.completed',
  'payment_intent.succeeded',
  'payment_intent.payment_failed',
  'charge.refunded',
  'charge.dispute.created',
];

/* Supported Stripe event types for payout reconciliation */
export const SUPPORTED_PAYOUT_EVENT_TYPES = [
  'payout.paid',
  'payout.failed',
  'payout.canceled',
];

/* Validate webhook contract compliance */
export function validateWebhookContract(event) {
  const reasons = [];

  if (!event || typeof event !== 'object') {
    return { ok: false, reasons: ['event must be an object'] };
  }

  // Schema
  if (event.schema !== 'nexora-payment-webhook/v1') {
    reasons.push('schema must be nexora-payment-webhook/v1');
  }

  // Provider & environment
  if (event.provider !== 'STRIPE') {
    reasons.push('provider must be STRIPE for this contract');
  }
  if (event.environment !== 'PRODUCTION') {
    reasons.push('this contract is for PRODUCTION environment only');
  }

  // Signature verification — MANDATORY
  if (event.signature_verified !== true) {
    reasons.push('signature_verified MUST be true — fail closed if not verified');
  }

  // Required fields
  for (const field of PRODUCTION_WEBHOOK_REQUIRED) {
    if (event[field] === undefined || event[field] === null || event[field] === '') {
      reasons.push(`missing required field: ${field}`);
    }
  }

  // Event type validation
  if (!SUPPORTED_PAYMENT_EVENT_TYPES.includes(event.event_type) &&
      !SUPPORTED_PAYOUT_EVENT_TYPES.includes(event.event_type)) {
    reasons.push(`unsupported event_type: ${event.event_type}`);
  }

  // Amount/currency
  if (typeof event.amount !== 'number' || event.amount <= 0) {
    reasons.push('amount must be a positive number (major units)');
  }
  if (event.currency !== 'GBP') {
    reasons.push('currency must be GBP for initial Production target');
  }

  // Idempotency
  if (!event.idempotency_key || typeof event.idempotency_key !== 'string') {
    reasons.push('idempotency_key required');
  }

  // Fingerprint
  if (!event.webhook_fingerprint || !/^[0-9a-f]{64}$/.test(event.webhook_fingerprint)) {
    reasons.push('webhook_fingerprint (64-hex) required');
  }

  // Reject TEST events in PRODUCTION contract
  if (event._test_only === true) {
    reasons.push('TEST event (_test_only: true) rejected in PRODUCTION contract');
  }

  return { ok: reasons.length === 0, reasons };
}

/* Idempotency key strategy */
export function deriveWebhookIdempotencyKey(stripeEventId, stripeObjectId) {
  return sha256hex(`nexora-webhook-idem:${stripeEventId}:${stripeObjectId}`).slice(0, 24);
}

/* Webhook processing rules */
export const WEBHOOK_PROCESSING_RULES = `
WEBHOOK PROCESSING RULES (PROP.10):

1. SIGNATURE VERIFICATION FIRST
   - Raw payload + Stripe-Signature header + webhook secret
   - MUST verify before ANY business logic
   - Fail closed: invalid signature = reject, do not process

2. ENVIRONMENT ISOLATION
   - Stripe event.livemode === true → PRODUCTION webhook only
   - Stripe event.livemode === false → TEST/SANDBOX only
   - Cross-environment events are REJECTED

3. IDEMPOTENCY
   - Every webhook event tracked by governed idempotency_key
   - Duplicate stripeEventId → ignore (already processed)
   - Duplicate governed event_id → reject (fingerprint mismatch)

4. LINEAGE
   - Extract nexora_payment_request_id from metadata
   - Extract nexora_invoice_id from metadata
   - If missing → reject (cannot reconcile)

5. RECONCILIATION TRIGGER
   - checkout.session.completed / payment_intent.succeeded
     → normalize → PROP.9 reconcile → PAID on EXACT/PARTIAL
   - charge.refunded
     → normalize → PROP.9 refund-record → REFUND/PARTIAL_REFUND
   - charge.dispute.created
     → normalize → PROP.9 dispute state → DISPUTED
   - payout.paid / payout.failed
     → normalize → payout-model reconcile → MATCHED/FAILED

6. REDIRECT ≠ PAID
   - Browser redirect to success_url does NOT mark PAID
   - Only webhook reconciliation marks PAID
   - Success page must state "Payment received for processing"

7. LOGGING (safe)
   - Log: event_id, event_type, invoice_id, payment_request_id, amount, currency, outcome
   - Never log: webhook secret, API keys, card details, full bank details
`;

/* Test webhook verification simulation */
export function simulateTestWebhookVerification(payload, signature) {
  // TEST MODE ONLY — deterministic simulation
  // In production, use Stripe SDK: stripe.webhooks.constructEvent()
  return {
    ok: true,
    verified: true,
    note: 'TEST MODE — webhook signature verification simulated',
  };
}