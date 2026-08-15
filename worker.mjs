/* Nexora — Cloudflare Workers Entry Point (PROP.17 HOTFIX 5)
   Route-first initialization: config → route → lazy handler import.
   No payment handlers loaded for unknown routes.
   Logger initialized from Cloudflare env bindings. */

import { buildConfigFromEnv, DEPLOYMENT_ENVIRONMENTS } from './ops/payment/deployment-config.mjs';
import { createWebhookVerifier } from './ops/payment/webhook-verifier.mjs';
import { parseRawBody, rawBodyToString, handlePreflight, ERROR_CODES } from './api/payment/request-limits.mjs';
import { sendErrorResponse } from './api/payment/error-contract.mjs';
import { generateCorrelationId } from './ops/payment/structured-logging.mjs';
import { SafeLogger } from './ops/payment/structured-logging.mjs';

/* Route map - exact path matching only */
const ROUTES = [
  { path: '/api/payment/health', handler: 'health', allowedMethods: ['GET'] },
  { path: '/api/payment/readiness', handler: 'readiness', allowedMethods: ['GET'] },
  { path: '/api/payment/checkout-create', handler: 'checkout-create', allowedMethods: ['POST'] },
  { path: '/api/payment/status', handler: 'status', allowedMethods: ['GET'] },
  { path: '/api/payment/webhook', handler: 'webhook', allowedMethods: ['POST'] },
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
function createRequestAdapter(cfRequest, env) {
  const url = new URL(cfRequest.url);
  const path = url.pathname;
  const query = {};
  for (const [key, value] of url.searchParams) query[key] = value;

  const headers = {};
  for (const [key, value] of cfRequest.headers) headers[key.toLowerCase()] = value;
  if (!headers['x-correlation-id'] && !headers['x-request-id']) {
    headers['x-correlation-id'] = generateCorrelationId();
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

/* Lazy load single handler by name */
async function loadHandler(handlerName) {
  if (handlerCache.has(handlerName)) return handlerCache.get(handlerName);

  const paths = {
    'health': './api/payment/health.mjs',
    'readiness': './api/payment/readiness.mjs',
    'checkout-create': './api/payment/checkout-create.mjs',
    'status': './api/payment/status.mjs',
    'webhook': './api/payment/webhook.mjs',
  };

  const path = paths[handlerName];
  if (!path) throw new Error(`Unknown handler: ${handlerName}`);

  const mod = await import(path);
  const handler = mod.default;
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
  const reqAdapter = createRequestAdapter(request, env);
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

/* Main Workers fetch handler - ROUTE-FIRST INITIALIZATION */
export default {
  async fetch(request, env, ctx) {
    // 1. Correlation ID
    const correlationId = request.headers.get('x-correlation-id') ||
                          request.headers.get('x-request-id') ||
                          generateCorrelationId();

    // 2. Build config from Cloudflare env (fails closed for STAGING_TEST if bindings missing)
    const config = buildConfigFromEnv(env);

    // 3. URL/path extraction
    const url = new URL(request.url);
    const path = url.pathname;

    // 4. Route matching
    const route = matchRoute(path);

    // 5. CORS preflight (uses config from step 2)
    const corsResponse = handlePreflightCf(request, config);
    if (corsResponse) return corsResponse;

    // 6. If route missing -> immediate safe 404 (NO handler imports, NO storage init)
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

    // 7. Method validation -> safe 405
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

    // 8. Create logger from Cloudflare env (not process.env)
    const logger = createLogger(env, correlationId);
    const startTime = Date.now();

    // 9. Create request/response adapters
    const reqAdapter = createRequestAdapter(request, env);
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

    // 10. ONLY NOW lazily import the single required handler
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