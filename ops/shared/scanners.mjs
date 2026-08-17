/* Nexora — Worker-Safe Scanner Suite (PROP.17 HOTFIX12)
   Pure functions, no filesystem access, no Node-only builtins.
   sha256hex uses node:crypto.createHash (allowed via nodejs_compat in wrangler.toml).
   Verbose patterns preserved verbatim from source modules. */

import { createHash } from 'node:crypto';

/* ------------------------------------------------------------------ */
/* Canonical serialisation helpers (local to this module)             */
/* ------------------------------------------------------------------ */
function sortKeys(value) {
  if (Array.isArray(value)) return value.map(sortKeys);
  if (value && typeof value === 'object') {
    const out = {};
    for (const k of Object.keys(value).sort()) out[k] = sortKeys(value[k]);
    return out;
  }
  return value;
}

function canonicalSerialise(value) {
  return JSON.stringify(sortKeys(value));
}

/* ------------------------------------------------------------------ */
/* sha256hex — deterministic SHA-256 hex string                       */
/* ------------------------------------------------------------------ */
export function sha256hex(input) {
  const buf = typeof input === 'string' ? Buffer.from(input, 'utf8') : input;
  return createHash('sha256').update(buf).digest('hex');
}

/* ------------------------------------------------------------------ */
/* collectStrings — extract all string values from an object/array    */
/* ------------------------------------------------------------------ */
export function collectStrings(value, acc = []) {
  if (typeof value === 'string') acc.push(value);
  else if (Array.isArray(value)) for (const v of value) collectStrings(v, acc);
  else if (value && typeof value === 'object') for (const k of Object.keys(value)) collectStrings(value[k], acc);
  return acc;
}

/* ------------------------------------------------------------------ */
/* Legacy commercial vocabulary scanner (frozen obsolete terms)       */
/* Source: ops/documents/document-output.mjs                          */
/* ------------------------------------------------------------------ */
const LEGACY_PATTERNS = [
  /£250/, /£250\s+secures?/i, /\b250\s+deposit\b/i, /\bpay\s+£250\b/i,
  /buy\.stripe\.com/i, /paypal\.com/i, /\bStarter\b/, /\bElite\b/, /\bAI\s+Care\b/i
];

export function scanLegacy(text) {
  const violations = [];
  for (const re of LEGACY_PATTERNS) if (re.test(text)) violations.push(`legacy: ${re}`);
  return violations;
}

/* ------------------------------------------------------------------ */
/* VAT assertion scanner (undetermined tax status)                    */
/* Source: ops/documents/document-output.mjs                          */
/* ------------------------------------------------------------------ */
const VAT_ASSERTIONS = [
  /\bVAT\s+registered\b/i, /\bregistered\s+for\s+VAT\b/i,
  /\b20\s*%\s*VAT\b/i, /\bVAT\s+at\s+\d+\s*%/i,
  /\bVAT\s+included\b/i, /\bVAT\s+excluded\b/i, /\bVAT\s+inclusive\b/i, /\bVAT\s+exclusive\b/i, /\btax\s+amount\b/i
];

export function scanVatAssertions(text) {
  const violations = [];
  for (const re of VAT_ASSERTIONS) if (re.test(text)) violations.push(`VAT assertion: ${re}`);
  return violations;
}

/* ------------------------------------------------------------------ */
/* Secret-like value scanner                                          */
/* Source: ops/execution/execution-validation.mjs                     */
/* ------------------------------------------------------------------ */
const SECRET_PATTERNS = [
  /\bsk_(live|test)_[A-Za-z0-9]{16,}/,
  /\brk_(live|test)_[A-Za-z0-9]{16,}/,
  /\bwhsec_[A-Za-z0-9]{16,}/,
  /\bghp_[A-Za-z0-9]{36,}/,
  /\bAKIA[0-9A-Z]{16}\b/,
  /\beyJ[A-Za-z0-9_-]{10,}\./,
  /\bapi[_-]?key\b\s*[:=]\s*['"][^'"]{8,}/i,
  /oauth[_-]?token|client[_-]?secret/i,
  /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/
];

export function scanSecrets(text) {
  return SECRET_PATTERNS.filter((re) => re.test(text)).map((re) => `secret-like: ${re}`);
}

/* ------------------------------------------------------------------ */
/* Bank detail scanner                                                */
/* Source: ops/execution/execution-validation.mjs (inferred patterns) */
/* ------------------------------------------------------------------ */
const BANK_DETAIL_PATTERNS = [
  /\bIBAN\s*[A-Z]{2}\d{2}[A-Z0-9]{11,30}\b/i,
  /\bSWIFT\s*[A-Z]{6}[A-Z0-9]{2}([A-Z0-9]{3})?\b/i,
  /\bBIC\s*[A-Z]{6}[A-Z0-9]{2}([A-Z0-9]{3})?\b/i,
  /\bsort\s*code\s*[\d\s-]{6,}\b/i,
  /\baccount\s*(?:number|no)\s*[\d\s-]{6,}\b/i,
  /\bsortcode\s*[\d\s-]{6,}\b/i,
];

export function scanBankDetails(text) {
  return BANK_DETAIL_PATTERNS.filter((re) => re.test(text)).map((re) => `bank detail: ${re}`);
}

/* ------------------------------------------------------------------ */
/* Payment link scanner                                               */
/* Source: ops/execution/execution-validation.mjs (inferred patterns) */
/* ------------------------------------------------------------------ */
const PAYMENT_LINK_PATTERNS = [
  /https?:\/\/buy\.stripe\.com\b/i,
  /https?:\/\/pay\.stripe\.com\b/i,
  /https?:\/\/checkout\.stripe\.com\b/i,
  /https?:\/\/paypal\.com\b/i,
  /https?:\/\/www\.paypal\.com\b/i,
  /https?:\/\/payment\.paypal\.com\b/i,
];

export function scanPaymentLink(text) {
  return PAYMENT_LINK_PATTERNS.filter((re) => re.test(text)).map((re) => `payment-link: ${re}`);
}

/* ------------------------------------------------------------------ */
/* Financial claim scanner (unverified monetary assertions)           */
/* Source: ops/execution/execution-validation.mjs (inferred patterns) */
/* ------------------------------------------------------------------ */
const FINANCIAL_CLAIM_PATTERNS = [
  /\bguaranteed\s+(?:return|profit|income|yield)\b/i,
  /\brisk[- ]?free\s+(?:return|profit|investment)\b/i,
  /\b(?:fixed|guaranteed)\s+(?:APR|APY|interest\s+rate)\s+\d+(\.\d+)?\s*%\b/i,
  /\bdouble\s+your\s+money\b/i,
  /\bmake\s+\$\d+\s+(?:per|a)\s+(?:day|week|month)\b/i,
  /\bpassive\s+income\s+(?:guaranteed|assured)\b/i,
  /\bget\s+rich\b/i,
];

export function scanFinancialClaims(text) {
  return FINANCIAL_CLAIM_PATTERNS.filter((re) => re.test(text)).map((re) => `financial claim: ${re}`);
}