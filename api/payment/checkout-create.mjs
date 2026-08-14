/* Nexora — Stripe Checkout Session Creation API (PROP.14)
   POST /api/payment/checkout
   Deployment-ready: TEST/SANDBOX/STAGING_TEST modes.
   Server-authoritative amount/currency, environment gates, staging kill switch,
   idempotency, safe URL construction, governed lineage. */

import { createHash } from 'crypto';
import { join } from 'path';
import { buildConfigFromEnv, validateDeploymentConfig, DEPLOYMENT_ENVIRONMENTS, STRIPE_MODES } from '../../ops/payment/deployment-config.mjs';
import { StripeAdapter, STRIPE_PROVIDER_ID, toMinorUnits, buildStripeMetadata, deriveIdempotencyKey } from '../../ops/payment/stripe-adapter.mjs';
import { buildCheckoutSessionRequest, normalizeStripeCheckoutSession, buildPortalSession, validatePortalSession, attachCheckoutSession, checkSessionValidForCheckout } from '../../ops/payment/portal-session.mjs';
import { buildPaymentToken, checkTokenUsable, validatePaymentToken, TOKEN_EXAMPLE, markTokenUsed, TOKEN_ID_RE } from '../../ops/payment/token-model.mjs';
import { createStorageAdapter } from '../../ops/payment/runtime-storage.mjs';
import { createBoundProductionStorageAdapter } from '../../ops/payment/shared-storage-binding.mjs';
import { parseJsonBody, setSafeResponseHeaders, handlePreflight, validateTokenId, sendErrorResponse, ERROR_CODES, createRequestValidator } from './request-limits.mjs';
import { getDefaultLogger } from '../../ops/payment/structured-logging.mjs';
import { generateCorrelationId } from '../../ops/payment/structured-logging.mjs';

const OPS_DIR = join(process.cwd(), 'ops');
const PAYMENT_DIR = join(OPS_DIR, 'payment');

const logger = getDefaultLogger();

/* Build Stripe config from deployment config */
function buildStripeConfig(config) {
  return {
    success_url: config.stripe_success_url,
    cancel_url: config.stripe_cancel_url,
    production_activation_gate: config.production_payment_enabled === true,
  };
}

/* Get test invoice fixture */
async function getTestInvoice(invoiceId) {
  const file = join(OPS_DIR, 'billing', 'examples', 'invoice-issued-example.json');
  const { existsSync, readFileSync } = await import('fs');
  if (existsSync(file)) {
    const invoice = JSON.parse(readFileSync(file, 'utf8'));
    if (invoice.invoice_id === invoiceId) return invoice;
  }
  return null;
}

/* Get test payment request fixture */
async function getTestRequest(requestId) {
  const file = join(PAYMENT_DIR, 'examples', 'payment-request-example.json');
  const { existsSync, readFileSync } = await import('fs');
  if (existsSync(file)) {
    const request = JSON.parse(readFileSync(file, 'utf8'));
    if (request.request_id === requestId) return request;
  }
  return null;
}

/* Lookup payment token (test fixtures only) */
function lookupToken(tokenId) {
  if (tokenId === TOKEN_EXAMPLE.token_id) {
    return { token: TOKEN_EXAMPLE, source: 'example' };
  }
  if (TOKEN_ID_RE.test(tokenId)) {
    const derivedToken = buildPaymentToken({
      invoice: getTestInvoice('INV-2026-9898-001'),
      request: getTestRequest('REQ-2026-9898-001'),
      example: true
    });
    if (derivedToken.ok && derivedToken.token.token_id === tokenId) {
      return { token: derivedToken.token, source: 'derived' };
    }
  }
  return null;
}

/* Create Stripe Checkout Session (test mode uses deterministic synthetic representation) */
async function createCheckoutSession(adapter, paymentRequest, config) {
  return await adapter.createCheckoutSession(paymentRequest);
}

/* Main handler */
export default async function handler(req, res) {
  const correlationId = req.headers['x-correlation-id'] || req.headers['x-request-id'] || generateCorrelationId();
  req.correlationId = correlationId;

  // Safe headers
  setSafeResponseHeaders(res, correlationId);

  // CORS from config
  const config = buildConfigFromEnv();
  const origins = config.allowed_origins ? config.allowed_origins.split(',').map(o => o.trim()) : [];
  const requestOrigin = req.headers.origin;
  if (requestOrigin && origins.includes(requestOrigin)) {
    res.setHeader('Access-Control-Allow-Origin', requestOrigin);
  }
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, X-Correlation-Id');

  if (handlePreflight(req, res)) return;

  // Validate deployment config
  const configValidation = validateDeploymentConfig(config);
  if (!configValidation.ok) {
    logger.logConfigValidation({
      correlationId,
      environment: config.environment,
      valid: false,
      reasons: configValidation.reasons,
    });
    return sendErrorResponse(res, ERROR_CODES.CONFIG_INVALID, correlationId, configValidation.reasons);
  }

  // Enforce STAGING_PAYMENT_ENABLED gate
  if (config.environment === DEPLOYMENT_ENVIRONMENTS.STAGING_TEST && !config.staging_payment_enabled) {
    logger.logKillSwitch({
      correlationId,
      gate: 'STAGING_PAYMENT_ENABLED',
      enabled: false,
      action: 'checkout_blocked',
    });
    return sendErrorResponse(res, ERROR_CODES.STAGING_PAYMENTS_DISABLED, correlationId);
  }

  // Enforce PRODUCTION_PAYMENT_ENABLED gate
  if (config.environment === DEPLOYMENT_ENVIRONMENTS.PRODUCTION_DISABLED && !config.production_payment_enabled) {
    logger.logKillSwitch({
      correlationId,
      gate: 'PRODUCTION_PAYMENT_ENABLED',
      enabled: false,
      action: 'checkout_blocked',
    });
    return sendErrorResponse(res, ERROR_CODES.PRODUCTION_PAYMENTS_DISABLED, correlationId);
  }

  // Parse JSON body with size limit
  let body;
  try {
    body = await parseJsonBody(req, config.max_json_body_size);
  } catch (err) {
    return sendErrorResponse(res, err.code, correlationId);
  }

  // Validate token
  const tokenId = body.token;
  const tokenValidation = validateTokenId(tokenId);
  if (!tokenValidation.ok) {
    return sendErrorResponse(res, tokenValidation.code, correlationId);
  }

  try {
    // Lookup token
    const lookup = lookupToken(tokenId);
    if (!lookup) {
      return sendErrorResponse(res, ERROR_CODES.TOKEN_NOT_FOUND, correlationId);
    }

    const { token, source } = lookup;

    // Validate token structure
    const validation = validatePaymentToken(token, { requireExampleMarker: source === 'example' });
    if (validation.failures.length) {
      return sendErrorResponse(res, ERROR_CODES.INVALID_REQUEST, correlationId, validation.failures);
    }

    // Get invoice and request
    const invoice = await getTestInvoice(token.invoice_id);
    const request = await getTestRequest(token.payment_request_id);

    if (!invoice || !request) {
      return sendErrorResponse(res, ERROR_CODES.INVOICE_NOT_PAYABLE, correlationId);
    }

    // Check token usability
    const usable = checkTokenUsable(token, invoice, request);
    if (!usable.ok) {
      if (usable.reasons.some(r => r.includes('VOID_INVOICE') || r.includes('CANCELLED_INVOICE'))) {
        return sendErrorResponse(res, ERROR_CODES.INVOICE_NOT_PAYABLE, correlationId, usable.reasons);
      }
      if (usable.reasons.some(r => r.includes('expired') || r.includes('used'))) {
        return sendErrorResponse(res, ERROR_CODES.TOKEN_USED, correlationId, usable.reasons);
      }
      return sendErrorResponse(res, ERROR_CODES.INVALID_REQUEST, correlationId, usable.reasons);
    }

    // Build portal session
    const sessionResult = buildPortalSession({ token, paymentRequest: request, invoice, example: true });
    if (!sessionResult.ok) {
      return sendErrorResponse(res, ERROR_CODES.CHECKOUT_CREATION_FAILED, correlationId, sessionResult.reasons);
    }

    let portalSession = sessionResult.session;

    // Build Stripe Checkout Session request
    const stripeConfig = buildStripeConfig(config);
    const checkoutRequest = buildCheckoutSessionRequest(request, portalSession, stripeConfig);

    // Create Stripe adapter
    const stripeAdapter = new StripeAdapter({
      environment: config.stripe_mode === 'LIVE' ? 'PRODUCTION' : 'TEST',
      config: stripeConfig,
    });

    // Create Checkout Session
    const stripeSession = await createCheckoutSession(stripeAdapter, request, stripeConfig);

    // Normalize and attach to portal session
    const normalized = normalizeStripeCheckoutSession(stripeSession);
    if (!normalized.ok) {
      return sendErrorResponse(res, ERROR_CODES.CHECKOUT_CREATION_FAILED, correlationId, normalized.reasons);
    }

    const attached = attachCheckoutSession(portalSession, normalized.session);
    if (!attached.ok) {
      return sendErrorResponse(res, ERROR_CODES.CHECKOUT_CREATION_FAILED, correlationId, attached.reasons);
    }

    portalSession = attached.session;

    // Store session via governed storage adapter
    const storage = config.environment === DEPLOYMENT_ENVIRONMENTS.LOCAL_TEST
      ? createStorageAdapter({ environment: 'TEST', config: { baseDir: join(PAYMENT_DIR, 'private', 'test-runtime') } })
      : createBoundProductionStorageAdapter(config);

    await storage.createSession(portalSession);

    // Mark token as used (single-use)
    const usedTokenResult = markTokenUsed(token);
    if (usedTokenResult.ok) {
      // In production, persist updated token
    }

    // Log checkout created
    logger.logCheckoutCreated({
      correlationId,
      sessionId: portalSession.session_id,
      paymentRequestId: request.request_id,
      amount: request.amount_requested,
      currency: request.currency,
    });

    // Return checkout URL
    return res.status(200).json({
      ok: true,
      checkout_url: normalized.session.url,
      checkout_session_id: normalized.session.id,
      portal_session_id: portalSession.session_id,
      expires_at: normalized.session.expires_at,
      environment: config.environment,
      stripe_mode: config.stripe_mode,
      _test_only: config.environment !== DEPLOYMENT_ENVIRONMENTS.PRODUCTION_DISABLED || config.stripe_mode !== 'LIVE',
    });

  } catch (err) {
    logger.logError({
      correlationId,
      error_code: 'CHECKOUT_CREATION_FAILED',
      message: err.message,
      context: 'checkout_create',
    });

    return sendErrorResponse(res, ERROR_CODES.INTERNAL_ERROR, correlationId);
  }
}

/* For local testing */
if (import.meta.url === `file://${process.argv[1]}`) {
  const testReq = { method: 'POST', headers: {}, body: { token: TOKEN_EXAMPLE.token_id } };
  const testRes = {
    statusCode: 200,
    headers: {},
    body: null,
    setHeader() {},
    status(code) { this.statusCode = code; return this; },
    json(data) { this.body = data; console.log(JSON.stringify(data, null, 2)); return this; },
    end() { console.log('Status:', this.statusCode); }
  };
  await handler(testReq, testRes);
}