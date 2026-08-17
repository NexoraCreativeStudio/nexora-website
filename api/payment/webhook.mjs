/* Nexora — Stripe Webhook Endpoint (PROP.14)
   POST /api/payment/webhook
   Deployment-ready: STAGING_TEST mode with TEST/SANDBOX webhooks.
   Raw body adapter for exact-byte signature verification,
   shared storage, structured logging, governed reconciliation,
   idempotency, environment gates. */

import { buildConfigFromEnv, validateDeploymentConfig, DEPLOYMENT_ENVIRONMENTS } from '../../ops/payment/deployment-config.mjs';
import { StripeTestAdapter, StripeAdapter, STRIPE_RECONCILIATION_EVENT_TYPES, STRIPE_PROVIDER_ID } from '../../ops/payment/stripe-adapter.mjs';
import {
  RECONCILIATION_SCHEMA,
  PAYMENT_SCHEMA,
  PAYMENT_STATUSES,
  applyPaymentEvent,
  applyReconciliation,
  TestPaymentAdapter,
  buildPaymentRecord
} from '../../ops/payment/payment-validation-core.mjs';
import { markWebhookReceived, markReconciled } from '../../ops/payment/portal-session.mjs';
import { createStorageAdapter } from '../../ops/payment/runtime-storage.mjs';
import { createBoundProductionStorageAdapter } from '../../ops/payment/shared-storage-binding.mjs';
import { createWebhookVerifier } from '../../ops/payment/webhook-verifier.mjs';
import { parseRawBody, rawBodyToString, setSafeResponseHeaders, handlePreflight, ERROR_CODES } from './request-limits.mjs';
import { sendErrorResponse } from './error-contract.mjs';
import { getDefaultLogger } from '../../ops/payment/structured-logging.mjs';
import { generateCorrelationId } from '../../ops/payment/structured-logging.mjs';

/* Trigger PROP.9 reconciliation */
async function triggerReconciliation(webhookEvent, paymentRecord) {
  const adapter = new TestPaymentAdapter();
  const result = adapter.reconcilePayment(webhookEvent, {
    invoice: { invoice_id: webhookEvent.invoice_id, amount_requested: webhookEvent.amount, currency: webhookEvent.currency },
    request: { request_id: webhookEvent.payment_request_id, amount_requested: webhookEvent.amount, currency: webhookEvent.currency },
    seenEventIds: new Set()
  });

  return result;
}

export default async function handler(req, res) {
  const correlationId = req.headers['x-correlation-id'] || req.headers['x-request-id'] || generateCorrelationId();
  req.correlationId = correlationId;

  // Safe headers
  setSafeResponseHeaders(res, correlationId);

  // Use config from request adapter (injected by worker)
  // In Workers: worker.mjs injects config via req.config
  // In local tests: handler is called directly without worker, so fall back to buildConfigFromEnv()
  const config = req.config || buildConfigFromEnv();

  // Request-scoped logger (injected by worker) with local test fallback
  const logger = req.logger || getDefaultLogger();

  // CORS from config
  const origins = config.allowed_origins ? config.allowed_origins.split(',').map(o => o.trim()) : [];
  const requestOrigin = req.headers.origin;
  if (requestOrigin && origins.includes(requestOrigin)) {
    res.setHeader('Access-Control-Allow-Origin', requestOrigin);
  }
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Stripe-Signature, X-Correlation-Id');

  if (handlePreflight(req, res)) return;

  // Validate deployment config
  const configValidation = validateDeploymentConfig(config);
  if (!configValidation.ok) {
    logger.logConfigValidation({
      correlationId,
      environment: config.environment,
      valid: false,
      reasons: configValidation.reasons,
    });
    return sendErrorResponse(res, ERROR_CODES.CONFIG_INVALID, correlationId, configValidation.reasons);
  }

  // STAGING_PAYMENT_ENABLED gate behavior (PROP.14/15):
  // - Blocks NEW checkout creation (handled in checkout-create.mjs)
  // - Does NOT block webhook processing for in-flight transactions
  // - Log gate state for observability
  if (config.environment === DEPLOYMENT_ENVIRONMENTS.STAGING_TEST && !config.staging_payment_enabled) {
    logger.logKillSwitch({
      correlationId,
      gate: 'STAGING_PAYMENT_ENABLED',
      enabled: false,
      action: 'webhook_allowed_in_flight',
    });
  }

  // Use pre-parsed raw body and verification from worker (Cloudflare Workers path)
  // or parse fresh for local/Node.js path
  let rawBody;
  let stripeEvent;
  let signatureVerified = false;

  if (req.signatureVerified && req.rawBody) {
    // Worker path: already parsed and verified
    rawBody = req.rawBody;
    stripeEvent = req.webhookEvent || req.body;
    signatureVerified = true;
  } else {
    // Local/Node path: parse fresh
    try {
      rawBody = await parseRawBody(req, config.max_raw_webhook_size);
    } catch (err) {
      return sendErrorResponse(res, err.code, correlationId);
    }

    const signatureHeader = req.headers['stripe-signature'] || req.headers['Stripe-Signature'];
    if (!signatureHeader) {
      logger.logWebhookSignatureMissing({ correlationId });
      return sendErrorResponse(res, ERROR_CODES.WEBHOOK_SIGNATURE_INVALID, correlationId);
    }

    // Parse JSON from raw body
    try {
      stripeEvent = JSON.parse(rawBodyToString(rawBody));
    } catch (e) {
      logger.logWebhookPayloadInvalid({ correlationId, error: e.message });
      return sendErrorResponse(res, ERROR_CODES.WEBHOOK_PAYLOAD_INVALID, correlationId);
    }

    // Verify signature via governed webhook verifier
    const verifier = createWebhookVerifier({ environment: config.environment, config });
    const sigResult = await verifier.verify(rawBodyToString(rawBody), signatureHeader, config.stripe_webhook_secret);
    if (!sigResult.verified) {
      logger.logWebhookSignatureInvalid({ correlationId, reason: sigResult.reason });
      return sendErrorResponse(res, ERROR_CODES.WEBHOOK_SIGNATURE_INVALID, correlationId);
    }
    signatureVerified = true;
  }

  // Ensure signature was verified
  if (!signatureVerified) {
    logger.logWebhookSignatureMissing({ correlationId });
    return sendErrorResponse(res, ERROR_CODES.WEBHOOK_SIGNATURE_INVALID, correlationId);
  }

  // Check event type is supported
  if (!STRIPE_RECONCILIATION_EVENT_TYPES.includes(stripeEvent.type)) {
    logger.logWebhookUnsupportedEvent({ correlationId, eventType: stripeEvent.type });
    return res.status(200).json({ ok: true, received: true, ignored: true, reason: 'Unsupported event type' });
  }

  // Normalize webhook event using StripeAdapter
  const stripeAdapter = config.environment === DEPLOYMENT_ENVIRONMENTS.LOCAL_TEST
    ? new StripeTestAdapter()
    : new StripeAdapter({ environment: config.stripe_mode === 'LIVE' ? 'PRODUCTION' : 'TEST' });

  const normalized = stripeAdapter.normalizeWebhookEvent(stripeEvent, { signatureVerified: true });
  if (!normalized.ok) {
    logger.logWebhookNormalizationFailed({ correlationId, reasons: normalized.reasons });
    return sendErrorResponse(res, ERROR_CODES.WEBHOOK_PAYLOAD_INVALID, correlationId, normalized.reasons);
  }

  const webhookEvent = normalized.event;
  webhookEvent.signature_verified = true;

  // Validate webhook contract
  if (webhookEvent.environment !== config.environment) {
    logger.logWebhookEnvironmentMismatch({ correlationId, expected: config.environment, actual: webhookEvent.environment });
    return sendErrorResponse(res, ERROR_CODES.WEBHOOK_ENVIRONMENT_MISMATCH, correlationId);
  }

  // Check for required metadata lineage
  if (!webhookEvent.payment_request_id || !webhookEvent.invoice_id) {
    logger.logWebhookMissingLineage({ correlationId });
    return sendErrorResponse(res, ERROR_CODES.WEBHOOK_MISSING_LINEAGE, correlationId);
  }

  try {
    // Get storage adapter
    let storage;
    if (config.environment === DEPLOYMENT_ENVIRONMENTS.LOCAL_TEST) {
      // LOCAL_TEST: lazy import Node-only path module and construct test path
      const { join } = await import('node:path');
      const baseDir = join(process.cwd(), 'ops', 'payment', 'private', 'test-runtime');
      storage = await createStorageAdapter({ environment: 'TEST', config: { baseDir } });
    } else {
      // STAGING_TEST / PRODUCTION_DISABLED: governed shared storage
      storage = createBoundProductionStorageAdapter(config);
    }

    // Find portal session via governed storage
    let portalSession = null;
    if (webhookEvent.normalized_evidence?.provider_ref) {
      portalSession = await storage.findSessionByCheckoutSessionId(webhookEvent.normalized_evidence.provider_ref);
    }

    // Find or create payment record
    let paymentRecord = await storage.findPaymentByRequestId(webhookEvent.payment_request_id);

    if (!paymentRecord) {
      const paymentBuild = buildPaymentRecord(
        { request_id: webhookEvent.payment_request_id, invoice_id: webhookEvent.invoice_id, amount_requested: webhookEvent.amount, currency: webhookEvent.currency, environment: config.environment },
        { example: config.environment === DEPLOYMENT_ENVIRONMENTS.LOCAL_TEST, createdAt: new Date().toISOString() }
      );
      if (!paymentBuild.ok) {
        return sendErrorResponse(res, ERROR_CODES.INTERNAL_ERROR, correlationId, paymentBuild.reasons);
      }
      paymentRecord = paymentBuild.payment;
      await storage.createPayment(paymentRecord);
    }

    // Check idempotency
    const idemCheck = await storage.checkIdempotency(webhookEvent.idempotency_key);
    if (idemCheck.exists) {
      logger.logWebhookDuplicate({ correlationId, idempotencyKey: webhookEvent.idempotency_key, eventId: webhookEvent.event_id });
      return res.status(200).json({ ok: true, received: true, duplicate: true, event_id: webhookEvent.event_id });
    }

    // Apply webhook event to payment record (evidence recording)
    const eventResult = applyPaymentEvent(paymentRecord, webhookEvent);
    if (!eventResult.ok) {
      logger.logWebhookApplicationFailed({ correlationId, reasons: eventResult.reasons });
      return sendErrorResponse(res, ERROR_CODES.INTERNAL_ERROR, correlationId, eventResult.reasons);
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
        const reconApplied = applyReconciliation(paymentRecord, reconciliationResult.reconciliation);
        if (reconApplied.ok) {
          paymentRecord = reconApplied.payment;
          await storage.updatePayment(paymentRecord);

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
    logger.logWebhookProcessed({
      correlationId,
      eventId: webhookEvent.event_id,
      eventType: webhookEvent.event_type,
      invoiceId: webhookEvent.invoice_id,
      paymentRequestId: webhookEvent.payment_request_id,
      amount: webhookEvent.amount,
      currency: webhookEvent.currency,
      paymentStatus: paymentRecord.status,
      reconciliationOutcome: reconciliationResult?.reconciliation?.outcome || 'N/A',
    });

    return res.status(200).json({
      ok: true,
      received: true,
      event_id: webhookEvent.event_id,
      payment_status: paymentRecord.status,
      reconciliation_outcome: reconciliationResult?.reconciliation?.outcome || null,
      environment: config.environment,
      stripe_mode: config.stripe_mode,
      _test_only: config.environment !== DEPLOYMENT_ENVIRONMENTS.PRODUCTION_DISABLED || config.stripe_mode !== 'LIVE',
    });

  } catch (err) {
    logger.logError({
      correlationId,
      error_code: 'WEBHOOK_PROCESSING_FAILED',
      message: err.message,
      context: 'webhook_endpoint',
    });

    return sendErrorResponse(res, ERROR_CODES.INTERNAL_ERROR, correlationId);
  }
}

/* For local testing */
if (import.meta.url === `file://${process.argv[1]}`) {
  const StripeTestAdapter = (await import('../../ops/payment/stripe-adapter.mjs')).StripeTestAdapter;
  const adapter = new StripeTestAdapter();

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