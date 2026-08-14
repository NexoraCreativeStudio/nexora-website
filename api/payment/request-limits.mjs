/* Nexora — Request Limits Utility (PROP.14)
   Shared request-limit enforcement for payment endpoints. */

import { ERROR_CODES, sendErrorResponse } from './error-contract.mjs';

/* Default limits */
export const DEFAULT_LIMITS = {
  maxJsonBodySize: 1048576,        // 1 MB
  maxRawWebhookSize: 1048576,      // 1 MB
  maxSessionIdLength: 64,
  maxQueryParamLength: 512,
  maxCorrelationIdLength: 128,
};

/* Parse JSON body with size limit */
export async function parseJsonBody(req, maxSize = DEFAULT_LIMITS.maxJsonBodySize) {
  return new Promise((resolve, reject) => {
    let total = 0;
    const chunks = [];

    req.on('data', (chunk) => {
      total += chunk.length;
      if (total > maxSize) {
        req.destroy();
        reject({ code: ERROR_CODES.REQUEST_TOO_LARGE, message: `JSON body exceeds ${maxSize} bytes` });
        return;
      }
      chunks.push(chunk);
    });

    req.on('end', () => {
      const raw = Buffer.concat(chunks).toString('utf8');
      if (!raw.trim()) {
        resolve({});
        return;
      }
      try {
        const parsed = JSON.parse(raw);
        resolve(parsed);
      } catch (e) {
        reject({ code: ERROR_CODES.INVALID_JSON, message: 'Invalid JSON payload' });
      }
    });

    req.on('error', (err) => {
      reject({ code: ERROR_CODES.INTERNAL_ERROR, message: `Request error: ${err.message}` });
    });
  });
}

/* Parse raw webhook body with size limit */
export async function parseRawBody(req, maxSize = DEFAULT_LIMITS.maxRawWebhookSize) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let total = 0;

    req.on('data', (chunk) => {
      total += chunk.length;
      if (total > maxSize) {
        req.destroy();
        reject({ code: ERROR_CODES.REQUEST_TOO_LARGE, message: `Raw body exceeds ${maxSize} bytes` });
        return;
      }
      chunks.push(chunk);
    });

    req.on('end', () => {
      const raw = Buffer.concat(chunks);
      resolve(raw);
    });

    req.on('error', (err) => {
      reject({ code: ERROR_CODES.INTERNAL_ERROR, message: `Request error: ${err.message}` });
    });
  });
}

/* Validate session ID format */
export function validateSessionId(sessionId, maxLength = DEFAULT_LIMITS.maxSessionIdLength) {
  if (!sessionId || typeof sessionId !== 'string') {
    return { ok: false, code: ERROR_CODES.MISSING_REQUIRED_FIELD, message: 'session_id required' };
  }
  if (sessionId.length > maxLength) {
    return { ok: false, code: ERROR_CODES.INVALID_FIELD_FORMAT, message: 'session_id too long' };
  }
  if (!/^PSS-[A-Za-z0-9_-]{43}$/.test(sessionId)) {
    return { ok: false, code: ERROR_CODES.INVALID_FIELD_FORMAT, message: 'Invalid session_id format' };
  }
  return { ok: true };
}

/* Validate token ID format */
export function validateTokenId(tokenId, maxLength = DEFAULT_LIMITS.maxSessionIdLength) {
  if (!tokenId || typeof tokenId !== 'string') {
    return { ok: false, code: ERROR_CODES.MISSING_REQUIRED_FIELD, message: 'token required' };
  }
  if (tokenId.length > maxLength) {
    return { ok: false, code: ERROR_CODES.INVALID_FIELD_FORMAT, message: 'token too long' };
  }
  if (!/^PAT-[A-Za-z0-9_-]{43}$/.test(tokenId)) {
    return { ok: false, code: ERROR_CODES.INVALID_FIELD_FORMAT, message: 'Invalid token format' };
  }
  return { ok: true };
}

/* Validate query parameter length */
export function validateQueryParam(value, maxLength = DEFAULT_LIMITS.maxQueryParamLength) {
  if (value === undefined || value === null) return { ok: true };
  const str = String(value);
  if (str.length > maxLength) {
    return { ok: false, code: ERROR_CODES.INVALID_FIELD_FORMAT, message: 'Query parameter too long' };
  }
  return { ok: true };
}

/* Validate correlation ID */
export function validateCorrelationId(correlationId, maxLength = DEFAULT_LIMITS.maxCorrelationIdLength) {
  if (!correlationId || typeof correlationId !== 'string') return { ok: true }; // Optional
  if (correlationId.length > maxLength) {
    return { ok: false, code: ERROR_CODES.INVALID_FIELD_FORMAT, message: 'Correlation ID too long' };
  }
  return { ok: true };
}

/* Create safe response headers */
export function setSafeResponseHeaders(res, correlationId) {
  res.setHeader('Content-Type', 'application/json');
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('X-Content-Type-Options', 'nosniff');
  if (correlationId) {
    res.setHeader('X-Correlation-Id', correlationId);
  }
}

/* CORS headers from config */
export function setCorsHeaders(res, config) {
  if (!config.allowed_origins) return;

  const origins = config.allowed_origins.split(',').map(o => o.trim());
  // Note: actual origin matching happens per-request in handler
  // This just sets the default allowed methods/headers
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Stripe-Signature, X-Correlation-Id');
}

/* Handle preflight */
export function handlePreflight(req, res) {
  if (req.method === 'OPTIONS') {
    res.status(200).end();
    return true;
  }
  return false;
}

/* Middleware-style request validation */
export function createRequestValidator(opts = {}) {
  const limits = { ...DEFAULT_LIMITS, ...opts.limits };

  return async function validateRequest(req, res, next) {
    const correlationId = req.headers['x-correlation-id'] || req.headers['x-request-id'] || generateCorrelationId();
    req.correlationId = correlationId;

    setSafeResponseHeaders(res, correlationId);
    setCorsHeaders(res, opts.config || {});

    if (handlePreflight(req, res)) return;

    // Validate correlation ID
    const corrValidation = validateCorrelationId(correlationId);
    if (!corrValidation.ok) {
      return sendErrorResponse(res, corrValidation.code, correlationId);
    }

    // Body size limits enforced in parseJsonBody/parseRawBody

    if (typeof next === 'function') {
      next();
    }
  };
}

/* Generate correlation ID */
function generateCorrelationId() {
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  return `req-${Buffer.from(bytes).toString('base64url')}`;
}