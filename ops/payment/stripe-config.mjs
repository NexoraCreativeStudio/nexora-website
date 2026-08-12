/* Nexora — Stripe Configuration Contract (PROP.10)
   Governed configuration model for Stripe integration readiness.
   All values are environment references only — never committed. */

export const STRIPE_CONFIG_SCHEMA = 'nexora-stripe-config/v1';

/* Required configuration keys — populated from environment/platform secret manager.
   Test-mode keys (sk_test_, pk_test_) used for sandbox readiness.
   Production keys (sk_live_, pk_live_) require explicit Owner activation gate. */
export const STRIPE_CONFIG_KEYS = [
  'STRIPE_ENVIRONMENT',           // 'test' | 'live'
  'STRIPE_ACCOUNT_MODE',          // 'standard' | 'express' | 'custom' (connected accounts)
  'STRIPE_PUBLISHABLE_KEY_REF',   // pk_test_... | pk_live_... (env ref only)
  'STRIPE_SECRET_KEY_REF',        // sk_test_... | sk_live_... (env ref only)
  'STRIPE_WEBHOOK_SECRET_REF',    // whsec_... (env ref only)
  'STRIPE_ACCOUNT_ID_REF',        // acct_... (env ref only, for connected accounts)
  'STRIPE_DEFAULT_CURRENCY',      // 'gbp'
  'STRIPE_PAYOUT_CURRENCY',       // 'gbp'
  'STRIPE_SUCCESS_URL',           // https://domain.com/payment/success?session_id={CHECKOUT_SESSION_ID}
  'STRIPE_CANCEL_URL',            // https://domain.com/payment/cancel
];

/* Forbidden patterns in committed files (secret scanning) */
export const STRIPE_SECRET_PATTERNS = [
  /sk_live_[a-zA-Z0-9]{24,}/,
  /rk_live_[a-zA-Z0-9]{24,}/,
  /whsec_[a-zA-Z0-9]{32,}/,
  /acct_[a-zA-Z0-9]{16,}/,
];

/* Synthetic test-mode placeholder patterns (allowed in examples) */
export const STRIPE_TEST_PLACEHOLDERS = {
  publishable_key: 'pk_test_PLACEHOLDER_REPLACE_WITH_REAL_TEST_KEY',
  secret_key: 'sk_test_PLACEHOLDER_REPLACE_WITH_REAL_TEST_KEY',
  webhook_secret: 'whsec_PLACEHOLDER_REPLACE_WITH_REAL_TEST_SECRET',
  account_id: 'acct_PLACEHOLDER_REPLACE_WITH_REAL_ACCOUNT_ID',
};

/* Configuration validation */
export function validateStripeConfig(config) {
  const reasons = [];
  if (!config || typeof config !== 'object') {
    return { ok: false, reasons: ['config must be an object'] };
  }
  if (config.schema !== STRIPE_CONFIG_SCHEMA) {
    reasons.push(`schema must be ${STRIPE_CONFIG_SCHEMA}`);
  }
  if (!['test', 'live'].includes(config.environment)) {
    reasons.push('environment must be "test" or "live"');
  }
  if (config.environment === 'live' && !config.production_activation_gate === true) {
    reasons.push('live environment requires production_activation_gate: true (Owner approval)');
  }
  if (config.publishable_key && STRIPE_SECRET_PATTERNS[0].test(config.publishable_key)) {
    reasons.push('publishable_key appears to be a live key — forbidden in committed config');
  }
  if (config.secret_key && STRIPE_SECRET_PATTERNS[1].test(config.secret_key)) {
    reasons.push('secret_key appears to be a live secret key — forbidden in committed config');
  }
  if (config.webhook_secret && STRIPE_SECRET_PATTERNS[2].test(config.webhook_secret)) {
    reasons.push('webhook_secret appears to be a live webhook secret — forbidden in committed config');
  }
  if (config.default_currency !== 'gbp') {
    reasons.push('default_currency must be "gbp" for initial Production target');
  }
  if (config.payout_currency !== 'gbp') {
    reasons.push('payout_currency must be "gbp" for initial Starling settlement');
  }
  return { ok: reasons.length === 0, reasons };
}

/* Example synthetic config for test-mode readiness (never committed with real values) */
export const STRIPE_TEST_CONFIG_EXAMPLE = {
  schema: STRIPE_CONFIG_SCHEMA,
  environment: 'test',
  account_mode: 'standard',
  publishable_key: STRIPE_TEST_PLACEHOLDERS.publishable_key,
  secret_key: STRIPE_TEST_PLACEHOLDERS.secret_key,
  webhook_secret: STRIPE_TEST_PLACEHOLDERS.webhook_secret,
  account_id: STRIPE_TEST_PLACEHOLDERS.account_id,
  default_currency: 'gbp',
  payout_currency: 'gbp',
  success_url: 'https://example.com/payment/success?session_id={CHECKOUT_SESSION_ID}',
  cancel_url: 'https://example.com/payment/cancel',
  production_activation_gate: false,
  _example: true,
};

/* OWNER DECISION — PRIMARY PAYMENT PROVIDER
   PROPOSED: STRIPE
   Architecture remains provider-neutral for future PayPal support.
   This contract models Stripe-specific configuration; a PayPal contract
   would follow the same governance pattern when separately approved. */