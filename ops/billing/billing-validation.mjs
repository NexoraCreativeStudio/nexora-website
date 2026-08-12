/* Nexora Invoice & Billing Engine (PROP.8) — shared billing core.
   Consumes an EXECUTED Agreement Execution (PROP.7) + the governed READY
   Agreement (PROP.5) and derives a governed billing schedule, invoice
   records, recurring-billing readiness, and Go-Live modelling.

   THIS IS GOVERNANCE + RECORD MODELLING ONLY. It does NOT:
     - collect payment, call Stripe/PayPal/SumUp, create Payment Intents,
       Checkout Sessions, Payment Links, or direct checkout;
     - send invoices or emails externally;
     - invent commercial terms, VAT treatment, late fees, penalties,
       interest, grace periods, bank details, or payment instructions;
     - model PAID as reachable (payment status is external);
     - touch the commercial Source of Truth, pricing, or any Proposal /
       Agreement / Execution status.

   Invoices are derived ONLY from the Approved Final Project Price (and the
   governed setup/recurring/Care fees) inherited by the Agreement — never the
   public/reference price. Recurring billing begins at Go-Live and is blocked
   before a recorded Go-Live. Care is billed monthly in advance, separately.

   Key boundaries (explicit):
     - Invoice != Payment. ISSUED != PAID. EXECUTED Agreement != PAID.
       Invoice created != payment collected.
     - Invoice number NX-INV-YYYY-NNNN is a TECHNICAL sequence under PROP.8;
       the accounting system becomes authoritative for real issuance.
     - VAT is UNDETERMINED (no tax determination is ever claimed).
     - A billing/invoice fingerprint is NOT an accounting signature.

   Node built-ins only. No printing, no process.exit — CLI tools decide. */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import {
  sha256hex,
  scanLegacy,
  scanVatAssertions,
  scanTokens,
  scanPathLeakage
} from '../documents/document-output.mjs';
import {
  validateExecutionRecord,
  verifyExecutionFingerprint,
  agreementChecksum,
  scanSecrets,
  buildExecutionFingerprint,
  EXECUTION_SCHEMA,
  EXECUTION_STATUSES
} from '../execution/execution-validation.mjs';
import {
  validateCommercialSnapshot,
  classifyInput as classifyAgreementInput,
  loadLegalDecisions,
  AGREEMENT_SCHEMA
} from '../agreements/agreement-validation.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const billingDir = __dirname;
const root = path.join(__dirname, '..', '..');

export const OUT_DIR = path.join(billingDir, 'out');
export const PRIVATE_DIR = path.join(billingDir, 'private');
export const EXAMPLES_DIR = path.join(billingDir, 'examples');

export const BILLING_SCHEMA = 'nexora-billing/v1';
export const INVOICE_SCHEMA = 'nexora-invoice/v1';
export const GO_LIVE_SCHEMA = 'nexora-go-live/v1';

export const INVOICE_STATUSES = [
  'DRAFT', 'READY_TO_ISSUE', 'ISSUED', 'DUE', 'PAID', 'OVERDUE', 'VOID', 'CANCELLED', 'REFUNDED', 'CREDITED'
];
/* Reachable inside PROP.8. PAID/OVERDUE/REFUNDED/CREDITED require payment /
   reconciliation evidence from a future layer and are refused here. */
export const PROP8_STATUSES = ['DRAFT', 'READY_TO_ISSUE', 'ISSUED', 'VOID', 'CANCELLED'];
export const PAYMENT_ONLY_STATUSES = ['PAID', 'OVERDUE', 'REFUNDED', 'CREDITED'];

export const INVOICE_TYPES = [
  'PROJECT_MILESTONE', 'FINAL_BALANCE', 'SETUP_IMPLEMENTATION',
  'RECURRING_SERVICE', 'CARE_RECURRING', 'CHANGE_REQUEST'
];

export const INVOICE_ID_RE = /^INV-\d{4}-\d{4}-\d{3}$/;
export const INVOICE_NUMBER_RE = /^NX-INV-\d{4}-\d{4}$/;
export const GO_LIVE_EVENT_TYPE = 'GO_LIVE';

export const OWNER_ACCOUNTING_DECISION = 'OWNER/ACCOUNTING DECISION REQUIRED — VAT AND STATUTORY INVOICE ISSUANCE';
export const OWNER_MILESTONE_DECISION = 'OWNER/OPERATIONS DECISION REQUIRED — MILESTONE INVOICE TRIGGER';

/* Governed Care product codes (billing-source-of-truth.json `care`). AI Care
   does not exist and is refused (D2). */
export const CARE_CODES = [
  'WEB_CARE_ESSENTIAL', 'WEB_CARE_PLUS', 'BRAND_CARE_STANDARD', 'BRAND_CARE_EXTENDED'
];

/* ------------------------------------------------------------------ */
/* Source of truth (consumed, never modified)                         */
/* ------------------------------------------------------------------ */
export function loadSourceOfTruth() {
  return JSON.parse(fs.readFileSync(path.join(root, 'ops', 'billing-source-of-truth.json'), 'utf8'));
}
export const CURRENCY = loadSourceOfTruth().currency; /* GBP */
export const PAYMENT_TERM_DAYS = Number(loadSourceOfTruth().invoice_terms && loadSourceOfTruth().invoice_terms.project_invoice_due_days) || 7;
export const PROPOSAL_VALIDITY_DAYS = Number(loadSourceOfTruth().invoice_terms && loadSourceOfTruth().invoice_terms.proposal_validity_days) || 30;

/* ------------------------------------------------------------------ */
/* Canonical serialisation + fingerprints (deterministic SHA-256)      */
/* ------------------------------------------------------------------ */
export function sortKeys(value) {
  if (Array.isArray(value)) return value.map(sortKeys);
  if (value && typeof value === 'object') {
    const out = {};
    for (const k of Object.keys(value).sort()) out[k] = sortKeys(value[k]);
    return out;
  }
  return value;
}
export function canonicalSerialise(value) {
  return JSON.stringify(sortKeys(value));
}
export function collectStrings(value, acc = []) {
  if (typeof value === 'string') acc.push(value);
  else if (Array.isArray(value)) for (const v of value) collectStrings(v, acc);
  else if (value && typeof value === 'object') for (const k of Object.keys(value)) collectStrings(value[k], acc);
  return acc;
}

const INVOICE_FP_EXCLUDED = new Set(['invoice_fingerprint', 'status', 'payment', 'audit_events', 'updated_at', '_example']);
const SCHEDULE_FP_EXCLUDED = new Set(['schedule_fingerprint', 'audit_events', '_example']);

function canonicalExcluding(obj, excluded) {
  const clone = (function pick(value) {
    if (Array.isArray(value)) return value.map(pick);
    if (value && typeof value === 'object') {
      const out = {};
      for (const k of Object.keys(value)) if (!excluded.has(k)) out[k] = pick(value[k]);
      return out;
    }
    return value;
  })(obj);
  return canonicalSerialise(clone);
}

export function buildInvoiceFingerprint(record) {
  return sha256hex('nexora-invoice:' + canonicalExcluding(record, INVOICE_FP_EXCLUDED));
}
export function verifyInvoiceFingerprint(record) {
  const stored = record && record.invoice_fingerprint;
  if (typeof stored !== 'string' || stored.length !== 64) return { ok: false, reasons: ['invoice_fingerprint missing or malformed'] };
  const recomputed = buildInvoiceFingerprint(record);
  if (stored !== recomputed) return { ok: false, reasons: ['invoice fingerprint mismatch — commercial content has been changed'] };
  return { ok: true, reasons: [] };
}
export function buildScheduleFingerprint(schedule) {
  return sha256hex('nexora-billing-schedule:' + canonicalExcluding(schedule, SCHEDULE_FP_EXCLUDED));
}
export function verifyScheduleFingerprint(schedule) {
  const stored = schedule && schedule.schedule_fingerprint;
  if (typeof stored !== 'string' || stored.length !== 64) return { ok: false, reasons: ['schedule_fingerprint missing or malformed'] };
  if (stored !== buildScheduleFingerprint(schedule)) return { ok: false, reasons: ['billing schedule fingerprint mismatch — schedule has been changed'] };
  return { ok: true, reasons: [] };
}

/* ------------------------------------------------------------------ */
/* Deterministic dates (no Date.now — pure arithmetic)                 */
/* ------------------------------------------------------------------ */
export function addDaysIso(isoDate, days) {
  if (typeof isoDate !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(isoDate)) return null;
  const [y, m, d] = isoDate.split('-').map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d + days));
  return dt.toISOString().slice(0, 10);
}
export function dueDateFor(issueDate) {
  return addDaysIso(issueDate, PAYMENT_TERM_DAYS);
}
export function firstOfNextMonth(isoDate) {
  if (typeof isoDate !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(isoDate)) return null;
  const [y, m] = isoDate.split('-').map(Number);
  if (m === 12) return `${y + 1}-01-01`;
  return `${y}-${String(m + 1).padStart(2, '0')}-01`;
}

/* ------------------------------------------------------------------ */
/* Milestone amounts — same rounding policy as PROP.3/5/6.             */
/* Non-final tranches: Math.round(approved * pct / 100) (half-up).     */
/* Final tranche absorbs the residual so the total equals the approved */
/* price exactly.                                                      */
/* ------------------------------------------------------------------ */
export function computeMilestoneAmounts(approved, schedule) {
  if (!(typeof approved === 'number' && Number.isFinite(approved) && approved >= 0)) return null;
  if (!Array.isArray(schedule) || schedule.length === 0) return null;
  const rows = [];
  let accrued = 0;
  schedule.forEach((pct, i) => {
    const amount = (i === schedule.length - 1) ? (approved - accrued) : Math.round((approved * pct) / 100);
    if (i < schedule.length - 1) accrued += amount;
    rows.push({ pct, amount });
  });
  return rows;
}
export function validateSchedulePercentages(schedule) {
  const reasons = [];
  if (!Array.isArray(schedule) || schedule.length === 0) { reasons.push('payment_schedule must be a non-empty array'); return { ok: false, reasons }; }
  for (const p of schedule) if (!Number.isInteger(p) || p <= 0 || p > 100) { reasons.push(`payment_schedule percentage ${p} must be an integer in 1..100`); break; }
  const sum = schedule.reduce((a, b) => a + b, 0);
  if (sum !== 100) reasons.push(`payment_schedule percentages must sum to 100 (got ${sum})`);
  return { ok: reasons.length === 0, reasons };
}

/* ------------------------------------------------------------------ */
/* Input classification (PROP.8 output areas)                          */
/* ------------------------------------------------------------------ */
export function classifyBillingInput(filePath) {
  const p = path.resolve(filePath);
  const rel = path.relative(root, p);
  if (rel.startsWith('ops' + path.sep + 'billing' + path.sep + 'out' + path.sep)) return 'OUT';
  if (rel.startsWith('ops' + path.sep + 'billing' + path.sep + 'private' + path.sep)) return 'PRIVATE';
  if (rel.startsWith('ops' + path.sep + 'billing' + path.sep + 'examples' + path.sep)) return 'EXAMPLES';
  return 'UNSAFE';
}
export function assertSafeBillingOutput(dir) {
  const resolved = path.resolve(dir);
  const rel = path.relative(root, resolved);
  if (rel.startsWith('..') || path.isAbsolute(rel)) return { ok: false, reason: `Unsafe output directory: ${dir} — output must stay within the repository root.` };
  return { ok: true };
}
export function defaultBillingOutputDir() { return OUT_DIR; }

export function scheduleFilename(scheduleId, version) {
  const clean = String(scheduleId).replace(/[^A-Za-z0-9._-]/g, '-');
  return `${clean}-v${String(version).replace(/[^0-9.]/g, '')}.billing-schedule.json`;
}
export function invoiceFilename(invoiceId, version) {
  const clean = String(invoiceId).replace(/[^A-Za-z0-9._-]/g, '-');
  return `${clean}-v${String(version).replace(/[^0-9.]/g, '')}.invoice.json`;
}
export function goLiveFilename(agreementId) {
  return `${String(agreementId).replace(/[^A-Za-z0-9._-]/g, '-')}.go-live.json`;
}

/* ------------------------------------------------------------------ */
/* Identity derivation                                                 */
/* ------------------------------------------------------------------ */
export function agreementSeq(agreementId) {
  const m = String(agreementId).match(/^AGR-(\d{4})-(\d{4})$/);
  return m ? m[2] : null;
}
export function billingScheduleId(agreementId) {
  const seq = agreementSeq(agreementId);
  return seq ? `SCH-${agreementId.slice(4, 8)}-${seq}` : `SCH-${String(agreementId).replace(/[^A-Za-z0-9._-]/g, '-')}`;
}
export function invoiceIdFor(agreementId, ordinal) {
  const seq = agreementSeq(agreementId);
  if (!seq) return null;
  const year = agreementId.slice(4, 8);
  return `INV-${year}-${seq}-${String(ordinal).padStart(3, '0')}`;
}
/* Technical invoice number — governed format NX-INV-YYYY-NNNN. The NNNN is a
   deterministic per-schedule sequence; accounting software is authoritative for
   real issuance and must not run a competing sequence. */
export function invoiceNumberFor(issueYear, ordinal) {
  return `NX-INV-${String(issueYear).padStart(4, '0')}-${String(ordinal).padStart(4, '0')}`;
}

/* ------------------------------------------------------------------ */
/* Execution input gate — EXECUTED only                                */
/* ------------------------------------------------------------------ */
export function validateExecutionForBilling(record) {
  const reasons = [];
  if (!record || typeof record !== 'object') { reasons.push('execution record must be an object'); return { ok: false, reasons }; }
  if (record.schema !== EXECUTION_SCHEMA) reasons.push(`execution schema must be ${EXECUTION_SCHEMA}`);
  if (!EXECUTION_STATUSES.includes(record.status)) reasons.push(`unknown execution status ${JSON.stringify(record.status)}`);
  if (record.status !== 'EXECUTED') {
    reasons.push(`execution status EXECUTED required — got ${JSON.stringify(record.status || '(missing)')} (PREPARED/SENT_FOR_SIGNATURE/PARTIALLY_SIGNED/DECLINED/CANCELLED/EXPIRED rejected)`);
  }
  if (record.agreement_status && record.agreement_status !== 'READY_FOR_EXECUTION') {
    reasons.push(`agreement_status must be READY_FOR_EXECUTION — got ${JSON.stringify(record.agreement_status)}`);
  }
  const v = validateExecutionRecord(record, { requireExampleMarker: false });
  if (v.failures.length) reasons.push(`execution record invalid: ${v.failures.slice(0, 3).join('; ')}`);
  const fp = verifyExecutionFingerprint(record);
  if (!fp.ok) reasons.push(...fp.reasons);
  return { ok: reasons.length === 0, reasons };
}

/* ------------------------------------------------------------------ */
/* Agreement input gate — READY_FOR_EXECUTION, linked to the execution  */
/* ------------------------------------------------------------------ */
export function validateAgreementForBilling(agreement, executionRecord) {
  const reasons = [];
  if (!agreement || typeof agreement !== 'object') { reasons.push('agreement must be an object'); return { ok: false, reasons }; }
  if (agreement.schema !== AGREEMENT_SCHEMA) reasons.push(`agreement schema must be ${AGREEMENT_SCHEMA}`);
  if (agreement.status !== 'READY_FOR_EXECUTION') {
    reasons.push(`agreement status READY_FOR_EXECUTION required — got ${JSON.stringify(agreement.status || '(missing)')} (invoices may not be generated directly from a Proposal, Handoff, DRAFT or plain READY agreement without execution evidence)`);
  }
  if (executionRecord) {
    if (agreement.agreement_id !== executionRecord.agreement_id) reasons.push(`agreement_id does not match the execution record (${agreement.agreement_id} != ${executionRecord.agreement_id})`);
    if (agreement.version !== executionRecord.agreement_version) reasons.push(`agreement version does not match the execution record (${agreement.version} != ${executionRecord.agreement_version})`);
    const ck = agreementChecksum(agreement);
    if (ck !== executionRecord.agreement_checksum_sha256) reasons.push('agreement checksum does not match the execution record — the Agreement must not have changed since execution');
  }
  const cs = agreement.commercial_schedule;
  if (!cs || typeof cs !== 'object') {
    reasons.push('commercial_schedule required');
    return { ok: false, reasons };
  }
  const snap = validateCommercialSnapshot(agreement.offering, cs, { label: 'billing·commercial', requireExampleMarker: false });
  if (snap.failures.length) reasons.push(`commercial schedule invalid: ${snap.failures.slice(0, 3).join('; ')}`);
  if (!(typeof cs.approved_final_project_price === 'number' && Number.isFinite(cs.approved_final_project_price) && cs.approved_final_project_price >= 0)) {
    reasons.push('commercial_schedule.approved_final_project_price required — invoices derive ONLY from the Approved Final Project Price, never the public/reference price');
  }
  if (cs.currency !== CURRENCY) reasons.push(`currency must be ${CURRENCY}`);
  return { ok: reasons.length === 0, reasons };
}

/* ------------------------------------------------------------------ */
/* Billing schedule derivation                                         */
/* ------------------------------------------------------------------ */
const AI_CATEGORY = 'AI';
const COMPLETE_CODE = 'COMPLETE';

export function deriveInvoiceSchedule(agreement, executionRecord, opts = {}) {
  const ev = validateExecutionForBilling(executionRecord);
  if (!ev.ok) return { ok: false, reasons: ev.reasons };
  const ag = validateAgreementForBilling(agreement, executionRecord);
  if (!ag.ok) return { ok: false, reasons: ag.reasons };

  const cs = agreement.commercial_schedule;
  const approved = cs.approved_final_project_price;
  const offering = agreement.offering || {};
  const generatedAt = opts.generatedAt || '1970-01-01T00:00:00.000Z';
  const items = [];

  /* Project milestones (frozen or recorded-bespoke schedule). */
  const milestonePcts = cs.payment_schedule;
  if (Array.isArray(milestonePcts) && milestonePcts.length > 0) {
    const pctGuard = validateSchedulePercentages(milestonePcts);
    if (!pctGuard.ok) return { ok: false, reasons: pctGuard.reasons };
    const rows = computeMilestoneAmounts(approved, milestonePcts);
    if (!rows) return { ok: false, reasons: ['cannot compute milestone amounts from Approved Final Project Price'] };
    const total = rows.reduce((a, b) => a + b.amount, 0);
    if (total !== approved) return { ok: false, reasons: [`milestone total ${total} must equal Approved Final Project Price ${approved} exactly`] };
    rows.forEach((row, i) => {
      const isFinal = i === rows.length - 1;
      items.push({
        index: items.length,
        invoice_type: isFinal ? 'FINAL_BALANCE' : 'PROJECT_MILESTONE',
        label: isFinal ? 'Final Balance' : `Milestone ${i + 1}`,
        amount: row.amount,
        percentage: row.pct,
        milestone: { index: i + 1, total_milestones: rows.length, percentage: row.pct, amount: row.amount, is_final: isFinal },
        issuance: {
          gate: i === 0 ? 'EXECUTED' : 'MILESTONE_TRIGGER',
          note: i === 0 ? 'First project invoice allowed after EXECUTED Agreement.' : 'Subsequent milestone invoices require a milestone-ready trigger/evidence. Policy unresolved — ' + OWNER_MILESTONE_DECISION,
          satisfied: false
        }
      });
    });
  }

  /* AI implementation / setup fee (separate one-time amount). */
  if (cs.setup_fee != null) {
    items.push({
      index: items.length,
      invoice_type: 'SETUP_IMPLEMENTATION',
      label: 'Implementation',
      amount: cs.setup_fee,
      setup_fee: cs.setup_fee,
      issuance: { gate: 'EXECUTED', note: 'Setup/implementation invoice allowed after EXECUTED Agreement.', satisfied: false }
    });
  }

  /* Recurring AI service — starts ONLY at a recorded Go-Live. */
  const rf = cs.recurring_fees;
  if (rf && typeof rf === 'object') {
    if (rf.starts_at !== 'GO_LIVE') {
      return { ok: false, reasons: [`recurring_fees.starts_at must be GO_LIVE — recurring billing must not begin before a recorded Go-Live (got ${JSON.stringify(rf.starts_at)})`] };
    }
    items.push({
      index: items.length,
      invoice_type: 'RECURRING_SERVICE',
      label: `${offering.name || 'AI'} — Monthly Service`,
      amount: rf.monthly_fee,
      recurring: { period: 'monthly', monthly_fee: rf.monthly_fee, starts_at: 'GO_LIVE', cadence: 'monthly' },
      issuance: { gate: 'GO_LIVE', note: 'AI recurring billing begins ONLY at a recorded Go-Live. Never inferred from execution/proposal/start dates.', satisfied: false }
    });
  }

  /* Care recurring — monthly in advance, separate, only if accepted. */
  const care = cs.care;
  if (care && typeof care === 'object') {
    if (!CARE_CODES.includes(care.code)) {
      return { ok: false, reasons: [`care code ${JSON.stringify(care.code)} is not a governed Care product — AI Care does not exist (D2)`] };
    }
    if (care.billed_in_advance !== true) {
      return { ok: false, reasons: ['Care must be billed monthly in advance'] };
    }
    items.push({
      index: items.length,
      invoice_type: 'CARE_RECURRING',
      label: `${care.plan || care.code} — Monthly Service`,
      amount: care.monthly_fee,
      care: { code: care.code, plan: care.plan || null, monthly_fee: care.monthly_fee, billed_in_advance: true, cadence: 'monthly' },
      issuance: { gate: 'CARE_START', note: 'Care activation requires an accepted/executed service plus a governed Care start. Never silently activated.', satisfied: false }
    });
  }

  if (items.length === 0) {
    return { ok: false, reasons: ['no billable items derivable from the governed commercial schedule'] };
  }

  const scheduleId = billingScheduleId(agreement.agreement_id);
  const source = {
    proposal_id: agreement.proposal && agreement.proposal.proposal_id,
    proposal_version: agreement.proposal && agreement.proposal.version,
    agreement_id: agreement.agreement_id,
    agreement_version: agreement.version,
    agreement_checksum_sha256: executionRecord.agreement_checksum_sha256,
    execution_id: executionRecord.execution_id,
    execution_fingerprint: executionRecord.execution_fingerprint
  };

  /* Recurring readiness (provider-neutral; activation only on governed event). */
  const recurring = {};
  if (rf && typeof rf === 'object') {
    recurring.ai = {
      service: offering.name || null,
      package: offering.code || null,
      monthly_fee: rf.monthly_fee,
      cadence: 'monthly',
      starts_at: 'GO_LIVE',
      state: 'AWAITING_GO_LIVE',
      go_live_recorded: false,
      go_live_at: null,
      billing_start_date: null,
      next_billing_date: null
    };
  }
  if (care && typeof care === 'object') {
    recurring.care = {
      service: care.plan || care.code,
      code: care.code,
      monthly_fee: care.monthly_fee,
      cadence: 'monthly',
      billed_in_advance: true,
      state: 'AWAITING_START',
      care_start_recorded: false,
      care_start: null
    };
  }

  const schedule = {
    schema: BILLING_SCHEMA,
    billing_schedule_id: scheduleId,
    version: '1.0',
    currency: CURRENCY,
    offering: { code: offering.code, category: offering.category, name: offering.name },
    source,
    commercial_basis: {
      approved_final_project_price: approved,
      reference_price_from: cs.reference_price ? (cs.reference_price.from || cs.reference_price) : null,
      setup_fee: cs.setup_fee != null ? cs.setup_fee : null,
      milestone_schedule: milestonePcts || null,
      recurring_fees: rf ? { monthly_fee: rf.monthly_fee, starts_at: rf.starts_at } : null,
      care: care ? { code: care.code, plan: care.plan || null, monthly_fee: care.monthly_fee, billed_in_advance: true } : null
    },
    items,
    project_total: milestonePcts ? approved : null,
    recurring,
    generated_at: generatedAt,
    audit_events: [
      { event: 'schedule_created', at: generatedAt, event_id: sha256hex(`nexora-billing-schedule:${scheduleId}:${generatedAt}`).slice(0, 16), detail: 'Billing schedule derived from EXECUTED Agreement execution — schedule generation is NOT invoice issuance.' }
    ],
    _example: opts.example === true ? true : undefined,
    numbering_note: 'NX-INV-YYYY-NNNN is a technical sequence under PROP.8. The accounting system becomes authoritative for real invoice numbering.',
    vat_note: 'VAT status is UNDETERMINED — no tax determination is made. ' + OWNER_ACCOUNTING_DECISION + '.'
  };
  if (schedule._example === undefined) delete schedule._example;
  schedule.schedule_fingerprint = buildScheduleFingerprint(schedule);
  return { ok: true, schedule };
}

/* ------------------------------------------------------------------ */
/* Invoice creation — gate-driven                                      */
/* ------------------------------------------------------------------ */
export function buildInvoiceRecord(schedule, itemIndex, opts = {}) {
  const reasons = [];
  const item = schedule && schedule.items && schedule.items[itemIndex];
  if (!item) return { ok: false, reasons: [`schedule item ${itemIndex} not found`] };
  const fp = verifyScheduleFingerprint(schedule);
  if (!fp.ok) return { ok: false, reasons: fp.reasons };

  const gate = item.issuance.gate;
  const goLive = opts.goLive || null;
  const careStart = opts.careStart || null;
  const milestoneEvidence = opts.milestoneEvidence || null;
  let issuanceSatisfied = false;
  let evidenceRef = null;

  if (gate === 'EXECUTED') {
    issuanceSatisfied = true; /* schedule itself proves the EXECUTED input */
    evidenceRef = schedule.source.execution_id;
  } else if (gate === 'GO_LIVE') {
    if (!goLive || goLive.agreement_id !== schedule.source.agreement_id) {
      reasons.push(`AI recurring billing requires a recorded Go-Live (agreement ${schedule.source.agreement_id}) — Go-Live is NEVER inferred from the execution date, proposal acceptance or project start`);
      return { ok: false, reasons };
    }
    const gl = validateGoLiveRecord(goLive);
    if (!gl.ok) return { ok: false, reasons: gl.reasons };
    issuanceSatisfied = true;
    evidenceRef = goLive.evidence_ref || goLive.occurred_at;
  } else if (gate === 'CARE_START') {
    if (!careStart || !/^\d{4}-\d{2}-\d{2}$/.test(careStart)) {
      reasons.push('Care recurring billing requires an explicit governed Care start date (--care-start), never silently activated');
      return { ok: false, reasons };
    }
    issuanceSatisfied = true;
    evidenceRef = careStart;
  } else if (gate === 'MILESTONE_TRIGGER') {
    if (!milestoneEvidence || typeof milestoneEvidence !== 'string' || !milestoneEvidence.trim()) {
      reasons.push(`${OWNER_MILESTONE_DECISION} — a governed milestone trigger/evidence is required to create this milestone invoice`);
      return { ok: false, reasons };
    }
    issuanceSatisfied = true;
    evidenceRef = milestoneEvidence;
  } else {
    reasons.push(`unsupported issuance gate ${gate}`);
    return { ok: false, reasons };
  }

  const created = opts.createdAt || schedule.generated_at || '1970-01-01T00:00:00.000Z';
  const issue = opts.issue === true;
  const issueDate = issue ? (opts.issueDate || created.slice(0, 10)) : null;
  const dueDate = issue ? dueDateFor(issueDate) : null;
  const source = schedule.source;
  const offer = schedule.offering;
  const agreementCommercial = opts.commercialBasis || schedule.commercial_basis;
  const ordinal = itemIndex + 1;
  const year = issueDate ? issueDate.slice(0, 4) : created.slice(0, 4);
  const invoiceId = invoiceIdFor(source.agreement_id, ordinal);
  if (!invoiceId) return { ok: false, reasons: ['cannot derive invoice_id from agreement lineage'] };

  const lineItem = {
    description: lineItemDescription(offer, item),
    quantity: 1,
    unit_price: item.amount,
    line_total: item.amount
  };

  const record = {
    schema: INVOICE_SCHEMA,
    invoice_id: invoiceId,
    invoice_version: '1.0',
    invoice_number: invoiceNumberFor(year, ordinal),
    invoice_type: item.invoice_type,
    status: issue ? 'ISSUED' : 'DRAFT',
    currency: schedule.currency,
    source: {
      proposal_id: source.proposal_id,
      proposal_version: source.proposal_version,
      agreement_id: source.agreement_id,
      agreement_version: source.agreement_version,
      execution_id: source.execution_id,
      execution_fingerprint: source.execution_fingerprint
    },
    client: opts.client || { name: null, company: null, billing_email: null, billing_address: null },
    project: opts.project || { title: null },
    offering: { code: offer.code, category: offer.category, name: offer.name },
    commercial_basis: agreementCommercial,
    line_items: [lineItem],
    subtotal: item.amount,
    tax_status: 'UNDETERMINED',
    tax_amount: null,
    total: item.amount,
    issue_date: issueDate,
    due_date: dueDate,
    milestone: item.milestone ? { ...item.milestone, label: item.label, trigger_evidence: gate === 'MILESTONE_TRIGGER' ? milestoneEvidence : null } : null,
    recurring: item.recurring ? { ...item.recurring, go_live_at: null, billing_start_date: null, next_billing_date: null } : null,
    care: item.care ? { ...item.care, care_start: null } : null,
    issuance: {
      gate,
      satisfied: issuanceSatisfied,
      evidence_ref: evidenceRef,
      note: item.issuance.note
    },
    payment: {
      method_text: 'Bank transfer — details supplied separately (provider activation is an Owner action)',
      payment_reference: invoiceNumberFor(year, ordinal),
      status: 'UNPAID'
    },
    created_at: created,
    audit_events: [
      { event: 'invoice_created', at: created, event_id: sha256hex(`nexora-invoice:${invoiceId}:created:${created}`).slice(0, 16), detail: `Invoice record created for schedule item ${ordinal} (${item.invoice_type}). Invoice created != payment collected.` }
    ],
    vat_note: schedule.vat_note,
    numbering_note: schedule.numbering_note,
    _example: opts.example === true ? true : undefined
  };
  if (record._example === undefined) delete record._example;

  /* Recurring billing readiness — AI Go-Live + Care start. */
  if (item.recurring && gate === 'GO_LIVE' && goLive) {
    record.recurring.go_live_at = goLive.occurred_at;
    record.recurring.billing_start_date = firstOfNextMonth(goLive.occurred_at);
    record.recurring.next_billing_date = firstOfNextMonth(record.recurring.billing_start_date);
    record.audit_events.push({
      event: 'recurring_ready', at: created,
      event_id: sha256hex(`nexora-invoice:${invoiceId}:recurring:${goLive.occurred_at}`).slice(0, 16),
      detail: `AI recurring billing readiness confirmed — recorded Go-Live ${goLive.occurred_at}; billing starts ${record.recurring.billing_start_date}.`
    });
  }
  if (item.care && gate === 'CARE_START' && careStart) {
    record.care.care_start = careStart;
    record.audit_events.push({
      event: 'recurring_ready', at: created,
      event_id: sha256hex(`nexora-invoice:${invoiceId}:care:${careStart}`).slice(0, 16),
      detail: `Care recurring billing readiness confirmed — governed Care start ${careStart} (monthly in advance).`
    });
  }
  if (issue) {
    record.audit_events.push({ event: 'invoice_issued', at: created, event_id: sha256hex(`nexora-invoice:${invoiceId}:issued:${issueDate}`).slice(0, 16), detail: 'Invoice issued. ISSUED != PAID.' });
  }
  record.invoice_fingerprint = buildInvoiceFingerprint(record);
  return { ok: true, record };
}

function lineItemDescription(offer, item) {
  const base = offer && offer.name ? `Nexora ${offer.name}` : 'Nexora';
  switch (item.invoice_type) {
    case 'SETUP_IMPLEMENTATION': return `${base} — Implementation (setup fee)`;
    case 'RECURRING_SERVICE': return `${base} — Monthly Service (recurring billing starts at Go-Live)`;
    case 'CARE_RECURRING': return `${item.care.plan || item.care.code} — Monthly Service (billed in advance)`;
    case 'FINAL_BALANCE': return `${base} — Final Balance (${item.percentage}%, absorbs residual)`;
    default: return `${base} — ${item.label} (${item.percentage}% of Approved Final Project Price)`;
  }
}

/* ------------------------------------------------------------------ */
/* Invoice validation                                                 */
/* ------------------------------------------------------------------ */
export function validateInvoiceRecord(record, opts = {}) {
  const reasons = [];
  if (!record || typeof record !== 'object') return { failures: ['invoice record must be an object'], checks: [] };
  if (opts.requireExampleMarker !== false && record._example !== true) reasons.push('_example: fixture must be marked "_example": true — real invoices belong in ops/billing/private/ (gitignored), never committed');
  if (record.schema !== INVOICE_SCHEMA) reasons.push(`schema must be ${INVOICE_SCHEMA}`);
  if (typeof record.invoice_id !== 'string' || !INVOICE_ID_RE.test(record.invoice_id)) reasons.push(`invoice_id must match ${INVOICE_ID_RE}`);
  if (typeof record.invoice_number !== 'string' || !INVOICE_NUMBER_RE.test(record.invoice_number)) reasons.push(`invoice_number must match ${INVOICE_NUMBER_RE} (NX-INV-YYYY-NNNN)`);
  if (!INVOICE_TYPES.includes(record.invoice_type)) reasons.push(`invoice_type must be one of ${INVOICE_TYPES.join(', ')}`);
  if (!INVOICE_STATUSES.includes(record.status)) reasons.push(`status must be one of ${INVOICE_STATUSES.join(', ')}`);
  if (PAYMENT_ONLY_STATUSES.includes(record.status)) {
    reasons.push(`status ${record.status} requires payment/reconciliation evidence from a future layer — PROP.8 must not fake PAID`);
  }
  if (record.currency !== CURRENCY) reasons.push(`currency must be ${CURRENCY}`);

  /* Provenance required — no orphan invoices. */
  const s = record.source || {};
  if (!/^PRP-\d{4}-\d{4}$/.test(s.proposal_id || '')) reasons.push('source.proposal_id required (PRP-YYYY-NNNN)');
  if (!/^AGR-\d{4}-\d{4}$/.test(s.agreement_id || '')) reasons.push('source.agreement_id required');
  if (!/^EXE-\d{4}-\d{4}$/.test(s.execution_id || '')) reasons.push('source.execution_id required');
  if (typeof s.execution_fingerprint !== 'string' || !/^[0-9a-f]{64}$/.test(s.execution_fingerprint)) reasons.push('source.execution_fingerprint (64-hex) required');

  const client = record.client || {};
  if (!client.name || !client.company) reasons.push('client name + company required');
  if (!record.project || !record.project.title) reasons.push('project.title required');
  if (!record.offering || !record.offering.code || !record.offering.category || !record.offering.name) reasons.push('offering code/category/name required');

  const cb = record.commercial_basis || {};
  if (!(typeof cb.approved_final_project_price === 'number' && Number.isFinite(cb.approved_final_project_price) && cb.approved_final_project_price >= 0)) {
    reasons.push('commercial_basis.approved_final_project_price required');
  }

  /* Line items + arithmetic. */
  if (!Array.isArray(record.line_items) || record.line_items.length === 0) reasons.push('line_items required');
  const lineSum = (record.line_items || []).reduce((a, l) => a + (l.line_total || 0), 0);
  if (record.subtotal !== lineSum) reasons.push(`subtotal ${record.subtotal} must equal sum of line_items ${lineSum}`);
  for (const l of record.line_items || []) {
    if (l.quantity !== 1) reasons.push('invoice line quantity must be 1 (governed fixed-fee line items)');
    if (l.unit_price !== l.line_total) reasons.push('invoice line unit_price must equal line_total');
  }
  if (record.total !== record.subtotal) reasons.push(`total ${record.total} must equal subtotal ${record.subtotal} (tax is UNDETERMINED)`);
  if (record.tax_status !== 'UNDETERMINED') reasons.push('tax_status must be UNDETERMINED — no VAT determination may be claimed (VAT gate)');
  if (record.tax_amount !== null) reasons.push('tax_amount must be null while VAT is UNDETERMINED');

  /* Amount must derive from the Approved Final Project Price / governed fees —
     never the public/reference price. */
  const amountCheck = validateInvoiceAmount(record);
  if (!amountCheck.ok) reasons.push(...amountCheck.reasons);

  /* Due date = issue date + governed invoice term (7 calendar days). */
  if (record.issue_date && record.due_date && dueDateFor(record.issue_date) !== record.due_date) {
    reasons.push(`due_date must be issue_date + ${PAYMENT_TERM_DAYS} calendar days (got ${record.due_date} for ${record.issue_date})`);
  }
  if (record.status === 'ISSUED' && !record.issue_date) reasons.push('ISSUED invoice requires issue_date');
  if (record.issuance && record.status === 'ISSUED' && record.issuance.satisfied !== true) {
    reasons.push('invoice must not be ISSUED before its required issuance gate is satisfied');
  }

  /* Scanners over every string in the record. */
  const allText = collectStrings(record).join('\n');
  for (const v of scanLegacy(allText)) reasons.push(`legacy: ${v}`);
  for (const v of scanVatAssertions(allText)) reasons.push(`VAT assertion: ${v}`);
  for (const v of scanSecrets(allText)) reasons.push(`secret-like: ${v}`);
  for (const v of scanBankDetails(allText)) reasons.push(`bank detail: ${v}`);
  for (const v of scanPaymentLink(allText)) reasons.push(`payment-link: ${v}`);
  for (const v of scanFinancialClaims(allText)) reasons.push(`financial claim: ${v}`);
  for (const v of scanPathLeakage(allText)) reasons.push(`path leakage: ${v}`);

  const fp = verifyInvoiceFingerprint(record);
  if (!fp.ok) reasons.push(...fp.reasons);

  if (!Array.isArray(record.audit_events)) reasons.push('audit_events array required');
  return { failures: reasons, checks: [] };
}

function validateInvoiceAmount(record) {
  const reasons = [];
  const item = (record.line_items || [])[0];
  const amount = item && item.line_total;
  const cb = record.commercial_basis || {};
  const m = record.milestone;
  if (record.invoice_type === 'PROJECT_MILESTONE' || record.invoice_type === 'FINAL_BALANCE') {
    const schedule = Array.isArray(cb.milestone_schedule) ? cb.milestone_schedule : null;
    const approved = cb.approved_final_project_price;
    if (schedule && m && typeof m.index === 'number' && approved != null) {
      const rows = computeMilestoneAmounts(approved, schedule);
      const expected = rows && rows[m.index - 1] ? rows[m.index - 1].amount : null;
      if (expected != null && amount !== expected) {
        reasons.push(`milestone invoice amount ${amount} does not match Approved Final Project Price ${approved} × governed ${m.percentage}% (expected ${expected}) — stale public/reference price or tampered amount`);
      }
    }
  } else if (record.invoice_type === 'SETUP_IMPLEMENTATION') {
    if (amount !== cb.setup_fee) reasons.push(`setup invoice amount ${amount} must equal the governed setup fee ${cb.setup_fee}`);
  } else if (record.invoice_type === 'RECURRING_SERVICE') {
    const expected = cb.recurring_fees && cb.recurring_fees.monthly_fee;
    if (amount !== expected) reasons.push(`recurring invoice amount ${amount} must equal the governed monthly fee ${expected}`);
  } else if (record.invoice_type === 'CARE_RECURRING') {
    const expected = cb.care && cb.care.monthly_fee;
    if (amount !== expected) reasons.push(`Care invoice amount ${amount} must equal the governed Care monthly fee ${expected}`);
  }
  return { ok: reasons.length === 0, reasons };
}

/* ------------------------------------------------------------------ */
/* Invoice status transitions — evidence-free PAID impossible          */
/* ------------------------------------------------------------------ */
export function allowedInvoiceTransition(from, eventType) {
  if (eventType === 'ISSUE') return from === 'DRAFT' || from === 'READY_TO_ISSUE';
  if (eventType === 'VOID') return from === 'ISSUED' || from === 'DUE';
  if (eventType === 'CANCEL') return from === 'DRAFT' || from === 'READY_TO_ISSUE';
  if (eventType === 'MARK_PAID') return false; /* PAID requires payment evidence — future reconciliation layer */
  return false;
}

export function applyInvoiceEvent(record, event) {
  const reasons = [];
  if (!record || !record.schema || record.schema !== INVOICE_SCHEMA) { reasons.push('not an invoice record'); return { ok: false, reasons }; }
  if (!record.issuance || record.issuance.satisfied !== true) {
    reasons.push(`invoice ${record.status} cannot transition — its issuance gate is not satisfied`);
    return { ok: false, reasons };
  }
  const from = record.status;
  const type = event.event_type;
  if (!allowedInvoiceTransition(from, type)) {
    reasons.push(`invoice transition ${from} -> ${type} not allowed`);
    if (type === 'MARK_PAID') reasons.push('PAID requires real payment/reconciliation evidence from a future layer — PROP.8 never fakes PAID');
    return { ok: false, reasons };
  }
  const next = JSON.parse(JSON.stringify(record));
  next.audit_events = [...(record.audit_events || [])];
  if (type === 'ISSUE') {
    next.status = 'ISSUED';
    next.issue_date = event.issue_date || record.issue_date || (event.at || '1970-01-01T00:00:00.000Z').slice(0, 10);
    next.due_date = dueDateFor(next.issue_date);
    next.updated_at = event.at || record.created_at;
    next.audit_events.push({ event: 'invoice_issued', at: event.at || record.created_at, event_id: sha256hex(`nexora-invoice:${record.invoice_id}:issued:${event.at}`).slice(0, 16), detail: 'Invoice issued. ISSUED != PAID.' });
  } else if (type === 'VOID') {
    next.status = 'VOID';
    next.updated_at = event.at || record.created_at;
    next.audit_events.push({ event: 'invoice_voided', at: event.at || record.created_at, event_id: sha256hex(`nexora-invoice:${record.invoice_id}:voided:${event.at}`).slice(0, 16), detail: 'Invoice voided — correction path. VOID/void + new invoice is the governed correction flow.' });
  } else if (type === 'CANCEL') {
    next.status = 'CANCELLED';
    next.updated_at = event.at || record.created_at;
    next.audit_events.push({ event: 'invoice_cancelled', at: event.at || record.created_at, event_id: sha256hex(`nexora-invoice:${record.invoice_id}:cancelled:${event.at}`).slice(0, 16), detail: 'Invoice cancelled before issue.' });
  }
  next.invoice_fingerprint = buildInvoiceFingerprint(next);
  return { ok: true, record: next };
}

/* ------------------------------------------------------------------ */
/* Go-Live event model — explicit operational record only              */
/* ------------------------------------------------------------------ */
export function buildGoLiveRecord({ agreementId, executionId, occurredAt, recordedAt, evidenceRef, example }) {
  const record = {
    schema: GO_LIVE_SCHEMA,
    event_type: GO_LIVE_EVENT_TYPE,
    agreement_id: agreementId,
    execution_id: executionId,
    occurred_at: occurredAt,
    recorded_at: recordedAt,
    evidence_ref: evidenceRef,
    audit_events: [
      { event: 'go_live_recorded', at: recordedAt, event_id: sha256hex(`nexora-go-live:${agreementId}:${occurredAt}`).slice(0, 16), detail: 'Go-Live recorded from explicit operational evidence — never inferred from the execution date or proposal acceptance.' }
    ],
    _example: example === true ? true : undefined
  };
  if (record._example === undefined) delete record._example;
  return record;
}
export function validateGoLiveRecord(record) {
  const reasons = [];
  if (!record || typeof record !== 'object') return { ok: false, reasons: ['go-live record must be an object'] };
  if (record.schema !== GO_LIVE_SCHEMA) reasons.push(`schema must be ${GO_LIVE_SCHEMA}`);
  if (record.event_type !== GO_LIVE_EVENT_TYPE) reasons.push('event_type must be GO_LIVE');
  if (typeof record.agreement_id !== 'string' || !/^AGR-\d{4}-\d{4}$/.test(record.agreement_id)) reasons.push('agreement_id required (AGR-YYYY-NNNN)');
  if (typeof record.execution_id !== 'string' || !/^EXE-\d{4}-\d{4}$/.test(record.execution_id)) reasons.push('execution_id required (EXE-YYYY-NNNN)');
  if (typeof record.occurred_at !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(record.occurred_at)) reasons.push('occurred_at ISO date required');
  if (typeof record.recorded_at !== 'string' || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/.test(record.recorded_at)) reasons.push('recorded_at ISO datetime required');
  if (typeof record.evidence_ref !== 'string' || !record.evidence_ref.trim()) reasons.push('evidence_ref required — Go-Live must be an explicit operational record, never inferred');
  return { ok: reasons.length === 0, reasons };
}

/* ------------------------------------------------------------------ */
/* Financial / payment scanners (fail-closed, no secrets printed)      */
/* ------------------------------------------------------------------ */
const BANK_DETAIL_PATTERNS = [
  /\bsort\s*code\b/i,
  /\baccount\s*(?:number|no\.?)\b/i,
  /\bbank\s*(?:number|no\.?)\b/i,
  /\b\d{2}-\d{2}-\d{2}\b/,             /* sort code 12-34-56 */
  /\b\d{8}\b/,                          /* 8-digit account number */
  /\b[A-Z]{2}\d{2}[A-Z0-9]{11,}\b/      /* IBAN */
];
const PAYMENT_LINK_PATTERNS = [
  /stripe\.com\/pay\//i,
  /buy\.stripe\.com/i,
  /checkout\.stripe/i,
  /paypal\.me\//i,
  /\bpayment\s*link\b/i,
  /\bpayment\s*intent\b/i,
  /\bcheckout\s*session\b/i
];
const FINANCIAL_CLAIM_PATTERNS = [
  /\blate\s*fee\b/i,
  /\bpenalt/i,
  /\binterest\b/i,
  /\boverdue\s*charges?/i,
  /\bgrace\s*period\b/i,
  /\bcollection\s*fee\b/i
];

export function scanBankDetails(text) {
  const out = [];
  for (const re of BANK_DETAIL_PATTERNS) if (re.test(text)) out.push(`bank detail: ${re}`);
  return out;
}
export function scanPaymentLink(text) {
  const out = [];
  for (const re of PAYMENT_LINK_PATTERNS) if (re.test(text)) out.push(`payment link/intent/checkout: ${re}`);
  return out;
}
export function scanFinancialClaims(text) {
  const out = [];
  for (const re of FINANCIAL_CLAIM_PATTERNS) if (re.test(text)) out.push(`uninventable financial claim: ${re}`);
  return out;
}

/* Re-exported shared scanners for the validator. */
export { sha256hex, scanLegacy, scanVatAssertions, scanSecrets, agreementChecksum, buildExecutionFingerprint, scanPathLeakage };
