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

## What this Proposal System does NOT yet implement

This is **not yet**:

- an Agreement / contract generator
- an e-signature system
- an invoicing engine
- automated PDF rendering (output is print-ready; PDF is produced by the browser
  via Print → Save as PDF)

Those remain separate (later PROP units / external gates). Acceptance/signature is represented
only as a provider-neutral placeholder (`acceptance` block) — **E-SIGNATURE PROVIDER — OWNER
DECISION REQUIRED**. VAT remains UNDETERMINED (external accounting gate). No legal contract
clauses (termination, liability, IP, governing law, privacy/DPA, cancellation/refund) are placed
in the Proposal — they belong to the separate executed Agreement (Legal/Contract gate).
