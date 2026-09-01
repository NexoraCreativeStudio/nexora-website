/* Nexora — Stripe Provider Adapter (PROP.10)
   Production-ready interface contract for Stripe integration.
   TEST/SANDBOX-FIRST — no live calls, no live keys.
   Architecture remains provider-neutral for future PayPal support. */

/* Lazy Stripe SDK loading - avoids bundling in Workers test/staging environments */
let _stripeSdk = null;
let _stripeSdkError = null;

async function getStripeSdk() {
  if (_stripeSdk !== null || _stripeSdkError !== null) {
    if (_stripeSdkError) throw new Error(_stripeSdkError);
    return _stripeSdk;
  }
  try {
    // eslint-disable-next-line global-require
    _stripeSdk = require('stripe');
    return _stripeSdk;
  } catch (e) {
    _stripeSdkError = e.message;
    throw new Error(`Stripe SDK not available: ${e.message}`);
  }
}

import { createHash } from 'node:crypto';
import {
  PAYMENT_REQUEST_SCHEMA,
  WEBHOOK_EVENT_SCHEMA,
  PAYMENT_SCHEMA,
  RECONCILIATION_SCHEMA,
  PAYMENT_STATUSES,
  PAYMENT_ENVIRONMENTS,
  PROVIDER_IDS,
  buildWebhookFingerprint,
  verifyWebhookFingerprint,
  sha256hex,
} from './payment-validation-core.mjs';

/* Stripe-specific constants */
export const STRIPE_PROVIDER_ID = 'STRIPE';
export const STRIPE_TEST_ENV = 'TEST';
export const STRIPE_LIVE_ENV = 'PRODUCTION';

/* Supported Stripe event types for reconciliation */
export const STRIPE_RECONCILIATION_EVENT_TYPES = [
  'checkout.session.completed',
  'payment_intent.succeeded',
  'payment_intent.payment_failed',
  'charge.refunded',
  'charge.dispute.created',
  'payout.paid',
  'payout.failed',
  'payout.canceled',
];

/* Minor unit conversion (GBP pounds → pence) */
export function toMinorUnits(amountMajor, currency = 'GBP') {
  if (typeof amountMajor !== 'number' || !Number.isFinite(amountMajor)) {
    throw new Error('amountMajor must be a finite number');
  }
  if (amountMajor < 0) throw new Error('amountMajor must not be negative');
  if (currency !== 'GBP') throw new Error(`Unsupported currency: ${currency}`);
  return Math.round(amountMajor * 100);
}

export function fromMinorUnits(amountMinor, currency = 'GBP') {
  if (typeof amountMinor !== 'number' || !Number.isFinite(amountMinor)) {
    throw new Error('amountMinor must be a finite number');
  }
  if (currency !== 'GBP') throw new Error(`Unsupported currency: ${currency}`);
  return amountMinor / 100;
}

/* Deterministic idempotency key from governed identities */
export function deriveIdempotencyKey(paymentRequestId, operation = 'create') {
  return createHash('sha256')
    .update(`nexora-stripe-idempotency:${operation}:${paymentRequestId}`)
    .digest('hex')
    .slice(0, 32);
}

/* Metadata lineage — connects Stripe objects to governed records */
export function buildStripeMetadata(paymentRequest, paymentId = null) {
  return {
    nexora_payment_request_id: paymentRequest.request_id,
    nexora_invoice_id: paymentRequest.invoice_id,
    nexora_invoice_version: paymentRequest.invoice_version,
    nexora_payment_id: paymentId || '',
    nexora_environment: paymentRequest.environment,
    nexora_provider: 'STRIPE',
  };
}

/* Stripe Adapter Interface — server-side only */
export class StripeAdapter {
  constructor({ environment = 'TEST', config }) {
    this.environment = environment;
    this.config = config;
    this.provider = STRIPE_PROVIDER_ID;
  }

  /* Create a Stripe Checkout Session for a governed payment request.
     Amount/currency MUST derive from the governed payment request. */
  async createCheckoutSession(paymentRequest) {
    if (this.environment === 'PRODUCTION' && !this.config?.production_activation_gate) {
      throw new Error('PRODUCTION mode requires production_activation_gate: true (Owner approval)');
    }

    const amountMinor = toMinorUnits(paymentRequest.amount_requested, paymentRequest.currency);
    const metadata = buildStripeMetadata(paymentRequest);
    const idempotencyKey = deriveIdempotencyKey(paymentRequest.request_id, 'checkout');

    // TEST-MODE: return deterministic synthetic representation
    if (this.environment !== 'PRODUCTION') {
      const syntheticSession = {
        object: 'checkout.session',
        id: `cs_test_${sha256hex(`nexora-checkout:${paymentRequest.request_id}:${amountMinor}`).slice(0, 24)}`,
        payment_status: 'unpaid',
        status: 'open',
        amount_total: amountMinor,
        currency: paymentRequest.currency.toLowerCase(),
        metadata,
        success_url: this.config?.success_url || 'https://example.com/payment/success',
        cancel_url: this.config?.cancel_url || 'https://example.com/payment/cancel',
        livemode: false,
        idempotency_key: idempotencyKey,
        _test_only: true,
        note: 'SYNTHETIC TEST-MODE REPRESENTATION — NOT A REAL STRIPE OBJECT',
      };
      // Add url property to match real Stripe Checkout Session structure
      // In TEST mode, return a fake checkout URL (NOT the success URL)
      syntheticSession.url = `https://checkout.stripe.test/pay/${syntheticSession.id}#fidkdgw`;
      return syntheticSession;
    }

    // PRODUCTION PATH — requires server-side Stripe SDK (lazy loaded)
    try {
      const stripe = await getStripeSdk();
      const stripeClient = stripe(this.config?.secretKey);

      const session = await stripeClient.checkout.sessions.create({
        payment_method_types: ['card'],
        line_items: [{
          price_data: {
            currency: paymentRequest.currency.toLowerCase(),
            product_data: {
              name: `Invoice ${paymentRequest.invoice_number || paymentRequest.invoice_id}`,
              description: `Payment for ${paymentRequest.invoice_id} — Nexora services`,
            },
            unit_amount: amountMinor,
          },
          quantity: 1,
        }],
        mode: 'payment',
        success_url: this.config?.success_url,
        cancel_url: this.config?.cancel_url,
        metadata,
        payment_intent_data: { metadata },
        client_reference_id: this.config?.clientReferenceId,
        idempotency_key: idempotencyKey,
      });

      return session;
    } catch (err) {
      throw new Error(`PRODUCTION createCheckoutSession failed: ${err.message}`);
    }
  }

  /* Create a Stripe Payment Intent (alternative to Checkout for embedded flows) */
  async createPaymentIntent(paymentRequest) {
    if (this.environment === 'PRODUCTION' && !this.config?.production_activation_gate) {
      throw new Error('PRODUCTION mode requires production_activation_gate: true (Owner approval)');
    }

    const amountMinor = toMinorUnits(paymentRequest.amount_requested, paymentRequest.currency);
    const metadata = buildStripeMetadata(paymentRequest);
    const idempotencyKey = deriveIdempotencyKey(paymentRequest.request_id, 'payment_intent');

    if (this.environment !== 'PRODUCTION') {
      return {
        object: 'payment_intent',
        id: `pi_test_${sha256hex(`nexora-pi:${paymentRequest.request_id}:${amountMinor}`).slice(0, 24)}`,
        amount: amountMinor,
        currency: paymentRequest.currency.toLowerCase(),
        metadata,
        status: 'requires_payment_method',
        livemode: false,
        idempotency_key: idempotencyKey,
        _test_only: true,
        note: 'SYNTHETIC TEST-MODE REPRESENTATION — NOT A REAL STRIPE OBJECT',
      };
    }

    // PRODUCTION PATH — requires server-side Stripe SDK (lazy loaded)
    try {
      const stripe = await getStripeSdk();
      const stripeClient = stripe(this.config?.secretKey);

      const intent = await stripeClient.paymentIntents.create({
        amount: amountMinor,
        currency: paymentRequest.currency.toLowerCase(),
        metadata,
        idempotency_key: idempotencyKey,
      });

      return intent;
    } catch (err) {
      throw new Error(`PRODUCTION createPaymentIntent failed: ${err.message}`);
    }
  }

  /* Retrieve Payment Intent status */
  async retrievePaymentIntent(paymentIntentId) {
    if (this.environment !== 'PRODUCTION') {
      return {
        object: 'payment_intent',
        id: paymentIntentId,
        status: 'requires_payment_method',
        _test_only: true,
      };
    }
    throw new Error('PRODUCTION retrievePaymentIntent requires server-side Stripe SDK');
  }

  /* Normalize a raw Stripe webhook event into governed webhook record.
     Signature verification MUST be performed before calling this. */
  normalizeWebhookEvent(stripeEvent, opts = {}) {
    if (!stripeEvent || typeof stripeEvent !== 'object') {
      return { ok: false, reasons: ['stripeEvent must be an object'] };
    }
    if (!stripeEvent.id || !stripeEvent.type) {
      return { ok: false, reasons: ['Stripe event missing id or type'] };
    }
    if (stripeEvent.livemode === true && this.environment !== 'PRODUCTION') {
      return { ok: false, reasons: ['Live Stripe event rejected in non-PRODUCTION environment'] };
    }
    if (stripeEvent.livemode === false && this.environment === 'PRODUCTION') {
      return { ok: false, reasons: ['Test Stripe event rejected in PRODUCTION environment'] };
    }

    // Extract amount/currency from various Stripe event structures
    let amount = null;
    let currency = null;
    let providerRef = stripeEvent.id;
    let paymentRequestId = null;
    let invoiceId = null;

    if (stripeEvent.data?.object) {
      const obj = stripeEvent.data.object;
      amount = obj.amount_total ?? obj.amount ?? null;
      currency = obj.currency?.toUpperCase() ?? null;
      providerRef = obj.id;
      paymentRequestId = obj.metadata?.nexora_payment_request_id ?? null;
      invoiceId = obj.metadata?.nexora_invoice_id ?? null;
    }

    if (amount === null || currency === null) {
      return { ok: false, reasons: ['Could not extract amount/currency from Stripe event'] };
    }

    // Build governed webhook evidence
    const webhookRecord = {
      schema: WEBHOOK_EVENT_SCHEMA,
      event_id: sha256hex(`nexora-stripe-evt:${stripeEvent.id}:${stripeEvent.created}`).slice(0, 24),
      provider: this.provider,
      environment: this.environment,
      provider_ref: providerRef,
      event_type: stripeEvent.type,
      event_time: new Date(stripeEvent.created * 1000).toISOString(),
      recorded_at: new Date().toISOString(),
      invoice_id: invoiceId,
      payment_request_id: paymentRequestId,
      amount: fromMinorUnits(amount, currency),
      currency,
      signature_verified: opts.signatureVerified === true,
      normalized_evidence: {
        provider_ref: providerRef,
        stripe_event_type: stripeEvent.type,
        amount,
        currency: currency.toLowerCase(),
        livemode: stripeEvent.livemode,
      },
      idempotency_key: sha256hex(`nexora-stripe-idem:${stripeEvent.id}`).slice(0, 24),
      _test_only: this.environment !== 'PRODUCTION',
      audit_events: [
        {
          event: 'webhook_received',
          at: new Date().toISOString(),
          event_id: sha256hex(`nexora-stripe-webhook:${stripeEvent.id}`).slice(0, 16),
          detail: `Stripe ${stripeEvent.type} normalised from ${this.environment}. WEBHOOK RECEIVED != PAID.`,
        },
      ],
    };

    webhookRecord.webhook_fingerprint = buildWebhookFingerprint(webhookRecord);
    return { ok: true, event: webhookRecord };
  }

  /* Verify Stripe webhook signature — MUST be called before normalizeWebhookEvent */
  async verifyWebhookSignature(rawPayload, signatureHeader, webhookSecret) {
    if (this.environment !== 'PRODUCTION') {
      // TEST MODE: deterministic simulation — always returns verified for valid test events
      return { ok: true, verified: true, note: 'TEST MODE — signature verification simulated' };
    }

    // PRODUCTION: requires Stripe SDK (lazy loaded)
    try {
      const stripe = await getStripeSdk();
      const stripeClient = stripe(this.config?.secretKey || 'sk_live_PLACEHOLDER');

      const event = stripeClient.webhooks.constructEvent(
        rawPayload,
        signatureHeader,
        webhookSecret
      );

      return {
        ok: true,
        verified: true,
        event,
        note: 'PRODUCTION — verified via official Stripe SDK (lazy loaded)',
        environment: 'PRODUCTION',
      };
    } catch (err) {
      return {
        ok: false,
        verified: false,
        reason: `Stripe signature verification failed: ${err.message}`,
        environment: 'PRODUCTION',
      };
    }
  }

  /* Refund a payment */
  async refundPayment(chargeId, amountMinor = null, metadata = {}) {
    if (this.environment !== 'PRODUCTION') {
      return {
        object: 'refund',
        id: `re_test_${sha256hex(`nexora-refund:${chargeId}:${amountMinor || 'full'}`).slice(0, 18)}`,
        charge: chargeId,
        amount: amountMinor,
        status: 'succeeded',
        _test_only: true,
      };
    }
    throw new Error('PRODUCTION refundPayment requires server-side Stripe SDK');
  }

  /* Retrieve charge details */
  async retrieveCharge(chargeId) {
    if (this.environment !== 'PRODUCTION') {
      return {
        object: 'charge',
        id: chargeId,
        amount: 204000,
        currency: 'gbp',
        status: 'succeeded',
        _test_only: true,
      };
    }
    throw new Error('PRODUCTION retrieveCharge requires server-side Stripe SDK');
  }

  /* Retrieve balance transaction (for fee analysis) */
  async retrieveBalanceTransaction(balanceTransactionId) {
    if (this.environment !== 'PRODUCTION') {
      return {
        object: 'balance_transaction',
        id: balanceTransactionId,
        amount: 204000,
        currency: 'gbp',
        fee: 5916, // ~2.9% + 20p example
        net: 198084,
        type: 'charge',
        _test_only: true,
      };
    }
    throw new Error('PRODUCTION retrieveBalanceTransaction requires server-side Stripe SDK');
  }

  /* Retrieve payout */
  async retrievePayout(payoutId) {
    if (this.environment !== 'PRODUCTION') {
      return {
        object: 'payout',
        id: payoutId,
        amount: 198084,
        currency: 'gbp',
        status: 'paid',
        arrival_date: Math.floor(Date.now() / 1000) + 86400,
        _test_only: true,
      };
    }
    throw new Error('PRODUCTION retrievePayout requires server-side Stripe SDK');
  }
}

/* Test-only Stripe Adapter for deterministic test fixtures */
export class StripeTestAdapter extends StripeAdapter {
  constructor() {
    super({ environment: 'TEST', config: { production_activation_gate: false } });
  }

  /* Generate synthetic Stripe Checkout Session for tests */
  makeTestCheckoutSession(paymentRequest, opts = {}) {
    return this.createCheckoutSession(paymentRequest);
  }

  /* Generate synthetic Stripe webhook event for tests */
  makeTestWebhookEvent(paymentRequest, eventType = 'checkout.session.completed', opts = {}) {
    const amountMinor = toMinorUnits(paymentRequest.amount_requested, paymentRequest.currency);
    const now = Math.floor(Date.now() / 1000);

    return {
      id: `evt_test_${sha256hex(`nexora-test-evt:${paymentRequest.request_id}:${eventType}`).slice(0, 20)}`,
      object: 'event',
      type: eventType,
      created: now,
      livemode: false,
      data: {
        object: {
          id: `cs_test_${sha256hex(`nexora-cs:${paymentRequest.request_id}`).slice(0, 24)}`,
          object: 'checkout.session',
          amount_total: amountMinor,
          currency: paymentRequest.currency.toLowerCase(),
          payment_status: 'paid',
          status: 'complete',
          metadata: buildStripeMetadata(paymentRequest),
          livemode: false,
        },
      },
    };
  }
}

/* OWNER DECISION — PRIMARY PAYMENT PROVIDER
   PROPOSED: STRIPE
   Architecture remains provider-neutral for future PayPal support.
   PayPal adapter would implement equivalent interface when separately approved. */