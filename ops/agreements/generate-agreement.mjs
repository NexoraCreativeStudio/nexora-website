#!/usr/bin/env node
/* Nexora Agreement Generator (PROP.5).
   Consumes a governed PROP.4 Agreement Handoff (only from a CLIENT_ACCEPTED,
   fingerprint-verified Proposal) and produces a governed Agreement.

   Flow:
     Agreement Handoff (PROP.4, READY_FOR_AGREEMENT)
       -> fail-closed handoff verification (schema, status, commercial snapshot
          vs ops/billing-source-of-truth.json)
       -> provenance re-verification: the accepted Proposal is re-fingerprinted
          (nexora-proposal-canonical/v1 SHA-256) and compared to the fingerprint in
          the handoff and the acceptance record. Tampering FAILS CLOSED.
       -> Agreement data model built (AGR-YYYY-NNNN; DRAFT | READY_FOR_EXECUTION)
       -> READY_FOR_EXECUTION gate: every mandatory legal/commercial decision must
          be resolved through the approved legal-decisions register. No --force.
       -> Agreement document (HTML, print-ready) | governed JSON (--json)
       -> ops/agreements/out/ (gitignored) | --output

   This is generation ONLY. It does NOT implement Agreement execution, e-signature,
   invoice generation, payment collection, or Phase 5. Agreement generation !=
   Agreement execution. READY_FOR_EXECUTION != SIGNED.

   Usage:  node ops/agreements/generate-agreement.mjs <handoff.json> [options]
           node ops/agreements/generate-agreement.mjs --example [options]
   Options:
     --proposal <p>           accepted Proposal file (provenance re-verification)
     --acceptance-record <r>  acceptance record (provenance re-verification)
     --legal-decisions <p>    legal-decisions register (default: committed register)
     --status <DRAFT|READY_FOR_EXECUTION>   default DRAFT
     --agreement-id <id>      AGR-YYYY-NNNN (default: derived from the Proposal lineage)
     --json                   write the governed Agreement JSON (default: HTML document)
     --output <path>          write to <path> (default: out/{agreement_id}-v{version}.html)
     --generated-at <ISO>     deterministic timestamp override (tests)
     --check                  validate only (no render); exit 0 if generation-safe
     --overwrite              allow replacing an existing output for the same id + version
     --help                   show usage

   Input safety (PROP.5):
     Real Agreements      -> ops/agreements/private/     (gitignored, no marker required)
     Synthetic tests      -> ops/agreements/examples/    (must be marked "_example": true)
     Upstream governed    -> ops/proposals/private/ and ops/proposals/examples/ (handoff,
                             accepted Proposal, acceptance record — no marker required)
     Any other path       -> REFUSED (unsafe tracked/arbitrary data)

   PDF path: the HTML is fully print-ready — use browser Print -> Save as PDF.
   No external PDF engine or SaaS is required. */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import {
  AGREEMENT_VERSION,
  AGREEMENT_SCHEMA,
  AGREEMENT_ID_RE,
  AGREEMENT_STATUSES,
  LEGAL_DECISIONS_PATH,
  classifyInput,
  legalSectionsFor,
  isReadyForExecution,
  validateAgreementHandoff,
  validateAgreement,
  loadLegalDecisions
} from './agreement-validation.mjs';
import { proposalFingerprint, todayISO } from '../proposals/proposal-lifecycle.mjs';
import { renderTemplate, fmtMoney } from '../proposals/preview-proposal.mjs';
import { computeScheduleRows } from '../proposals/generate-proposal.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const agreementsDir = __dirname;
const root = path.join(__dirname, '..', '..');

const TEMPLATE_PATH = path.join(agreementsDir, 'template', 'agreement-template.html');
const CSS_PATH = path.join(agreementsDir, 'template', 'agreement.css');
const OUT_DIR = path.join(agreementsDir, 'out');
const EXAMPLES_DIR = path.join(agreementsDir, 'examples');
const PRIVATE_DIR = path.join(agreementsDir, 'private');
const PROPOSALS_DIR = path.join(root, 'ops', 'proposals');
const COMMITTED_B2_HANDOFF = path.join(PROPOSALS_DIR, 'examples', 'lifecycle', 'proposal-accepted.handoff.json');

export class AgreementError extends Error {}

/* ------------------------------------------------------------------ */
/* Provenance file discovery.                                          */
/* ------------------------------------------------------------------ */
function siblingFor(file, from, to) {
  const base = path.basename(file).replace(from, to);
  return path.join(path.dirname(file), base);
}

export function resolveProvenanceFiles(handoffPath, kind, opts) {
  const id = opts.proposalId;
  const ver = opts.proposalVersion;

  let proposal = opts.proposal;
  let record = opts.acceptanceRecord;

  if (!proposal && (kind === 'EXAMPLES' || kind === 'PROPOSAL_EXAMPLES')) {
    proposal = siblingFor(handoffPath, '.handoff.json', '.json');
  } else if (!proposal && kind === 'PRIVATE') {
    const cand = path.join(PROPOSALS_DIR, 'private', `${id}-v${ver}.json`);
    if (fs.existsSync(cand)) proposal = cand;
  }
  if (!record && (kind === 'EXAMPLES' || kind === 'PROPOSAL_EXAMPLES')) {
    record = siblingFor(handoffPath, '.handoff.json', '.acceptance.json');
  } else if (!record && kind === 'PRIVATE') {
    const cand = path.join(PROPOSALS_DIR, 'private', 'acceptance', `${id}-v${ver}.acceptance.json`);
    if (fs.existsSync(cand)) record = cand;
  }
  return { proposal, record };
}

/* ------------------------------------------------------------------ */
/* Agreement data build + view model + document render.                */
/* ------------------------------------------------------------------ */
const statusLabel = (s) =>
  s ? String(s).toLowerCase().replace(/_/g, ' ').replace(/^\w/, (c) => c.toUpperCase()) : '';

export function buildAgreement({ handoff, proposal, record, decisions, status, createdAt, agreementId }) {
  const project = proposal.project || {};
  const scope = proposal.scope || {};
  const timeline = proposal.timeline || {};
  const legal = legalSectionsFor(decisions);
  return {
    schema: AGREEMENT_SCHEMA,
    agreement_id: agreementId,
    version: '1.0',
    status,
    created_at: createdAt,
    proposal: { proposal_id: proposal.proposal_id, version: proposal.version },
    provenance: {
      proposal_fingerprint: handoff.acceptance.content_sha256,
      acceptance_record: record.schema,
      agreement_handoff: handoff.schema,
      handoff_fingerprint: proposalFingerprint(handoff)
    },
    client: proposal.client,
    project: {
      title: project.title,
      summary: project.summary,
      objectives: Array.isArray(project.objectives) ? project.objectives : []
    },
    offering: proposal.offering,
    scope: {
      included: Array.isArray(scope.included) ? scope.included : [],
      deliverables: Array.isArray(scope.deliverables) ? scope.deliverables : [],
      exclusions: Array.isArray(scope.exclusions) ? scope.exclusions : []
    },
    timeline: { estimated_delivery: timeline.estimated_delivery, notes: timeline.notes },
    commercial_schedule: proposal.commercial_schedule,
    client_responsibilities: Array.isArray(proposal.client_responsibilities) ? proposal.client_responsibilities : [],
    assumptions: Array.isArray(proposal.assumptions) ? proposal.assumptions : [],
    dependencies: [],
    legal_sections: legal,
    document_control: { agreement_id: agreementId, version: '1.0', status, created_at: createdAt, supersedes: null },
    execution: { client_signature: null, nexora_signature: null, execution_date: null }
  };
}

export function buildAgreementViewModel(a) {
  const cs = a.commercial_schedule || {};
  const approved = cs.approved_final_project_price;
  const recurring = cs.recurring_fees || null;
  const care = cs.care || null;
  const warranty = cs.warranty || null;
  const client = a.client || {};
  const contact = client.contact || {};
  const project = a.project || {};
  const offering = a.offering || {};
  const scope = a.scope || {};
  const timeline = a.timeline || {};
  const pv = a.provenance || {};
  const draft = a.status !== 'READY_FOR_EXECUTION';
  const legalSections = (a.legal_sections || []).map((s) => ({ ...s, unresolved: s.status === 'UNRESOLVED' }));

  return {
    agreement_id: a.agreement_id,
    version: a.version,
    status_label: statusLabel(a.status),
    status_banner: draft ? 'DRAFT — NOT FOR EXECUTION' : 'READY FOR EXECUTION — NOT YET SIGNED',
    status_banner_class: draft ? 'draft' : 'ready',
    draft,
    created_at: a.created_at,
    proposal_id: (a.proposal && a.proposal.proposal_id) || '',
    proposal_version: (a.proposal && a.proposal.version) || '',
    proposal_fingerprint_short: String(pv.proposal_fingerprint || '').slice(0, 16) + '…',
    proposal_fingerprint: pv.proposal_fingerprint || '',
    acceptance_record: pv.acceptance_record || '',
    agreement_handoff: pv.agreement_handoff || '',
    client_name: client.name,
    client_company: client.company,
    client_contact_name: contact.name,
    client_email: contact.email,
    client_phone: contact.phone,
    project_title: project.title,
    project_summary: project.summary,
    project_objectives: Array.isArray(project.objectives) && project.objectives.length ? project.objectives : null,
    offering_code: offering.code,
    offering_category: offering.category,
    offering_name: offering.name,
    scope_included: Array.isArray(scope.included) && scope.included.length ? scope.included : null,
    scope_deliverables: Array.isArray(scope.deliverables) && scope.deliverables.length ? scope.deliverables : null,
    scope_exclusions: Array.isArray(scope.exclusions) && scope.exclusions.length ? scope.exclusions : null,
    timeline_estimated_delivery: timeline.estimated_delivery,
    timeline_notes: timeline.notes,
    currency: cs.currency,
    approved_price_display: fmtMoney(approved),
    reference_price_display: fmtMoney(cs.reference_price),
    setup_fee_display: fmtMoney(cs.setup_fee),
    payment_schedule_rows: Array.isArray(cs.payment_schedule) ? computeScheduleRows(approved, cs.payment_schedule) : null,
    recurring_monthly_display: recurring && fmtMoney(recurring.monthly_fee),
    recurring_start_display: recurring ? (recurring.starts_at === 'GO_LIVE' ? 'from Go-Live' : 'monthly in advance') : null,
    recurring_note: recurring
      ? (recurring.starts_at === 'GO_LIVE'
          ? 'Recurring billing begins at Go-Live — never before, never at acceptance, execution, or project start.'
          : 'Paid monthly in advance.')
      : null,
    ai_recurring: Boolean(recurring && recurring.starts_at === 'GO_LIVE'),
    care_plan_display: care && (care.plan || care.code),
    care_monthly_display: care && fmtMoney(care.monthly_fee),
    care_note: care && 'Paid monthly in advance; separately identifiable from the project price.',
    warranty_label: warranty && warranty.label,
    responsibilities: Array.isArray(a.client_responsibilities) && a.client_responsibilities.length ? a.client_responsibilities : null,
    assumptions: Array.isArray(a.assumptions) && a.assumptions.length ? a.assumptions : null,
    dependencies: Array.isArray(a.dependencies) && a.dependencies.length ? a.dependencies : null,
    legal_sections: legalSections,
    execution_intro: draft
      ? 'This is a DRAFT Agreement. It is NOT FOR EXECUTION and no signature is requested.'
      : 'This Agreement is ready for execution through the governed execution process. Signature and execution remain a separate external gate.'
  };
}

export function renderAgreementDocument(agreement, opts = {}) {
  const sourceLabel = opts.sourceLabel || 'agreement';
  const tpl = fs.readFileSync(TEMPLATE_PATH, 'utf8');
  const css = fs.readFileSync(CSS_PATH, 'utf8');
  const vm = buildAgreementViewModel(agreement);
  let html = renderTemplate(tpl, vm);
  html = html.replace('<link rel="stylesheet" href="agreement.css">', '<style>\n' + css + '\n</style>');

  const audit = [
    '<!--',
    `  Nexora Agreement Generator v${AGREEMENT_VERSION} · schema ${AGREEMENT_SCHEMA}`,
    `  source: ${path.basename(sourceLabel)} · agreement_id: ${agreement.agreement_id} · version: ${agreement.version}`,
    `  generated: ${opts.generatedStamp || new Date().toISOString()}`,
    '  Agreement generation ≠ Agreement execution. This document is not a contract.',
    '-->'
  ].join('\n');
  html = html.replace('<!DOCTYPE html>', '<!DOCTYPE html>\n' + audit);
  return html;
}

function assertSafeOutput(outPath) {
  const resolved = path.resolve(outPath);
  const rel = path.relative(root, resolved);
  if (rel.startsWith('..') || path.isAbsolute(rel)) {
    throw new AgreementError(`Unsafe output path: ${outPath} — output must stay within the repository root.`);
  }
}

function cleanSegment(s) {
  const clean = String(s)
    .replace(/[^A-Za-z0-9._-]/g, '-')
    .replace(/-+/g, '-')
    .replace(/^[-.]+|[-.]+$/g, '');
  return clean || 'agreement';
}

export function defaultOutputPath(agreementId, version, jsonMode) {
  return path.join(OUT_DIR, `${cleanSegment(agreementId)}-v${cleanSegment(version)}.${jsonMode ? 'agreement.json' : 'html'}`);
}

/* ------------------------------------------------------------------ */
/* CLI                                                                */
/* ------------------------------------------------------------------ */
function usage(out) {
  out.write(`Nexora Agreement Generator (PROP.5) — v${AGREEMENT_VERSION}
Governed Agreement layer. Consumes a PROP.4 Agreement Handoff (only from a
CLIENT_ACCEPTED, fingerprint-verified Proposal). Agreement generation !=
Agreement execution. READY_FOR_EXECUTION != SIGNED.

Usage:
  node ops/agreements/generate-agreement.mjs <handoff.json> [options]
  node ops/agreements/generate-agreement.mjs --example [options]

Options:
  --example             Generate from the committed synthetic B2 handoff pair
  --proposal <p>        Accepted Proposal file (provenance re-verification)
  --acceptance-record <r>  Acceptance record (provenance re-verification)
  --legal-decisions <p> Legal-decisions register (default: committed register)
  --status <DRAFT|READY_FOR_EXECUTION>  Default DRAFT (no --force shortcut)
  --agreement-id <id>   AGR-YYYY-NNNN (default: derived from the Proposal lineage)
  --json                Write the governed Agreement JSON (default: HTML document)
  --output <path>       Write to <path> (default: out/{agreement_id}-v{version}.html)
  --generated-at <ISO>  Deterministic timestamp override (tests)
  --check               Validate only (no render); exit 0 if generation-safe
  --overwrite           Allow replacing an existing output for the same id + version
  --help                Show this help

Input safety:
  Real Agreements    -> ops/agreements/private/   (gitignored; no marker required)
  Synthetic tests    -> ops/agreements/examples/  (must be marked "_example": true)
  Upstream governed  -> ops/proposals/private/ and ops/proposals/examples/ (handoff,
                        accepted Proposal, acceptance record)
  Any other path     -> refused (unsafe tracked/arbitrary data)

Provenance verification (fails closed):
  The accepted Proposal is re-fingerprinted (nexora-proposal-canonical/v1 SHA-256)
  and compared against the fingerprint in the handoff and the acceptance record.
  A modified accepted Proposal / fabricated handoff / changed commercial value is
  refused.

READY_FOR_EXECUTION gate:
  Requires every mandatory legal/commercial decision to be resolved through an
  approved source (legal-decisions.json). No --force-ready shortcut.

PDF path: HTML -> browser Print -> Save as PDF (no external engine required).`);
}

function main() {
  const args = process.argv.slice(2);
  const opts = {};
  const positional = [];
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === '--proposal') opts.proposal = args[++i];
    else if (a === '--acceptance-record') opts.acceptanceRecord = args[++i];
    else if (a === '--legal-decisions') opts.legalDecisions = args[++i];
    else if (a === '--status') opts.status = args[++i];
    else if (a === '--agreement-id') opts.agreementId = args[++i];
    else if (a === '--json') opts.json = true;
    else if (a === '--output') opts.output = args[++i];
    else if (a === '--generated-at') opts.generatedAt = args[++i];
    else if (a === '--check') opts.check = true;
    else if (a === '--overwrite') opts.overwrite = true;
    else if (a === '--example') opts.example = true;
    else if (a === '--help' || a === '-h') opts.help = true;
    else if (a.startsWith('-')) { usage(process.stderr); return 2; }
    else positional.push(a);
  }
  if (opts.help) { usage(process.stdout); return 0; }
  if (!positional[0] && !opts.example) { usage(process.stderr); return 2; }
  if (positional[0] && opts.example) { process.stderr.write('Give either a handoff path or --example, not both.\n'); return 2; }
  if (opts.status && !AGREEMENT_STATUSES.includes(opts.status)) {
    process.stderr.write(`Invalid --status "${opts.status}" — must be one of ${AGREEMENT_STATUSES.join(', ')} (SIGNED/EXECUTED is an external gate, not modelled).\n`);
    return 2;
  }
  if (opts.agreementId && !AGREEMENT_ID_RE.test(opts.agreementId)) {
    process.stderr.write(`Invalid --agreement-id "${opts.agreementId}" — AGR-YYYY-NNNN format required.\n`);
    return 2;
  }

  const handoffPath = opts.example ? COMMITTED_B2_HANDOFF : path.resolve(positional[0]);
  const kind = classifyInput(handoffPath);
  if (kind === 'UNSAFE') {
    process.stderr.write(`Refusing unsafe input: ${handoffPath}\n` +
      'Agreement handoffs must come from ops/proposals/private/ (real), ops/proposals/examples/ ' +
      '(synthetic) or ops/agreements/private/ (real agreements).\n');
    return 1;
  }

  let handoff;
  try {
    handoff = JSON.parse(fs.readFileSync(handoffPath, 'utf8'));
  } catch (e) {
    process.stderr.write(`Cannot read handoff: ${e.message}\n`);
    return 1;
  }

  /* Fail-closed upstream gate: handoff structure + commercial snapshot vs Source of Truth. */
  const h = validateAgreementHandoff(handoff, { label: path.basename(handoffPath) });
  if (h.failures.length > 0) {
    process.stderr.write(`HANDOFF VALIDATION FAILED — ${h.failures.length} issue(s). No Agreement generated.\n`);
    for (const f of h.failures) process.stderr.write(`  FAIL ${f}\n`);
    return 1;
  }

  /* Provenance re-verification: locate + verify the accepted Proposal and record. */
  const pid = handoff.proposal.proposal_id;
  const pver = handoff.proposal.version;
  const { proposal: proposalPath, record: recordPath } = resolveProvenanceFiles(handoffPath, kind, { proposalId: pid, proposalVersion: pver, ...opts });

  if (!proposalPath || !fs.existsSync(proposalPath)) {
    process.stderr.write('PROVENANCE FAILED — accepted Proposal file not found.\n' +
      `  handoff: ${path.relative(root, handoffPath)}\n` +
      '  Supply --proposal <accepted proposal.json> so the fingerprint can be re-verified.\n');
    return 1;
  }
  if (classifyInput(proposalPath) === 'UNSAFE') {
    process.stderr.write(`Refusing unsafe --proposal path: ${proposalPath}\n`);
    return 1;
  }
  if (!recordPath || !fs.existsSync(recordPath)) {
    process.stderr.write('PROVENANCE FAILED — acceptance record not found.\n' +
      `  handoff: ${path.relative(root, handoffPath)}\n` +
      '  Supply --acceptance-record <record.json> so the recorded fingerprint can be verified.\n');
    return 1;
  }
  if (classifyInput(recordPath) === 'UNSAFE') {
    process.stderr.write(`Refusing unsafe --acceptance-record path: ${recordPath}\n`);
    return 1;
  }

  let proposal;
  let record;
  try {
    proposal = JSON.parse(fs.readFileSync(proposalPath, 'utf8'));
    record = JSON.parse(fs.readFileSync(recordPath, 'utf8'));
  } catch (e) {
    process.stderr.write(`Cannot read provenance files: ${e.message}\n`);
    return 1;
  }

  /* Proposal fingerprint must match the handoff AND the acceptance record. */
  const fp = proposalFingerprint(proposal);
  if (proposal.status !== 'CLIENT_ACCEPTED') {
    process.stderr.write(`PROVENANCE FAILED — proposal is ${proposal.status}, not CLIENT_ACCEPTED. An Agreement may only derive from an accepted Proposal.\n`);
    return 1;
  }
  if (fp !== handoff.acceptance.content_sha256) {
    process.stderr.write(`FINGERPRINT MISMATCH — the accepted Proposal does not match the handoff's recorded fingerprint.\n` +
      `  recorded: ${handoff.acceptance.content_sha256}\n  current:  ${fp}\n` +
      'The accepted Proposal or handoff was modified. Refusing to generate.\n');
    return 1;
  }
  if (record.schema !== 'nexora-proposal-acceptance/v1' ||
      record.proposal_id !== pid || record.version !== pver ||
      record.content_sha256 !== fp) {
    process.stderr.write('ACCEPTANCE RECORD MISMATCH — record does not match the accepted Proposal fingerprint.\n');
    return 1;
  }

  /* Handoff commercial snapshot must match the accepted Proposal commercial schedule. */
  const snap = handoff.commercial_snapshot || {};
  const cs = proposal.commercial_schedule || {};
  const same = (a, b) => (a == null && b == null) || (a != null && b != null && JSON.stringify(a) === JSON.stringify(b));
  const snapKeys = ['currency', 'reference_price', 'approved_final_project_price', 'setup_fee', 'payment_schedule', 'recurring_fees', 'care', 'warranty', 'vat'];
  const drift = snapKeys.filter((k) => !same(snap[k], cs[k]));
  if (drift.length > 0) {
    process.stderr.write(`COMMERCIAL DRIFT — handoff snapshot differs from accepted Proposal: ${drift.join(', ')}. Refusing to generate.\n`);
    return 1;
  }

  /* Build + validate the Agreement. */
  const generatedStamp = opts.generatedAt || new Date().toISOString();
  const createdAt = /^\d{4}-\d{2}-\d{2}/.test(generatedStamp) ? generatedStamp.slice(0, 10) : todayISO();
  const status = opts.status || 'DRAFT';
  const agreementId = opts.agreementId || ('AGR-' + pid.slice(4));

  let decisions;
  try {
    decisions = loadLegalDecisions(opts.legalDecisions);
  } catch (e) {
    process.stderr.write(`${e.message}\n`);
    return 1;
  }
  const agreement = buildAgreement({ handoff, proposal, record, decisions, status, createdAt, agreementId });

  const v = validateAgreement(agreement, { label: 'generated', requireExampleMarker: false, legalDecisionsPath: opts.legalDecisions });
  if (v.failures.length > 0) {
    process.stderr.write(`AGREEMENT VALIDATION FAILED — ${v.failures.length} issue(s). No Agreement generated.\n`);
    for (const f of v.failures) process.stderr.write(`  FAIL ${f}\n`);
    return 1;
  }

  if (status === 'READY_FOR_EXECUTION') {
    const gate = isReadyForExecution(agreement, decisions);
    if (!gate.ready) {
      process.stderr.write(`READY_FOR_EXECUTION REFUSED — unresolved decisions remain:\n  ${gate.reasons.join('\n  ')}\n` +
        'Resolve every mandatory legal/commercial decision through the approved register first. There is no force-ready shortcut.\n');
      return 1;
    }
  }

  if (opts.check) {
    process.stdout.write(`VALID: ${path.basename(handoffPath)} -> ${agreementId} v${agreement.version} (${status})\n`);
    return 0;
  }

  /* Safe, protected output. */
  const outPath = opts.output
    ? path.resolve(opts.output)
    : defaultOutputPath(agreementId, agreement.version, opts.json);
  try {
    assertSafeOutput(outPath);
  } catch (e) {
    process.stderr.write(`${e.message}\n`);
    return 1;
  }
  if (fs.existsSync(outPath) && !opts.overwrite) {
    process.stderr.write(`Refusing to overwrite existing output: ${path.relative(root, outPath)}\n` +
      'An output already exists for this agreement_id + version. Use --overwrite to replace.\n' +
      '(Agreements are governed documents; generation never silently destroys history.)\n');
    return 1;
  }

  fs.mkdirSync(path.dirname(outPath), { recursive: true });
  if (opts.json) {
    fs.writeFileSync(outPath, JSON.stringify(agreement, null, 2) + '\n');
    process.stdout.write(`Agreement JSON written: ${path.relative(root, outPath)}\n`);
  } else {
    const html = renderAgreementDocument(agreement, { sourceLabel: handoffPath, generatedStamp });
    fs.writeFileSync(outPath, html);
    const leftover = (html.match(/\{\{[\s\S]*?\}\}/g) || []);
    process.stdout.write(`Agreement generated: ${path.relative(root, outPath)}\n`);
    process.stdout.write(leftover.length ? `LEFTOVER TOKENS: ${leftover.join(', ')}\n` : 'No leftover tokens.\n');
  }
  return 0;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exit(main());
}
