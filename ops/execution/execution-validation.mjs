/* Nexora Agreement Execution System (PROP.7) — shared execution core.
   Turns a governed READY_FOR_EXECUTION Agreement (PROP.5) into a governed,
   evidence-driven execution package + execution record.

   THIS IS GOVERNANCE + EVIDENCE MODELLING ONLY. It does NOT:
     - fabricate signatures, signer identity, or provider events;
     - mark an Agreement EXECUTED without valid, complete evidence;
     - invent legal terms;
     - implement invoicing, payment, or Stripe;
     - touch the commercial Source of Truth, pricing, or the Agreement's status.

   Key invariants:
     - Only a governed READY_FOR_EXECUTION Agreement may enter PROP.7 (DRAFT /
       Proposal / handoff / arbitrary HTML / unsigned JSON / tampered agreement
       / unresolved mandatory decisions are all refused).
     - Agreement status stays READY_FOR_EXECUTION. Execution status is a SEPARATE
       governed concept (PREPARED … EXECUTED). This layer never writes SIGNED.
     - Status transitions are EVIDENCE-DRIVEN. There is no --force-executed and
       no --mark-signed shortcut. PREPARED -> EXECUTED directly is impossible.
     - The execution fingerprint is a deterministic SHA-256 over the governed
       record content + evidence. A changed execution record FAILS verification.
     - A checksum/fingerprint is NOT a digital signature. Final document output
       is NOT an e-signature. READY_FOR_EXECUTION is NOT SIGNED. EXECUTED is
       NOT PAID.

   Node built-ins only. This module performs no printing and never calls
   process.exit — CLI tools decide how to print/exit. */
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
  validateAgreement,
  isReadyForExecution,
  classifyInput as classifyAgreementInput,
  loadLegalDecisions
} from '../agreements/agreement-validation.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const executionDir = __dirname;
const root = path.join(__dirname, '..', '..');

export const EXECUTION_VERSION = '1.0';
export const EXECUTION_SCHEMA = 'nexora-agreement-execution/v1';
export const EXECUTION_BUNDLE_SCHEMA = 'nexora-agreement-executed-bundle/v1';
export const EXECUTION_PACKAGE_SCHEMA = 'nexora-agreement-execution-package/v1';

/* Execution status model — fail-closed. EXECUTED requires all required
   signers complete + valid evidence + a passing finalize gate. */
export const EXECUTION_STATUSES = [
  'PREPARED',
  'SENT_FOR_SIGNATURE',
  'PARTIALLY_SIGNED',
  'EXECUTED',
  'DECLINED',
  'CANCELLED',
  'EXPIRED'
];
export const TERMINAL_STATUSES = ['EXECUTED', 'DECLINED', 'CANCELLED', 'EXPIRED'];

export const EXECUTION_ID_RE = /^EXE-\d{4}-\d{4}$/;
export const SIGNER_ROLES = ['CLIENT', 'NEXORA'];

export const EVENT_TYPES = [
  'EXECUTION_REQUESTED',
  'SIGNER_COMPLETED',
  'EXECUTION_DECLINED',
  'EXECUTION_CANCELLED',
  'EXECUTION_EXPIRED'
];

export const PROVIDERS = ['MANUAL', 'TEST_ADAPTER', 'NONE'];
export const EVIDENCE_TYPES = ['MANUAL_RECORD', 'E_SIGNATURE_PROVIDER'];
export const EXECUTION_METHODS = ['MANUAL', 'E_SIGNATURE_PROVIDER'];

export const PROVIDER_DECISION = 'OWNER DECISION REQUIRED — E-SIGNATURE PROVIDER';
export const TEST_LABEL = 'TEST ONLY — NOT LEGAL SIGNATURE — NOT FOR PRODUCTION';

export const SIGNATURE_ANCHORS = [
  { anchor: 'CLIENT_SIGNATURE', signer_role: 'CLIENT' },
  { anchor: 'CLIENT_NAME', signer_role: 'CLIENT' },
  { anchor: 'CLIENT_DATE', signer_role: 'CLIENT' },
  { anchor: 'NEXORA_SIGNATURE', signer_role: 'NEXORA' },
  { anchor: 'NEXORA_NAME', signer_role: 'NEXORA' },
  { anchor: 'NEXORA_DATE', signer_role: 'NEXORA' }
];

export const OUT_DIR = path.join(executionDir, 'out');
export const PRIVATE_DIR = path.join(executionDir, 'private');
export const EXAMPLES_DIR = path.join(executionDir, 'examples');

/* ------------------------------------------------------------------ */
/* Canonicalisation + integrity.                                       */
/* ------------------------------------------------------------------ */
function sortKeys(v) {
  if (Array.isArray(v)) return v.map(sortKeys);
  if (v !== null && typeof v === 'object') {
    const out = {};
    for (const k of Object.keys(v).sort()) out[k] = sortKeys(v[k]);
    return out;
  }
  return v;
}

/* Canonical Agreement content (PROP.5 model) for checksum linkage. Formatting
   and key order are irrelevant; ANY change to governed content changes the
   checksum. Fixture markers are excluded (they are not governed content). */
export function canonicalAgreement(a) {
  const clone = JSON.parse(JSON.stringify(a));
  delete clone._example;
  delete clone._comment;
  return JSON.stringify(sortKeys(clone));
}

export function agreementChecksum(a) {
  return sha256hex(canonicalAgreement(a));
}

function canonicalEvent(e) {
  return JSON.stringify(sortKeys(JSON.parse(JSON.stringify(e))));
}

/* ------------------------------------------------------------------ */
/* Input-location policy. Real execution records + packages are private */
/* (or generated under out/). Only committed synthetic examples may be  */
/* tracked, and they must be marked "_example": true.                   */
/* ------------------------------------------------------------------ */
export function classifyExecutionInput(filePath) {
  const abs = path.resolve(filePath);
  if (abs.startsWith(path.resolve(OUT_DIR) + path.sep)) return 'OUT';
  if (abs.startsWith(path.resolve(PRIVATE_DIR) + path.sep)) return 'PRIVATE';
  if (abs.startsWith(path.resolve(EXAMPLES_DIR) + path.sep)) return 'EXAMPLES';
  return 'UNSAFE';
}

/* ------------------------------------------------------------------ */
/* Signer model. No identity-verification claims are made or allowed.  */
/* ------------------------------------------------------------------ */
export function defaultSignersFor(agreement) {
  const client = agreement.client || {};
  const contact = client.contact || {};
  const signers = [
    { role: 'CLIENT', name: client.name || '', email: contact.email || null, organisation: client.company || null, required: true }
  ];
  signers.push({ role: 'NEXORA', name: 'Nexora Creative Studio', email: null, organisation: 'Nexora Creative Studio', required: true });
  return signers;
}

export function validateSigners(signers) {
  const reasons = [];
  if (!Array.isArray(signers) || signers.length === 0) {
    reasons.push('signers required (at least one signer)');
    return { ok: false, reasons };
  }
  const roles = new Set();
  for (const s of signers) {
    if (!s || typeof s !== 'object') { reasons.push('signer entry must be an object'); continue; }
    if (!SIGNER_ROLES.includes(s.role)) reasons.push(`signer role "${s.role}" — must be one of ${SIGNER_ROLES.join(', ')}`);
    if (roles.has(s.role)) reasons.push(`duplicate signer role "${s.role}"`);
    roles.add(s.role);
    if (typeof s.name !== 'string' || !s.name.trim()) reasons.push(`signer ${s.role} · name required`);
    if (typeof s.required !== 'boolean') reasons.push(`signer ${s.role} · required boolean required`);
    if (s.email != null && typeof s.email === 'string' && s.email.trim() && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(s.email.trim())) {
      reasons.push(`signer ${s.role} · invalid email "${s.email}"`);
    }
    if (s.organisation != null && typeof s.organisation !== 'string') reasons.push(`signer ${s.role} · organisation must be a string`);
    for (const claim of IDENTITY_CLAIMS) if (claim.test(JSON.stringify(s))) reasons.push(`signer ${s.role} · identity claim "${claim}" is not evidenced`);
  }
  /* The governed signer model requires BOTH roles, both required. An execution
     that omits a required role can never reach EXECUTED. */
  for (const role of SIGNER_ROLES) {
    if (!roles.has(role)) reasons.push(`missing required signer role "${role}" — both CLIENT and NEXORA must sign`);
  }
  const required = signers.filter((s) => s.required === true);
  if (required.length === 0) reasons.push('at least one required signer required');
  return { ok: reasons.length === 0, reasons };
}

/* ------------------------------------------------------------------ */
/* Claims that REQUIRE real evidence and are therefore NEVER allowed on */
/* an execution record produced by this layer.                         */
/* ------------------------------------------------------------------ */
/* Positive assertions only — a statement that something is NOT verified is
   not a claim. (?<!not\s) keeps "not cryptographically verified" from firing
   while still catching "cryptographically verified" as a bare assertion. */
export const IDENTITY_CLAIMS = [
  /(?<!not\s)identity\s+verified/i,
  /\bKYC\b/i,
  /IP\s+address\s+verified/i,
  /certificate[-\s]backed/i,
  /qualified\s+electronic\s+signature/i,
  /advanced\s+electronic\s+signature/i,
  /\bnotari[sz]/i,
  /(?<!not\s)cryptographically\s+verified/i
];

export function scanIdentityClaims(text) {
  return IDENTITY_CLAIMS.filter((re) => re.test(text)).map((re) => `identity claim: ${re}`);
}

/* Secret-like values (Stripe, GitHub, AWS, JWT, OAuth, API key, PEM). These
   detection patterns are used by the validator to prove nothing leaks. */
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

/* Fake signature/certificate fields must never appear on a record. A record
   that carries such fields is defective. */
const FAKE_SIGNATURE_KEYS = [
  /signature_certificate/i,
  /signature_image/i,
  /signature_bytes/i,
  /signed_pdf/i,
  /e_signature_value/i,
  /signature_value/i
];

export function scanFakeSignature(record) {
  const violations = [];
  if (record.signed_document_ref != null) violations.push('signed_document_ref must be null — this layer never claims a signed document');
  (function walk(v) {
    if (Array.isArray(v)) { v.forEach(walk); return; }
    if (v !== null && typeof v === 'object') {
      for (const k of Object.keys(v)) {
        if (FAKE_SIGNATURE_KEYS.some((re) => re.test(k))) violations.push(`fake signature/certificate field "${k}"`);
        walk(v[k]);
      }
    }
  })(record);
  return violations;
}

function collectStrings(obj, out = []) {
  if (typeof obj === 'string') { out.push(obj); return out; }
  if (Array.isArray(obj)) { for (const v of obj) collectStrings(v, out); return out; }
  if (obj !== null && typeof obj === 'object') { for (const k of Object.keys(obj)) collectStrings(obj[k], out); }
  return out;
}

/* ------------------------------------------------------------------ */
/* Signer completion state (from evidence).                            */
/* ------------------------------------------------------------------ */
export function signerCompletionState(record) {
  const events = (record.evidence && record.evidence.events) || [];
  const completed = new Set(events.filter((e) => e.event_type === 'SIGNER_COMPLETED').map((e) => e.signer_role));
  const signers = record.signers || [];
  const state = signers.map((s) => ({ role: s.role, required: !!s.required, completed: completed.has(s.role) }));
  const required = state.filter((s) => s.required);
  const allCompleted = required.length > 0 && required.every((s) => s.completed);
  return { state, completed: [...completed], allCompleted, requiredCount: required.length, completedCount: completed.size };
}

/* ------------------------------------------------------------------ */
/* Execution fingerprint (deterministic SHA-256).                      */
/*                                                                     */
/* WHAT IS HASHED: execution identity + Agreement linkage (id/version/ */
/* status/checksum/manifest/proposal lineage) + status + signers +     */
/* normalised evidence events + completion timestamps. Everything that  */
/* makes the record what it is. Excluded: execution_fingerprint itself, */
/* audit_events (append-only provenance), recorded_at, _example.       */
/*                                                                     */
/* A checksum/fingerprint is an integrity aid ONLY. It is NOT a digital */
/* signature and provides no signer authenticity.                      */
/* ------------------------------------------------------------------ */
export function buildExecutionFingerprint(record) {
  const signers = (record.signers || [])
    .slice()
    .sort((a, b) => String(a.role).localeCompare(String(b.role)))
    .map((s) => ({ role: s.role, name: s.name, email: s.email || null, organisation: s.organisation || null, required: !!s.required }));
  const events = ((record.evidence && record.evidence.events) || []).map(canonicalEvent).sort();
  const input = {
    schema: record.schema,
    execution_id: record.execution_id,
    execution_version: record.execution_version,
    agreement_id: record.agreement_id,
    agreement_version: record.agreement_version,
    agreement_status: record.agreement_status,
    agreement_checksum_sha256: record.agreement_checksum_sha256,
    agreement_manifest_ref: record.agreement_manifest_ref || null,
    proposal_id: record.proposal_id,
    proposal_version: record.proposal_version,
    proposal_fingerprint: record.proposal_fingerprint,
    status: record.status,
    signers,
    execution_method: record.execution_method || null,
    provider: record.provider || null,
    provider_request_id: record.provider_request_id || null,
    provider_document_id: record.provider_document_id || null,
    requested_at: record.requested_at || null,
    completed_at: record.completed_at || null,
    cancelled_at: record.cancelled_at || null,
    expired_at: record.expired_at || null,
    declined_at: record.declined_at || null,
    evidence_events: events
  };
  return sha256hex(JSON.stringify(sortKeys(input)));
}

export function verifyExecutionFingerprint(record) {
  const expected = record.execution_fingerprint;
  if (typeof expected !== 'string' || !/^[0-9a-f]{64}$/.test(expected)) {
    return { ok: false, reasons: ['execution_fingerprint missing or malformed'] };
  }
  const actual = buildExecutionFingerprint(record);
  if (actual !== expected) {
    return { ok: false, reasons: ['execution fingerprint mismatch — execution record content has been changed'] };
  }
  return { ok: true, reasons: [] };
}

/* ------------------------------------------------------------------ */
/* Evidence event validation (structural + ownership).                 */
/* ------------------------------------------------------------------ */
export function validateEvidenceEvent(record, event) {
  const reasons = [];
  if (!event || typeof event !== 'object') return { ok: false, reasons: ['evidence event must be an object'] };
  if (typeof event.event_id !== 'string' || !event.event_id.trim()) reasons.push('event_id required');
  if (event.execution_id !== record.execution_id) reasons.push('event execution_id does not match the record');
  if (event.agreement_id !== record.agreement_id) reasons.push('event agreement_id does not match the record');
  if (!EVENT_TYPES.includes(event.event_type)) reasons.push(`event_type "${event.event_type}" — must be one of ${EVENT_TYPES.join(', ')}`);
  if (typeof event.event_time !== 'string' || !/^\d{4}-\d{2}-\d{2}T/.test(event.event_time)) reasons.push('event_time ISO-8601 required');
  if (event.event_type === 'SIGNER_COMPLETED') {
    if (!event.signer_role || !record.signers.some((s) => s.role === event.signer_role)) {
      reasons.push(`SIGNER_COMPLETED requires a signer_role present on the record ("${event.signer_role || ''}")`);
    }
  }
  if (!EVIDENCE_TYPES.includes(event.evidence_type)) reasons.push(`evidence_type "${event.evidence_type}" — must be MANUAL_RECORD or E_SIGNATURE_PROVIDER`);
  if (event.document_checksum_sha256 != null && !/^[0-9a-f]{64}$/.test(event.document_checksum_sha256)) {
    reasons.push('document_checksum_sha256 must be 64-char hex or null');
  }
  return { ok: reasons.length === 0, reasons };
}

/* ------------------------------------------------------------------ */
/* Evidence-driven transition engine. Pure — returns a NEW record.     */
/* ------------------------------------------------------------------ */
export function allowedTransition(from, eventType) {
  if (TERMINAL_STATUSES.includes(from)) return false;
  switch (from) {
    case 'PREPARED':
      return eventType === 'EXECUTION_REQUESTED' || eventType === 'EXECUTION_CANCELLED' || eventType === 'EXECUTION_EXPIRED';
    case 'SENT_FOR_SIGNATURE':
    case 'PARTIALLY_SIGNED':
      return eventType === 'SIGNER_COMPLETED' || eventType === 'EXECUTION_DECLINED' ||
             eventType === 'EXECUTION_CANCELLED' || eventType === 'EXECUTION_EXPIRED';
    default:
      return false;
  }
}

function auditId(record, event, n) {
  return 'aud-' + sha256hex(`${record.execution_id}:${n}:${event.event_id || ''}`).slice(0, 12);
}

export function applyEvent(record, event, opts = {}) {
  const structural = validateEvidenceEvent(record, event);
  if (!structural.ok) return { ok: false, reasons: structural.reasons };

  const from = record.status;
  if (TERMINAL_STATUSES.includes(from)) return { ok: false, reasons: [`${from} is terminal — no further transitions`] };
  if (!allowedTransition(from, event.event_type)) {
    return { ok: false, reasons: [`no evidence-driven transition from ${from} via ${event.event_type}`] };
  }

  let to = from;
  const next = {
    ...record,
    requested_at: record.requested_at || null,
    completed_at: record.completed_at || null,
    cancelled_at: record.cancelled_at || null,
    expired_at: record.expired_at || null,
    declined_at: record.declined_at || null
  };

  if (event.event_type === 'EXECUTION_REQUESTED') {
    to = 'SENT_FOR_SIGNATURE';
    next.requested_at = event.event_time;
    next.provider_request_id = event.provider_request_id || next.provider_request_id;
    next.provider_document_id = event.document_id || next.provider_document_id;
  } else if (event.event_type === 'SIGNER_COMPLETED') {
    to = 'PARTIALLY_SIGNED';
  } else if (event.event_type === 'EXECUTION_DECLINED') {
    to = 'DECLINED';
    next.declined_at = event.event_time;
  } else if (event.event_type === 'EXECUTION_CANCELLED') {
    to = 'CANCELLED';
    next.cancelled_at = event.event_time;
  } else if (event.event_type === 'EXECUTION_EXPIRED') {
    to = 'EXPIRED';
    next.expired_at = event.event_time;
  }

  const evidence = {
    events: [...((record.evidence && record.evidence.events) || []), event],
    completion: (record.evidence && record.evidence.completion) || null,
    provider_summary: (record.evidence && record.evidence.provider_summary) || null
  };
  const n = evidence.events.length;
  const auditEvent = {
    event_id: auditId(record, event, n),
    at: event.event_time,
    action: event.event_type,
    detail: `${from} -> ${to}` + (event.signer_role ? ` (signer ${event.signer_role})` : ''),
    by: 'CLI'
  };

  next.status = to;
  next.evidence = evidence;
  next.audit_events = [...((record.audit_events || []).filter(Boolean)), auditEvent];
  next.recorded_at = event.event_time;
  delete next.execution_fingerprint;
  next.execution_fingerprint = buildExecutionFingerprint(next);
  return { ok: true, record: next, from, to };
}

/* ------------------------------------------------------------------ */
/* EXECUTED gate — the ONLY path to EXECUTED. All evidence must be     */
/* present, valid and belong to the same execution/agreement.          */
/* ------------------------------------------------------------------ */
export function executionGate(record, opts = {}) {
  const reasons = [];
  if (record.status === 'EXECUTED') reasons.push('already EXECUTED');
  if (record.status === 'DECLINED') reasons.push('DECLINED — cannot execute');
  if (record.status === 'CANCELLED') reasons.push('CANCELLED — cannot execute');
  if (record.status === 'EXPIRED') reasons.push('EXPIRED — cannot execute');
  if (record.status === 'PREPARED') reasons.push('not dispatched — EXECUTION_REQUESTED evidence required');

  const fp = verifyExecutionFingerprint(record);
  if (!fp.ok) reasons.push(...fp.reasons);

  const { allCompleted, requiredCount, completedCount } = signerCompletionState(record);
  if (!allCompleted) reasons.push(`not all required signers completed (${completedCount}/${requiredCount})`);

  const events = (record.evidence && record.evidence.events) || [];
  for (const e of events) {
    if (e.execution_id !== record.execution_id) reasons.push(`evidence event ${e.event_id} belongs to a different execution`);
    if (e.agreement_id !== record.agreement_id) reasons.push(`evidence event ${e.event_id} belongs to a different Agreement`);
  }
  if (events.some((e) => e.event_type === 'EXECUTION_DECLINED')) reasons.push('evidence contains a declined signer/execution');
  if (events.some((e) => e.event_type === 'EXECUTION_CANCELLED')) reasons.push('evidence contains a cancellation');
  if (events.some((e) => e.event_type === 'EXECUTION_EXPIRED')) reasons.push('evidence contains an expiry');

  if (opts.agreement) {
    if (opts.agreement.status !== 'READY_FOR_EXECUTION') reasons.push('Agreement is not READY_FOR_EXECUTION');
    const ck = agreementChecksum(opts.agreement);
    if (ck !== record.agreement_checksum_sha256) reasons.push('Agreement checksum does not match the execution record');
    if (opts.agreement.proposal) {
      if (opts.agreement.proposal.proposal_id !== record.proposal_id) reasons.push('proposal_id linkage mismatch');
      if (opts.agreement.proposal.version !== record.proposal_version) reasons.push('proposal version linkage mismatch');
    }
    const pv = opts.agreement.provenance || {};
    if (pv.proposal_fingerprint && pv.proposal_fingerprint !== record.proposal_fingerprint) reasons.push('proposal fingerprint linkage mismatch');
  }

  /* Re-validate every evidence event through its provider adapter
     (defence in depth — finalize re-verifies what record-event accepted). */
  if (opts.validateEvent) {
    for (const e of events) {
      const v = opts.validateEvent(record, e);
      if (!v.ok) reasons.push(...v.reasons.map((r) => `evidence ${e.event_id}: ${r}`));
    }
  }

  return { ok: reasons.length === 0, reasons };
}

/* ------------------------------------------------------------------ */
/* Full record validation.                                             */
/* ------------------------------------------------------------------ */
export function validateExecutionRecord(record, opts = {}) {
  const label = opts.label || 'execution';
  const requireExampleMarker = opts.requireExampleMarker !== false;
  const checks = [];
  const failures = [];
  const pass = (t) => checks.push({ ok: true, text: `${label} · ${t}` });
  const fail = (t, d) => { const full = d ? `${label} · ${t} — ${d}` : `${label} · ${t}`; checks.push({ ok: false, text: full }); failures.push(full); };

  if (!record || typeof record !== 'object') { fail('structure', 'execution record must be a JSON object'); return { checks, failures }; }

  if (requireExampleMarker) {
    if (record._example === true) pass('example fixture marker');
    else fail('_example', 'execution record fixture must be marked "_example": true — real records belong in ops/execution/private/ or out/ (gitignored)');
  }

  if (record.schema === EXECUTION_SCHEMA) pass(`schema ${EXECUTION_SCHEMA}`);
  else fail('schema', `expected ${EXECUTION_SCHEMA}, got ${JSON.stringify(record.schema)}`);

  if (typeof record.execution_id === 'string' && EXECUTION_ID_RE.test(record.execution_id)) pass(`execution_id ${record.execution_id}`);
  else fail('execution_id', 'EXE-YYYY-NNNN format required');
  if (typeof record.execution_version === 'string' && /^\d+\.\d+$/.test(record.execution_version)) pass(`execution_version ${record.execution_version}`);
  else fail('execution_version', 'x.y format required');

  if (typeof record.agreement_id === 'string' && /^AGR-\d{4}-\d{4}$/.test(record.agreement_id)) pass(`agreement_id ${record.agreement_id}`);
  else fail('agreement_id', 'AGR-YYYY-NNNN format required');
  if (typeof record.agreement_version === 'string' && /^\d+\.\d+$/.test(record.agreement_version)) pass(`agreement_version ${record.agreement_version}`);
  else fail('agreement_version', 'x.y format required');
  if (record.agreement_status === 'READY_FOR_EXECUTION') pass('agreement_status READY_FOR_EXECUTION (PROP.7 input boundary)');
  else fail('agreement_status', `only a READY_FOR_EXECUTION Agreement may enter PROP.7, got ${JSON.stringify(record.agreement_status)}`);
  if (typeof record.agreement_checksum_sha256 === 'string' && /^[0-9a-f]{64}$/.test(record.agreement_checksum_sha256)) pass('agreement_checksum_sha256 (64-hex)');
  else fail('agreement_checksum_sha256', '64-char hex SHA-256 of the governed Agreement required');

  if (typeof record.proposal_id === 'string' && /^PRP-\d{4}-\d{4}$/.test(record.proposal_id)) pass(`proposal_id ${record.proposal_id}`);
  else fail('proposal_id', 'PRP-YYYY-NNNN format required');
  if (typeof record.proposal_version === 'string' && /^\d+\.\d+$/.test(record.proposal_version)) pass(`proposal_version ${record.proposal_version}`);
  else fail('proposal_version', 'x.y format required');
  if (typeof record.proposal_fingerprint === 'string' && /^[0-9a-f]{64}$/.test(record.proposal_fingerprint)) pass('proposal_fingerprint (64-hex)');
  else fail('proposal_fingerprint', '64-char hex canonical SHA-256 of the accepted Proposal required');

  if (EXECUTION_STATUSES.includes(record.status)) pass(`status ${record.status}`);
  else fail('status', `must be one of ${EXECUTION_STATUSES.join(', ')}`);

  if (record.execution_method != null && !EXECUTION_METHODS.includes(record.execution_method)) fail('execution_method', `must be ${EXECUTION_METHODS.join(' or ')}`);
  if (record.provider != null && !PROVIDERS.includes(record.provider)) fail('provider', `must be one of ${PROVIDERS.join(', ')}`);

  /* Signers — roles, uniqueness, required, no identity claims. */
  const sg = validateSigners(record.signers);
  if (sg.ok) pass(`signers valid (${record.signers.length} roles: ${record.signers.map((s) => s.role).join(', ')})`);
  else for (const r of sg.reasons) fail('signers', r);

  /* Evidence events — structure + ownership. */
  if (!Array.isArray(record.evidence) && (!record.evidence || !Array.isArray(record.evidence.events))) {
    fail('evidence', 'evidence.events array required');
  } else {
    const events = record.evidence.events;
    let ok = true;
    for (const e of events) {
      const ev = validateEvidenceEvent(record, e);
      if (!ev.ok) { ok = false; for (const r of ev.reasons) fail('evidence event', `${e.event_id || '(unnamed)'}: ${r}`); }
    }
    if (ok) pass(`evidence events valid (${events.length})`);
  }

  if (Array.isArray(record.audit_events)) pass('audit_events array present');
  else fail('audit_events', 'audit_events array required');

  /* Never a claimed signed document in this layer. */
  const fake = scanFakeSignature(record);
  if (fake.length === 0) pass('no fake signature/certificate/signed-document fields');
  else for (const f of fake) fail('fake signature fields', f);

  /* Identity / trust claims sweep. */
  const claims = scanIdentityClaims(JSON.stringify(record));
  if (claims.length === 0) pass('no unsupported identity/trust claims');
  else for (const c of claims) fail('unsupported claim', c);

  /* Legacy commercial / VAT / token / path-leakage sweep (shared PROP.6 core). */
  const allText = collectStrings(record).join('\n');
  for (const v of scanLegacy(allText)) fail('legacy content', v);
  for (const v of scanVatAssertions(allText)) fail('VAT assertion', v);
  for (const t of scanTokens(allText)) fail('leftover template token', t);
  for (const p of scanPathLeakage(allText)) fail('path leakage', p);

  /* Secret-like value sweep. */
  for (const s of scanSecrets(allText)) fail('secret-like value', s);

  /* Fingerprint — a governed record must verify. */
  const fp = verifyExecutionFingerprint(record);
  if (fp.ok) pass('execution fingerprint valid');
  else for (const r of fp.reasons) fail('execution fingerprint', r);

  return { checks, failures };
}

/* sha256hex is imported from the PROP.6 shared core and re-exported here so
   execution-layer consumers have a single integrity primitive. */
export { sha256hex };

/* ------------------------------------------------------------------ */
/* Executed-record bundle (§22). Immutable, no fake signed PDF.        */
/* ------------------------------------------------------------------ */
export function buildExecutedBundle(executionRecord, opts = {}) {
  const evidence = executionRecord.evidence || { events: [] };
  const bundle = {
    schema: EXECUTION_BUNDLE_SCHEMA,
    execution_id: executionRecord.execution_id,
    execution_version: executionRecord.execution_version,
    agreement_id: executionRecord.agreement_id,
    agreement_version: executionRecord.agreement_version,
    agreement_status: 'READY_FOR_EXECUTION',
    agreement_checksum_sha256: executionRecord.agreement_checksum_sha256,
    agreement_manifest_ref: executionRecord.agreement_manifest_ref || null,
    execution_record_ref: opts.executionRecordFilename || null,
    execution_fingerprint: executionRecord.execution_fingerprint,
    audit_trail: (executionRecord.audit_events || []).map((a) => ({ ...a })),
    evidence_summary: {
      provider: executionRecord.provider,
      evidence_type_count: evidence.events.length,
      signers_completed: signerCompletionState(executionRecord).completed.slice().sort(),
      completion_recorded_at: executionRecord.completed_at || null
    },
    signed_document_ref: null,
    signed_document_checksum_sha256: null,
    signed_document_boundary: 'No signed document bytes are provided by this layer. If a real e-signature provider later returns a signed PDF, a future adapter may archive it with a checksum. This bundle NEVER claims a signed PDF it does not hold.',
    recorded_at: executionRecord.completed_at || null,
    _example: executionRecord._example === true
  };
  if (executionRecord.provider === 'TEST_ADAPTER') {
    bundle.execution_provenance_test_only = true;
    bundle.test_label = TEST_LABEL;
  }
  return bundle;
}

/* ------------------------------------------------------------------ */
/* Agreement READY gate used by prepare (shared with PROP.5).          */
/* ------------------------------------------------------------------ */
export function validateReadyAgreement(agreement, opts = {}) {
  const label = opts.label || 'agreement-input';
  const checks = [];
  const failures = [];
  const pass = (t) => checks.push({ ok: true, text: `${label} · ${t}` });
  const fail = (t, d) => { const full = d ? `${label} · ${t} — ${d}` : `${label} · ${t}`; checks.push({ ok: false, text: full }); failures.push(full); };

  if (!agreement || typeof agreement !== 'object') { fail('structure', 'Agreement must be a JSON object'); return { checks, failures }; }
  if (agreement.schema === 'nexora-agreement/v1') pass(`schema ${agreement.schema}`);
  else fail('schema', 'nexora-agreement/v1 required');

  const v = validateAgreement(agreement, { label: `${label}·agreement`, requireExampleMarker: false, legalDecisionsPath: opts.legalDecisionsPath });
  checks.push(...v.checks);
  failures.push(...v.failures);

  if (agreement.status !== 'READY_FOR_EXECUTION') {
    fail('status', `only a READY_FOR_EXECUTION Agreement may enter PROP.7 (got ${JSON.stringify(agreement.status)})`);
  }

  if (failures.length === 0) {
    let decisions;
    try {
      decisions = loadLegalDecisions(opts.legalDecisionsPath);
    } catch (e) {
      fail('legal-decisions register', e.message);
      return { checks, failures };
    }
    const gate = isReadyForExecution(agreement, decisions);
    if (gate.ready) pass('READY_FOR_EXECUTION gate passed (all legal/commercial decisions resolved, integrity intact)');
    else fail('READY_FOR_EXECUTION gate', gate.reasons.join('; '));
  }
  return { checks, failures };
}

/* ------------------------------------------------------------------ */
/* Path helpers (deterministic, sanitised filenames — no client names).*/
/* ------------------------------------------------------------------ */
function cleanSegment(s) {
  const clean = String(s)
    .replace(/[^A-Za-z0-9._-]/g, '-')
    .replace(/-+/g, '-')
    .replace(/^[-.]+|[-.]+$/g, '');
  return clean || 'execution';
}

/* Evidence count is part of the name so every transition is a DISTINCT,
   immutable record file — two SIGNER_COMPLETED events in the same status can
   never collide or silently overwrite. */
export function executionFilename(executionId, version, status, evidenceCount) {
  return `${cleanSegment(executionId)}-v${cleanSegment(version)}-${cleanSegment(status)}-${Number(evidenceCount) || 0}.execution.json`;
}

export function executionPackageFilename(executionId, version) {
  return `${cleanSegment(executionId)}-v${cleanSegment(version)}.execution-package.json`;
}

export function executedBundleFilename(executionId, version) {
  return `${cleanSegment(executionId)}-v${cleanSegment(version)}-EXECUTED.execution-bundle.json`;
}

export function assertSafeExecutionOutput(outPath) {
  const resolved = path.resolve(outPath);
  const rel = path.relative(root, resolved);
  if (rel.startsWith('..') || path.isAbsolute(rel)) {
    return `Unsafe output path: ${outPath} — output must stay within the repository root.`;
  }
  return null;
}

export function defaultExecutionOutputDir() {
  return OUT_DIR;
}

/* Deterministic execution_id derived from an Agreement's lineage. */
export function defaultExecutionId(agreementId) {
  const m = String(agreementId).match(/^AGR-(\d{4}-\d{4})$/);
  return m ? `EXE-${m[1]}` : `EXE-${new Date().getUTCFullYear()}-0001`;
}
