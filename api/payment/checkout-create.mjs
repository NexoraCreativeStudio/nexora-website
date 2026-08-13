/* Nexora — Stripe TEST Checkout Session Creation API (PROP.11)
   POST /api/payment/checkout
   Creates a Stripe Checkout Session for a validated payment token.
   TEST/SANDBOX only — no LIVE credentials, no real Stripe calls. */

import { createHash } from 'crypto';
import { StripeTestAdapter, buildCheckoutSessionRequest, normalizeStripeCheckoutSession } from '../../ops/payment/portal-session.mjs';
import { buildPaymentToken, checkTokenUsable, validatePaymentToken, TOKEN_EXAMPLE, markTokenUsed } from '../../ops/payment/token-model.mjs';
import { buildPortalSession, validatePortalSession, attachCheckoutSession, checkSessionValidForCheckout } from '../../ops/payment/portal-session.mjs';

const OPS_DIR = join(process.cwd(), 'ops');
const PAYMENT_DIR = join(OPS_DIR, 'payment');

/* Stripe TEST configuration (synthetic, no real keys) */
const STRIPE_TEST_CONFIG = {
  success_url: 'https://example.com/payment/success?session_id={CHECKOUT_SESSION_ID}',
  cancel_url: 'https://example.com/payment/cancel?canceled=true',
  production_activation_gate: false,
};

/* In production, sessions would be stored in a database.
   For TEST/SANDBOX, we use in-memory storage. */
const sessionStore = new Map();

function getTestInvoice(invoiceId) {
  const file = join(OPS_DIR, 'billing', 'examples', 'invoice-issued-example.json');
  const fs = await import('fs');
  if (fs.existsSync(file)) {
    const invoice = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (invoice.invoice_id === invoiceId) return invoice;
  }
  return null;
}

function getTestRequest(requestId) {
  const file = join(PAYMENT_DIR, 'examples', 'payment-request-example.json');
  const fs = await import('fs');
  if (fs.existsSync(file)) {
    const request = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (request.request_id === requestId) return request;
  }
  return null;
}

function lookupToken(tokenId) {
  if (tokenId === TOKEN_EXAMPLE.token_id) {
    return { token: TOKEN_EXAMPLE, source: 'example' };
  }
  if (/^PAT-[A-Za-z0-9_-]{43}$/.test(tokenId)) {
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

/* Create synthetic Stripe Checkout Session (TEST mode) */
function createTestCheckoutSession(checkoutRequest) {
  const sessionId = `cs_test_${createHash('sha256').update(`nexora-checkout:${checkoutRequest.metadata.nexora_payment_request_id}:${checkoutRequest.line_items[0].price_data.unit_amount}`).digest('hex').slice(0, 24)}`;
  return {
    id: sessionId,
    object: 'checkout.session',
    url: `https://checkout.stripe.com/pay/${sessionId}#fidkdWxOYHwnPyd1blpxYHZxWjA0Vl9kOWZFUlRiS05XU35mX2JzN2V8V0ZKYmh8Qkx8JzA%3D`,
    payment_status: 'unpaid',
    status: 'open',
    amount_total: checkoutRequest.line_items[0].price_data.unit_amount,
    currency: checkoutRequest.line_items[0].price_data.currency,
    metadata: checkoutRequest.metadata,
    success_url: checkoutRequest.success_url,
    cancel_url: checkoutRequest.cancel_url,
    expires_at: Math.floor(Date.now() / 1000) + 1800,
    livemode: false,
    client_reference_id: checkoutRequest.client_reference_id,
    _test_only: true,
    note: 'SYNTHETIC TEST-MODE REPRESENTATION — NOT A REAL STRIPE OBJECT',
  };
}

/* Main handler */
export default async function handler(req, res) {
  const { readFileSync, existsSync } = await import('fs');
  const { join } = await import('path');

  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') {
    return res.status(200).end();
  }

  if (req.method !== 'POST') {
    return res.status(405).json({ ok: false, error: 'Method not allowed' });
  }

  const body = req.body;
  if (!body || typeof body !== 'object') {
    return res.status(400).json({ ok: false, error: 'Request body required' });
  }

  const tokenId = body.token;
  if (!tokenId || !/^PAT-[A-Za-z0-9_-]{43}$/.test(tokenId)) {
    return res.status(400).json({ ok: false, error: 'Valid token required' });
  }

  try {
    // Lookup token
    const lookup = lookupToken(tokenId);
    if (!lookup) {
      return res.status(404).json({ ok: false, error: 'Token not found' });
    }

    const { token, source } = lookup;

    // Validate token
    const validation = validatePaymentToken(token, { requireExampleMarker: source === 'example' });
    if (validation.failures.length) {
      return res.status(400).json({ ok: false, error: 'Invalid token structure', failures: validation.failures });
    }

    // Get invoice and request
    const invoice = getTestInvoice(token.invoice_id);
    const request = getTestRequest(token.payment_request_id);

    if (!invoice || !request) {
      return res.status(404).json({ ok: false, error: 'Associated invoice or request not found' });
    }

    // Check token usability
    const usable = checkTokenUsable(token, invoice, request);
    if (!usable.ok) {
      if (usable.reasons.some(r => r.includes('VOID_INVOICE') || r.includes('CANCELLED_INVOICE'))) {
        return res.status(403).json({ ok: false, error: 'Invoice not payable', reasons: usable.reasons });
      }
      if (usable.reasons.some(r => r.includes('expired') || r.includes('used'))) {
        return res.status(410).json({ ok: false, error: 'Token expired or used', reasons: usable.reasons });
      }
      return res.status(400).json({ ok: false, error: 'Token not usable', reasons: usable.reasons });
    }

    // Build portal session
    const sessionResult = buildPortalSession({ token, paymentRequest: request, invoice, example: true });
    if (!sessionResult.ok) {
      return res.status(400).json({ ok: false, error: 'Failed to create portal session', reasons: sessionResult.reasons });
    }

    let portalSession = sessionResult.session;

    // Build Stripe Checkout Session request
    const checkoutRequest = buildCheckoutSessionRequest(request, portalSession, STRIPE_TEST_CONFIG);

    // Create synthetic Stripe Checkout Session (TEST mode)
    const stripeSession = createTestCheckoutSession(checkoutRequest);

    // Normalize and attach to portal session
    const normalized = normalizeStripeCheckoutSession(stripeSession);
    if (!normalized.ok) {
      return res.status(500).json({ ok: false, error: 'Failed to normalize checkout session', reasons: normalized.reasons });
    }

    const attached = attachCheckoutSession(portalSession, normalized.session);
    if (!attached.ok) {
      return res.status(500).json({ ok: false, error: 'Failed to attach checkout session', reasons: attached.reasons });
    }

    portalSession = attached.session;

    // Store session (in production, persist to database)
    sessionStore.set(portalSession.session_id, portalSession);

    // Mark token as used (single-use)
    const usedTokenResult = markTokenUsed(token);
    if (usedTokenResult.ok) {
      // In production, persist updated token
    }

    // Return checkout URL
    return res.status(200).json({
      ok: true,
      checkout_url: normalized.session.url,
      checkout_session_id: normalized.session.id,
      portal_session_id: portalSession.session_id,
      expires_at: normalized.session.expires_at,
      _test_only: true,
      note: 'TEST MODE — synthetic Stripe Checkout Session',
    });

  } catch (err) {
    console.error('Checkout creation error:', err);
    return res.status(500).json({ ok: false, error: 'Internal server error' });
  }
}

/* For local testing */
if (import.meta.url === `file://${process.argv[1]}`) {
  const testReq = { method: 'POST', body: { token: TOKEN_EXAMPLE.token_id } };
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