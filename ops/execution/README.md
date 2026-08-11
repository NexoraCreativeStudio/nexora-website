# Nexora — Agreement Execution System (PROP.7)

The governed execution layer that turns a **READY_FOR_EXECUTION** Agreement
(PROP.5) into a governed execution package, an evidence-driven execution record,
and — **only** through a full evidence gate — an **EXECUTED** execution status.

```
READY_FOR_EXECUTION Agreement (PROP.5)
→ prepare           : governed execution package + PREPARED record (local only)
→ record-event      : evidence-driven transitions
                      EXECUTION_REQUESTED → SENT_FOR_SIGNATURE
                      SIGNER_COMPLETED    → PARTIALLY_SIGNED
                      DECLINED / CANCELLED / EXPIRED → terminal
→ finalize          : EXECUTED ONLY via the full evidence gate
→ verify / status   : integrity + state inspection
```

This is **governance + evidence modelling only**. PROP.7 does **not** implement an
e-signature provider, does **not** collect signatures, does **not** invent a
signed PDF, does **not** invoice, and does **not** collect payment. The real
e-signature provider is **unresolved** (`OWNER DECISION REQUIRED — E-SIGNATURE
PROVIDER`); the provider-neutral boundary is fully operational regardless.

## What PROP.7 does

- **Input boundary (fails closed):** only a governed **READY_FOR_EXECUTION**
  Agreement (PROP.5) may enter. DRAFT Agreements, malformed Agreements, tampered
  Agreements, Agreements with unresolved mandatory legal decisions, and unsafe
  paths are all refused. No `--force` shortcut exists at any gate.
- **Execution package** from the READY Agreement: Agreement identity/version,
  SHA-256 checksum, manifest ref, signer roles, provider-neutral signing payload.
  Deterministic, gitignored output.
- **Evidence-driven status machine.** Every transition is caused by a validated
  evidence event. There is **no** `--force-executed`, **no** `--mark-signed`, and
  **no** `--status` flag. `PREPARED → EXECUTED` directly is impossible.
- **Signer-role model** — `CLIENT` and `NEXORA`, both required, with
  provider-neutral signing anchors (`CLIENT_SIGNATURE`/`CLIENT_NAME`/`CLIENT_DATE`
  /`NEXORA_SIGNATURE`/`NEXORA_NAME`/`NEXORA_DATE`). No identity-verification, KYC,
  IP-verified, certificate-backed, qualified/advanced-e-signature claims are ever
  made (or allowed).
- **Provider abstraction** (`execution-providers.mjs`): a provider-neutral
  interface (`prepareRequest` / `buildProviderPayload` / `validateProviderEvent` /
  `normalizeExecutionEvidence`) with two safe adapters:
  - `MANUAL` — the governed manual execution path (evidence is `MANUAL_RECORD`,
    never claimed to be cryptographically verified);
  - `TEST_ADAPTER` — a **local synthetic** adapter (evidence is
    `E_SIGNATURE_PROVIDER`) used to prove the execution mechanics. Every artifact
    is labelled **`TEST ONLY — NOT LEGAL SIGNATURE — NOT FOR PRODUCTION`**. It is
    **not** a signature and **not** legal execution evidence in production terms.
  - `NONE` — records `OWNER DECISION REQUIRED — E-SIGNATURE PROVIDER` and refuses
    dispatch. No external vendor is authoritative.
  - **No network calls, no API keys, no secrets.**
- **Execution fingerprint** — a deterministic SHA-256 over the governed record
  content + normalised evidence + Agreement linkage. A changed record **fails
  verification** (tamper detection).
- **EXECUTED gate** — the only path to `EXECUTED`: all required signers complete,
  Agreement checksum + lineage match, evidence re-validated through the provider
  adapter (defence in depth), fingerprint valid. No declined/cancelled/expired
  evidence. No silent overwrite — executed records are immutable.
- **Audit trail** — every applied event is appended to `audit_events` (provenance,
  excluded from the fingerprint by design).
- **Webhook readiness** — event/evidence validation + normalisation layer and
  local synthetic fixtures. **No webhook deployment, no Production endpoints.**

## What PROP.7 does NOT do

- **Not an e-signature implementation.** No real provider integration, no signing
  links, no provider API calls, no signer invitations.
- **NEVER creates a fake "signed PDF".** If a signed PDF does not exist, one is
  never invented. Executed bundles always carry `signed_document_ref: null` with
  an explicit boundary note. No signature image is stamped; an unsigned PDF is
  never called "signed".
- **Never fabricates evidence.** A provider event must pass adapter validation
  (fail-closed) before it becomes evidence; a fabricated provider request id is
  refused (anti-fabrication).
- **Does not touch the Agreement's status.** The Agreement stays
  `READY_FOR_EXECUTION`; execution status (`EXECUTED`) is a **separate** governed
  concept. **`READY_FOR_EXECUTION` is NOT `SIGNED`.**
- **No invoicing**, no invoice creation, no payment intent, no Stripe/PayPal, no
  Payment Links, no bank collection, no subscription setup, no payment buttons.
  **`EXECUTED` is NOT `PAID`.**
- **No commercial Source of Truth changes.** Nothing here re-prices, re-bills, or
  alters the Constitution / billing source of truth.
- **No real client data committed.** Execution packages, records, evidence, audit
  trails and executed bundles are private/gitignored. Committed fixtures are
  synthetic and must carry `"_example": true`.

## Boundaries (explicit)

- **A checksum / execution fingerprint is NOT a digital signature.** It is an
  integrity aid only and provides no signer authenticity.
- **Synthetic TEST_ADAPTER fixtures are NOT legal signatures** and carry the
  `TEST ONLY — NOT LEGAL SIGNATURE — NOT FOR PRODUCTION` label.
- **`READY_FOR_EXECUTION` is NOT `SIGNED`** (separate external gate).
- **`EXECUTED` is NOT `PAID`** (separate invoicing/payment gates).
- **`MANUAL_RECORD` evidence is a governed manual record**, not a cryptographic
  provider response.
- **Final document output (PROP.6) is NOT an e-signature.**

## Status model

| Status | Meaning | Entered via |
|---|---|---|
| `PREPARED` | Execution package generated locally; nothing dispatched | `prepare` |
| `SENT_FOR_SIGNATURE` | Dispatch evidence recorded (request to signers) | `record-event EXECUTION_REQUESTED` |
| `PARTIALLY_SIGNED` | One or more (not all) required signers completed | `record-event SIGNER_COMPLETED` |
| `EXECUTED` | **All** required signers complete + full evidence gate passes | `finalize` (gate) |
| `DECLINED` / `CANCELLED` / `EXPIRED` | Terminal, cannot reach EXECUTED | `record-event` |

`SIGNED` is **never** an execution status — signing is a separate external event
this layer does not model.

## Signer model

- Roles are exactly `CLIENT` and `NEXORA`, both `required: true`.
- Signers are derived by default from the READY Agreement's client/company;
  `--signers <json>` may supply a governed list, but it must include both roles
  with no duplicates and no missing required role.
- Signer completion is driven **only** by `SIGNER_COMPLETED` evidence.
- Identity claims (identity verified, KYC, IP verified, certificate-backed,
  qualified/advanced e-signature, notarised, cryptographically verified) are
  refused by the claim scanner — positive assertions only; a statement that
  something is "not verified" is not a claim.

## Provider abstraction

`execution-providers.mjs` defines the provider-neutral boundary. The real
e-signature provider is unresolved; `NONE` is the honest default for
`E_SIGNATURE_PROVIDER` method.

| Provider | Purpose | Evidence type |
|---|---|---|
| `MANUAL` | Governed manual dispatch + signer records | `MANUAL_RECORD` |
| `TEST_ADAPTER` | **Synthetic** local adapter — proves mechanics only | `E_SIGNATURE_PROVIDER` (`_test_only`, TEST label) |
| `NONE` | `OWNER DECISION REQUIRED` — dispatch refused | — |

Deterministic derived ids (`preq-te-…`, `tdoc-…`, `tevt-…`, `evt-man-…`) come from
the execution_id via SHA-256, so a hand-fabricated id can never match a genuine
adapter id (anti-fabrication). The adapter performs **no network calls**.

## Execution fingerprint

`buildExecutionFingerprint` hashes execution identity + Agreement linkage
(id/version/status/checksum/manifest) + Proposal lineage + status + signers +
method/provider/request/doc ids + timestamps + sorted normalised evidence events.
Excluded by design: `execution_fingerprint` itself, `audit_events` (append-only
provenance), `recorded_at`, `_example`. `verifyExecutionFingerprint` recomputes
and rejects any changed record.

## CLI

```
node ops/execution/execution.mjs prepare <agreement.json> [options]
node ops/execution/execution.mjs verify <execution-record.json>
node ops/execution/execution.mjs status <execution-record.json>
node ops/execution/execution.mjs record-event <record.json> --event <event.json> [options]
node ops/execution/execution.mjs finalize <record.json> [options]
```

`prepare` options: `--execution-id`, `--signers`, `--legal-decisions`,
`--method <MANUAL|E_SIGNATURE_PROVIDER>`, `--provider <MANUAL|TEST_ADAPTER|NONE>`,
`--output`, `--generated-at`, `--check`, `--example`, `--overwrite`, `--help`.

`record-event` options: `--event <json>`, `--out`, `--overwrite`, `--generated-at`.

`finalize` options: `--agreement <path>` (re-verifies checksum + linkage),
`--output`, `--generated-at`.

- **No command sets EXECUTED without evidence.** `finalize` runs the full gate or
  refuses. There is no `--force-executed` / `--mark-signed` / `--status`.
- **Input safety:** execution records from `ops/execution/out|private|examples`,
  Agreements from `ops/agreements/private|examples` and
  `ops/proposals/private|examples` — anything else is refused. Output must stay
  within the repository root.
- **Determinism:** identical `--generated-at` + identical inputs → identical
  outputs; filenames are deterministic (`{id}-v{ver}-{STATUS}-{n}.execution.json`,
  evidence count in the name so repeated completions can never collide).

## Privacy

Real execution data (signer names/emails, provider request/document ids, evidence,
audit trails, executed bundles) is **never committed**:

- `ops/execution/private/` and `ops/execution/out/` are git-ignored.
- Committed fixtures are synthetic and **must** carry `"_example": true` (the
  validator enforces this — a real-client-style unmarked fixture fails).
- No real signatures, provider responses, certificates, API keys, tokens or
  secrets are committed. A secret-scan (`scanSecrets`) runs over generated
  artifacts.
- No real e-signature provider responses are stored anywhere by this layer.

## Validator

`node ops/execution/validate-execution.mjs`

98 checks: static safety (no network/deps, no status-shortcut flags, no
hard-coded prices, gitignore), positive QA (READY→PREPARED package, signer
mapping, provider-neutral payload, MANUAL path to EXECUTED, TEST_ADAPTER synthetic
path to EXECUTED, partial state, fingerprint validity, immutable executed record,
checksum linkage, manual-evidence model), and **32 negative tests** proving
fail-closed rejection of: DRAFT input, malformed Agreement, Agreement checksum
mismatch, wrong Agreement identity, unresolved legal decisions, missing required
signer, duplicate signer role, fabricated provider request id, event for wrong
execution, event for wrong Agreement, missing completion event, one signer
incomplete, declined, cancelled, expired, tampered event, fingerprint mismatch,
direct PREPARED→EXECUTED, status-shortcut flags, fake signature/certificate
fields, legacy Starter/Elite/£250/AI Care, unsupported VAT assertion,
real-client-style unmarked fixture, unsafe input path, unsafe output path,
overwrite of an executed record, secret-looking credential, fake signed-PDF
classification, and a provider event without adapter validation. Plus a privacy
sweep and full cleanup of all tmp fixtures (all under gitignored locations).

## Source-of-truth safety

PROP.7 consumes the governed Agreement and never alters the Commercial
Constitution, `ops/billing-source-of-truth.json`, pricing, or legal decisions. It
creates no invoice, no invoice number, no payment intent, and no payment
capability of any kind.

## Explicit boundaries

- **Checksum/fingerprint ≠ e-signature**
- **Synthetic TEST_ADAPTER fixtures ≠ legal signatures**
- **READY_FOR_EXECUTION ≠ SIGNED**
- **EXECUTED ≠ PAID**
- **Execution record immutability** — once EXECUTED, a record is never silently
  overwritten; corrections require new governed events, not edits.

E-signature provider selection is an **Owner decision** (`OWNER DECISION
REQUIRED — E-SIGNATURE PROVIDER`). When one is chosen, a future adapter may
archive a real signed PDF with a checksum — this layer never claims a signed PDF
it does not hold.
