/* Nexora — Recurring Payments Readiness (PROP.10)
   Stripe Subscription architecture for AI monthly + Care monthly.
   Preserves PROP.9/PROP.8 rules: AI recurring starts at Go-Live only. */

import { sha256hex } from './payment-validation.mjs';

export const RECURRING_SCHEMA = 'nexora-recurring-readiness/v1';

/* Recurring billing types */
export const RECURRING_TYPES = {
  AI_MONTHLY: 'AI_MONTHLY',
  CARE_MONTHLY: 'CARE_MONTHLY',
};

/* Recurring readiness gates */
export const RECURRING_GATES = {
  AI_MONTHLY: [
    'AI implementation complete',
    'Go-Live date recorded (governed trigger)',
    'Stripe Price ID configured for plan (A1/A2/A3 monthly fee)',
    'Customer Stripe Customer object created (or will be created at first payment)',
    'Payment method attached to customer',
    'Subscription schedule aligned with Go-Live (not before)',
  ],
  CARE_MONTHLY: [
    'Care plan purchased (Web Essential/Plus or Brand Standard/Extended)',
    'Care start date recorded',
    'Stripe Price ID configured for Care tier',
    'Customer Stripe Customer object created',
    'Payment method attached',
    'Subscription starts on Care start date',
  ],
};

/* Recurring activation record — governed linkage */
export function buildRecurringActivationRecord(opts = {}) {
  const reasons = [];
  if (!opts.type || !Object.values(RECURRING_TYPES).includes(opts.type)) {
    reasons.push('type must be AI_MONTHLY or CARE_MONTHLY');
  }
  if (!opts.client_ref) reasons.push('client_ref required');
  if (!opts.stripe_price_id) reasons.push('stripe_price_id required');
  if (opts.type === RECURRING_TYPES.AI_MONTHLY && !opts.go_live_date) {
    reasons.push('go_live_date required for AI_MONTHLY (recurring starts at Go-Live)');
  }
  if (opts.type === RECURRING_TYPES.CARE_MONTHLY && !opts.care_start_date) {
    reasons.push('care_start_date required for CARE_MONTHLY');
  }

  if (reasons.length) return { ok: false, reasons };

  const record = {
    schema: RECURRING_SCHEMA,
    recurring_id: `RECUR-${sha256hex(`nexora-recur:${opts.client_ref}:${opts.type}:${opts.go_live_date || opts.care_start_date}`).slice(0, 8).toUpperCase()}`,
    type: opts.type,
    client_ref: opts.client_ref,
    stripe_price_id: opts.stripe_price_id,
    stripe_customer_ref: opts.stripe_customer_ref || null,
    amount_monthly: opts.amount_monthly,
    currency: opts.currency || 'GBP',
    billing_start_date: opts.type === RECURRING_TYPES.AI_MONTHLY ? opts.go_live_date : opts.care_start_date,
    go_live_date: opts.go_live_date || null,
    care_start_date: opts.care_start_date || null,
    status: 'PENDING_ACTIVATION',
    stripe_subscription_ref: null,
    payment_method_ref: opts.payment_method_ref || null,
    activation_gate: opts.type === RECURRING_TYPES.AI_MONTHLY ? 'GO_LIVE_RECORDED' : 'CARE_START_DATE',
    created_at: new Date().toISOString(),
    activated_at: null,
    audit_events: [
      {
        event: 'recurring_record_created',
        at: new Date().toISOString(),
        event_id: sha256hex(`nexora-recur-create:${opts.client_ref}:${opts.type}`).slice(0, 16),
        detail: `Recurring ${opts.type} record created. ACTIVATION GATE: ${opts.type === RECURRING_TYPES.AI_MONTHLY ? 'GO_LIVE' : 'CARE_START'}.`,
      },
    ],
    _example: opts.example === true ? true : undefined,
  };
  if (record._example === undefined) delete record._example;
  return { ok: true, record };
}

/* Subscription activation — only after gate satisfied */
export function canActivateSubscription(record, currentDate = new Date().toISOString().slice(0, 10)) {
  if (!record || record.schema !== RECURRING_SCHEMA) return { ok: false, reason: 'invalid record' };
  if (record.status !== 'PENDING_ACTIVATION') return { ok: false, reason: `status is ${record.status}, not PENDING_ACTIVATION` };

  const gateDate = record.type === RECURRING_TYPES.AI_MONTHLY ? record.go_live_date : record.care_start_date;
  if (!gateDate) return { ok: false, reason: 'activation gate date not set' };

  if (currentDate < gateDate) {
    return { ok: false, reason: `activation gate not reached: ${gateDate} > ${currentDate}` };
  }

  if (!record.stripe_customer_ref) return { ok: false, reason: 'stripe_customer_ref not set' };
  if (!record.payment_method_ref) return { ok: false, reason: 'payment_method_ref not set' };

  return { ok: true, reason: 'activation gate satisfied' };
}

/* Stripe Subscription representation (test-mode) */
export function makeTestStripeSubscription(record) {
  return {
    object: 'subscription',
    id: `sub_test_${sha256hex(`nexora-sub:${record.recurring_id}`).slice(0, 20)}`,
    customer: record.stripe_customer_ref,
    status: 'active',
    current_period_start: Math.floor(new Date(record.billing_start_date).getTime() / 1000),
    current_period_end: Math.floor(new Date(record.billing_start_date).getTime() / 1000) + 2678400, // ~31 days
    items: {
      data: [{
        price: record.stripe_price_id,
        quantity: 1,
      }],
    },
    metadata: {
      nexora_recurring_id: record.recurring_id,
      nexora_type: record.type,
      nexora_client_ref: record.client_ref,
    },
    livemode: false,
    _test_only: true,
  };
}

/* Recurring billing rules from Commercial Constitution */
export const RECURRING_RULES = `
RECURRING BILLING RULES (from Commercial Constitution):

AI MONTHLY (A1/A2/A3):
- Recurring billing STARTS AT GO-LIVE — never before
- Go-Live must be a RECORDED date (not memory, not informal)
- Implementation fee billed separately (project milestone invoice)
- Monthly fee = plan monthly_fee from billing-source-of-truth.json
- AI support included in subscription — NO AI Care, NO separate AI support invoice

CARE MONTHLY (Web Essential/Plus, Brand Standard/Extended):
- Monthly, paid in advance
- NO indefinite rollover
- Care invoices separately identifiable from project invoices
- Never silently bundled into project price
- Activate only when Care is purchased

STRIPE SUBSCRIPTION STRATEGY (readiness):
- One Stripe Customer per client (shared across AI + Care if both)
- Separate Stripe Price per plan/tier (A1, A2, A3, Web Essential, Web Plus, Brand Standard, Brand Extended)
- Subscription created only after activation gate satisfied
- Payment method required before activation
- webhook: invoice.payment_succeeded → recurring reconciliation
- webhook: invoice.payment_failed → failed payment flow
- webhook: customer.subscription.deleted → cancelled status

NO LIVE SUBSCRIPTIONS IN PROP.10 — TEST-MODE ONLY.
`;