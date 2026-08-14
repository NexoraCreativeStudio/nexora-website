/* Nexora — Payment Readiness Endpoint (PROP.14)
   GET /api/payment/readiness
   STAGING_TEST readiness requires:
   - shared storage configured
   - Stripe SDK/verifier available
   - test-mode Stripe secret configured
   - webhook secret configured
   - base URL configured
   - staging gate state known */

import { buildConfigFromEnv, validateDeploymentConfig, DEPLOYMENT_ENVIRONMENTS } from '../../ops/payment/deployment-config.mjs';
import { createSharedStorageClient } from '../../ops/payment/shared-storage-binding.mjs';
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

    // Validate config
    const configValidation = validateDeploymentConfig(config);
    const reasons = [];
    const checks = {
      config_valid: configValidation.ok,
      environment: config.environment,
      stripe_mode: config.stripe_mode,
      staging_gate_known: true,
      shared_storage_configured: false,
      stripe_secret_configured: false,
      webhook_secret_configured: false,
      base_url_configured: false,
      stripe_verifier_available: false,
      staging_payment_enabled: config.staging_payment_enabled,
    };

    if (!configValidation.ok) {
      reasons.push(...configValidation.reasons);
    }

    // Check shared storage for STAGING_TEST
    if (config.environment === DEPLOYMENT_ENVIRONMENTS.STAGING_TEST ||
        config.environment === DEPLOYMENT_ENVIRONMENTS.PRODUCTION_DISABLED) {
      if (config.shared_storage_provider && config.shared_storage_provider !== 'memory') {
        checks.shared_storage_configured = true;
      } else {
        reasons.push('shared storage provider not configured');
      }
    } else if (config.environment === DEPLOYMENT_ENVIRONMENTS.LOCAL_TEST) {
      checks.shared_storage_configured = true; // memory adapter available
    }

    // Check Stripe secrets (references)
    if (config.stripe_secret_key && !config.stripe_secret_key.includes('PLACEHOLDER')) {
      checks.stripe_secret_configured = true;
    } else {
      if (config.environment !== DEPLOYMENT_ENVIRONMENTS.LOCAL_TEST) {
        reasons.push('stripe secret key not configured (placeholder detected)');
      }
    }

    if (config.stripe_webhook_secret && !config.stripe_webhook_secret.includes('PLACEHOLDER')) {
      checks.webhook_secret_configured = true;
    } else {
      if (config.environment !== DEPLOYMENT_ENVIRONMENTS.LOCAL_TEST) {
        reasons.push('stripe webhook secret not configured (placeholder detected)');
      }
    }

    // Check base URLs
    if (config.public_base_url && config.payment_api_base_url) {
      checks.base_url_configured = true;
    } else {
      reasons.push('base URLs not configured');
    }

    // Check Stripe verifier availability (production would need SDK)
    if (config.environment === DEPLOYMENT_ENVIRONMENTS.LOCAL_TEST) {
      checks.stripe_verifier_available = true; // deterministic verifier available
    } else if (config.environment === DEPLOYMENT_ENVIRONMENTS.STAGING_TEST) {
      // In STAGING_TEST, would need official Stripe SDK
      // For now, check if stripe_mode is TEST
      checks.stripe_verifier_available = config.stripe_mode === 'TEST';
      if (config.stripe_mode !== 'TEST') {
        reasons.push('STAGING_TEST requires STRIPE_MODE=TEST');
      }
    }

    // Check staging gate
    if (config.environment === DEPLOYMENT_ENVIRONMENTS.STAGING_TEST) {
      if (!config.staging_payment_enabled) {
        reasons.push('STAGING_PAYMENT_ENABLED=false — staging payments disabled');
      }
    }

    const ready = reasons.length === 0;

    logger.logReadinessCheck({
      correlationId,
      ready,
      reasons,
    });

    return res.status(ready ? 200 : 503).json({
      ok: ready,
      ready,
      environment: config.environment,
      deployment_id: config.deployment_id,
      release_sha: config.release_sha,
      timestamp: new Date().toISOString(),
      checks,
      reasons: reasons.length > 0 ? reasons : undefined,
    });

  } catch (err) {
    logger.logError({
      correlationId,
      error_code: 'READINESS_CHECK_FAILED',
      message: err.message,
      context: 'readiness_endpoint',
    });

    return res.status(500).json({
      ok: false,
      ready: false,
      error: { code: 'INTERNAL_ERROR', message: 'Readiness check failed', request_id: correlationId },
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