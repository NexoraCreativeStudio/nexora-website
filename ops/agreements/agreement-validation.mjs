/* Nexora Agreement System — shared PROP.5 validation core.
   Consumes the PROP.4 Agreement Handoff (only from a CLIENT_ACCEPTED,
   fingerprint-verified Proposal) and validates governed Agreement instances.

   Exports:
     AGREEMENT_SCHEMA, AGREEMENT_VERSION, AGREEMENT_STATUSES, AGREEMENT_ID_RE
     CLASSIFICATIONS, LEGAL_CLAUSES (ordered inventory w/ labels)
     LEGAL_DECISIONS_PATH, loadLegalDecisions(pathOverride)
     classifyInput(filePath)            — PROP.5 input-location policy
     legalSectionsFor(decisions)        — build legal_sections from the register
     isReadyForExecution(agreement, decisions)  — {ready, reasons}
     validateAgreementHandoff(h, opts)  — handoff structure + commercial snapshot
     validateAgreement(a, opts)         — full Agreement instance validation
     snapshotProposal(offering, snap)   — wrap handoff snapshot for shared-core reuse

   Commercial inheritance reuses the PROP.1 shared core (validateProposal) so the
   Agreement can never independently redefine pricing: reference/setup/schedule/
   recurring/Care/Warranty/VAT/legacy rules resolve against
   ops/billing-source-of-truth.json exactly as the Proposal system enforces them.

   This module performs no printing and never calls process.exit — CLI tools
   decide how to print/exit. Node built-ins only. */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { validateProposal } from '../proposals/proposal-validation.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const agreementsDir = __dirname;
const root = path.join(__dirname, '..', '..');
const proposalsDir = path.join(root, 'ops', 'proposals');

export const AGREEMENT_VERSION = '1.0';
export const AGREEMENT_SCHEMA = 'nexora-agreement/v1';
export const AGREEMENT_STATUSES = ['DRAFT', 'READY_FOR_EXECUTION'];
export const AGREEMENT_ID_RE = /^AGR-\d{4}-\d{4}$/;
export const CLASSIFICATIONS = ['AUTHORITATIVE', 'DERIVED', 'CLIENT_SPECIFIC', 'LEGAL_DECISION_REQUIRED'];
export const LEGAL_DECISIONS_PATH = path.join(agreementsDir, 'legal', 'legal-decisions.json');

const PRIVATE_DIR = path.join(agreementsDir, 'private');
const EXAMPLES_DIR = path.join(agreementsDir, 'examples');
const PROPOSALS_PRIVATE = path.join(proposalsDir, 'private');
const PROPOSALS_EXAMPLES = path.join(proposalsDir, 'examples');

/* ------------------------------------------------------------------ */
/* Legal clause inventory (from the PROP.5 brief). Labels are the      */
/* client-facing section titles; ids are the governance identifiers.  */
/* ------------------------------------------------------------------ */
export const LEGAL_CLAUSES = [
  ['governing_law', 'Governing law'],
  ['jurisdiction', 'Jurisdiction'],
  ['dispute_resolution', 'Dispute resolution'],
  ['limitation_of_liability', 'Limitation of liability'],
  ['indemnities', 'Indemnities'],
  ['ip_ownership', 'Intellectual property'],
  ['confidentiality', 'Confidentiality'],
  ['termination', 'Termination'],
  ['cancellation', 'Cancellation'],
  ['refunds', 'Refunds'],
  ['late_payment_penalties', 'Late payment'],
  ['debt_recovery', 'Debt recovery'],
  ['force_majeure', 'Force majeure'],
  ['data_processing', 'Data processing'],
  ['gdpr_obligations', 'Data protection (GDPR)'],
  ['warranty_terms', 'Warranty terms'],
  ['statutory_representations', 'Statutory representations'],
  ['vat_tax_treatment', 'Tax / VAT treatment'],
  ['ownership_transfer', 'Ownership transfer'],
  ['portfolio_publicity_rights', 'Portfolio & publicity'],
  ['non_solicitation', 'Non-solicitation'],
  ['exclusivity', 'Exclusivity'],
  ['acceptance_by_conduct', 'Acceptance by conduct'],
  ['automatic_renewal', 'Automatic renewal'],
  ['minimum_subscription', 'Minimum subscription'],
  ['cancellation_notice_period', 'Cancellation notice period']
];

export function loadLegalDecisions(pathOverride) {
  const file = pathOverride || LEGAL_DECISIONS_PATH;
  let data;
  try {
    data = JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (e) {
    throw new Error(`Cannot read legal-decisions register (${file}): ${e.message}`);
  }
  if (data.schema !== 'nexora-legal-decisions/v1' || !data.clauses) {
    throw new Error(`Invalid legal-decisions register at ${file} — schema nexora-legal-decisions/v1 required`);
  }
  return data;
}

/* ------------------------------------------------------------------ */
/* Input-location policy (PROP.5). Real Agreements are private.        */
/* Upstream governed inputs (handoff / accepted proposal / record)     */
/* are read from the Proposal system's private/ and examples/ areas.   */
/* ------------------------------------------------------------------ */
export function classifyInput(filePath) {
  const abs = path.resolve(filePath);
  if (abs.startsWith(path.resolve(PRIVATE_DIR) + path.sep)) return 'PRIVATE';
  if (abs.startsWith(path.resolve(EXAMPLES_DIR) + path.sep)) return 'EXAMPLES';
  if (abs.startsWith(path.resolve(PROPOSALS_PRIVATE) + path.sep)) return 'PROPOSAL_PRIVATE';
  if (abs.startsWith(path.resolve(PROPOSALS_EXAMPLES) + path.sep)) return 'PROPOSAL_EXAMPLES';
  return 'UNSAFE';
}

/* ------------------------------------------------------------------ */
/* Legal sections + readiness gate.                                    */
/* ------------------------------------------------------------------ */
export function legalSectionsFor(decisions) {
  const clauses = decisions.clauses || {};
  return LEGAL_CLAUSES.map(([id, label]) => {
    const clause = clauses[id] || { classification: 'LEGAL_DECISION_REQUIRED', note: 'No decision recorded.' };
    const unresolved = clause.classification === 'LEGAL_DECISION_REQUIRED';
    return {
      id,
      label,
      classification: clause.classification,
      status: unresolved ? 'UNRESOLVED' : 'RESOLVED',
      note: clause.note || ''
    };
  });
}

export function isReadyForExecution(agreement, decisions) {
  const reasons = [];
  const sections = Array.isArray(agreement.legal_sections) ? agreement.legal_sections : [];
  const unresolved = sections.filter((s) => s.status === 'UNRESOLVED' || s.classification === 'LEGAL_DECISION_REQUIRED');
  if (unresolved.length > 0) {
    reasons.push(`legal decision required for: ${unresolved.map((s) => s.id).join(', ')}`);
  }
  if (!agreement.provenance || !agreement.provenance.proposal_fingerprint) reasons.push('missing provenance (proposal fingerprint)');
  const cs = agreement.commercial_schedule || {};
  if (typeof cs.approved_final_project_price !== 'number' || !Number.isFinite(cs.approved_final_project_price)) {
    reasons.push('commercial_schedule.approved_final_project_price required');
  }
  return { ready: reasons.length === 0, reasons };
}

/* ------------------------------------------------------------------ */
/* Reuse the PROP.1 shared core for commercial inheritance. The handoff */
/* snapshot (and agreement commercial_schedule) is wrapped into a       */
/* proposal-shaped object so ALL frozen commercial checks (reference,   */
/* setup fee, payment schedule, recurring, Care, Warranty, VAT, legacy) */
/* are enforced against ops/billing-source-of-truth.json with no drift. */
/* ------------------------------------------------------------------ */
export function snapshotProposal(offering, snap) {
  return {
    proposal_id: 'PRP-0000-0000',
    version: '1.0',
    status: 'CLIENT_ACCEPTED',
    issue_date: '2020-01-01',
    valid_until: '2020-01-31',
    client: { name: 'Provenance', company: 'Provenance', contact: {} },
    project: { title: 'Provenance', summary: 'Provenance', objectives: [] },
    offering,
    commercial_schedule: snap,
    next_steps: []
  };
}

export function validateCommercialSnapshot(offering, snap, opts = {}) {
  const label = opts.label || 'agreement-commercial';
  return validateProposal(snapshotProposal(offering, snap), { label, requireExampleMarker: false });
}

/* ------------------------------------------------------------------ */
/* Handoff structure validation (the PROP.5 upstream gate).            */
/* ------------------------------------------------------------------ */
export function validateAgreementHandoff(h, opts = {}) {
  const label = opts.label || 'handoff';
  const checks = [];
  const failures = [];
  const pass = (t) => checks.push({ ok: true, text: `${label} · ${t}` });
  const fail = (t, d) => { const full = d ? `${label} · ${t} — ${d}` : `${label} · ${t}`; checks.push({ ok: false, text: full }); failures.push(full); };

  if (!h || typeof h !== 'object') { fail('structure', 'handoff must be a JSON object'); return { checks, failures }; }
  if (h.schema === 'nexora-agreement-handoff/v1') pass(`schema ${h.schema}`);
  else fail('schema', `expected nexora-agreement-handoff/v1, got ${JSON.stringify(h.schema)}`);
  if (h.status === 'READY_FOR_AGREEMENT') pass('status READY_FOR_AGREEMENT');
  else fail('status', `expected READY_FOR_AGREEMENT, got ${JSON.stringify(h.status)}`);

  if (!h.proposal || !/^PRP-\d{4}-\d{4}$/.test(h.proposal.proposal_id)) fail('proposal.proposal_id', 'PRP-YYYY-NNNN required');
  else pass(`proposal ${h.proposal.proposal_id}`);
  if (!h.proposal || !/^\d+\.\d+$/.test(h.proposal.version)) fail('proposal.version', 'x.y required');
  else pass(`proposal version ${h.proposal.version}`);

  if (!h.acceptance || !/^[0-9a-f]{64}$/.test(h.acceptance.content_sha256)) fail('acceptance.content_sha256', 'canonical SHA-256 fingerprint required');
  else pass(`acceptance fingerprint ${h.acceptance.content_sha256.slice(0, 16)}…`);
  if (!h.acceptance || h.acceptance.canonical_format !== 'nexora-proposal-canonical/v1') fail('acceptance.canonical_format', 'nexora-proposal-canonical/v1 required');

  if (!h.client || typeof h.client !== 'object' || !h.client.name) fail('client', 'client identity required');
  if (!h.project || !h.project.title) fail('project', 'project title required');
  if (!h.offering || !h.offering.code || !h.offering.category || !h.offering.name) fail('offering', 'code/category/name required');
  if (!h.commercial_snapshot || typeof h.commercial_snapshot !== 'object') {
    fail('commercial_snapshot', 'required');
    return { checks, failures };
  }

  /* Commercial inheritance — revalidate the snapshot against the Source of Truth. */
  const snap = validateCommercialSnapshot(h.offering, h.commercial_snapshot, { label: `${label}·commercial` });
  checks.push(...snap.checks);
  failures.push(...snap.failures);

  return { checks, failures };
}

/* ------------------------------------------------------------------ */
/* Agreement instance validation.                                      */
/* ------------------------------------------------------------------ */
function collectStrings(obj, out = []) {
  if (typeof obj === 'string') { out.push(obj); return out; }
  if (Array.isArray(obj)) { for (const v of obj) collectStrings(v, out); return out; }
  if (obj !== null && typeof obj === 'object') { for (const k of Object.keys(obj)) collectStrings(obj[k], out); }
  return out;
}

export function validateAgreement(a, opts = {}) {
  const label = opts.label || 'agreement';
  const requireExampleMarker = opts.requireExampleMarker !== false;
  const decisions = loadLegalDecisions(opts.legalDecisionsPath);
  const clauses = decisions.clauses || {};
  const { checks, failures, pass, fail } = (() => {
    const c = [];
    const f = [];
    const p = (t) => c.push({ ok: true, text: `${label} · ${t}` });
    const fl = (t, d) => { const full = d ? `${label} · ${t} — ${d}` : `${label} · ${t}`; c.push({ ok: false, text: full }); f.push(full); };
    return { checks: c, failures: f, pass: p, fail: fl };
  })();

  if (requireExampleMarker) {
    if (a._example === true) pass('example fixture marker');
    else fail('_example', 'fixture must be marked "_example": true — real Agreements belong in ops/agreements/private/ (gitignored), never committed');
  }

  if (a.schema !== AGREEMENT_SCHEMA) fail('schema', `expected ${AGREEMENT_SCHEMA}, got ${JSON.stringify(a.schema)}`);
  else pass(`schema ${AGREEMENT_SCHEMA}`);

  if (typeof a.agreement_id === 'string' && AGREEMENT_ID_RE.test(a.agreement_id)) pass(`agreement_id ${a.agreement_id}`);
  else fail('agreement_id', 'AGR-YYYY-NNNN format required');
  if (typeof a.version === 'string' && /^\d+\.\d+$/.test(a.version)) pass(`version ${a.version}`);
  else fail('version', 'x.y format required');
  if (AGREEMENT_STATUSES.includes(a.status)) pass(`status ${a.status}`);
  else fail(`status ${JSON.stringify(a.status)}`, `must be one of ${AGREEMENT_STATUSES.join(', ')} — SIGNED/EXECUTED is not modelled`);

  if (!a.proposal || !/^PRP-\d{4}-\d{4}$/.test(a.proposal.proposal_id)) fail('proposal.proposal_id', 'PRP-YYYY-NNNN required');
  if (!a.proposal || !/^\d+\.\d+$/.test(a.proposal.version)) fail('proposal.version', 'x.y required');

  const pv = a.provenance || {};
  if (typeof pv.proposal_fingerprint === 'string' && /^[0-9a-f]{64}$/.test(pv.proposal_fingerprint)) pass('provenance.proposal_fingerprint');
  else fail('provenance.proposal_fingerprint', '64-char hex canonical SHA-256 required');
  if (typeof pv.acceptance_record === 'string' && pv.acceptance_record.startsWith('nexora-proposal-acceptance/')) pass(`provenance.acceptance_record ${pv.acceptance_record}`);
  else fail('provenance.acceptance_record', 'nexora-proposal-acceptance/v1 required');
  if (typeof pv.agreement_handoff === 'string' && pv.agreement_handoff.startsWith('nexora-agreement-handoff/')) pass(`provenance.agreement_handoff ${pv.agreement_handoff}`);
  else fail('provenance.agreement_handoff', 'nexora-agreement-handoff/v1 required');
  if (typeof pv.handoff_fingerprint === 'string' && /^[0-9a-f]{64}$/.test(pv.handoff_fingerprint)) pass('provenance.handoff_fingerprint');
  else fail('provenance.handoff_fingerprint', '64-char hex required');

  if (!a.client || typeof a.client !== 'object' || !a.client.name || !a.client.company) fail('client', 'name + company required');
  if (!a.project || !a.project.title) fail('project', 'title required');
  if (!a.offering || !a.offering.code || !a.offering.category || !a.offering.name) fail('offering', 'code/category/name required');

  /* Commercial inheritance — same frozen checks as the Proposal system. */
  if (!a.commercial_schedule || typeof a.commercial_schedule !== 'object') {
    fail('commercial_schedule', 'required');
  } else {
    const snap = validateCommercialSnapshot(a.offering, a.commercial_schedule, { label: `${label}·commercial` });
    checks.push(...snap.checks);
    failures.push(...snap.failures);
  }

  /* Legal sections must mirror the approved register exactly (no drift, no fake promotion). */
  if (!Array.isArray(a.legal_sections)) {
    fail('legal_sections', 'required');
  } else {
    const ids = new Set(a.legal_sections.map((s) => s.id));
    let complete = true;
    for (const [id] of LEGAL_CLAUSES) if (!ids.has(id)) { complete = false; fail(`legal_sections · missing clause ${id}`); }
    if (complete) pass(`legal_sections · all ${LEGAL_CLAUSES.length} inventory clauses present`);
    let consistent = true;
    for (const s of a.legal_sections) {
      if (!LEGAL_CLAUSES.some(([id]) => id === s.id)) { consistent = false; fail(`legal_sections · unknown clause "${s.id}"`); continue; }
      if (!CLASSIFICATIONS.includes(s.classification)) { consistent = false; fail(`legal_sections · ${s.id} bad classification ${s.classification}`); continue; }
      const reg = clauses[s.id];
      const expected = reg ? reg.classification : 'LEGAL_DECISION_REQUIRED';
      if (s.classification !== expected) { consistent = false; fail(`legal_sections · ${s.id} classification "${s.classification}" != register "${expected}" (drift or fake promotion)`); }
      if (s.status === 'UNRESOLVED' && expected !== 'LEGAL_DECISION_REQUIRED') { consistent = false; fail(`legal_sections · ${s.id} unresolved but register resolved`); }
      if (s.status === 'RESOLVED' && expected === 'LEGAL_DECISION_REQUIRED') { consistent = false; fail(`legal_sections · ${s.id} RESOLVED but register requires a decision (LEGAL_DECISION_REQUIRED)`); }
    }
    if (consistent) pass('legal_sections · classifications/status consistent with register');
  }

  /* Readiness gate — only meaningful for READY_FOR_EXECUTION. */
  if (a.status === 'READY_FOR_EXECUTION') {
    const gate = isReadyForExecution(a, decisions);
    if (gate.ready) pass('READY_FOR_EXECUTION gate passed (all legal/commercial decisions resolved, integrity intact)');
    else fail('READY_FOR_EXECUTION gate', gate.reasons.join('; '));
  } else {
    pass('DRAFT — NOT FOR EXECUTION (unresolved provisions permitted, clearly marked)');
  }

  /* Execution placeholders must stay null — no fake signed/executed state. */
  const ex = a.execution || {};
  if (ex.client_signature == null && ex.nexora_signature == null && ex.execution_date == null) pass('execution placeholders null (not signed)');
  else fail('execution', 'signature/execution fields must remain null — SIGNED/EXECUTED is an external gate, never modelled here');

  /* Legacy / VAT / AI-Care sweep across every string in the Agreement. */
  const legacyPatterns = [
    /£250/, /£250\s+secures?/i, /\b250\s+deposit\b/i, /\bpay\s+£250\b/i,
    /buy\.stripe\.com/i, /paypal\.com/i, /\bStarter\b/, /\bElite\b/, /\bAI\s+Care\b/i
  ];
  const vatAssertions = [
    /\bVAT\s+registered\b/i, /\bregistered\s+for\s+VAT\b/i,
    /\b20\s*%\s*VAT\b/i, /\bVAT\s+at\s+\d+\s*%/i,
    /\bVAT\s+included\b/i, /\bVAT\s+excluded\b/i, /\bVAT\s+inclusive\b/i, /\bVAT\s+exclusive\b/i, /\btax\s+amount\b/i
  ];
  for (const str of collectStrings(a)) {
    for (const re of legacyPatterns) if (re.test(str)) fail('legacy content', `obsolete commercial reference in text: "${str}"`);
    for (const re of vatAssertions) if (re.test(str)) fail('VAT assertion', `unsupported claim in text: "${str}"`);
  }

  return { checks, failures };
}
