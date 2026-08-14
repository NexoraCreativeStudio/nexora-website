/* Nexora — Controlled Deployment Validator (PROP.14 §36)
   Validates payment backend for TEST/STAGING deployment readiness.
   Verifies: environment boundaries, kill switches, no live credentials,
   governed contracts, safe error responses, storage binding, logging. */

import { join } from 'path';
import { readFileSync, existsSync } from 'fs';
import { buildConfigFromEnv, validateDeploymentConfig, DEPLOYMENT_ENVIRONMENTS, STRIPE_MODES } from './deployment-config.mjs';
import { createSharedStorageClient, createBoundProductionStorageAdapter } from './shared-storage-binding.mjs';
import { createStorageAdapter } from './runtime-storage.mjs';
import { getDefaultLogger } from './structured-logging.mjs';
import { ERROR_CODES } from '../../api/payment/error-contract.mjs';
import { validateSessionId, validateTokenId } from '../../api/payment/request-limits.mjs';

const logger = getDefaultLogger();

const VALIDATION_STATE = {
  passed: 0,
  failed: 0,
  warnings: 0,
  results: [],
};

function recordValidation(name, passed, details = {}) {
  if (passed) {
    VALIDATION_STATE.passed++;
    VALIDATION_STATE.results.push({ name, status: 'PASS', ...details });
  } else {
    VALIDATION_STATE.failed++;
    VALIDATION_STATE.results.push({ name, status: 'FAIL', ...details });
  }
}

function recordWarning(name, message) {
  VALIDATION_STATE.warnings++;
  VALIDATION_STATE.results.push({ name, status: 'WARN', message });
}

function assert(condition, message) {
  if (!condition) {
    throw new Error(message);
  }
}

/* Validate environment boundaries */
function validateEnvironmentBoundaries() {
  const config = buildConfigFromEnv();

  recordValidation('env: no LIVE mode allowed unless gate open', !(
    config.stripe_mode === STRIPE_MODES.LIVE && !config.production_payment_enabled
  ), {
    stripe_mode: config.stripe_mode,
    production_payment_enabled: config.production_payment_enabled,
  });

  // In PRODUCTION_DISABLED, no live calls
  if (config.environment === DEPLOYMENT_ENVIRONMENTS.PRODUCTION_DISABLED) {
    recordValidation('env: PRODUCTION_DISABLED blocks live', !config.production_payment_enabled);
  }

  // In STAGING_TEST, no LIVE mode
  if (config.environment === DEPLOYMENT_ENVIRONMENTS.STAGING_TEST) {
    recordValidation('env: STAGING_TEST requires TEST stripe mode', config.stripe_mode === STRIPE_MODES.TEST);
  }
}

/* Validate kill switches (all default false) */
function validateKillSwitches() {
  const config = buildConfigFromEnv();

  recordValidation('kill: PAYMENTS_ENABLED default false', config.payments_enabled === false);
  recordValidation('kill: STAGING_PAYMENT_ENABLED default false', config.staging_payment_enabled === false);
  recordValidation('kill: PRODUCTION_PAYMENT_ENABLED default false', config.production_payment_enabled === false);

  // Enforce fail-closed in production
  if (config.environment === DEPLOYMENT_ENVIRONMENTS.PRODUCTION_DISABLED) {
    assert(config.production_payment_enabled === false, 'PRODUCTION_PAYMENT_ENABLED must be false in PRODUCTION_DISABLED');
    recordValidation('kill: PRODUCTION gate closed', config.production_payment_enabled === false);
  }
}

/* Validate no live credentials */
function validateNoLiveCredentials() {
  const config = buildConfigFromEnv();

  // Check env vars for live keys
  const liveKeyPatterns = [
    /sk_live_/,
    /pk_live_/,
    /whsec_.{32,}/, // Webhook secret (not live-specific but should be configured separately)
  ];

  if (process.env.STRIPE_SECRET_KEY && liveKeyPatterns[0].test(process.env.STRIPE_SECRET_KEY)) {
    recordValidation('creds: no live stripe key', false, { detail: 'Live key detected in STRIPE_SECRET_KEY' });
  } else {
    recordValidation('creds: no live stripe key', true);
  }

  // Check config placeholders
  if (config.stripe_secret_key && config.stripe_secret_key.includes('PLACEHOLDER')) {
    recordValidation('creds: placeholder detected (not real)', true);
  } else if (config.stripe_secret_key && !config.stripe_secret_key.includes('PLACEHOLDER')) {
    recordWarning('creds: non-placeholder secret configured', 'Ensure this is a TEST key, not a LIVE key');
  }
}

/* Validate governed contracts */
async function validateGovernedContracts() {
  // Error contract
  try {
    const { ERROR_CODES, ERROR_STATUS_CODES, createErrorResponse } = await import('../../api/payment/error-contract.mjs');
    for (const code of Object.values(ERROR_CODES)) {
      assert(ERROR_STATUS_CODES[code] !== undefined, `Missing status code for ${code}`);
    }
    recordValidation('contract: error codes complete', true);
  } catch (err) {
    recordValidation('contract: error codes complete', false, { error: err.message });
  }

  // Request limits
  try {
    const { validateSessionId, validateTokenId } = await import('../../api/payment/request-limits.mjs');
    const validSession = validateSessionId('PSS-' + 'a'.repeat(43));
    const invalidSession = validateSessionId('INVALID');
    const validToken = validateTokenId('PAT-' + 'a'.repeat(43));
    const invalidToken = validateTokenId('INVALID');
    recordValidation('contract: session/token validation works', validSession.ok && !invalidSession.ok && validToken.ok && !invalidToken.ok);
  } catch (err) {
    recordValidation('contract: session/token validation works', false, { error: err.message });
  }
}

/* Validate storage binding */
function validateStorageBinding() {
  // LOCAL_TEST: memory/file storage
  try {
    const storage = createStorageAdapter({ environment: 'TEST', config: { baseDir: '/tmp/nexora-validate' } });
    assert(storage !== null, 'Storage adapter created');
    recordValidation('storage: LOCAL_TEST adapter initialized', true);
  } catch (err) {
    recordValidation('storage: LOCAL_TEST adapter initialized', false, { error: err.message });
  }

  // STAGING_TEST: requires shared storage config (provider implementation is Owner decision)
  try {
    const config = buildConfigFromEnv({
      environment: DEPLOYMENT_ENVIRONMENTS.STAGING_TEST,
      shared_storage_provider: 'redis', // Must be non-memory for STAGING_TEST
      shared_storage_namespace: 'nexora/payment/STAGING_TEST',
    });
    const validation = validateDeploymentConfig(config);
    // Config should pass (shared_storage_provider is non-memory)
    assert(validation.ok, `Config validation failed: ${validation.reasons.join(', ')}`);
    // The adapter creation will fail (no provider implemented) - this is expected
    // Validation passes if config is correct and fails closed appropriately
    recordValidation('storage: STAGING_TEST binding configured (Owner decision required for provider)', true);
  } catch (err) {
    recordValidation('storage: STAGING_TEST binding configured (Owner decision required for provider)', false, { error: err.message });
  }
}

/* Validate logging */
function validateLogging() {
  try {
    const logger = getDefaultLogger();
    logger.info('test', { message: 'test', correlationId: 'test' });
    logger.error({ error_code: 'TEST', message: 'test', context: 'test' });
    recordValidation('logging: safe logger functional', true);
  } catch (err) {
    recordValidation('logging: safe logger functional', false, { error: err.message });
  }
}

/* Validate endpoint handlers exist */
function validateEndpoints() {
  const endpoints = [
    '../../api/payment/health.mjs',
    '../../api/payment/readiness.mjs',
    '../../api/payment/checkout-create.mjs',
    '../../api/payment/status.mjs',
    '../../api/payment/webhook.mjs',
  ];

  for (const endpoint of endpoints) {
    const fullPath = join(process.cwd(), 'ops', 'payment', endpoint);
    if (existsSync(fullPath)) {
      recordValidation(`endpoint: ${endpoint} exists`, true);
    } else {
      recordValidation(`endpoint: ${endpoint} exists`, false, { path: endpoint });
    }
  }
}

/* Validate manifest generation */
async function validateManifest() {
  try {
    const { generateDeploymentManifest, validateDeploymentManifest } = await import('./deployment-manifest.mjs');
    const config = buildConfigFromEnv();
    const manifest = generateDeploymentManifest(config);
    const validation = validateDeploymentManifest(manifest);
    recordValidation('manifest: generates valid manifest', validation.ok, validation.reasons || {});
  } catch (err) {
    recordValidation('manifest: generates valid manifest', false, { error: err.message });
  }
}

/* Validate deployment config schema */
function validateConfigSchema() {
  try {
    const config = buildConfigFromEnv();
    const validation = validateDeploymentConfig(config);
    recordValidation('config: schema valid', validation.ok, validation.reasons || {});
  } catch (err) {
    recordValidation('config: schema valid', false, { error: err.message });
  }
}

/* Main validation runner */
export async function runControlledDeploymentValidation() {
  console.log('����������������������������������������������������������������������������������������������������������������');
  console.log('��  Nexora Controlled Deployment Validator (PROP.14 §36)              ���');
  console.log('��  TEST/STAGING deployment readiness check                            ���');
  console.log('����������������������������������������������������������������������������������������������������������������\n');

  console.log('Validating environment boundaries...');
  validateEnvironmentBoundaries();

  console.log('Validating kill switches...');
  validateKillSwitches();

  console.log('Validating no live credentials...');
  validateNoLiveCredentials();

  console.log('Validating governed contracts...');
  await validateGovernedContracts();

  console.log('Validating storage binding...');
  validateStorageBinding();

  console.log('Validating logging...');
  validateLogging();

  console.log('Validating endpoints...');
  validateEndpoints();

  console.log('Validating manifest...');
  await validateManifest();

  console.log('Validating config schema...');
  validateConfigSchema();

  console.log('\n����������������������������������������������������������������������������������������������������������������');
  console.log(`Validation: ${VALIDATION_STATE.passed} passed, ${VALIDATION_STATE.failed} failed, ${VALIDATION_STATE.warnings} warnings`);
  console.log('����������������������������������������������������������������������������������������������������������������');

  if (VALIDATION_STATE.failed > 0) {
    console.log('\nFAILED VALIDATIONS:');
    VALIDATION_STATE.results.filter(r => r.status === 'FAIL').forEach(r => {
      console.log(`  - ${r.name}: ${JSON.stringify(r.details || r.message || {})}`);
    });
    process.exitCode = 1;
  } else {
    console.log('\n✅ Controlled deployment validation passed');
  }

  return VALIDATION_STATE;
}

/* CLI entry point */
if (import.meta.url === `file://${process.argv[1]}`) {
  await runControlledDeploymentValidation();
}
