#!/usr/bin/env node
/* Nexora Proposal Lifecycle (PROP.4) — governed lifecycle + auditability.
   Establishes and enforces the lifecycle surrounding a generated Proposal:

     DRAFT -> INTERNAL_APPROVED -> SENT (issued) -> CLIENT_ACCEPTED
                                                   -> DECLINED
                                                   -> EXPIRED
                                                   -> SUPERSEDED

   This is governance + lifecycle + auditability ONLY. It is NOT an
   e-signature implementation, NOT the Agreement generator, NOT invoicing,
   and NOT payment processing. Acceptance is recorded as a provider-neutral
   fact (who/when/how + a content fingerprint), never a signature.

   Core guarantees:
     - Forward-only, explicit, fail-closed transitions (no arbitrary backwards moves).
     - An ACCEPTED proposal is IMMUTABLE: a SHA-256 fingerprint of its governed
       content is recorded at acceptance; verify() refuses any modified accepted
       Proposal. A revised Proposal is a NEW version (supersedes/superseded_by),
       never a mutation of the accepted historical version.
     - Deterministic expiry (valid_until = issue_date + 30 days, frozen); acceptance
       of an expired Proposal is refused.
     - Controlled Agreement handoff artifact, emitted ONLY from an ACCEPTED
       Proposal whose fingerprint still verifies. The handoff is not a contract.

   Input policy (mirrors the PROP.3 generator): real proposals live in
   ops/proposals/private/ (gitignored, no marker required); committed synthetic
   fixtures live in ops/proposals/examples/ and MUST carry "_example": true;
   any other path is refused.

   Records (gitignored):
     Acceptance record -> ops/proposals/private/acceptance/{id}-v{version}.acceptance.json
     Agreement handoff -> ops/proposals/private/handoffs/{id}-v{version}.handoff.json

   Node built-ins only. No external dependencies. */
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { validatePackageMapping, validateProposal } from './proposal-validation.mjs';
import { classifyInput } from './generate-proposal.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const proposalsDir = __dirname;
const root = path.join(__dirname, '..', '..');

const PRIVATE_DIR = path.join(proposalsDir, 'private');
const ACCEPTANCE_DIR = path.join(PRIVATE_DIR, 'acceptance');
const HANDOFF_DIR = path.join(PRIVATE_DIR, 'handoffs');

export const LIFECYCLE_VERSION = '1.0';
export const CANONICAL_FORMAT = 'nexora-proposal-canonical/v1';
export const ACCEPTANCE_SCHEMA = 'nexora-proposal-acceptance/v1';
export const HANDOFF_SCHEMA = 'nexora-agreement-handoff/v1';

/* ------------------------------------------------------------------ */
/* Canonical lifecycle model (reuses the PROP.1 status enum,           */
/* extended with DECLINED). Forward-only, explicit, fail-closed.       */
/* ------------------------------------------------------------------ */
export const TRANSITIONS = {
  DRAFT: ['INTERNAL_APPROVED', 'SENT'],
  INTERNAL_APPROVED: ['SENT'],
  SENT: ['CLIENT_ACCEPTED', 'DECLINED', 'EXPIRED', 'SUPERSEDED'],
  CLIENT_ACCEPTED: [],
  DECLINED: [],
  EXPIRED: [],
  SUPERSEDED: []
};

export const TERMINAL = ['CLIENT_ACCEPTED', 'DECLINED', 'EXPIRED', 'SUPERSEDED'];

export class LifecycleError extends Error {}

/* ------------------------------------------------------------------ */
/* Dates + versions (deterministic; ISO date strings compare safely). */
/* ------------------------------------------------------------------ */
export function todayISO() {
  const d = new Date();
  const pad = (n) => String(n).padStart(2, '0');
  return `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}`;
}

/* A Proposal is expired when as-of > valid_until (valid_until is inclusive).
   valid_until = issue_date + proposal_validity_days (30, frozen). */
export function isExpired(p, asOf) {
  const iso = asOf || todayISO();
  return iso > p.valid_until;
}

export function parseVersion(v) {
  const m = String(v).match(/^(\d+)\.(\d+)$/);
  return m ? [Number(m[1]), Number(m[2])] : null;
}

/* true if a > b, false if a <= b, null if unparseable. */
export function versionGt(a, b) {
  const A = parseVersion(a);
  const B = parseVersion(b);
  if (!A || !B) return null;
  return A[0] > B[0] || (A[0] === B[0] && A[1] > B[1]);
}

/* ------------------------------------------------------------------ */
/* Canonical fingerprint (SHA-256, Node built-in).                     */
/*                                                                     */
/* WHAT IS HASHED: the full governed Proposal content, excluding ONLY  */
/* the fixture markers (_example, _comment). Status and acceptance     */
/* metadata ARE included, so the fingerprint captures the exact        */
/* accepted state. Key order is normalised (sorted recursively) and    */
/* serialisation is compact JSON (UTF-8), so formatting/whitespace is  */
/* irrelevant — a cosmetic re-format does NOT change the fingerprint,  */
/* but ANY change to governed content does.                            */
/* WHEN: computed at the moment of acceptance (after the transition to */
/* CLIENT_ACCEPTED) and stored in the acceptance record.               */
/* HOW VERIFIED: verify() re-canonicalises the current file and        */
/* compares to the recorded fingerprint; a mismatch FAILS CLOSED.      */
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

export function canonicalProposal(p) {
  const clone = JSON.parse(JSON.stringify(p));
  delete clone._example;
  delete clone._comment;
  return JSON.stringify(sortKeys(clone));
}

export function proposalFingerprint(p) {
  return crypto.createHash('sha256').update(canonicalProposal(p), 'utf8').digest('hex');
}

/* ------------------------------------------------------------------ */
/* Record / handoff builders + deterministic private paths.            */
/* ------------------------------------------------------------------ */
export function acceptanceRecordPath(proposalId, version) {
  return path.join(ACCEPTANCE_DIR, `${proposalId}-v${version}.acceptance.json`);
}

export function handoffPath(proposalId, version) {
  return path.join(HANDOFF_DIR, `${proposalId}-v${version}.handoff.json`);
}

export function buildAcceptanceRecord(data, meta) {
  return {
    schema: ACCEPTANCE_SCHEMA,
    proposal_id: data.proposal_id,
    version: data.version,
    accepted_at: meta.acceptedAt,
    accepted_by_name: meta.acceptedBy,
    acceptance_method: meta.method,
    content_sha256: meta.fp,
    canonical_format: CANONICAL_FORMAT,
    recorded_at: new Date().toISOString()
  };
}

export function buildHandoff(data, rec) {
  const cs = data.commercial_schedule;
  return {
    schema: HANDOFF_SCHEMA,
    status: 'READY_FOR_AGREEMENT',
    proposal: { proposal_id: data.proposal_id, version: data.version },
    acceptance: {
      accepted_at: rec.accepted_at,
      accepted_by_name: rec.accepted_by_name,
      acceptance_method: rec.acceptance_method,
      content_sha256: rec.content_sha256,
      canonical_format: rec.canonical_format
    },
    client: data.client,
    project: { title: data.project.title, summary: data.project.summary },
    offering: data.offering,
    commercial_snapshot: {
      currency: cs.currency,
      reference_price: cs.reference_price != null ? cs.reference_price : null,
      approved_final_project_price: cs.approved_final_project_price,
      setup_fee: cs.setup_fee != null ? cs.setup_fee : null,
      payment_schedule: cs.payment_schedule != null ? cs.payment_schedule : null,
      recurring_fees: cs.recurring_fees != null ? cs.recurring_fees : null,
      care: cs.care != null ? cs.care : null,
      warranty: cs.warranty != null ? cs.warranty : null,
      vat: cs.vat
    },
    generated_at: new Date().toISOString(),
    note: 'Agreement handoff artifact — NOT a contract, NOT an invoice, NOT payment. The accepted Proposal snapshot (Approved Final Project Price basis) is the commercial input for the future Agreement stage.'
  };
}

/* ------------------------------------------------------------------ */
/* Fail-closed load + shared PROP.1 validation. Every lifecycle        */
/* operation re-validates through the shared core, so legacy, VAT,     */
/* and commercial drift can never be carried forward by the lifecycle. */
/* ------------------------------------------------------------------ */
export function validateLifecycle(data) {
  const issues = [];
  if (data.supersedes) {
    const s = data.supersedes;
    if (!/^PRP-\d{4}-\d{4}$/.test(s.proposal_id)) issues.push('supersedes.proposal_id must be in PRP-YYYY-NNNN format');
    if (s.version != null && !/^\d+\.\d+$/.test(s.version)) issues.push('supersedes.version must be in x.y format');
    else if (s.version != null && versionGt(data.version, s.version) === false) {
      issues.push(`supersedes reference version ${s.version} is not lower than current version ${data.version} — a superseding version must be higher`);
    }
  }
  if (data.superseded_by) {
    const sb = data.superseded_by;
    if (!/^PRP-\d{4}-\d{4}$/.test(sb.proposal_id)) issues.push('superseded_by.proposal_id must be in PRP-YYYY-NNNN format');
    if (sb.version != null && !/^\d+\.\d+$/.test(sb.version)) issues.push('superseded_by.version must be in x.y format');
  }
  if (data.status === 'SUPERSEDED' && !data.superseded_by) {
    issues.push('status SUPERSEDED requires a superseded_by reference (created by the lifecycle supersede command)');
  }
  return issues;
}

export function loadProposal(filePath) {
  const kind = classifyInput(filePath);
  if (kind === 'UNSAFE') {
    throw new LifecycleError(
      `Refusing unsafe input: ${filePath}\n` +
      'Proposals must come from ops/proposals/private/ (real proposals, gitignored) or ' +
      'ops/proposals/examples/ (synthetic fixtures marked "_example": true).');
  }
  let data;
  try {
    data = JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch (e) {
    throw new LifecycleError(`Cannot read proposal: ${e.message}`);
  }
  const mapping = validatePackageMapping();
  const proposal = validateProposal(data, { label: path.basename(filePath), requireExampleMarker: false });
  const failures = mapping.failures.concat(proposal.failures);
  if (kind === 'EXAMPLES' && data._example !== true) {
    failures.push(`${path.basename(filePath)} · unsafe committed fixture — examples/ must be marked "_example": true`);
  }
  for (const issue of validateLifecycle(data)) failures.push(issue);
  if (failures.length > 0) {
    throw new LifecycleError(
      `VALIDATION FAILED — ${failures.length} issue(s). No lifecycle operation performed.\n  ` +
      failures.join('\n  '));
  }
  return data;
}

function saveProposal(filePath, data) {
  fs.writeFileSync(filePath, JSON.stringify(data, null, 2) + '\n');
}

/* Acceptance records and handoffs are immutable by default. */
function writeJson(outPath, obj, opts = {}) {
  if (fs.existsSync(outPath) && !opts.overwrite) {
    throw new LifecycleError(
      `Refusing to overwrite existing file: ${path.relative(root, outPath)}. ` +
      'Accepted records / handoffs are immutable by default — use --overwrite to replace ' +
      '(accepted-proposal immutability enforcement).');
  }
  fs.mkdirSync(path.dirname(outPath), { recursive: true });
  fs.writeFileSync(outPath, JSON.stringify(obj, null, 2) + '\n');
}

function assertTransition(data, to) {
  const allowed = TRANSITIONS[data.status] || [];
  if (!allowed.includes(to)) {
    const hint = allowed.length ? `Allowed: ${allowed.join(', ')}` : 'Terminal status — this Proposal cannot change';
    throw new LifecycleError(`Invalid transition ${data.status} -> ${to}. ${hint}.`);
  }
}

/* ------------------------------------------------------------------ */
/* Commands                                                            */
/* ------------------------------------------------------------------ */
function cmdIssue(proposalPath) {
  const data = loadProposal(proposalPath);
  assertTransition(data, 'SENT');
  data.status = 'SENT';
  saveProposal(proposalPath, data);
  console.log(`Issued ${data.proposal_id} v${data.version} — status ${data.status}`);
}

function cmdAccept(proposalPath, opts) {
  const data = loadProposal(proposalPath);
  assertTransition(data, 'CLIENT_ACCEPTED');
  const acceptedAt = opts.date || opts.asOf || todayISO();
  if (isExpired(data, acceptedAt)) {
    throw new LifecycleError(
      `Refusing acceptance of an expired Proposal — valid_until ${data.valid_until} < acceptance date ${acceptedAt}. ` +
      'Proposal validity is 30 days (issue_date + 30). Create a new version/lineage instead.');
  }
  const by = opts.by ? String(opts.by).trim() : '';
  if (!by) throw new LifecycleError('accept requires --by "<name>" (the person accepting on behalf of the client)');
  const method = opts.method || (data.acceptance && data.acceptance.method) || 'written';
  const provider = data.acceptance && data.acceptance.provider != null ? data.acceptance.provider : null;

  data.status = 'CLIENT_ACCEPTED';
  data.acceptance = { method, provider, status: 'ACCEPTED', accepted_by: by, accepted_at: acceptedAt };

  /* Re-validate the accepted-state Proposal before writing (fail closed). */
  const recheck = validateProposal(data, { label: 'accepted-state', requireExampleMarker: false });
  if (recheck.failures.length > 0) {
    throw new LifecycleError('Accepted-state Proposal failed re-validation; nothing was written. ' + recheck.failures.join('; '));
  }
  saveProposal(proposalPath, data);

  const fp = proposalFingerprint(data);
  const record = buildAcceptanceRecord(data, { fp, acceptedAt, acceptedBy: by, method });
  const recPath = opts.record ? path.resolve(opts.record) : acceptanceRecordPath(data.proposal_id, data.version);
  writeJson(recPath, record, { overwrite: Boolean(opts.overwrite) });

  console.log(`Accepted ${data.proposal_id} v${data.version} — CLIENT_ACCEPTED (immutable from now on)`);
  console.log(`  fingerprint (${CANONICAL_FORMAT}): ${fp}`);
  console.log(`  acceptance record: ${path.relative(root, recPath)}`);
}

function cmdDecline(proposalPath) {
  const data = loadProposal(proposalPath);
  assertTransition(data, 'DECLINED');
  data.status = 'DECLINED';
  saveProposal(proposalPath, data);
  console.log(`Declined ${data.proposal_id} v${data.version} — status DECLINED`);
}

function cmdExpire(proposalPath, opts) {
  const data = loadProposal(proposalPath);
  assertTransition(data, 'EXPIRED');
  const asOf = opts.asOf || opts.date || todayISO();
  if (!isExpired(data, asOf)) {
    throw new LifecycleError(
      `Proposal is NOT expired as of ${asOf} — valid_until ${data.valid_until}. ` +
      'Expiry is deterministic; it cannot be forced early.');
  }
  data.status = 'EXPIRED';
  saveProposal(proposalPath, data);
  console.log(`Expired ${data.proposal_id} v${data.version} — status EXPIRED`);
}

function cmdSupersede(proposalPath, opts) {
  const data = loadProposal(proposalPath);
  assertTransition(data, 'SUPERSEDED');
  if (!opts.by || !/^PRP-\d{4}-\d{4}$/.test(opts.by)) {
    throw new LifecycleError('supersede requires --by <proposal_id> in PRP-YYYY-NNNN format (the new Proposal that replaces this one)');
  }
  if (!opts.version || !/^\d+\.\d+$/.test(opts.version)) {
    throw new LifecycleError('supersede requires --version <x.y> (the version of the new Proposal)');
  }
  if (versionGt(opts.version, data.version) === false) {
    throw new LifecycleError(`Superseding version ${opts.version} must be HIGHER than the current version ${data.version}`);
  }
  data.status = 'SUPERSEDED';
  data.superseded_by = { proposal_id: opts.by, version: opts.version };
  if (opts.reason) data.superseded_by.reason = opts.reason;
  saveProposal(proposalPath, data);
  console.log(`Superseded ${data.proposal_id} v${data.version} — status SUPERSEDED (by ${opts.by} v${opts.version})`);
}

function cmdVerify(proposalPath, opts) {
  const data = loadProposal(proposalPath);
  const recPath = opts.record ? path.resolve(opts.record) : acceptanceRecordPath(data.proposal_id, data.version);
  if (!fs.existsSync(recPath)) {
    throw new LifecycleError(`No acceptance record at ${path.relative(root, recPath)} — cannot verify. Was this Proposal accepted through the lifecycle tool?`);
  }
  let rec;
  try {
    rec = JSON.parse(fs.readFileSync(recPath, 'utf8'));
  } catch (e) {
    throw new LifecycleError(`Cannot read acceptance record: ${e.message}`);
  }
  if (rec.proposal_id !== data.proposal_id || rec.version !== data.version) {
    throw new LifecycleError(`Acceptance record mismatch — record is for ${rec.proposal_id} v${rec.version}, Proposal is ${data.proposal_id} v${data.version}`);
  }
  const fp = proposalFingerprint(data);
  if (fp !== rec.content_sha256) {
    throw new LifecycleError(
      'FINGERPRINT MISMATCH — accepted content was modified.\n' +
      `  recorded ${CANONICAL_FORMAT}: ${rec.content_sha256}\n` +
      `  current  ${CANONICAL_FORMAT}: ${fp}\n` +
      'A modified accepted Proposal must never be used. Create a new version instead.');
  }
  console.log(`VERIFIED — ${data.proposal_id} v${data.version} content intact`);
  console.log(`  ${CANONICAL_FORMAT}: ${fp}`);
  return 0;
}

function cmdHandoff(proposalPath, opts) {
  const data = loadProposal(proposalPath);
  if (data.status !== 'CLIENT_ACCEPTED') {
    throw new LifecycleError(`Only an ACCEPTED Proposal may create an Agreement handoff — this Proposal is ${data.status}.`);
  }
  const recPath = opts.record ? path.resolve(opts.record) : acceptanceRecordPath(data.proposal_id, data.version);
  if (!fs.existsSync(recPath)) {
    throw new LifecycleError(`No acceptance record at ${path.relative(root, recPath)} — an Agreement handoff requires a recorded acceptance (with fingerprint).`);
  }
  let rec;
  try {
    rec = JSON.parse(fs.readFileSync(recPath, 'utf8'));
  } catch (e) {
    throw new LifecycleError(`Cannot read acceptance record: ${e.message}`);
  }
  const fp = proposalFingerprint(data);
  if (fp !== rec.content_sha256) {
    throw new LifecycleError('FINGERPRINT MISMATCH — accepted content was modified. Refusing to create an Agreement handoff from a tampered accepted Proposal.');
  }
  const handoff = buildHandoff(data, rec);
  const out = opts.output ? path.resolve(opts.output) : handoffPath(data.proposal_id, data.version);
  writeJson(out, handoff, { overwrite: Boolean(opts.overwrite) });
  console.log(`Agreement handoff created: ${path.relative(root, out)}`);
  console.log(`  ${HANDOFF_SCHEMA} · ${data.proposal_id} v${data.version} · fingerprint ${fp.slice(0, 16)}…`);
}

/* ------------------------------------------------------------------ */
/* CLI                                                                */
/* ------------------------------------------------------------------ */
const COMMANDS = ['issue', 'accept', 'decline', 'expire', 'supersede', 'verify', 'handoff'];

function usage(out) {
  out.write(`Nexora Proposal Lifecycle (PROP.4) — v${LIFECYCLE_VERSION}
Governed lifecycle + auditability around a Proposal. Governance + lifecycle only:
NOT e-signature, NOT the Agreement generator, NOT invoicing, NOT payment processing.

Status model (canonical): DRAFT, INTERNAL_APPROVED, SENT, CLIENT_ACCEPTED,
DECLINED, EXPIRED, SUPERSEDED. Forward-only, fail-closed transitions:
  DRAFT              -> INTERNAL_APPROVED | SENT
  INTERNAL_APPROVED  -> SENT
  SENT               -> CLIENT_ACCEPTED | DECLINED | EXPIRED | SUPERSEDED
  (terminal: CLIENT_ACCEPTED, DECLINED, EXPIRED, SUPERSEDED — no outgoing transitions)

An ACCEPTED Proposal is IMMUTABLE: a SHA-256 fingerprint of the accepted content
is recorded, and verify() refuses any modified accepted Proposal.

Usage:
  node ops/proposals/proposal-lifecycle.mjs issue     <proposal.json>
  node ops/proposals/proposal-lifecycle.mjs accept    <proposal.json> --by "<name>" [--method <m>] [--date YYYY-MM-DD] [--record <path>] [--overwrite]
  node ops/proposals/proposal-lifecycle.mjs decline   <proposal.json>
  node ops/proposals/proposal-lifecycle.mjs expire    <proposal.json> [--as-of YYYY-MM-DD]
  node ops/proposals/proposal-lifecycle.mjs supersede <proposal.json> --by <proposal_id> --version <x.y> [--reason "<r>"]
  node ops/proposals/proposal-lifecycle.mjs verify    <proposal.json> [--record <path>]
  node ops/proposals/proposal-lifecycle.mjs handoff   <proposal.json> [--record <path>] [--output <path>] [--overwrite]
  node ops/proposals/proposal-lifecycle.mjs --help

Options:
  --by <name>       Person accepting on behalf of the client (accept)
  --method <m>      Provider-neutral acceptance method (default: proposal acceptance.method, else 'written')
  --date <ISO>      Operational acceptance date + expiry evaluation (accept, default: today)
  --as-of <ISO>     Deterministic expiry evaluation date (expire, default: today)
  --version <x.y>   Version of the NEW Proposal (supersede — must be higher than the current version)
  --reason <r>      Supersession reason (supersede)
  --record <path>   Acceptance record: accept writes, verify/handoff read
  --output <path>   Agreement handoff output path (handoff)
  --overwrite       Allow replacing an existing acceptance record / handoff (never by default)

Input safety:
  Real proposals   -> ops/proposals/private/  (gitignored; no marker required)
  Synthetic tests  -> ops/proposals/examples/ (must be marked "_example": true)
  Any other path   -> refused

Validity: valid_until = issue_date + 30 days (frozen). A Proposal is expired when
the acceptance date > valid_until. Acceptance of an expired Proposal is refused.
Proposal validity (30 days) is NOT the invoice due date (7 calendar days).

Records (gitignored, private):
  Acceptance record -> ops/proposals/private/acceptance/{id}-v{version}.acceptance.json
  Agreement handoff -> ops/proposals/private/handoffs/{id}-v{version}.handoff.json`);
}

function main() {
  const args = process.argv.slice(2);
  const command = args[0];
  if (!command) { usage(process.stderr); return 2; }
  if (command === '--help' || command === '-h') { usage(process.stdout); return 0; }
  if (command.startsWith('-') || !COMMANDS.includes(command)) { usage(process.stderr); return 2; }

  const rest = args.slice(1);
  const opts = {};
  const positional = [];
  for (let i = 0; i < rest.length; i++) {
    const a = rest[i];
    if (a === '--by') opts.by = rest[++i];
    else if (a === '--method') opts.method = rest[++i];
    else if (a === '--date') opts.date = rest[++i];
    else if (a === '--as-of') opts.asOf = rest[++i];
    else if (a === '--version') opts.version = rest[++i];
    else if (a === '--reason') opts.reason = rest[++i];
    else if (a === '--record') opts.record = rest[++i];
    else if (a === '--output') opts.output = rest[++i];
    else if (a === '--overwrite') opts.overwrite = true;
    else if (a.startsWith('-')) { usage(process.stderr); return 2; }
    else positional.push(a);
  }
  if (positional.length !== 1) { usage(process.stderr); return 2; }
  const target = path.resolve(positional[0]);

  try {
    switch (command) {
      case 'issue': cmdIssue(target); break;
      case 'accept': cmdAccept(target, opts); break;
      case 'decline': cmdDecline(target); break;
      case 'expire': cmdExpire(target, opts); break;
      case 'supersede': cmdSupersede(target, opts); break;
      case 'verify': return cmdVerify(target, opts);
      case 'handoff': cmdHandoff(target, opts); break;
    }
    return 0;
  } catch (e) {
    if (e instanceof LifecycleError) {
      process.stderr.write(`PROP.4 · ${e.message}\n`);
      return 1;
    }
    throw e;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exit(main());
}
