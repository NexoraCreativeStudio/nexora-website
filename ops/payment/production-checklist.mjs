/* Nexora — Production Payment Activation Checklist (PROP.10)
   Machine-readable and human-readable gates for Production activation.
   ALL GATES MUST PASS before PRODUCTION_PAYMENT_ENABLED = true. */

export const ACTIVATION_CHECKLIST_SCHEMA = 'nexora-activation-checklist/v1';

export const ACTIVATION_GATES = [
  // Stripe Account & Ownership
  {
    id: 'stripe_account_verified',
    category: 'STRIPE_ACCOUNT',
    description: 'Stripe account created and verified (KYC complete)',
    required: true,
    verified: false,
  },
  {
    id: 'stripe_legal_entity_verified',
    category: 'STRIPE_ACCOUNT',
    description: 'Nexora legal entity/account ownership verified in Stripe Dashboard',
    required: true,
    verified: false,
  },

  // Starling Settlement
  {
    id: 'starling_business_account_confirmed',
    category: 'STARLING_SETTLEMENT',
    description: 'Starling business account confirmed as settlement destination',
    required: true,
    verified: false,
  },
  {
    id: 'starling_bank_details_in_stripe',
    category: 'STARLING_SETTLEMENT',
    description: 'GBP payout bank details entered directly in Stripe Dashboard (not in repo)',
    required: true,
    verified: false,
  },

  // Backend & Infrastructure
  {
    id: 'payment_backend_hosting_chosen',
    category: 'BACKEND',
    description: 'Payment backend hosting chosen (serverless function platform / managed backend)',
    required: true,
    verified: false,
  },
  {
    id: 'production_domain_confirmed',
    category: 'BACKEND',
    description: 'Production domain confirmed for webhook endpoints and return URLs',
    required: true,
    verified: false,
  },

  // Stripe Production Configuration
  {
    id: 'stripe_live_keys_configured',
    category: 'STRIPE_PRODUCTION_CONFIG',
    description: 'Stripe live keys configured in secret manager (STRIPE_SECRET_KEY, STRIPE_PUBLISHABLE_KEY)',
    required: true,
    verified: false,
  },
  {
    id: 'stripe_webhook_endpoint_deployed',
    category: 'STRIPE_PRODUCTION_CONFIG',
    description: 'Webhook endpoint deployed and accessible at production domain',
    required: true,
    verified: false,
  },
  {
    id: 'stripe_webhook_signing_secret_configured',
    category: 'STRIPE_PRODUCTION_CONFIG',
    description: 'Webhook signing secret (whsec_...) configured in secret manager',
    required: true,
    verified: false,
  },

  // Test-Mode Verification
  {
    id: 'test_checkout_successful',
    category: 'TEST_VERIFICATION',
    description: 'Test-mode Checkout Session created and completed successfully',
    required: true,
    verified: false,
  },
  {
    id: 'test_webhook_verified',
    category: 'TEST_VERIFICATION',
    description: 'Test-mode webhook received, signature verified, normalized correctly',
    required: true,
    verified: false,
  },
  {
    id: 'exact_reconciliation_verified',
    category: 'TEST_VERIFICATION',
    description: 'Exact amount reconciliation verified (customer payment → PROP.9 PAID)',
    required: true,
    verified: false,
  },
  {
    id: 'failed_payment_verified',
    category: 'TEST_VERIFICATION',
    description: 'Failed payment flow verified (payment_intent.payment_failed → status update)',
    required: true,
    verified: false,
  },
  {
    id: 'duplicate_webhook_verified',
    category: 'TEST_VERIFICATION',
    description: 'Duplicate webhook idempotency verified (second delivery ignored)',
    required: true,
    verified: false,
  },
  {
    id: 'refund_flow_verified',
    category: 'TEST_VERIFICATION',
    description: 'Refund flow verified (charge.refunded → PROP.9 refund-record → REFUND)',
    required: true,
    verified: false,
  },
  {
    id: 'dispute_flow_reviewed',
    category: 'TEST_VERIFICATION',
    description: 'Dispute flow reviewed (charge.dispute.created → PROP.9 dispute state)',
    required: true,
    verified: false,
  },
  {
    id: 'payout_reconciliation_tested',
    category: 'TEST_VERIFICATION',
    description: 'Payout reconciliation tested (Stripe payout → bank evidence → MATCHED)',
    required: true,
    verified: false,
  },

  // Recurring & Operating Policies
  {
    id: 'recurring_strategy_approved',
    category: 'POLICIES',
    description: 'Recurring billing strategy approved (AI monthly at Go-Live, Care monthly)',
    required: true,
    verified: false,
  },
  {
    id: 'refund_operating_policy_approved',
    category: 'POLICIES',
    description: 'Refund operating policy approved (authorization, partial/full, timelines)',
    required: true,
    verified: false,
  },
  {
    id: 'dispute_operating_policy_approved',
    category: 'POLICIES',
    description: 'Dispute operating policy approved (evidence collection, response, escalation)',
    required: true,
    verified: false,
  },

  // Compliance & Review
  {
    id: 'privacy_security_review_complete',
    category: 'COMPLIANCE',
    description: 'Privacy/security review complete (no client data in webhook logs, secret handling)',
    required: true,
    verified: false,
  },
  {
    id: 'owner_explicitly_approves_activation',
    category: 'COMPLIANCE',
    description: 'Owner explicitly approves Production payment activation',
    required: true,
    verified: false,
  },
];

/* Check if all required gates are passed */
export function isProductionReady(checklist) {
  if (!checklist || !Array.isArray(checklist)) return false;
  return checklist
    .filter(g => g.required)
    .every(g => g.verified === true);
}

/* Generate default checklist */
export function createActivationChecklist() {
  return {
    schema: ACTIVATION_CHECKLIST_SCHEMA,
    gates: ACTIVATION_GATES.map(g => ({ ...g, verified: false })),
    production_payment_enabled: false,
    kill_switch: 'PAYMENTS_ENABLED=false', // prevents new Production payment requests
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
    _example: true,
  };
}

/* Kill switch behavior */
export const KILL_SWITCH_NOTE = `
KILL SWITCH: PAYMENTS_ENABLED=false

When PAYMENTS_ENABLED=false:
- NEW Production payment requests (Checkout Sessions, Payment Intents) are BLOCKED
- Webhook processing for EXISTING transactions CONTINUES (reconciliation must complete)
- Test-mode operations UNAFFECTED
- Manual bank-transfer reconciliation UNAFFECTED

When PAYMENTS_ENABLED=true:
- All Production payment operations permitted
- Webhook processing continues

This distinction ensures in-flight transactions can complete even during emergency stop.
`;

export const PRODUCTION_STATUS = `
PRODUCTION_PAYMENT_ENABLED = false (DEFAULT)

Until ALL required gates pass:
- No live Checkout Sessions
- No live Payment Intents
- No live subscriptions
- No live webhook processing for payment events
- Test-mode only

Website remains byte-identical — no payment buttons, no public links.
`;