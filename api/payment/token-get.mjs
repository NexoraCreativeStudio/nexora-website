/* Nexora — Payment Token Validation API (PROP.11)
   GET /api/payment/token/:token
   Validates a payment access token and returns associated invoice/request details.
   TEST/SANDBOX only — no LIVE credentials. */

import { readFileSync, existsSync } from 'fs';
import { join } from 'path';
import { validatePaymentToken, checkTokenUsable, TOKEN_EXAMPLE } from '../../ops/payment/token-model.mjs';
import { buildPaymentToken } from '../../ops/payment/token-model.mjs';

const OPS_DIR = join(process.cwd(), 'ops');
const PAYMENT_DIR = join(OPS_DIR, 'payment');
const BILLING_DIR = join(OPS_DIR, 'billing');
const BILLING_EXAMPLES_DIR = join(BILLING_DIR, 'examples');

/* In production, tokens would be stored in a secure database.
   For TEST/SANDBOX, we use deterministic fixtures. */
function getTestToken(tokenId) {
  if (tokenId === TOKEN_EXAMPLE.token_id) {
    return TOKEN_EXAMPLE;
  }
  return null;
}

function getTestInvoice(invoiceId) {
  const file = join(BILLING_EXAMPLES_DIR, 'invoice-issued-example.json');
  if (existsSync(file)) {
    const invoice = JSON.parse(readFileSync(file, 'utf8'));
    if (invoice.invoice_id === invoiceId) return invoice;
  }
  return null;
}

function getTestRequest(requestId) {
  const file = join(BILLING_EXAMPLES_DIR, '..', '..', 'payment', 'examples', 'payment-request-example.json');
  const fullPath = join(PAYMENT_DIR, 'examples', 'payment-request-example.json');
  if (existsSync(fullPath)) {
    const request = JSON.parse(readFileSync(fullPath, 'utf8'));
    if (request.request_id === requestId) return request;
  }
  return null;
}

/* Simulate token lookup (TEST mode) */
function lookupToken(tokenId) {
  // Try example fixture first
  const exampleToken = getTestToken(tokenId);
  if (exampleToken) return { token: exampleToken, source: 'example' };

  // In production, look up from secure storage
  // For TEST, derive deterministic token if it matches pattern
  if (/^PAT-[A-Za-z0-9_-]{43}$/.test(tokenId)) {
    // Check if it matches our derived test token
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

/* Main handler */
export default async function handler(req, res) {
  // CORS headers for browser access
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') {
    return res.status(200).end();
  }

  if (req.method !== 'GET') {
    return res.status(405).json({ ok: false, error: 'Method not allowed' });
  }

  const tokenId = req.query.token || req.params?.token;

  if (!tokenId) {
    return res.status(400).json({ ok: false, error: 'Token parameter required' });
  }

  if (!/^PAT-[A-Za-z0-9_-]{43}$/.test(tokenId)) {
    return res.status(400).json({ ok: false, error: 'Invalid token format' });
  }

  try {
    const lookup = lookupToken(tokenId);

    if (!lookup) {
      return res.status(404).json({ ok: false, error: 'Token not found' });
    }

    const { token, source } = lookup;

    // Validate token structure
    const validation = validatePaymentToken(token, { requireExampleMarker: source === 'example' });
    if (validation.failures.length) {
      return res.status(400).json({ ok: false, error: 'Invalid token structure', failures: validation.failures });
    }

    // Get associated invoice and request
    const invoice = getTestInvoice(token.invoice_id);
    const request = getTestRequest(token.payment_request_id);

    if (!invoice || !request) {
      return res.status(404).json({ ok: false, error: 'Associated invoice or request not found' });
    }

    // Check if token is usable
    const usable = checkTokenUsable(token, invoice, request);

    if (!usable.ok) {
      // Determine appropriate status code
      if (usable.reasons.some(r => r.includes('VOID_INVOICE') || r.includes('CANCELLED_INVOICE'))) {
        return res.status(403).json({ ok: false, error: 'Invoice not payable', reasons: usable.reasons });
      }
      if (usable.reasons.some(r => r.includes('expired'))) {
        return res.status(410).json({ ok: false, error: 'Token expired', reasons: usable.reasons });
      }
      if (usable.reasons.some(r => r.includes('used'))) {
        return res.status(410).json({ ok: false, error: 'Token already used', reasons: usable.reasons });
      }
      return res.status(400).json({ ok: false, error: 'Token not usable', reasons: usable.reasons });
    }

    // Return token details (safe subset)
    return res.status(200).json({
      ok: true,
      token: {
        token_id: token.token_id,
        invoice_id: token.invoice_id,
        invoice_number: token.invoice_number,
        payment_request_id: token.payment_request_id,
        amount: token.amount,
        currency: token.currency,
        status: token.status,
        created_at: token.created_at,
        expires_at: token.expires_at,
      },
      invoice: {
        invoice_id: invoice.invoice_id,
        invoice_number: invoice.invoice_number,
        status: invoice.status,
        total: invoice.total,
        currency: invoice.currency,
        due_date: invoice.due_date,
        line_items: invoice.line_items,
      },
      request: {
        request_id: request.request_id,
        amount_requested: request.amount_requested,
        currency: request.currency,
        environment: request.environment,
        description: request.description,
      },
    });

  } catch (err) {
    console.error('Token validation error:', err);
    return res.status(500).json({ ok: false, error: 'Internal server error' });
  }
}

/* For local testing */
if (import.meta.url === `file://${process.argv[1]}`) {
  const testReq = { method: 'GET', query: { token: TOKEN_EXAMPLE.token_id } };
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