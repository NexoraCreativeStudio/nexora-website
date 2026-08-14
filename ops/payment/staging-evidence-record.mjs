/* Nexora — Staging Evidence Record (PROP.15 §17)
   Immutable audit record of STAGING_TEST deployment evidence.
   Captures: config snapshot, checklist results, operator sign-off, timestamps. */

import { createHash } from 'node:crypto';
import { DEPLOYMENT_ENVIRONMENTS, safeConfigForLogging, buildConfigFromEnv } from './deployment-config.mjs';
import { getDefaultLogger } from './structured-logging.mjs';

const logger = getDefaultLogger();

/**
 * Evidence record schema version
 */
export const EVIDENCE_RECORD_SCHEMA = 'nexora-staging-evidence/v1';

/**
 * Evidence record status
 */
export const EVIDENCE_STATUS = {
  PENDING: 'PENDING',           // Evidence being collected
  COMPLETE: 'COMPLETE',         // All evidence collected, awaiting sign-off
  SIGNED_OFF: 'SIGNED_OFF',     // Operator signed off
  REJECTED: 'REJECTED',         // Evidence rejected, requires re-deployment
  ARCHIVED: 'ARCHIVED',         // Historical record
};

/**
 * Create a new evidence record
 */
export function createEvidenceRecord(config, operatorId = 'system') {
  const safeConfig = safeConfigForLogging(config);
  const deploymentId = config.deployment_id;
  const timestamp = new Date().toISOString();
  const recordId = generateRecordId(deploymentId);

  return {
    schema: EVIDENCE_RECORD_SCHEMA,
    record_id: recordId,
    deployment_id: deploymentId,
    environment: config.environment,
    release_sha: config.release_sha,
    status: EVIDENCE_STATUS.PENDING,
    created_at: timestamp,
    updated_at: timestamp,
    operator_id: operatorId,

    // Configuration snapshot (secrets redacted)
    config_snapshot: safeConfig,

    // Evidence sections (populated during deployment)
    evidence: {
      checklist: null,           // Checklist results
      connectivity: null,        // Storage/Stripe connectivity proofs
      health_endpoint: null,     // /api/payment/health response
      readiness_endpoint: null,  // /api/payment/readiness response
      webhook_verification: null,// Webhook verification test results
      checkout_test: null,       // Test checkout creation result
      reconciliation_test: null, // Test reconciliation result
      rollback_test: null,       // Rollback dry-run result
    },

    // Operator sign-off
    sign_off: null,

    // Integrity hash (computed on finalization)
    integrity_hash: null,
  };
}

/**
 * Generate unique record ID
 */
function generateRecordId(deploymentId) {
  const timestamp = Date.now().toString(36);
  const random = Math.random().toString(36).substring(2, 8);
  return `ev-${deploymentId}-${timestamp}-${random}`;
}

/**
 * Update evidence section
 */
export function updateEvidenceSection(record, section, data) {
  if (!record.evidence[section]) {
    record.evidence[section] = {};
  }
  record.evidence[section] = {
    ...record.evidence[section],
    ...data,
    captured_at: new Date().toISOString(),
  };
  record.updated_at = new Date().toISOString();
  return record;
}

/**
 * Add checklist results to evidence
 */
export function addChecklistEvidence(record, checklistResult) {
  return updateEvidenceSection(record, 'checklist', {
    overall: checklistResult.overall,
    summary: checklistResult.summary,
    items: checklistResult.items.map(item => ({
      id: item.id,
      name: item.name,
      category: item.category,
      required: item.required,
      status: item.status,
      details: item.details,
      durationMs: item.durationMs,
    })),
    gate_result: {
      pass: checklistResult.overall === 'PASS',
      failed_required: checklistResult.items.filter(i => i.status === 'FAIL' && i.required).length,
    },
  });
}

/**
 * Add connectivity test evidence
 */
export function addConnectivityEvidence(record, storageResult, stripeResult) {
  return updateEvidenceSection(record, 'connectivity', {
    shared_storage: storageResult,
    stripe_api: stripeResult,
  });
}

/**
 * Add health endpoint evidence
 */
export function addHealthEvidence(record, healthResponse) {
  return updateEvidenceSection(record, 'health_endpoint', {
    status: healthResponse.status,
    checks: healthResponse.checks,
    collection_enabled: healthResponse.collection_enabled,
    kill_switches: healthResponse.kill_switches,
  });
}

/**
 * Add readiness endpoint evidence
 */
export function addReadinessEvidence(record, readinessResponse) {
  return updateEvidenceSection(record, 'readiness_endpoint', {
    ready: readinessResponse.ready,
    checks: readinessResponse.checks,
    collection_enabled: readinessResponse.collection_enabled,
    kill_switches: readinessResponse.kill_switches,
    reasons: readinessResponse.reasons,
    state: readinessResponse.state,
  });
}

/**
 * Add webhook verification test evidence
 */
export function addWebhookVerificationEvidence(record, testResult) {
  return updateEvidenceSection(record, 'webhook_verification', {
    test_event_type: testResult.eventType,
    signature_verified: testResult.verified,
    verifier_type: testResult.verifierType,
    tolerance_seconds: testResult.toleranceSeconds,
    processing_time_ms: testResult.processingTimeMs,
  });
}

/**
 * Add test checkout creation evidence
 */
export function addCheckoutTestEvidence(record, testResult) {
  return updateEvidenceSection(record, 'checkout_test', {
    success: testResult.ok,
    checkout_session_id: testResult.checkout_session_id,
    portal_session_id: testResult.portal_session_id,
    checkout_url_present: !!testResult.checkout_url,
    expires_at: testResult.expires_at,
    environment: testResult.environment,
    stripe_mode: testResult.stripe_mode,
    processing_time_ms: testResult.processingTimeMs,
    error: testResult.error || null,
  });
}

/**
 * Add reconciliation test evidence
 */
export function addReconciliationTestEvidence(record, testResult) {
  return updateEvidenceSection(record, 'reconciliation_test', {
    success: testResult.ok,
    reconciliation_outcome: testResult.outcome,
    amount_match: testResult.amountMatch,
    currency_match: testResult.currencyMatch,
    invoice_match: testResult.invoiceMatch,
    payment_request_match: testResult.paymentRequestMatch,
    tolerance_pence: testResult.tolerancePence,
    processing_time_ms: testResult.processingTimeMs,
    error: testResult.error || null,
  });
}

/**
 * Add rollback test evidence
 */
export function addRollbackTestEvidence(record, testResult) {
  return updateEvidenceSection(record, 'rollback_test', {
    success: testResult.ok,
    rollback_type: testResult.type, // 'config' | 'data' | 'full'
    previous_state_restored: testResult.previousStateRestored,
    data_integrity_verified: testResult.dataIntegrityVerified,
    rollback_time_ms: testResult.rollbackTimeMs,
    error: testResult.error || null,
  });
}

/**
 * Record operator sign-off
 */
export function recordSignOff(record, operatorId, decision, notes = '') {
  const signOff = {
    operator_id: operatorId,
    decision, // 'APPROVE' | 'REJECT'
    notes,
    timestamp: new Date().toISOString(),
  };

  record.sign_off = signOff;
  record.status = decision === 'APPROVE' ? EVIDENCE_STATUS.SIGNED_OFF : EVIDENCE_STATUS.REJECTED;
  record.updated_at = signOff.timestamp;

  // Compute integrity hash after sign-off
  record.integrity_hash = computeIntegrityHash(record);

  logger.info('evidence_sign_off', {
    recordId: record.record_id,
    deploymentId: record.deployment_id,
    operatorId,
    decision,
    integrityHash: record.integrity_hash,
  });

  return record;
}

/**
 * Compute integrity hash of evidence record (excluding the hash itself)
 */
export function computeIntegrityHash(record) {
  const copy = { ...record };
  delete copy.integrity_hash;
  const content = JSON.stringify(copy, Object.keys(copy).sort());
  return createHash('sha256').update(content).digest('hex');
}

/**
 * Verify integrity hash
 */
export function verifyIntegrityHash(record) {
  if (!record.integrity_hash) return { ok: false, reason: 'No integrity hash present' };
  const computed = computeIntegrityHash(record);
  return {
    ok: computed === record.integrity_hash,
    computed,
    stored: record.integrity_hash,
  };
}

/**
 * Finalize evidence record (compute hash, set status to COMPLETE)
 */
export function finalizeEvidenceRecord(record) {
  record.status = EVIDENCE_STATUS.COMPLETE;
  record.updated_at = new Date().toISOString();
  record.integrity_hash = computeIntegrityHash(record);
  return record;
}

/**
 * Archive evidence record
 */
export function archiveEvidenceRecord(record) {
  record.status = EVIDENCE_STATUS.ARCHIVED;
  record.updated_at = new Date().toISOString();
  return record;
}

/**
 * Validate evidence record structure
 */
export function validateEvidenceRecord(record) {
  const reasons = [];

  if (!record || typeof record !== 'object') {
    return { ok: false, reasons: ['Record must be an object'] };
  }

  if (record.schema !== EVIDENCE_RECORD_SCHEMA) {
    reasons.push(`Schema must be ${EVIDENCE_RECORD_SCHEMA}`);
  }

  if (!record.record_id || !record.record_id.startsWith('ev-')) {
    reasons.push('Invalid record_id format');
  }

  if (!record.deployment_id) {
    reasons.push('Missing deployment_id');
  }

  if (!Object.values(DEPLOYMENT_ENVIRONMENTS).includes(record.environment)) {
    reasons.push(`Invalid environment: ${record.environment}`);
  }

  if (!record.release_sha) {
    reasons.push('Missing release_sha');
  }

  if (!Object.values(EVIDENCE_STATUS).includes(record.status)) {
    reasons.push(`Invalid status: ${record.status}`);
  }

  if (!record.config_snapshot) {
    reasons.push('Missing config_snapshot');
  }

  if (!record.evidence || typeof record.evidence !== 'object') {
    reasons.push('Missing evidence object');
  }

  if (!record.created_at || !record.updated_at) {
    reasons.push('Missing timestamps');
  }

  // If signed off, must have sign_off and integrity_hash
  if (record.status === EVIDENCE_STATUS.SIGNED_OFF) {
    if (!record.sign_off) reasons.push('Missing sign_off for SIGNED_OFF status');
    if (!record.integrity_hash) reasons.push('Missing integrity_hash for SIGNED_OFF status');
    else {
      const verify = verifyIntegrityHash(record);
      if (!verify.ok) reasons.push('Integrity hash verification failed');
    }
  }

  return { ok: reasons.length === 0, reasons };
}

/**
 * Generate human-readable evidence report
 */
export function generateEvidenceReport(record) {
  const lines = [
    '# Staging Deployment Evidence Record',
    '',
    `**Record ID:** ${record.record_id}`,
    `**Deployment ID:** ${record.deployment_id}`,
    `**Environment:** ${record.environment}`,
    `**Release SHA:** ${record.release_sha}`,
    `**Status:** ${record.status}`,
    `**Created:** ${record.created_at}`,
    `**Updated:** ${record.updated_at}`,
    `**Operator:** ${record.operator_id}`,
    '',
    '## Configuration Snapshot (Secrets Redacted)',
    '',
    '```json',
    JSON.stringify(record.config_snapshot, null, 2),
    '```',
    '',
    '## Evidence Sections',
    '',
  ];

  const evidence = record.evidence || {};
  for (const [section, data] of Object.entries(evidence)) {
    if (!data) continue;
    lines.push(`### ${section.replace('_', ' ').toUpperCase()}`);
    lines.push('');
    lines.push('```json');
    lines.push(JSON.stringify(data, null, 2));
    lines.push('```');
    lines.push('');
  }

  if (record.sign_off) {
    lines.push('## Operator Sign-Off');
    lines.push('');
    lines.push(`- **Operator:** ${record.sign_off.operator_id}`);
    lines.push(`- **Decision:** ${record.sign_off.decision}`);
    lines.push(`- **Timestamp:** ${record.sign_off.timestamp}`);
    if (record.sign_off.notes) {
      lines.push(`- **Notes:** ${record.sign_off.notes}`);
    }
    lines.push('');
  }

  if (record.integrity_hash) {
    lines.push('## Integrity');
    lines.push('');
    lines.push(`- **SHA-256:** ${record.integrity_hash}`);
    lines.push('');
    const verify = verifyIntegrityHash(record);
    lines.push(`- **Verification:** ${verify.ok ? '✅ VALID' : '❌ INVALID'}`);
    if (!verify.ok) {
      lines.push(`  - Computed: ${verify.computed}`);
      lines.push(`  - Stored: ${verify.stored}`);
    }
    lines.push('');
  }

  return lines.join('\n');
}

/**
 * Minimal evidence record for CI/CD artifact
 */
export function createMinimalEvidenceArtifact(record) {
  return {
    schema: EVIDENCE_RECORD_SCHEMA,
    record_id: record.record_id,
    deployment_id: record.deployment_id,
    environment: record.environment,
    release_sha: record.release_sha,
    status: record.status,
    created_at: record.created_at,
    sign_off: record.sign_off ? {
      operator_id: record.sign_off.operator_id,
      decision: record.sign_off.decision,
      timestamp: record.sign_off.timestamp,
    } : null,
    integrity_hash: record.integrity_hash,
    checklist_overall: record.evidence?.checklist?.overall,
    readiness_ready: record.evidence?.readiness_endpoint?.ready,
    health_healthy: record.evidence?.health_endpoint?.status === 'HEALTHY',
  };
}

/* For local testing */
if (import.meta.url === `file://${process.argv[1]}`) {
  const config = buildConfigFromEnv({
    ...process.env,
    DEPLOYMENT_ENV: 'STAGING_TEST',
    DEPLOYMENT_ID: 'test-evidence-' + Date.now(),
    RELEASE_SHA: 'abc123def456',
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
    SHARED_STORAGE_PROVIDER: 'redis',
    SHARED_STORAGE_NAMESPACE: 'nexora/payment/STAGING_TEST',
    ALLOWED_ORIGINS: 'https://staging.nexora.studio',
    LOG_LEVEL: 'info',
    STRIPE_API_VERSION: '2024-06-20',
    WEBHOOK_TOLERANCE_SECONDS: '300',
    IDEMPOTENCY_TTL_SECONDS: '86400',
    RECONCILIATION_TOLERANCE_PENCE: '0',
  });

  const record = createEvidenceRecord(config, 'test-operator');
  console.log('Created record:', record.record_id);

  // Add mock evidence
  addChecklistEvidence(record, {
    overall: 'PASS',
    summary: { passed: 25, failed: 0, warnings: 2, skipped: 1, total: 28 },
    items: [
      { id: 'config-schema', name: 'Config schema', category: 'Configuration', required: true, status: 'PASS', details: 'OK', durationMs: 5 },
      { id: 'shared-storage-provider', name: 'Storage provider', category: 'Shared Storage', required: true, status: 'PASS', details: 'redis', durationMs: 10 },
    ],
  });

  addHealthEvidence(record, {
    status: 'HEALTHY',
    checks: { runtime: 'alive', config_parseable: true },
    collection_enabled: 'COLLECTION_DISABLED',
    kill_switches: { payments_enabled: false, staging_payment_enabled: false, production_payment_enabled: false },
  });

  addReadinessEvidence(record, {
    ready: false,
    checks: { config_valid: true, stripe_config_valid: true },
    collection_enabled: 'COLLECTION_DISABLED',
    kill_switches: { payments_enabled: false, staging_payment_enabled: false, production_payment_enabled: false },
    reasons: ['STAGING_PAYMENT_ENABLED=false — staging payments disabled'],
    state: 'NOT_READY',
  });

  recordSignOff(record, 'test-operator', 'APPROVE', 'All checks pass, staging deployment approved for smoke testing');

  console.log('\n' + generateEvidenceReport(record));
  console.log('\nMinimal artifact:', JSON.stringify(createMinimalEvidenceArtifact(record), null, 2));
}