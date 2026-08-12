# Nexora — Governed Payment Collection & Reconciliation (PROP.9)

The governed payment layer that connects a governed **ISSUED Invoice** (PROP.8) to
a governed payment-request, provider-abstraction, webhook, idempotency, and
reconciliation machinery — **without ever collecting payment, calling a provider,
deploying a webhook, or marking PAID without reconciled evidence.**

```
ISSUED Invoice (PROP.8)
      │
      ▼
Payment Request (amount from invoice)
      │
      ▼
Payment Record (CREATED)
      │
      ▼
Record Event (normalised webhook/provider evidence; NOT payment)
      │
      ▼
Reconcile (adapter outcome + governed rules)
      │
      ▼
Payment Status (only PAID on governed EXACT/PARTIAL/REFUND outcome)
```

## What PROP.9 does

- **Input boundary (fails closed):** payment requests come **only** from a governed
  **ISSUED** invoice record (schema, status, id, fingerprint must match).
  DRAFT/READY_TO_ISSUE invoices, VOID/CANCELLED invoices, and any
  non-payment-layer input are refused. Unsafe input/output paths are refused.
- **Payment Request** — governed record with `amount_requested` equal to the
  invoice `total` (no override), provider/environment, purpose, milestone/recurring/care
  linkage, and fingerprint.
- **Payment Record** — controlled status machine: **CREATED → PENDING → PROCESSING →
  PARTIALLY_PAID → PAID** (and FAILED, CANCELLED, REFUNDED, PARTIALLY_REFUNDED, DISPUTED).
  **PAID is only reachable via governed reconciliation** — there is **no** `mark-paid`,
  **no** `--force-paid`, **no** `--fake-paid`, **no** `--assume-paid` anywhere.
- **Record Event** — normalises a provider/webhook event into a governed internal
  webhook record. **WEBHOOK RECEIVED != PAID**. Evidence accumulates; status advances
  to `PROCESSING`; reconciliation is required before `PAID`.
- **Provider Abstraction** — provider-neutral adapter interface with:
  - `normalizePaymentEvidence` — normalises provider event to governed webhook record
  - `reconcilePayment` — returns governed reconciliation outcome
  - **TEST_ADAPTER** built-in: deterministic, no network, no secrets, labelled
    `_test_only: true`, never accepted as Production evidence.
- **Reconciliation** — governed outcome from adapter + invoice + request context.
  Outcomes: `EXACT`, `PARTIAL`, `OVERPAYMENT`, `DUPLICATE_EVIDENCE`,
  `WRONG_CURRENCY`, `WRONG_INVOICE`, `WRONG_AMOUNT`, `UNKNOWN_PROVIDER_REF`,
  `VOID_INVOICE`, `REFUND`, `PARTIAL_REFUND`, `DISPUTE`, `PENDING`, `UNVERIFIED`.
  Only `EXACT` and `PARTIAL` (cumulative) can settle to `PAID`. `OVERPAYMENT`
  **never silently classified as PAID** — flagged for review.
- **Refund Record** — records a provider-backed refund linked to the original payment.
  Only allowed on `PAID` payments. Produces `REFUND` or `PARTIAL_REFUND` outcome.
- **Verify / Status** — inspection commands that validate fingerprints and
  display governed state. Status explicitly notes: **PAID requires governed
  reconciled payment evidence — this is a status inspection only.**
- **Fingerprints:** deterministic SHA-256 over commercial terms + provenance +
  dates (excluding status/audit/_example). Any change fails the fingerprint.
  A fingerprint is an **integrity aid**, **not** a bank confirmation, digital
  signature, or proof of payment.
- **Privacy:** real payment records are written under gitignored
  `ops/payment/private/` and `ops/payment/out/`. Committed fixtures under
  `ops/payment/examples/` are synthetic only and must carry `"_example": true`.
- **Security:** no secrets, no live credentials, no provider account IDs.
  Fake Production evidence from TEST adapter is rejected.

## CLI

```
node ops/payment/payment.mjs request <invoice.json> --amount <n> --currency GBP [options]
node ops/payment/payment.mjs pay <request.json> [options]
node ops/payment/payment.mjs record-event <payment.json> --event <webhook.json> [options]
node ops/payment/payment.mjs reconcile <payment.json> <invoice.json> --event <webhook.json> [options]
node ops/payment/payment.mjs refund-record <payment.json> --refund <refund.json> [options]
node ops/payment/payment.mjs verify <file.json>
node ops/payment/payment.mjs status <payment.json>
```

Run `node ops/payment/payment.mjs` (no args) for full usage.

### Example (B2, governed pipeline)

```sh
# 1. payment request from an ISSUED invoice
node ops/payment/payment.mjs request \
  ops/billing/out/INV-2026-9898-001-v1.0.invoice.json \
  --amount 2040 --currency GBP \
  --provider TEST_ADAPTER --environment TEST \
  --output ops/payment/out

# 2. create a payment record from the request
node ops/payment/payment.mjs pay \
  ops/payment/out/REQ-2026-9898-001.payment-request.json \
  --output ops/payment/out

# 3. record a synthetic TEST_ADAPTER event (evidence, NOT payment)
node ops/payment/payment.mjs record-event \
  ops/payment/out/PAY-2026-9898-001.payment.json \
  --event ops/payment/examples/test-webhook-example.json \
  --output ops/payment/out

# 4. reconcile the payment against the invoice using the event
node ops/payment/payment.mjs reconcile \
  ops/payment/out/PAY-2026-9898-001.payment.json \
  ops/billing/out/INV-2026-9898-001-v1.0.invoice.json \
  --event ops/payment/examples/test-webhook-example.json \
  --provider TEST_ADAPTER --environment TEST \
  --output ops/payment/out
```

## Validation

```
node ops/payment/validate-payment.mjs
```

Runs static safety (modules present, Node built-ins only, no network/payment
SDK, no hard-coded prices, no payment-shortcut flags, gitignore, Source-of-Truth
consumption), positive QA for governed pipeline (request → pay → record-event
→ reconcile → status), fingerprint integrity, fail-closed negative tests,
privacy sweep, and cleanup. All fixtures are synthetic and live under
gitignored locations.

## Governance boundaries

PROP.9 must **never** collect payment, call a payment provider API, create
Payment Intents / Checkout Sessions / Payment Links, deploy webhooks, activate
Production payment collection, use live keys, or mark an invoice PAID without
reconciled evidence. Do **not** fake `PAID`; do **not** merge the branch; do
**not** deploy Production; do **not** commit real client data; do **not** expose
secrets; do **not** alter the Source of Truth or change commercial schedules.

PAYMENT REQUEST ≠ PAID · CHECKOUT SESSION ≠ PAID · WEBHOOK RECEIVED ≠ PAID ·
INVOICE ISSUED ≠ PAID · AGREEMENT EXECUTED ≠ PAID.