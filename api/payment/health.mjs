/* Nexora — Payment Health Endpoint (PROP.14)
   GET /api/payment/health
   Safe health check — no secret output, no provider connectivity test unless safe. */

import { buildConfigFromEnv } from '../../ops/payment/deployment-config.mjs';
import { getDefaultLogger } from '../../ops/payment/structured-logging.mjs';

const logger = getDefaultLogger();

/* Main handler */
export default async function handler(req, res) {
  const correlationId = req.headers['x-correlation-id'] || req.headers['x-request-id'] || generateCorrelationId();

  // Security headers
  res.setHeader('Content-Type', 'application/json');
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('X-Content-Type-Options', 'nosniff');

  // CORS
  const config = buildConfigFromEnv();
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
    const config = buildConfigFromEnv();

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

    logger.logHealthCheck({
      correlationId,
      status: 'healthy',
      checks,
    });

    return res.status(200).json({
      ok: true,
      status: 'healthy',
      environment: config.environment,
      deployment_id: config.deployment_id,
      release_sha: config.release_sha,
      timestamp: new Date().toISOString(),
      checks,
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
      status: 'unhealthy',
      error: { code: 'INTERNAL_ERROR', message: 'Health check failed', request_id: correlationId },
    });
  }
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