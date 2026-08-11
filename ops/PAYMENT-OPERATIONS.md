# Nexora — Payment Operations (master)

Operational guidance for the commercial payment flow:

**PROPOSAL → AGREEMENT → INVOICE → PAYMENT → DELIVERY / IMPLEMENTATION → GO-LIVE → RECURRING BILLING → RECONCILIATION.**

Billing amounts and schedules: `ops/BILLING-SOURCE-OF-TRUTH.md` (machine-readable: `billing-source-of-truth.json`). Invoice mechanics: `ops/INVOICE-FLOW.md`. This file is the master document.

## 1. Current payment tooling

**No payment provider is operationally configured as of 2026-08-11.** The repository contains no Stripe/PayPal integration, no webhooks, no environment configuration, and no payment JS. The historical Stripe/PayPal items were website deposit links for the obsolete £250 flow, already removed from the live website. Do not assume a payment system exists because the website mentions payments — the website copy is marketing, not operational tooling.

## 2. Payment methods — practical separation

| Method | Operational now? | Notes |
|---|---|---|
| Bank transfer | Yes (manual reconciliation) | Always available for a UK business; confirm banking details are Owner-confirmed before sending to clients |
| Card payment / Checkout | No — requires provider activation | Activation is an Owner action (Stripe/KYC, account) |
| Recurring card / automated billing | No — requires provider activation | For AI monthly + Care monthly after Go-Live |
| Payment link | No — requires provider activation | Can be a low-friction method once active |

Do not claim a method is operational until technically verified. Do not invent payment credentials.

## 3. Provider architecture (safe scaffold)

The safe, non-secret integration architecture is documented in `ops/payment-integration/README.md`, with env-var placeholders in `.env.example` and a reference (non-executed, test-mode) example in `stripe-example.js`.

- No secret keys in the repository. `.env` is git-ignored.
- Production activation (live keys, KYC, settlement bank, tax settings) is an **Owner action**.
- The website itself hosts **no** payment logic; it links out to provider-hosted flows.

## 4. Failed-payment flow

1. **Payment failure** occurs (provider reject, failed direct debit, unpaid invoice past due).
2. **Automated provider retry** where configured (do not configure aggressive retry loops without provider guidance).
3. **Client notification** — calm, factual (template: `ops/templates/client-messages.md`).
4. **Manual follow-up** if unresolved.
5. **Service review / pause** according to the agreement and legal terms.

Do not invent aggressive suspension timing. Legal enforcement/suspension remains subject to the commercial agreement. No threatening automated copy.

## 5. Payment confirmation

- **Provider/card payments:** use verified provider status (webhook/dashboard) as confirmation.
- **Bank transfer:** manual reconciliation is required.
- **Never** mark an invoice PAID solely because the client says payment was sent.

## 6. Reconciliation

Lightweight process linking: **INVOICE ↔ PAYMENT ↔ CLIENT ↔ PROJECT / SERVICE ↔ ACCOUNTING RECORD.**

- No orphan payments.
- No paid invoices left open.
- No duplicate invoice collection.

Recommended weekly check: every invoice has a status; every received payment maps to an invoice; the accounting record matches.

## 7. Refunds / credit notes

- Do **not** invent refund entitlement — rights are governed by the agreement, law, and approved commercial decisions.
- Operationally support: refund record / credit-note record with reason, amount, and original invoice reference.
- **Never** silently edit a paid historical invoice to erase financial history.

## 8. Third-party / pass-through costs

- Hosting, licences, provider fees, and third-party services must be identifiable per the frozen commercial arrangement.
- Do **not** silently absorb variable third-party costs into fixed Care fees.
- Do **not** add unapproved markups.

## 9. Care billing

- Monthly, paid in advance, **no indefinite rollover**.
- Care invoices are **separately identifiable** from project invoices and are never silently bundled into the project price.
- Activate Care billing only when Care is purchased.

## 10. Security & PCI

- Never commit, print, or expose secret keys, card numbers, CVV, or banking credentials.
- Never build custom card storage.
- Use **provider-hosted** payment flows (Stripe Checkout / Payment Links / hosted subscription pages).
- Nexora does **not** directly handle raw card data.
- Do **not** claim PCI compliance — compliance status requires external validation.

## 11. Tool boundary

- **Payment provider:** collects and confirms payments (hosted flows, subscriptions, webhooks).
- **Accounting/invoicing software:** numbering, ledger, VAT, credit notes (authoritative for numbering when active).
- **CRM / project operations:** client, proposal, agreement, milestones, Go-Live records.
- **Repository/document templates:** this `ops/` layer — rules, schemas, templates.
- Do **not** build accounting software inside the website.

## 12. Automation opportunities (future, safe to automate later)

- Proposal-to-invoice data transfer (once source of truth is agreed)
- Invoice generation from the commercial schedule
- Payment links
- Payment confirmation
- Go-Live recurring activation (once provider live)
- Failed-payment reminders
- Care recurring billing
- Reconciliation alerts

Do **not** automate a process whose source of truth is unresolved.

## 13. Operational checklist

Reusable per-client checklist: `ops/templates/operational-checklist.md`.
