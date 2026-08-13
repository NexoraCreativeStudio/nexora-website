/* Nexora — Stripe TEST Webhook Endpoint (PROP.12)
   POST /api/payment/webhook
   Handles Stripe webhook events, verifies signatures via governed verifier,
   normalizes to governed webhook record, triggers PROP.9 reconciliation.
   TEST/SANDBOX only — no LIVE credentials.
   Uses governed storage abstraction (runtime-storage.mjs) and webhook verifier (webhook-verifier.mjs). */

import { createHash } from 'crypto';
import { join } from 'path';
import { StripeTestAdapter, StripeAdapter, STRIPE_RECONCILIATION_EVENT_TYPES } from '../../ops/payment/stripe-adapter.mjs';
import {
  RECONCILIATION_SCHEMA,
  PAYMENT_SCHEMA,
  PAYMENT_STATUSES,
  applyPaymentEvent,
  applyReconciliation,
  TestPaymentAdapter,
  buildPaymentRecord
} from '../../ops/payment/payment-validation.mjs';
import { markWebhookReceived, markReconciled } from '../../ops/payment/portal-session.mjs';
import { createStorageAdapter } from '../../ops/payment/runtime-storage.mjs';
import { createWebhookVerifier } from '../../ops/payment/webhook-verifier.mjs';

const OPS_DIR = join(process.cwd(), 'ops');
const PAYMENT_DIR = join(OPS_DIR, 'payment');
const OUT_DIR = join(PAYMENT_DIR, 'out');

/* Governed storage adapter (TEST mode uses deterministic file storage) */
const storage = createStorageAdapter({ environment: 'TEST', config: { baseDir: join(PAYMENT_DIR, 'private', 'test-runtime') } });

/* Governed webhook verifier (TEST mode uses deterministic simulation) */
const verifier = createWebhookVerifier({ environment: 'TEST', config: {} });

/* Get raw body for signature verification */
async function getRawBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on('data', chunk => chunks.push(chunk));
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

/* Trigger PROP.9 reconciliation */
async function triggerReconciliation(webhookEvent, paymentRecord) {
  const { TestPaymentAdapter } = await import('../../ops/payment/payment-validation.mjs');

  const adapter = new TestPaymentAdapter();
  const result = adapter.reconcilePayment(webhookEvent, {
    invoice: { invoice_id: webhookEvent.invoice_id, amount_requested: webhookEvent.amount, currency: webhookEvent.currency },
    request: { request_id: webhookEvent.payment_request_id, amount_requested: webhookEvent.amount, currency: webhookEvent.currency },
    seenEventIds: new Set()
  });

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

    // Verify signature via governed webhook verifier
    const sigResult = await verifier.verify(rawBody.toString('utf8'), signatureHeader, 'whsec_test');
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

    // Find portal session via governed storage
    let portalSession = null;
    if (webhookEvent.normalized_evidence?.provider_ref) {
      portalSession = await storage.findSessionByCheckoutSessionId(webhookEvent.normalized_evidence.provider_ref);
    }

    // Find or create payment record via governed storage
    let paymentRecord = await storage.findPaymentByRequestId(webhookEvent.payment_request_id);

    if (!paymentRecord) {
      // Build payment record from governed payment request
      const paymentBuild = buildPaymentRecord(
        { request_id: webhookEvent.payment_request_id, invoice_id: webhookEvent.invoice_id, amount_requested: webhookEvent.amount, currency: webhookEvent.currency, environment: 'TEST' },
        { example: true, createdAt: new Date().toISOString() }
      );
      if (!paymentBuild.ok) {
        return res.status(500).json({ ok: false, error: 'Failed to build payment record', reasons: paymentBuild.reasons });
      }
      paymentRecord = paymentBuild.payment;
      await storage.createPayment(paymentRecord);
    }

    // Check idempotency
    const idemCheck = await storage.checkIdempotency(webhookEvent.idempotency_key);
    if (idemCheck.exists) {
      console.log('Duplicate webhook event detected (idempotency):', webhookEvent.idempotency_key);
      return res.status(200).json({ ok: true, received: true, duplicate: true, event_id: webhookEvent.event_id });
    }

    // Apply webhook event to payment record (evidence recording)
    const eventResult = applyPaymentEvent(paymentRecord, webhookEvent);
    if (!eventResult.ok) {
      console.error('Failed to apply webhook event:', eventResult.reasons);
      return res.status(400).json({ ok: false, error: 'Failed to record webhook evidence', reasons: eventResult.reasons });
    }
    paymentRecord = eventResult.payment;
    await storage.updatePayment(paymentRecord);

    // Update portal session if found
    if (portalSession) {
      const webhookMarked = markWebhookReceived(portalSession, webhookEvent);
      if (webhookMarked.ok) {
        await storage.updateSession(webhookMarked.session);
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
          await storage.updatePayment(paymentRecord);

          // Update portal session to reconciled
          if (portalSession && (reconciliationResult.reconciliation.outcome === 'EXACT' || reconciliationResult.reconciliation.outcome === 'PARTIAL')) {
            const reconciled = markReconciled(portalSession, reconciliationResult.reconciliation);
            if (reconciled.ok) {
              await storage.updateSession(reconciled.session);
            }
          }
        }
      }
    }

    // Set idempotency key
    await storage.setIdempotency(webhookEvent.idempotency_key, webhookEvent.event_id);

    // Log processing result
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