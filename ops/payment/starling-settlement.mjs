/* Nexora — Starling Settlement Contract (PROP.10)
   Governed configuration model for bank settlement destination.
   All values are environment references only — never committed. */

export const STARLING_SETTLEMENT_SCHEMA = 'nexora-starling-settlement/v1';

/* Required configuration keys — populated from environment/platform secret manager.
   Real bank details never committed. */
export const STARLING_SETTLEMENT_KEYS = [
  'BANK_PROVIDER',                // 'STARLING'
  'ACCOUNT_TYPE',                 // 'BUSINESS'
  'COUNTRY',                      // 'GB'
  'SETTLEMENT_CURRENCY',          // 'GBP'
  'ACCOUNT_HOLDER_REF',           // Legal entity name (env ref)
  'SORT_CODE_REF',                // UK sort code (env ref only)
  'ACCOUNT_NUMBER_REF',           // UK account number (env ref only)
  'VERIFICATION_STATUS',          // 'UNVERIFIED' | 'VERIFIED' | 'PENDING'
  'CONFIGURED_AT',                // ISO timestamp
  'PRODUCTION_ENABLED',           // boolean
];

/* Forbidden patterns in committed files — applied to individual field values, not whole JSON */
export const STARLING_SECRET_PATTERNS = [
  /^\d{6}$/,           // sort code (exact 6 digits)
  /^\d{8}$/,           // account number (exact 8 digits)
  /[A-Z]{2}\d{2}[A-Z0-9]{4}\d{7}/,  // IBAN-like
];

/* Validation */
export function validateStarlingSettlement(config) {
  const reasons = [];
  if (!config || typeof config !== 'object') {
    return { ok: false, reasons: ['config must be an object'] };
  }
  if (config.schema !== STARLING_SETTLEMENT_SCHEMA) {
    reasons.push(`schema must be ${STARLING_SETTLEMENT_SCHEMA}`);
  }
  if (config.bank_provider !== 'STARLING') {
    reasons.push('bank_provider must be "STARLING"');
  }
  if (config.account_type !== 'BUSINESS') {
    reasons.push('account_type must be "BUSINESS"');
  }
  if (config.country !== 'GB') {
    reasons.push('country must be "GB"');
  }
  if (config.settlement_currency !== 'GBP') {
    reasons.push('settlement_currency must be "GBP"');
  }
  if (config.production_enabled === true && config.verification_status !== 'VERIFIED') {
    reasons.push('production_enabled requires verification_status: "VERIFIED"');
  }
  // Scan for real-looking bank details in individual fields
  const sensitiveFields = ['sort_code_ref', 'account_number_ref', 'iban_ref'];
  for (const field of sensitiveFields) {
    const value = config[field];
    if (typeof value === 'string') {
      for (const pattern of STARLING_SECRET_PATTERNS) {
        if (pattern.test(value)) {
          reasons.push(`field ${field} appears to contain real bank details — forbidden in committed config`);
          break;
        }
      }
    }
  }
  return { ok: reasons.length === 0, reasons };
}

/* Example synthetic config (never committed with real values) */
export const STARLING_TEST_CONFIG_EXAMPLE = {
  schema: STARLING_SETTLEMENT_SCHEMA,
  bank_provider: 'STARLING',
  account_type: 'BUSINESS',
  country: 'GB',
  settlement_currency: 'GBP',
  account_holder_ref: 'NEXORA_CREATIVE_STUDIO_LTD',
  sort_code_ref: 'REPLACE_WITH_REAL_SORT_CODE',
  account_number_ref: 'REPLACE_WITH_REAL_ACCOUNT_NUMBER',
  verification_status: 'UNVERIFIED',
  configured_at: '2026-08-12T00:00:00.000Z',
  production_enabled: false,
  _example: true,
};

/* BOUNDARY CLARIFICATION:
   - Starling is the PAYOUT DESTINATION (bank settlement).
   - Starling does NOT determine invoice/payment state.
   - Stripe provider evidence + PROP.9 reconciliation determine payment state (PAID).
   - Payout reconciliation is a SEPARATE governed process (Stripe payout -> bank credit).
   - Customer PAID ≠ Stripe payout received ≠ Bank credit received. */