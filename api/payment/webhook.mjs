/* Nexora — Stripe TEST Webhook Endpoint (PROP.11)
   POST /api/payment/webhook
   Handles Stripe webhook events, verifies signatures (TEST mode),
   normalizes to governed webhook record, triggers PROP.9 reconciliation.
   TEST/SANDBOX only — no LIVE credentials. */

import { createHash } from 'crypto';
import { StripeTestAdapter, normalizeStripeCheckoutSession } from '../../ops/payment/portal-session.mjs';
import { StripeAdapter } from '../../ops/payment/stripe-adapter.mjs';
import {
  normalizeWebhookEvent,
  verifyWebhookSignature,
  STRIPE_RECONCILIATION_EVENT_TYPES
} from '../../ops/payment/stripe-adapter.mjs';
import {
  validateWebhookContract,
  WEBHOOK_PROCESSING_RULES,
  SUPPORTED_PAYMENT_EVENT_TYPES,
  SUPPORTED_PAYOUT_EVENT_TYPES
} from '../../ops/payment/webhook-contract.mjs';
import {
  RECONCILIATION_SCHEMA,
  PAYMENT_SCHEMA,
  PAYMENT_STATUSES,
  applyPaymentEvent,
  applyReconciliation,
  TestPaymentAdapter,
  PaymentProviderAdapter,
  buildPaymentRecord,
  buildWebhookFingerprint,
  verifyWebhookFingerprint,
  sha256hex
} from '../../ops/payment/payment-validation.mjs';
import { buildPortalSession, validatePortalSession, markWebhookReceived, markReconciled, sessionStore } from '../../ops/payment/portal-session.mjs';

const OPS_DIR = join(process.cwd(), 'ops');
const PAYMENT_DIR = join(OPS_DIR, 'payment');
const OUT_DIR = join(PAYMENT_DIR, 'out');

/* In production, sessions and payments would be in a database.
   For TEST/SANDBOX, we use in-memory storage. */
const paymentStore = new Map();

/* TEST webhook secret (synthetic) */
const STRIPE_TEST_WEBHOOK_SECRET_REF = process.env.STRIPE_WEBHOOK_SECRET || null;

/* Get raw body for signature verification */
async function getRawBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on('data', chunk => chunks.push(chunk));
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

/* Simulate Stripe signature verification (TEST mode) */
function simulateTestSignatureVerification(rawPayload, signatureHeader) {
  // In TEST mode, we accept any signature that looks like a Stripe test signature
  // Real verification would use: stripe.webhooks.constructEvent(payload, sig, secret)
  if (signatureHeader && signatureHeader.startsWith('t=') && signatureHeader.includes('v1=')) {
    return { ok: true, verified: true, note: 'TEST MODE — signature verification simulated' };
  }
  return { ok: false, verified: false, reason: 'Invalid test signature format' };
}

/* Find portal session by Stripe Checkout Session ID */
function findPortalSessionByCheckoutSessionId(checkoutSessionId) {
  for (const [_, session] of sessionStore) {
    if (session.stripe_checkout_session_id === checkoutSessionId) {
      return session;
    }
  }
  return null;
}

/* Find payment record by payment request ID */
function findPaymentByRequestId(requestId) {
  for (const [_, payment] of paymentStore) {
    if (payment.payment_request_id === requestId) {
      return payment;
    }
  }
  return null;
}

/* Trigger PROP.9 reconciliation */
async function triggerReconciliation(webhookEvent, paymentRecord) {
  const { TestPaymentAdapter } = await import('../../ops/payment/payment-validation.mjs');

  const adapter = new TestPaymentAdapter();
  const result = adapter.reconcilePayment(paymentRecord, webhookEvent);

  return result;
}

/* Main handler */
export default async function handler(req, res) {
  const { readFileSync, existsSync, writeFileSync, mkdirSync } = await import('fs');
  const { join } = await import('path');

  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Stripe-Signature');

  if (req.method === 'OPTIONS') {
    return res.status(200).end();
  }

  if (req.method !== 'POST') {
    return res.status(405).json({ ok: false, error: 'Method not allowed' });
  }

  try {
    // Get raw body for signature verification
    const rawBody = await getRawBody(req);
    const signatureHeader = req.headers['stripe-signature'] || req.headers['Stripe-Signature'];

    // Parse JSON
    let stripeEvent;
    try {
      stripeEvent = JSON.parse(rawBody.toString('utf8'));
    } catch (e) {
      return res.status(400).json({ ok: false, error: 'Invalid JSON payload' });
    }

    // Verify signature (TEST mode simulation)
    const sigResult = simulateTestSignatureVerification(rawBody, signatureHeader);
    if (!sigResult.verified) {
      console.warn('Webhook signature verification failed:', sigResult.reason);
      return res.status(400).json({ ok: false, error: 'Webhook signature verification failed' });
    }

    // Check event type is supported
    if (!STRIPE_RECONCILIATION_EVENT_TYPES.includes(stripeEvent.type)) {
      console.log('Ignoring unsupported event type:', stripeEvent.type);
      return res.status(200).json({ ok: true, received: true, ignored: true, reason: 'Unsupported event type' });
    }

    // Normalize webhook event using StripeAdapter
    const stripeAdapter = new StripeTestAdapter();
    const normalized = stripeAdapter.normalizeWebhookEvent(stripeEvent, { signatureVerified: true });

    if (!normalized.ok) {
      console.error('Webhook normalization failed:', normalized.reasons);
      return res.status(400).json({ ok: false, error: 'Webhook normalization failed', reasons: normalized.reasons });
    }

    const webhookEvent = normalized.event;
    webhookEvent.signature_verified = true;

    // Validate webhook contract (TEST mode version)
    if (webhookEvent.environment !== 'TEST') {
      console.error('Environment mismatch:', webhookEvent.environment);
      return res.status(400).json({ ok: false, error: 'Environment mismatch' });
    }

    // Check for required metadata lineage
    if (!webhookEvent.payment_request_id || !webhookEvent.invoice_id) {
      console.error('Missing payment request or invoice ID in webhook metadata');
      return res.status(400).json({ ok: false, error: 'Missing lineage metadata' });
    }

    // Find portal session
    let portalSession = null;
    if (webhookEvent.normalized_evidence?.provider_ref) {
      portalSession = findPortalSessionByCheckoutSessionId(webhookEvent.normalized_evidence.provider_ref);
    }

    // Find or create payment record
    let paymentRecord = findPaymentByRequestId(webhookEvent.payment_request_id);

    if (!paymentRecord) {
      // Build payment record from governed payment request
      // In production, fetch from database
      paymentRecord = {
        schema: PAYMENT_SCHEMA,
        payment_id: `PAY-${createHash('sha256').update(`nexora-pay:${webhookEvent.payment_request_id}`).digest('hex').slice(0, 24)}`,
        payment_request_id: webhookEvent.payment_request_id,
        invoice_id: webhookEvent.invoice_id,
        provider: 'STRIPE',
        environment: 'TEST',
        status: 'PROCESSING',
        amount_expected: webhookEvent.amount,
        amount_received: 0,
        currency: webhookEvent.currency,
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
        evidence: [],
        audit_events: [
          { event: 'payment_created', at: new Date().toISOString(), event_id: createHash('sha256').update(`nexora-pay:${webhookEvent.payment_request_id}`).digest('hex').slice(0, 16), detail: 'Payment record created from webhook' }
        ],
      };
      paymentStore.set(paymentRecord.payment_id, paymentRecord);
    }

    // Apply webhook event to payment record (evidence recording)
    const eventResult = applyPaymentEvent(paymentRecord, webhookEvent);
    if (!eventResult.ok) {
      console.error('Failed to apply webhook event:', eventResult.reasons);
      return res.status(400).json({ ok: false, error: 'Failed to record webhook evidence', reasons: eventResult.reasons });
    }
    paymentRecord = eventResult.payment;

    // Update portal session if found
    if (portalSession) {
      const webhookMarked = markWebhookReceived(portalSession, webhookEvent);
      if (webhookMarked.ok) {
        sessionStore.set(portalSession.session_id, webhookMarked.session);
      }
    }

    // Trigger reconciliation for completed payments
    let reconciliationResult = null;
    if (['checkout.session.completed', 'payment_intent.succeeded'].includes(stripeEvent.type)) {
      reconciliationResult = await triggerReconciliation(webhookEvent, paymentRecord);

      if (reconciliationResult.ok && reconciliationResult.reconciliation) {
        // Apply reconciliation to payment record
        const reconApplied = applyReconciliation(paymentRecord, reconciliationResult.reconciliation);
        if (reconApplied.ok) {
          paymentRecord = reconApplied.payment;

          // Update portal session to reconciled
          if (portalSession && (reconciliationResult.reconciliation.outcome === 'EXACT' || reconciliationResult.reconciliation.outcome === 'PARTIAL')) {
            const reconciled = markReconciled(portalSession, reconciliationResult.reconciliation);
            if (reconciled.ok) {
              sessionStore.set(portalSession.session_id, reconciled.session);
            }
          }
        }
      }
    }

    // In production, persist paymentRecord and portalSession to database
    // For TEST, just log
    console.log('Webhook processed:', {
      event_id: webhookEvent.event_id,
      event_type: webhookEvent.event_type,
      invoice_id: webhookEvent.invoice_id,
      payment_request_id: webhookEvent.payment_request_id,
      amount: webhookEvent.amount,
      currency: webhookEvent.currency,
      payment_status: paymentRecord.status,
      reconciliation_outcome: reconciliationResult?.reconciliation?.outcome || 'N/A',
    });

    return res.status(200).json({
      ok: true,
      received: true,
      event_id: webhookEvent.event_id,
      payment_status: paymentRecord.status,
      reconciliation_outcome: reconciliationResult?.reconciliation?.outcome || null,
      _test_only: true,
    });

  } catch (err) {
    console.error('Webhook handler error:', err);
    return res.status(500).json({ ok: false, error: 'Internal server error' });
  }
}

/* For local testing */
if (import.meta.url === `file://${process.argv[1]}`) {
  // Simulate a test webhook event
  const StripeTestAdapter = (await import('../../ops/payment/stripe-adapter.mjs')).StripeTestAdapter;
  const adapter = new StripeTestAdapter();

  // Need a payment request
  const paymentRequest = {
    request_id: 'REQ-2026-9898-001',
    invoice_id: 'INV-2026-9898-001',
    invoice_version: '1.0',
    invoice_number: 'NX-INV-2026-0001',
    amount_requested: 2040,
    currency: 'GBP',
    environment: 'TEST',
  };

  const testEvent = adapter.makeTestWebhookEvent(paymentRequest, 'checkout.session.completed');
  console.log('Test webhook event:', JSON.stringify(testEvent, null, 2));
}