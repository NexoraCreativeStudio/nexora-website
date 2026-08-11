#!/usr/bin/env node
/* Nexora Agreement Execution System (PROP.7) — local CLI.
   Governed execution layer for a READY_FOR_EXECUTION Agreement (PROP.5).

   Flow:
     READY_FOR_EXECUTION Agreement
       -> prepare   : build a governed execution record + execution package
                       (PREPARED — generated locally only)
       -> record-event : evidence-driven transitions
                       (EXECUTION_REQUESTED -> SENT_FOR_SIGNATURE,
                        SIGNER_COMPLETED    -> PARTIALLY_SIGNED, …)
       -> finalize  : EXECUTED ONLY through the full evidence gate
       -> verify / status : integrity + state inspection

   Evidence-driven ONLY. There is NO --force-executed and NO --mark-signed
   shortcut. PREPARED -> EXECUTED directly is impossible. Agreement status
   stays READY_FOR_EXECUTION; execution status is a separate governed concept.
   READY_FOR_EXECUTION is NOT SIGNED. EXECUTED is NOT PAID.

   This is NOT an e-signature implementation and makes NO network calls.
   Real provider / manual dispatch evidence is required to progress an
   execution. The real e-signature provider remains an OWNER DECISION; the
   provider-neutral layer is fully operational regardless.

   Usage:
     node ops/execution/execution.mjs prepare <agreement.json> [options]
     node ops/execution/execution.mjs verify <execution-record.json>
     node ops/execution/execution.mjs status <execution-record.json>
     node ops/execution/execution.mjs record-event <record.json> --event <event.json> [options]
     node ops/execution/execution.mjs finalize <record.json> [options]

   prepare options:
     --execution-id <id>    EXE-YYYY-NNNN (default: derived from Agreement lineage)
     --signers <json>       signer array file (default: derived from the Agreement)
     --legal-decisions <p>  legal-decisions register used to build the Agreement
                            (default: committed register)
     --method <MANUAL|E_SIGNATURE_PROVIDER>   default MANUAL
     --provider <MANUAL|TEST_ADAPTER|NONE>    default depends on method
     --output <dir>         write into <dir> (default ops/execution/out)
     --generated-at <ISO>   deterministic timestamp override (tests)
     --check                validate only (no write)
     --example              build a synthetic READY Agreement + prepare (test-only)
     --overwrite            allow replacing a non-executed record for same id+version
     --help                 show usage

   record-event options:
     --event <json>         evidence event file (MANUAL_RECORD or provider event)
     --out <path>           explicit output path for the next record
     --overwrite            allow replacing a non-executed target record
     --generated-at <ISO>   deterministic timestamp override (tests)

   finalize options:
     --agreement <path>     the READY Agreement (re-verifies checksum + linkage)
     --output <dir>         write into <dir> (default ops/execution/out)
     --generated-at <ISO>   deterministic timestamp override (tests)

   Input safety:
     Execution records  -> ops/execution/out|private|examples (else REFUSED)
     Agreements         -> ops/agreements/private|examples and
                           ops/proposals/private|examples (else REFUSED)
     Committed examples must be marked "_example": true. */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { execFileSync } from 'node:child_process';
import {
  EXECUTION_VERSION,
  EXECUTION_SCHEMA,
  EXECUTION_PACKAGE_SCHEMA,
  EXECUTION_ID_RE,
  PROVIDERS,
  EXECUTION_METHODS,
  EVENT_TYPES,
  PROVIDER_DECISION,
  OUT_DIR,
  classifyExecutionInput,
  defaultSignersFor,
  validateSigners,
  validateReadyAgreement,
  validateExecutionRecord,
  executionFilename,
  executionPackageFilename,
  executedBundleFilename,
  assertSafeExecutionOutput,
  defaultExecutionId,
  buildExecutionFingerprint,
  executionGate,
  buildExecutedBundle,
  signerCompletionState,
  agreementChecksum,
  sha256hex,
  applyEvent
} from './execution-validation.mjs';
import { classifyInput as classifyAgreementInput } from '../agreements/agreement-validation.mjs';
import {
  buildDispatchEvent,
  validateProviderEvent,
  normalizeExecutionEvidence,
  verifyEvidenceViaAdapter,
  buildProviderPayload
} from './execution-providers.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const executionDir = __dirname;
const root = path.join(__dirname, '..', '..');
const agreementsDir = path.join(root, 'ops', 'agreements');
const proposalsDir = path.join(root, 'ops', 'proposals');
const AGREEMENT_GEN = path.join(agreementsDir, 'generate-agreement.mjs');
const B2_HANDOFF = path.join(proposalsDir, 'examples', 'lifecycle', 'proposal-accepted.handoff.json');
const B2_PROP = path.join(proposalsDir, 'examples', 'lifecycle', 'proposal-accepted.json');
const B2_REC = path.join(proposalsDir, 'examples', 'lifecycle', 'proposal-accepted.acceptance.json');
const EXEC_TMP = path.join(executionDir, 'private', '.tmp-tests', 'example');
const AGR_TMP = path.join(agreementsDir, 'private', '.tmp-tests', 'execution-example');

export class ExecutionError extends Error {}

/* ------------------------------------------------------------------ */
/* Helpers                                                             */
/* ------------------------------------------------------------------ */
function readJson(p) {
  return JSON.parse(fs.readFileSync(p, 'utf8'));
}
function writeJson(p, obj) {
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, JSON.stringify(obj, null, 2) + '\n');
}

function isIso(t) {
  return typeof t === 'string' && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/.test(t);
}

function nextStamp(opts) {
  if (opts.generatedAt && isIso(opts.generatedAt)) return opts.generatedAt;
  if (opts.generatedAt) throw new ExecutionError(`Invalid --generated-at "${opts.generatedAt}" — ISO-8601 required`);
  return new Date().toISOString();
}

function refuseOverwrite(target, opts) {
  if (fs.existsSync(target) && !opts.overwrite) {
    throw new ExecutionError(`Refusing to overwrite existing output: ${path.relative(root, target)}\n` +
      'An execution record already exists for this id + version. Use --overwrite to replace a NON-executed record.\n' +
      'Executed records are immutable and are never overwritten.');
  }
}

function printRecordStatus(record) {
  const sc = signerCompletionState(record);
  const line = `status: ${record.status} · signers completed ${sc.completedCount}/${sc.requiredCount} required (${sc.completed.slice().sort().join(', ') || 'none'})`;
  return line;
}

/* ------------------------------------------------------------------ */
/* prepare                                                             */
/* ------------------------------------------------------------------ */
function buildExampleReadyAgreement(opts) {
  /* Synthetic READY_FOR_EXECUTION Agreement from the committed B2 pair + a
     SYNTHETIC resolved legal register (mechanism proof only — never a real
     owner/legal decision, never committed). */
  fs.mkdirSync(AGR_TMP, { recursive: true });
  const resolvedPath = path.join(AGR_TMP, 'synthetic-resolved-legal-decisions.json');
  const baseReg = readJson(path.join(agreementsDir, 'legal', 'legal-decisions.json'));
  const resolved = { ...baseReg, description: 'SYNTHETIC TEST REGISTER — proves the READY_FOR_EXECUTION gate mechanism; NOT a real owner/legal decision.' };
  resolved.clauses = {};
  for (const id of Object.keys(baseReg.clauses)) {
    resolved.clauses[id] = { classification: 'AUTHORITATIVE', note: 'SYNTHETIC TEST RESOLUTION — mechanism proof only.' };
  }
  writeJson(resolvedPath, resolved);

  const stamp = opts.generatedAt || new Date().toISOString();
  const agreementOut = path.join(AGR_TMP, 'AGR-2026-9104-v1.0.json');
  const args = [
    AGREEMENT_GEN, B2_HANDOFF,
    '--proposal', B2_PROP,
    '--acceptance-record', B2_REC,
    '--legal-decisions', resolvedPath,
    '--status', 'READY_FOR_EXECUTION',
    '--agreement-id', 'AGR-2026-9104',
    '--json',
    '--output', agreementOut,
    '--generated-at', stamp,
    '--overwrite'
  ];
  try {
    execFileSync(process.execPath, args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  } catch (e) {
    throw new ExecutionError(`Cannot build synthetic READY Agreement: ${(e.stderr || e.message).trim()}`);
  }
  return { agreementPath: agreementOut, resolvedPath };
}

function runPrepare(opts) {
  const method = opts.method || 'MANUAL';
  if (!EXECUTION_METHODS.includes(method)) {
    process.stderr.write(`Invalid --method "${method}" — must be one of ${EXECUTION_METHODS.join(', ')}.\n`);
    return 1;
  }
  let provider = opts.provider;
  if (!provider) provider = method === 'MANUAL' ? 'MANUAL' : 'NONE';
  if (!PROVIDERS.includes(provider)) {
    process.stderr.write(`Invalid --provider "${provider}" — must be one of ${PROVIDERS.join(', ')}.\n`);
    return 1;
  }
  if (method === 'MANUAL' && provider !== 'MANUAL') {
    process.stderr.write('method MANUAL requires provider MANUAL (manual dispatch record).\n');
    return 1;
  }
  if (method === 'E_SIGNATURE_PROVIDER' && !['NONE', 'TEST_ADAPTER'].includes(provider)) {
    process.stderr.write(`method E_SIGNATURE_PROVIDER only supports provider TEST_ADAPTER (synthetic) or NONE (${PROVIDER_DECISION}). Real providers are unresolved.\n`);
    return 1;
  }

  let agreementPath = opts.positional[1];
  let legalDecisionsPath = opts.legalDecisions;
  if (opts.example) {
    const built = buildExampleReadyAgreement(opts);
    agreementPath = built.agreementPath;
    legalDecisionsPath = built.resolvedPath;
  }
  if (!agreementPath) {
    usage(process.stderr);
    return 2;
  }
  const kind = classifyAgreementInput(agreementPath);
  if (kind === 'UNSAFE') {
    process.stderr.write(`Refusing unsafe agreement input: ${agreementPath}\n` +
      'Agreements must come from ops/agreements/private/, ops/agreements/examples/, ops/proposals/private/ or ops/proposals/examples/.\n');
    return 1;
  }

  let agreement;
  try {
    agreement = readJson(agreementPath);
  } catch (e) {
    process.stderr.write(`Cannot read Agreement: ${e.message}\n`);
    return 1;
  }

  /* §5 input boundary — READY_FOR_EXECUTION + integrity + resolved decisions.
     The same legal-decisions register used to build the Agreement must be used
     to validate it, so classifications can never drift from the register. */
  const v = validateReadyAgreement(agreement, { label: path.basename(agreementPath), legalDecisionsPath });
  if (v.failures.length > 0) {
    process.stderr.write(`AGREEMENT REFUSED — ${v.failures.length} issue(s). No execution package produced.\n`);
    for (const f of v.failures) process.stderr.write(`  FAIL ${f}\n`);
    return 1;
  }

  const executionId = opts.executionId || defaultExecutionId(agreement.agreement_id);
  if (!EXECUTION_ID_RE.test(executionId)) {
    process.stderr.write(`Invalid --execution-id "${executionId}" — EXE-YYYY-NNNN format required.\n`);
    return 1;
  }

  let signers;
  if (opts.signers) {
    try {
      signers = readJson(opts.signers);
    } catch (e) {
      process.stderr.write(`Cannot read --signers file: ${e.message}\n`);
      return 1;
    }
  } else {
    signers = defaultSignersFor(agreement);
  }
  const sg = validateSigners(signers);
  if (!sg.ok) {
    process.stderr.write(`SIGNER MODEL INVALID — ${sg.reasons.length} issue(s).\n`);
    for (const r of sg.reasons) process.stderr.write(`  FAIL ${r}\n`);
    return 1;
  }

  const stamp = nextStamp(opts);
  const record = {
    schema: EXECUTION_SCHEMA,
    execution_id: executionId,
    execution_version: EXECUTION_VERSION,
    agreement_id: agreement.agreement_id,
    agreement_version: agreement.version,
    agreement_status: 'READY_FOR_EXECUTION',
    agreement_checksum_sha256: agreementChecksum(agreement),
    agreement_manifest_ref: `${agreement.agreement_id}-v${agreement.version}-READY_FOR_EXECUTION.manifest.json`,
    proposal_id: (agreement.proposal && agreement.proposal.proposal_id) || '',
    proposal_version: (agreement.proposal && agreement.proposal.version) || '',
    proposal_fingerprint: (agreement.provenance && agreement.provenance.proposal_fingerprint) || '',
    status: 'PREPARED',
    signers,
    execution_method: method,
    provider,
    provider_request_id: null,
    provider_document_id: null,
    requested_at: null,
    completed_at: null,
    cancelled_at: null,
    expired_at: null,
    declined_at: null,
    evidence: { events: [], completion: null, provider_summary: null },
    audit_events: [
      {
        event_id: 'aud-' + sha256hex(`${executionId}:prepared`).slice(0, 12),
        at: stamp,
        action: 'PREPARED',
        detail: 'execution package generated locally only — no dispatch, no signature',
        by: 'CLI'
      }
    ],
    recorded_at: stamp,
    _example: agreement._example === true
  };
  delete record.execution_fingerprint;
  record.execution_fingerprint = buildExecutionFingerprint(record);

  const rv = validateExecutionRecord(record, { label: 'prepared', requireExampleMarker: false });
  if (rv.failures.length > 0) {
    process.stderr.write(`EXECUTION RECORD VALIDATION FAILED — ${rv.failures.length} issue(s).\n`);
    for (const f of rv.failures) process.stderr.write(`  FAIL ${f}\n`);
    return 1;
  }

  if (opts.check) {
    process.stdout.write(`VALID: ${path.basename(agreementPath)} -> ${executionId} v${EXECUTION_VERSION} (PREPARED)\n`);
    return 0;
  }

  const outDir = path.resolve(opts.output || OUT_DIR);
  const unsafe = assertSafeExecutionOutput(outDir);
  if (unsafe) { process.stderr.write(unsafe + '\n'); return 1; }
  const recordPath = path.join(outDir, executionFilename(executionId, EXECUTION_VERSION, 'PREPARED', 0));
  try {
    refuseOverwrite(recordPath, opts);
  } catch (e) {
    process.stderr.write(e.message + '\n');
    return 1;
  }
  writeJson(recordPath, record);

  const pkg = {
    schema: EXECUTION_PACKAGE_SCHEMA,
    execution_id: executionId,
    execution_version: EXECUTION_VERSION,
    agreement_id: record.agreement_id,
    agreement_version: record.agreement_version,
    agreement_checksum_sha256: record.agreement_checksum_sha256,
    agreement_manifest_ref: record.agreement_manifest_ref,
    agreement_document_ref: {
      html: null,
      pdf: null,
      manifest: record.agreement_manifest_ref,
      note: 'Final HTML/PDF are produced by PROP.6 (generate-document.mjs). The package references them deterministically; on-disk refs are added when the files exist in ops/documents/out/agreements/.'
    },
    signers: record.signers,
    execution_method: method,
    provider,
    provider_neutral_payload: buildProviderPayload(record),
    generated_at: stamp,
    _example: record._example === true
  };
  const pkgPath = path.join(outDir, executionPackageFilename(executionId, EXECUTION_VERSION));
  writeJson(pkgPath, pkg);

  process.stdout.write(`Execution package prepared: ${path.relative(root, recordPath)}\n`);
  process.stdout.write(`Execution package manifest:  ${path.relative(root, pkgPath)}\n`);
  process.stdout.write(printRecordStatus(record) + '\n');
  if (provider === 'NONE') {
    process.stdout.write(`${PROVIDER_DECISION} — dispatch/evidence collection requires a provider or the MANUAL path.\n`);
  }
  return 0;
}

/* ------------------------------------------------------------------ */
/* verify / status                                                     */
/* ------------------------------------------------------------------ */
function loadRecord(opts) {
  const p = opts.positional[1];
  if (!p) return { err: 'execution record path required' };
  const kind = classifyExecutionInput(p);
  if (kind === 'UNSAFE') {
    return { err: `Refusing unsafe execution record path: ${p}\nExecution records must come from ops/execution/out/, ops/execution/private/ or ops/execution/examples/.` };
  }
  let record;
  try {
    record = readJson(p);
  } catch (e) {
    return { err: `Cannot read execution record: ${e.message}` };
  }
  const v = validateExecutionRecord(record, { label: path.basename(p), requireExampleMarker: false });
  return { record, checks: v.checks, failures: v.failures, path: p };
}

function runVerify(opts) {
  const loaded = loadRecord(opts);
  if (loaded.err) { process.stderr.write(loaded.err + '\n'); return 1; }
  if (loaded.failures.length > 0) {
    process.stderr.write(`EXECUTION RECORD INVALID — ${loaded.failures.length} issue(s).\n`);
    for (const f of loaded.failures) process.stderr.write(`  FAIL ${f}\n`);
    return 1;
  }
  process.stdout.write(`VALID: ${loaded.record.execution_id} v${loaded.record.execution_version} — status ${loaded.record.status}\n`);
  process.stdout.write(printRecordStatus(loaded.record) + '\n');
  return 0;
}

function runStatus(opts) {
  const loaded = loadRecord(opts);
  if (loaded.err) { process.stderr.write(loaded.err + '\n'); return 1; }
  if (loaded.failures.length > 0) {
    process.stderr.write(`EXECUTION RECORD INVALID — cannot report status.\n`);
    for (const f of loaded.failures) process.stderr.write(`  FAIL ${f}\n`);
    return 1;
  }
  const r = loaded.record;
  process.stdout.write(`execution:  ${r.execution_id} v${r.execution_version}\n`);
  process.stdout.write(`agreement:  ${r.agreement_id} v${r.agreement_version} (${r.agreement_status}) checksum ${r.agreement_checksum_sha256.slice(0, 16)}…\n`);
  process.stdout.write(`proposal:   ${r.proposal_id} v${r.proposal_version} fingerprint ${r.proposal_fingerprint.slice(0, 16)}…\n`);
  process.stdout.write(`method:     ${r.execution_method} · provider: ${r.provider}\n`);
  process.stdout.write(`status:     ${r.status}\n`);
  process.stdout.write(printRecordStatus(r) + '\n');
  process.stdout.write(`requested:  ${r.requested_at || '—'}\n`);
  process.stdout.write(`completed:  ${r.completed_at || '—'}\n`);
  process.stdout.write(`evidence events: ${(r.evidence && r.evidence.events || []).length}\n`);
  return 0;
}

/* ------------------------------------------------------------------ */
/* record-event                                                        */
/* ------------------------------------------------------------------ */
function runRecordEvent(opts) {
  const loaded = loadRecord(opts);
  if (loaded.err) { process.stderr.write(loaded.err + '\n'); return 1; }
  if (loaded.failures.length > 0) {
    process.stderr.write(`EXECUTION RECORD INVALID — cannot record an event.\n`);
    for (const f of loaded.failures) process.stderr.write(`  FAIL ${f}\n`);
    return 1;
  }
  const record = loaded.record;
  const provider = record.provider;
  if (!provider) {
    process.stderr.write(`No provider configured on the execution — ${PROVIDER_DECISION}\n`);
    return 1;
  }
  if (!opts.event) { usage(process.stderr); return 2; }
  let raw;
  try {
    raw = readJson(opts.event);
  } catch (e) {
    process.stderr.write(`Cannot read --event file: ${e.message}\n`);
    return 1;
  }
  if (!EVENT_TYPES.includes(raw.event_type)) {
    process.stderr.write(`Invalid event_type "${raw.event_type}" — must be one of ${EVENT_TYPES.join(', ')}.\n`);
    return 1;
  }

  let canonical;
  try {
    if (raw.event_type === 'EXECUTION_REQUESTED') {
      if (provider === 'NONE') {
        process.stderr.write(`${PROVIDER_DECISION} — cannot dispatch without a provider (use method MANUAL or a TEST_ADAPTER provider for synthetic tests).\n`);
        return 1;
      }
      if (!isIso(raw.event_time)) { process.stderr.write('event_time ISO-8601 required.\n'); return 1; }
      canonical = buildDispatchEvent(provider, record, { ...raw, event_time: raw.event_time || nextStamp(opts) });
    } else {
      const pv = validateProviderEvent(provider, record, raw);
      if (!pv.ok) {
        process.stderr.write(`PROVIDER EVENT REJECTED — ${pv.reasons.length} issue(s).\n`);
        for (const r of pv.reasons) process.stderr.write(`  FAIL ${r}\n`);
        return 1;
      }
      canonical = normalizeExecutionEvidence(provider, record, raw);
    }
  } catch (e) {
    process.stderr.write(`EVENT REJECTED — ${e.message}\n`);
    return 1;
  }

  const applied = applyEvent(record, canonical);
  if (!applied.ok) {
    process.stderr.write(`TRANSITION REJECTED — ${applied.reasons.join('; ')}\n`);
    return 1;
  }

  const rv = validateExecutionRecord(applied.record, { label: 'event', requireExampleMarker: false });
  if (rv.failures.length > 0) {
    process.stderr.write(`EVENT APPLIED BUT RECORD INVALID — ${rv.failures.length} issue(s). No record written.\n`);
    for (const f of rv.failures) process.stderr.write(`  FAIL ${f}\n`);
    return 1;
  }

  const outDir = path.resolve(opts.output || OUT_DIR);
  const unsafe = assertSafeExecutionOutput(outDir);
  if (unsafe) { process.stderr.write(unsafe + '\n'); return 1; }
  const recordPath = opts.out
    ? path.resolve(opts.out)
    : path.join(outDir, executionFilename(record.execution_id, EXECUTION_VERSION, applied.to, applied.record.evidence.events.length));
  const targetUnsafe = assertSafeExecutionOutput(recordPath);
  if (targetUnsafe) { process.stderr.write(targetUnsafe + '\n'); return 1; }
  try {
    refuseOverwrite(recordPath, opts);
  } catch (e) {
    process.stderr.write(e.message + '\n');
    return 1;
  }
  writeJson(recordPath, applied.record);

  process.stdout.write(`${applied.from} -> ${applied.to} (evidence ${canonical.event_id})\n`);
  process.stdout.write(`Record written: ${path.relative(root, recordPath)}\n`);
  process.stdout.write(printRecordStatus(applied.record) + '\n');
  return 0;
}

/* ------------------------------------------------------------------ */
/* finalize — the ONLY path to EXECUTED.                               */
/* ------------------------------------------------------------------ */
function runFinalize(opts) {
  const loaded = loadRecord(opts);
  if (loaded.err) { process.stderr.write(loaded.err + '\n'); return 1; }
  if (loaded.failures.length > 0) {
    process.stderr.write(`EXECUTION RECORD INVALID — cannot finalize.\n`);
    for (const f of loaded.failures) process.stderr.write(`  FAIL ${f}\n`);
    return 1;
  }
  const record = loaded.record;

  let agreement = null;
  if (opts.agreement) {
    if (classifyAgreementInput(opts.agreement) === 'UNSAFE') {
      process.stderr.write(`Refusing unsafe --agreement path: ${opts.agreement}\n`);
      return 1;
    }
    try {
      agreement = readJson(opts.agreement);
    } catch (e) {
      process.stderr.write(`Cannot read --agreement: ${e.message}\n`);
      return 1;
    }
  }

  const gate = executionGate(record, { agreement, validateEvent: verifyEvidenceViaAdapter });
  if (!gate.ok) {
    process.stderr.write(`EXECUTED GATE REFUSED — ${gate.reasons.length} issue(s). No execution occurs without complete, valid evidence.\n`);
    for (const r of gate.reasons) process.stderr.write(`  FAIL ${r}\n`);
    return 1;
  }

  const stamp = nextStamp(opts);
  const executed = { ...record, status: 'EXECUTED', completed_at: stamp };
  executed.evidence = {
    events: (record.evidence && record.evidence.events) || [],
    completion: {
      status: 'EXECUTED',
      recorded_at: stamp,
      completed_signers: signerCompletionState(record).completed.slice().sort(),
      note: 'All required signer completion evidence present and verified. Execution status EXECUTED is governed by this execution layer; the Agreement itself stays READY_FOR_EXECUTION.'
    },
    provider_summary: {
      provider: record.provider,
      evidence_type: (record.evidence && record.evidence.events || []).map((e) => e.evidence_type),
      test_only: record.provider === 'TEST_ADAPTER'
    }
  };
  executed.audit_events = [...((record.audit_events || []).filter(Boolean)), {
    event_id: 'aud-' + sha256hex(`${record.execution_id}:finalized`).slice(0, 12),
    at: stamp,
    action: 'FINALIZED',
    detail: 'EXECUTED — all required signers complete, evidence integrity verified, execution fingerprint valid',
    by: 'CLI'
  }];
  delete executed.execution_fingerprint;
  executed.execution_fingerprint = buildExecutionFingerprint(executed);

  const rv = validateExecutionRecord(executed, { label: 'executed', requireExampleMarker: false });
  if (rv.failures.length > 0) {
    process.stderr.write(`EXECUTED RECORD INVALID — ${rv.failures.length} issue(s). Not written.\n`);
    for (const f of rv.failures) process.stderr.write(`  FAIL ${f}\n`);
    return 1;
  }

  const outDir = path.resolve(opts.output || OUT_DIR);
  const unsafe = assertSafeExecutionOutput(outDir);
  if (unsafe) { process.stderr.write(unsafe + '\n'); return 1; }
  const recordPath = path.join(outDir, executionFilename(record.execution_id, EXECUTION_VERSION, 'EXECUTED', executed.evidence.events.length));
  const bundlePath = path.join(outDir, executedBundleFilename(record.execution_id, EXECUTION_VERSION));
  for (const t of [recordPath, bundlePath]) {
    if (fs.existsSync(t)) {
      process.stderr.write(`EXECUTED artifacts already exist: ${path.relative(root, t)}\n` +
        'Executed records and bundles are immutable. They are never overwritten.\n');
      return 1;
    }
  }

  writeJson(recordPath, executed);
  const bundle = buildExecutedBundle(executed, { executionRecordFilename: path.basename(recordPath) });
  writeJson(bundlePath, bundle);

  process.stdout.write(`EXECUTED — immutable executed record: ${path.relative(root, recordPath)}\n`);
  process.stdout.write(`EXECUTED — executed bundle:           ${path.relative(root, bundlePath)}\n`);
  process.stdout.write('Agreement status is unchanged (READY_FOR_EXECUTION). Execution EXECUTED is a separate governed gate.\n');
  process.stdout.write('No signed PDF is claimed. No invoice. No payment.\n');
  return 0;
}

/* ------------------------------------------------------------------ */
/* CLI                                                                */
/* ------------------------------------------------------------------ */
function usage(out) {
  out.write(`Nexora Agreement Execution System (PROP.7) — v${EXECUTION_VERSION}
Governed execution layer for a READY_FOR_EXECUTION Agreement (PROP.5).
Evidence-driven only. No --force-executed, no --mark-signed, no status flags.
READY_FOR_EXECUTION is NOT SIGNED. EXECUTED is NOT PAID. This is NOT an
e-signature implementation and makes no network calls.

Commands:
  node ops/execution/execution.mjs prepare <agreement.json> [options]
  node ops/execution/execution.mjs verify <execution-record.json>
  node ops/execution/execution.mjs status <execution-record.json>
  node ops/execution/execution.mjs record-event <record.json> --event <event.json> [options]
  node ops/execution/execution.mjs finalize <record.json> [options]

prepare options:
  --execution-id <id>   EXE-YYYY-NNNN (default derived from Agreement lineage)
  --signers <json>      signer array file (default derived from the Agreement)
  --legal-decisions <p> legal-decisions register used to build the Agreement
                        (default: committed register — required for agreements
                        built against a synthetic resolved register)
  --method <MANUAL|E_SIGNATURE_PROVIDER>   default MANUAL
  --provider <MANUAL|TEST_ADAPTER|NONE>    default: MANUAL (MANUAL method),
                        NONE (E_SIGNATURE_PROVIDER — OWNER DECISION REQUIRED)
  --output <dir>        write into <dir> (default ops/execution/out)
  --generated-at <ISO>  deterministic timestamp override (tests)
  --check               validate only (no write)
  --example             build a synthetic READY Agreement + prepare (test-only)
  --overwrite           allow replacing a non-executed record
  --help                show this help

record-event options:
  --event <json>        evidence event file
  --out <path>          explicit output path for the next record
  --overwrite           allow replacing a non-executed target record
  --generated-at <ISO>  deterministic timestamp override

finalize options:
  --agreement <path>    the READY Agreement (re-verifies checksum + linkage)
  --output <dir>        write into <dir> (default ops/execution/out)
  --generated-at <ISO>  deterministic timestamp override

Evidence event (--event) — MANUAL method:
  { "evidence_type": "MANUAL_RECORD", "event_type": "SIGNER_COMPLETED",
    "signer_role": "CLIENT", "event_time": "<ISO>", "note": "..." }

Evidence event — TEST_ADAPTER method (synthetic):
  { "evidence_type": "E_SIGNATURE_PROVIDER", "provider": "TEST_ADAPTER",
    "event_type": "SIGNER_COMPLETED", "signer_role": "CLIENT",
    "event_time": "<ISO>", "provider_event_id": "tevt-<16hex>",
    "document_id": "tdoc-<16hex>", "_test_only": true,
    "note": "TEST ONLY — NOT LEGAL SIGNATURE — NOT FOR PRODUCTION" }

Input safety:
  Execution records -> ops/execution/out|private|examples (else refused)
  Agreements        -> ops/agreements/private|examples and
                       ops/proposals/private|examples (else refused)
  Committed examples must be marked "_example": true.`);
}

function parseArgs(args) {
  const opts = { positional: [] };
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === '--execution-id') opts.executionId = args[++i];
    else if (a === '--signers') opts.signers = args[++i];
    else if (a === '--legal-decisions') opts.legalDecisions = args[++i];
    else if (a === '--method') opts.method = args[++i];
    else if (a === '--provider') opts.provider = args[++i];
    else if (a === '--output') opts.output = args[++i];
    else if (a === '--generated-at') opts.generatedAt = args[++i];
    else if (a === '--check') opts.check = true;
    else if (a === '--example') opts.example = true;
    else if (a === '--overwrite') opts.overwrite = true;
    else if (a === '--event') opts.event = args[++i];
    else if (a === '--out') opts.out = args[++i];
    else if (a === '--agreement') opts.agreement = args[++i];
    else if (a === '--help' || a === '-h') opts.help = true;
    else if (a.startsWith('-')) { opts.bad = a; }
    else opts.positional.push(a);
  }
  return opts;
}

function main() {
  const opts = parseArgs(process.argv.slice(2));
  const cmd = opts.positional[0];
  if (opts.bad) {
    usage(process.stderr);
    process.stderr.write(`Unknown option: ${opts.bad}\n`);
    return 2;
  }
  if (opts.help) { usage(process.stdout); return 0; }

  switch (cmd) {
    case 'prepare':
      return runPrepare(opts);
    case 'verify':
      return runVerify(opts);
    case 'status':
      return runStatus(opts);
    case 'record-event':
      return runRecordEvent(opts);
    case 'finalize':
      return runFinalize(opts);
    default:
      usage(process.stderr);
      return cmd ? 2 : 0;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exit(main());
}
