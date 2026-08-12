/* Nexora — Governed Payout Model (PROP.10)
   Separates customer payment reconciliation from payout settlement.
   CUSTOMER PAID ≠ STRIPE PAYOUT RECEIVED ≠ BANK CREDIT RECEIVED. */

import { sha256hex } from './payment-validation.mjs';

export const PAYOUT_SCHEMA = 'nexora-payout/v1';
export const PAYOUT_RECONCILIATION_SCHEMA = 'nexora-payout-reconciliation/v1';

/* Payout status model */
export const PAYOUT_STATUSES = [
  'CREATED',      // Stripe payout initiated
  'PENDING',      // Stripe processing
  'IN_TRANSIT',   // Stripe shows paid, awaiting bank confirmation
  'PAID',         // Bank credit confirmed (matched)
  'FAILED',       // Stripe payout failed
  'CANCELLED',    // Payout cancelled
  'REVERSED',     // Payout reversed (rare)
];

/* Payout reconciliation outcomes */
export const PAYOUT_RECONCILIATION_OUTCOMES = [
  'MATCHED',              // Stripe payout net = bank credit amount
  'PENDING',              // Awaiting bank statement evidence
  'AMOUNT_MISMATCH',      // Stripe net ≠ bank credit
  'CURRENCY_MISMATCH',    // Currency mismatch
  'UNKNOWN_PAYOUT',       // Bank credit has no matching Stripe payout
  'MISSING_BANK_EVIDENCE',// No bank statement provided
];

/* Build a governed payout record from Stripe payout evidence */
export function buildPayoutRecord(stripePayout, opts = {}) {
  const reasons = [];

  if (!stripePayout || typeof stripePayout !== 'object') {
    return { ok: false, reasons: ['stripePayout must be an object'] };
  }
  if (!stripePayout.id || !stripePayout.amount || !stripePayout.currency) {
    return { ok: false, reasons: ['stripePayout missing required fields'] };
  }

  const payoutId = `PO-${sha256hex(`nexora-payout:${stripePayout.id}`).slice(0, 8).toUpperCase()}`;
  const grossMajor = stripePayout.amount / 100;
  const feesMajor = (stripePayout.fee || 0) / 100;
  const netMajor = grossMajor - feesMajor;

  const record = {
    schema: PAYOUT_SCHEMA,
    payout_id: payoutId,
    provider: 'STRIPE',
    provider_payout_ref: stripePayout.id,
    currency: stripePayout.currency.toUpperCase(),
    gross_amount: grossMajor,
    fees: feesMajor,
    net_amount: netMajor,
    status: mapStripePayoutStatus(stripePayout.status),
    expected_arrival: stripePayout.arrival_date
      ? new Date(stripePayout.arrival_date * 1000).toISOString()
      : null,
    bank_destination_ref: opts.bankDestinationRef || 'STARLING_BUSINESS_ACCOUNT',
    included_charge_refs: opts.includedChargeRefs || [],
    provider_evidence: {
      stripe_payout_id: stripePayout.id,
      stripe_status: stripePayout.status,
      stripe_arrival_date: stripePayout.arrival_date,
      stripe_method: stripePayout.method,
    },
    reconciliation_status: 'PENDING',
    created_at: new Date().toISOString(),
    reconciled_at: null,
    audit_events: [
      {
        event: 'payout_created',
        at: new Date().toISOString(),
        event_id: sha256hex(`nexora-payout:${payoutId}:created`).slice(0, 16),
        detail: `Stripe payout ${stripePayout.id} recorded. PAYOUT RECEIVED ≠ BANK CREDIT CONFIRMED.`,
      },
    ],
    _example: opts.example === true ? true : undefined,
  };
  if (record._example === undefined) delete record._example;

  return { ok: true, payout: record };
}

/* Map Stripe payout status to governed status */
function mapStripePayoutStatus(stripeStatus) {
  const map = {
    'pending': 'PENDING',
    'in_transit': 'IN_TRANSIT',
    'paid': 'IN_TRANSIT', // Stripe "paid" = sent to bank, not confirmed received
    'failed': 'FAILED',
    'canceled': 'CANCELLED',
  };
  return map[stripeStatus] || 'CREATED';
}

/* Payout reconciliation — match Stripe payout to bank evidence */
export function reconcilePayout(payoutRecord, bankEvidence, opts = {}) {
  const reasons = [];

  if (!payoutRecord || payoutRecord.schema !== PAYOUT_SCHEMA) {
    return { ok: false, reasons: ['invalid payout record'] };
  }
  if (!bankEvidence || typeof bankEvidence !== 'object') {
    return { ok: false, reasons: ['bankEvidence must be an object'] };
  }

  const bankAmount = bankEvidence.credit_amount;
  const bankCurrency = bankEvidence.currency?.toUpperCase();
  const bankRef = bankEvidence.bank_reference;
  const bankDate = bankEvidence.received_date;

  if (typeof bankAmount !== 'number' || bankAmount <= 0) {
    return { ok: false, reasons: ['bankEvidence missing valid credit_amount'] };
  }
  if (bankCurrency !== payoutRecord.currency) {
    return {
      ok: false,
      outcome: 'CURRENCY_MISMATCH',
      reasons: [`bank currency ${bankCurrency} ≠ payout currency ${payoutRecord.currency}`],
    };
  }

  const amountDiff = Math.abs(bankAmount - payoutRecord.net_amount);
  if (amountDiff < 0.01) { // Within 1 penny tolerance
    const reconciliation = {
      schema: PAYOUT_RECONCILIATION_SCHEMA,
      reconciliation_id: `POREC-${payoutRecord.payout_id}-${sha256hex(`nexora-po-rec:${payoutRecord.payout_id}:${bankRef}`).slice(0, 8)}`,
      payout_id: payoutRecord.payout_id,
      provider: payoutRecord.provider,
      provider_payout_ref: payoutRecord.provider_payout_ref,
      bank_reference: bankRef,
      bank_received_date: bankDate,
      outcome: 'MATCHED',
      expected_amount: payoutRecord.net_amount,
      actual_amount: bankAmount,
      currency: payoutRecord.currency,
      reconciled_at: new Date().toISOString(),
      detail: `Stripe payout ${payoutRecord.provider_payout_ref} matched bank credit ${bankRef}.`,
      audit_events: [
        {
          event: 'payout_reconciled',
          at: new Date().toISOString(),
          event_id: sha256hex(`nexora-po-rec:${payoutRecord.payout_id}`).slice(0, 16),
          detail: `Payout reconciliation MATCHED. Bank credit confirmed.`,
        },
      ],
    };
    return { ok: true, outcome: 'MATCHED', reconciliation };
  }

  return {
    ok: false,
    outcome: 'AMOUNT_MISMATCH',
    reasons: [`bank credit ${bankAmount} ≠ expected net ${payoutRecord.net_amount}`],
  };
}

/* Fee model clarification: Provider fees do NOT reduce invoice settled amount.
   Invoice is PAID when customer gross payment is reconciled.
   Fees are provider expense, tracked separately in payout model. */
export const FEE_MODEL_NOTE = `
FEE MODEL (PROP.10):
- Invoice amount (e.g., £2,040) = customer gross payment
- Stripe fee (e.g., £59.16) = provider expense, NOT deducted from invoice settled amount
- Net payout (e.g., £1,980.84) = amount arriving in bank
- Invoice PAID when customer £2,040 reconciled via PROP.9
- Payout reconciliation is SEPARATE: matches £1,980.84 to bank credit
`;