# Nexora — Governed Invoice & Billing Engine (PROP.8)

The governed billing layer that turns an **EXECUTED** Agreement Execution
(PROP.7) + its **READY_FOR_EXECUTION** Agreement (PROP.5) into a billing
schedule, governed invoice records, Go-Live modelling and recurring-billing
readiness.

```
EXECUTED execution (PROP.7)  ─┐
                             ├─► PROP.8 billing schedule  ──►  governed invoice
READY_FOR_EXECUTION          │      (amounts, types, gates,     records (DRAFT →
Agreement (PROP.5)  ─────────┘       due dates, recurring)        READY_TO_ISSUE →
                                                                  ISSUED)
```

PROP.8 is **governance + record modelling only**. It does **not** collect
payment, does **not** call Stripe/PayPal/SumUp/any payment provider, does **not**
create Payment Intents / Checkout Sessions / Payment Links, does **not** send
invoices or emails externally, and does **not** modify the Production website or
the Commercial Source of Truth. **Invoice ≠ Payment · ISSUED ≠ PAID · EXECUTED ≠
PAID.**

## What PROP.8 does

- **Input boundary (fails closed):** invoices come **only** from a governed
  **EXECUTED** execution record plus the exact READY Agreement that was executed
  (schema, status, id/version and SHA-256 checksum must all match). PREPARED /
  SENT_FOR_SIGNATURE / PARTIALLY_SIGNED / DECLINED / CANCELLED / EXPIRED
  executions, DRAFT / READY Agreements, and any Proposal / Handoff input are all
  refused. Unsafe input/output paths are refused.
- **Billing schedule** derived deterministically from the Approved Final Project
  Price and the governed payment schedule:
  - Milestone amounts = Approved Final Project Price × governed percentage,
    rounded to the pound; the **final tranche absorbs the residual** so the
    milestone total equals the Approved Final Project Price **exactly**.
  - Only the governed schedules exist: B1 `[50,50]`, B2 `[40,30,30]`, B3
    (bespoke, sums to 100), C1 `[50,50]`, C2 `[40,30,30]`, C3
    `[40,30,20,10]`, Complete `[30,30,30,10]`. No invented schedules.
  - AI setup/implementation is a **separate one-time item** (never bundled into
    the monthly recurring, no deposit). Web Care + Brand & Creative Care are
    separate recurring items, monthly in advance.
- **Governed invoice records** with a controlled status machine: **DRAFT →
  READY_TO_ISSUE → ISSUED → (VOID | CANCELLED)**. **PAID / OVERDUE / REFUNDED /
  CREDITED are recognised but NOT reachable in PROP.8** — they require payment /
  reconciliation evidence from a future layer. There is **no** `mark-paid`,
  **no** `--force-paid`, and **no** `--fake-payment` anywhere.
- **Issuance gates:** the first project invoice / setup invoice requires
  **EXECUTED**. A later milestone requires **milestone trigger evidence**
  (`OWNER/OPERATIONS DECISION REQUIRED — MILESTONE INVOICE TRIGGER`). **AI
  recurring billing starts only at a recorded Go-Live** (explicit evidence
  record with schema, agreement_id, execution_id, occurred_at, recorded_at,
  evidence_ref) — **never** inferred from the execution date, proposal
  acceptance, project start or setup payment. Care recurring requires an
  explicit governed Care start (never silent activation).
- **Due date** = issue date + **7 calendar days** (project_invoice_due_days from
  the Source of Truth), distinct from the 30-day proposal validity. No invented
  late fees or penalties.
- **VAT stays UNDETERMINED** (`tax_status = UNDETERMINED`, `tax_amount = null`).
  No VAT or accounting assertion is ever made; the record carries
  `OWNER/ACCOUNTING DECISION REQUIRED`.
- **Immutability:** once a record is ISSUED its commercial contents are
  immutable. Corrections require **VOID / CANCEL + a new governed invoice**, never
  an edit; `--overwrite` is refused on issued invoices.
- **Fingerprints:** deterministic SHA-256 over the commercial terms + provenance
  + dates. Any change to the amount, Agreement linkage, Execution linkage, due
  date or line items fails the fingerprint. A fingerprint is an **integrity
  aid**, **not** an accounting signature.
- **Privacy:** real invoices / schedules / Go-Live records are written under
  gitignored `ops/billing/private/` and `ops/billing/out/`. Committed fixtures
  under `ops/billing/examples/` are synthetic only and must carry
  `"_example": true`.

## CLI

```
node ops/billing/billing.mjs schedule <agreement.json> <execution-record.json> [options]
node ops/billing/billing.mjs create <schedule.json> --item <index> [options]
node ops/billing/billing.mjs issue <invoice.json> [options]
node ops/billing/billing.mjs void <invoice.json> [options]
node ops/billing/billing.mjs cancel <invoice.json> [options]
node ops/billing/billing.mjs verify <schedule-or-invoice.json>
node ops/billing/billing.mjs list-due <dir> [--as-of <YYYY-MM-DD>]
node ops/billing/billing.mjs record-go-live --execution <record.json> --occurred-at <YYYY-MM-DD> --evidence-ref <ref>
node ops/billing/billing.mjs recurring-status <schedule.json> [--go-live <go-live.json>]
```

Run `node ops/billing/billing.mjs` (no args) for full usage.

### Example (B2, governed pipeline)

```sh
# 1. schedule from the EXECUTED execution + READY Agreement
node ops/billing/billing.mjs schedule \
  ops/agreements/examples/AGR-...-v1.0.json \
  ops/execution/out/EXE-...-EXECUTED-3.execution.json \
  --output ops/billing/out

# 2. create + issue the first milestone invoice (due = issue + 7 days)
node ops/billing/billing.mjs create \
  ops/billing/out/billing-schedule-...-v1.0.billing.json \
  --item 0 --issue --issue-date 2026-08-15 \
  --client-name 'Example Client' --client-company 'Example Clinic Ltd' \
  --project-title 'Grow Website — Example Clinic' \
  --output ops/billing/out
```

## Validation

```
node ops/billing/validate-billing.mjs
```

Runs static safety (modules present, Node built-ins only, no network/payment
SDK, no hard-coded prices, no payment-shortcut flags, gitignore, Source-of-Truth
consumption), positive QA for every offering (B1/B2/B3/C1/C2/C3/Complete
schedules with exact amounts + residual-to-last totals, governed invoices +
issuance + due date + VAT, AI setup + recurring Go-Live gate, Care
monthly-in-advance, fingerprints, immutability), **36 fail-closed negative
tests**, a privacy sweep, and cleanup. All fixtures are synthetic and live under
gitignored locations.

## Governance boundaries

PROP.8 must **never** collect payment, call a payment provider API, create
Payment Intents / Checkout Sessions / Payment Links, send invoices or emails
externally, modify the Production website, modify pricing, invent commercial
terms, invent VAT treatment, invent late fees, or create direct checkout. Do
**not** fake `PAID`; do **not** merge the branch; do **not** deploy Production;
do **not** commit real client data; do **not** expose secrets; do **not** alter
the Source of Truth or change commercial schedules.
