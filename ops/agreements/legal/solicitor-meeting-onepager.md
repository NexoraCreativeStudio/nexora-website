# Nexora Creative Studio — Solicitor Briefing: High-Stakes Contract Clauses

**Prepared for:** Solicitor pre-meeting briefing  
**Date:** 2026-09-01  
**Context:** B2B services agreements for UK aesthetic clinic clients (AI receptionist, CRM, website, growth automation)  
**Current Status:** All 29 clauses in legal register are `LEGAL_DECISION_REQUIRED` — this brief covers the 12 requiring solicitor approval.

---

## Company Context

| Item | Detail |
|------|--------|
| **Entity** | Nexora Creative Studio (UK limited company) |
| **Clients** | UK aesthetic clinics (B2B) |
| **Services** | AI Receptionist, AI CRM, Analytics, Automations, Lead Reactivation, Patient Journey, Knowledge Base, Luxury Clinic Websites |
| **Pricing Model** | Project milestones + monthly platform subscriptions |
| **Key Commercial Terms** | Governed by `ops/billing-source-of-truth.json` (frozen constitution) |
| **Existing Warranty** | 90-day Web Launch Warranty (from accepted Proposal only) |

---

## 12 High-Stakes Clauses Requiring Solicitor Decision

### 1. Governing Law
**Decision Question:** Which country's law governs the agreement?  
**Default Consideration:** England & Wales (standard for UK B2B). Confirm appropriateness if any clients are non-UK entities.

### 2. Jurisdiction
**Decision Question:** Which courts have exclusive or non-exclusive jurisdiction?  
**Default Consideration:** English courts (exclusive). Consider non-exclusive if clients outside UK may prefer local courts.

### 3. Dispute Resolution
**Decision Question:** Litigation, arbitration, or mediation? If arbitration: seat, rules, language? If mediation: mandatory precursor?  
**Default Consideration:** English litigation (cost-effective for SME disputes); optional mediation as precondition; avoid arbitration unless cross-border enforcement needed.

### 4. Limitation of Liability
**Decision Question:** What overall cap? What carve-outs (uncapped liabilities)?  
**Default Consideration:** Cap at 1× annual fees paid / payable. Carve-outs: IP infringement, confidentiality breach, data protection/GDPR, fraud/wilful default, death/personal injury.

### 5. Indemnities
**Decision Question:** What indemnities does Nexora give? What indemnities does client give? Any mutual indemnities?  
**Default Consideration:** Nexora indemnifies: IP infringement (deliverables), data breach (Nexora-as-processor), wilful default. Client indemnifies: client-provided content/IP, regulatory compliance of clinic operations. No broad "all losses" indemnities.

### 6. IP Ownership
**Decision Question:** Who owns deliverables? Background IP? License terms if ownership doesn't transfer?  
**Default Consideration:** Client owns deliverables on **full payment**. Nexora retains background IP + tools/frameworks. Pre-payment: Nexora grants revocable license. Post-payment: perpetual, irrevocable, worldwide license to client (assignment on full payment).

### 7. Confidentiality
**Decision Question:** Scope (one-way/mutual)? Duration post-termination? Carve-outs (legal compulsion, public domain, independent development)?  
**Default Consideration:** Mutual. 3 years post-termination (5 years for trade secrets). Standard carve-outs: legal compulsion, public domain, independent development, prior knowledge.

### 8. Termination
**Decision Question:** Grounds (material breach, insolvency, convenience)? Notice periods? Cure periods? Effect on accrued rights, fees, IP license?  
**Default Consideration:** Material breach: 30-day written cure notice. Insolvency: immediate. Convenience: 30 days (client) / 60 days (Nexora). Accrued fees survive. IP license survives if fees paid.

### 9. Data Processing (UK GDPR Art. 28)
**Decision Question:** Controller/processor roles? Sub-processor approval process? International transfers (US/adequate countries)? Security measures?  
**Default Consideration:** Client = Controller, Nexora = Processor. Written sub-processor authorization (general + specific). SCCs for US transfers. ISO 27001-aligned security. 72-hour breach notification to Controller.

### 10. GDPR Obligations (Beyond Art. 28)
**Decision Question:** DPIA cooperation? Data subject request assistance? Record-keeping? DPO contact?  
**Default Consideration:** Nexora assists with DPIAs (client leads). Assists with DSARs within 10 business days. Maintains Art. 30 records. Designated DPO contact for privacy queries.

### 11. VAT / Tax Treatment
**Decision Question:** Is Nexora VAT registered? Pricing inclusive or exclusive of VAT? Reverse charge for B2B?  
**Default Consideration:** **Accounting gate** — depends on Nexora's VAT registration status (threshold £90k). If registered: prices exclusive + VAT at standard rate. If not: prices inclusive (no VAT shown). Reverse charge applies for B2B cross-border (post-Brexit NI protocol considerations).

### 12. Ownership Transfer Timing
**Decision Question:** When does IP ownership transfer — on invoice, on payment, on milestone acceptance? Partial payment = partial transfer or license?  
**Default Consideration:** Full ownership transfers on **full payment of all invoices** for that deliverable. Milestone payments = license to use delivered milestone. No ownership transfer on invoice alone.

---

## Meeting Logistics

| Item | Detail |
|------|--------|
| **Duration** | 30–60 minutes |
| **Format** | Video call / in-person |
| **Prep Required** | Review this document; confirm any sector-specific regulations for aesthetic clinics (CQC, GMC, advertising standards) |
| **Output Needed** | Written confirmation of approved positions for each clause → will be recorded in `legal-decisions.json` as `AUTHORITATIVE` |

---

## Post-Meeting Actions (Nexora)

1. Update `ops/agreements/legal/legal-decisions.json` — change 12 clauses from `LEGAL_DECISION_REQUIRED` → `AUTHORITATIVE` with solicitor-approved notes
2. Decide 17 Administrative clauses internally (separate document)
3. Run validation: `node ops/validate-ops.mjs` && `node ops/validate-website.mjs`
4. Generate updated Agreement templates from approved clauses

---

## Contact

**Nexora Lead:** [Your Name]  
**Email:** [your-email@nexorastudio.uk]  
**Reference:** PROP.5 / PROP.8 Legal Decision Register