/* Nexora — Webhook Signature Verification Abstraction (PROP.12/16)
   Governed verification interface for provider webhook signatures.
   TEST adapter uses deterministic simulation. PRODUCTION requires
   official Stripe SDK boundary — fails closed if unavailable.
   Web Crypto API compatible for Cloudflare Workers. */

import { timingSafeEqual } from 'node:crypto';

/* Detect runtime environment for crypto API selection */
function getCryptoProvider() {
  // Cloudflare Workers has global crypto.subtle
  if (typeof globalThis !== 'undefined' && globalThis.crypto && globalThis.crypto.subtle) {
    return 'webcrypto';
  }
  // Node.js has node:crypto
  return 'node';
}

const CRYPTO_PROVIDER = getCryptoProvider();

/* Web Crypto HMAC-SHA256 implementation */
async function webCryptoHmacSha256(secret, payload) {
  const encoder = new TextEncoder();
  const keyData = encoder.encode(secret);
  const payloadData = typeof payload === 'string' ? encoder.encode(payload) : payload;

  const key = await crypto.subtle.importKey(
    'raw',
    keyData,
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign']
  );

  const signature = await crypto.subtle.sign('HMAC', key, payloadData);
  return new Uint8Array(signature);
}

/* Node.js HMAC-SHA256 implementation */
function nodeHmacSha256(secret, payload) {
  const crypto = require('node:crypto');
  return crypto.createHmac('sha256', secret).update(payload).digest();
}

/* Unified HMAC-SHA256 - returns hex string */
export async function hmacSha256Hex(secret, payload) {
  if (CRYPTO_PROVIDER === 'webcrypto') {
    const result = await webCryptoHmacSha256(secret, payload);
    return Array.from(result).map(b => b.toString(16).padStart(2, '0')).join('');
  }
  return nodeHmacSha256(secret, payload).toString('hex');
}

/* Unified HMAC-SHA256 - returns Uint8Array/Buffer for timing-safe comparison */
export async function hmacSha256Raw(secret, payload) {
  if (CRYPTO_PROVIDER === 'webcrypto') {
    return webCryptoHmacSha256(secret, payload);
  }
  return nodeHmacSha256(secret, payload);
}

/* Constant-time comparison - works with both Uint8Array, Buffer, and strings */
export function constantTimeEqual(a, b) {
  if (!a || !b) return false;

  // Convert to Uint8Array for consistent handling
  let arrA, arrB;

  if (a instanceof Uint8Array) {
    arrA = a;
  } else if (typeof a === 'string') {
    arrA = new TextEncoder().encode(a);
  } else if (typeof Buffer !== 'undefined' && Buffer.isBuffer(a)) {
    arrA = new Uint8Array(a);
  } else if (ArrayBuffer.isView(a)) {
    arrA = new Uint8Array(a.buffer, a.byteOffset, a.byteLength);
  } else {
    arrA = new Uint8Array(a);
  }

  if (b instanceof Uint8Array) {
    arrB = b;
  } else if (typeof b === 'string') {
    arrB = new TextEncoder().encode(b);
  } else if (typeof Buffer !== 'undefined' && Buffer.isBuffer(b)) {
    arrB = new Uint8Array(b);
  } else if (ArrayBuffer.isView(b)) {
    arrB = new Uint8Array(b.buffer, b.byteOffset, b.byteLength);
  } else {
    arrB = new Uint8Array(b);
  }

  if (arrA.length !== arrB.length) return false;

  // Use Web Crypto subtle.timingSafeEqual if available, otherwise manual
  if (typeof crypto !== 'undefined' && crypto.subtle && crypto.subtle.timingSafeEqual) {
    return crypto.subtle.timingSafeEqual(arrA, arrB);
  }

  // Node.js timingSafeEqual with Buffer
  if (typeof Buffer !== 'undefined' && Buffer.from) {
    return timingSafeEqual(Buffer.from(arrA), Buffer.from(arrB));
  }

  // Fallback constant-time comparison
  let result = 0;
  for (let i = 0; i < arrA.length; i++) {
    result |= arrA[i] ^ arrB[i];
  }
  return result === 0;
}

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

    // Verify webhook secret is configured
    this.webhookSecret = opts.config?.webhookSecret;
    if (!this.webhookSecret) {
      throw new Error('STRIPE_OFFICIAL verifier requires config.webhookSecret (from environment/secret manager)');
    }
    if (!this.webhookSecret.startsWith('whsec_')) {
      throw new Error('Webhook secret must be a valid Stripe webhook secret (whsec_...)');
    }

    // Stripe SDK availability - lazy checked on first verify
    this._stripeAvailable = null;
    this._stripeError = null;
  }

  /* Lazy check for Stripe SDK availability */
  async _checkStripeSdk() {
    if (this._stripeAvailable !== null) {
      return this._stripeAvailable;
    }

    try {
      // eslint-disable-next-line no-unused-vars
      const stripe = require('stripe');
      this._stripeAvailable = true;
    } catch (e) {
      this._stripeAvailable = false;
      this._stripeError = e.message;
    }
    return this._stripeAvailable;
  }

  async verify(rawPayload, signatureHeader, webhookSecret) {
    const stripeAvailable = await this._checkStripeSdk();

    if (!stripeAvailable) {
      return {
        ok: false,
        verified: false,
        reason: `Stripe SDK not available: ${this._stripeError}. PRODUCTION webhook verification requires 'stripe' package.`,
      };
    }

    if (!signatureHeader || typeof signatureHeader !== 'string') {
      return { ok: false, verified: false, reason: 'Missing Stripe-Signature header' };
    }

    // Use the official Stripe SDK webhook verification
    try {
      // eslint-disable-next-line global-require
      const stripe = require('stripe')(this.config?.secretKey || 'sk_live_placeholder');

      // Stripe's constructEvent verifies signature and parses
      const event = stripe.webhooks.constructEvent(
        rawPayload,
        signatureHeader,
        this.webhookSecret
      );

      return {
        ok: true,
        verified: true,
        event,
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

/* CRYPTO_PROVIDER is exported above at line 19 */