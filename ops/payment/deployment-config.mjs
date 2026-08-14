/* Nexora — Payment Deployment Configuration Contract (PROP.14)
   Governed configuration model for controlled payment backend deployment.
   All values are environment references — never committed with real values. */

export const DEPLOYMENT_CONFIG_SCHEMA = 'nexora-payment-deployment/v1';

/* Explicit deployment environments — no ambiguous "production" for test deployment */
export const DEPLOYMENT_ENVIRONMENTS = {
  LOCAL_TEST: 'LOCAL_TEST',           // Local development with deterministic adapters
  STAGING_TEST: 'STAGING_TEST',       // Deployed staging with shared storage + test Stripe
  PRODUCTION_DISABLED: 'PRODUCTION_DISABLED', // Production runtime, payments blocked
};

export const STRIPE_MODES = {
  TEST: 'TEST',
  LIVE: 'LIVE',
};

/* Required configuration keys — populated from environment/platform secret manager.
   Never commit real values. Use references/placeholders only. */
export const DEPLOYMENT_CONFIG_KEYS = [
  // Deployment identity
  'DEPLOYMENT_ENV',                   // LOCAL_TEST | STAGING_TEST | PRODUCTION_DISABLED
  'DEPLOYMENT_ID',                    // Unique deployment identifier
  'RELEASE_SHA',                      // Git commit SHA

  // Payment gates
  'PAYMENTS_ENABLED',                 // false by default — global kill switch
  'STAGING_PAYMENT_ENABLED',          // false by default — staging gate
  'PRODUCTION_PAYMENT_ENABLED',       // false by default — production gate (Owner approval only)

  // Stripe configuration (references to secrets)
  'STRIPE_MODE',                      // TEST | LIVE
  'STRIPE_SECRET_KEY_REF',            // Reference to secret manager key for sk_test_* or sk_live_*
  'STRIPE_WEBHOOK_SECRET_REF',        // Reference to secret manager key for whsec_*
  'STRIPE_PUBLISHABLE_KEY_REF',       // Reference to secret manager key for pk_test_* or pk_live_*

  // URLs
  'PUBLIC_BASE_URL',                  // Public-facing base URL (e.g., https://staging.nexora.studio)
  'PAYMENT_API_BASE_URL',             // Payment API base URL (e.g., https://api-staging.nexora.studio)
  'STRIPE_SUCCESS_URL',               // Success URL template with {CHECKOUT_SESSION_ID}
  'STRIPE_CANCEL_URL',                // Cancel URL template

  // Shared storage
  'SHARED_STORAGE_PROVIDER',          // Provider identifier (e.g., 'redis', 'postgresql', 'dynamodb')
  'SHARED_STORAGE_NAMESPACE',         // Namespace prefix (e.g., 'nexora/payment/STAGING_TEST')
  'SHARED_STORAGE_URL_REF',           // Optional reference to connection URL in secret manager
  'SHARED_STORAGE_TOKEN_REF',         // Optional reference to auth token in secret manager

  // CORS
  'ALLOWED_ORIGINS',                  // Comma-separated list of allowed origins

  // Logging
  'LOG_LEVEL',                        // debug | info | warn | error

  // Request limits
  'MAX_JSON_BODY_SIZE',               // Max JSON body size in bytes (default: 1048576)
  'MAX_RAW_WEBHOOK_SIZE',             // Max raw webhook body size in bytes (default: 1048576)
];

/* Forbidden patterns in committed files (secret scanning) */
export const DEPLOYMENT_SECRET_PATTERNS = [
  /sk_live_[a-zA-Z0-9]{24,}/,
  /rk_live_[a-zA-Z0-9]{24,}/,
  /whsec_[a-zA-Z0-9]{32,}/,
  /acct_[a-zA-Z0-9]{16,}/,
  /sk_test_[a-zA-Z0-9]{24,}/,  // Test keys also should not be committed
  /pk_live_[a-zA-Z0-9]{24,}/,
  /pk_test_[a-zA-Z0-9]{24,}/,
];

/* Synthetic placeholder patterns (allowed in examples only) */
export const DEPLOYMENT_PLACEHOLDERS = {
  stripe_secret_key: 'sk_test_PLACEHOLDER_REPLACE_WITH_REAL_TEST_KEY',
  stripe_webhook_secret: 'whsec_PLACEHOLDER_REPLACE_WITH_REAL_TEST_SECRET',
  stripe_publishable_key: 'pk_test_PLACEHOLDER_REPLACE_WITH_REAL_TEST_KEY',
  shared_storage_url: 'redis://PLACEHOLDER_REPLACE_WITH_REAL_URL',
  shared_storage_token: 'PLACEHOLDER_REPLACE_WITH_REAL_TOKEN',
};

/* Default configuration values */
export const DEPLOYMENT_DEFAULTS = {
  PAYMENTS_ENABLED: false,
  STAGING_PAYMENT_ENABLED: false,
  PRODUCTION_PAYMENT_ENABLED: false,
  STRIPE_MODE: 'TEST',
  LOG_LEVEL: 'info',
  MAX_JSON_BODY_SIZE: 1048576,      // 1 MB
  MAX_RAW_WEBHOOK_SIZE: 1048576,    // 1 MB
};

/* Configuration validation */
export function validateDeploymentConfig(config) {
  const reasons = [];

  if (!config || typeof config !== 'object') {
    return { ok: false, reasons: ['config must be an object'] };
  }

  if (config.schema !== DEPLOYMENT_CONFIG_SCHEMA) {
    reasons.push(`schema must be ${DEPLOYMENT_CONFIG_SCHEMA}`);
  }

  // Environment validation
  if (!Object.values(DEPLOYMENT_ENVIRONMENTS).includes(config.environment)) {
    reasons.push(`environment must be one of: ${Object.values(DEPLOYMENT_ENVIRONMENTS).join(', ')}`);
  }

  // Stripe mode validation
  if (!Object.values(STRIPE_MODES).includes(config.stripe_mode)) {
    reasons.push(`stripe_mode must be one of: ${Object.values(STRIPE_MODES).join(', ')}`);
  }

  // Gate validation
  if (config.production_payment_enabled === true && config.environment !== 'PRODUCTION_DISABLED') {
    reasons.push('PRODUCTION_PAYMENT_ENABLED=true requires environment=PRODUCTION_DISABLED and Owner approval');
  }

  if (config.staging_payment_enabled === true && config.environment !== 'STAGING_TEST') {
    reasons.push('STAGING_PAYMENT_ENABLED=true requires environment=STAGING_TEST');
  }

  // Stripe mode vs environment isolation
  if (config.environment === 'STAGING_TEST' && config.stripe_mode === 'LIVE') {
    reasons.push('STAGING_TEST environment must use STRIPE_MODE=TEST');
  }

  if (config.environment === 'LOCAL_TEST' && config.stripe_mode === 'LIVE') {
    reasons.push('LOCAL_TEST environment must use STRIPE_MODE=TEST');
  }

  if (config.environment === 'PRODUCTION_DISABLED' && config.stripe_mode === 'LIVE' && config.production_payment_enabled !== true) {
    reasons.push('PRODUCTION_DISABLED with STRIPE_MODE=LIVE requires PRODUCTION_PAYMENT_ENABLED=true (Owner approval)');
  }

  // Shared storage requirement for STAGING_TEST
  if (config.environment === 'STAGING_TEST') {
    if (!config.shared_storage_provider) {
      reasons.push('STAGING_TEST requires SHARED_STORAGE_PROVIDER');
    }
    if (!config.shared_storage_namespace) {
      reasons.push('STAGING_TEST requires SHARED_STORAGE_NAMESPACE');
    }
  }

  // Secret pattern check
  const secretFields = ['stripe_secret_key', 'stripe_webhook_secret', 'stripe_publishable_key'];
  for (const field of secretFields) {
    if (config[field]) {
      for (const pattern of DEPLOYMENT_SECRET_PATTERNS) {
        if (pattern.test(config[field])) {
          reasons.push(`${field} appears to contain a live or test secret — forbidden in committed config`);
        }
      }
    }
  }

  // URL validation
  const urlFields = ['public_base_url', 'payment_api_base_url', 'stripe_success_url', 'stripe_cancel_url'];
  for (const field of urlFields) {
    if (config[field] && !config[field].startsWith('https://')) {
      reasons.push(`${field} must use HTTPS`);
    }
  }

  // CORS validation
  if (config.allowed_origins && config.allowed_origins === '*') {
    reasons.push('ALLOWED_ORIGINS cannot be wildcard (*) for sensitive payment routes');
  }

  return { ok: reasons.length === 0, reasons };
}

/* Example synthetic config for LOCAL_TEST (never committed with real values) */
export const LOCAL_TEST_CONFIG_EXAMPLE = {
  schema: DEPLOYMENT_CONFIG_SCHEMA,
  environment: 'LOCAL_TEST',
  deployment_id: 'local-test-' + Date.now(),
  release_sha: '0000000000000000000000000000000000000000',
  payments_enabled: false,
  staging_payment_enabled: false,
  production_payment_enabled: false,
  stripe_mode: 'TEST',
  stripe_secret_key: DEPLOYMENT_PLACEHOLDERS.stripe_secret_key,
  stripe_webhook_secret: DEPLOYMENT_PLACEHOLDERS.stripe_webhook_secret,
  stripe_publishable_key: DEPLOYMENT_PLACEHOLDERS.stripe_publishable_key,
  public_base_url: 'https://localhost:3000',
  payment_api_base_url: 'https://localhost:3000',
  stripe_success_url: 'https://localhost:3000/payment/success?session_id={CHECKOUT_SESSION_ID}',
  stripe_cancel_url: 'https://localhost:3000/payment/cancel',
  shared_storage_provider: 'memory',
  shared_storage_namespace: 'nexora/payment/LOCAL_TEST',
  allowed_origins: 'https://localhost:3000',
  log_level: 'debug',
  max_json_body_size: 1048576,
  max_raw_webhook_size: 1048576,
  _example: true,
};

/* Example synthetic config for STAGING_TEST (never committed with real values) */
export const STAGING_TEST_CONFIG_EXAMPLE = {
  schema: DEPLOYMENT_CONFIG_SCHEMA,
  environment: 'STAGING_TEST',
  deployment_id: 'staging-test-' + Date.now(),
  release_sha: '0000000000000000000000000000000000000000',
  payments_enabled: false,
  staging_payment_enabled: false,  // Must be explicitly enabled by operator
  production_payment_enabled: false,
  stripe_mode: 'TEST',
  stripe_secret_key: DEPLOYMENT_PLACEHOLDERS.stripe_secret_key,
  stripe_webhook_secret: DEPLOYMENT_PLACEHOLDERS.stripe_webhook_secret,
  stripe_publishable_key: DEPLOYMENT_PLACEHOLDERS.stripe_publishable_key,
  public_base_url: 'https://staging.nexora.studio',
  payment_api_base_url: 'https://api-staging.nexora.studio',
  stripe_success_url: 'https://staging.nexora.studio/payment/success?session_id={CHECKOUT_SESSION_ID}',
  stripe_cancel_url: 'https://staging.nexora.studio/payment/cancel',
  shared_storage_provider: 'redis',
  shared_storage_namespace: 'nexora/payment/STAGING_TEST',
  shared_storage_url: DEPLOYMENT_PLACEHOLDERS.shared_storage_url,
  shared_storage_token: DEPLOYMENT_PLACEHOLDERS.shared_storage_token,
  allowed_origins: 'https://staging.nexora.studio',
  log_level: 'info',
  max_json_body_size: 1048576,
  max_raw_webhook_size: 1048576,
  _example: true,
};

/* Example synthetic config for PRODUCTION_DISABLED (never committed with real values) */
export const PRODUCTION_DISABLED_CONFIG_EXAMPLE = {
  schema: DEPLOYMENT_CONFIG_SCHEMA,
  environment: 'PRODUCTION_DISABLED',
  deployment_id: 'prod-disabled-' + Date.now(),
  release_sha: '0000000000000000000000000000000000000000',
  payments_enabled: false,
  staging_payment_enabled: false,
  production_payment_enabled: false,  // Requires explicit Owner approval to change
  stripe_mode: 'TEST',  // Stays TEST until Owner approval
  stripe_secret_key: DEPLOYMENT_PLACEHOLDERS.stripe_secret_key,
  stripe_webhook_secret: DEPLOYMENT_PLACEHOLDERS.stripe_webhook_secret,
  stripe_publishable_key: DEPLOYMENT_PLACEHOLDERS.stripe_publishable_key,
  public_base_url: 'https://nexora.studio',
  payment_api_base_url: 'https://api.nexora.studio',
  stripe_success_url: 'https://nexora.studio/payment/success?session_id={CHECKOUT_SESSION_ID}',
  stripe_cancel_url: 'https://nexora.studio/payment/cancel',
  shared_storage_provider: 'postgresql',
  shared_storage_namespace: 'nexora/payment/PRODUCTION_DISABLED',
  shared_storage_url: DEPLOYMENT_PLACEHOLDERS.shared_storage_url,
  shared_storage_token: DEPLOYMENT_PLACEHOLDERS.shared_storage_token,
  allowed_origins: 'https://nexora.studio',
  log_level: 'warn',
  max_json_body_size: 1048576,
  max_raw_webhook_size: 1048576,
  _example: true,
};

/* Build configuration from environment variables (deployment-time) */
export function buildConfigFromEnv(env = process.env) {
  return {
    schema: DEPLOYMENT_CONFIG_SCHEMA,
    environment: env.DEPLOYMENT_ENV || 'LOCAL_TEST',
    deployment_id: env.DEPLOYMENT_ID || `deploy-${Date.now()}`,
    release_sha: env.RELEASE_SHA || 'unknown',
    payments_enabled: env.PAYMENTS_ENABLED === 'true',
    staging_payment_enabled: env.STAGING_PAYMENT_ENABLED === 'true',
    production_payment_enabled: env.PRODUCTION_PAYMENT_ENABLED === 'true',
    stripe_mode: env.STRIPE_MODE || 'TEST',
    stripe_secret_key: env.STRIPE_SECRET_KEY_REF || DEPLOYMENT_PLACEHOLDERS.stripe_secret_key,
    stripe_webhook_secret: env.STRIPE_WEBHOOK_SECRET_REF || DEPLOYMENT_PLACEHOLDERS.stripe_webhook_secret,
    stripe_publishable_key: env.STRIPE_PUBLISHABLE_KEY_REF || DEPLOYMENT_PLACEHOLDERS.stripe_publishable_key,
    public_base_url: env.PUBLIC_BASE_URL || 'https://localhost:3000',
    payment_api_base_url: env.PAYMENT_API_BASE_URL || 'https://localhost:3000',
    stripe_success_url: env.STRIPE_SUCCESS_URL || 'https://localhost:3000/payment/success?session_id={CHECKOUT_SESSION_ID}',
    stripe_cancel_url: env.STRIPE_CANCEL_URL || 'https://localhost:3000/payment/cancel',
    shared_storage_provider: env.SHARED_STORAGE_PROVIDER || 'memory',
    shared_storage_namespace: env.SHARED_STORAGE_NAMESPACE || 'nexora/payment/LOCAL_TEST',
    shared_storage_url: env.SHARED_STORAGE_URL_REF || DEPLOYMENT_PLACEHOLDERS.shared_storage_url,
    shared_storage_token: env.SHARED_STORAGE_TOKEN_REF || DEPLOYMENT_PLACEHOLDERS.shared_storage_token,
    allowed_origins: env.ALLOWED_ORIGINS || 'https://localhost:3000',
    log_level: env.LOG_LEVEL || 'info',
    max_json_body_size: parseInt(env.MAX_JSON_BODY_SIZE, 10) || 1048576,
    max_raw_webhook_size: parseInt(env.MAX_RAW_WEBHOOK_SIZE, 10) || 1048576,
  };
}

/* Safe configuration for logging (redacts secrets) */
export function safeConfigForLogging(config) {
  if (!config) return null;
  const safe = { ...config };
  const secretKeys = [
    'stripe_secret_key', 'stripe_webhook_secret', 'stripe_publishable_key',
    'shared_storage_url', 'shared_storage_token'
  ];
  for (const key of secretKeys) {
    if (safe[key]) {
      safe[key] = '[REDACTED]';
    }
  }
  return safe;
}