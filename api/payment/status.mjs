/* Nexora — Payment Status API (PROP.12)
   GET /api/payment/status/:session_id
   Returns the governed status of a payment portal session.
   Does NOT mark PAID on redirect — only PROP.9 reconciliation does.
   Uses governed storage abstraction (runtime-storage.mjs) for persistence. */

import { createHash } from 'crypto';
import { join } from 'path';
import { createStorageAdapter } from '../../ops/payment/runtime-storage.mjs';

const OPS_DIR = join(process.cwd(), 'ops');
const PAYMENT_DIR = join(OPS_DIR, 'payment');
const OUT_DIR = join(PAYMENT_DIR, 'out');

/* Governed storage adapter (TEST mode uses deterministic file storage) */
const storage = createStorageAdapter({ environment: 'TEST', config: { baseDir: join(PAYMENT_DIR, 'private', 'test-runtime') } });

async function getPortalSession(sessionId) {
  // Check governed storage
  return await storage.getSession(sessionId);
}

/* Main handler */
export default async function handler(req, res) {
  const { readFileSync, existsSync } = await import('fs');
  const { join } = await import('path');

  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') {
    return res.status(200).end();
  }

  if (req.method !== 'GET') {
    return res.status(405).json({ ok: false, error: 'Method not allowed' });
  }

  const sessionId = req.query.session_id || req.params?.session_id;

  if (!sessionId || !/^PSS-[A-Za-z0-9_-]{43}$/.test(sessionId)) {
    return res.status(400).json({ ok: false, error: 'Valid session_id required' });
  }

  try {
    const session = await getPortalSession(sessionId);

    if (!session) {
      return res.status(404).json({ ok: false, error: 'Session not found' });
    }

    // Return safe session status
    return res.status(200).json({
      ok: true,
      session: {
        session_id: session.session_id,
        token_id: session.token_id,
        invoice_id: session.invoice_id,
        invoice_number: session.invoice_number,
        payment_request_id: session.payment_request_id,
        amount: session.amount,
        currency: session.currency,
        status: session.status,
        stripe_checkout_session_id: session.stripe_checkout_session_id,
        created_at: session.created_at,
        expires_at: session.expires_at,
        completed_at: session.completed_at,
        failed_at: session.failed_at,
        failure_reason: session.failure_reason,
        audit_events: session.audit_events?.slice(-5), // Last 5 events
      },
      _test_only: true,
    });

  } catch (err) {
    console.error('Status endpoint error:', err);
    return res.status(500).json({ ok: false, error: 'Internal server error' });
  }
}

/* For local testing */
if (import.meta.url === `file://${process.argv[1]}`) {
  const testReq = { method: 'GET', query: { session_id: 'PSS-dnqeauWAoxwvhUFCWsb-iKrBcR9sjCMlrtfY0EuFxss' } };
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