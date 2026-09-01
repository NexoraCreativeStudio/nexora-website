/* Nexora — Governed Payment Access Token Model (PROP.11)
   Opaque, high-entropy tokens for secure customer payment portal access.
   Tokens link to exactly one governed payable invoice and fail closed. */

import { createHash } from 'node:crypto';

export const TOKEN_SCHEMA = 'nexora-payment-token/v1';
export const TOKEN_ID_RE = /^PAT-[A-Za-z0-9_-]{43}$/; /* 256-bit entropy, URL-safe base64 */
export const TOKEN_STATUS = ['ACTIVE', 'USED', 'EXPIRED', 'REVOKED', 'VOID_INVOICE', 'CANCELLED_INVOICE'];

/* Token time-to-live in seconds (7 days default for payment window) */
export const DEFAULT_TOKEN_TTL_SECONDS = 7 * 24 * 60 * 60;

/* Generate a cryptographically random token ID (256 bits = 43 chars URL-safe base64) */
export function generateTokenId() {
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  return 'PAT-' + Buffer.from(bytes).toString('base64url');
}

/* Derive a deterministic token ID for testing (NOT for production use) */
export function deriveTestTokenId(invoiceId, requestId, salt = 'test') {
  return 'PAT-' + createHash('sha256')
    .update(`nexora-pat:${salt}:${invoiceId}:${requestId}`)
    .digest('base64url')
    .slice(0, 43);
}

/* Build a governed payment access token record */
export function buildPaymentToken(opts = {}) {
  const reasons = [];
  const { invoice, request, ttlSeconds = DEFAULT_TOKEN_TTL_SECONDS, example = false } = opts;

  if (!invoice || typeof invoice !== 'object') reasons.push('invoice required');
  if (!request || typeof request !== 'object') reasons.push('payment request required');
  if (invoice.status !== 'ISSUED') reasons.push(`invoice must be ISSUED — got ${invoice.status}`);
  if (request.invoice_id !== invoice.invoice_id) reasons.push('request invoice_id must match invoice');

  if (reasons.length) return { ok: false, reasons };

  const now = new Date();
  const createdAt = opts.createdAt || now.toISOString();
  const expiresAt = new Date(now.getTime() + ttlSeconds * 1000).toISOString();

  const tokenId = opts.tokenId || (example ? deriveTestTokenId(invoice.invoice_id, request.request_id, 'example') : generateTokenId());

  const record = {
    schema: TOKEN_SCHEMA,
    token_id: tokenId,
    invoice_id: invoice.invoice_id,
    invoice_number: invoice.invoice_number,
    payment_request_id: request.request_id,
    amount: request.amount_requested,
    currency: request.currency,
    status: 'ACTIVE',
    created_at: createdAt,
    expires_at: expiresAt,
    used_at: null,
    revoked_at: null,
    revoked_reason: null,
    audit_events: [
      { event: 'token_created', at: createdAt, event_id: createHash('sha256').update(`nexora-pat:${tokenId}:${createdAt}`).digest('hex').slice(0, 16), detail: `Payment access token created for ${invoice.invoice_id}` }
    ],
    _example: example === true ? true : undefined
  };
  if (record._example === undefined) delete record._example;

  return { ok: true, token: record };
}

/* Validate token structure */
export function validatePaymentToken(token, opts = {}) {
  const reasons = [];
  if (!token || typeof token !== 'object') return { failures: ['token must be an object'], checks: [] };
  if (opts.requireExampleMarker !== false && token._example !== true) reasons.push('_example: fixture must be marked "_example": true — real tokens belong in ops/payment/private/, never committed');
  if (token.schema !== TOKEN_SCHEMA) reasons.push(`schema must be ${TOKEN_SCHEMA}`);
  if (typeof token.token_id !== 'string' || !TOKEN_ID_RE.test(token.token_id)) reasons.push(`token_id must match ${TOKEN_ID_RE}`);
  if (typeof token.invoice_id !== 'string' || !/^INV-\d{4}-\d{4}-\d{3}$/.test(token.invoice_id)) reasons.push('invoice_id required');
  if (typeof token.payment_request_id !== 'string' || !/^REQ-\d{4}-\d{4}-\d{3}$/.test(token.payment_request_id)) reasons.push('payment_request_id required');
  if (typeof token.amount !== 'number' || token.amount <= 0) reasons.push('amount must be positive');
  if (token.currency !== 'GBP') reasons.push('currency must be GBP');
  if (!TOKEN_STATUS.includes(token.status)) reasons.push(`status must be one of ${TOKEN_STATUS.join(', ')}`);
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/.test(token.created_at || '')) reasons.push('created_at ISO datetime required');
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/.test(token.expires_at || '')) reasons.push('expires_at ISO datetime required');
  return { failures: reasons, checks: [] };
}

/* Check if token is valid for payment (not expired, not used, not revoked, invoice payable) */
export function checkTokenUsable(token, invoice, request, now = new Date()) {
  const reasons = [];

  if (token.status !== 'ACTIVE') {
    reasons.push(`token status ${token.status} is not ACTIVE`);
    return { ok: false, reasons };
  }

  if (new Date(token.expires_at) <= now) {
    reasons.push('token has expired');
    return { ok: false, reasons };
  }

  if (token.used_at) {
    reasons.push('token has already been used');
    return { ok: false, reasons };
  }

  if (!invoice || invoice.invoice_id !== token.invoice_id) {
    reasons.push('invoice mismatch');
    return { ok: false, reasons };
  }

  if (invoice.status === 'VOID') {
    reasons.push('invoice is VOID — payment not permitted');
    return { ok: false, reasons: reasons.map(r => `VOID_INVOICE: ${r}`) };
  }

  if (invoice.status === 'CANCELLED') {
    reasons.push('invoice is CANCELLED — payment not permitted');
    return { ok: false, reasons: reasons.map(r => `CANCELLED_INVOICE: ${r}`) };
  }

  if (invoice.status !== 'ISSUED') {
    reasons.push(`invoice status ${invoice.status} is not payable (must be ISSUED)`);
    return { ok: false, reasons };
  }

  if (!request || request.request_id !== token.payment_request_id) {
    reasons.push('payment request mismatch');
    return { ok: false, reasons };
  }

  if (request.amount_requested !== token.amount || request.currency !== token.currency) {
    reasons.push('amount/currency mismatch between token and request');
    return { ok: false, reasons };
  }

  return { ok: true, reasons: [] };
}

/* Mark token as used */
export function markTokenUsed(token, opts = {}) {
  if (token.status !== 'ACTIVE') return { ok: false, reasons: ['only ACTIVE tokens can be marked used'] };
  const next = JSON.parse(JSON.stringify(token));
  next.status = 'USED';
  next.used_at = opts.at || new Date().toISOString();
  next.audit_events = [...(token.audit_events || []), { event: 'token_used', at: next.used_at, event_id: createHash('sha256').update(`nexora-pat:${token.token_id}:used:${next.used_at}`).digest('hex').slice(0, 16), detail: 'Payment access token used for checkout session' }];
  return { ok: true, token: next };
}

/* Revoke token */
export function revokeToken(token, reason, opts = {}) {
  if (['USED', 'REVOKED', 'EXPIRED', 'VOID_INVOICE', 'CANCELLED_INVOICE'].includes(token.status)) {
    return { ok: false, reasons: [`cannot revoke token in ${token.status} state`] };
  }
  const next = JSON.parse(JSON.stringify(token));
  next.status = 'REVOKED';
  next.revoked_at = opts.at || new Date().toISOString();
  next.revoked_reason = reason;
  next.audit_events = [...(token.audit_events || []), { event: 'token_revoked', at: next.revoked_at, event_id: createHash('sha256').update(`nexora-pat:${token.token_id}:revoked:${next.revoked_at}`).digest('hex').slice(0, 16), detail: `Token revoked: ${reason}` }];
  return { ok: true, token: next };
}

/* Expire token (called when checking expired tokens) */
export function expireToken(token) {
  if (token.status !== 'ACTIVE') return { ok: false, reasons: ['only ACTIVE tokens can be expired'] };
  const next = JSON.parse(JSON.stringify(token));
  next.status = 'EXPIRED';
  next.audit_events = [...(token.audit_events || []), { event: 'token_expired', at: new Date().toISOString(), event_id: createHash('sha256').update(`nexora-pat:${token.token_id}:expired`).digest('hex').slice(0, 16), detail: 'Token expired' }];
  return { ok: true, token: next };
}

/* Build token record for void invoice scenario */
export function markTokenVoidInvoice(token) {
  const next = JSON.parse(JSON.stringify(token));
  next.status = 'VOID_INVOICE';
  next.audit_events = [...(token.audit_events || []), { event: 'token_void_invoice', at: new Date().toISOString(), event_id: createHash('sha256').update(`nexora-pat:${token.token_id}:void`).digest('hex').slice(0, 16), detail: 'Invoice voided — token invalidated' }];
  return { ok: true, token: next };
}

/* Build token record for cancelled invoice scenario */
export function markTokenCancelledInvoice(token) {
  const next = JSON.parse(JSON.stringify(token));
  next.status = 'CANCELLED_INVOICE';
  next.audit_events = [...(token.audit_events || []), { event: 'token_cancelled_invoice', at: new Date().toISOString(), event_id: createHash('sha256').update(`nexora-pat:${token.token_id}:cancelled`).digest('hex').slice(0, 16), detail: 'Invoice cancelled — token invalidated' }];
  return { ok: true, token: next };
}

/* Token filename for storage */
export function tokenFilename(tokenId) {
  return `${tokenId}.payment-token.json`;
}

export const TOKEN_EXAMPLE = {
  schema: TOKEN_SCHEMA,
  token_id: 'PAT-AAECAwQFBgcICQoLDA0ODxAREhMUFRYXGBkaGxwdHh8',
  invoice_id: 'INV-2026-9898-001',
  invoice_number: 'NX-INV-2026-0001',
  payment_request_id: 'REQ-2026-9898-001',
  amount: 2040,
  currency: 'GBP',
  status: 'ACTIVE',
  created_at: '2026-08-15T09:00:00.000Z',
  expires_at: '2026-12-31T09:00:00.000Z',
  used_at: null,
  revoked_at: null,
  revoked_reason: null,
  audit_events: [
    { event: 'token_created', at: '2026-08-15T09:00:00.000Z', event_id: 'example000000001', detail: 'Payment access token created for INV-2026-9898-001' }
  ],
  _example: true
};