/* Nexora — Payment Readiness Endpoint (PROP.14/15)
   GET /api/payment/readiness
   STAGING_TEST readiness requires:
   - shared storage configured (non-memory provider)
   - Stripe SDK/verifier available
   - test-mode Stripe secret configured (not placeholder)
   - webhook secret configured (not placeholder)
   - base URL configured
   - staging gate state known
   - Stripe API version pinned
   - Webhook tolerance configured
   - Idempotency TTL configured
   - Reconciliation tolerance configured

   Returns: READY/NOT_READY with detailed checks + COLLECTION_ENABLED/COLLECTION_DISABLED state */

import { validateDeploymentConfig, DEPLOYMENT_ENVIRONMENTS } from '../../ops/payment/deployment-config.mjs';
import { validateStripeConfig } from '../../ops/payment/stripe-test-boundaries.mjs';
import { createSharedStorageClient } from '../../ops/payment/shared-storage-binding.mjs';
import { getDefaultLogger } from '../../ops/payment/structured-logging.mjs';

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
  // In Workers: worker.mjs injects config via req.config
  // In local tests: handler is called directly without worker
  const config = req.config;

  // Request-scoped logger (injected by worker) with local test fallback
  const logger = req.logger || getDefaultLogger();

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
    // Handle observational config (from worker) - never throws, reports missing bindings
    // Fall back to strict validation for local testing
    const isObservational = config._observational === true;
    let configValidation = { ok: true, reasons: [] };
    let stripeValidation = { ok: true, reasons: [] };
    const reasons = [];
    const checks = {
      config_valid: true,
      stripe_config_valid: true,
      environment: config.environment,
      stripe_mode: config.stripe_mode,
      stripe_api_version: config.stripe_api_version,
      webhook_tolerance_seconds: config.webhook_tolerance_seconds,
      idempotency_ttl_seconds: config.idempotency_ttl_seconds,
      reconciliation_tolerance_pence: config.reconciliation_tolerance_pence,
      staging_gate_known: true,
      shared_storage_configured: false,
      shared_storage_provider: config.shared_storage_provider,
      stripe_secret_configured: false,
      webhook_secret_configured: false,
      base_url_configured: false,
      stripe_verifier_available: false,
      staging_payment_enabled: config.staging_payment_enabled,
      production_payment_enabled: config.production_payment_enabled,
      payments_enabled: config.payments_enabled,
    };

    if (isObservational) {
      // Observational mode: use _missing_bindings to determine readiness without throwing
      const missing = config._missing_bindings || {};

      // Check shared storage for STAGING_TEST and PRODUCTION_DISABLED
      if (config.environment === DEPLOYMENT_ENVIRONMENTS.STAGING_TEST ||
          config.environment === DEPLOYMENT_ENVIRONMENTS.PRODUCTION_DISABLED) {
        if (config.shared_storage_provider && config.shared_storage_provider !== 'memory') {
          checks.shared_storage_configured = true;
        } else {
          reasons.push('shared storage provider not configured (must be non-memory for STAGING_TEST/PRODUCTION_DISABLED)');
        }
      } else if (config.environment === DEPLOYMENT_ENVIRONMENTS.LOCAL_TEST) {
        checks.shared_storage_configured = true; // memory adapter available
      }

      // Check Stripe secrets (references - not placeholders)
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

      // Check Stripe verifier availability
      if (config.environment === DEPLOYMENT_ENVIRONMENTS.LOCAL_TEST) {
        checks.stripe_verifier_available = true; // deterministic verifier available
      } else if (config.environment === DEPLOYMENT_ENVIRONMENTS.STAGING_TEST) {
        checks.stripe_verifier_available = config.stripe_mode === 'TEST';
        if (config.stripe_mode !== 'TEST') {
          reasons.push('STAGING_TEST requires STRIPE_MODE=TEST');
        }
      } else if (config.environment === DEPLOYMENT_ENVIRONMENTS.PRODUCTION_DISABLED) {
        checks.stripe_verifier_available = config.stripe_mode === 'LIVE' || config.stripe_mode === 'TEST';
        if (config.stripe_mode === 'LIVE' && !config.production_payment_enabled) {
          reasons.push('PRODUCTION_DISABLED with STRIPE_MODE=LIVE requires PRODUCTION_PAYMENT_ENABLED=true');
        }
      }

      // Check staging gate
      if (config.environment === DEPLOYMENT_ENVIRONMENTS.STAGING_TEST) {
        if (!config.staging_payment_enabled) {
          reasons.push('STAGING_PAYMENT_ENABLED=false — staging payments disabled');
        }
      }

      // Check NEON_DATABASE_URL presence (observational only)
      if (config.environment !== DEPLOYMENT_ENVIRONMENTS.LOCAL_TEST) {
        if (missing.neon_database_url) {
          reasons.push('NEON_DATABASE_URL not configured');
        }
      }

      // Add missing bindings info to checks for visibility
      checks.missing_bindings = missing;
    } else {
      // Strict validation mode (local testing fallback)
      configValidation = validateDeploymentConfig(config);
      stripeValidation = validateStripeConfig(config);
      checks.config_valid = configValidation.ok;
      checks.stripe_config_valid = stripeValidation.ok;

      if (!configValidation.ok) {
        reasons.push(...configValidation.reasons);
      }
      if (!stripeValidation.ok) {
        reasons.push(...stripeValidation.reasons);
      }

      // Check shared storage for STAGING_TEST and PRODUCTION_DISABLED
      if (config.environment === DEPLOYMENT_ENVIRONMENTS.STAGING_TEST ||
          config.environment === DEPLOYMENT_ENVIRONMENTS.PRODUCTION_DISABLED) {
        if (config.shared_storage_provider && config.shared_storage_provider !== 'memory') {
          checks.shared_storage_configured = true;
        } else {
          reasons.push('shared storage provider not configured (must be non-memory for STAGING_TEST/PRODUCTION_DISABLED)');
        }
      } else if (config.environment === DEPLOYMENT_ENVIRONMENTS.LOCAL_TEST) {
        checks.shared_storage_configured = true; // memory adapter available
      }

      // Check Stripe secrets (references - not placeholders)
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

      // Check Stripe verifier availability
      if (config.environment === DEPLOYMENT_ENVIRONMENTS.LOCAL_TEST) {
        checks.stripe_verifier_available = true; // deterministic verifier available
      } else if (config.environment === DEPLOYMENT_ENVIRONMENTS.STAGING_TEST) {
        checks.stripe_verifier_available = config.stripe_mode === 'TEST';
        if (config.stripe_mode !== 'TEST') {
          reasons.push('STAGING_TEST requires STRIPE_MODE=TEST');
        }
      } else if (config.environment === DEPLOYMENT_ENVIRONMENTS.PRODUCTION_DISABLED) {
        checks.stripe_verifier_available = config.stripe_mode === 'LIVE' || config.stripe_mode === 'TEST';
        if (config.stripe_mode === 'LIVE' && !config.production_payment_enabled) {
          reasons.push('PRODUCTION_DISABLED with STRIPE_MODE=LIVE requires PRODUCTION_PAYMENT_ENABLED=true');
        }
      }

      // Check staging gate
      if (config.environment === DEPLOYMENT_ENVIRONMENTS.STAGING_TEST) {
        if (!config.staging_payment_enabled) {
          reasons.push('STAGING_PAYMENT_ENABLED=false — staging payments disabled');
        }
      }
    }

    const ready = reasons.length === 0;

    // Collection-enabled state (subset of readiness)
    const collectionEnabled = checkCollectionEnabled(config);

    logger.logReadinessCheck({
      correlationId,
      ready,
      reasons,
      collection_enabled: collectionEnabled,
    });

    const statusCode = ready ? 200 : 503;

    return res.status(statusCode).json({
      ok: ready,
      ready,
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
      reasons: reasons.length > 0 ? reasons : undefined,
      state: ready ? DEPLOYMENT_STATE.READY : DEPLOYMENT_STATE.NOT_READY,
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
      state: DEPLOYMENT_STATE.NOT_READY,
      collection_enabled: DEPLOYMENT_STATE.COLLECTION_DISABLED,
      error: { code: 'INTERNAL_ERROR', message: 'Readiness check failed', request_id: correlationId },
    });
  }
}

/* Check if collection is enabled (payments can be created) */
function checkCollectionEnabled(config) {
  // Global kill switch
  if (!config.payments_enabled) {
    return DEPLOYMENT_STATE.COLLECTION_DISABLED;
  }

  // Not ready means not collection-enabled
  if (!checkReadyInternal(config)) {
    return DEPLOYMENT_STATE.COLLECTION_DISABLED;
  }

  // Environment-specific gates
  if (config.environment === DEPLOYMENT_ENVIRONMENTS.STAGING_TEST) {
    return config.staging_payment_enabled ? DEPLOYMENT_STATE.COLLECTION_ENABLED : DEPLOYMENT_STATE.COLLECTION_DISABLED;
  }

  if (config.environment === DEPLOYMENT_ENVIRONMENTS.PRODUCTION_DISABLED) {
    return config.production_payment_enabled ? DEPLOYMENT_STATE.COLLECTION_ENABLED : DEPLOYMENT_STATE.COLLECTION_DISABLED;
  }

  // LOCAL_TEST: collection enabled if payments_enabled and ready
  return config.payments_enabled ? DEPLOYMENT_STATE.COLLECTION_ENABLED : DEPLOYMENT_STATE.COLLECTION_DISABLED;
}

/* Internal ready check (without logging) */
function checkReadyInternal(config) {
  const configValidation = validateDeploymentConfig(config);
  const stripeValidation = validateStripeConfig(config);
  if (!configValidation.ok || !stripeValidation.ok) return false;

  // Shared storage
  if (config.environment === DEPLOYMENT_ENVIRONMENTS.STAGING_TEST ||
      config.environment === DEPLOYMENT_ENVIRONMENTS.PRODUCTION_DISABLED) {
    if (!config.shared_storage_provider || config.shared_storage_provider === 'memory') return false;
  }

  // Stripe secrets
  if (config.environment !== DEPLOYMENT_ENVIRONMENTS.LOCAL_TEST) {
    if (config.stripe_secret_key?.includes('PLACEHOLDER')) return false;
    if (config.stripe_webhook_secret?.includes('PLACEHOLDER')) return false;
  }

  // Base URLs
  if (!config.public_base_url || !config.payment_api_base_url) return false;

  // Stripe verifier
  if (config.environment === DEPLOYMENT_ENVIRONMENTS.STAGING_TEST && config.stripe_mode !== 'TEST') return false;
  if (config.environment === DEPLOYMENT_ENVIRONMENTS.PRODUCTION_DISABLED && config.stripe_mode === 'LIVE' && !config.production_payment_enabled) return false;

  // Gates
  if (config.environment === DEPLOYMENT_ENVIRONMENTS.STAGING_TEST && !config.staging_payment_enabled) return false;

  return true;
}

/* Generate correlation ID */
function generateCorrelationId() {
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  return `req-${Buffer.from(bytes).toString('base64url')}`;
}

/* For local testing */
if (import.meta.url === `file://${process.argv[1]}`) {
  const testReq = {
    method: 'GET',
    headers: {},
    config: {
      environment: 'LOCAL_TEST',
      deployment_id: 'local-test',
      release_sha: 'local',
      payments_enabled: false,
      staging_payment_enabled: false,
      production_payment_enabled: false,
      stripe_mode: 'TEST',
      stripe_secret_key: 'sk_test_PLACEHOLDER_REPLACE_WITH_REAL_TEST_KEY',
      stripe_webhook_secret: 'whsec_PLACEHOLDER_REPLACE_WITH_REAL_TEST_SECRET',
      stripe_publishable_key: 'pk_test_PLACEHOLDER_REPLACE_WITH_REAL_TEST_KEY',
      stripe_api_version: '2024-06-20',
      webhook_tolerance_seconds: 300,
      idempotency_ttl_seconds: 86400,
      reconciliation_tolerance_pence: 0,
      shared_storage_provider: 'memory',
      shared_storage_namespace: 'nexora/payment/LOCAL_TEST',
      public_base_url: 'https://localhost:3000',
      payment_api_base_url: 'https://localhost:3000',
      allowed_origins: 'https://localhost:3000',
    }
  };
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