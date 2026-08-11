/*
 * Nexora — Stripe integration REFERENCE EXAMPLE (TEST-MODE ONLY).
 *
 * NOT OPERATIONAL. NOT EXECUTED. NOT WIRED TO ANY ROUTE.
 * This file exists to document the safe integration shape for a future
 * serverless function (e.g. Netlify Function). It contains NO real keys.
 * Secrets are read from process.env only (see .env.example). Do not use
 * this as-is for production; production activation is an Owner action.
 */

// Reference imports — the Stripe SDK would be a dependency of the function,
// not of the static site. Nothing here runs today.
// import Stripe from 'stripe';

const stripeSecretKey = process.env.STRIPE_SECRET_KEY; // never hard-code
const stripeWebhookSecret = process.env.STRIPE_WEBHOOK_SECRET;

// Example guard: refuse to operate without an explicitly activated key.
// Test mode uses the test key; production requires an Owner activation gate.
function requireStripe() {
  if (!stripeSecretKey || stripeSecretKey.startsWith('sk_live_')) {
    // In reality, live keys require an explicit activation decision.
    throw new Error('Stripe not activated for this environment');
  }
  // const stripe = new Stripe(stripeSecretKey);
  return stripeSecretKey;
}

// Example: create a Checkout Session for an invoice amount.
// Milestones are computed from the APPROVED final price — never from the
// public "From" price. VAT is UNDETERMINED; do not add a hard-coded tax rate.
export async function createCheckoutSession({ amountPence, currency = 'gbp', successUrl, cancelUrl, metadata }) {
  requireStripe();
  // const session = await stripe.checkout.sessions.create({ ... });
  // Not executed. Shape only.
  return { status: 'not-executed-example', amountPence, currency, metadata };
}

// Example: verify a webhook signature before trusting a payment event.
// This is what would mark an invoice PAID from provider status.
export async function verifyWebhook(payload, signature) {
  requireStripe();
  // const event = stripe.webhooks.constructEvent(payload, signature, stripeWebhookSecret);
  // Map event.type (e.g. 'checkout.session.completed') -> mark invoice PAID
  // via verified provider status (never "client says paid").
  return { status: 'not-executed-example', signature };
}

// Example: activate a recurring subscription — only AFTER a recorded Go-Live.
// Recurring AI billing starts at Go-Live; never before. No AI Care, no
// separate AI support charge.
export async function startRecurring({ customerId, priceId, goLiveDate, billingStartDate }) {
  requireStripe();
  if (!goLiveDate) throw new Error('Go-Live date must be recorded before recurring billing');
  // const subscription = await stripe.subscriptions.create({ customer: customerId, items: [{ price: priceId }] });
  return { status: 'not-executed-example', goLiveDate, billingStartDate };
}
