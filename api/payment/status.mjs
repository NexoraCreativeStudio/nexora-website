/* Nexora — Payment Status API (PROP.14)
   GET /api/payment/status/:session_id
   Deployment-ready: TEST/SANDBOX/STAGING_TEST modes.
   Safe error contract, structured logging, environment-aware storage,
   CORS from config, request limits. */

import { join } from 'path';
import { buildConfigFromEnv, validateDeploymentConfig, DEPLOYMENT_ENVIRONMENTS } from '../../ops/payment/deployment-config.mjs';
import { createStorageAdapter } from '../../ops/payment/runtime-storage.mjs';
import { createBoundProductionStorageAdapter } from '../../ops/payment/shared-storage-binding.mjs';
import { parseJsonBody, setSafeResponseHeaders, handlePreflight, validateSessionId, sendErrorResponse, ERROR_CODES, validateQueryParam } from './request-limits.mjs';
import { getDefaultLogger } from '../../ops/payment/structured-logging.mjs';
import { generateCorrelationId } from '../../ops/payment/structured-logging.mjs';

const OPS_DIR = join(process.cwd(), 'ops');
const PAYMENT_DIR = join(OPS_DIR, 'payment');

const logger = getDefaultLogger();

async function getPortalSession(storage, sessionId) {
  return await storage.getSession(sessionId);
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

  // CORS from config
  const origins = config.allowed_origins ? config.allowed_origins.split(',').map(o => o.trim()) : [];
  const requestOrigin = req.headers.origin;
  if (requestOrigin && origins.includes(requestOrigin)) {
    res.setHeader('Access-Control-Allow-Origin', requestOrigin);
  }
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, X-Correlation-Id');

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

  // Enforce STAGING_PAYMENT_ENABLED gate (read-only access allowed but session must exist)
  if (config.environment === DEPLOYMENT_ENVIRONMENTS.STAGING_TEST && !config.staging_payment_enabled) {
    logger.logKillSwitch({
      correlationId,
      gate: 'STAGING_PAYMENT_ENABLED',
      enabled: false,
      action: 'status_read',
    });
    // Allow read for existing sessions, but log gate state
  }

  // Validate session_id from query or path
  const sessionId = req.query.session_id || req.params?.session_id;
  const sessionValidation = validateSessionId(sessionId);
  if (!sessionValidation.ok) {
    return sendErrorResponse(res, sessionValidation.code, correlationId);
  }

  try {
    // Get storage adapter based on environment
    const storage = config.environment === DEPLOYMENT_ENVIRONMENTS.LOCAL_TEST
      ? createStorageAdapter({ environment: 'TEST', config: { baseDir: join(PAYMENT_DIR, 'private', 'test-runtime') } })
      : createBoundProductionStorageAdapter(config);

    const session = await getPortalSession(storage, sessionId);

    if (!session) {
      logger.logSessionNotFound({ correlationId, sessionId });
      return sendErrorResponse(res, ERROR_CODES.SESSION_NOT_FOUND, correlationId);
    }

    // Log status check
    logger.logStatusCheck({
      correlationId,
      sessionId: session.session_id,
      status: session.status,
      paymentRequestId: session.payment_request_id,
    });

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
      environment: config.environment,
      stripe_mode: config.stripe_mode,
      _test_only: config.environment !== DEPLOYMENT_ENVIRONMENTS.PRODUCTION_DISABLED || config.stripe_mode !== 'LIVE',
    });

  } catch (err) {
    logger.logError({
      correlationId,
      error_code: 'STATUS_CHECK_FAILED',
      message: err.message,
      context: 'status_endpoint',
    });

    return sendErrorResponse(res, ERROR_CODES.INTERNAL_ERROR, correlationId);
  }
}

/* For local testing */
if (import.meta.url === `file://${process.argv[1]}`) {
  const testReq = { method: 'GET', query: { session_id: 'PSS-dnqeauWAoxwvhUFCWsb-iKrBcR9sjCMlrtfY0EuFxss' }, headers: {}, params: {} };
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