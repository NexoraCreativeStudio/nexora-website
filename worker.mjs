/* Nexora — Cloudflare Workers Entry Point (PROP.17 HOTFIX 8)
   Route-before-config: URL → route → lightweight config → 404/405 → full config → handler.
   Unknown routes return 404 WITHOUT validating payment/storage/Stripe secrets.
   Logger initialized from Cloudflare env bindings.
   Statically analyzable lazy handler imports — no dynamic import(pathVariable).
   Request-scoped logger injected into handlers for correct environment telemetry. */

import { buildConfigFromEnv, buildReadinessConfigFromEnv, DEPLOYMENT_ENVIRONMENTS } from './ops/payment/deployment-config.mjs';
import { createWebhookVerifier } from './ops/payment/webhook-verifier.mjs';
import { parseRawBody, rawBodyToString, handlePreflight, ERROR_CODES } from './api/payment/request-limits.mjs';
import { sendErrorResponse } from './api/payment/error-contract.mjs';
import { generateCorrelationId } from './ops/payment/structured-logging.mjs';
import { SafeLogger } from './ops/payment/structured-logging.mjs';

/* Route map - exact path matching only */
const ROUTES = [
  { path: '/api/payment/health', handler: 'health', allowedMethods: ['GET', 'OPTIONS'], requiresFullConfig: false, requiresObservationalConfig: false },
  { path: '/api/payment/readiness', handler: 'readiness', allowedMethods: ['GET', 'OPTIONS'], requiresFullConfig: false, requiresObservationalConfig: true },
  { path: '/api/payment/checkout-create', handler: 'checkout-create', allowedMethods: ['POST', 'OPTIONS'], requiresFullConfig: true },
  { path: '/api/payment/status', handler: 'status', allowedMethods: ['GET', 'OPTIONS'], requiresFullConfig: true },
  { path: '/api/payment/webhook', handler: 'webhook', allowedMethods: ['POST', 'OPTIONS'], requiresFullConfig: true },
];

/* Lazy handler cache */
const handlerCache = new Map();

/* Create logger from Cloudflare env bindings (not process.env) */
function createLogger(env, correlationId) {
  return new SafeLogger({
    level: env.LOG_LEVEL || 'info',
    deploymentId: env.DEPLOYMENT_ID || correlationId,
    environment: env.PAYMENT_RUNTIME_ENV || env.DEPLOYMENT_ENV || 'LOCAL_TEST',
  });
}

/* Match route - exact path only */
function matchRoute(path) {
  for (const route of ROUTES) {
    if (route.path === path) return route;
  }
  return null;
}

/* Lightweight config for routing/preflight - extracts only runtime values needed before full validation */
function buildLightweightConfig(env) {
  return {
    environment: env.PAYMENT_RUNTIME_ENV || env.DEPLOYMENT_ENV || 'LOCAL_TEST',
    allowed_origins: env.ALLOWED_ORIGINS || 'https://localhost:3000',
    log_level: env.LOG_LEVEL || 'info',
    deployment_id: env.DEPLOYMENT_ID || 'unknown',
    stripe_mode: env.STRIPE_MODE || 'TEST',
    max_raw_webhook_size: parseInt(env.MAX_RAW_WEBHOOK_SIZE, 10) || 1048576,
  };
}

/* Cloudflare Workers Response adapter */
class WorkersResponseAdapter {
  constructor() {
    this.statusCode = 200;
    this.headers = new Headers();
    this.body = null;
    this._ended = false;
  }

  setHeader(name, value) { this.headers.set(name, value); }
  getHeader(name) { return this.headers.get(name); }
  removeHeader(name) { this.headers.delete(name); }
  status(code) { this.statusCode = code; return this; }

  json(data) {
    this.body = JSON.stringify(data);
    this.headers.set('Content-Type', 'application/json');
    return this;
  }

  end(data) {
    if (data !== undefined) {
      if (typeof data === 'string') this.body = data;
      else this.body = JSON.stringify(data);
    }
    this._ended = true;
    return this;
  }

  toResponse() {
    return new Response(this.body, { status: this.statusCode, headers: this.headers });
  }
}

/* Cloudflare Workers Request adapter */
function createRequestAdapter(cfRequest, env, logger = null, correlationId = null) {
  const url = new URL(cfRequest.url);
  const path = url.pathname;
  const query = {};
  for (const [key, value] of url.searchParams) query[key] = value;

  const headers = {};
  for (const [key, value] of cfRequest.headers) headers[key.toLowerCase()] = value;
  // Use pre-computed correlationId if provided (Worker fetch handler), else fallback to headers or generate
  if (!headers['x-correlation-id'] && !headers['x-request-id']) {
    headers['x-correlation-id'] = correlationId || generateCorrelationId();
  }

  return {
    method: cfRequest.method,
    url: cfRequest.url,
    path,
    query,
    params: {},
    headers,
    cf: cfRequest.cf,
    _cfRequest: cfRequest,
    _env: env,
    logger, // Request-scoped logger from Worker env
  };
}

/* Handle preflight for Cloudflare Workers */
function handlePreflightCf(request, config) {
  if (request.method !== 'OPTIONS') return null;
  const headers = new Headers();
  headers.set('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  headers.set('Access-Control-Allow-Headers', 'Content-Type, Stripe-Signature, X-Correlation-Id');
  headers.set('Cache-Control', 'no-store');

  if (config.allowed_origins) {
    const origins = config.allowed_origins.split(',').map(o => o.trim());
    const requestOrigin = request.headers.get('origin');
    if (requestOrigin && origins.includes(requestOrigin)) {
      headers.set('Access-Control-Allow-Origin', requestOrigin);
    }
  }
  return new Response(null, { status: 200, headers });
}

/* Statically analyzable handler loaders — literal import() call sites for Wrangler/esbuild */
const HANDLER_LOADERS = {
  health: () => import('./api/payment/health.mjs'),
  readiness: () => import('./api/payment/readiness.mjs'),
  'checkout-create': () => import('./api/payment/checkout-create.mjs'),
  status: () => import('./api/payment/status.mjs'),
  webhook: () => import('./api/payment/webhook.mjs'),
};

/* Lazy load single handler by name — validates handlerName, preserves cache, invokes loader */
async function loadHandler(handlerName) {
  if (handlerCache.has(handlerName)) return handlerCache.get(handlerName);

  const loader = HANDLER_LOADERS[handlerName];
  if (!loader) throw new Error(`Unknown handler: ${handlerName}`);

  const mod = await loader();
  const handler = mod.default;
  if (typeof handler !== 'function') throw new Error(`Handler ${handlerName} does not export default function`);
  handlerCache.set(handlerName, handler);
  return handler;
}

/* Specialized webhook handler preserving exact raw body */
async function handleWebhook(request, env, config, correlationId, logger, resAdapter) {
  // Parse raw body with size limit - exact bytes for signature verification
  let rawBody;
  try {
    rawBody = await parseRawBody(request, config.max_raw_webhook_size);
  } catch (err) {
    sendErrorResponse(resAdapter, err.code, correlationId);
    return resAdapter.toResponse();
  }

  // Get signature header
  const signatureHeader = request.headers.get('stripe-signature') || request.headers.get('Stripe-Signature');
  if (!signatureHeader) {
    logger.logWebhookSignatureMissing({ correlationId });
    sendErrorResponse(resAdapter, ERROR_CODES.WEBHOOK_SIGNATURE_INVALID, correlationId);
    return resAdapter.toResponse();
  }

  // Verify signature via governed webhook verifier
  const verifier = createWebhookVerifier({ environment: config.environment, config });
  const rawBodyString = rawBodyToString(rawBody);
  const sigResult = await verifier.verify(rawBodyString, signatureHeader, config.stripe_webhook_secret);

  if (!sigResult.verified) {
    logger.logWebhookSignatureInvalid({ correlationId, reason: sigResult.reason });
    sendErrorResponse(resAdapter, ERROR_CODES.WEBHOOK_SIGNATURE_INVALID, correlationId);
    return resAdapter.toResponse();
  }

  // Parse JSON from raw body
  let stripeEvent;
  try {
    stripeEvent = JSON.parse(rawBodyString);
  } catch (e) {
    logger.logWebhookPayloadInvalid({ correlationId, error: e.message });
    sendErrorResponse(resAdapter, ERROR_CODES.WEBHOOK_PAYLOAD_INVALID, correlationId);
    return resAdapter.toResponse();
  }

  // Create request adapter with parsed body and verified flag
  const reqAdapter = createRequestAdapter(request, env, logger, correlationId);
  reqAdapter.body = stripeEvent;
  reqAdapter.rawBody = rawBody;
  reqAdapter.signatureVerified = true;
  reqAdapter.webhookEvent = stripeEvent;
  reqAdapter.config = config;

  // Call the webhook handler (lazy loaded)
  const handler = await loadHandler('webhook');
  await handler(reqAdapter, resAdapter);
  return resAdapter.toResponse();
}

/* Main Workers fetch handler - ROUTE-BEFORE-CONFIG INITIALIZATION */
export default {
  async fetch(request, env, ctx) {
    // 1. Correlation ID
    const correlationId = request.headers.get('x-correlation-id') ||
                          request.headers.get('x-request-id') ||
                          generateCorrelationId();

    // 2. URL/path extraction
    const url = new URL(request.url);
    const path = url.pathname;

    // 3. Route matching
    const route = matchRoute(path);

    // 4. If route missing -> immediate safe 404 (NO config validation, NO handler imports, NO storage init)
    if (!route) {
      return new Response(JSON.stringify({
        error: { code: 'NOT_FOUND', message: 'Route not found', request_id: correlationId }
      }), {
        status: 404,
        headers: {
          'Content-Type': 'application/json',
          'Cache-Control': 'no-store',
          'X-Content-Type-Options': 'nosniff',
          'X-Correlation-Id': correlationId,
        },
      });
    }

    // 5. Method validation -> safe 405 (NO config validation needed)
    const allowed = route.allowedMethods || [];
    if (!allowed.includes(request.method)) {
      return new Response(JSON.stringify({
        error: { code: 'METHOD_NOT_ALLOWED', message: 'Method not allowed', request_id: correlationId }
      }), {
        status: 405,
        headers: {
          'Content-Type': 'application/json',
          'Cache-Control': 'no-store',
          'X-Content-Type-Options': 'nosniff',
          'X-Correlation-Id': correlationId,
          'Allow': allowed.join(', '),
        },
      });
    }

    // 6. Lightweight config for preflight/CORS (no secret validation)
    const lightConfig = buildLightweightConfig(env);

    // 7. CORS preflight (uses lightweight config)
    const corsResponse = handlePreflightCf(request, lightConfig);
    if (corsResponse) return corsResponse;

    // 8. Only NOW build config for routes that require it
    let config;
    if (route.requiresFullConfig) {
      // Full strict config for routes that need secrets/validation
      config = buildConfigFromEnv(env);
    } else if (route.requiresObservationalConfig) {
      // Observational config for readiness - never throws, reports missing bindings
      config = buildReadinessConfigFromEnv(env);
    } else {
      // For routes like /health that don't need full config, merge lightweight with minimal defaults
      config = {
        ...lightConfig,
        schema: 'nexora-payment-deployment/v1',
        deployment_id: lightConfig.deployment_id,
        release_sha: env.RELEASE_SHA || 'unknown',
        payments_enabled: env.PAYMENTS_ENABLED === 'true',
        staging_payment_enabled: env.STAGING_PAYMENT_ENABLED === 'true',
        production_payment_enabled: env.PRODUCTION_PAYMENT_ENABLED === 'true',
        stripe_secret_key: 'sk_test_PLACEHOLDER_REPLACE_WITH_REAL_TEST_KEY',
        stripe_webhook_secret: 'whsec_PLACEHOLDER_REPLACE_WITH_REAL_TEST_SECRET',
        stripe_publishable_key: 'pk_test_PLACEHOLDER_REPLACE_WITH_REAL_TEST_KEY',
        public_base_url: env.PUBLIC_BASE_URL || 'https://localhost:3000',
        payment_api_base_url: env.PAYMENT_API_BASE_URL || 'https://localhost:3000',
        stripe_success_url: env.STRIPE_SUCCESS_URL || 'https://localhost:3000/payment/success?session_id={CHECKOUT_SESSION_ID}',
        stripe_cancel_url: env.STRIPE_CANCEL_URL || 'https://localhost:3000/payment/cancel',
        shared_storage_provider: 'memory',
        shared_storage_namespace: 'nexora/payment/LOCAL_TEST',
        allowed_origins: lightConfig.allowed_origins,
        max_json_body_size: parseInt(env.MAX_JSON_BODY_SIZE, 10) || 1048576,
        stripe_api_version: env.STRIPE_API_VERSION || '2024-06-20',
        webhook_tolerance_seconds: parseInt(env.WEBHOOK_TOLERANCE_SECONDS, 10) || 300,
        idempotency_ttl_seconds: parseInt(env.IDEMPOTENCY_TTL_SECONDS, 10) || 86400,
        reconciliation_tolerance_pence: parseInt(env.RECONCILIATION_TOLERANCE_PENCE, 10) || 0,
      };
    }

    // 9. Create logger from Cloudflare env (not process.env) - uses correct environment
    const logger = createLogger(env, correlationId);
    const startTime = Date.now();

    // 10. Create request/response adapters (with request-scoped logger and correlationId)
    const reqAdapter = createRequestAdapter(request, env, logger, correlationId);
    reqAdapter.params = {}; // exact matching, no params
    reqAdapter.config = config; // Pass config so handlers don't re-read env

    const resAdapter = new WorkersResponseAdapter();

    // Add CORS headers from config
    if (config.allowed_origins) {
      const origins = config.allowed_origins.split(',').map(o => o.trim());
      const requestOrigin = request.headers.get('origin');
      if (requestOrigin && origins.includes(requestOrigin)) {
        resAdapter.setHeader('Access-Control-Allow-Origin', requestOrigin);
      }
    }

    // 11. ONLY NOW lazily import the single required handler
    try {
      switch (route.handler) {
        case 'health': {
          const handler = await loadHandler('health');
          await handler(reqAdapter, resAdapter);
          break;
        }
        case 'readiness': {
          const handler = await loadHandler('readiness');
          await handler(reqAdapter, resAdapter);
          break;
        }
        case 'checkout-create': {
          const handler = await loadHandler('checkout-create');
          await handler(reqAdapter, resAdapter);
          break;
        }
        case 'status': {
          const handler = await loadHandler('status');
          await handler(reqAdapter, resAdapter);
          break;
        }
        case 'webhook': {
          await handleWebhook(request, env, config, correlationId, logger, resAdapter);
          break;
        }
        default:
          // Should not happen - route matched but handler unknown
          logger.logError({ correlationId, error_code: 'UNKNOWN_HANDLER', message: `No handler for route: ${route.handler}`, context: 'fetch' });
          sendErrorResponse(resAdapter, ERROR_CODES.INTERNAL_ERROR, correlationId);
      }
    } catch (handlerErr) {
      logger.logError({
        correlationId,
        error_code: 'HANDLER_ERROR',
        message: handlerErr.message,
        context: route.handler,
      });
      const errorRes = new WorkersResponseAdapter();
      sendErrorResponse(errorRes, ERROR_CODES.INTERNAL_ERROR, correlationId);
      return errorRes.toResponse();
    }

    // Convert WorkersResponseAdapter to Cloudflare Response
    const cfResponse = resAdapter.toResponse();
    cfResponse.headers.set('X-Correlation-Id', correlationId);

    // Log request completion
    const duration = Date.now() - startTime;
    logger.logRequestComplete({ correlationId, method: request.method, path, status: cfResponse.status, duration_ms: duration });

    return cfResponse;
  },
};