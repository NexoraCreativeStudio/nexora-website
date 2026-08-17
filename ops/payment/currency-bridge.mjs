/* Nexora — Worker-Safe Currency Bridge (PROP.17 HOTFIX12)
   Build-time consumption of the authoritative billing source of truth.
   Zero runtime filesystem access. Single source of truth preserved. */

import sourceOfTruth from '../billing-source-of-truth.json' with { type: 'json' };

export const SOURCE_CURRENCY = sourceOfTruth.currency;  // 'GBP' — frozen, authoritative
export const INVOICE_ID_RE = /^INV-\d{4}-\d{4}-\d{3}$/;