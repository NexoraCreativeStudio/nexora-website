/* Nexora — Payment Deployment Manifest (PROP.14)
   Machine-readable deployment manifest/schema for payment backend.
   No credentials — safe for deployment tracking and rollback. */

import { buildConfigFromEnv, DEPLOYMENT_ENVIRONMENTS } from './deployment-config.mjs';
import { generateCorrelationId } from './structured-logging.mjs';

export const DEPLOYMENT_MANIFEST_SCHEMA = 'nexora-payment-deployment-manifest/v1';

/* Generate deployment manifest from config */
export function generateDeploymentManifest(config) {
  const validated = typeof config === 'object' && config.schema === 'nexora-payment-deployment/v1'
    ? config
    : buildConfigFromEnv(config);

  const manifest = {
    schema: DEPLOYMENT_MANIFEST_SCHEMA,
    environment: validated.environment,
    deployment_id: validated.deployment_id,
    release_sha: validated.release_sha,
    runtime_mode: validated.environment,
    stripe_mode: validated.stripe_mode,
    storage_provider_ref: validated.shared_storage_provider,
    payments_enabled: validated.payments_enabled,
    staging_payment_enabled: validated.staging_payment_enabled,
    production_enabled: validated.production_payment_enabled,
    health_path: '/api/payment/health',
    readiness_path: '/api/payment/readiness',
    checkout_path: '/api/payment/checkout',
    status_path: '/api/payment/status',
    webhook_path: '/api/payment/webhook',
    token_path: '/api/payment/token',
    generated_at: new Date().toISOString(),
    generated_by: 'ops/payment/deployment-manifest.mjs',
    manifest_id: generateCorrelationId('manifest'),
  };

  // Add environment-specific fields
  if (validated.environment === DEPLOYMENT_ENVIRONMENTS.STAGING_TEST) {
    manifest.stripe_test_mode = true;
    manifest.webhook_expected_environment = 'TEST';
  }

  return manifest;
}

/* Validate deployment manifest */
export function validateDeploymentManifest(manifest) {
  const reasons = [];

  if (!manifest || typeof manifest !== 'object') {
    return { ok: false, reasons: ['manifest must be an object'] };
  }

  if (manifest.schema !== DEPLOYMENT_MANIFEST_SCHEMA) {
    reasons.push(`schema must be ${DEPLOYMENT_MANIFEST_SCHEMA}`);
  }

  if (!Object.values(DEPLOYMENT_ENVIRONMENTS).includes(manifest.environment)) {
    reasons.push(`invalid environment: ${manifest.environment}`);
  }

  if (!manifest.deployment_id || typeof manifest.deployment_id !== 'string') {
    reasons.push('deployment_id required');
  }

  if (!manifest.release_sha || typeof manifest.release_sha !== 'string') {
    reasons.push('release_sha required');
  }

  const requiredPaths = ['health_path', 'readiness_path', 'checkout_path', 'status_path', 'webhook_path'];
  for (const path of requiredPaths) {
    if (!manifest[path] || typeof manifest[path] !== 'string') {
      reasons.push(`missing required path: ${path}`);
    }
  }

  if (typeof manifest.payments_enabled !== 'boolean') {
    reasons.push('payments_enabled must be boolean');
  }

  if (typeof manifest.staging_payment_enabled !== 'boolean') {
    reasons.push('staging_payment_enabled must be boolean');
  }

  if (typeof manifest.production_enabled !== 'boolean') {
    reasons.push('production_enabled must be boolean');
  }

  return { ok: reasons.length === 0, reasons };
}

/* Rollback manifest — minimal info needed for rollback */
export function generateRollbackManifest(config) {
  const manifest = generateDeploymentManifest(config);

  return {
    schema: 'nexora-payment-rollback-manifest/v1',
    deployment_id: manifest.deployment_id,
    release_sha: manifest.release_sha,
    environment: manifest.environment,
    stripe_mode: manifest.stripe_mode,
    storage_provider_ref: manifest.storage_provider_ref,
    payments_enabled: manifest.payments_enabled,
    staging_payment_enabled: manifest.staging_payment_enabled,
    production_enabled: manifest.production_enabled,
    rollback_allowed: true, // PROP.14: no destructive migrations
    rollback_notes: 'Previous deployment selectable. Idempotency history preserved. Webhook endpoint processes retries.',
    generated_at: new Date().toISOString(),
    rollback_id: generateCorrelationId('rollback'),
  };
}

/* Validate rollback manifest */
export function validateRollbackManifest(manifest) {
  const reasons = [];

  if (!manifest || typeof manifest !== 'object') {
    return { ok: false, reasons: ['manifest must be an object'] };
  }

  if (manifest.schema !== 'nexora-payment-rollback-manifest/v1') {
    reasons.push('schema must be nexora-payment-rollback-manifest/v1');
  }

  if (!manifest.deployment_id) reasons.push('deployment_id required');
  if (!manifest.release_sha) reasons.push('release_sha required');
  if (!manifest.environment) reasons.push('environment required');

  return { ok: reasons.length === 0, reasons };
}

/* Rollback contract documentation */
export const ROLLBACK_CONTRACT = `
ROLLBACK CONTRACT (PROP.14):

1. PREVIOUS DEPLOYMENT SELECTABLE
   - Deployment infrastructure must support selecting previous deployment
   - No database destructive migration in PROP.14

2. IDEMPOTENCY HISTORY PRESERVED
   - Shared storage idempotency keys NOT cleared on rollback
   - Duplicate webhook events still detected correctly

3. WEBHOOK ENDPOINT PROCESSES RETRIES
   - Webhook endpoint remains accessible during rollback
   - In-flight Stripe webhook retries will be processed by either deployment

4. KILL SWITCH AVAILABLE
   - STAGING_PAYMENT_ENABLED=false blocks new checkout creation
   - Does not block webhook processing for existing transactions

5. NO AUTOMATED DESTRUCTIVE ROLLBACK
   - Rollback is manual operator decision
   - Deployment platform controls traffic routing
`;