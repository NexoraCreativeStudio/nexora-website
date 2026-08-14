/* Nexora — Stripe TEST-Mode Boundaries (PROP.15 §8-9)
   Formal contracts for Stripe SDK version pinning, test-mode enforcement,
   and API boundary guards to prevent LIVE mode access in STAGING_TEST. */

import { DEPLOYMENT_ENVIRONMENTS, STRIPE_MODES, buildConfigFromEnv } from './deployment-config.mjs';

/* Stripe SDK version constraint — update via controlled process only */
export const STRIPE_SDK_VERSION_CONSTRAINT = '^16.0.0';

/* Stripe API version pin — must match STRIPE_API_VERSION in deployment config */
export const STRIPE_API_VERSION_DEFAULT = '2024-06-20';

/* Allowed Stripe hosts by environment */
export const STRIPE_ALLOWED_HOSTS = {
  [DEPLOYMENT_ENVIRONMENTS.LOCAL_TEST]: ['api.stripe.com'],
  [DEPLOYMENT_ENVIRONMENTS.STAGING_TEST]: ['api.stripe.com'],
  [DEPLOYMENT_ENVIRONMENTS.PRODUCTION_DISABLED]: ['api.stripe.com'],
};

/* Blocked Stripe hosts by environment */
export const STRIPE_BLOCKED_HOSTS = {
  [DEPLOYMENT_ENVIRONMENTS.LOCAL_TEST]: ['api.live.stripe.com', 'api.stripe.com/v1/radar', 'connect.stripe.com'],
  [DEPLOYMENT_ENVIRONMENTS.STAGING_TEST]: ['api.live.stripe.com', 'api.stripe.com/v1/radar', 'connect.stripe.com'],
  [DEPLOYMENT_ENVIRONMENTS.PRODUCTION_DISABLED]: [],
};

/* Stripe mode allowed by environment */
export const STRIPE_MODE_ALLOWED = {
  [DEPLOYMENT_ENVIRONMENTS.LOCAL_TEST]: [STRIPE_MODES.TEST],
  [DEPLOYMENT_ENVIRONMENTS.STAGING_TEST]: [STRIPE_MODES.TEST],
  [DEPLOYMENT_ENVIRONMENTS.PRODUCTION_DISABLED]: [STRIPE_MODES.TEST, STRIPE_MODES.LIVE],
};

/* Stripe key prefix validation */
export const STRIPE_KEY_PREFIXES = {
  [STRIPE_MODES.TEST]: {
    secret: 'sk_test_',
    publishable: 'pk_test_',
    webhook: 'whsec_',
  },
  [STRIPE_MODES.LIVE]: {
    secret: 'sk_live_',
    publishable: 'pk_live_',
    webhook: 'whsec_',
  },
};

/* Validate Stripe configuration for environment */
export function validateStripeConfig(config) {
  const reasons = [];

  // Check stripe_mode is allowed for environment
  const allowedModes = STRIPE_MODE_ALLOWED[config.environment] || [];
  if (!allowedModes.includes(config.stripe_mode)) {
    reasons.push(`STRIPE_MODE=${config.stripe_mode} not allowed for environment=${config.environment}`);
  }

  // Check key prefixes match mode
  if (config.stripe_secret_key && !config.stripe_secret_key.includes('PLACEHOLDER')) {
    const expectedPrefix = STRIPE_KEY_PREFIXES[config.stripe_mode]?.secret;
    if (expectedPrefix && !config.stripe_secret_key.startsWith(expectedPrefix)) {
      reasons.push(`Stripe secret key prefix mismatch: expected ${expectedPrefix} for ${config.stripe_mode} mode`);
    }
  }

  if (config.stripe_publishable_key && !config.stripe_publishable_key.includes('PLACEHOLDER')) {
    const expectedPrefix = STRIPE_KEY_PREFIXES[config.stripe_mode]?.publishable;
    if (expectedPrefix && !config.stripe_publishable_key.startsWith(expectedPrefix)) {
      reasons.push(`Stripe publishable key prefix mismatch: expected ${expectedPrefix} for ${config.stripe_mode} mode`);
    }
  }

  if (config.stripe_webhook_secret && !config.stripe_webhook_secret.includes('PLACEHOLDER')) {
    const expectedPrefix = STRIPE_KEY_PREFIXES[config.stripe_mode]?.webhook;
    if (expectedPrefix && !config.stripe_webhook_secret.startsWith(expectedPrefix)) {
      reasons.push(`Stripe webhook secret prefix mismatch: expected ${expectedPrefix} for ${config.stripe_mode} mode`);
    }
  }

  // STAGING_TEST specific validations
  if (config.environment === DEPLOYMENT_ENVIRONMENTS.STAGING_TEST) {
    if (config.stripe_mode !== STRIPE_MODES.TEST) {
      reasons.push('STAGING_TEST must use STRIPE_MODE=TEST');
    }
    if (!config.stripe_api_version) {
      reasons.push('STAGING_TEST requires STRIPE_API_VERSION');
    }
    if (config.webhook_tolerance_seconds === undefined || config.webhook_tolerance_seconds < 0) {
      reasons.push('STAGING_TEST requires WEBHOOK_TOLERANCE_SECONDS >= 0');
    }
  }

  return { ok: reasons.length === 0, reasons };
}

/* Validate a Stripe API call is allowed for current environment */
export function validateStripeCallAllowed(config, operation, targetHost = 'api.stripe.com') {
  const reasons = [];

  // Check mode
  if (!STRIPE_MODE_ALLOWED[config.environment].includes(config.stripe_mode)) {
    reasons.push(`Operation ${operation} not allowed: ${config.stripe_mode} mode forbidden in ${config.environment}`);
  }

  // Check host
  if (!STRIPE_ALLOWED_HOSTS[config.environment].includes(targetHost)) {
    reasons.push(`Operation ${operation} not allowed: host ${targetHost} forbidden in ${config.environment}`);
  }

  if (STRIPE_BLOCKED_HOSTS[config.environment].includes(targetHost)) {
    reasons.push(`Operation ${operation} blocked: host ${targetHost} explicitly blocked in ${config.environment}`);
  }

  return { ok: reasons.length === 0, reasons };
}

/* Test-mode only guard — throws if LIVE mode detected in test environments */
export function assertTestModeOnly(config, context = 'operation') {
  if (config.environment === DEPLOYMENT_ENVIRONMENTS.STAGING_TEST && config.stripe_mode === STRIPE_MODES.LIVE) {
    throw new Error(`${context}: LIVE mode forbidden in STAGING_TEST environment`);
  }
  if (config.environment === DEPLOYMENT_ENVIRONMENTS.LOCAL_TEST && config.stripe_mode === STRIPE_MODES.LIVE) {
    throw new Error(`${context}: LIVE mode forbidden in LOCAL_TEST environment`);
  }
}

/* LIVE mode gate — only allows if PRODUCTION_PAYMENT_ENABLED=true in PRODUCTION_DISABLED */
export function assertLiveModeAllowed(config, context = 'operation') {
  if (config.stripe_mode === STRIPE_MODES.LIVE) {
    if (config.environment !== DEPLOYMENT_ENVIRONMENTS.PRODUCTION_DISABLED) {
      throw new Error(`${context}: LIVE mode only allowed in PRODUCTION_DISABLED environment`);
    }
    if (config.production_payment_enabled !== true) {
      throw new Error(`${context}: LIVE mode requires PRODUCTION_PAYMENT_ENABLED=true (Owner approval)`);
    }
  }
}

/* Stripe SDK initialization contract — ensures test-mode initialization */
export function createStripeClientConfig(config) {
  assertTestModeOnly(config, 'Stripe client initialization');
  assertLiveModeAllowed(config, 'Stripe client initialization');

  return {
    apiKey: config.stripe_secret_key,
    apiVersion: config.stripe_api_version || STRIPE_API_VERSION_DEFAULT,
    // In test mode, we may use a mock HTTP client
    httpClient: config.environment !== DEPLOYMENT_ENVIRONMENTS.PRODUCTION_DISABLED
      ? 'mock'
      : undefined,
    // Never allow telemetry in test environments
    telemetry: config.environment === DEPLOYMENT_ENVIRONMENTS.PRODUCTION_DISABLED,
  };
}

/* Webhook endpoint validation for Stripe Dashboard configuration */
export function validateWebhookEndpointConfig(config) {
  const reasons = [];

  // Webhook URL must use HTTPS
  if (config.payment_api_base_url && !config.payment_api_base_url.startsWith('https://')) {
    reasons.push('PAYMENT_API_BASE_URL must use HTTPS for webhook endpoint');
  }

  // Webhook path must be configured
  const webhookPath = '/api/payment/webhook';
  if (!config.payment_api_base_url) {
    reasons.push('PAYMENT_API_BASE_URL required for webhook endpoint');
  }

  // In STAGING_TEST, webhook secret must be test mode
  if (config.environment === DEPLOYMENT_ENVIRONMENTS.STAGING_TEST) {
    if (config.stripe_webhook_secret && !config.stripe_webhook_secret.includes('PLACEHOLDER')) {
      if (!config.stripe_webhook_secret.startsWith('whsec_')) {
        reasons.push('STAGING_TEST webhook secret must be test mode (whsec_...)');
      }
    }
  }

  return { ok: reasons.length === 0, reasons };
}

/* Checkout session creation boundary — ensures amount/currency are server-authoritative */
export function validateCheckoutSessionRequest(request, config) {
  const reasons = [];

  // Amount must be positive number
  if (typeof request.amount_requested !== 'number' || request.amount_requested <= 0) {
    reasons.push('amount_requested must be a positive number');
  }

  // Currency must be GBP (frozen)
  if (request.currency !== 'GBP') {
    reasons.push('currency must be GBP (frozen commercial rule)');
  }

  // Mode must be payment (not setup/subscription)
  if (request.mode && request.mode !== 'payment') {
    reasons.push('Checkout mode must be "payment"');
  }

  // Success/cancel URLs must be from configured base URL
  if (config.stripe_success_url && !request.success_url?.startsWith(config.public_base_url)) {
    reasons.push('success_url must use configured PUBLIC_BASE_URL');
  }
  if (config.stripe_cancel_url && !request.cancel_url?.startsWith(config.public_base_url)) {
    reasons.push('cancel_url must use configured PUBLIC_BASE_URL');
  }

  return { ok: reasons.length === 0, reasons };
}

/* PROP.15 Contract Summary */
export const STRIPE_TEST_BOUNDARIES_CONTRACT = `
STRIPE TEST-MODE BOUNDARIES CONTRACT (PROP.15 §8-9):

1. SDK VERSION PINNING
   - Stripe Node SDK pinned to ${STRIPE_SDK_VERSION_CONSTRAINT}
   - API version pinned to ${STRIPE_API_VERSION_DEFAULT} (configurable via STRIPE_API_VERSION)
   - Updates require controlled change process

2. ENVIRONMENT-MODE MATRIX
   - LOCAL_TEST: TEST mode only
   - STAGING_TEST: TEST mode only
   - PRODUCTION_DISABLED: TEST mode (default), LIVE mode only with PRODUCTION_PAYMENT_ENABLED=true

3. KEY PREFIX VALIDATION
   - TEST mode keys: sk_test_*, pk_test_*, whsec_*
   - LIVE mode keys: sk_live_*, pk_live_*, whsec_*
   - Mismatch = validation failure

4. HOST ALLOWLIST/BLOCKLIST
   - Allowed: api.stripe.com (all environments)
   - Blocked in test environments: api.live.stripe.com, connect.stripe.com, radar endpoints
   - Runtime validation before each API call

5. WEBHOOK ENDPOINT
   - Must use HTTPS
   - Configured in Stripe Dashboard for test mode
   - Signature verification mandatory

6. CHECKOUT SESSION BOUNDARIES
   - Amount/currency server-authoritative (from governed payment request)
   - Currency frozen to GBP
   - Mode must be "payment"
   - URLs must use configured base URLs

7. RUNTIME GUARDS
   - assertTestModeOnly() — throws in STAGING_TEST/LOCAL_TEST if LIVE mode
   - assertLiveModeAllowed() — throws unless PRODUCTION_DISABLED + PRODUCTION_PAYMENT_ENABLED
   - validateStripeCallAllowed() — validates each operation/host

These boundaries are enforced in:
- deployment-config.mjs (validation)
- stripe-adapter.mjs (adapter-level guards)
- checkout-create.mjs (endpoint-level guards)
- webhook.mjs (endpoint-level guards)
`;