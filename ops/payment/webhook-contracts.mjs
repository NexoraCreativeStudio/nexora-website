/* Nexora — Webhook Contracts (PROP.15 §13)
   Stripe TEST webhook verification, supported event types, replay protection,
   raw-body handling, and idempotency. */

import { STRIPE_RECONCILIATION_EVENT_TYPES, STRIPE_PROVIDER_ID } from './stripe-adapter.mjs';
import { DEPLOYMENT_ENVIRONMENTS } from './deployment-config.mjs';
import { getRawBody, assertRawBodyIntact, getStripeSignatureHeader, DEFAULT_MAX_RAW_BODY } from './raw-body-adapter.mjs';
import { createWebhookVerifier, validateWebhookVerifier } from './webhook-verifier.mjs';
import { createHash } from 'node:crypto';

/* Supported webhook event types for STAGING_TEST */
export const SUPPORTED_WEBHOOK_EVENTS = {
  // Primary events that trigger reconciliation
  RECONCILIATION_TRIGGERS: [
    'checkout.session.completed',
    'payment_intent.succeeded',
  ],
  // Events that update status but don't trigger reconciliation
  STATUS_UPDATES: [
    'checkout.session.expired',
    'payment_intent.payment_failed',
    'charge.refunded',
    'charge.dispute.created',
    'payout.paid',
    'payout.failed',
    'payout.canceled',
  ],
  // All supported events (union)
  ALL: [
    'checkout.session.completed',
    'checkout.session.expired',
    'payment_intent.succeeded',
    'payment_intent.payment_failed',
    'charge.refunded',
    'charge.dispute.created',
    'payout.paid',
    'payout.failed',
    'payout.canceled',
  ],
};

/* Verify event type is supported */
export function isSupportedEventType(eventType) {
  return SUPPORTED_WEBHOOK_EVENTS.ALL.includes(eventType);
}

/* Check if event triggers reconciliation */
export function isReconciliationTrigger(eventType) {
  return SUPPORTED_WEBHOOK_EVENTS.RECONCILIATION_TRIGGERS.includes(eventType);
}

/* Webhook processing contract */
export const WEBHOOK_PROCESSING_CONTRACT = {
  /* Required steps in order */
  steps: [
    '1. Extract raw body (exact bytes — no parse/reserialize)',
    '2. Extract Stripe-Signature header',
    '3. Verify signature via governed verifier',
    '4. Parse JSON from raw body',
    '5. Validate event type is supported',
    '6. Normalize event via StripeAdapter',
    '7. Validate environment matches deployment',
    '8. Validate metadata lineage (payment_request_id, invoice_id)',
    '9. Check idempotency (compare-and-set)',
    '10. Apply event to payment record (evidence)',
    '11. Trigger reconciliation if completed payment',
    '12. Update portal session if found',
    '13. Set idempotency key',
    '14. Return 200 OK with processing result',
  ],

  /* Idempotency guarantees */
  idempotency: {
    keyDerivation: 'sha256("nexora-stripe-idem:" + stripeEventId)',
    storage: 'SharedStorageClient.compareAndSet / setIfAbsent (linearizable)',
    ttl: 'IDEMPOTENCY_TTL_SECONDS (default 86400 = 24h)',
    replayProtection: 'Duplicate events return 200 OK with duplicate: true',
  },

  /* Signature verification */
  signature: {
    algorithm: 'HMAC-SHA256',
    header: 'Stripe-Signature (case-insensitive)',
    components: 't=<timestamp>,v1=<signature>',
    tolerance: 'WEBHOOK_TOLERANCE_SECONDS (default 300 = 5 min)',
    testMode: 'TestDeterministicVerifier (accepts valid format, no crypto)',
    productionMode: 'StripeOfficialVerifier (official Stripe SDK)',
  },

  /* Raw body requirements */
  rawBody: {
    maxSize: 'MAX_RAW_WEBHOOK_SIZE (default 1048576 = 1 MB)',
    encoding: 'UTF-8 (must match exact bytes sent by Stripe)',
    noParsing: 'Must NOT use body-parser middleware before webhook endpoint',
    streamSupport: 'Must handle streaming IncomingMessage',
  },
};

/* Create webhook handler configuration from deployment config */
export function buildWebhookConfig(config) {
  return {
    maxRawBodySize: config.max_raw_webhook_size || DEFAULT_MAX_RAW_BODY,
    webhookToleranceSeconds: config.webhook_tolerance_seconds || 300,
    idempotencyTtlSeconds: config.idempotency_ttl_seconds || 86400,
    reconciliationTolerancePence: config.reconciliation_tolerance_pence || 0,
    supportedEvents: SUPPORTED_WEBHOOK_EVENTS.ALL,
    reconciliationTriggers: SUPPORTED_WEBHOOK_EVENTS.RECONCILIATION_TRIGGERS,
    environment: config.environment,
    stripeMode: config.stripe_mode,
  };
}

/* Validate webhook event structure */
export function validateWebhookEventStructure(stripeEvent) {
  const reasons = [];

  if (!stripeEvent || typeof stripeEvent !== 'object') {
    reasons.push('Event must be an object');
    return { ok: false, reasons };
  }

  if (!stripeEvent.id || typeof stripeEvent.id !== 'string') {
    reasons.push('Event missing id');
  }

  if (!stripeEvent.type || typeof stripeEvent.type !== 'string') {
    reasons.push('Event missing type');
  }

  if (typeof stripeEvent.livemode !== 'boolean') {
    reasons.push('Event missing livemode boolean');
  }

  if (!stripeEvent.created || typeof stripeEvent.created !== 'number') {
    reasons.push('Event missing created timestamp');
  }

  if (!stripeEvent.data || typeof stripeEvent.data !== 'object') {
    reasons.push('Event missing data object');
  }

  return { ok: reasons.length === 0, reasons };
}

/* Extract idempotency key from Stripe event */
export function deriveWebhookIdempotencyKey(stripeEventId) {
  return createHash('sha256')
    .update(`nexora-stripe-idem:${stripeEventId}`)
    .digest('hex')
    .slice(0, 24);
}

/* Webhook signature verification contract */
export async function verifyWebhookSignature(rawPayload, signatureHeader, config, environment) {
  // Get webhook secret
  const webhookSecret = config.stripe_webhook_secret;
  if (!webhookSecret || webhookSecret.includes('PLACEHOLDER')) {
    if (environment === DEPLOYMENT_ENVIRONMENTS.LOCAL_TEST) {
      return { ok: true, verified: true, note: 'TEST MODE — placeholder secret accepted for local testing' };
    }
    return { ok: false, verified: false, reason: 'Webhook secret not configured' };
  }

  // Create verifier
  const verifier = createWebhookVerifier({
    environment: environment === DEPLOYMENT_ENVIRONMENTS.PRODUCTION_DISABLED && config.production_payment_enabled ? 'PRODUCTION' : 'TEST',
    config: { webhookSecret, secretKey: config.stripe_secret_key },
  });

  // Validate verifier
  const verifierValidation = validateWebhookVerifier(verifier, environment);
  if (!verifierValidation.ok) {
    return { ok: false, verified: false, reason: verifierValidation.reason };
  }

  // Verify
  return await verifier.verify(rawPayload, signatureHeader, webhookSecret);
}

/* Idempotency check contract */
export async function checkAndSetIdempotency(storage, idempotencyKey, eventId, ttlSeconds = 86400) {
  // Check if already processed
  const existing = await storage.checkIdempotency(idempotencyKey);
  if (existing.exists) {
    return { ok: true, duplicate: true, eventId: existing.eventId };
  }

  // Try to set (atomic compare-and-set pattern via setIfAbsent)
  const setResult = await storage.setIdempotency(idempotencyKey, eventId);
  if (!setResult.ok) {
    return { ok: false, reason: 'Failed to set idempotency key' };
  }

  return { ok: true, duplicate: false };
}

/* Webhook response contract */
export function buildWebhookResponse(data) {
  return {
    ok: true,
    received: true,
    event_id: data.eventId,
    payment_status: data.paymentStatus,
    reconciliation_outcome: data.reconciliationOutcome || null,
    duplicate: data.duplicate || false,
    environment: data.environment,
    stripe_mode: data.stripeMode,
    _test_only: data.environment !== DEPLOYMENT_ENVIRONMENTS.PRODUCTION_DISABLED || data.stripeMode !== 'LIVE',
  };
}

/* PROP.15 Webhook Contracts Summary */
export const WEBHOOK_CONTRACTS_SUMMARY = `
WEBHOOK CONTRACTS (PROP.15 §13):

1. SUPPORTED EVENT TYPES (TEST mode only for STAGING_TEST)
   Reconciliation triggers:
     - checkout.session.completed
     - payment_intent.succeeded

   Status updates (no reconciliation):
     - checkout.session.expired
     - payment_intent.payment_failed
     - charge.refunded
     - charge.dispute.created
     - payout.paid
     - payout.failed
     - payout.canceled

2. PROCESSING ORDER (14 steps — all mandatory)
   1. Extract raw body (exact bytes)
   2. Extract Stripe-Signature header
   3. Verify signature (governed verifier)
   4. Parse JSON from raw body
   5. Validate event type supported
   6. Normalize via StripeAdapter
   7. Validate environment match
   8. Validate metadata lineage
   9. Check idempotency (CAS)
   10. Apply event to payment record
   11. Trigger reconciliation if completed
   12. Update portal session
   13. Set idempotency key
   14. Return 200 OK

3. IDEMPOTENCY
   - Key: sha256("nexora-stripe-idem:" + stripeEventId)
   - Storage: SharedStorageClient.compareAndSet / setIfAbsent (linearizable)
   - TTL: IDEMPOTENCY_TTL_SECONDS (default 24h)
   - Duplicate handling: 200 OK with duplicate: true

4. SIGNATURE VERIFICATION
   - Algorithm: HMAC-SHA256
   - Header: Stripe-Signature (t=timestamp,v1=signature)
   - Tolerance: WEBHOOK_TOLERANCE_SECONDS (default 300s)
   - Test: TestDeterministicVerifier (format check only)
   - Production: StripeOfficialVerifier (Stripe SDK)

5. RAW BODY REQUIREMENTS
   - Max size: MAX_RAW_WEBHOOK_SIZE (default 1 MB)
   - Encoding: UTF-8 exact bytes
   - No pre-parsing middleware allowed
   - Streaming IncomingMessage supported

6. ENVIRONMENT ISOLATION
   - Test events (livemode: false) rejected in PRODUCTION
   - Live events (livemode: true) rejected in STAGING_TEST/LOCAL_TEST
   - Webhook secret must match mode (test vs live)
`;