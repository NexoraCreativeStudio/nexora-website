/* Nexora — Checkout Session Contracts (PROP.15 §11-12)
   Stripe Checkout Session creation, request/response schemas,
   idempotency key handling, and error contracts for STAGING_TEST. */

import { STRIPE_MODES, DEPLOYMENT_ENVIRONMENTS } from './deployment-config.mjs';
import { validateStripeConfig, validateStripeCallAllowed, assertTestModeOnly, validateCheckoutSessionRequest, createStripeClientConfig } from './stripe-test-boundaries.mjs';
import { buildConfigFromEnv } from './deployment-config.mjs';
import { deriveIdempotencyKey, toMinorUnits, buildStripeMetadata } from './stripe-adapter.mjs';
import { PORTAL_SESSION_SCHEMA, PORTAL_SESSION_ID_RE, buildPortalSession, attachCheckoutSession, normalizeStripeCheckoutSession, checkSessionValidForCheckout } from './portal-session.mjs';
import { TOKEN_ID_RE, validatePaymentToken, checkTokenUsable, markTokenUsed } from './token-model.mjs';
import { PAYMENT_REQUEST_SCHEMA, PAYMENT_SCHEMA } from './payment-validation.mjs';

/* Checkout session creation request contract */
export const CHECKOUT_CREATION_REQUEST_SCHEMA = {
  token: 'string (PAT-...)',           // Required: payment access token
  idempotency_key: 'string (optional)', // Optional: client-provided idempotency key
};

/* Checkout session creation response contract */
export const CHECKOUT_CREATION_RESPONSE_SCHEMA = {
  ok: 'boolean',
  checkout_url: 'string (URL)',
  checkout_session_id: 'string (cs_...)',
  portal_session_id: 'string (PSS-...)',
  expires_at: 'ISO datetime',
  environment: 'string (LOCAL_TEST|STAGING_TEST|PRODUCTION_DISABLED)',
  stripe_mode: 'string (TEST|LIVE)',
  _test_only: 'boolean',
};

/* Supported checkout session errors */
export const CHECKOUT_ERRORS = {
  CONFIG_INVALID: 'Deployment configuration invalid',
  STAGING_PAYMENTS_DISABLED: 'Staging payments disabled (STAGING_PAYMENT_ENABLED=false)',
  PRODUCTION_PAYMENTS_DISABLED: 'Production payments disabled (PRODUCTION_PAYMENT_ENABLED=false)',
  INVALID_TOKEN: 'Token format invalid',
  TOKEN_NOT_FOUND: 'Token not found',
  TOKEN_USED: 'Token already used or expired',
  TOKEN_EXPIRED: 'Token expired',
  INVOICE_NOT_PAYABLE: 'Invoice not payable (void, cancelled, or not issued)',
  CHECKOUT_CREATION_FAILED: 'Failed to create Stripe Checkout Session',
  INTERNAL_ERROR: 'Internal server error',
  STRIPE_MODE_MISMATCH: 'Stripe mode mismatch for environment',
  AMOUNT_CURRENCY_MISMATCH: 'Amount/currency validation failed',
};

/* Build checkout session creation config from deployment config */
export function buildCheckoutConfig(config) {
  return {
    success_url: config.stripe_success_url,
    cancel_url: config.stripe_cancel_url,
    production_activation_gate: config.production_payment_enabled === true,
    stripe_api_version: config.stripe_api_version,
    webhook_tolerance_seconds: config.webhook_tolerance_seconds,
    idempotency_ttl_seconds: config.idempotency_ttl_seconds,
  };
}

/* Validate checkout creation request */
export function validateCheckoutRequest(body, config) {
  const reasons = [];

  // Validate token
  if (!body.token) {
    reasons.push('token required');
  } else {
    const tokenValidation = validateTokenId(body.token);
    if (!tokenValidation.ok) {
      reasons.push(tokenValidation.message);
    }
  }

  // Validate idempotency key if provided
  if (body.idempotency_key) {
    if (typeof body.idempotency_key !== 'string' || body.idempotency_key.length > 256) {
      reasons.push('idempotency_key must be a string <= 256 characters');
    }
  }

  return { ok: reasons.length === 0, reasons };
}

/* Token ID validation (from request-limits) */
function validateTokenId(tokenId) {
  if (!tokenId || typeof tokenId !== 'string') {
    return { ok: false, code: 'MISSING_REQUIRED_FIELD', message: 'token required' };
  }
  if (tokenId.length > 64) {
    return { ok: false, code: 'INVALID_FIELD_FORMAT', message: 'token too long' };
  }
  if (!/^PAT-[A-Za-z0-9_-]{43}$/.test(tokenId)) {
    return { ok: false, code: 'INVALID_FIELD_FORMAT', message: 'Invalid token format' };
  }
  return { ok: true };
}

/* Build Stripe Checkout Session request from governed payment request */
export function buildGovernedCheckoutRequest(paymentRequest, portalSession, config) {
  const checkoutConfig = buildCheckoutConfig(config);

  const amountMinor = toMinorUnits(paymentRequest.amount_requested, paymentRequest.currency);
  const metadata = buildStripeMetadata(paymentRequest);
  const idempotencyKey = deriveIdempotencyKey(paymentRequest.request_id, 'checkout');

  const successUrl = checkoutConfig.success_url || 'https://example.com/payment/success?session_id={CHECKOUT_SESSION_ID}';
  const cancelUrl = checkoutConfig.cancel_url || 'https://example.com/payment/cancel';

  return {
    payment_method_types: ['card'],
    line_items: [{
      price_data: {
        currency: paymentRequest.currency.toLowerCase(),
        product_data: {
          name: `Invoice ${paymentRequest.invoice_number || paymentRequest.invoice_id}`,
          description: `Payment for ${paymentRequest.invoice_id} — ${paymentRequest.description || 'Nexora services'}`,
          metadata: {
            nexora_invoice_id: paymentRequest.invoice_id,
            nexora_payment_request_id: paymentRequest.request_id,
          },
        },
        unit_amount: amountMinor,
      },
      quantity: 1,
    }],
    mode: 'payment',
    success_url: successUrl,
    cancel_url: cancelUrl,
    metadata,
    payment_intent_data: {
      metadata,
    },
    client_reference_id: portalSession.session_id,
    expires_at: Math.floor((new Date(portalSession.expires_at).getTime()) / 1000),
  };
}

/* Checkout session creation contract (server-side logic) */
export async function createGovernedCheckoutSession(adapter, paymentRequest, portalSession, config) {
  // Validate Stripe configuration
  const stripeValidation = validateStripeConfig(config);
  if (!stripeValidation.ok) {
    throw new Error(`Stripe config invalid: ${stripeValidation.reasons.join(', ')}`);
  }

  // Validate checkout request
  const checkoutRequest = buildGovernedCheckoutRequest(paymentRequest, portalSession, config);
  const requestValidation = validateCheckoutSessionRequest(checkoutRequest, config);
  if (!requestValidation.ok) {
    throw new Error(`Checkout request invalid: ${requestValidation.reasons.join(', ')}`);
  }

  // Validate Stripe call allowed
  const callValidation = validateStripeCallAllowed(config, 'createCheckoutSession', 'api.stripe.com');
  if (!callValidation.ok) {
    throw new Error(`Stripe call not allowed: ${callValidation.reasons.join(', ')}`);
  }

  // Create session via adapter
  const stripeSession = await adapter.createCheckoutSession(paymentRequest);

  // Normalize response
  const normalized = normalizeStripeCheckoutSession(stripeSession);
  if (!normalized.ok) {
    throw new Error(`Normalization failed: ${normalized.reasons.join(', ')}`);
  }

  return {
    stripeSession: normalized.session,
    portalSession: attachCheckoutSession(portalSession, normalized.session).session,
  };
}

/* Idempotency handling for checkout creation */
export async function handleCheckoutIdempotency(storage, idempotencyKey, paymentRequestId, sessionData) {
  if (!idempotencyKey) {
    // Generate deterministic idempotency key from payment request
    idempotencyKey = deriveIdempotencyKey(paymentRequestId, 'checkout');
  }

  // Check if already created
  const existing = await storage.checkIdempotency(idempotencyKey);
  if (existing.exists) {
    return { ok: true, duplicate: true, sessionData: existing.sessionData };
  }

  // Set idempotency key
  const setResult = await storage.setIdempotency(idempotencyKey, sessionData);
  if (!setResult.ok) {
    return { ok: false, reason: 'Failed to set idempotency key' };
  }

  return { ok: true, duplicate: false };
}

/* PROP.15 Checkout Contracts Summary */
export const CHECKOUT_CONTRACTS_SUMMARY = `
CHECKOUT SESSION CONTRACTS (PROP.15 §11-12):

1. REQUEST SCHEMA
   POST /api/payment/checkout
   {
     "token": "PAT-...",           // Required: payment access token
     "idempotency_key": "..."      // Optional: client-provided idempotency key
   }

2. RESPONSE SCHEMA
   {
     "ok": true,
     "checkout_url": "https://checkout.stripe.com/...",
     "checkout_session_id": "cs_test_...",
     "portal_session_id": "PSS-...",
     "expires_at": "2026-08-15T09:30:00.000Z",
     "environment": "STAGING_TEST",
     "stripe_mode": "TEST",
     "_test_only": true
   }

3. ERROR RESPONSES
   - CONFIG_INVALID: Deployment configuration invalid
   - STAGING_PAYMENTS_DISABLED: STAGING_PAYMENT_ENABLED=false
   - PRODUCTION_PAYMENTS_DISABLED: PRODUCTION_PAYMENT_ENABLED=false
   - INVALID_TOKEN: Token format invalid
   - TOKEN_NOT_FOUND: Token not found
   - TOKEN_USED: Token already used/expired
   - INVOICE_NOT_PAYABLE: Invoice void/cancelled/not issued
   - CHECKOUT_CREATION_FAILED: Stripe session creation failed
   - INTERNAL_ERROR: Internal server error

4. IDEMPOTENCY
   - Key: deriveIdempotencyKey(paymentRequestId, 'checkout') or client-provided
   - Storage: SharedStorageClient.setIfAbsent (linearizable)
   - Duplicate returns existing session data

5. ENVIRONMENT GATES
   - STAGING_TEST: STAGING_PAYMENT_ENABLED must be true
   - PRODUCTION_DISABLED: PRODUCTION_PAYMENT_ENABLED must be true
   - LOCAL_TEST: Always allowed (deterministic adapter)

6. STRIPE TEST MODE BOUNDARIES
   - Amount/currency server-authoritative (from governed payment request)
   - Currency frozen to GBP
   - Mode must be "payment"
   - Success/cancel URLs from configured base URLs
   - Stripe SDK version pinned
   - API version pinned

7. SESSION LIFECYCLE
   CREATED → CHECKOUT_CREATED → CUSTOMER_REDIRECTED → WEBHOOK_RECEIVED → RECONCILED
   Or: EXPIRED / FAILED at any point
`;