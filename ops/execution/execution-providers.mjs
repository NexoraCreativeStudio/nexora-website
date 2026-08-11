/* Nexora Agreement Execution System (PROP.7) — provider abstraction.
   Provider-neutral interface for the e-signature boundary.

   THIS IS NOT A REAL PROVIDER INTEGRATION. It performs NO network calls,
   requires NO API keys, and never touches a real e-signature service.
   It defines the interface + two safe adapters:

     MANUAL         — the governed manual execution path (dispatch + signer
                      events are MANUAL_RECORD evidence, never claimed to be
                      cryptographically verified).
     TEST_ADAPTER   — a LOCAL SYNTHETIC adapter that simulates provider event
                      structures so the execution mechanics can be validated.
                      Every artifact is labelled:
                        TEST ONLY — NOT LEGAL SIGNATURE — NOT FOR PRODUCTION
                      It is NOT a signature, NOT legal execution evidence in
                      production semantics.

   Interface (see validateProviderEvent / normalizeExecutionEvidence):
     prepareRequest()          -> provider request/document ids (no network)
     buildProviderPayload()    -> provider-neutral signing payload
     validateProviderEvent()   -> adapter-specific event validation
     normalizeExecutionEvidence() -> canonical evidence event

   No external vendor is authoritative to the Agreement system. The real
   e-signature provider is unresolved (OWNER DECISION REQUIRED) until the
   Owner selects one — PROP.7 continues to build the provider-neutral layer
   regardless. */
import { sha256hex } from '../documents/document-output.mjs';
import {
  EXECUTION_VERSION,
  EXECUTION_SCHEMA,
  SIGNATURE_ANCHORS,
  PROVIDERS,
  EVIDENCE_TYPES,
  EVENT_TYPES,
  PROVIDER_DECISION,
  TEST_LABEL,
  scanIdentityClaims,
  verifyExecutionFingerprint
} from './execution-validation.mjs';

export const REQUEST_ID_RE = /^preq-te-[0-9a-f]{16}$/;
export const EVENT_ID_RE = /^tevt-[0-9a-f]{16}$/;
export const DOCUMENT_ID_RE = /^tdoc-[0-9a-f]{16}$/;

const der = (seed) => sha256hex(`nexora-execution-test-adapter:${seed}`);

/* Deterministic ids — derived from the execution_id so a hand-fabricated id
   can never match a genuine adapter id (anti-fabrication). */
export function deriveRequestId(executionId) { return 'preq-te-' + der(`${executionId}:request`).slice(0, 16); }
export function deriveDocumentId(executionId) { return 'tdoc-' + der(`${executionId}:document`).slice(0, 16); }
export function deriveEventId(executionId, role, seed) { return 'tevt-' + der(`${executionId}:${role || ''}:${seed}`).slice(0, 16); }
export function deriveManualEventId(executionId, seed) { return 'evt-man-' + sha256hex(`${executionId}:manual:${seed}`).slice(0, 16); }

function isIsoTime(t) {
  return typeof t === 'string' && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/.test(t);
}

/* ------------------------------------------------------------------ */
/* prepareRequest — local only, never a network call.                  */
/* ------------------------------------------------------------------ */
export function prepareRequest(provider, execution) {
  if (provider === 'MANUAL') {
    return {
      ok: true,
      provider: 'MANUAL',
      provider_request_id: null,
      provider_document_id: null,
      note: 'Manual dispatch record — the execution package is handed to the signers outside an automated provider. NOT a provider event and NOT cryptographically verified.'
    };
  }
  if (provider === 'TEST_ADAPTER') {
    return {
      ok: true,
      provider: 'TEST_ADAPTER',
      provider_request_id: deriveRequestId(execution.execution_id),
      provider_document_id: deriveDocumentId(execution.execution_id),
      note: TEST_LABEL
    };
  }
  return { ok: false, provider, reason: `${PROVIDER_DECISION} — provider "${provider}" cannot dispatch. Use MANUAL or a TEST_ADAPTER for synthetic tests.` };
}

/* ------------------------------------------------------------------ */
/* buildProviderPayload — provider-neutral signing payload.            */
/* ------------------------------------------------------------------ */
export function buildProviderPayload(execution) {
  const signers = (execution.signers || []).map((s) => {
    const anchor = (SIGNATURE_ANCHORS.find((a) => a.signer_role === s.role) || {}).anchor || null;
    return {
      role: s.role,
      name: s.name,
      email: s.email || null,
      organisation: s.organisation || null,
      required: !!s.required,
      signature_anchor: anchor
    };
  });
  return {
    schema: 'nexora-execution-provider-payload/v1',
    document: {
      agreement_id: execution.agreement_id,
      agreement_version: execution.agreement_version,
      agreement_checksum_sha256: execution.agreement_checksum_sha256,
      agreement_manifest_ref: execution.agreement_manifest_ref || null
    },
    signers,
    signature_anchors: SIGNATURE_ANCHORS,
    provider_neutral: true,
    provider_resolution: execution.provider === 'NONE'
      ? { state: PROVIDER_DECISION, provider: null }
      : { state: 'RESOLVED', provider: execution.provider },
    execution_schema: EXECUTION_SCHEMA,
    execution_version: EXECUTION_VERSION
  };
}

/* ------------------------------------------------------------------ */
/* validateProviderEvent — adapter-specific, fail-closed.              */
/* ------------------------------------------------------------------ */
export function validateProviderEvent(provider, execution, rawEvent) {
  const reasons = [];
  if (!rawEvent || typeof rawEvent !== 'object') return { ok: false, reasons: ['provider event must be an object'] };

  if (provider === 'NONE') {
    reasons.push(`${PROVIDER_DECISION} — no provider is configured on this execution; dispatch and evidence collection are unavailable`);
    return { ok: false, reasons };
  }
  if (!PROVIDERS.includes(provider)) { reasons.push(`unsupported provider "${provider}"`); return { ok: false, reasons }; }

  if (!EVENT_TYPES.includes(rawEvent.event_type)) reasons.push(`event_type "${rawEvent.event_type}" — must be one of ${EVENT_TYPES.join(', ')}`);
  if (!isIsoTime(rawEvent.event_time)) reasons.push('event_time ISO-8601 required');
  if (!EVIDENCE_TYPES.includes(rawEvent.evidence_type)) reasons.push('evidence_type required (MANUAL_RECORD or E_SIGNATURE_PROVIDER)');
  if (rawEvent.event_type === 'SIGNER_COMPLETED' && (!rawEvent.signer_role || !execution.signers.some((s) => s.role === rawEvent.signer_role))) {
    reasons.push(`SIGNER_COMPLETED requires a signer_role present on the execution ("${rawEvent.signer_role || ''}")`);
  }

  if (provider === 'MANUAL') {
    if (rawEvent.evidence_type !== 'MANUAL_RECORD') reasons.push('MANUAL evidence must be evidence_type MANUAL_RECORD');
    if (typeof rawEvent.note !== 'string' || !rawEvent.note.trim()) reasons.push('MANUAL evidence requires a note (who recorded what, and how)');
    if (rawEvent.provider_event_id != null) reasons.push('MANUAL evidence must not carry a provider_event_id (a manual record is not a provider event)');
    if (rawEvent.provider_request_id != null) reasons.push('MANUAL evidence must not carry a provider_request_id');
    if (rawEvent.provider && rawEvent.provider !== 'MANUAL') reasons.push('provider must be MANUAL for a manual record');
  }

  if (provider === 'TEST_ADAPTER') {
    const isDispatch = rawEvent.event_type === 'EXECUTION_REQUESTED';
    if (execution.provider !== 'TEST_ADAPTER') reasons.push('execution provider is not TEST_ADAPTER');
    /* Anti-fabrication: at dispatch the adapter derives the request id (the
       dispatch event carries it); afterwards the RECORD must already carry the
       genuine derived request id. A hand-fabricated id can never match. */
    if (!isDispatch && execution.provider_request_id !== deriveRequestId(execution.execution_id)) {
      reasons.push('execution.provider_request_id is not the genuine TEST_ADAPTER request id for this execution (fabricated request id)');
    }
    if (rawEvent.provider_request_id != null && rawEvent.provider_request_id !== deriveRequestId(execution.execution_id)) {
      reasons.push('event provider_request_id is not the genuine TEST_ADAPTER request id (fabricated)');
    }
    if (rawEvent.evidence_type !== 'E_SIGNATURE_PROVIDER') reasons.push('TEST_ADAPTER evidence must be evidence_type E_SIGNATURE_PROVIDER');
    if (rawEvent.provider !== 'TEST_ADAPTER') reasons.push('provider must be TEST_ADAPTER for a synthetic provider event');
    if (typeof rawEvent.provider_event_id !== 'string' || !EVENT_ID_RE.test(rawEvent.provider_event_id)) reasons.push(`TEST_ADAPTER provider_event_id must match ${EVENT_ID_RE}`);
    if (rawEvent.document_id !== deriveDocumentId(execution.execution_id)) reasons.push('TEST_ADAPTER document_id is not the genuine document id for this execution');
    if (rawEvent._test_only !== true) reasons.push('TEST_ADAPTER events must be explicitly labelled _test_only: true');
    if (typeof rawEvent.note === 'string' && !/TEST ONLY/.test(rawEvent.note)) reasons.push('TEST_ADAPTER events must carry the TEST ONLY label in the note');
  }

  /* Never claim cryptographic verification or identity verification. */
  const claims = scanIdentityClaims(JSON.stringify(rawEvent));
  for (const c of claims) reasons.push(`unsupported claim "${c}" — no such evidence exists here`);

  return { ok: reasons.length === 0, reasons };
}

/* ------------------------------------------------------------------ */
/* normalizeExecutionEvidence — raw provider/manual event -> canonical. */
/* ------------------------------------------------------------------ */
export function normalizeExecutionEvidence(provider, execution, rawEvent) {
  const v = validateProviderEvent(provider, execution, rawEvent);
  if (!v.ok) throw new Error('Cannot normalise provider event: ' + v.reasons.join('; '));

  const completion = rawEvent.event_type === 'SIGNER_COMPLETED';
  const seed = `${rawEvent.event_time}:${rawEvent.signer_role || ''}:${rawEvent.note || rawEvent.provider_event_id || ''}`;
  const base = {
    execution_id: execution.execution_id,
    agreement_id: execution.agreement_id,
    event_type: rawEvent.event_type,
    event_time: rawEvent.event_time,
    evidence_type: rawEvent.evidence_type,
    completion,
    signer_role: rawEvent.signer_role || null,
    document_checksum_sha256: rawEvent.document_checksum_sha256 || null,
    note: rawEvent.note || null
  };

  if (provider === 'MANUAL') {
    return {
      ...base,
      event_id: deriveManualEventId(execution.execution_id, seed),
      provider: 'MANUAL',
      provider_event_id: null,
      document_id: null,
      provider_request_id: null
    };
  }

  /* TEST_ADAPTER — clearly synthetic. */
  const docId = deriveDocumentId(execution.execution_id);
  const reqId = deriveRequestId(execution.execution_id);
  const eventId = rawEvent.provider_event_id || deriveEventId(execution.execution_id, rawEvent.signer_role, seed);
  return {
    ...base,
    event_id: eventId,
    provider: 'TEST_ADAPTER',
    provider_event_id: eventId,
    document_id: docId,
    provider_request_id: rawEvent.event_type === 'EXECUTION_REQUESTED' ? reqId : null,
    _test_only: true,
    test_label: TEST_LABEL,
    note: rawEvent.note || TEST_LABEL
  };
}

/* ------------------------------------------------------------------ */
/* buildDispatchEvent — the evidence for EXECUTION_REQUESTED.          */
/* ------------------------------------------------------------------ */
export function buildDispatchEvent(provider, execution, rawEvent) {
  const req = prepareRequest(provider, execution);
  if (!req.ok) throw new Error(req.reason);
  if (provider === 'MANUAL') {
    return normalizeExecutionEvidence('MANUAL', execution, {
      evidence_type: 'MANUAL_RECORD',
      event_type: 'EXECUTION_REQUESTED',
      event_time: rawEvent.event_time,
      note: rawEvent.note || req.note
    });
  }
  if (provider === 'TEST_ADAPTER') {
    return normalizeExecutionEvidence('TEST_ADAPTER', execution, {
      evidence_type: 'E_SIGNATURE_PROVIDER',
      provider: 'TEST_ADAPTER',
      event_type: 'EXECUTION_REQUESTED',
      event_time: rawEvent.event_time,
      provider_event_id: deriveEventId(execution.execution_id, 'dispatch', rawEvent.event_time),
      document_id: req.provider_document_id,
      _test_only: true,
      note: req.note
    });
  }
  throw new Error(`${PROVIDER_DECISION} — cannot dispatch with provider "${provider}"`);
}

/* ------------------------------------------------------------------ */
/* verifyEvidenceViaAdapter — re-validates recorded evidence through    */
/* the adapter (used by the EXECUTED gate, defence in depth).          */
/* ------------------------------------------------------------------ */
export function verifyEvidenceViaAdapter(execution, canonicalEvent) {
  const v = validateProviderEvent(execution.provider, execution, {
    evidence_type: canonicalEvent.evidence_type,
    provider: canonicalEvent.provider,
    event_type: canonicalEvent.event_type,
    event_time: canonicalEvent.event_time,
    signer_role: canonicalEvent.signer_role,
    note: canonicalEvent.note,
    provider_event_id: canonicalEvent.provider_event_id,
    document_id: canonicalEvent.document_id,
    provider_request_id: canonicalEvent.provider_request_id,
    document_checksum_sha256: canonicalEvent.document_checksum_sha256,
    _test_only: canonicalEvent._test_only
  });
  if (!v.ok) return { ok: false, reasons: v.reasons };
  /* Also require the recorded fingerprint to verify (tamper detection). */
  const fp = verifyExecutionFingerprint(execution);
  if (!fp.ok) return { ok: false, reasons: fp.reasons };
  return { ok: true, reasons: [] };
}

export { PROVIDERS, EVIDENCE_TYPES, EVENT_TYPES, PROVIDER_DECISION, TEST_LABEL };
