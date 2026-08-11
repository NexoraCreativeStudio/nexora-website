# Nexora — Governed Agreement System (PROP.5)

The governed Agreement layer that consumes the controlled **Agreement Handoff**
produced by PROP.4 after `CLIENT_ACCEPTED`. This is the bridge from an accepted
Proposal toward a future executed Agreement.

```
Validated Proposal
→ CLIENT_ACCEPTED
→ immutable acceptance record
→ controlled Agreement Handoff (PROP.4)
→ PROP.5 Agreement validation
→ Agreement document generation
→ DRAFT AGREEMENT (NOT FOR EXECUTION)  |  READY_FOR_EXECUTION (gate)
→ later execution / signature (EXTERNAL gate — NOT implemented here)
```

This is **governance + generation only**. PROP.5 does **not** execute Agreements,
does **not** collect signatures, does **not** invoice, and does **not** collect
payment.

## What PROP.5 does

- Consumes a PROP.4 Agreement Handoff and **fails closed** unless the handoff and
  its provenance are valid (accepted Proposal fingerprint, acceptance record,
  commercial snapshot vs the Source of Truth).
- Produces a governed Agreement data model (`nexora-agreement/v1`) inheriting the
  accepted commercial snapshot — **Approved Final Project Price** is the
  contractual amount; reference/public pricing is informational only and never
  replaces it.
- Renders a professional, print-ready **Nexora Agreement** HTML document (A4,
  browser Print → Save as PDF) that is clearly distinct from the Proposal.
- Classifies every legal clause via the committed legal-decision register.
  Unresolved legal decisions render as clearly-marked provisions in a **DRAFT**;
  a **READY_FOR_EXECUTION** Agreement is refused while any mandatory decision is
  unresolved (**no `--force-ready` shortcut**).

## What PROP.5 does NOT do

- **Agreement generation ≠ Agreement execution.** Nothing here signs anything.
- **No e-signature provider** (DocuSign / Dropbox Sign / Adobe Sign), no signing
  links, no signature evidence.
- **READY_FOR_EXECUTION ≠ SIGNED.** Execution/signature is a separate external
  gate and is deliberately not modelled.
- **No invoicing engine**, no invoice creation, no bank collection, no payment
  processor, no Stripe/PayPal, no payment buttons.
- **No CRM**, no customer portal, no public exposure of Agreement generation.
- **No new commercial Source of Truth.** All commercial values are inherited and
  re-validated, never re-priced here.
- **No invented contract law.** See the legal governance section.

## Source-of-Truth hierarchy

| Source | Role |
|---|---|
| `docs/constitution/COMMERCIAL-CONSTITUTION.md` | Governance authority (freeze, change control) |
| `ops/billing-source-of-truth.json` | **Authoritative pricing / schedule / Care / recurring rules** — consumed, never duplicated |
| `ops/BILLING-SOURCE-OF-TRUTH.md` | Human-readable mirror |
| `ops/INVOICE-FLOW.md`, `ops/PAYMENT-OPERATIONS.md` | Invoice/payment operational rules (separate gates) |
| `ops/proposals/` (PROP.1–PROP.4) | Proposal schema, lifecycle, acceptance records, **Agreement Handoff** |
| `ops/agreements/legal/legal-decisions.json` | **Legal-clause classification register** (committed truth) |
| `ops/agreements/` (this directory) | Agreement model, generator, validator, templates |

PROP.5 is a **consumer**. It never becomes a pricing authority.

## Agreement flow

1. A Proposal reaches `CLIENT_ACCEPTED` (PROP.4). Its commercial snapshot is
   frozen and fingerprinted.
2. `node ops/proposals/proposal-lifecycle.mjs handoff <proposal.json>` emits the
   Agreement Handoff (gitignored, `ops/proposals/private/handoffs/`).
3. The Agreement generator verifies the handoff end-to-end (below) and produces
   the Agreement.

## Agreement data model

`ops/agreements/agreement.schema.json` — `nexora-agreement/v1`.

- `agreement_id` — `AGR-YYYY-NNNN` (derived from the Proposal lineage by default,
  e.g. accepted `PRP-2026-9104` → `AGR-2026-9104`).
- `version` — document version (`x.y`).
- `status` — `DRAFT` | `READY_FOR_EXECUTION`. **SIGNED is not modelled.**
- `created_at` — creation date.
- `proposal` — the accepted Proposal identity (`proposal_id`, `version`).
- `provenance` — `proposal_fingerprint` (canonical SHA-256), `acceptance_record`
  schema, `agreement_handoff` schema, `handoff_fingerprint`.
- `client` / `project` / `offering` — inherited from the accepted Proposal.
- `scope` / `timeline` — inherited.
- `commercial_schedule` — **inherited verbatim** from the accepted Proposal /
  Handoff and re-validated against the billing Source of Truth.
- `legal_sections` — one entry per legal clause in the inventory, classified
  against the register.
- `document_control` — id/version/status/created/supersedes.
- `execution` — **placeholders only** (must remain `null`; signature/execution is
  an external gate).

## Agreement IDs and statuses

- **ID:** `AGR-YYYY-NNNN`. No existing governed Agreement ID format was found, so
  this format is established by PROP.5.
- **Statuses:** minimal and appropriate to PROP.5:
  - `DRAFT` — may contain unresolved legal decisions; clearly labelled
    **NOT FOR EXECUTION**.
  - `READY_FOR_EXECUTION` — every mandatory legal/commercial decision resolved
    through an approved source; all integrity checks pass.
- `SIGNED` / executed state is **not** implemented — actual signature/execution
  does not exist yet.

## Upstream handoff verification (fails closed)

The generator verifies its input as far as the existing architecture permits:

- handoff `schema` = `nexora-agreement-handoff/v1`, `status` = `READY_FOR_AGREEMENT`;
- `proposal_id` / `proposal_version` identity;
- `acceptance.content_sha256` (canonical SHA-256) present + `canonical_format`;
- the **accepted Proposal is re-fingerprinted** (`nexora-proposal-canonical/v1`
  SHA-256) and compared to the fingerprint in the handoff and in the acceptance
  record — a modified accepted Proposal is refused;
- the **acceptance record** identity and fingerprint must match;
- the handoff `commercial_snapshot` must deep-equal the accepted Proposal's
  `commercial_schedule` (approved price, schedule, setup fee, recurring, Care,
  Warranty, VAT) — **commercial drift is refused**;
- the Proposal must be `CLIENT_ACCEPTED` (never DRAFT / INTERNAL_APPROVED / SENT /
  DECLINED / EXPIRED / SUPERSEDED).

Any tampering — changed approved price, changed milestone percentages, changed
offering, changed client identity, altered acceptance record, mismatched
fingerprint, a handoff for a non-accepted Proposal, a fabricated handoff — causes
generation to **fail closed**.

## Commercial inheritance

All commercial values render exclusively from validated accepted data:

- **Approved Final Project Price** is the contractual commercial amount. The
  public/reference "From" price is shown only as an informational reference and is
  explicitly **not** the contractual amount. Reference pricing can never silently
  replace the Approved price (the Agreement refuses to exist without it).
- **Milestones** are deterministic amounts = `Approved Final Project Price ×
  percentage`, using the PROP.3 rounding policy (non-final tranches rounded to the
  pound; the final tranche absorbs the residual so the total **exactly equals** the
  Approved price). B2 40/30/30, B3 per-proposal, Complete 30/30/30/10.
- **Setup / implementation fee** inherited where applicable.
- **AI recurring** starts at **Go-Live**, never before — wording never implies
  acceptance, generation, execution, or project start. Uses the governed monthly
  amount from the Source of Truth.
- **Care** (Web Care, Brand & Creative Care) stays a distinct, optional, governed
  component: monthly in advance, separately identifiable, never bundled. No AI
  Care. Care is never silently added — only what the accepted Proposal contained.
- **Warranty** — only governed/validated data renders (the 90-day Web Launch
  Warranty where the accepted data permits). No invented warranty language.
- **VAT / tax** — preserved as **UNDETERMINED**. No registered/unregistered, no
  rate, no inclusive/exclusive claim is asserted. The neutral tax note is used.

## Legal governance

`ops/agreements/legal/legal-decisions.json` is the committed classification
register. Every legal clause is classified as one of:

| Classification | Meaning |
|---|---|
| `AUTHORITATIVE` | Already governed by an approved Nexora source |
| `DERIVED` | Safely derived from authoritative data |
| `CLIENT_SPECIFIC` | Recorded client-specific value |
| `LEGAL_DECISION_REQUIRED` | **No owner/legal decision exists — must NOT appear as an agreed term** |

**Currently every legal clause is `LEGAL_DECISION_REQUIRED`.** No owner/legal
decision has been made, and none is invented by PROP.5. The affected clauses
include governing law, jurisdiction, dispute resolution, limitation of liability,
indemnities, IP ownership, confidentiality, termination, cancellation, refunds,
late-payment penalties, debt recovery, force majeure, data processing / GDPR,
broader warranty terms, statutory representations, VAT/tax treatment, ownership
transfer, portfolio/publicity rights, non-solicitation, exclusivity,
acceptance-by-conduct, automatic renewals, minimum subscription periods, and
cancellation notice periods.

- **DRAFT** Agreements render each unresolved provision with a professional
  neutral marker (**"To be confirmed"**) — an unresolved decision is never
  disguised as an agreed term.
- **READY_FOR_EXECUTION** is refused while any mandatory clause remains
  `LEGAL_DECISION_REQUIRED`. There is **no `--force-ready` shortcut**.

Resolving a clause is an Owner/legal decision recorded in the register through the
Constitution change-control process — never by the generator.

## DRAFT vs READY_FOR_EXECUTION

- **DRAFT** — generated by default; may contain unresolved provisions; carries a
  prominent **"DRAFT — NOT FOR EXECUTION"** banner; execution section is
  placeholders only.
- **READY_FOR_EXECUTION** — `--status READY_FOR_EXECUTION`; the fail-closed
  readiness check requires:
  - every mandatory legal/commercial decision resolved in the register;
  - no unresolved required placeholders;
  - all integrity checks pass.
  - It still renders **"READY FOR EXECUTION — NOT YET SIGNED"** and placeholders.

## Generator

`node ops/agreements/generate-agreement.mjs <handoff.json> [options]`

```
--proposal <p>           accepted Proposal file (provenance re-verification)
--acceptance-record <r>  acceptance record (provenance re-verification)
--legal-decisions <p>    legal-decisions register (default: committed register)
--status <DRAFT|READY_FOR_EXECUTION>   default DRAFT (no --force shortcut)
--agreement-id <id>      AGR-YYYY-NNNN (default: derived from the Proposal lineage)
--json                   write the governed Agreement JSON (default: HTML document)
--output <path>          write to <path> (default: out/{agreement_id}-v{version}.html)
--generated-at <ISO>     deterministic timestamp override (tests)
--check                  validate only (no render); exit 0 if generation-safe
--overwrite              allow replacing an existing output for the same id + version
--help                   show usage
```

- **Input safety:** real Agreements live in `ops/agreements/private/` (gitignored,
  no marker required); synthetic fixtures in `ops/agreements/examples/` (must carry
  `"_example": true`); upstream governed inputs (handoff, accepted Proposal,
  acceptance record) are read from the Proposal system's private/examples areas;
  **any other path is refused**.
- **Output:** self-contained HTML (browser Print → Save as PDF) under
  `ops/agreements/out/` (gitignored) or `--output`. Output must stay within the
  repository root; overwrite requires `--overwrite`.
- **Determinism:** identical `--generated-at` + identical inputs → identical output.
- **Escaping:** all client content is HTML-escaped in the document.
- **No leftover tokens:** the generator asserts no unresolved template tokens.

`node ops/agreements/generate-agreement.mjs --example` renders the committed
synthetic B2 DRAFT Agreement pair.

## Privacy

Real Agreement data is **never committed**:

- `ops/agreements/private/` and `ops/agreements/out/` are git-ignored.
- Committed fixtures under `ops/agreements/examples/` are synthetic only and
  **must** carry `"_example": true` (enforced by the validator, so a real Agreement
  dropped in by mistake fails validation).
- Only `example.com` contacts, fictional clients, synthetic prices are committed.
- No real names, emails, phones, signatures, negotiated prices, or client projects.

## Validator

`node ops/agreements/validate-agreements.mjs`

76 checks: static safety, legal register truthfulness, data-model units,
commercial inheritance, positive generator flows (B2 / AI recurring Go-Live /
Complete bespoke / Care / warranty conditional / deterministic / HTML escaping /
status labelling / READY gate), and negative tests proving fail-closed rejection
of: non-accepted provenance, fingerprint mismatch, modified approved price,
modified payment schedule, offering mismatch, acceptance-record mismatch,
fabricated handoff, unresolved decisions promoted to READY_FOR_EXECUTION, legacy
Starter, legacy Elite, £250, unsupported VAT, AI Care, recurring before Go-Live,
reference price used as contractual, malformed JSON, unsafe input path, unsafe
output path/traversal, overwrite without policy, leftover tokens, unmarked
fixtures, and milestone rounding/total mismatch.

## Explicit boundaries

- **Agreement generation != Agreement execution**
- **Acceptance record != e-signature**
- **Agreement Handoff != Agreement**
- **READY_FOR_EXECUTION != SIGNED**
- **Accepted Proposal != invoice; no payment is collected by PROP.5**

E-signature, the Agreement execution gate, invoicing, and payment processing
remain separate (later PROP units / external gates).
