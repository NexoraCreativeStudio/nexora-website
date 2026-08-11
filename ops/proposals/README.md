# Nexora — Proposal System (core)

The governed Client Proposal System used **before** agreement/invoicing. This is PROP.1: the
version-controlled core foundation (schema + package mapping + validator + one safe example).

Lifecycle this supports:

```
LEAD / CLIENT REQUIREMENTS
→ PACKAGE / SCOPE SELECTION
→ PROPOSAL
→ CLIENT APPROVAL
→ AGREEMENT / CONTRACT
→ INVOICE
→ PAYMENT
→ DELIVERY
```

## Purpose

One governed Proposal architecture capable of producing the correct proposal for every Nexora
offering — **not** 12 independently maintained documents with duplicated prices and rules.
Shared commercial/legal structure is single-sourced; package-specific content is modular.

## Authoritative sources

| Source | Role |
|---|---|
| `docs/constitution/COMMERCIAL-CONSTITUTION.md` | Governance authority (freeze scope, change control, Proposal architecture protected) |
| `ops/billing-source-of-truth.json` | **Authoritative pricing / schedule / terms source** — never duplicated here |
| `ops/proposals/package-mapping.json` | Maps Proposal offering identifiers → `source_ref` paths into the billing JSON. **Contains no prices.** |
| `ops/proposals/proposal.schema.json` | Machine-readable Proposal/Commercial Schedule data model (JSON Schema draft-07) |
| `ops/proposals/validate-proposals.mjs` | Enforces the schema subset + resolves the mapping against the billing JSON |
| `ops/INVOICE-FLOW.md`, `ops/PAYMENT-OPERATIONS.md`, `ops/templates/operational-checklist.md` | Invoice/payment/operational rules this system feeds into |

## Proposal vs pricing Source of Truth

The Proposal System is a **consumer**, never a redefiner. It resolves reference prices, setup
fees, recurring fees, and milestone schedules from `ops/billing-source-of-truth.json` at
validation time. There is **no third pricing database**: `package-mapping.json` holds references
(`source_ref`), not figures.

## Reference price vs Approved Final Project Price

- **REFERENCE / PUBLIC PACKAGE PRICE** — the public "From" or fixed price, resolved from the
  billing JSON. It is a starting point, **not** the contractual price.
- **APPROVED FINAL PROJECT PRICE** — client-specific, approved, and recorded. Per governance
  (`ops/INVOICE-FLOW.md` §5), **invoices derive from this approved price, never the public
  "From" price**. For From/bespoke/scoped offerings (A3, B3, C3, Complete) the approved final
  price may legitimately differ from the public reference; the validator never forces equality.

## Bespoke / scoped offerings

- **Complete** is bespoke/scoped with **no** mechanical public price — `reference_price` must be
  absent. Its governed schedule `30/30/30/10` (first 30% part of the total) still validates.
- **B3** has a **recorded per-proposal** milestone schedule (sums to 100%) — never invented
  standard percentages.
- Do not make bespoke values appear deterministic when they are not.

## Private client data rule

The repository may be public. **Real client proposal instances must never be committed.**

- **Version-controlled (committed):** schema, mapping, validator, this README, and the safe
  synthetic example under `examples/` (marked `"_example": true`).
- **Private (git-ignored):** `ops/proposals/private/` — real client names, emails, phones,
  addresses, negotiated/approved prices, signatures, accepted/signed proposals, project details.
- Generated output (HTML/PDF) goes to `ops/proposals/out/` — git-ignored.

`.gitignore` adds both paths. Every committed proposal fixture MUST carry `"_example": true` so
the validator can refuse unmarked fixtures (a real client proposal dropped into `examples/` by
mistake fails validation).

## Creating a Proposal instance later

1. Copy `examples/sample-proposal.json` into `ops/proposals/private/` (never commit it).
2. Set `proposal_id` (`PRP-YYYY-NNNN`), `version` (`1.0`), `status`, `issue_date`,
   `valid_until` (issue + 30 days), client/project/offering fields.
3. Set `commercial_schedule` — reference data resolves from the billing JSON; only
   client-specific values (scope, timeline, **approved_final_project_price**) are entered.
4. Validate, then generate the client-facing HTML:
   `node ops/proposals/validate-proposals.mjs` and
   `node ops/proposals/generate-proposal.mjs ops/proposals/private/<file>.json`.

## How validation works

`node ops/proposals/validate-proposals.mjs [extra files…]`

- Always validates `package-mapping.json` against `ops/billing-source-of-truth.json`:
  offering count (9 core + 3 additional = 12), no legacy `Starter`/`Elite` codes, every
  `source_ref` resolves, names match, Care sub-plans exist.
- Validates every `.json` in `examples/` (plus any files passed) for: malformed JSON, missing
  metadata, proposal/version/status format, validity window, offering identity, **stale
  reference prices and setup fees**, frozen/recorded payment schedules, **approved final project
  price presence**, recurring-fee semantics, Care relationship, warranty (only the governed
  90-day Web Launch Warranty), **VAT UNDETERMINED only**, and the **obsolete £250 deposit /
  Starter-Elite** sweep. Real private instances are never validated here.

## Template layer (PROP.2)

The reusable client-facing template binds validated PROP.1 data to a print-ready document:

| File | Role |
|---|---|
| `template/proposal-template.html` | Reusable Proposal HTML template (11 sections) with data-binding tokens |
| `template/proposal.css` | Print-ready visual system (A4 `@page`, page-break rules, responsive, Nexora brand tokens) |
| `preview-proposal.mjs` | **Safe preview mechanism** — renders a validated fixture for visual QA. NOT the full generator. |
| `validate-proposal-template.mjs` | Template-layer validation (no hard-coded prices, no legacy/£250/VAT claims, no real client data, hooks present, render smoke test) |

**Data binding.** Every template token maps to the PROP.1 schema via a presentation view model
(`preview-proposal.mjs` → `buildViewModel`). Token syntax:

- `{{path}}` — value (HTML-escaped)
- `{{#if path}} … {{/if}}` / `{{#unless path}}` — conditionals (empty arrays are falsy)
- `{{#each path}} … {{/each}}` — arrays; `{{.}}` = item, `{{@index}}` = 1-based number

Only **presentation-derived** values are computed (money formatting, milestone amounts from the
approved final price, recurring/Care display text, Go-Live start phrasing). No price is
hard-coded anywhere in the template. The template contains **no** legal contract clauses;
client-facing legal references stay neutral ("subject to the applicable Nexora Agreement").

**Preview:** `node ops/proposals/preview-proposal.mjs [fixture.json]` writes
`ops/proposals/out/proposal-preview.html` (git-ignored, never committed).

**Conditional display:** reference price, setup fee, milestone table, recurring fees, Care, and
warranty sections render only when the validated data requires them. AI offerings never show an
invented reference price; Complete never shows a mechanical public price; recurring billing is
presented as starting **at Go-Live**; Care is presented as monthly-in-advance and separate.

**Template validation:** `node ops/proposals/validate-proposal-template.mjs`

## Generator (PROP.3)

The full Proposal Generator turns a validated Proposal JSON instance into a
client-facing HTML Proposal document through the PROP.2 template. It is a
**pure renderer**: generation never changes proposal state and never touches
the Source of Truth.

**Flow:** validated proposal JSON → fail-closed PROP.1 validation (shared core)
→ commercial resolution against `ops/billing-source-of-truth.json` → deterministic
milestone amounts from the Approved Final Project Price → PROP.2 template → self-contained
HTML → `ops/proposals/out/`.

**CLI:**

```
node ops/proposals/generate-proposal.mjs <proposal.json> [--output <path>] [--overwrite] [--check]
node ops/proposals/generate-proposal.mjs --example
```

- `--output <path>` — write to a chosen path (default `ops/proposals/out/{proposal_id}-v{version}.html`, sanitised).
- `--overwrite` — allow replacing an existing output for the same `proposal_id` + `version`. Without it the generator **refuses** to silently overwrite (accepted-proposal immutability enforcement is PROP.4; generation never destroys history accidentally).
- `--check` — validate only, no render (exit 0 = generation-safe).
- `--example` — render the synthetic B2 example.

**Input safety.** Real Proposal instances live in `ops/proposals/private/` (gitignored)
and may be generated from there (no `_example` marker required). Committed fixtures
under `ops/proposals/examples/` must carry `"_example": true`. Any other input path
is **refused** — the generator will not render arbitrary tracked data.

**Validation before generation (fail closed).** The generator runs the same shared
PROP.1 validation core as the CLI validator (structure, offering identity,
commercial references vs the billing JSON, payment schedule, setup fee, recurring
semantics, Care, Warranty, validity, VAT UNDETERMINED, no legacy/£250 language).
An invalid Proposal is never rendered.

**Commercial resolution.** All authoritative figures resolve from
`ops/billing-source-of-truth.json` at validation time. The generator contains no
prices and cannot mutate the Source of Truth.

**Approved Final Project Price.** Milestone amounts are computed from the
Approved Final Project Price, never the public/reference "From" price. Non-final
tranches are rounded to whole pounds (half up); the final tranche absorbs any
rounding residual so the displayed total equals the Approved Final Project Price
exactly. Labels stay neutral ("Tranche 1..n") — no invented due dates.

**Bespoke.** Complete never shows a mechanical public price and uses the governed
30/30/30/10 schedule. B3 uses a recorded per-proposal schedule (sums to 100%).
C3/A3 approved final prices may legitimately differ from their From reference.

**AI recurring.** A1/A2/A3 (and Complete with AI) always present the one-time
implementation fee separately from the monthly fee, and recurring billing is
worded as starting **at Go-Live** — never at acceptance, signature, invoice or project start.

**Care & warranty.** Care is monthly, paid in advance, and rendered separately
from the project amount. The only warranty rendered is the governed 90-day Web
Launch Warranty.

**VAT.** Client-facing output makes no VAT determination — the neutral tax note
from PROP.2 is used.

**Agreement boundary.** The generated document is a Proposal, not a contract:
"Subject to the applicable Nexora Agreement." No legal clauses (liability,
termination, IP, governing law, indemnity, refund, privacy/DPA, cancellation) are
generated.

**Output & PDF path.** Output is a fully self-contained HTML file
(`ops/proposals/out/`, gitignored) suitable for browser review, email/link handoff,
and print-to-PDF. PDF is produced by the browser: **HTML → Print → Save as PDF**.
No external PDF engine or SaaS is required.

**Generator validation:** `node ops/proposals/validate-proposal-generator.mjs`
(static safety, fixture renders, no leftover tokens, rounding determinism,
overwrite protection, and 12 negative tests proving generation fails closed).

## Proposal lifecycle (PROP.4)

Governed lifecycle + auditability around a Proposal **after** it has been
generated: `DRAFT → ISSUED → ACCEPTED / DECLINED / EXPIRED / SUPERSEDED`, plus
a controlled machine-readable handoff from an ACCEPTED Proposal toward the future
Agreement stage. This is governance, versioning and auditability — **not** an
e-signature implementation, **not** the Agreement generator, **not** invoicing,
and **not** payment processing.

### Lifecycle states (canonical)

Reuses the PROP.1 status model, extended with one new state (`DECLINED`). No
competing concepts:

| Canonical status | Meaning |
|---|---|
| `DRAFT` | Being authored; content may change freely |
| `INTERNAL_APPROVED` | Internally approved, not yet issued |
| `SENT` | Issued to the client (the task's "ISSUED") |
| `CLIENT_ACCEPTED` | Accepted by the client — **commercial snapshot frozen, immutable** |
| `DECLINED` | Client declined — terminal |
| `EXPIRED` | Validity window passed — terminal |
| `SUPERSEDED` | Replaced by a newer version — terminal |

### Valid transitions

Explicit, forward-only, fail-closed. No arbitrary backwards transitions. Terminal
statuses (`CLIENT_ACCEPTED`, `DECLINED`, `EXPIRED`, `SUPERSEDED`) have **no**
outgoing transitions.

```
DRAFT              -> INTERNAL_APPROVED | SENT
INTERNAL_APPROVED  -> SENT
SENT               -> CLIENT_ACCEPTED | DECLINED | EXPIRED | SUPERSEDED
```

### Issue workflow

`node ops/proposals/proposal-lifecycle.mjs issue <proposal.json>` moves a
`DRAFT`/`INTERNAL_APPROVED` Proposal to `SENT`. The Proposal is fully re-validated
through the shared PROP.1 core first (any legacy/VAT/drift content blocks the
operation). `issue_date` / `valid_until` are authored at creation; `issue` is the
controlled publication gate and never changes dates.

### Expiry

`valid_until = issue_date + 30 days` (frozen `proposal_validity_days`), preserved
from PROP.1. A Proposal is **expired** when the acceptance date `> valid_until`
(`valid_until` is inclusive). Acceptance of an expired Proposal is **refused** —
no grace periods. `expire <proposal.json> [--as-of YYYY-MM-DD]` marks an expired
`SENT` Proposal `EXPIRED` deterministically and cannot be forced early. Proposal
validity (30 days) is **not** the invoice due date (7 calendar days).

### Acceptance record

`accept <proposal.json> --by "<name>" [--method <m>] [--date YYYY-MM-DD]` moves a
valid, unexpired `SENT` Proposal to `CLIENT_ACCEPTED` and writes a machine-readable
acceptance record to `ops/proposals/private/acceptance/{id}-v{version}.acceptance.json`
(gitignored). The record captures only governance-safe metadata:

- `proposal_id`, `version`
- `accepted_at`, `accepted_by_name`, `acceptance_method`
- `content_sha256` (canonical SHA-256 fingerprint of the accepted content)
- `canonical_format`, `recorded_at`

**Acceptance record ≠ e-signature.** No signature-provider IDs, legal identity
verification, IP-address proof, certificate IDs, or enforceability claims are
recorded. `provider` stays null (`E-SIGNATURE PROVIDER — OWNER DECISION REQUIRED`).

### Fingerprinting

`verify <proposal.json> [--record <path>]` proves **which version was accepted**:

- **What is hashed:** the full governed Proposal content, excluding only the
  fixture markers (`_example`, `_comment`). Status and acceptance metadata ARE
  included, so the fingerprint captures the exact accepted state.
- **Canonicalisation:** keys sorted recursively, compact JSON (UTF-8). Whitespace
  and key order are normalised, so a cosmetic re-format does **not** change the
  fingerprint — any change to governed content does.
- **When:** computed at the moment of acceptance (after the `CLIENT_ACCEPTED`
  transition) and stored in the acceptance record.
- **How verification works:** `verify` re-canonicalises the current file and
  compares to the recorded fingerprint. A modified accepted Proposal **fails
  verification** and is refused everywhere (verify, handoff).

### Accepted immutability

Once `CLIENT_ACCEPTED`, the commercial snapshot is immutable: `proposal_id`,
`version`, client identity, offering, scope, timeline, Approved Final Project
Price, reference snapshot, setup/implementation fee, payment schedule, recurring
fees, Care, Warranty, VAT, issue/valid-until dates and acceptance metadata. There
are **no outgoing transitions** and the fingerprint detects any silent edit. If
commercial terms must change after acceptance, **create a new Proposal version** —
never mutate the accepted historical version.

### Versioning & supersession

- `proposal_id` = stable lineage; `version` = document version (`x.y`).
- A revised Proposal is a **new version**, optionally carrying
  `supersedes: { proposal_id, version, reason }` pointing to the version it
  replaces (a superseding version must be **higher**).
- `supersede <proposal.json> --by <new_id> --version <x.y> [--reason "<r>"]` moves
  an issued-but-unaccepted (`SENT`) Proposal to `SUPERSEDED` and records
  `superseded_by`.
- Accepted Proposals are never re-labelled: a post-acceptance revision is a new
  version whose `supersedes` reference links the lineage, while the accepted
  historical version stays `CLIENT_ACCEPTED` (immutable). No silent replacement —
  acceptance records and handoffs refuse overwrite without `--overwrite`.

### Agreement handoff

`handoff <proposal.json> [--record <path>] [--output <path>]` emits a
machine-readable handoff artifact to
`ops/proposals/private/handoffs/{id}-v{version}.handoff.json` (gitignored) —
**only from an ACCEPTED Proposal whose fingerprint still verifies**. It carries
proposal identity/version, client/project identity, offering, the accepted
commercial snapshot (Approved Final Project Price, payment schedule, recurring
components, Care, Warranty, VAT), and the acceptance record + fingerprint.

**Agreement handoff ≠ Agreement.** The handoff is not a contract, contains no
invented legal clauses, and does not generate an Agreement. It is a trustworthy
input for future PROP work — the accepted Proposal snapshot is the commercial
basis for the future Agreement.

### Private-data workflow

- Real proposals, acceptance records and handoffs live under
  `ops/proposals/private/` (gitignored) — never committed.
- Committed fixtures live in `ops/proposals/examples/lifecycle/` and **must** carry
  `"_example": true` (enforced). Only synthetic data (`@example.com` contacts,
  fictional client names) is committed.
- Generated Proposal HTML stays in `ops/proposals/out/` (gitignored).

### CLI usage

```
node ops/proposals/proposal-lifecycle.mjs issue     <proposal.json>
node ops/proposals/proposal-lifecycle.mjs accept    <proposal.json> --by "<name>" [--method <m>] [--date YYYY-MM-DD] [--record <path>]
node ops/proposals/proposal-lifecycle.mjs decline   <proposal.json>
node ops/proposals/proposal-lifecycle.mjs expire    <proposal.json> [--as-of YYYY-MM-DD]
node ops/proposals/proposal-lifecycle.mjs supersede <proposal.json> --by <proposal_id> --version <x.y> [--reason "<r>"]
node ops/proposals/proposal-lifecycle.mjs verify    <proposal.json> [--record <path>]
node ops/proposals/proposal-lifecycle.mjs handoff   <proposal.json> [--record <path>] [--output <path>]
```

Input safety mirrors the generator: real proposals from `private/` (no marker
needed), synthetic fixtures from `examples/` (`_example: true`), any other path
refused. Every operation re-validates through the shared PROP.1 core.

**Lifecycle validation:** `node ops/proposals/validate-proposal-lifecycle.mjs`
(static safety, transition model, fingerprint determinism, positive flows, and
negative tests that must fail closed — invalid transitions, expired/declined
acceptance, tampering, accepted-version overwrite, handoff from non-accepted
states, legacy Starter/£250, unsupported VAT, commercial Source-of-Truth drift).

**What PROP.4 does NOT implement:** Proposal acceptance record ≠ e-signature;
Agreement handoff ≠ Agreement; Accepted Proposal ≠ invoice; **no payment is
collected by PROP.4.** E-signature, the Agreement generator, invoicing and
payment processing remain separate (later PROP units / external gates).

## What this Proposal System does NOT yet implement

This is **not yet**:

- an Agreement / contract generator
- an e-signature system
- an invoicing engine
- payment collection
- automated PDF rendering (output is print-ready; PDF is produced by the browser
  via Print → Save as PDF)

Those remain separate (later PROP units / external gates). Acceptance/signature is represented
only as a provider-neutral placeholder (`acceptance` block) — **E-SIGNATURE PROVIDER — OWNER
DECISION REQUIRED**. VAT remains UNDETERMINED (external accounting gate). No legal contract
clauses (termination, liability, IP, governing law, privacy/DPA, cancellation/refund) are placed
in the Proposal — they belong to the separate executed Agreement (Legal/Contract gate).
