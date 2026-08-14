/* Nexora — PROP.15 Staging Integration Validator
   Targeted validation for STAGING_TEST deployment readiness.
   Verifies: environment config, storage provider, stripe mode, and gate state.
   No external network calls. */

import { buildConfigFromEnv, DEPLOYMENT_ENVIRONMENTS, STRIPE_MODES } from './deployment-config.mjs';
import { validateStripeConfig } from './stripe-test-boundaries.mjs';

function assert(condition, message) {
  if (!condition) {
    throw new Error(`Integration validation failed: ${message}`);
  }
}

async function validateStagingIntegration() {
  console.log('Validating PROP.15 Staging Integration...');

  // 1. Build config for STAGING_TEST
  const config = buildConfigFromEnv({
    DEPLOYMENT_ENV: DEPLOYMENT_ENVIRONMENTS.STAGING_TEST,
    SHARED_STORAGE_PROVIDER: 'redis', // Required: non-memory
    SHARED_STORAGE_NAMESPACE: 'nexora/payment/STAGING_TEST',
    STRIPE_MODE: STRIPE_MODES.TEST,
    STAGING_PAYMENT_ENABLED: 'false'
  });

  // 2. Validate environment
  assert(config.environment === DEPLOYMENT_ENVIRONMENTS.STAGING_TEST, 'Environment must be STAGING_TEST');
  console.log('✅ Environment is STAGING_TEST');

  // 3. Validate storage provider (non-memory)
  assert(config.shared_storage_provider !== 'memory', 'Shared storage provider must be non-memory in STAGING_TEST');
  console.log(`✅ Storage provider ${config.shared_storage_provider} is acceptable`);

  // 4. Validate Stripe config (TEST mode, proper API version)
  const stripeValidation = validateStripeConfig(config);
  assert(stripeValidation.ok, `Stripe config invalid: ${stripeValidation.reasons.join(', ')}`);
  console.log('✅ Stripe config is valid');

  // 5. Validate Gate State (Accessibility)
  assert(typeof config.staging_payment_enabled === 'boolean', 'Staging gate state must be boolean');
  console.log(`✅ Staging gate state is ${config.staging_payment_enabled}`);

  console.log('\n✅ PROP.15 targeted staging integration validator PASSED');
  return true;
}

validateStagingIntegration().catch(err => {
  console.error(err.message);
  process.exit(1);
});
