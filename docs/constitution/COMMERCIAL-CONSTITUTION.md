# Nexora — Commercial Constitution

**Status:** AUTHORITATIVE COMMERCIAL GOVERNANCE DOCUMENT — Phase 4
**Owner:** Nexora Creative Studio (owner-approved, commercially frozen)
**Last consolidated:** 2026-08-11

This is the single constitutional document for Nexora commercial governance. It defines **who governs**, **where the frozen rules live**, and **how they may be changed**. It is deliberately governance-focused: it does **not** re-implement the pricing data — the authoritative structured source holds the exact figures (see §3).

---

## 1. Purpose

Answer, unambiguously, one question for any future developer or agent:

> **"Where is the authoritative Nexora commercial rule?"**

Answer: **this Constitution** (governance authority) → **`ops/billing-source-of-truth.json`** (authoritative structured frozen facts) → **downstream consumers** (website, proposals, invoices, payment operations).

---

## 2. Authority chain

```
OWNER-APPROVED COMMERCIAL GOVERNANCE
  └── docs/constitution/COMMERCIAL-CONSTITUTION.md        (this document — governance + freeze)
        └── AUTHORITATIVE STRUCTURED SOURCE
              └── ops/billing-source-of-truth.json        (machine-readable frozen facts)
                    └── OPERATIONAL IMPLEMENTATION
                          └── ops/*.md, ops/templates/    (payment/invoice/Care operations)
                                └── CONSUMERS
                                      ├── Website public pricing   (index.html, /de/, web, brand)
                                      ├── Client Proposals + Commercial Schedule
                                      └── Invoices / billing / payment flows
```

The Proposal System, website, and invoice/billing flows **consume** frozen commercial rules; they never **redefine** them.

---

## 3. Authoritative sources

| Source | Role | Authority |
|---|---|---|
| `docs/constitution/COMMERCIAL-CONSTITUTION.md` | Governance: freeze scope, anti-drift, change control, gates | **Constitutional** |
| `ops/billing-source-of-truth.json` | Structured frozen facts: prices, schedules, Care, invoice terms, VAT status | **Authoritative structured source** |
| `ops/BILLING-SOURCE-OF-TRUTH.md` | Human-readable mirror of the JSON | Reference (JSON governs on conflict) |
| `ops/PAYMENT-OPERATIONS.md`, `ops/INVOICE-FLOW.md`, `ops/templates/` | Operational implementation | Reference |
| `ops/validate-ops.mjs`, `ops/validate-website.mjs` | Invariant + website-drift validation | Reference |
| `BASELINE.md` | Technical/build baseline for the generated homepage | Technical only — not a commercial source |
| `CLAUDE.md` | Agent instructions | Points to this Constitution; not a pricing database |

---

## 4. Scope of the commercial freeze

The following are **commercially frozen** and may only change through the change-control process in §6:

- **AI plans** — A1 (AI Reception), A2 (AI Growth), A3 (AI Scale): implementation fee + monthly fee, separate. **AI recurring billing starts at Go-Live** — never before. **AI support is included** within the relevant subscription. **No AI Care. No separate AI support invoice.**
- **Web packages** — B1/B2/B3 (Launch/Grow/Scale). **B3 is bespoke** — no standard percentage schedule may be invented.
- **Brand packages** — C1/C2/C3 (Foundation/System/Signature).
- **Nexora Complete** — integrated Brand + Web + AI engagement. **Not** mechanical A+B+C public pricing, **not** automatically discounted. Payment **30/30/30/10 = 100%**; the **first 30% is part of the total**, never an additional deposit. AI implementation remains commercially identifiable where applicable. AI recurring starts at Go-Live. Care remains optional.
- **Care** — Web Care Essential/Plus, Brand & Creative Care Standard/Extended. **Optional, monthly, paid in advance, no indefinite rollover.** Care is separately identifiable from project invoices; never bundled into the project price.
- **Milestone schedules** — 50/50, 40/30/30, 40/30/20/10, Complete 30/30/30/10. Milestone amounts derive from the **approved final project price** (Commercial Schedule), never the public "From" price.
- **Invoice terms** — project invoice due **7 calendar days**; proposal validity **30 days** (distinct concepts).
- **Change requests** — immaterial (next invoice after written confirmation) / material (paid in advance) / large (separate proposal or project).
- **Warranty** — **90-day Web Launch Warranty** for qualifying Nexora delivery defects. Not unlimited maintenance, not Web Care, not new features/pages/integrations/redesign. Qualifying warranty work does **not** consume Web Care capacity.

Exact figures and schedules: **`ops/billing-source-of-truth.json`** (authoritative). The governance summary in `ops/BILLING-SOURCE-OF-TRUTH.md` mirrors it. If any copy disagrees, the JSON governs.

---

## 5. Anti-drift rule

**DOWNSTREAM IMPLEMENTATION DOES NOT OVERRIDE THE AUTHORITATIVE COMMERCIAL SOURCE.**

If the website, a proposal, billing, an invoice, SEO copy, conversion copy, or documentation conflicts with the authoritative frozen source (`ops/billing-source-of-truth.json`):

- the downstream implementation is **presumed wrong** until an approved commercial change modifies the authoritative source.

---

## 6. Change control

A frozen commercial rule **cannot** be changed by:

- SEO or conversion optimisation
- copywriting
- developer preference
- AI/model suggestion
- routine refactor
- payment-provider setup
- accounting-tool setup

Commercial changes require the full sequence:

1. **CHANGE PROPOSAL**
2. **IMPACT REVIEW**
3. **OWNER APPROVAL**
4. **AUTHORITATIVE SOURCE UPDATE** (`ops/billing-source-of-truth.json` + this Constitution's freeze scope)
5. **VALIDATION** (run all validators)
6. **FEATURE BRANCH**
7. **PR**
8. **MERGE**
9. **DOWNSTREAM IMPLEMENTATION** (website / proposals / billing)

---

## 7. Phase 5 boundary

**PHASE 5 — GROWTH, SEO & CONVERSION OPTIMISATION** may improve:

- SEO, Core Web Vitals, performance
- content clarity, CTA wording, mobile conversion
- FAQ, Schema.org, Open Graph, internal linking
- trust presentation, analytics/conversion measurement

It **may not** silently change: pricing, packages, Care, Complete, billing, milestones, AI support, Go-Live billing, Proposal architecture, or the commercial hierarchy (§4).

---

## 8. Trust claims

Future conversion work must not invent trust claims. Claims such as "UK Ltd", "Stripe", "PayPal", "response within one UK business day", security, compliance, or guarantees must be **evidence-backed** and **operationally validated** where applicable. No fabricated compliance claims (including PCI).

---

## 9. Deprecated: the £250 flow

**THE OLD GENERIC £250 DEPOSIT / CHECKOUT FLOW IS OBSOLETE.**

It must not return through the website, CTAs, FAQ, SEO, conversion optimisation, payment implementation, or future Phase 5 work. Historical Git references to it are **not** current commercial truth.

---

## 10. VAT / tax gate

**VAT STATUS: UNDETERMINED / EXTERNAL VALIDATION REQUIRED.**

Do not assert VAT registered / not registered / 20% / inclusive / exclusive without validated accounting evidence. Invoice templates support tax fields **without making a tax determination**.

---

## 11. Invoice / payment governance

Operational mechanics live in **`ops/INVOICE-FLOW.md`** and **`ops/PAYMENT-OPERATIONS.md`** (payment methods, failed-payment flow, reconciliation, refunds/credit notes, security, PCI). Core rules:

- Invoice values derive from the **approved client Commercial Schedule**, not public "From" pricing.
- **PAID** requires verified provider status or confirmed manual bank-transfer reconciliation — never "the client said it was sent."
- AI recurring requires a **recorded Go-Live date**.
- No real financial actions, secrets, or live provider activation without Owner/validated context.

---

## 12. External gates

The following are **controlled external gates**, not contradictions:

1. **LEGAL / CONTRACT VALIDATION**
2. **ACCOUNTING / VAT VALIDATION**
3. **PAYMENT TOOLING PRODUCTION ACTIVATION**
4. **OPERATIONAL DELIVERY VALIDATION**

They remain open and must not be falsely marked complete.

---

## 13. No secret data

Never commit: API keys, Stripe/PayPal credentials, bank credentials, KYC documents, client financial data, card information, passwords, or private account details. `.env` is git-ignored; `.env.example` holds placeholders only.

---

## 14. Validation

Before and after any commercial change, run:

- `node ops/validate-ops.mjs` — frozen invariants against the source JSON
- `node ops/validate-website.mjs` — website public pricing against the source JSON
- `node build.js` + `node verify.js` — website build + baseline
- a secret scan across changed files

---

## 15. Decision register

Major frozen decisions are recorded in **`docs/constitution/COMMERCIAL-DECISION-REGISTER.md`** (concise; no implementation detail duplication).
