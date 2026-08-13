/* Nexora — Webhook Signature Verification Abstraction (PROP.12)
   Governed verification interface for provider webhook signatures.
   TEST adapter uses deterministic simulation. PRODUCTION requires
   official Stripe SDK boundary — fails closed if unavailable. */

import { createHmac, timingSafeEqual } from 'node:crypto';

export const VERIFIER_ADAPTERS = ['TEST_DETERMINISTIC', 'STRIPE_OFFICIAL'];

/* ------------------------------------------------------------------ */
/* Verifier Interface (all adapters must implement)                   */
/* ------------------------------------------------------------------ */
export class WebhookVerifierAdapter {
  constructor({ environment = 'TEST', config = {} }) {
    this.environment = environment;
    this.config = config;
  }

  /* Verify webhook signature
     Returns: { ok: true, verified: true } or { ok: false, verified: false, reason: '...' }
  */
  async verify(rawPayload, signatureHeader, webhookSecret) {
    throw new Error('Not implemented');
  }

  getAdapterId() { return this.constructor.name; }
}

/* ------------------------------------------------------------------ */
/* TEST Deterministic Adapter — accepts valid-format test signatures  */
/* ------------------------------------------------------------------ */
export class TestDeterministicVerifier extends WebhookVerifierAdapter {
  constructor(opts = {}) {
    super({ environment: 'TEST', config: opts.config || {} });
    this.testSecret = opts.config?.testSecret || 'whsec_test_deterministic_secret_for_offline_validation_only';
  }

  async verify(rawPayload, signatureHeader, webhookSecret) {
    // TEST MODE: deterministic simulation
    // In production, this MUST use the official Stripe SDK
    // Accepts signature header format: t=<timestamp>,v1=<signature>
    if (!signatureHeader || typeof signatureHeader !== 'string') {
      return { ok: false, verified: false, reason: 'Missing Stripe-Signature header' };
    }

    // Must contain both timestamp and signature components
    if (!signatureHeader.includes('t=') || !signatureHeader.includes('v1=')) {
      return { ok: false, verified: false, reason: 'Invalid test signature format (missing t= or v1=)' };
    }

    // In TEST mode, we accept valid-format signatures for deterministic testing
    // The payload is NOT cryptographically verified — this is intentional for offline tests
    return {
      ok: true,
      verified: true,
      note: 'TEST MODE — signature verification simulated (deterministic, no crypto)',
      environment: 'TEST',
    };
  }
}

/* ------------------------------------------------------------------ */
/* STRIPE OFFICIAL Adapter — uses Stripe SDK for PRODUCTION          */
/* ------------------------------------------------------------------ */
export class StripeOfficialVerifier extends WebhookVerifierAdapter {
  constructor(opts = {}) {
    super({ environment: 'PRODUCTION', config: opts.config || {} });

    // Verify Stripe SDK is available
    try {
      // eslint-disable-next-line no-unused-vars
      const stripe = require('stripe');
      this.stripeAvailable = true;
    } catch (e) {
      this.stripeAvailable = false;
      this.stripeError = e.message;
    }

    // Verify webhook secret is configured
    this.webhookSecret = opts.config?.webhookSecret;
    if (!this.webhookSecret) {
      throw new Error('STRIPE_OFFICIAL verifier requires config.webhookSecret (from environment/secret manager)');
    }
    if (!this.webhookSecret.startsWith('whsec_')) {
      throw new Error('Webhook secret must be a valid Stripe webhook secret (whsec_...)');
    }
  }

  async verify(rawPayload, signatureHeader, webhookSecret) {
    if (!this.stripeAvailable) {
      return {
        ok: false,
        verified: false,
        reason: `Stripe SDK not available: ${this.stripeError}. PRODUCTION webhook verification requires 'stripe' package.`,
      };
    }

    if (!signatureHeader || typeof signatureHeader !== 'string') {
      return { ok: false, verified: false, reason: 'Missing Stripe-Signature header' };
    }

    // Use the official Stripe SDK webhook verification
    // Note: We construct the event and extract it to verify
    // The SDK's constructEvent does the HMAC-SHA256 verification
    try {
      // eslint-disable-next-line global-require
      const stripe = require('stripe')(this.config?.secretKey || 'sk_live_placeholder'); // secret key needed for some operations

      // Stripe's constructEvent verifies signature and parses
      const event = stripe.webhooks.constructEvent(
        rawPayload,
        signatureHeader,
        this.webhookSecret
      );

      return {
        ok: true,
        verified: true,
        event, // Return the verified event object
        note: 'PRODUCTION — verified via official Stripe SDK',
        environment: 'PRODUCTION',
      };
    } catch (err) {
      // Signature verification failed (wrong secret, tampered payload, etc.)
      return {
        ok: false,
        verified: false,
        reason: `Stripe signature verification failed: ${err.message}`,
        environment: 'PRODUCTION',
      };
    }
  }
}

/* ------------------------------------------------------------------ */
/* Factory — creates verifier based on environment and config        */
/* ------------------------------------------------------------------ */
export function createWebhookVerifier(opts = {}) {
  const environment = opts.environment || 'TEST';

  if (environment === 'PRODUCTION') {
    // PRODUCTION requires explicit StripeOfficialVerifier configuration
    if (!opts.config?.webhookSecret) {
      throw new Error('PRODUCTION environment requires config.webhookSecret for webhook verification');
    }
    return new StripeOfficialVerifier(opts);
  }

  // TEST/SANDBOX — deterministic, no network, no secrets
  return new TestDeterministicVerifier({
    testSecret: opts.config?.testSecret,
  });
}

/* ------------------------------------------------------------------ */
/* Validation helper                                                 */
/* ------------------------------------------------------------------ */
export function validateWebhookVerifier(verifier, environment) {
  if (!verifier || typeof verifier !== 'object') {
    return { ok: false, reason: 'verifier must be an object' };
  }
  if (typeof verifier.verify !== 'function') {
    return { ok: false, reason: 'verifier missing required verify() method' };
  }
  if (environment === 'PRODUCTION' && verifier.getAdapterId() === 'TestDeterministicVerifier') {
    return { ok: false, reason: 'TestDeterministicVerifier must not be used in PRODUCTION' };
  }
  if (environment === 'TEST' && verifier.getAdapterId() === 'StripeOfficialVerifier') {
    return { ok: false, reason: 'StripeOfficialVerifier requires PRODUCTION environment and Stripe SDK' };
  }
  return { ok: true };
}

/* ------------------------------------------------------------------ */
/* Constant-time string comparison (for any custom verification)     */
/* ------------------------------------------------------------------ */
export function constantTimeEqual(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string') return false;
  if (a.length !== b.length) return false;
  return timingSafeEqual(Buffer.from(a), Buffer.from(b));
}

/* ------------------------------------------------------------------ */
/* HMAC-SHA256 helper (for reference — production uses Stripe SDK)   */
/* ------------------------------------------------------------------ */
export function hmacSha256Hex(secret, payload) {
  return createHmac('sha256', secret).update(payload).digest('hex');
}