/* Nexora — Governed Payment Portal Session Model (PROP.11)
   Server-side session management for customer payment portal.
   Links payment access token → Stripe Checkout Session → reconciliation.
   TEST/SANDBOX only — no LIVE credentials. */

import { createHash } from 'node:crypto';
import { toMinorUnits, fromMinorUnits, deriveIdempotencyKey, buildStripeMetadata } from './stripe-adapter.mjs';
import { TOKEN_SCHEMA, TOKEN_ID_RE, checkTokenUsable, markTokenUsed, validatePaymentToken } from './token-model.mjs';
import { PAYMENT_REQUEST_SCHEMA, PAYMENT_SCHEMA, RECONCILIATION_SCHEMA, PAYMENT_STATUSES, PAYMENT_ENVIRONMENTS, PROVIDER_IDS, buildPaymentRecord, buildWebhookFingerprint } from './payment-validation-core.mjs';

export const PORTAL_SESSION_SCHEMA = 'nexora-portal-session/v1';
export const PORTAL_SESSION_ID_RE = /^PSS-[A-Za-z0-9_-]{43}$/; /* 256-bit entropy, URL-safe base64 */
export const PORTAL_SESSION_STATUS = ['CREATED', 'CHECKOUT_CREATED', 'CUSTOMER_REDIRECTED', 'WEBHOOK_RECEIVED', 'RECONCILED', 'EXPIRED', 'FAILED'];

/* Session time-to-live in seconds (30 minutes for checkout session) */
export const DEFAULT_SESSION_TTL_SECONDS = 30 * 60;

/* Generate a cryptographically random portal session ID */
export function generatePortalSessionId() {
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  return 'PSS-' + Buffer.from(bytes).toString('base64url');
}

/* Derive deterministic portal session ID for testing */
export function deriveTestPortalSessionId(tokenId, salt = 'test') {
  return 'PSS-' + createHash('sha256')
    .update(`nexora-pss:${salt}:${tokenId}`)
    .digest('base64url')
    .slice(0, 43);
}

/* Build a governed portal session record */
export function buildPortalSession(opts = {}) {
  const reasons = [];
  const { token, paymentRequest, invoice, ttlSeconds = DEFAULT_SESSION_TTL_SECONDS, example = false } = opts;

  if (!token || typeof token !== 'object') reasons.push('payment token required');
  if (!paymentRequest || typeof paymentRequest !== 'object') reasons.push('payment request required');
  if (!invoice || typeof invoice !== 'object') reasons.push('invoice required');

  const tokenValidation = validatePaymentToken(token, { requireExampleMarker: false });
  if (tokenValidation.failures.length) reasons.push(...tokenValidation.failures);

  const usable = checkTokenUsable(token, invoice, paymentRequest);
  if (!usable.ok) reasons.push(...usable.reasons);

  if (reasons.length) return { ok: false, reasons };

  const now = new Date();
  const createdAt = opts.createdAt || now.toISOString();
  const expiresAt = new Date(now.getTime() + ttlSeconds * 1000).toISOString();

  const sessionId = opts.sessionId || (example ? deriveTestPortalSessionId(token.token_id, 'example') : generatePortalSessionId());

  const record = {
    schema: PORTAL_SESSION_SCHEMA,
    session_id: sessionId,
    token_id: token.token_id,
    invoice_id: invoice.invoice_id,
    invoice_number: invoice.invoice_number,
    payment_request_id: paymentRequest.request_id,
    amount: paymentRequest.amount_requested,
    currency: paymentRequest.currency,
    status: 'CREATED',
    stripe_checkout_session_id: null,
    stripe_checkout_session_url: null,
    stripe_checkout_session_expires_at: null,
    created_at: createdAt,
    expires_at: expiresAt,
    completed_at: null,
    failed_at: null,
    failure_reason: null,
    audit_events: [
      { event: 'portal_session_created', at: createdAt, event_id: createHash('sha256').update(`nexora-pss:${sessionId}:${createdAt}`).digest('hex').slice(0, 16), detail: `Payment portal session created for ${token.token_id}` }
    ],
    _example: example === true ? true : undefined
  };
  if (record._example === undefined) delete record._example;

  return { ok: true, session: record };
}

/* Validate portal session structure */
export function validatePortalSession(session, opts = {}) {
  const reasons = [];
  if (!session || typeof session !== 'object') return { failures: ['session must be an object'], checks: [] };
  if (opts.requireExampleMarker !== false && session._example !== true) reasons.push('_example: fixture must be marked "_example": true — real sessions belong in ops/payment/private/, never committed');
  if (session.schema !== PORTAL_SESSION_SCHEMA) reasons.push(`schema must be ${PORTAL_SESSION_SCHEMA}`);
  if (typeof session.session_id !== 'string' || !PORTAL_SESSION_ID_RE.test(session.session_id)) reasons.push(`session_id must match ${PORTAL_SESSION_ID_RE}`);
  if (typeof session.token_id !== 'string' || !TOKEN_ID_RE.test(session.token_id)) reasons.push(`token_id must match ${TOKEN_ID_RE}`);
  if (typeof session.invoice_id !== 'string' || !/^INV-\d{4}-\d{4}-\d{3}$/.test(session.invoice_id)) reasons.push('invoice_id required');
  if (typeof session.payment_request_id !== 'string' || !/^REQ-\d{4}-\d{4}-\d{3}$/.test(session.payment_request_id)) reasons.push('payment_request_id required');
  if (typeof session.amount !== 'number' || session.amount <= 0) reasons.push('amount must be positive');
  if (session.currency !== 'GBP') reasons.push('currency must be GBP');
  if (!PORTAL_SESSION_STATUS.includes(session.status)) reasons.push(`status must be one of ${PORTAL_SESSION_STATUS.join(', ')}`);
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/.test(session.created_at || '')) reasons.push('created_at ISO datetime required');
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/.test(session.expires_at || '')) reasons.push('expires_at ISO datetime required');
  return { failures: reasons, checks: [] };
}

/* Update session with Stripe Checkout Session details */
export function attachCheckoutSession(session, stripeCheckoutSession, opts = {}) {
  if (!stripeCheckoutSession || !stripeCheckoutSession.id || !stripeCheckoutSession.url) {
    return { ok: false, reasons: ['stripeCheckoutSession must have id and url'] };
  }
  if (session.status !== 'CREATED' && session.status !== 'CHECKOUT_CREATED') {
    return { ok: false, reasons: [`cannot attach checkout session in ${session.status} state`] };
  }

  const next = JSON.parse(JSON.stringify(session));
  next.status = 'CHECKOUT_CREATED';
  next.stripe_checkout_session_id = stripeCheckoutSession.id;
  next.stripe_checkout_session_url = stripeCheckoutSession.url;
  // Handle both Unix timestamp (seconds) and ISO string formats
  if (stripeCheckoutSession.expires_at) {
    const expiresMs = typeof stripeCheckoutSession.expires_at === 'number'
      ? stripeCheckoutSession.expires_at * 1000
      : new Date(stripeCheckoutSession.expires_at).getTime();
    next.stripe_checkout_session_expires_at = new Date(expiresMs).toISOString();
  } else {
    next.stripe_checkout_session_expires_at = null;
  }
  next.audit_events = [...(session.audit_events || []), { event: 'checkout_session_attached', at: new Date().toISOString(), event_id: createHash('sha256').update(`nexora-pss:${session.sessionId}:checkout:${Date.now()}`).digest('hex').slice(0, 16), detail: `Stripe Checkout Session ${stripeCheckoutSession.id} attached` }];
  return { ok: true, session: next };
}

/* Mark customer as redirected to Stripe Checkout */
export function markCustomerRedirected(session, opts = {}) {
  if (session.status !== 'CHECKOUT_CREATED') {
    return { ok: false, reasons: [`cannot mark redirected in ${session.status} state — must be CHECKOUT_CREATED`] };
  }

  const next = JSON.parse(JSON.stringify(session));
  next.status = 'CUSTOMER_REDIRECTED';
  next.audit_events = [...(session.audit_events || []), { event: 'customer_redirected', at: new Date().toISOString(), event_id: createHash('sha256').update(`nexora-pss:${session.sessionId}:redirect:${Date.now()}`).digest('hex').slice(0, 16), detail: 'Customer redirected to Stripe Checkout' }];
  return { ok: true, session: next };
}

/* Mark webhook received (does NOT mark paid) */
export function markWebhookReceived(session, webhookEvent, opts = {}) {
  if (!['CHECKOUT_CREATED', 'CUSTOMER_REDIRECTED'].includes(session.status)) {
    return { ok: false, reasons: [`cannot mark webhook received in ${session.status} state`] };
  }

  const next = JSON.parse(JSON.stringify(session));
  next.status = 'WEBHOOK_RECEIVED';
  next.audit_events = [...(session.audit_events || []), { event: 'webhook_received', at: new Date().toISOString(), event_id: createHash('sha256').update(`nexora-pss:${session.sessionId}:webhook:${Date.now()}`).digest('hex').slice(0, 16), detail: `Webhook ${webhookEvent.event_type} received — WEBHOOK RECEIVED != PAID. Awaiting reconciliation.` }];
  return { ok: true, session: next };
}

/* Mark session as reconciled (PAID through PROP.9) */
export function markReconciled(session, reconciliationResult, opts = {}) {
  if (session.status !== 'WEBHOOK_RECEIVED') {
    return { ok: false, reasons: [`cannot mark reconciled in ${session.status} state — must be WEBHOOK_RECEIVED`] };
  }
  if (!reconciliationResult || reconciliationResult.outcome !== 'EXACT' && reconciliationResult.outcome !== 'PARTIAL') {
    return { ok: false, reasons: ['reconciliation must be EXACT or PARTIAL to mark PAID'] };
  }

  const next = JSON.parse(JSON.stringify(session));
  next.status = 'RECONCILED';
  next.completed_at = opts.at || new Date().toISOString();
  next.audit_events = [...(session.audit_events || []), { event: 'session_reconciled', at: next.completed_at, event_id: createHash('sha256').update(`nexora-pss:${session.sessionId}:reconciled:${next.completed_at}`).digest('hex').slice(0, 16), detail: `Payment reconciled: ${reconciliationResult.outcome} — invoice marked PAID` }];
  return { ok: true, session: next };
}

/* Mark session as failed */
export function markFailed(session, reason, opts = {}) {
  if (['RECONCILED', 'EXPIRED', 'FAILED'].includes(session.status)) {
    return { ok: false, reasons: [`cannot mark failed in ${session.status} state`] };
  }

  const next = JSON.parse(JSON.stringify(session));
  next.status = 'FAILED';
  next.failed_at = opts.at || new Date().toISOString();
  next.failure_reason = reason;
  next.audit_events = [...(session.audit_events || []), { event: 'session_failed', at: next.failed_at, event_id: createHash('sha256').update(`nexora-pss:${session.sessionId}:failed:${next.failed_at}`).digest('hex').slice(0, 16), detail: `Session failed: ${reason}` }];
  return { ok: true, session: next };
}

/* Expire session */
export function expireSession(session) {
  if (session.status !== 'CREATED' && session.status !== 'CHECKOUT_CREATED') {
    return { ok: false, reasons: [`cannot expire session in ${session.status} state`] };
  }

  const next = JSON.parse(JSON.stringify(session));
  next.status = 'EXPIRED';
  next.audit_events = [...(session.audit_events || []), { event: 'session_expired', at: new Date().toISOString(), event_id: createHash('sha256').update(`nexora-pss:${session.sessionId}:expired`).digest('hex').slice(0, 16), detail: 'Portal session expired' }];
  return { ok: true, session: next };
}

/* Check if session is still valid for checkout */
export function checkSessionValidForCheckout(session, now = new Date()) {
  const reasons = [];

  // Allow CUSTOMER_REDIRECTED for idempotent redirect (user refreshes or clicks link again)
  if (!['CREATED', 'CHECKOUT_CREATED', 'CUSTOMER_REDIRECTED'].includes(session.status)) {
    reasons.push(`session status ${session.status} not valid for checkout`);
    return { ok: false, reasons };
  }

  if (new Date(session.expires_at) <= now) {
    reasons.push('session has expired');
    return { ok: false, reasons };
  }

  if (session.stripe_checkout_session_expires_at && new Date(session.stripe_checkout_session_expires_at) <= now) {
    reasons.push('Stripe Checkout Session has expired');
    return { ok: false, reasons };
  }

  return { ok: true, reasons: [] };
}

/* Session filename for storage */
export function sessionFilename(sessionId) {
  return `${sessionId}.portal-session.json`;
}

/* Example fixture */
export const PORTAL_SESSION_EXAMPLE = {
  schema: PORTAL_SESSION_SCHEMA,
  session_id: 'PSS-AAECAwQFBgcICQoLDA0ODxAREhMUFRYXGBkaGxwdHh8',
  token_id: 'PAT-AAECAwQFBgcICQoLDA0ODxAREhMUFRYXGBkaGxwdHh8',
  invoice_id: 'INV-2026-9898-001',
  invoice_number: 'NX-INV-2026-0001',
  payment_request_id: 'REQ-2026-9898-001',
  amount: 2040,
  currency: 'GBP',
  status: 'CREATED',
  stripe_checkout_session_id: null,
  stripe_checkout_session_url: null,
  stripe_checkout_session_expires_at: null,
  created_at: '2026-08-15T09:00:00.000Z',
  expires_at: '2027-12-31T09:30:00.000Z',
  completed_at: null,
  failed_at: null,
  failure_reason: null,
  audit_events: [
    { event: 'portal_session_created', at: '2026-08-15T09:00:00.000Z', event_id: 'example000000001', detail: 'Payment portal session created for PAT-AAECAwQFBgcICQoLDA0ODxAREhMUFRYXGBkaGxwdHh8' }
  ],
  _example: true
};

/* Build Stripe Checkout Session request from governed payment request (server-side) */
export function buildCheckoutSessionRequest(paymentRequest, portalSession, config) {
  if (paymentRequest.environment !== 'TEST' && paymentRequest.environment !== 'SANDBOX') {
    throw new Error('buildCheckoutSessionRequest only supports TEST/SANDBOX environment');
  }

  const amountMinor = toMinorUnits(paymentRequest.amount_requested, paymentRequest.currency);
  const metadata = buildStripeMetadata(paymentRequest);
  const idempotencyKey = deriveIdempotencyKey(paymentRequest.request_id, 'checkout');

  const successUrl = config.success_url || 'https://example.com/payment/success?session_id={CHECKOUT_SESSION_ID}';
  const cancelUrl = config.cancel_url || 'https://example.com/payment/cancel';

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

/* Normalize Stripe Checkout Session response to governed session update */
export function normalizeStripeCheckoutSession(stripeSession) {
  if (!stripeSession || !stripeSession.id || !stripeSession.url) {
    return { ok: false, reasons: ['Invalid Stripe Checkout Session response'] };
  }

  return {
    ok: true,
    session: {
      id: stripeSession.id,
      url: stripeSession.url,
      expires_at: stripeSession.expires_at ? new Date(stripeSession.expires_at * 1000).toISOString() : null,
      payment_status: stripeSession.payment_status,
      status: stripeSession.status,
      amount_total: stripeSession.amount_total,
      currency: stripeSession.currency?.toUpperCase(),
      livemode: stripeSession.livemode,
      metadata: stripeSession.metadata,
    }
  };
}