/* Nexora Proposal System — shared PROP.1 validation core (PROP.3).
   Extracted from validate-proposals.mjs so the CLI validator and the PROP.3
   generator share ONE validation implementation (no drift, no duplication).

   Exports:
     validatePackageMapping()        -> { checks, failures } — package-mapping vs billing-source-of-truth.json
     validateProposal(p, opts)       -> { checks, failures } — one Proposal instance (all commercial checks)
     resolvePath(obj, dotted)        — dotted-path resolver into billing-source-of-truth.json
     moneyValue(v)                   — normalise 4250 | {from:4250} -> 4250
     EXPECTED_CODES, STATUSES, CATEGORIES, W90, VALIDITY_DAYS, CURRENCY, CARE_PLANS

   opts:
     label  (default 'proposal') — prefix used in check text (CLI passes the file basename)
     requireExampleMarker (default true) — committed fixtures must be marked "_example": true
       so a real client proposal is never committed by mistake. The generator passes
       { requireExampleMarker: false } and enforces its own input-location policy instead
       (private/ real proposals never carry the marker).

   Return shape: { checks: [{ ok, text }], failures: [text] } — `checks` preserves the
   exact interleaved order used by the CLI validator; `failures` is the failed subset.
   This module performs no printing and never calls process.exit — the CLI and the
   generator decide how to print/exit. Check text uses the SAME labels as the original
   CLI so output stays stable. */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const proposalsDir = __dirname;
const root = path.join(__dirname, '..', '..');

const SOURCE = JSON.parse(fs.readFileSync(path.join(root, 'ops', 'billing-source-of-truth.json'), 'utf8'));
const MAPPING = JSON.parse(fs.readFileSync(path.join(proposalsDir, 'package-mapping.json'), 'utf8'));
const SCHEMA = JSON.parse(fs.readFileSync(path.join(proposalsDir, 'proposal.schema.json'), 'utf8'));

export const EXPECTED_CODES = ['A1', 'A2', 'A3', 'B1', 'B2', 'B3', 'C1', 'C2', 'C3', 'COMPLETE', 'WEB_CARE', 'BRAND_CARE'];
export const STATUSES = ['DRAFT', 'INTERNAL_APPROVED', 'SENT', 'CLIENT_ACCEPTED', 'DECLINED', 'EXPIRED', 'SUPERSEDED'];
export const CATEGORIES = ['AI', 'WEB', 'BRAND', 'ADDITIONAL'];
export const W90 = '90-day Web Launch Warranty';
export const VALIDITY_DAYS = SOURCE.invoice_terms && SOURCE.invoice_terms.proposal_validity_days;
export const CURRENCY = SOURCE.currency;

/* Care plan identifiers -> authoritative source path. Preserves authoritative structure. */
export const CARE_PLANS = {
  WEB_CARE_ESSENTIAL: { source_ref: 'care.web.essential' },
  WEB_CARE_PLUS: { source_ref: 'care.web.plus' },
  BRAND_CARE_STANDARD: { source_ref: 'care.brand.standard' },
  BRAND_CARE_EXTENDED: { source_ref: 'care.brand.extended' }
};

/* ---- helpers ---- */

const isObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);

export function resolvePath(obj, dotted) {
  let cur = obj;
  for (const key of String(dotted).split('.')) {
    if (cur == null || typeof cur !== 'object' || !(key in cur)) return undefined;
    cur = cur[key];
  }
  return cur;
}

/* Normalise a money value: 4250 or {from:4250} -> 4250; null/undefined -> undefined. */
export function moneyValue(v) {
  if (v == null) return undefined;
  if (typeof v === 'number') return v;
  if (isObject(v) && typeof v.from === 'number') return v.from;
  return undefined;
}

const sum = (arr) => (Array.isArray(arr) ? arr.reduce((a, b) => a + b, 0) : NaN);

function dateAddDays(iso, days) {
  const d = new Date(String(iso) + 'T00:00:00Z');
  if (Number.isNaN(d.getTime())) return null;
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

/* Walk every string in a proposal for legacy / unsupported content. */
function collectStrings(obj, out = []) {
  if (typeof obj === 'string') { out.push(obj); return out; }
  if (Array.isArray(obj)) { for (const v of obj) collectStrings(v, out); return out; }
  if (isObject(obj)) { for (const k of Object.keys(obj)) collectStrings(obj[k], out); }
  return out;
}

/* Ordered check collector. `label` prefixes every check (mapping vs proposal file basename). */
function makeCollector(label) {
  const checks = [];
  const failures = [];
  const pass = (text) => { checks.push({ ok: true, text: `${label} · ${text}` }); };
  const fail = (text, detail) => {
    const full = detail ? `${label} · ${text} — ${detail}` : `${label} · ${text}`;
    checks.push({ ok: false, text: full });
    failures.push(full);
  };
  return { checks, failures, pass, fail };
}

/* ---- STEP 7/10: package mapping + architecture ---- */

export function validatePackageMapping() {
  const { checks, failures, pass, fail } = makeCollector('mapping');

  const offered = MAPPING.offerings || [];
  if (!Array.isArray(offered)) {
    fail('offerings', 'package-mapping.json has no offerings array');
  } else if (offered.length !== 12) {
    fail('offering count', `expected 12 (9 core + 3 additional), got ${offered.length}`);
  } else {
    pass('offering count (9 core + 3 additional = 12)');
  }

  const codes = offered.map((o) => o.code);
  for (const c of EXPECTED_CODES) {
    if (codes.includes(c)) pass(`${c} present`);
    else fail(`${c} present`);
  }
  for (const c of codes) {
    if (!EXPECTED_CODES.includes(c)) fail(`unexpected offering code "${c}"`, 'commercial architecture drift');
  }

  for (const o of offered) {
    if (/\b(starter|elite)\b/i.test(o.code)) {
      fail(`legacy code "${o.code}"`, 'Starter/Elite legacy architecture must not return');
    }
    if (!EXPECTED_CODES.includes(o.code)) continue;
    if (!CATEGORIES.includes(o.category)) fail(`${o.code} category "${o.category}"`, 'unknown category');
    if (!o.source_ref) { fail(`${o.code}`, 'missing source_ref'); continue; }
    const resolved = resolvePath(SOURCE, o.source_ref);
    if (resolved === undefined) {
      fail(`${o.code} source_ref "${o.source_ref}"`, 'does not resolve in billing-source-of-truth.json');
    } else {
      pass(`${o.code} resolves ${o.source_ref}`);
      if (isObject(resolved) && typeof resolved.name === 'string' && o.name && resolved.name !== o.name) {
        fail(`${o.code} name`, `mapping "${o.name}" != source "${resolved.name}"`);
      }
    }
    /* Care sub-plans must resolve to authoritative plan objects. */
    if (Array.isArray(o.plans)) {
      const base = resolvePath(SOURCE, o.source_ref);
      if (isObject(base)) {
        for (const plan of o.plans) {
          if (!isObject(base[plan])) fail(`${o.code} plan "${plan}"`, `not found under ${o.source_ref}`);
        }
      }
    }
  }

  return { checks, failures };
}

/* ---- proposal instance validation ---- */

export function validateProposal(p, opts = {}) {
  const label = opts.label || 'proposal';
  const requireExampleMarker = opts.requireExampleMarker !== false;
  const { checks, failures, pass, fail } = makeCollector(label);

  const offered = MAPPING.offerings || [];

  /* Fixture marker — accidental real/private client data protection. */
  if (requireExampleMarker) {
    if (p._example !== true) {
      fail('_example', 'fixture must be marked "_example": true — real client proposals belong in ops/proposals/private/ (gitignored), never committed');
    } else {
      pass('example fixture marker');
    }
  }

  /* Required metadata. */
  for (const req of ['proposal_id', 'version', 'status', 'issue_date', 'valid_until', 'client', 'project', 'offering', 'commercial_schedule', 'next_steps']) {
    if (!(req in p)) fail('required field', `"${req}" missing`);
    else if (req === 'commercial_schedule' && !isObject(p[req])) fail('commercial_schedule', 'must be an object');
  }
  if (!isObject(p.client)) fail('client', 'must be an object');
  if (!isObject(p.project)) fail('project', 'must be an object');
  if (!isObject(p.offering)) fail('offering', 'must be an object');
  if (!isObject(p.commercial_schedule)) return { checks, failures };

  /* proposal_id / version / status. */
  if (typeof p.proposal_id === 'string') {
    if (/^PRP-\d{4}-\d{4}$/.test(p.proposal_id)) pass('proposal_id format');
    else fail('proposal_id format');
  }
  if (typeof p.version === 'string') {
    if (/^\d+\.\d+$/.test(p.version)) pass('version format');
    else fail('version format');
  }
  if (STATUSES.includes(p.status)) pass(`status ${p.status}`);
  else fail(`status "${p.status}"`, `must be one of ${STATUSES.join(', ')}`);

  /* Validity: valid_until = issue_date + proposal_validity_days (30). */
  const expectedUntil = dateAddDays(p.issue_date, VALIDITY_DAYS);
  if (expectedUntil === null) fail('issue_date', `invalid date "${p.issue_date}"`);
  else if (p.valid_until === expectedUntil) pass(`validity ${p.valid_until} (issue + ${VALIDITY_DAYS} days)`);
  else fail(`valid_until "${p.valid_until}"`, `expected "${expectedUntil}" (issue_date + ${VALIDITY_DAYS} days per billing-source-of-truth.json)`);

  /* Offering identity. */
  const mapEntry = offered.find((o) => o.code === (p.offering && p.offering.code));
  if (!mapEntry) {
    fail(`offering code "${p.offering && p.offering.code}"`, 'unknown offering identifier (check package-mapping.json)');
    return { checks, failures };
  }
  if (/\b(starter|elite)\b/i.test(p.offering.code)) fail('offering code', 'legacy Starter/Elite architecture must not return');
  if (mapEntry.category !== p.offering.category) fail('offering category', `expected "${mapEntry.category}"`);
  if (mapEntry.name !== p.offering.name) fail('offering name', `expected "${mapEntry.name}"`);

  const source = resolvePath(SOURCE, mapEntry.source_ref);
  const resolvedSourceName = isObject(source) && typeof source.name === 'string' ? source.name : null;
  if (resolvedSourceName && resolvedSourceName !== p.offering.name) {
    fail('offering name', `does not match authoritative source "${resolvedSourceName}"`);
  }

  /* Currency. */
  if (p.commercial_schedule.currency !== CURRENCY) {
    fail('currency', `must be "${CURRENCY}"`);
  }

  /* Reference price vs authoritative source (stale-reference detection). */
  const cs = p.commercial_schedule;
  const srcPrice = isObject(source) ? moneyValue(source.price) : undefined;
  if (mapEntry.category === 'WEB' || mapEntry.category === 'BRAND') {
    if (srcPrice === undefined) fail('source price', `no price at ${mapEntry.source_ref}`);
    else if (moneyValue(cs.reference_price) === srcPrice) pass(`reference price matches source (${srcPrice})`);
    else fail('reference_price', `stale — source is ${srcPrice}, proposal shows ${JSON.stringify(cs.reference_price)}`);
  } else if (mapEntry.code === 'COMPLETE') {
    if (cs.reference_price == null) pass('COMPLETE has no public reference price');
    else fail('reference_price', 'COMPLETE is bespoke/scoped with NO mechanical public price — reference_price must be absent');
  } else {
    /* AI: no single package price; reference is expressed via setup_fee + recurring_fees. */
    if (cs.reference_price == null) pass('AI has no single reference price');
    else fail('reference_price', 'AI pricing is implementation_fee + monthly_fee (separate) — reference_price must be absent');
  }

  /* Setup fee (AI implementation fee). */
  const srcImpl = isObject(source) ? moneyValue(source.implementation_fee) : undefined;
  if (mapEntry.category === 'AI') {
    if (srcImpl === undefined) fail('source implementation fee', `no implementation_fee at ${mapEntry.source_ref}`);
    else if (moneyValue(cs.setup_fee) === srcImpl) pass(`setup_fee matches source implementation fee (${srcImpl})`);
    else fail('setup_fee', `stale — source implementation_fee is ${srcImpl}, proposal shows ${JSON.stringify(cs.setup_fee)}`);
  } else if (mapEntry.code === 'COMPLETE') {
    /* AI implementation remains commercially identifiable where applicable — client-approved, no source compare. */
    pass('COMPLETE setup_fee is client-approved (no source compare)');
  } else {
    if (cs.setup_fee == null) pass(`no setup fee for ${mapEntry.code}`);
    else fail('setup_fee', `${mapEntry.code} has no governed setup fee — remove it`);
  }

  /* Payment schedule. */
  const srcSchedule = isObject(source) ? source.schedule : undefined;
  const hasSchedule = Array.isArray(srcSchedule) || srcSchedule === 'BESPOKE_MILESTONE_SCHEDULE';
  if (mapEntry.code === 'B3') {
    if (Array.isArray(cs.payment_schedule) && cs.payment_schedule.length >= 2 && sum(cs.payment_schedule) === 100) {
      pass('B3 bespoke schedule recorded (sums to 100%)');
    } else {
      fail('payment_schedule', 'B3 is bespoke — a per-proposal schedule summing to 100% must be recorded (no invented standard percentages)');
    }
  } else if (mapEntry.code === 'COMPLETE') {
    const target = Array.isArray(SOURCE.complete.schedule) ? SOURCE.complete.schedule : null;
    if (target && Array.isArray(cs.payment_schedule) && JSON.stringify(cs.payment_schedule) === JSON.stringify(target)) {
      pass(`COMPLETE schedule ${JSON.stringify(target)}`);
    } else {
      fail('payment_schedule', `COMPLETE must be ${JSON.stringify(target)} (governed), got ${JSON.stringify(cs.payment_schedule)}`);
    }
  } else if (hasSchedule && Array.isArray(srcSchedule)) {
    if (Array.isArray(cs.payment_schedule) && JSON.stringify(cs.payment_schedule) === JSON.stringify(srcSchedule)) {
      pass(`payment_schedule ${JSON.stringify(srcSchedule)}`);
    } else {
      fail('payment_schedule', `must be ${JSON.stringify(srcSchedule)} (frozen), got ${JSON.stringify(cs.payment_schedule)}`);
    }
  } else {
    if (cs.payment_schedule == null) pass(`no governed milestone schedule for ${mapEntry.code}`);
    else if (Array.isArray(cs.payment_schedule) && sum(cs.payment_schedule) === 100) pass('per-proposal schedule sums to 100%');
    else fail('payment_schedule', `${mapEntry.code} has no frozen milestone schedule — must be absent or sum to 100%`);
  }

  /* Approved Final Project Price — required, client-specific, governs invoicing. */
  if (typeof cs.approved_final_project_price === 'number' && Number.isFinite(cs.approved_final_project_price) && cs.approved_final_project_price >= 0) {
    pass(`approved_final_project_price £${cs.approved_final_project_price}`);
    /* From/bespoke/scoped: the approved final price MAY differ from the public reference — never a failure. */
    const ref = moneyValue(cs.reference_price);
    if (mapEntry.bespoke && ref !== undefined && ref !== cs.approved_final_project_price) {
      pass('approved final differs from public reference — permitted for bespoke/From/scoped');
    }
  } else {
    fail('approved_final_project_price', 'required (governs invoicing per INVOICE-FLOW.md §5) and must be a non-negative number');
  }

  /* Recurring fees. */
  const srcMonthly = isObject(source) ? moneyValue(source.monthly_fee) : undefined;
  if (mapEntry.category === 'AI') {
    const rf = cs.recurring_fees;
    if (isObject(rf) && moneyValue(rf.monthly_fee) === srcMonthly && rf.starts_at === 'GO_LIVE') {
      pass(`recurring monthly fee ${JSON.stringify(rf.monthly_fee)} starts at GO_LIVE`);
    } else {
      fail('recurring_fees', `AI requires monthly_fee matching source (${JSON.stringify(source && source.monthly_fee)}) and starts_at GO_LIVE`);
    }
  } else if (mapEntry.code === 'COMPLETE') {
    const rf = cs.recurring_fees;
    if (rf == null) pass('COMPLETE no recurring fees');
    else if (isObject(rf) && rf.starts_at === 'GO_LIVE') pass('COMPLETE recurring starts at GO_LIVE (AI where applicable)');
    else fail('recurring_fees', 'COMPLETE AI recurring must start at GO_LIVE');
  } else if (mapEntry.category === 'ADDITIONAL') {
    const rf = cs.recurring_fees;
    if (isObject(rf) && moneyValue(rf.monthly_fee) === srcMonthly && rf.starts_at === 'MONTHLY_IN_ADVANCE') {
      pass(`Care recurring monthly fee ${JSON.stringify(rf.monthly_fee)} paid in advance`);
    } else if (isObject(rf)) {
      fail('recurring_fees', `Care must be paid monthly in advance, matching source ${JSON.stringify(source && source.monthly_fee)}`);
    } else {
      fail('recurring_fees', 'Care offering requires a monthly fee paid in advance');
    }
  } else {
    if (cs.recurring_fees == null) pass(`no recurring fees for ${mapEntry.code}`);
    else fail('recurring_fees', `${mapEntry.code} is a project package — recurring fees only via an optional Care plan`);
  }

  /* Care relationship — optional, separately identifiable, never bundled. */
  if (cs.care == null) {
    pass('no Care plan (optional)');
  } else {
    const careCode = cs.care.code;
    const carePlan = CARE_PLANS[careCode];
    if (!carePlan) {
      fail('care.code', `unknown Care plan — must be one of ${Object.keys(CARE_PLANS).join(', ')}`);
    } else {
      const careSrc = resolvePath(SOURCE, carePlan.source_ref);
      const careMonthly = moneyValue(careSrc && careSrc.monthly_fee);
      if (moneyValue(cs.care.monthly_fee) === careMonthly && cs.care.billed_in_advance === true) {
        pass(`Care ${careCode} monthly ${JSON.stringify(cs.care.monthly_fee)} paid in advance`);
      } else {
        fail('care', `must reference an authoritative plan with matching monthly fee (${JSON.stringify(careMonthly)}) billed in advance`);
      }
    }
  }

  /* Warranty — the only supported claim is the governed 90-day Web Launch Warranty. */
  if (cs.warranty == null) {
    pass('no warranty claim');
  } else if (cs.warranty.label === W90) {
    pass(`warranty "${W90}"`);
  } else {
    fail('warranty', `unsupported — the only governed claim is "${W90}"`);
  }

  /* VAT — UNRESOLVED. No rate / registration / included / excluded assertion. */
  if (isObject(cs.vat) && cs.vat.status === 'UNDETERMINED') {
    pass('VAT status UNDETERMINED (no determination made)');
  } else {
    fail('vat', 'VAT is UNRESOLVED — vat.status must be "UNDETERMINED"; no rate/registration/included/excluded assertion may be made');
  }
  const vatAssertions = [
    /\bVAT\s+registered\b/i, /\bregistered\s+for\s+VAT\b/i,
    /\b20\s*%\s*VAT\b/i, /\bVAT\s+at\s+\d+\s*%/i,
    /\bVAT\s+included\b/i, /\bVAT\s+excluded\b/i, /\bVAT\s+inclusive\b/i, /\bVAT\s+exclusive\b/i,
    /\btax\s+amount\b/i
  ];
  for (const str of collectStrings(p)) {
    for (const re of vatAssertions) {
      if (re.test(str)) fail('VAT assertion', `unsupported claim in text: "${str}"`);
    }
  }

  /* Legacy commercial sweep: obsolete £250 deposit/checkout flow and old tiers. */
  const legacyPatterns = [
    /£250/, /£250\s+secures?/i, /\b250\s+deposit\b/i, /\bpay\s+£250\b/i,
    /buy\.stripe\.com/i, /paypal\.com/i,
    /\bStarter\b/, /\bElite\b/
  ];
  for (const str of collectStrings(p)) {
    for (const re of legacyPatterns) {
      if (re.test(str)) fail('legacy content', `obsolete commercial reference in text: "${str}"`);
    }
  }

  return { checks, failures };
}
