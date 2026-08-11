# Nexora — Operational checklist (per client / engagement)

Copy per client engagement. Fulfilment of each item should leave a verifiable record (proposal ref, agreement ref, invoice ref, Go-Live date). Values reference `ops/billing-source-of-truth.json`.

- [ ] **PROPOSAL APPROVED** — signed/accepted proposal; proposal reference recorded (validity 30 days).
- [ ] **AGREEMENT COMPLETE** — commercial agreement executed (scope, fees, payment schedule, terms). If agreement tooling is not operational, flag as the Legal/Contract gate.
- [ ] **FINAL COMMERCIAL SCHEDULE VERIFIED** — final approved price recorded (not the public "From" price); milestone schedule confirmed against the frozen schedules; B3/Complete bespoke schedules recorded explicitly.
- [ ] **INVOICE CREATED** — invoice number `NX-INV-YYYY-NNNN`; data matches client, service, approved price, milestone, implementation fee, recurring fee, billing start, Care, add-ons, approved CRs.
- [ ] **INVOICE SENT** — issued; due date = +7 calendar days (project invoices).
- [ ] **PAYMENT RECEIVED** — confirmed via provider status **or** manual bank-transfer reconciliation (never "client says sent").
- [ ] **DELIVERY AUTHORISED** — work proceeds only after the applicable payment / milestone condition.
- [ ] **MILESTONE TRACKED** — each tranche invoiced from the approved final price at the frozen percentages.
- [ ] **GO-LIVE RECORDED** — AI Go-Live date recorded; recurring billing start date derived from it.
- [ ] **RECURRING BILLING ACTIVATED** — first recurring invoice/subscription starts **at Go-Live**; AI support included, no separate AI support invoice, no AI Care.
- [ ] **CARE ACTIVATED (if purchased)** — Care billed monthly in advance, separately identifiable, no indefinite rollover.
- [ ] **ACCOUNTING RECONCILED** — invoice ↔ payment ↔ client ↔ project ↔ accounting record matches; no orphan payments, no paid invoices left open.

## Blockers that must halt this checklist

- Proposed milestone schedule deviates from a frozen schedule (e.g. invented B3 percentages).
- Complete billing would exceed 100% (e.g. "30% deposit + 100%").
- AI recurring would start before a recorded Go-Live date.
- Any VAT determination is being asserted without validated accounting input.
- Any payment is marked PAID without verified confirmation.
- Any duplicate invoice number would be issued.
