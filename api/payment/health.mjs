/* Nexora — Payment Health Endpoint (PROP.14/15)
   GET /api/payment/health
   Safe health check — no secret output, no provider connectivity test unless safe.
   Returns: runtime status, environment, deployment identity, kill switch states. */

import { buildConfigFromEnv, DEPLOYMENT_ENVIRONMENTS } from '../../ops/payment/deployment-config.mjs';
import { getDefaultLogger } from '../../ops/payment/structured-logging.mjs';

const logger = getDefaultLogger();

/* Deployment state model (PROP.15 §18-20) */
export const DEPLOYMENT_STATE = {
  /* Health: runtime is alive and config is parseable */
  HEALTHY: 'HEALTHY',
  UNHEALTHY: 'UNHEALTHY',

  /* Readiness: all dependencies configured and gates known */
  READY: 'READY',
  NOT_READY: 'NOT_READY',

  /* Collection-enabled: payments can be created (subset of READY) */
  COLLECTION_ENABLED: 'COLLECTION_ENABLED',
  COLLECTION_DISABLED: 'COLLECTION_DISABLED',
};

/* Main handler */
export default async function handler(req, res) {
  const correlationId = req.headers['x-correlation-id'] || req.headers['x-request-id'] || generateCorrelationId();

  // Security headers
  res.setHeader('Content-Type', 'application/json');
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('X-Content-Type-Options', 'nosniff');

  // Use config from request adapter (injected by worker)
  const config = req.config || buildConfigFromEnv();

  // CORS
  if (config.allowed_origins) {
    const origins = config.allowed_origins.split(',').map(o => o.trim());
    const requestOrigin = req.headers.origin;
    if (requestOrigin && origins.includes(requestOrigin)) {
      res.setHeader('Access-Control-Allow-Origin', requestOrigin);
    }
  }
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, X-Correlation-Id');

  if (req.method === 'OPTIONS') {
    return res.status(200).end();
  }

  if (req.method !== 'GET') {
    return res.status(405).json({
      error: { code: 'METHOD_NOT_ALLOWED', message: 'Method not allowed', request_id: correlationId }
    });
  }

  try {

    const checks = {
      runtime: 'alive',
      environment: config.environment,
      config_parseable: true,
      deployment_id: config.deployment_id,
      release_sha: config.release_sha,
      stripe_mode: config.stripe_mode,
      payments_enabled: config.payments_enabled,
      staging_payment_enabled: config.staging_payment_enabled,
      production_payment_enabled: config.production_payment_enabled,
    };

    // No secret output
    const safeConfig = { ...config };
    delete safeConfig.stripe_secret_key;
    delete safeConfig.stripe_webhook_secret;
    delete safeConfig.stripe_publishable_key;
    delete safeConfig.shared_storage_url;
    delete safeConfig.shared_storage_token;

    // Determine health status
    const healthy = checks.config_parseable && checks.runtime === 'alive';
    const status = healthy ? DEPLOYMENT_STATE.HEALTHY : DEPLOYMENT_STATE.UNHEALTHY;

    // Determine collection-enabled state
    const collectionEnabled = checkCollectionEnabled(config);

    logger.logHealthCheck({
      correlationId,
      status: status === DEPLOYMENT_STATE.HEALTHY ? 'healthy' : 'unhealthy',
      checks,
      collection_enabled: collectionEnabled,
    });

    return res.status(healthy ? 200 : 503).json({
      ok: healthy,
      status,
      environment: config.environment,
      deployment_id: config.deployment_id,
      release_sha: config.release_sha,
      timestamp: new Date().toISOString(),
      checks,
      collection_enabled: collectionEnabled,
      kill_switches: {
        payments_enabled: config.payments_enabled,
        staging_payment_enabled: config.staging_payment_enabled,
        production_payment_enabled: config.production_payment_enabled,
      },
    });

  } catch (err) {
    logger.logError({
      correlationId,
      error_code: 'HEALTH_CHECK_FAILED',
      message: err.message,
      context: 'health_endpoint',
    });

    return res.status(500).json({
      ok: false,
      status: DEPLOYMENT_STATE.UNHEALTHY,
      error: { code: 'INTERNAL_ERROR', message: 'Health check failed', request_id: correlationId },
      collection_enabled: DEPLOYMENT_STATE.COLLECTION_DISABLED,
    });
  }
}

/* Check if collection is enabled (payments can be created) */
function checkCollectionEnabled(config) {
  // Global kill switch
  if (!config.payments_enabled) {
    return DEPLOYMENT_STATE.COLLECTION_DISABLED;
  }

  // Environment-specific gates
  if (config.environment === DEPLOYMENT_ENVIRONMENTS.STAGING_TEST) {
    return config.staging_payment_enabled ? DEPLOYMENT_STATE.COLLECTION_ENABLED : DEPLOYMENT_STATE.COLLECTION_DISABLED;
  }

  if (config.environment === DEPLOYMENT_ENVIRONMENTS.PRODUCTION_DISABLED) {
    return config.production_payment_enabled ? DEPLOYMENT_STATE.COLLECTION_ENABLED : DEPLOYMENT_STATE.COLLECTION_DISABLED;
  }

  // LOCAL_TEST: collection enabled if payments_enabled
  return config.payments_enabled ? DEPLOYMENT_STATE.COLLECTION_ENABLED : DEPLOYMENT_STATE.COLLECTION_DISABLED;
}

/* Generate correlation ID */
function generateCorrelationId() {
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  return `req-${Buffer.from(bytes).toString('base64url')}`;
}

/* For local testing */
if (import.meta.url === `file://${process.argv[1]}`) {
  const testReq = { method: 'GET', headers: {} };
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