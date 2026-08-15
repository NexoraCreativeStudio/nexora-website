/* Nexora — Structured Logging (PROP.14)
   Deployment-safe logger with redaction for secrets, PII, and sensitive data. */

import { createHash } from 'node:crypto';

/* Log levels */
export const LOG_LEVELS = {
  debug: 0,
  info: 1,
  warn: 2,
  error: 3,
};

/* Default log level */
export const DEFAULT_LOG_LEVEL = 'info';

/* Fields that must be redacted in logs */
export const REDACTED_FIELDS = new Set([
  // Secrets
  'stripe_secret_key', 'stripe_webhook_secret', 'stripe_publishable_key',
  'shared_storage_url', 'shared_storage_token', 'shared_storage_token_ref',
  'secret', 'password', 'api_key', 'api_secret', 'private_key',
  'authorization', 'cookie', 'set-cookie', 'x-api-key',

  // Banking / Financial
  'account_number', 'sort_code', 'iban', 'swift', 'bic',
  'bank_account', 'bank_details', 'routing_number', 'account_name',

  // PII
  'email', 'phone', 'address', 'postcode', 'zipcode', 'dob', 'date_of_birth',
  'first_name', 'last_name', 'full_name', 'customer_name',
  'payer_email', 'payer_phone', 'card_number', 'card_last4', 'card_brand',

  // Stripe sensitive
  'client_secret', 'payment_method', 'setup_intent_secret', 'setup_intent_client_secret',
  'payment_intent_client_secret', 'ephemeral_key_secret',

  // Raw webhook
  'raw_payload', 'raw_body', 'webhook_payload',
]);

/* Create a redaction function */
function createRedactor(additionalFields = []) {
  const fieldsToRedact = new Set([...REDACTED_FIELDS, ...additionalFields]);

  function redactValue(value, key = '') {
    if (value === null || value === undefined) return value;

    // Check if key matches redacted field
    if (typeof key === 'string' && fieldsToRedact.has(key.toLowerCase())) {
      return '[REDACTED]';
    }

    // Recursively redact objects
    if (typeof value === 'object') {
      if (Array.isArray(value)) {
        return value.map(v => redactValue(v, key));
      }
      const redacted = {};
      for (const [k, v] of Object.entries(value)) {
        redacted[k] = redactValue(v, k);
      }
      return redacted;
    }

    return value;
  }

  return redactValue;
}

/* Generate correlation/request ID */
export function generateCorrelationId(prefix = 'req') {
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  return `${prefix}-${Buffer.from(bytes).toString('base64url')}`;
}

/* Safe logger class */
export class SafeLogger {
  constructor(opts = {}) {
    this.level = opts.level || DEFAULT_LOG_LEVEL;
    this.deploymentId = opts.deploymentId || 'unknown';
    this.environment = opts.environment || 'LOCAL_TEST';
    this.redactor = createRedactor(opts.additionalRedactedFields);
    this.output = opts.output || console;
  }

  /* Check if level is enabled */
  isEnabled(level) {
    return LOG_LEVELS[level] >= LOG_LEVELS[this.level];
  }

  /* Base log method */
  log(level, event, data = {}) {
    if (!this.isEnabled(level)) return;

    const timestamp = new Date().toISOString();
    const logEntry = {
      timestamp,
      level,
      event,
      deployment_id: this.deploymentId,
      environment: this.environment,
      ...this.redactor(data),
    };

    // Use appropriate console method
    const method = this.output[level] || this.output.log;
    method.call(this.output, JSON.stringify(logEntry));
  }

  debug(event, data) { this.log('debug', event, data); }
  info(event, data) { this.log('info', event, data); }
  warn(event, data) { this.log('warn', event, data); }
  error(event, data) { this.log('error', data); }

  /* Payment-specific log helpers */
  logCheckoutCreated(data) {
    this.info('checkout_created', {
      correlation_id: data.correlationId,
      session_id: data.sessionId,
      payment_request_id: data.paymentRequestId,
      amount: data.amount,
      currency: data.currency,
    });
  }

  logCustomerRedirected(data) {
    this.info('customer_redirected', {
      correlation_id: data.correlationId,
      session_id: data.sessionId,
      checkout_session_id: data.checkoutSessionId,
    });
  }

  logWebhookReceived(data) {
    this.info('webhook_received', {
      correlation_id: data.correlationId,
      event_id: data.eventId,
      event_type: data.eventType,
      provider: data.provider,
      invoice_id: data.invoiceId,
      payment_request_id: data.paymentRequestId,
      amount: data.amount,
      currency: data.currency,
      verification_outcome: data.verificationOutcome,
    });
  }

  logWebhookProcessed(data) {
    this.info('webhook_processed', {
      correlation_id: data.correlationId,
      event_id: data.eventId,
      event_type: data.eventType,
      reconciliation_outcome: data.reconciliationOutcome,
      payment_id: data.paymentId,
    });
  }

  logWebhookNormalizationFailed(data) {
    this.warn('webhook_normalization_failed', {
      correlation_id: data.correlationId,
      reasons: data.reasons,
    });
  }

  logReconciliation(data) {
    this.info('reconciliation', {
      correlation_id: data.correlationId,
      payment_id: data.paymentId,
      invoice_id: data.invoiceId,
      outcome: data.outcome,
      amount_expected: data.amountExpected,
      amount_received: data.amountReceived,
    });
  }

  logStatusRetrieved(data) {
    this.info('status_retrieved', {
      correlation_id: data.correlationId,
      session_id: data.sessionId,
      status: data.status,
    });
  }

  logError(data) {
    this.error('error', {
      correlation_id: data.correlationId,
      error_code: data.errorCode,
      message: data.message,
      context: data.context,
    });
  }

  logConfigValidation(data) {
    this.info('config_validation', {
      correlation_id: data.correlationId,
      environment: data.environment,
      valid: data.valid,
      reasons: data.reasons,
    });
  }

  logHealthCheck(data) {
    this.info('health_check', {
      correlation_id: data.correlationId,
      status: data.status,
      checks: data.checks,
    });
  }

  logReadinessCheck(data) {
    this.info('readiness_check', {
      correlation_id: data.correlationId,
      ready: data.ready,
      reasons: data.reasons,
    });
  }

  logKillSwitch(data) {
    this.warn('kill_switch', {
      correlation_id: data.correlationId,
      gate: data.gate,
      enabled: data.enabled,
      action: data.action,
    });
  }

  logRequestComplete(data) {
    this.info('request_complete', {
      correlation_id: data.correlationId,
      method: data.method,
      path: data.path,
      status: data.status,
      duration_ms: data.duration_ms,
    });
  }

  logSessionNotFound(data) {
    this.info('session_not_found', {
      correlation_id: data.correlationId,
      session_id: data.sessionId,
    });
  }
}

/* Default logger instance */
let defaultLogger = null;

export function getDefaultLogger() {
  if (!defaultLogger) {
    defaultLogger = new SafeLogger({
      level: process.env.LOG_LEVEL || DEFAULT_LOG_LEVEL,
      deploymentId: process.env.DEPLOYMENT_ID || 'unknown',
      environment: process.env.DEPLOYMENT_ENV || 'LOCAL_TEST',
    });
  }
  return defaultLogger;
}

export function setDefaultLogger(logger) {
  defaultLogger = logger;
}