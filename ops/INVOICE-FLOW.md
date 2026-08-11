# Nexora — Invoice Flow (operational)

Scope: how invoices are created, numbered, typed, validated, and reconciled. Billing amounts come from `ops/billing-source-of-truth.json` (frozen). VAT is **UNDETERMINED** — the schema supports tax fields but the template makes no tax determination.

## 1. Invoice data structure

Every Nexora invoice supports these fields (machine-readable template: `ops/templates/invoice.example.json`):

| Field | Notes |
|---|---|
| invoice_number | `NX-INV-YYYY-NNNN` (see numbering) |
| issue_date | Date issued |
| due_date | Issue date + project_invoice_due_days (7), or agreed milestone term |
| client_legal_name | Legal / business name on the commercial agreement |
| client_billing_details | Billing address, email, any purchase-order reference |
| service_reference | What was delivered / is being delivered |
| proposal_reference | Proposal that controls the final amount |
| agreement_reference | Commercial agreement (where applicable) |
| line_items | Description, quantity where appropriate, unit/fixed price |
| subtotal | Sum of line items |
| tax_status | Supported, **not determined** (VAT gate) |
| total_due | Subtotal + any tax |
| currency | GBP |
| payment_method | Instructions / link (see Payment Operations) |
| payment_status | DRAFT / ISSUED / DUE / PAID / OVERDUE / VOID / REFUNDED or CREDITED |
| notes | Free text |

## 2. Invoice numbering

- Pattern: **`NX-INV-YYYY-NNNN`** — e.g. `NX-INV-2026-0001`.
- Requirement: uniqueness, chronological traceability, no accidental duplicates.
- If accounting software later controls numbering, **that system becomes authoritative** — do not run a competing numbering sequence.

## 3. Invoice types

| Type | When used |
|---|---|
| Project / implementation invoice | Web, Brand, AI implementation, Complete project work |
| Milestone invoice | Each approved milestone tranche (from the approved final price) |
| Recurring service invoice | AI monthly service after Go-Live |
| Care invoice | Care monthly (separately identifiable, never bundled) |
| Change request invoice | Per the CR billing policy |
| Credit note / adjustment | Refunds and corrections — never silently edit a paid historical invoice |

## 4. Milestone invoicing

- Milestone amounts are calculated from the **APPROVED FINAL PROJECT PRICE** (the Commercial Schedule / proposal), **never** from the public "From" price on the website when a higher final price is agreed.
- Example (B2 approved at £4,250): 40% £1,700 / 30% £1,275 / 30% £1,275 — but if the final proposal agreed £5,100, milestones are 40/30/30 **of £5,100**.
- B3 has **no standard percentage schedule** — a bespoke schedule is defined per proposal and recorded before invoicing.

## 5. Commercial schedule → invoice handoff (validation gate)

**Never invoice directly from public website pricing where a proposal controls the final amount.** Before creating any invoice, verify it matches the frozen/approved record on **all** of:

- [ ] Client (legal/business name matches)
- [ ] Selected service / package
- [ ] Final approved price (from proposal, not the public "From" price)
- [ ] Milestone / tranche
- [ ] Implementation fee (if any)
- [ ] Recurring fee and billing start (AI: **Go-Live**, never before)
- [ ] Care (if purchased) — separately identifiable
- [ ] Add-ons
- [ ] Approved change requests (documented)

## 6. Payment status model

`DRAFT → ISSUED → DUE → PAID` (with `OVERDUE`, `VOID`, `REFUNDED`/`CREDITED` as applicable).

- **PAID** requires verified provider status **or** confirmed manual reconciliation for bank transfer — never solely "the client said it was sent".

## 7. Agreement gate

Proposal-led work keeps the chain:

**PROPOSAL → AGREEMENT → INVOICE → PAYMENT.**

- Proposal acceptance alone does not automatically satisfy all contractual requirements.
- If agreement tooling is not operational, that is a separate **Legal/Contract operational gate** — do not fabricate e-sign capability.

## 8. Recurring billing start (AI)

Operational trigger, with a **recorded Go-Live date** (never memory/informal chat):

1. AI implementation complete
2. **Go-Live approved / recorded** (date captured)
3. Recurring billing start date created
4. First recurring invoice / subscription activated

Track per recurring client: client, service, package, monthly amount, billing start date, next billing date, payment method, status, Care if applicable, paused/cancelled status. Record template: `ops/templates/recurring-billing-record.json`.
