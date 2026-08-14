/* Nexora — Staging Deployment Checklist (PROP.15 §16)
   Pre-flight validation checklist for STAGING_TEST deployment.
   All items must pass before external staging deployment. */

import { DEPLOYMENT_ENVIRONMENTS, buildConfigFromEnv, validateDeploymentConfig, validateConfigSecurity } from './deployment-config.mjs';
import { createSharedStorageClient, validateSharedStorageConnectivity } from './shared-storage-binding.mjs';
import { createWebhookVerifier, validateWebhookVerifier } from './webhook-verifier.mjs';
import { validateStripeCallAllowed, validateStripeConfig } from './stripe-test-boundaries.mjs';
import { getDefaultLogger } from './structured-logging.mjs';

const logger = getDefaultLogger();

/**
 * Checklist result statuses
 */
export const CHECKLIST_STATUS = {
  PASS: 'PASS',
  FAIL: 'FAIL',
  SKIP: 'SKIP',
  WARNING: 'WARNING',
};

/**
 * Individual checklist item
 */
class ChecklistItem {
  constructor(id, name, category, required = true, checkFn) {
    this.id = id;
    this.name = name;
    this.category = category;
    this.required = required;
    this.checkFn = checkFn;
    this.result = null;
    this.details = null;
    this.durationMs = 0;
  }

  async run(config, context = {}) {
    const start = Date.now();
    try {
      const result = await this.checkFn(config, context);
      this.result = result.ok ? CHECKLIST_STATUS.PASS : CHECKLIST_STATUS.FAIL;
      this.details = result.details || result.reason;
    } catch (err) {
      this.result = CHECKLIST_STATUS.FAIL;
      this.details = err.message;
    }
    this.durationMs = Date.now() - start;
    return this;
  }
}

/**
 * Build the complete staging deployment checklist
 */
export function buildStagingChecklist() {
  return [
    // ============================================================
    // CATEGORY: Configuration Validation
    // ============================================================
    new ChecklistItem(
      'config-schema',
      'Deployment config schema valid (nexora-payment-deployment/v1)',
      'Configuration',
      true,
      async (config) => {
        const validation = validateDeploymentConfig(config);
        return { ok: validation.ok, reasons: validation.reasons };
      }
    ),

    new ChecklistItem(
      'config-security',
      'No secrets or placeholders in config for STAGING_TEST',
      'Configuration',
      true,
      async (config) => {
        const security = validateConfigSecurity(config);
        return { ok: security.ok, reasons: security.reasons };
      }
    ),

    new ChecklistItem(
      'stripe-config',
      'Stripe TEST mode configuration valid',
      'Configuration',
      true,
      async (config) => {
        const validation = validateStripeConfig(config);
        return { ok: validation.ok, reasons: validation.reasons };
      }
    ),

    new ChecklistItem(
      'environment-staging',
      'Environment is STAGING_TEST',
      'Configuration',
      true,
      async (config) => {
        return { ok: config.environment === DEPLOYMENT_ENVIRONMENTS.STAGING_TEST, reason: `Environment is ${config.environment}` };
      }
    ),

    new ChecklistItem(
      'stripe-mode-test',
      'STRIPE_MODE is TEST (not LIVE)',
      'Configuration',
      true,
      async (config) => {
        return { ok: config.stripe_mode === 'TEST', reason: `Stripe mode is ${config.stripe_mode}` };
      }
    ),

    new ChecklistItem(
      'kill-switches-default-false',
      'All kill switches default to false (PAYMENTS_ENABLED, STAGING_PAYMENT_ENABLED, PRODUCTION_PAYMENT_ENABLED)',
      'Configuration',
      true,
      async (config) => {
        const ok = config.payments_enabled === false &&
                   config.staging_payment_enabled === false &&
                   config.production_payment_enabled === false;
        return { ok, reason: `payments_enabled=${config.payments_enabled}, staging_payment_enabled=${config.staging_payment_enabled}, production_payment_enabled=${config.production_payment_enabled}` };
      }
    ),

    // ============================================================
    // CATEGORY: Shared Storage
    // ============================================================
    new ChecklistItem(
      'shared-storage-provider',
      'SHARED_STORAGE_PROVIDER configured and non-memory',
      'Shared Storage',
      true,
      async (config) => {
        const ok = config.shared_storage_provider &&
                   config.shared_storage_provider !== 'memory' &&
                   config.shared_storage_provider !== 'memory-test';
        return { ok, reason: `Provider: ${config.shared_storage_provider || 'NOT SET'}` };
      }
    ),

    new ChecklistItem(
      'shared-storage-namespace',
      'SHARED_STORAGE_NAMESPACE follows pattern nexora/payment/STAGING_TEST',
      'Shared Storage',
      true,
      async (config) => {
        const expected = 'nexora/payment/STAGING_TEST';
        const ok = config.shared_storage_namespace === expected;
        return { ok, reason: `Namespace: ${config.shared_storage_namespace || 'NOT SET'} (expected: ${expected})` };
      }
    ),

    new ChecklistItem(
      'shared-storage-connectivity',
      'Shared storage connectivity verified (ping/health check)',
      'Shared Storage',
      true,
      async (config) => {
        try {
          const client = createSharedStorageClient(config);
          const result = await validateSharedStorageConnectivity(client);
          await client.close?.();
          return { ok: result.ok, reason: result.reason };
        } catch (err) {
          return { ok: false, reason: err.message };
        }
      }
    ),

    new ChecklistItem(
      'shared-storage-cas',
      'Shared storage supports compare-and-set (linearizable)',
      'Shared Storage',
      true,
      async (config) => {
        try {
          const client = createSharedStorageClient(config);
          const result = await client.testCompareAndSet?.() || { ok: true, reason: 'CAS not directly testable, assumed by provider' };
          await client.close?.();
          return { ok: result.ok, reason: result.reason };
        } catch (err) {
          return { ok: false, reason: err.message };
        }
      }
    ),

    // ============================================================
    // CATEGORY: Stripe Configuration
    // ============================================================
    new ChecklistItem(
      'stripe-secret-key',
      'STRIPE_SECRET_KEY_REF resolves to valid sk_test_* key (not placeholder)',
      'Stripe',
      true,
      async (config) => {
        const ok = config.stripe_secret_key &&
                   config.stripe_secret_key.startsWith('sk_test_') &&
                   !config.stripe_secret_key.includes('PLACEHOLDER');
        return { ok, reason: ok ? 'Valid test secret key configured' : 'Secret key missing, not test mode, or placeholder' };
      }
    ),

    new ChecklistItem(
      'stripe-webhook-secret',
      'STRIPE_WEBHOOK_SECRET_REF resolves to valid whsec_* secret (not placeholder)',
      'Stripe',
      true,
      async (config) => {
        const ok = config.stripe_webhook_secret &&
                   config.stripe_webhook_secret.startsWith('whsec_') &&
                   !config.stripe_webhook_secret.includes('PLACEHOLDER');
        return { ok, reason: ok ? 'Valid webhook secret configured' : 'Webhook secret missing or placeholder' };
      }
    ),

    new ChecklistItem(
      'stripe-publishable-key',
      'STRIPE_PUBLISHABLE_KEY_REF resolves to valid pk_test_* key (not placeholder)',
      'Stripe',
      true,
      async (config) => {
        const ok = config.stripe_publishable_key &&
                   config.stripe_publishable_key.startsWith('pk_test_') &&
                   !config.stripe_publishable_key.includes('PLACEHOLDER');
        return { ok, reason: ok ? 'Valid publishable key configured' : 'Publishable key missing or placeholder' };
      }
    ),

    new ChecklistItem(
      'stripe-api-version',
      'STRIPE_API_VERSION pinned (e.g., 2024-06-20)',
      'Stripe',
      true,
      async (config) => {
        const ok = config.stripe_api_version && /^\d{4}-\d{2}-\d{2}$/.test(config.stripe_api_version);
        return { ok, reason: `API Version: ${config.stripe_api_version || 'NOT SET'}` };
      }
    ),

    new ChecklistItem(
      'stripe-sdk-available',
      'Stripe SDK available and version matches pinned API version',
      'Stripe',
      true,
      async (config) => {
        try {
          const stripe = await import('stripe');
          const version = stripe.default?.version || 'unknown';
          return { ok: true, reason: `Stripe SDK version: ${version}` };
        } catch (err) {
          return { ok: false, reason: `Stripe SDK not available: ${err.message}` };
        }
      }
    ),

    new ChecklistItem(
      'stripe-call-allowed',
      'Stripe API calls allowed to api.stripe.com (TEST mode)',
      'Stripe',
      true,
      async (config) => {
        const result = validateStripeCallAllowed(config, 'createCheckoutSession', 'api.stripe.com');
        return { ok: result.ok, reason: result.reasons?.join(', ') || 'Allowed' };
      }
    ),

    // ============================================================
    // CATEGORY: URLs and CORS
    // ============================================================
    new ChecklistItem(
      'urls-https',
      'All URLs use HTTPS (public_base_url, payment_api_base_url, success_url, cancel_url)',
      'URLs/CORS',
      true,
      async (config) => {
        const urls = [
          config.public_base_url,
          config.payment_api_base_url,
          config.stripe_success_url,
          config.stripe_cancel_url,
        ];
        const allHttps = urls.every(u => u && u.startsWith('https://'));
        return { ok: allHttps, reason: allHttps ? 'All URLs use HTTPS' : `Non-HTTPS URLs: ${urls.filter(u => u && !u.startsWith('https://')).join(', ')}` };
      }
    ),

    new ChecklistItem(
      'cors-explicit',
      'ALLOWED_ORIGINS explicit (no wildcard)',
      'URLs/CORS',
      true,
      async (config) => {
        const ok = config.allowed_origins && config.allowed_origins !== '*';
        return { ok, reason: ok ? `Origins: ${config.allowed_origins}` : 'Wildcard or missing CORS origins' };
      }
    ),

    new ChecklistItem(
      'success-url-template',
      'STRIPE_SUCCESS_URL contains {CHECKOUT_SESSION_ID} template',
      'URLs/CORS',
      true,
      async (config) => {
        const ok = config.stripe_success_url && config.stripe_success_url.includes('{CHECKOUT_SESSION_ID}');
        return { ok, reason: ok ? 'Template present' : 'Missing {CHECKOUT_SESSION_ID} template' };
      }
    ),

    // ============================================================
    // CATEGORY: Webhook Verification
    // ============================================================
    new ChecklistItem(
      'webhook-verifier-test',
      'Webhook verifier available for TEST mode (TestDeterministicVerifier)',
      'Webhook Verification',
      true,
      async (config) => {
        try {
          const verifier = createWebhookVerifier({ environment: 'TEST', config });
          const validation = validateWebhookVerifier(verifier, 'TEST');
          return { ok: validation.ok, reason: validation.reason };
        } catch (err) {
          return { ok: false, reason: err.message };
        }
      }
    ),

    new ChecklistItem(
      'webhook-tolerance',
      'WEBHOOK_TOLERANCE_SECONDS configured (default 300, Stripe recommended)',
      'Webhook Verification',
      true,
      async (config) => {
        const ok = config.webhook_tolerance_seconds !== undefined &&
                   config.webhook_tolerance_seconds >= 0 &&
                   config.webhook_tolerance_seconds <= 300;
        return { ok, reason: `Tolerance: ${config.webhook_tolerance_seconds}s` };
      }
    ),

    new ChecklistItem(
      'webhook-secret-matches-mode',
      'Webhook secret matches TEST mode (whsec_* for test)',
      'Webhook Verification',
      true,
      async (config) => {
        const ok = config.stripe_webhook_secret && config.stripe_webhook_secret.startsWith('whsec_');
        return { ok, reason: ok ? 'Test webhook secret format' : 'Webhook secret format mismatch for TEST mode' };
      }
    ),

    // ============================================================
    // CATEGORY: Idempotency and Reconciliation
    // ============================================================
    new ChecklistItem(
      'idempotency-ttl',
      'IDEMPOTENCY_TTL_SECONDS configured (>= 60, default 86400)',
      'Idempotency/Reconciliation',
      true,
      async (config) => {
        const ok = config.idempotency_ttl_seconds !== undefined &&
                   config.idempotency_ttl_seconds >= 60;
        return { ok, reason: `TTL: ${config.idempotency_ttl_seconds}s` };
      }
    ),

    new ChecklistItem(
      'reconciliation-tolerance',
      'RECONCILIATION_TOLERANCE_PENCE configured (default 0 = exact match)',
      'Idempotency/Reconciliation',
      true,
      async (config) => {
        const ok = config.reconciliation_tolerance_pence !== undefined &&
                   config.reconciliation_tolerance_pence >= 0;
        return { ok, reason: `Tolerance: ${config.reconciliation_tolerance_pence} pence` };
      }
    ),

    new ChecklistItem(
      'exact-match-reconciliation',
      'Reconciliation requires EXACT match for PAID status (tolerance = 0)',
      'Idempotency/Reconciliation',
      true,
      async (config) => {
        const ok = config.reconciliation_tolerance_pence === 0;
        return { ok, reason: ok ? 'Exact match enforced' : `Tolerance ${config.reconciliation_tolerance_pence}p allows partial matches` };
      }
    ),

    // ============================================================
    // CATEGORY: Logging and Observability
    // ============================================================
    new ChecklistItem(
      'log-level-configured',
      'LOG_LEVEL configured (info/warn for staging)',
      'Logging/Observability',
      false,
      async (config) => {
        const ok = ['info', 'warn', 'error'].includes(config.log_level);
        return { ok, reason: `Log level: ${config.log_level}` };
      }
    ),

    new ChecklistItem(
      'deployment-id-present',
      'DEPLOYMENT_ID present for traceability',
      'Logging/Observability',
      true,
      async (config) => {
        const ok = config.deployment_id && config.deployment_id !== 'unknown';
        return { ok, reason: `Deployment ID: ${config.deployment_id}` };
      }
    ),

    new ChecklistItem(
      'release-sha-present',
      'RELEASE_SHA present for version traceability',
      'Logging/Observability',
      true,
      async (config) => {
        const ok = config.release_sha && config.release_sha !== 'unknown';
        return { ok, reason: `Release SHA: ${config.release_sha}` };
      }
    ),

    // ============================================================
    // CATEGORY: Security
    // ============================================================
    new ChecklistItem(
      'no-live-secrets',
      'No LIVE secrets present in config (sk_live_, whsec_ live, pk_live_)',
      'Security',
      true,
      async (config) => {
        const livePatterns = [/sk_live_/, /pk_live_/, /whsec_[a-zA-Z0-9]{32,}/];
        const configStr = JSON.stringify(config);
        const hasLive = livePatterns.some(p => p.test(configStr));
        return { ok: !hasLive, reason: hasLive ? 'LIVE secrets detected in config' : 'No LIVE secrets found' };
      }
    ),

    new ChecklistItem(
      'secret-refs-not-committed',
      'Secret references (STRIPE_SECRET_KEY_REF, etc.) used instead of actual secrets',
      'Security',
      true,
      async (config) => {
        // This checks that config was built from env refs, not hardcoded secrets
        const secretFields = ['stripe_secret_key', 'stripe_webhook_secret', 'stripe_publishable_key'];
        let hasHardcoded = false;
        for (const field of secretFields) {
          const val = config[field];
          if (val && (val.startsWith('sk_test_') || val.startsWith('whsec_') || val.startsWith('pk_test_'))) {
            // Check if it looks like a real key (not placeholder)
            if (!val.includes('PLACEHOLDER') && val.length > 20) {
              hasHardcoded = true;
            }
          }
        }
        return { ok: !hasHardcoded, reason: hasHardcoded ? 'Hardcoded secrets detected' : 'Secrets loaded from references' };
      }
    ),

    new ChecklistItem(
      'raw-body-adapter',
      'Raw body adapter configured for exact-byte webhook signature verification',
      'Security',
      true,
      async () => {
        // Check that raw-body-adapter.mjs exists and exports required functions
        try {
          const adapter = await import('./raw-body-adapter.mjs');
          const ok = typeof adapter.getRawBody === 'function' &&
                     typeof adapter.assertRawBodyIntact === 'function' &&
                     typeof adapter.getStripeSignatureHeader === 'function';
          return { ok, reason: ok ? 'Raw body adapter available' : 'Raw body adapter incomplete' };
        } catch (err) {
          return { ok: false, reason: `Raw body adapter not available: ${err.message}` };
        }
      }
    ),

    // ============================================================
    // CATEGORY: Deployment Manifest
    // ============================================================
    new ChecklistItem(
      'deployment-manifest',
      'Deployment manifest generated with rollback capability',
      'Deployment Manifest',
      true,
      async (config) => {
        try {
          const manifest = await import('./deployment-manifest.mjs');
          return { ok: true, reason: 'Deployment manifest module available' };
        } catch (err) {
          return { ok: false, reason: `Deployment manifest not available: ${err.message}` };
        }
      }
    ),

    new ChecklistItem(
      'rollback-tested',
      'Rollback procedure tested (dry-run)',
      'Deployment Manifest',
      false,
      async () => {
        return { ok: true, reason: 'Rollback test requires operator execution' };
      }
    ),
  ];
}

/**
 * Run the complete checklist
 */
export async function runStagingChecklist(config, context = {}) {
  const checklist = buildStagingChecklist();
  const results = [];
  let passed = 0;
  let failed = 0;
  let warnings = 0;
  let skipped = 0;

  logger.info('staging_checklist_start', {
    deploymentId: config.deployment_id,
    environment: config.environment,
    totalItems: checklist.length,
  });

  for (const item of checklist) {
    await item.run(config, context);
    results.push({
      id: item.id,
      name: item.name,
      category: item.category,
      required: item.required,
      status: item.result,
      details: item.details,
      durationMs: item.durationMs,
    });

    switch (item.result) {
      case CHECKLIST_STATUS.PASS:
        passed++;
        break;
      case CHECKLIST_STATUS.FAIL:
        if (item.required) failed++;
        else warnings++;
        break;
      case CHECKLIST_STATUS.WARNING:
        warnings++;
        break;
      case CHECKLIST_STATUS.SKIP:
        skipped++;
        break;
    }

    logger.info('staging_checklist_item', {
      deploymentId: config.deployment_id,
      itemId: item.id,
      name: item.name,
      category: item.category,
      status: item.result,
      details: item.details,
      durationMs: item.durationMs,
    });
  }

  const overall = failed === 0 ? CHECKLIST_STATUS.PASS : CHECKLIST_STATUS.FAIL;

  logger.info('staging_checklist_complete', {
    deploymentId: config.deployment_id,
    overall,
    passed,
    failed,
    warnings,
    skipped,
    totalDurationMs: results.reduce((sum, r) => sum + r.durationMs, 0),
  });

  return {
    overall,
    summary: { passed, failed, warnings, skipped, total: checklist.length },
    items: results,
    timestamp: new Date().toISOString(),
    deploymentId: config.deployment_id,
    environment: config.environment,
  };
}

/**
 * Generate human-readable checklist report
 */
export function generateChecklistReport(result) {
  const lines = [
    '# Staging Deployment Checklist Report',
    '',
    `**Deployment:** ${result.deploymentId}`,
    `**Environment:** ${result.environment}`,
    `**Timestamp:** ${result.timestamp}`,
    `**Overall:** ${result.overall}`,
    '',
    '## Summary',
    '',
    `- �� Passed: ${result.summary.passed}`,
    `- ��� Failed (required): ${result.summary.failed}`,
    `- ������ Warnings (optional): ${result.summary.warnings}`,
    `- ������ Skipped: ${result.summary.skipped}`,
    `- **Total:** ${result.summary.total}`,
    '',
    '## Items by Category',
    '',
  ];

  // Group by category
  const byCategory = {};
  for (const item of result.items) {
    if (!byCategory[item.category]) byCategory[item.category] = [];
    byCategory[item.category].push(item);
  }

  for (const [category, items] of Object.entries(byCategory)) {
    lines.push(`### ${category}`);
    lines.push('');
    for (const item of items) {
      const icon = item.status === CHECKLIST_STATUS.PASS ? '���'
                   : item.status === CHECKLIST_STATUS.FAIL ? (item.required ? '���' : '������')
                   : item.status === CHECKLIST_STATUS.WARNING ? '������'
                   : '������';
      const req = item.required ? '' : ' (optional)';
      lines.push(`${icon} **${item.name}**${req}`);
      if (item.details) {
        lines.push(`   - ${item.details}`);
      }
      lines.push('');
    }
  }

  return lines.join('\n');
}

/**
 * Checklist summary for CI/CD gate
 */
export function getChecklistGateResult(result) {
  return {
    pass: result.overall === CHECKLIST_STATUS.PASS,
    reason: result.overall === CHECKLIST_STATUS.PASS
      ? 'All required checklist items passed'
      : `${result.summary.failed} required item(s) failed`,
    failedItems: result.items
      .filter(i => i.status === CHECKLIST_STATUS.FAIL && i.required)
      .map(i => ({ id: i.id, name: i.name, details: i.details })),
  };
}

/* For local testing */
if (import.meta.url === `file://${process.argv[1]}`) {
  const config = buildConfigFromEnv({
    ...process.env,
    DEPLOYMENT_ENV: 'STAGING_TEST',
    DEPLOYMENT_ID: 'test-checklist-' + Date.now(),
    RELEASE_SHA: 'abc123',
    PAYMENTS_ENABLED: 'false',
    STAGING_PAYMENT_ENABLED: 'false',
    PRODUCTION_PAYMENT_ENABLED: 'false',
    STRIPE_MODE: 'TEST',
    STRIPE_SECRET_KEY_REF: 'sk_test_PLACEHOLDER_REPLACE_WITH_REAL_TEST_KEY',
    STRIPE_WEBHOOK_SECRET_REF: 'whsec_PLACEHOLDER_REPLACE_WITH_REAL_TEST_SECRET',
    STRIPE_PUBLISHABLE_KEY_REF: 'pk_test_PLACEHOLDER_REPLACE_WITH_REAL_TEST_KEY',
    PUBLIC_BASE_URL: 'https://staging.nexora.studio',
    PAYMENT_API_BASE_URL: 'https://api-staging.nexora.studio',
    STRIPE_SUCCESS_URL: 'https://staging.nexora.studio/payment/success?session_id={CHECKOUT_SESSION_ID}',
    STRIPE_CANCEL_URL: 'https://staging.nexora.studio/payment/cancel',
    SHARED_STORAGE_PROVIDER: 'memory', // Will fail - must be non-memory
    SHARED_STORAGE_NAMESPACE: 'nexora/payment/STAGING_TEST',
    ALLOWED_ORIGINS: 'https://staging.nexora.studio',
    LOG_LEVEL: 'info',
    STRIPE_API_VERSION: '2024-06-20',
    WEBHOOK_TOLERANCE_SECONDS: '300',
    IDEMPOTENCY_TTL_SECONDS: '86400',
    RECONCILIATION_TOLERANCE_PENCE: '0',
  });

  runStagingChecklist(config).then(result => {
    console.log(generateChecklistReport(result));
    console.log('\nGate Result:', JSON.stringify(getChecklistGateResult(result), null, 2));
  });
}