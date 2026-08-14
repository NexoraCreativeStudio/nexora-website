/* Nexora — Safe API Error Contract (PROP.14)
   Standardized error responses for payment endpoints.
   No stack traces or internal paths in deployed responses. */

export const ERROR_CODES = {
  // Validation
  INVALID_REQUEST: 'INVALID_REQUEST',
  MISSING_REQUIRED_FIELD: 'MISSING_REQUIRED_FIELD',
  INVALID_FIELD_FORMAT: 'INVALID_FIELD_FORMAT',
  INVALID_JSON: 'INVALID_JSON',
  REQUEST_TOO_LARGE: 'REQUEST_TOO_LARGE',

  // Authorization
  UNAUTHORIZED: 'UNAUTHORIZED',
  FORBIDDEN: 'FORBIDDEN',
  TOKEN_EXPIRED: 'TOKEN_EXPIRED',
  TOKEN_USED: 'TOKEN_USED',
  TOKEN_NOT_FOUND: 'TOKEN_NOT_FOUND',
  INVOICE_NOT_PAYABLE: 'INVOICE_NOT_PAYABLE',

  // Session
  SESSION_NOT_FOUND: 'SESSION_NOT_FOUND',
  SESSION_EXPIRED: 'SESSION_EXPIRED',
  SESSION_INVALID_STATE: 'SESSION_INVALID_STATE',

  // Payment
  CHECKOUT_CREATION_FAILED: 'CHECKOUT_CREATION_FAILED',
  PAYMENT_NOT_FOUND: 'PAYMENT_NOT_FOUND',
  AMOUNT_MISMATCH: 'AMOUNT_MISMATCH',
  CURRENCY_MISMATCH: 'CURRENCY_MISMATCH',

  // Webhook
  WEBHOOK_SIGNATURE_INVALID: 'WEBHOOK_SIGNATURE_INVALID',
  WEBHOOK_PAYLOAD_INVALID: 'WEBHOOK_PAYLOAD_INVALID',
  WEBHOOK_DUPLICATE: 'WEBHOOK_DUPLICATE',
  WEBHOOK_UNSUPPORTED_EVENT: 'WEBHOOK_UNSUPPORTED_EVENT',
  WEBHOOK_ENVIRONMENT_MISMATCH: 'WEBHOOK_ENVIRONMENT_MISMATCH',
  WEBHOOK_MISSING_LINEAGE: 'WEBHOOK_MISSING_LINEAGE',

  // Configuration
  CONFIG_INVALID: 'CONFIG_INVALID',
  STAGING_PAYMENTS_DISABLED: 'STAGING_PAYMENTS_DISABLED',
  PRODUCTION_PAYMENTS_DISABLED: 'PRODUCTION_PAYMENTS_DISABLED',
  SHARED_STORAGE_NOT_CONFIGURED: 'SHARED_STORAGE_NOT_CONFIGURED',
  STRIPE_SDK_UNAVAILABLE: 'STRIPE_SDK_UNAVAILABLE',

  // Internal
  INTERNAL_ERROR: 'INTERNAL_ERROR',
  SERVICE_UNAVAILABLE: 'SERVICE_UNAVAILABLE',
};

/* Safe error response schema */
export function createErrorResponse(code, message, requestId, details = null) {
  const response = {
    error: {
      code,
      message: sanitizeMessage(message),
      request_id: requestId,
    },
  };

  if (details && process.env.NODE_ENV !== 'production') {
    response.error.details = sanitizeDetails(details);
  }

  return response;
}

/* Sanitize error message — no internal details */
function sanitizeMessage(message) {
  if (!message || typeof message !== 'string') return 'An error occurred';

  // Remove internal paths, stack traces, secret-like strings
  let sanitized = message
    .replace(/\/[a-zA-Z0-9_\-\/\.]+\.(mjs|js|ts|json)/g, '[internal]')
    .replace(/sk_(live|test)_[a-zA-Z0-9]{24,}/g, '[REDACTED]')
    .replace(/whsec_[a-zA-Z0-9]{32,}/g, '[REDACTED]')
    .replace(/pk_(live|test)_[a-zA-Z0-9]{24,}/g, '[REDACTED]')
    .replace(/acct_[a-zA-Z0-9]{16,}/g, '[REDACTED]');

  // Truncate if too long
  if (sanitized.length > 200) {
    sanitized = sanitized.slice(0, 197) + '...';
  }

  return sanitized;
}

/* Sanitize error details */
function sanitizeDetails(details) {
  if (!details || typeof details !== 'object') return details;

  const sanitized = {};
  for (const [key, value] of Object.entries(details)) {
    if (key === 'stack' || key === 'trace' || key === 'path') continue;
    if (typeof value === 'string') {
      sanitized[key] = sanitizeMessage(value);
    } else if (typeof value === 'object' && value !== null) {
      sanitized[key] = sanitizeDetails(value);
    } else {
      sanitized[key] = value;
    }
  }
  return sanitized;
}

/* Standard error factory */
export const PaymentErrors = {
  invalidRequest: (requestId, details) => createErrorResponse(ERROR_CODES.INVALID_REQUEST, 'Invalid request', requestId, details),
  missingField: (requestId, field) => createErrorResponse(ERROR_CODES.MISSING_REQUIRED_FIELD, `Required field missing: ${field}`, requestId),
  invalidFormat: (requestId, field) => createErrorResponse(ERROR_CODES.INVALID_FIELD_FORMAT, `Invalid format for field: ${field}`, requestId),
  invalidJson: (requestId) => createErrorResponse(ERROR_CODES.INVALID_JSON, 'Invalid JSON payload', requestId),
  requestTooLarge: (requestId) => createErrorResponse(ERROR_CODES.REQUEST_TOO_LARGE, 'Request body too large', requestId),

  unauthorized: (requestId) => createErrorResponse(ERROR_CODES.UNAUTHORIZED, 'Unauthorized', requestId),
  forbidden: (requestId) => createErrorResponse(ERROR_CODES.FORBIDDEN, 'Forbidden', requestId),
  tokenExpired: (requestId) => createErrorResponse(ERROR_CODES.TOKEN_EXPIRED, 'Payment token expired', requestId),
  tokenUsed: (requestId) => createErrorResponse(ERROR_CODES.TOKEN_USED, 'Payment token already used', requestId),
  tokenNotFound: (requestId) => createErrorResponse(ERROR_CODES.TOKEN_NOT_FOUND, 'Payment token not found', requestId),
  invoiceNotPayable: (requestId) => createErrorResponse(ERROR_CODES.INVOICE_NOT_PAYABLE, 'Invoice not payable', requestId),

  sessionNotFound: (requestId) => createErrorResponse(ERROR_CODES.SESSION_NOT_FOUND, 'Payment session not found', requestId),
  sessionExpired: (requestId) => createErrorResponse(ERROR_CODES.SESSION_EXPIRED, 'Payment session expired', requestId),
  sessionInvalidState: (requestId, state) => createErrorResponse(ERROR_CODES.SESSION_INVALID_STATE, `Invalid session state: ${state}`, requestId),

  checkoutCreationFailed: (requestId) => createErrorResponse(ERROR_CODES.CHECKOUT_CREATION_FAILED, 'Failed to create checkout session', requestId),
  paymentNotFound: (requestId) => createErrorResponse(ERROR_CODES.PAYMENT_NOT_FOUND, 'Payment record not found', requestId),
  amountMismatch: (requestId) => createErrorResponse(ERROR_CODES.AMOUNT_MISMATCH, 'Amount mismatch', requestId),
  currencyMismatch: (requestId) => createErrorResponse(ERROR_CODES.CURRENCY_MISMATCH, 'Currency mismatch', requestId),

  webhookSignatureInvalid: (requestId) => createErrorResponse(ERROR_CODES.WEBHOOK_SIGNATURE_INVALID, 'Webhook signature verification failed', requestId),
  webhookPayloadInvalid: (requestId) => createErrorResponse(ERROR_CODES.WEBHOOK_PAYLOAD_INVALID, 'Invalid webhook payload', requestId),
  webhookDuplicate: (requestId) => createErrorResponse(ERROR_CODES.WEBHOOK_DUPLICATE, 'Duplicate webhook event', requestId),
  webhookUnsupportedEvent: (requestId) => createErrorResponse(ERROR_CODES.WEBHOOK_UNSUPPORTED_EVENT, 'Unsupported webhook event type', requestId),
  webhookEnvironmentMismatch: (requestId) => createErrorResponse(ERROR_CODES.WEBHOOK_ENVIRONMENT_MISMATCH, 'Environment mismatch', requestId),
  webhookMissingLineage: (requestId) => createErrorResponse(ERROR_CODES.WEBHOOK_MISSING_LINEAGE, 'Missing payment lineage in webhook', requestId),

  configInvalid: (requestId, details) => createErrorResponse(ERROR_CODES.CONFIG_INVALID, 'Configuration invalid', requestId, details),
  stagingPaymentsDisabled: (requestId) => createErrorResponse(ERROR_CODES.STAGING_PAYMENTS_DISABLED, 'Staging payments disabled', requestId),
  productionPaymentsDisabled: (requestId) => createErrorResponse(ERROR_CODES.PRODUCTION_PAYMENTS_DISABLED, 'Production payments disabled', requestId),
  sharedStorageNotConfigured: (requestId) => createErrorResponse(ERROR_CODES.SHARED_STORAGE_NOT_CONFIGURED, 'Shared storage not configured', requestId),
  stripeSdkUnavailable: (requestId) => createErrorResponse(ERROR_CODES.STRIPE_SDK_UNAVAILABLE, 'Stripe SDK unavailable', requestId),

  internalError: (requestId) => createErrorResponse(ERROR_CODES.INTERNAL_ERROR, 'Internal server error', requestId),
  serviceUnavailable: (requestId) => createErrorResponse(ERROR_CODES.SERVICE_UNAVAILABLE, 'Service temporarily unavailable', requestId),
};

/* HTTP status code mapping */
export const ERROR_STATUS_CODES = {
  [ERROR_CODES.INVALID_REQUEST]: 400,
  [ERROR_CODES.MISSING_REQUIRED_FIELD]: 400,
  [ERROR_CODES.INVALID_FIELD_FORMAT]: 400,
  [ERROR_CODES.INVALID_JSON]: 400,
  [ERROR_CODES.REQUEST_TOO_LARGE]: 413,

  [ERROR_CODES.UNAUTHORIZED]: 401,
  [ERROR_CODES.FORBIDDEN]: 403,
  [ERROR_CODES.TOKEN_EXPIRED]: 410,
  [ERROR_CODES.TOKEN_USED]: 410,
  [ERROR_CODES.TOKEN_NOT_FOUND]: 404,
  [ERROR_CODES.INVOICE_NOT_PAYABLE]: 403,

  [ERROR_CODES.SESSION_NOT_FOUND]: 404,
  [ERROR_CODES.SESSION_EXPIRED]: 410,
  [ERROR_CODES.SESSION_INVALID_STATE]: 400,

  [ERROR_CODES.CHECKOUT_CREATION_FAILED]: 500,
  [ERROR_CODES.PAYMENT_NOT_FOUND]: 404,
  [ERROR_CODES.AMOUNT_MISMATCH]: 400,
  [ERROR_CODES.CURRENCY_MISMATCH]: 400,

  [ERROR_CODES.WEBHOOK_SIGNATURE_INVALID]: 400,
  [ERROR_CODES.WEBHOOK_PAYLOAD_INVALID]: 400,
  [ERROR_CODES.WEBHOOK_DUPLICATE]: 200, // Return 200 for duplicate to stop retries
  [ERROR_CODES.WEBHOOK_UNSUPPORTED_EVENT]: 200,
  [ERROR_CODES.WEBHOOK_ENVIRONMENT_MISMATCH]: 400,
  [ERROR_CODES.WEBHOOK_MISSING_LINEAGE]: 400,

  [ERROR_CODES.CONFIG_INVALID]: 500,
  [ERROR_CODES.STAGING_PAYMENTS_DISABLED]: 503,
  [ERROR_CODES.PRODUCTION_PAYMENTS_DISABLED]: 503,
  [ERROR_CODES.SHARED_STORAGE_NOT_CONFIGURED]: 503,
  [ERROR_CODES.STRIPE_SDK_UNAVAILABLE]: 503,

  [ERROR_CODES.INTERNAL_ERROR]: 500,
  [ERROR_CODES.SERVICE_UNAVAILABLE]: 503,
};

/* Send error response */
export function sendErrorResponse(res, code, requestId, details = null) {
  const statusCode = ERROR_STATUS_CODES[code] || 500;
  const response = PaymentErrors[code.toLowerCase().replace(/_/g, '')](requestId, details) ||
                   createErrorResponse(code, 'Error', requestId, details);
  res.setHeader('Content-Type', 'application/json');
  res.setHeader('Cache-Control', 'no-store');
  return res.status(statusCode).json(response);
}