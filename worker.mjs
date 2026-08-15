/* Nexora — Cloudflare Workers Entry Point (PROP.17)
   Routes requests to existing payment API handlers.
   Adapts Cloudflare Request/Response to existing handler contracts.
   No business logic duplicated — only routing and adaptation. */

import { buildConfigFromEnv, DEPLOYMENT_ENVIRONMENTS } from './ops/payment/deployment-config.mjs';
import { createBoundProductionStorageAdapter } from './ops/payment/shared-storage-binding.mjs';
import { createWebhookVerifier } from './ops/payment/webhook-verifier.mjs';
import { parseRawBody, rawBodyToString, toStringForSignature, setSafeResponseHeaders, handlePreflight, ERROR_CODES } from './api/payment/request-limits.mjs';
import { sendErrorResponse } from './api/payment/error-contract.mjs';
import { generateCorrelationId } from './ops/payment/structured-logging.mjs';
import { getDefaultLogger } from './ops/payment/structured-logging.mjs';

// Lazy import handlers to avoid circular dependencies
let healthHandler = null;
let readinessHandler = null;
let checkoutCreateHandler = null;
let statusHandler = null;
let webhookHandler = null;

async function loadHandlers() {
  if (!healthHandler) {
    const mod = await import('./api/payment/health.mjs');
    healthHandler = mod.default;
  }
  if (!readinessHandler) {
    const mod = await import('./api/payment/readiness.mjs');
    readinessHandler = mod.default;
  }
  if (!checkoutCreateHandler) {
    const mod = await import('./api/payment/checkout-create.mjs');
    checkoutCreateHandler = mod.default;
  }
  if (!statusHandler) {
    const mod = await import('./api/payment/status.mjs');
    statusHandler = mod.default;
  }
  if (!webhookHandler) {
    const mod = await import('./api/payment/webhook.mjs');
    webhookHandler = mod.default;
  }
}

/* Cloudflare Workers Response adapter
   Wraps a standard Response to provide Node-like response methods for handlers */
class WorkersResponseAdapter {
  constructor() {
    this.statusCode = 200;
    this.headers = new Headers();
    this.body = null;
    this._ended = false;
  }

  setHeader(name, value) {
    this.headers.set(name, value);
  }

  getHeader(name) {
    return this.headers.get(name);
  }

  removeHeader(name) {
    this.headers.delete(name);
  }

  status(code) {
    this.statusCode = code;
    return this;
  }

  json(data) {
    this.body = JSON.stringify(data);
    this.headers.set('Content-Type', 'application/json');
    return this;
  }

  end(data) {
    if (data !== undefined) {
      if (typeof data === 'string' || Buffer.isBuffer(data)) {
        this.body = data;
      } else {
        this.body = JSON.stringify(data);
      }
    }
    this._ended = true;
    return this;
  }

  toResponse() {
    return new Response(this.body, {
      status: this.statusCode,
      headers: this.headers,
    });
  }
}

/* Cloudflare Workers Request adapter
   Provides Node-like request interface for existing handlers */
function createRequestAdapter(cfRequest, env) {
  const url = new URL(cfRequest.url);

  // Extract path and query
  const path = url.pathname;
  const query = {};
  for (const [key, value] of url.searchParams) {
    query[key] = value;
  }

  // Convert headers to plain object (lowercase keys for compatibility)
  const headers = {};
  for (const [key, value] of cfRequest.headers) {
    headers[key.toLowerCase()] = value;
  }

  // Add correlation ID if not present
  if (!headers['x-correlation-id'] && !headers['x-request-id']) {
    headers['x-correlation-id'] = generateCorrelationId();
  }

  return {
    method: cfRequest.method,
    url: cfRequest.url,
    path,
    query,
    params: {}, // Will be populated by router
    headers,
    cf: cfRequest.cf,
    // Raw body access for webhook
    _cfRequest: cfRequest,
    _env: env,
  };
}

/* Route matching - exact path matching only (method checked separately for 405 vs 404) */
function matchRoute(path) {
  const routes = [
    { path: '/api/payment/health', handler: 'health', allowedMethods: ['GET'] },
    { path: '/api/payment/readiness', handler: 'readiness', allowedMethods: ['GET'] },
    { path: '/api/payment/checkout-create', handler: 'checkout-create', allowedMethods: ['POST'] },
    { path: '/api/payment/status', handler: 'status', allowedMethods: ['GET'] },
    { path: '/api/payment/webhook', handler: 'webhook', allowedMethods: ['POST'] },
  ];

  for (const route of routes) {
    if (route.path === path) {
      return route;
    }
  }
  return null;
}

/* Extract path params (for future extensibility) */
function extractParams(path, routePath) {
  // For exact matching, no params to extract
  return {};
}

/* Main Workers fetch handler */
export default {
  async fetch(request, env, ctx) {
    const correlationId = request.headers.get('x-correlation-id') ||
                          request.headers.get('x-request-id') ||
                          generateCorrelationId();

    const logger = getDefaultLogger();
    const startTime = Date.now();

    try {
      // Load handlers
      await loadHandlers();

      // Build config from Cloudflare env
      const config = buildConfigFromEnv(env);

      // Route matching
      const url = new URL(request.url);
      const path = url.pathname;
      const route = matchRoute(path);

      // CORS preflight
      const corsResponse = handlePreflightCf(request, config);
      if (corsResponse) return corsResponse;

      if (!route) {
        // 404 for unknown routes
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

      // Check method allowed (405 if path matches but method doesn't)
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

      // Create request adapter
      const reqAdapter = createRequestAdapter(request, env);
      reqAdapter.params = extractParams(path, route.path);
      // Pass config to handlers so they don't re-read process.env (not available in Workers)
      reqAdapter.config = config;

      // Create response adapter
      const resAdapter = new WorkersResponseAdapter();

      // Add CORS headers from config
      if (config.allowed_origins) {
        const origins = config.allowed_origins.split(',').map(o => o.trim());
        const requestOrigin = request.headers.get('origin');
        if (requestOrigin && origins.includes(requestOrigin)) {
          resAdapter.setHeader('Access-Control-Allow-Origin', requestOrigin);
        }
      }

      // Route to appropriate handler
      try {
        console.log(`DEBUG: Routing to handler: ${route.handler}`);
        console.log(`DEBUG: reqAdapter is defined: ${!!reqAdapter}`);
        console.log(`DEBUG: reqAdapter keys: ${Object.keys(reqAdapter)}`);

        switch (route.handler) {
          case 'health':
            await healthHandler(reqAdapter, resAdapter);
            break;
          case 'readiness':
            await readinessHandler(reqAdapter, resAdapter);
            break;
          case 'checkout-create':
            // checkout-create needs special handling for raw body if needed
            console.log(`DEBUG: Calling checkoutCreateHandler`);
            try {
              await checkoutCreateHandler(reqAdapter, resAdapter);
            } catch (e) {
              console.log(`DEBUG: checkoutCreateHandler ERROR: ${e.message}`);
              console.log(`DEBUG: checkoutCreateHandler STACK: ${e.stack}`);
              throw e;
            }
            break;
          case 'status':
            try {
              await statusHandler(reqAdapter, resAdapter);
            } catch (e) {
              console.log(`DEBUG: statusHandler ERROR: ${e.message}`);
              console.log(`DEBUG: statusHandler STACK: ${e.stack}`);
              throw e;
            }
            break;
          case 'webhook':
            // Webhook needs raw body handling - use specialized adapter
            try {
              await handleWebhook(request, env, config, correlationId, resAdapter);
            } catch (e) {
              console.log(`DEBUG: webhookHandler ERROR: ${e.message}`);
              console.log(`DEBUG: webhookHandler STACK: ${e.stack}`);
              throw e;
            }
            break;
        }
      } catch (handlerErr) {
        logger.logError({
          correlationId,
          error_code: 'HANDLER_ERROR',
          message: handlerErr.message,
          context: route.handler,
        });
        // Return a proper Response, not the adapter
        const errorRes = new WorkersResponseAdapter();
        sendErrorResponse(errorRes, ERROR_CODES.INTERNAL_ERROR, correlationId);
        return errorRes.toResponse();
      }

      // Convert WorkersResponseAdapter to Cloudflare Response
      const cfResponse = resAdapter.toResponse();

      // Add correlation ID to response
      cfResponse.headers.set('X-Correlation-Id', correlationId);

      // Log request completion
      const duration = Date.now() - startTime;
      logger.logRequestComplete({
        correlationId,
        method: request.method,
        path,
        status: cfResponse.status,
        duration_ms: duration,
      });

      return cfResponse;

    } catch (err) {
      logger.logError({
        correlationId,
        error_code: 'WORKER_FETCH_ERROR',
        message: err.message,
        context: 'fetch',
      });

      return new Response(JSON.stringify({
        ok: false,
        error: { code: 'INTERNAL_ERROR', message: 'Internal server error', request_id: correlationId },
      }), {
        status: 500,
        headers: {
          'Content-Type': 'application/json',
          'Cache-Control': 'no-store',
          'X-Content-Type-Options': 'nosniff',
          'X-Correlation-Id': correlationId,
        },
      });
    }
  },
};

/* Handle preflight for Cloudflare Workers */
function handlePreflightCf(request, config) {
  if (request.method === 'OPTIONS') {
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
  return null;
}

/* Specialized webhook handler preserving exact raw body */
async function handleWebhook(request, env, config, correlationId, resAdapter) {
  const logger = getDefaultLogger();

  console.log('DEBUG handleWebhook: request type:', typeof request);
  console.log('DEBUG handleWebhook: request.arrayBuffer:', typeof request?.arrayBuffer);
  console.log('DEBUG handleWebhook: request.clone:', typeof request?.clone);

  // Parse raw body with size limit - exact bytes for signature verification
  let rawBody;
  try {
    rawBody = await parseRawBody(request, config.max_raw_webhook_size);
  } catch (err) {
    console.log('DEBUG handleWebhook: parseRawBody error:', err);
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

  // Call the webhook handler
  await webhookHandler(reqAdapter, resAdapter);
  return resAdapter.toResponse();
}