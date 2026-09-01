/* Nexora — Request Limits Utility (PROP.14/16)
   Shared request-limit enforcement for payment endpoints.
   Supports both Node.js request objects and Cloudflare Workers Request API. */

import { ERROR_CODES, sendErrorResponse } from './error-contract.mjs';

/* Re-export for consumers */
export { ERROR_CODES, sendErrorResponse };

/* Default limits */
export const DEFAULT_LIMITS = {
  maxJsonBodySize: 1048576,        // 1 MB
  maxRawWebhookSize: 1048576,      // 1 MB
  maxSessionIdLength: 64,
  maxQueryParamLength: 512,
  maxCorrelationIdLength: 128,
};

/* Detect request environment */
function isCloudflareRequest(req) {
  return req && typeof req.arrayBuffer === 'function' && typeof req.clone === 'function';
}

function isNodeRequest(req) {
  return req && typeof req.on === 'function' && typeof req.destroy === 'function';
}

/* Parse JSON body with size limit - supports both Node and Cloudflare Workers */
export async function parseJsonBody(req, maxSize = DEFAULT_LIMITS.maxJsonBodySize) {
  // Handle pre-parsed body (for testing) - only if body is already a parsed object, not a stream
  if (req && req.body !== undefined && typeof req.body === 'object' && req.body !== null && typeof req.body.getReader !== 'function') {
    return req.body;
  }
  if (isCloudflareRequest(req)) {
    return parseJsonBodyCloudflare(req, maxSize);
  }
  if (isNodeRequest(req)) {
    return parseJsonBodyNode(req, maxSize);
  }
  // Invalid request object - throw structured error
  throw { code: ERROR_CODES.INVALID_REQUEST, message: 'Invalid request object: missing required stream interface' };
}

/* Node.js implementation */
function parseJsonBodyNode(req, maxSize) {
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

/* Cloudflare Workers implementation */
async function parseJsonBodyCloudflare(req, maxSize) {
  try {
    // Clone to avoid consuming body
    const clonedReq = req.clone();
    const arrayBuffer = await clonedReq.arrayBuffer();
    const bytes = new Uint8Array(arrayBuffer);

    if (bytes.length > maxSize) {
      throw { code: ERROR_CODES.REQUEST_TOO_LARGE, message: `JSON body exceeds ${maxSize} bytes` };
    }

    const raw = new TextDecoder('utf8').decode(bytes);
    if (!raw.trim()) {
      return {};
    }

    try {
      return JSON.parse(raw);
    } catch (e) {
      throw { code: ERROR_CODES.INVALID_JSON, message: 'Invalid JSON payload' };
    }
  } catch (err) {
    if (err.code) throw err;
    throw { code: ERROR_CODES.INTERNAL_ERROR, message: `Request error: ${err.message}` };
  }
}

/* Parse raw webhook body with size limit - supports both Node and Cloudflare Workers
   Returns exact bytes without JSON reserialization for signature verification. */
export async function parseRawBody(req, maxSize = DEFAULT_LIMITS.maxRawWebhookSize) {
  if (isCloudflareRequest(req)) {
    return parseRawBodyCloudflare(req, maxSize);
  }
  return parseRawBodyNode(req, maxSize);
}

/* Node.js implementation - returns Buffer */
function parseRawBodyNode(req, maxSize) {
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

/* Cloudflare Workers implementation - returns Uint8Array (exact bytes) */
async function parseRawBodyCloudflare(req, maxSize) {
  try {
    // Clone to avoid consuming body - critical for not reading twice
    const clonedReq = req.clone();
    const arrayBuffer = await clonedReq.arrayBuffer();
    const bytes = new Uint8Array(arrayBuffer);

    if (bytes.length > maxSize) {
      throw { code: ERROR_CODES.REQUEST_TOO_LARGE, message: `Raw body exceeds ${maxSize} bytes` };
    }

    // Return Uint8Array directly - exact bytes preserved
    return bytes;
  } catch (err) {
    if (err.code) throw err;
    throw { code: ERROR_CODES.INTERNAL_ERROR, message: `Request error: ${err.message}` };
  }
}

/* Unified raw body to string helper - preserves exact bytes */
export function rawBodyToString(rawBody) {
  if (rawBody instanceof Uint8Array) {
    return new TextDecoder('utf8').decode(rawBody);
  }
  if (Buffer.isBuffer(rawBody)) {
    return rawBody.toString('utf8');
  }
  if (typeof rawBody === 'string') {
    return rawBody;
  }
  throw new Error('Unsupported raw body type');
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
  // Handle both Node.js and Cloudflare Workers response objects
  const setHeader = res.setHeader?.bind(res) || res.headers?.set?.bind(res.headers);
  const status = res.status || res.statusCode;

  if (setHeader) {
    setHeader('Content-Type', 'application/json');
    setHeader('Cache-Control', 'no-store');
    setHeader('X-Content-Type-Options', 'nosniff');
    if (correlationId) {
      setHeader('X-Correlation-Id', correlationId);
    }
  }
}

/* CORS headers from config */
export function setCorsHeaders(res, config) {
  if (!config.allowed_origins) return;

  const origins = config.allowed_origins.split(',').map(o => o.trim());
  const setHeader = res.setHeader || res.headers?.set?.bind(res.headers);

  if (setHeader) {
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Stripe-Signature, X-Correlation-Id');
  }
}

/* Handle preflight */
export function handlePreflight(req, res) {
  if (req.method === 'OPTIONS') {
    const setHeader = res.setHeader || res.headers?.set?.bind(res.headers);
    if (setHeader) {
      setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
      setHeader('Access-Control-Allow-Headers', 'Content-Type, Stripe-Signature, X-Correlation-Id');
    }
    if (res.status) {
      res.status(200).end();
    } else {
      res.statusCode = 200;
      res.end();
    }
    return true;
  }
  return false;
}

/* Middleware-style request validation */
export function createRequestValidator(opts = {}) {
  const limits = { ...DEFAULT_LIMITS, ...opts.limits };

  return async function validateRequest(req, res, next) {
    const correlationId = req.headers?.['x-correlation-id'] || req.headers?.['x-request-id'] || generateCorrelationId();
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

/* Generate correlation ID - works in both Node and Workers */
function generateCorrelationId() {
  const bytes = new Uint8Array(16);
  if (typeof crypto !== 'undefined' && crypto.getRandomValues) {
    crypto.getRandomValues(bytes);
  } else if (typeof require !== 'undefined') {
    // Node.js fallback
    const { randomBytes } = require('node:crypto');
    const nodeBytes = randomBytes(16);
    bytes.set(nodeBytes);
  } else {
    // Fallback - not cryptographically secure
    for (let i = 0; i < bytes.length; i++) {
      bytes[i] = Math.floor(Math.random() * 256);
    }
  }
  return `req-${Buffer.from(bytes).toString('base64url')}`;
}

/* Convert raw body to string for signature verification
   Handles both Node Buffer and Cloudflare Uint8Array */
export function toStringForSignature(rawBody) {
  return rawBodyToString(rawBody);
}