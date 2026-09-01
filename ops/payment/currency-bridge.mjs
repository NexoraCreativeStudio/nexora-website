/* Nexora — Worker-Safe Currency Bridge (PROP.17 HOTFIX12)
   Build-time consumption of the authoritative billing source of truth.
   Zero runtime filesystem access. Single source of truth preserved. */

let _sourceOfTruth = null;

async function loadSourceOfTruth() {
  if (_sourceOfTruth !== null) return _sourceOfTruth;
  // Dynamic import to avoid top-level assert which fails in Node 24+
  const module = await import('../billing-source-of-truth.json', { with: { type: 'json' } });
  _sourceOfTruth = module.default;
  return _sourceOfTruth;
}

export const INVOICE_ID_RE = /^INV-\d{4}-\d{4}-\d{3}$/;

/**
 * Get the source currency (frozen, authoritative)
 * @returns {Promise<string>} Currency code (e.g., 'GBP')
 */
export async function getSourceCurrency() {
  const source = await loadSourceOfTruth();
  return source.currency;
}

/**
 * Get the source of truth object
 * @returns {Promise<Object>}
 */
export async function getSourceOfTruth() {
  return await loadSourceOfTruth();
}