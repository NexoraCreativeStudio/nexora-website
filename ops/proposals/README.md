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
4. Run validation: `node ops/proposals/validate-proposals.mjs`.

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

## What this Proposal System does NOT yet implement

This is **not yet**:

- a full proposal generator (PROP.3 — `preview-proposal.mjs` is the safe preview mechanism only)
- a PDF generator (the template is print-ready; browser/print PDF output is a later step)
- an Agreement / contract generator
- an e-signature system
- an invoicing engine

Those remain separate (later PROP units / external gates). Acceptance/signature is represented
only as a provider-neutral placeholder (`acceptance` block) — **E-SIGNATURE PROVIDER — OWNER
DECISION REQUIRED**. VAT remains UNDETERMINED (external accounting gate). No legal contract
clauses (termination, liability, IP, governing law, privacy/DPA, cancellation/refund) are placed
in the Proposal — they belong to the separate executed Agreement (Legal/Contract gate).
