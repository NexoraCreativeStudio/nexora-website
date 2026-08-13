/* Nexora — PROP.11 Governed Customer Payment Portal Validator
   Comprehensive validation of token model, portal session, checkout flow,
   webhook handling, and PROP.9 reconciliation integration.
   TEST/SANDBOX only — no LIVE credentials. */

import { readFileSync, writeFileSync, existsSync, mkdirSync, readdirSync } from 'fs';
import { join } from 'path';
import { spawnSync } from 'child_process';

const OPS_DIR = join(process.cwd(), 'ops');
const PAYMENT_DIR = join(OPS_DIR, 'payment');
const EXAMPLES_DIR = join(PAYMENT_DIR, 'examples');
const OUT_DIR = join(PAYMENT_DIR, 'out');
const BILLING_OUT_DIR = join(OPS_DIR, 'billing', 'out');

// Import modules
import {
  TOKEN_SCHEMA, TOKEN_ID_RE, TOKEN_STATUS, DEFAULT_TOKEN_TTL_SECONDS,
  generateTokenId, deriveTestTokenId, buildPaymentToken, validatePaymentToken,
  checkTokenUsable, markTokenUsed, revokeToken, expireToken,
  markTokenVoidInvoice, markTokenCancelledInvoice, tokenFilename, TOKEN_EXAMPLE
} from './token-model.mjs';

import {
  PORTAL_SESSION_SCHEMA, PORTAL_SESSION_ID_RE, PORTAL_SESSION_STATUS, DEFAULT_SESSION_TTL_SECONDS,
  generatePortalSessionId, deriveTestPortalSessionId, buildPortalSession, validatePortalSession,
  attachCheckoutSession, markCustomerRedirected, markWebhookReceived, markReconciled,
  markFailed, expireSession, checkSessionValidForCheckout, sessionFilename, PORTAL_SESSION_EXAMPLE,
  buildCheckoutSessionRequest, normalizeStripeCheckoutSession
} from './portal-session.mjs';

import {
  STRIPE_TEST_CONFIG_EXAMPLE, validateStripeConfig
} from './stripe-config.mjs';

import {
  StripeAdapter, StripeTestAdapter, toMinorUnits, fromMinorUnits,
  deriveIdempotencyKey, buildStripeMetadata
} from './stripe-adapter.mjs';

import {
  WEBHOOK_CONTRACT_SCHEMA, PRODUCTION_WEBHOOK_REQUIRED,
  validateWebhookContract, deriveWebhookIdempotencyKey,
  SUPPORTED_PAYMENT_EVENT_TYPES, SUPPORTED_PAYOUT_EVENT_TYPES
} from './webhook-contract.mjs';

import {
  PAYMENT_SCHEMA, PAYMENT_REQUEST_SCHEMA, WEBHOOK_EVENT_SCHEMA, RECONCILIATION_SCHEMA,
  PAYMENT_STATUSES, PAYMENT_ENVIRONMENTS, PROVIDER_IDS,
  buildPaymentRequest, buildPaymentRecord, applyPaymentEvent, applyReconciliation,
  buildReconciliation,
  TestPaymentAdapter, PaymentProviderAdapter,
  sha256hex, buildWebhookFingerprint, verifyWebhookFingerprint
} from './payment-validation.mjs';

import {
  INVOICE_SCHEMA, INVOICE_STATUSES, INVOICE_TYPES,
  buildInvoiceRecord, validateInvoiceRecord
} from '../billing/billing-validation.mjs';

/* Test utilities */
const results = { passed: 0, failed: 0, tests: [] };

function assert(condition, message) {
  if (condition) {
    results.passed++;
    results.tests.push({ name: message, status: 'PASS' });
    console.log(`  ✓ ${message}`);
  } else {
    results.failed++;
    results.tests.push({ name: message, status: 'FAIL' });
    console.error(`  ✗ ${message}`);
  }
}

function assertThrows(fn, message) {
  try {
    fn();
    results.failed++;
    results.tests.push({ name: message, status: 'FAIL' });
    console.error(`  ✗ ${message} — expected to throw`);
  } catch (e) {
    results.passed++;
    results.tests.push({ name: message, status: 'PASS' });
    console.log(`  ✓ ${message}`);
  }
}

function runTest(name, fn) {
  console.log(`\n▸ ${name}`);
  try {
    fn();
  } catch (e) {
    results.failed++;
    results.tests.push({ name, status: 'ERROR', error: e.message });
    console.error(`  ✗ ${name} — ${e.message}`);
  }
}

/* ============================================================
   TOKEN MODEL TESTS
   ============================================================ */

const exampleInvoice = JSON.parse(
  readFileSync(join(OPS_DIR, 'billing', 'examples', 'invoice-issued-example.json'), 'utf8')
);

const exampleRequest = JSON.parse(
  readFileSync(join(OPS_DIR, 'payment', 'examples', 'payment-request-example.json'), 'utf8')
);

runTest('TOKEN: generateTokenId produces valid format', () => {
  const id = generateTokenId();
  assert(TOKEN_ID_RE.test(id), 'Token ID matches regex');
  assert(id.startsWith('PAT-'), 'Token ID has PAT- prefix');
  assert(id.length === 47, 'Token ID is 47 chars (PAT- + 43)');
});

runTest('TOKEN: deriveTestTokenId is deterministic', () => {
  const id1 = deriveTestTokenId('INV-2026-9898-001', 'REQ-2026-9898-001');
  const id2 = deriveTestTokenId('INV-2026-9898-001', 'REQ-2026-9898-001');
  assert(id1 === id2, 'Same inputs produce same token ID');
  assert(TOKEN_ID_RE.test(id1), 'Derived token matches regex');
});

runTest('TOKEN: buildPaymentToken creates valid token', () => {
  const result = buildPaymentToken({ invoice: exampleInvoice, request: exampleRequest, example: true });
  assert(result.ok, 'Build succeeds');
  assert(result.token.token_id, 'Token has ID');
  assert(result.token.status === 'ACTIVE', 'Status is ACTIVE');
  assert(result.token.amount === 2040, 'Amount matches request');
  assert(result.token.currency === 'GBP', 'Currency is GBP');
  assert(result.token.expires_at > result.token.created_at, 'Expiry is after creation');
  assert(result.token.audit_events.length >= 1, 'Has audit event');
  assert(result.token._example === true, 'Marked as example');
});

runTest('TOKEN: buildPaymentToken rejects non-ISSUED invoice', () => {
  const voidInvoice = { ...exampleInvoice, status: 'VOID' };
  const result = buildPaymentToken({ invoice: voidInvoice, request: exampleRequest, example: true });
  assert(!result.ok, 'Rejects VOID invoice');
  assert(result.reasons.some(r => r.includes('ISSUED')), 'Reason mentions ISSUED');
});

runTest('TOKEN: buildPaymentToken rejects mismatched invoice_id', () => {
  const badRequest = { ...exampleRequest, invoice_id: 'INV-2026-9999-001' };
  const result = buildPaymentToken({ invoice: exampleInvoice, request: badRequest, example: true });
  assert(!result.ok, 'Rejects mismatched invoice_id');
});

runTest('TOKEN: validatePaymentToken passes valid token', () => {
  const result = buildPaymentToken({ invoice: exampleInvoice, request: exampleRequest, example: true });
  const validation = validatePaymentToken(result.token, { requireExampleMarker: true });
  assert(validation.failures.length === 0, 'Validation passes');
});

runTest('TOKEN: validatePaymentToken fails on bad token_id format', () => {
  const token = { ...TOKEN_EXAMPLE, token_id: 'BAD-TOKEN' };
  const validation = validatePaymentToken(token, { requireExampleMarker: true });
  assert(validation.failures.length > 0, 'Fails on bad token_id');
});

runTest('TOKEN: validatePaymentToken fails on wrong currency', () => {
  const token = { ...TOKEN_EXAMPLE, currency: 'USD' };
  const validation = validatePaymentToken(token, { requireExampleMarker: true });
  assert(validation.failures.some(f => f.includes('GBP')), 'Fails on non-GBP currency');
});

runTest('TOKEN: checkTokenUsable passes for valid token', () => {
  const result = buildPaymentToken({ invoice: exampleInvoice, request: exampleRequest, example: true });
  const usable = checkTokenUsable(result.token, exampleInvoice, exampleRequest);
  assert(usable.ok, 'Token is usable');
});

runTest('TOKEN: checkTokenUsable fails for expired token', () => {
  const token = { ...TOKEN_EXAMPLE, expires_at: '2020-01-01T00:00:00.000Z' };
  const usable = checkTokenUsable(token, exampleInvoice, exampleRequest);
  assert(!usable.ok, 'Expired token not usable');
  assert(usable.reasons.some(r => r.includes('expired')), 'Reason mentions expired');
});

runTest('TOKEN: checkTokenUsable fails for used token', () => {
  const token = { ...TOKEN_EXAMPLE, used_at: '2026-08-15T10:00:00.000Z', status: 'USED' };
  const usable = checkTokenUsable(token, exampleInvoice, exampleRequest);
  assert(!usable.ok, 'Used token not usable');
  assert(usable.reasons.some(r => r.toLowerCase().includes('used')), 'Reason mentions used');
});

runTest('TOKEN: checkTokenUsable fails for VOID invoice', () => {
  const voidInvoice = { ...exampleInvoice, status: 'VOID' };
  const usable = checkTokenUsable(TOKEN_EXAMPLE, voidInvoice, exampleRequest);
  assert(!usable.ok, 'VOID invoice not payable');
  assert(usable.reasons.some(r => r.includes('VOID_INVOICE')), 'Reason mentions VOID_INVOICE');
});

runTest('TOKEN: checkTokenUsable fails for CANCELLED invoice', () => {
  const cancelledInvoice = { ...exampleInvoice, status: 'CANCELLED' };
  const usable = checkTokenUsable(TOKEN_EXAMPLE, cancelledInvoice, exampleRequest);
  assert(!usable.ok, 'CANCELLED invoice not payable');
  assert(usable.reasons.some(r => r.includes('CANCELLED_INVOICE')), 'Reason mentions CANCELLED_INVOICE');
});

runTest('TOKEN: checkTokenUsable fails for non-ISSUED invoice', () => {
  const paidInvoice = { ...exampleInvoice, status: 'PAID' };
  const usable = checkTokenUsable(TOKEN_EXAMPLE, paidInvoice, exampleRequest);
  assert(!usable.ok, 'PAID invoice not payable');
  assert(usable.reasons.some(r => r.includes('ISSUED')), 'Reason mentions ISSUED');
});

runTest('TOKEN: markTokenUsed transitions to USED', () => {
  const result = buildPaymentToken({ invoice: exampleInvoice, request: exampleRequest, example: true });
  const used = markTokenUsed(result.token);
  assert(used.ok, 'Mark used succeeds');
  assert(used.token.status === 'USED', 'Status is USED');
  assert(used.token.used_at, 'Has used_at timestamp');
  assert(used.token.audit_events.length === 2, 'Added audit event');
});

runTest('TOKEN: markTokenUsed fails on non-ACTIVE', () => {
  const token = { ...TOKEN_EXAMPLE, status: 'USED' };
  const used = markTokenUsed(token);
  assert(!used.ok, 'Fails on non-ACTIVE');
});

runTest('TOKEN: revokeToken transitions to REVOKED', () => {
  const result = buildPaymentToken({ invoice: exampleInvoice, request: exampleRequest, example: true });
  const revoked = revokeToken(result.token, 'customer_request');
  assert(revoked.ok, 'Revoke succeeds');
  assert(revoked.token.status === 'REVOKED', 'Status is REVOKED');
  assert(revoked.token.revoked_reason === 'customer_request', 'Has revoked reason');
});

runTest('TOKEN: expireToken transitions to EXPIRED', () => {
  const result = buildPaymentToken({ invoice: exampleInvoice, request: exampleRequest, example: true });
  const expired = expireToken(result.token);
  assert(expired.ok, 'Expire succeeds');
  assert(expired.token.status === 'EXPIRED', 'Status is EXPIRED');
});

runTest('TOKEN: markTokenVoidInvoice transitions to VOID_INVOICE', () => {
  const result = buildPaymentToken({ invoice: exampleInvoice, request: exampleRequest, example: true });
  const voided = markTokenVoidInvoice(result.token);
  assert(voided.ok, 'Void invoice succeeds');
  assert(voided.token.status === 'VOID_INVOICE', 'Status is VOID_INVOICE');
});

runTest('TOKEN: markTokenCancelledInvoice transitions to CANCELLED_INVOICE', () => {
  const result = buildPaymentToken({ invoice: exampleInvoice, request: exampleRequest, example: true });
  const cancelled = markTokenCancelledInvoice(result.token);
  assert(cancelled.ok, 'Cancelled invoice succeeds');
  assert(cancelled.token.status === 'CANCELLED_INVOICE', 'Status is CANCELLED_INVOICE');
});

runTest('TOKEN: TOKEN_EXAMPLE validates correctly', () => {
  const validation = validatePaymentToken(TOKEN_EXAMPLE, { requireExampleMarker: true });
  assert(validation.failures.length === 0, 'Example token validates');
});

/* ============================================================
   PORTAL SESSION TESTS
   ============================================================ */

runTest('SESSION: generatePortalSessionId produces valid format', () => {
  const id = generatePortalSessionId();
  assert(PORTAL_SESSION_ID_RE.test(id), 'Session ID matches regex');
  assert(id.startsWith('PSS-'), 'Session ID has PSS- prefix');
  assert(id.length === 47, 'Session ID is 47 chars');
});

runTest('SESSION: deriveTestPortalSessionId is deterministic', () => {
  const id1 = deriveTestPortalSessionId('PAT-test');
  const id2 = deriveTestPortalSessionId('PAT-test');
  assert(id1 === id2, 'Same input produces same session ID');
});

runTest('SESSION: buildPortalSession creates valid session', () => {
  const tokenResult = buildPaymentToken({ invoice: exampleInvoice, request: exampleRequest, example: true });
  const result = buildPortalSession({ token: tokenResult.token, paymentRequest: exampleRequest, invoice: exampleInvoice, example: true });
  assert(result.ok, 'Build succeeds');
  assert(result.session.session_id, 'Has session ID');
  assert(result.session.status === 'CREATED', 'Status is CREATED');
  assert(result.session.token_id === tokenResult.token.token_id, 'Linked to token');
  assert(result.session.amount === 2040, 'Amount matches');
  assert(result.session.expires_at > result.session.created_at, 'Expiry after creation');
});

runTest('SESSION: buildPortalSession rejects unusable token', () => {
  const voidInvoice = { ...exampleInvoice, status: 'VOID' };
  const tokenResult = buildPaymentToken({ invoice: exampleInvoice, request: exampleRequest, example: true });
  const result = buildPortalSession({ token: tokenResult.token, paymentRequest: exampleRequest, invoice: voidInvoice, example: true });
  assert(!result.ok, 'Rejects VOID invoice');
});

runTest('SESSION: validatePortalSession passes valid session', () => {
  const tokenResult = buildPaymentToken({ invoice: exampleInvoice, request: exampleRequest, example: true });
  const sessionResult = buildPortalSession({ token: tokenResult.token, paymentRequest: exampleRequest, invoice: exampleInvoice, example: true });
  const validation = validatePortalSession(sessionResult.session, { requireExampleMarker: true });
  assert(validation.failures.length === 0, 'Validation passes');
});

runTest('SESSION: attachCheckoutSession updates status', () => {
  const tokenResult = buildPaymentToken({ invoice: exampleInvoice, request: exampleRequest, example: true });
  const sessionResult = buildPortalSession({ token: tokenResult.token, paymentRequest: exampleRequest, invoice: exampleInvoice, example: true });
  const fakeStripeSession = {
    id: 'cs_test_123',
    url: 'https://checkout.stripe.com/pay/cs_test_123',
    expires_at: Math.floor(Date.now() / 1000) + 1800,
    payment_status: 'unpaid',
    status: 'open',
    amount_total: 204000,
    currency: 'gbp',
    livemode: false,
    metadata: { nexora_payment_request_id: 'REQ-2026-9898-001' }
  };
  const attached = attachCheckoutSession(sessionResult.session, fakeStripeSession);
  assert(attached.ok, 'Attach succeeds');
  assert(attached.session.status === 'CHECKOUT_CREATED', 'Status updated');
  assert(attached.session.stripe_checkout_session_id === 'cs_test_123', 'Stripe ID stored');
});

runTest('SESSION: markCustomerRedirected transitions state', () => {
  const tokenResult = buildPaymentToken({ invoice: exampleInvoice, request: exampleRequest, example: true });
  const sessionResult = buildPortalSession({ token: tokenResult.token, paymentRequest: exampleRequest, invoice: exampleInvoice, example: true });
  const fakeStripeSession = {
    id: 'cs_test_123', url: 'https://checkout.stripe.com/pay/cs_test_123',
    expires_at: Math.floor(Date.now() / 1000) + 1800, payment_status: 'unpaid', status: 'open',
    amount_total: 204000, currency: 'gbp', livemode: false, metadata: {}
  };
  const attached = attachCheckoutSession(sessionResult.session, fakeStripeSession);
  const redirected = markCustomerRedirected(attached.session);
  assert(redirected.ok, 'Redirect succeeds');
  assert(redirected.session.status === 'CUSTOMER_REDIRECTED', 'Status is CUSTOMER_REDIRECTED');
});

runTest('SESSION: markWebhookReceived transitions state', () => {
  const tokenResult = buildPaymentToken({ invoice: exampleInvoice, request: exampleRequest, example: true });
  const sessionResult = buildPortalSession({ token: tokenResult.token, paymentRequest: exampleRequest, invoice: exampleInvoice, example: true });
  const fakeStripeSession = {
    id: 'cs_test_123', url: 'https://checkout.stripe.com/pay/cs_test_123',
    expires_at: Math.floor(Date.now() / 1000) + 1800, payment_status: 'unpaid', status: 'open',
    amount_total: 204000, currency: 'gbp', livemode: false, metadata: {}
  };
  const attached = attachCheckoutSession(sessionResult.session, fakeStripeSession);
  const redirected = markCustomerRedirected(attached.session);
  const webhookReceived = markWebhookReceived(redirected.session, { event_type: 'checkout.session.completed' });
  assert(webhookReceived.ok, 'Webhook received succeeds');
  assert(webhookReceived.session.status === 'WEBHOOK_RECEIVED', 'Status is WEBHOOK_RECEIVED');
  assert(webhookReceived.session.audit_events.some(e => e.event === 'webhook_received'), 'Audit event recorded');
  assert(webhookReceived.session.audit_events.some(e => e.detail.includes('WEBHOOK RECEIVED != PAID')), 'Audit mentions WEBHOOK RECEIVED != PAID');
});

runTest('SESSION: markReconciled transitions to RECONCILED', () => {
  const tokenResult = buildPaymentToken({ invoice: exampleInvoice, request: exampleRequest, example: true });
  const sessionResult = buildPortalSession({ token: tokenResult.token, paymentRequest: exampleRequest, invoice: exampleInvoice, example: true });
  const fakeStripeSession = {
    id: 'cs_test_123', url: 'https://checkout.stripe.com/pay/cs_test_123',
    expires_at: Math.floor(Date.now() / 1000) + 1800, payment_status: 'unpaid', status: 'open',
    amount_total: 204000, currency: 'gbp', livemode: false, metadata: {}
  };
  const attached = attachCheckoutSession(sessionResult.session, fakeStripeSession);
  const redirected = markCustomerRedirected(attached.session);
  const webhookReceived = markWebhookReceived(redirected.session, { event_type: 'checkout.session.completed' });
  const reconciled = markReconciled(webhookReceived.session, { outcome: 'EXACT' });
  assert(reconciled.ok, 'Reconcile succeeds');
  assert(reconciled.session.status === 'RECONCILED', 'Status is RECONCILED');
  assert(reconciled.session.completed_at, 'Has completed_at');
});

runTest('SESSION: markReconciled fails on non-EXACT/PARTIAL', () => {
  const tokenResult = buildPaymentToken({ invoice: exampleInvoice, request: exampleRequest, example: true });
  const sessionResult = buildPortalSession({ token: tokenResult.token, paymentRequest: exampleRequest, invoice: exampleInvoice, example: true });
  const fakeStripeSession = {
    id: 'cs_test_123', url: 'https://checkout.stripe.com/pay/cs_test_123',
    expires_at: Math.floor(Date.now() / 1000) + 1800, payment_status: 'unpaid', status: 'open',
    amount_total: 204000, currency: 'gbp', livemode: false, metadata: {}
  };
  const attached = attachCheckoutSession(sessionResult.session, fakeStripeSession);
  const redirected = markCustomerRedirected(attached.session);
  const webhookReceived = markWebhookReceived(redirected.session, { event_type: 'checkout.session.completed' });
  const reconciled = markReconciled(webhookReceived.session, { outcome: 'WRONG_AMOUNT' });
  assert(!reconciled.ok, 'Fails on WRONG_AMOUNT');
});

runTest('SESSION: markFailed transitions to FAILED', () => {
  const tokenResult = buildPaymentToken({ invoice: exampleInvoice, request: exampleRequest, example: true });
  const sessionResult = buildPortalSession({ token: tokenResult.token, paymentRequest: exampleRequest, invoice: exampleInvoice, example: true });
  const failed = markFailed(sessionResult.session, 'customer_cancelled');
  assert(failed.ok, 'Mark failed succeeds');
  assert(failed.session.status === 'FAILED', 'Status is FAILED');
  assert(failed.session.failure_reason === 'customer_cancelled', 'Has failure reason');
});

runTest('SESSION: expireSession transitions to EXPIRED', () => {
  const tokenResult = buildPaymentToken({ invoice: exampleInvoice, request: exampleRequest, example: true });
  const sessionResult = buildPortalSession({ token: tokenResult.token, paymentRequest: exampleRequest, invoice: exampleInvoice, example: true });
  const expired = expireSession(sessionResult.session);
  assert(expired.ok, 'Expire succeeds');
  assert(expired.session.status === 'EXPIRED', 'Status is EXPIRED');
});

runTest('SESSION: checkSessionValidForCheckout passes for valid session', () => {
  const tokenResult = buildPaymentToken({ invoice: exampleInvoice, request: exampleRequest, example: true });
  const sessionResult = buildPortalSession({ token: tokenResult.token, paymentRequest: exampleRequest, invoice: exampleInvoice, example: true });
  const valid = checkSessionValidForCheckout(sessionResult.session);
  assert(valid.ok, 'Session valid for checkout');
});

runTest('SESSION: checkSessionValidForCheckout fails for expired session', () => {
  const tokenResult = buildPaymentToken({ invoice: exampleInvoice, request: exampleRequest, example: true });
  const sessionResult = buildPortalSession({ token: tokenResult.token, paymentRequest: exampleRequest, invoice: exampleInvoice, example: true });
  const expiredSession = { ...sessionResult.session, expires_at: '2020-01-01T00:00:00.000Z' };
  const valid = checkSessionValidForCheckout(expiredSession);
  assert(!valid.ok, 'Expired session not valid');
});

runTest('SESSION: buildCheckoutSessionRequest creates valid request', () => {
  const tokenResult = buildPaymentToken({ invoice: exampleInvoice, request: exampleRequest, example: true });
  const sessionResult = buildPortalSession({ token: tokenResult.token, paymentRequest: exampleRequest, invoice: exampleInvoice, example: true });
  const config = { success_url: 'https://example.com/success', cancel_url: 'https://example.com/cancel' };
  const req = buildCheckoutSessionRequest(exampleRequest, sessionResult.session, config);
  assert(req.payment_method_types.includes('card'), 'Has card payment method');
  assert(req.line_items.length === 1, 'Has one line item');
  assert(req.line_items[0].price_data.unit_amount === 204000, 'Amount in minor units');
  assert(req.metadata.nexora_payment_request_id === 'REQ-2026-9898-001', 'Has lineage metadata');
  assert(req.client_reference_id === sessionResult.session.session_id, 'Has portal session reference');
});

runTest('SESSION: normalizeStripeCheckoutSession validates response', () => {
  const fakeStripeSession = {
    id: 'cs_test_123', url: 'https://checkout.stripe.com/pay/cs_test_123',
    expires_at: Math.floor(Date.now() / 1000) + 1800, payment_status: 'unpaid', status: 'open',
    amount_total: 204000, currency: 'gbp', livemode: false, metadata: {}
  };
  const normalized = normalizeStripeCheckoutSession(fakeStripeSession);
  assert(normalized.ok, 'Normalization succeeds');
  assert(normalized.session.id === 'cs_test_123', 'Has session ID');
  assert(normalized.session.url.includes('checkout.stripe.com'), 'Has checkout URL');
});

runTest('SESSION: PORTAL_SESSION_EXAMPLE validates', () => {
  const validation = validatePortalSession(PORTAL_SESSION_EXAMPLE, { requireExampleMarker: true });
  assert(validation.failures.length === 0, 'Example session validates');
});

/* ============================================================
   STRIPE ADAPTER TESTS
   ============================================================ */

runTest('STRIPE: toMinorUnits converts GBP correctly', () => {
  assert(toMinorUnits(2040) === 204000, '2040 GBP = 204000 pence');
  assert(toMinorUnits(100.50) === 10050, '100.50 GBP = 10050 pence');
  assertThrows(() => toMinorUnits(-1), 'Rejects negative amount');
  assertThrows(() => toMinorUnits(2040, 'USD'), 'Rejects non-GBP currency');
});

runTest('STRIPE: fromMinorUnits converts correctly', () => {
  assert(fromMinorUnits(204000) === 2040, '204000 pence = 2040 GBP');
  assert(fromMinorUnits(10050) === 100.50, '10050 pence = 100.50 GBP');
});

runTest('STRIPE: deriveIdempotencyKey is deterministic', () => {
  const key1 = deriveIdempotencyKey('REQ-2026-9898-001', 'checkout');
  const key2 = deriveIdempotencyKey('REQ-2026-9898-001', 'checkout');
  assert(key1 === key2, 'Same input produces same key');
  assert(key1.length === 32, 'Key is 32 hex chars');
});

runTest('STRIPE: buildStripeMetadata includes lineage', () => {
  const meta = buildStripeMetadata(exampleRequest, 'PAY-123');
  assert(meta.nexora_payment_request_id === 'REQ-2026-9898-001', 'Has payment request ID');
  assert(meta.nexora_invoice_id === 'INV-2026-9898-001', 'Has invoice ID');
  assert(meta.nexora_provider === 'STRIPE', 'Has provider');
  assert(meta.nexora_environment === 'TEST', 'Has environment');
});

runTest('STRIPE: StripeTestAdapter.createCheckoutSession returns synthetic', async () => {
  const adapter = new StripeTestAdapter();
  const session = await adapter.createCheckoutSession(exampleRequest);
  assert(session._test_only === true, 'Marked as test only');
  assert(session.id.startsWith('cs_test_'), 'Has test checkout session ID');
  assert(session.payment_status === 'unpaid', 'Status is unpaid');
  assert(session.metadata.nexora_payment_request_id === exampleRequest.request_id, 'Has metadata');
});

runTest('STRIPE: StripeTestAdapter.createPaymentIntent returns synthetic', async () => {
  const adapter = new StripeTestAdapter();
  const pi = await adapter.createPaymentIntent(exampleRequest);
  assert(pi._test_only === true, 'Marked as test only');
  assert(pi.id.startsWith('pi_test_'), 'Has test payment intent ID');
  assert(pi.status === 'requires_payment_method', 'Status correct');
});

runTest('STRIPE: StripeTestAdapter.makeTestWebhookEvent creates valid event', () => {
  const adapter = new StripeTestAdapter();
  const event = adapter.makeTestWebhookEvent(exampleRequest, 'checkout.session.completed');
  assert(event.livemode === false, 'Test mode');
  assert(event.type === 'checkout.session.completed', 'Correct event type');
  assert(event.data.object.payment_status === 'paid', 'Payment status paid');
  assert(event.data.object.metadata.nexora_payment_request_id === exampleRequest.request_id, 'Has lineage');
});

runTest('STRIPE: StripeAdapter rejects PRODUCTION without gate', async () => {
  const adapter = new StripeAdapter({ environment: 'PRODUCTION', config: {} });
  try {
    await adapter.createCheckoutSession(exampleRequest);
    assert(false, 'Should have thrown');
  } catch (e) {
    assert(e.message.includes('production_activation_gate'), 'Requires production gate');
  }
});

/* ============================================================
   STRIPE CONFIG TESTS
   ============================================================ */

runTest('CONFIG: STRIPE_TEST_CONFIG_EXAMPLE validates', () => {
  const result = validateStripeConfig(STRIPE_TEST_CONFIG_EXAMPLE);
  assert(result.ok, 'Test config validates');
});

runTest('CONFIG: validateStripeConfig rejects live key in test', () => {
  const syntheticLiveKey = ['sk', 'live', '123456789012345678901234'].join('_');
  const config = { ...STRIPE_TEST_CONFIG_EXAMPLE, secret_key: syntheticLiveKey };
  const result = validateStripeConfig(config);
  assert(!result.ok, 'Rejects live key');
  assert(result.reasons.some(r => r.includes('live secret key')), 'Reason mentions live key');
});

runTest('CONFIG: validateStripeConfig requires production gate for live', () => {
  const config = { ...STRIPE_TEST_CONFIG_EXAMPLE, environment: 'live', production_activation_gate: false };
  const result = validateStripeConfig(config);
  assert(!result.ok, 'Rejects live without gate');
});

/* ============================================================
   WEBHOOK CONTRACT TESTS
   ============================================================ */

runTest('WEBHOOK: validateWebhookContract passes valid production event', () => {
  const event = {
    schema: 'nexora-payment-webhook/v1',
    event_id: 'a1b2c3d4e5f6a1b2c3d4e5f6',
    provider: 'STRIPE',
    environment: 'PRODUCTION',
    provider_ref: 'evt_123',
    event_type: 'checkout.session.completed',
    event_time: '2026-08-15T10:00:00.000Z',
    recorded_at: '2026-08-15T10:00:01.000Z',
    invoice_id: 'INV-2026-9898-001',
    payment_request_id: 'REQ-2026-9898-001',
    amount: 2040,
    currency: 'GBP',
    signature_verified: true,
    normalized_evidence: {},
    idempotency_key: 'idem123',
    webhook_fingerprint: '0'.repeat(64),
  };
  const result = validateWebhookContract(event);
  assert(result.ok, 'Valid production event passes');
});

runTest('WEBHOOK: validateWebhookContract rejects TEST event in production', () => {
  const event = {
    schema: 'nexora-payment-webhook/v1',
    event_id: 'a1b2c3d4e5f6a1b2c3d4e5f6',
    provider: 'STRIPE',
    environment: 'PRODUCTION',
    provider_ref: 'evt_123',
    event_type: 'checkout.session.completed',
    event_time: '2026-08-15T10:00:00.000Z',
    recorded_at: '2026-08-15T10:00:01.000Z',
    invoice_id: 'INV-2026-9898-001',
    payment_request_id: 'REQ-2026-9898-001',
    amount: 2040,
    currency: 'GBP',
    signature_verified: true,
    normalized_evidence: {},
    idempotency_key: 'idem123',
    webhook_fingerprint: '0'.repeat(64),
    _test_only: true,
  };
  const result = validateWebhookContract(event);
  assert(!result.ok, 'Rejects TEST event in production');
  assert(result.reasons.some(r => r.includes('TEST event')), 'Reason mentions TEST event');
});

runTest('WEBHOOK: validateWebhookContract rejects unverified signature', () => {
  const event = {
    schema: 'nexora-payment-webhook/v1',
    event_id: 'a1b2c3d4e5f6a1b2c3d4e5f6',
    provider: 'STRIPE',
    environment: 'PRODUCTION',
    provider_ref: 'evt_123',
    event_type: 'checkout.session.completed',
    event_time: '2026-08-15T10:00:00.000Z',
    recorded_at: '2026-08-15T10:00:01.000Z',
    invoice_id: 'INV-2026-9898-001',
    payment_request_id: 'REQ-2026-9898-001',
    amount: 2040,
    currency: 'GBP',
    signature_verified: false,
    normalized_evidence: {},
    idempotency_key: 'idem123',
    webhook_fingerprint: '0'.repeat(64),
  };
  const result = validateWebhookContract(event);
  assert(!result.ok, 'Rejects unverified signature');
  assert(result.reasons.some(r => r.includes('signature_verified')), 'Reason mentions signature');
});

runTest('WEBHOOK: validateWebhookContract rejects unsupported event type', () => {
  const event = {
    schema: 'nexora-payment-webhook/v1',
    event_id: 'a1b2c3d4e5f6a1b2c3d4e5f6',
    provider: 'STRIPE',
    environment: 'PRODUCTION',
    provider_ref: 'evt_123',
    event_type: 'customer.created',
    event_time: '2026-08-15T10:00:00.000Z',
    recorded_at: '2026-08-15T10:00:01.000Z',
    invoice_id: 'INV-2026-9898-001',
    payment_request_id: 'REQ-2026-9898-001',
    amount: 2040,
    currency: 'GBP',
    signature_verified: true,
    normalized_evidence: {},
    idempotency_key: 'idem123',
    webhook_fingerprint: '0'.repeat(64),
  };
  const result = validateWebhookContract(event);
  assert(!result.ok, 'Rejects unsupported event type');
});

runTest('WEBHOOK: deriveWebhookIdempotencyKey is deterministic', () => {
  const key1 = deriveWebhookIdempotencyKey('evt_123', 'cs_456');
  const key2 = deriveWebhookIdempotencyKey('evt_123', 'cs_456');
  assert(key1 === key2, 'Same input produces same key');
  assert(key1.length === 24, 'Key is 24 hex chars');
});

/* ============================================================
   PAYMENT VALIDATION / RECONCILIATION TESTS
   ============================================================ */

const testPaymentRequest = {
  schema: PAYMENT_REQUEST_SCHEMA,
  request_id: 'REQ-2026-9898-001',
  invoice_id: 'INV-2026-9898-001',
  invoice_version: '1.0',
  invoice_number: 'NX-INV-2026-0001',
  invoice_fingerprint: '0'.repeat(64),
  currency: 'GBP',
  amount_expected: 2040,
  amount_requested: 2040,
  payment_purpose: 'PROJECT_MILESTONE',
  provider: 'STRIPE',
  environment: 'TEST',
  created_at: '2026-08-15T09:00:00.000Z',
  status: 'CREATED',
  _example: true,
};

const testPaymentRecord = {
  schema: PAYMENT_SCHEMA,
  payment_id: 'PAY-2026-9898-001',
  payment_request_id: 'REQ-2026-9898-001',
  invoice_id: 'INV-2026-9898-001',
  provider: 'STRIPE',
  environment: 'TEST',
  status: 'PROCESSING',
  amount_expected: 2040,
  amount_received: 0,
  currency: 'GBP',
  created_at: '2026-08-15T09:00:00.000Z',
  updated_at: '2026-08-15T09:00:00.000Z',
  evidence: [],
  _example: true,
};

const testWebhookEvent = {
  schema: WEBHOOK_EVENT_SCHEMA,
  event_id: 'evt-webhook-123',
  provider: 'STRIPE',
  environment: 'TEST',
  provider_ref: 'cs_test_123',
  event_type: 'checkout.session.completed',
  event_time: '2026-08-15T10:00:00.000Z',
  recorded_at: '2026-08-15T10:00:01.000Z',
  invoice_id: 'INV-2026-9898-001',
  payment_request_id: 'REQ-2026-9898-001',
  amount: 2040,
  currency: 'GBP',
  signature_verified: true,
  normalized_evidence: { provider_ref: 'cs_test_123', stripe_event_type: 'checkout.session.completed', amount: 204000, currency: 'gbp', livemode: false },
  idempotency_key: 'idem-webhook-123',
  webhook_fingerprint: '0'.repeat(64),
  _test_only: true,
};

runTest('RECON: applyPaymentEvent records evidence', () => {
  const paymentBuild = buildPaymentRecord(exampleRequest, {
    example: true,
    createdAt: '2026-08-15T09:00:00.000Z'
  });
  assert(paymentBuild.ok, 'Payment record builds');

  const adapter = new TestPaymentAdapter();
  const providerEvidence = adapter.makeTestEvidence({
    request: exampleRequest,
    invoice: exampleInvoice,
    amount: exampleInvoice.total,
    eventTime: '2026-08-15T12:00:00.000Z'
  });
  const normalized = adapter.normalizePaymentEvidence(providerEvidence, {
    example: true,
    recordedAt: '2026-08-15T12:00:00.000Z'
  });
  assert(normalized.ok, 'Evidence normalizes');

  const evidence = normalized.event;

  const result = applyPaymentEvent(paymentBuild.payment, {
    event_type: 'RECORD_EVENT',
    evidence_ref: evidence.event_id,
    at: evidence.recorded_at
  });

  assert(result.ok, 'Apply event succeeds');
  assert(result.record.evidence.length === 1, 'One evidence recorded');
  assert(result.record.evidence[0] === evidence.event_id, 'Evidence has event ID');
  assert(result.record.status === 'PROCESSING', 'Status remains PROCESSING');
});

runTest('RECON: duplicate evidence rejected by reconciliation idempotency', () => {
  const adapter = new TestPaymentAdapter();
  const providerEvidence = adapter.makeTestEvidence({
    request: exampleRequest,
    invoice: exampleInvoice,
    amount: exampleInvoice.total,
    eventTime: '2026-08-15T12:00:00.000Z'
  });
  const normalized = adapter.normalizePaymentEvidence(providerEvidence, {
    example: true
  });
  assert(normalized.ok, 'Evidence normalizes for duplicate test');

  const evidence = normalized.event;

  const result = adapter.reconcilePayment(evidence, {
    invoice: exampleInvoice,
    request: exampleRequest,
    seenEventIds: new Set([evidence.event_id])
  });

  assert(!result.ok, 'Rejects duplicate');
  assert(result.outcome === 'DUPLICATE_EVIDENCE', 'Outcome is DUPLICATE_EVIDENCE');
});

runTest('RECON: TestPaymentAdapter reconciles EXACT', () => {
  const adapter = new TestPaymentAdapter();
  const raw = adapter.makeTestEvidence({
    request: exampleRequest,
    invoice: exampleInvoice,
    amount: exampleInvoice.total
  });
  const normalized = adapter.normalizePaymentEvidence(raw, { example: true });
  const result = adapter.reconcilePayment(normalized.event, {
    invoice: exampleInvoice,
    request: exampleRequest,
    seenEventIds: new Set()
  });

  assert(result.ok, 'Reconcile succeeds');
  assert(result.outcome === 'EXACT', 'Outcome is EXACT');
});

runTest('RECON: TestPaymentAdapter rejects partial amount as WRONG_AMOUNT', () => {
  const adapter = new TestPaymentAdapter();
  const raw = adapter.makeTestEvidence({
    request: exampleRequest,
    invoice: exampleInvoice,
    amount: 1000
  });
  const normalized = adapter.normalizePaymentEvidence(raw, { example: true });
  const result = adapter.reconcilePayment(normalized.event, {
    invoice: exampleInvoice,
    request: exampleRequest,
    seenEventIds: new Set()
  });

  assert(!result.ok, 'Partial amount not silently settled');
  assert(result.outcome === 'WRONG_AMOUNT', 'Outcome is WRONG_AMOUNT');
});

runTest('RECON: TestPaymentAdapter detects WRONG_AMOUNT', () => {
  const adapter = new TestPaymentAdapter();
  const raw = adapter.makeTestEvidence({
    request: exampleRequest,
    invoice: exampleInvoice,
    amount: 1500
  });
  const normalized = adapter.normalizePaymentEvidence(raw, { example: true });
  const result = adapter.reconcilePayment(normalized.event, {
    invoice: exampleInvoice,
    request: exampleRequest,
    seenEventIds: new Set()
  });

  assert(!result.ok, 'Wrong amount rejected');
  assert(result.outcome === 'WRONG_AMOUNT', 'Outcome is WRONG_AMOUNT');
});

runTest('RECON: TestPaymentAdapter detects OVERPAYMENT', () => {
  const adapter = new TestPaymentAdapter();
  const raw = adapter.makeTestEvidence({
    request: exampleRequest,
    invoice: exampleInvoice,
    amount: 5000
  });
  const normalized = adapter.normalizePaymentEvidence(raw, { example: true });
  const result = adapter.reconcilePayment(normalized.event, {
    invoice: exampleInvoice,
    request: exampleRequest,
    seenEventIds: new Set()
  });

  assert(!result.ok, 'Overpayment requires review');
  assert(result.outcome === 'OVERPAYMENT', 'Outcome is OVERPAYMENT');
});

runTest('RECON: applyReconciliation updates payment status', () => {
  const paymentBuild = buildPaymentRecord(exampleRequest, {
    example: true,
    createdAt: '2026-08-15T09:00:00.000Z'
  });

  const adapter = new TestPaymentAdapter();
  const raw = adapter.makeTestEvidence({
    request: exampleRequest,
    invoice: exampleInvoice,
    amount: exampleInvoice.total
  });
  const normalized = adapter.normalizePaymentEvidence(raw, { example: true });

  const adapterOutcome = adapter.reconcilePayment(normalized.event, {
    invoice: exampleInvoice,
    request: exampleRequest,
    seenEventIds: new Set()
  });

  const recBuild = buildReconciliation({
    invoice: exampleInvoice,
    request: exampleRequest,
    evidence: normalized.event,
    adapterOutcome,
    opts: {
      paymentId: paymentBuild.payment.payment_id,
      example: true,
      at: '2026-08-15T12:30:00.000Z'
    }
  });

  const result = applyReconciliation(
    paymentBuild.payment,
    exampleInvoice,
    recBuild.reconciliation,
    { at: '2026-08-15T12:30:00.000Z' }
  );

  assert(result.ok, 'Apply reconciliation succeeds');
  assert(result.record.status === 'PAID', 'Status updated to PAID');
});

runTest('RECON: applyReconciliation does not mark PAID for WRONG_AMOUNT', () => {
  const paymentBuild = buildPaymentRecord(exampleRequest, {
    example: true,
    createdAt: '2026-08-15T09:00:00.000Z'
  });

  const adapter = new TestPaymentAdapter();
  const raw = adapter.makeTestEvidence({
    request: exampleRequest,
    invoice: exampleInvoice,
    amount: 1500
  });
  const normalized = adapter.normalizePaymentEvidence(raw, { example: true });

  const adapterOutcome = adapter.reconcilePayment(normalized.event, {
    invoice: exampleInvoice,
    request: exampleRequest,
    seenEventIds: new Set()
  });

  const recBuild = buildReconciliation({
    invoice: exampleInvoice,
    request: exampleRequest,
    evidence: normalized.event,
    adapterOutcome,
    opts: {
      paymentId: paymentBuild.payment.payment_id,
      example: true
    }
  });

  const result = applyReconciliation(
    paymentBuild.payment,
    exampleInvoice,
    recBuild.reconciliation
  );

  assert(!result.ok, 'Wrong amount reconciliation rejected');
  assert(paymentBuild.payment.status !== 'PAID', 'Original payment not marked PAID');
});

runTest('RECON: sha256hex produces valid hash', () => {
  const hash = sha256hex('test');
  assert(hash.length === 64, 'Hash is 64 hex chars');
  assert(/^[0-9a-f]{64}$/.test(hash), 'Hash is valid hex');
});

runTest('RECON: buildWebhookFingerprint is deterministic', () => {
  const fp1 = buildWebhookFingerprint(testWebhookEvent);
  const fp2 = buildWebhookFingerprint(testWebhookEvent);
  assert(fp1 === fp2, 'Same event produces same fingerprint');
  assert(fp1.length === 64, 'Fingerprint is 64 hex chars');
});

runTest('RECON: verifyWebhookFingerprint validates', () => {
  const validWebhook = {
    ...testWebhookEvent,
    webhook_fingerprint: buildWebhookFingerprint(testWebhookEvent)
  };
  assert(verifyWebhookFingerprint(validWebhook).ok, 'Valid fingerprint verifies');

  const tamperedWebhook = {
    ...validWebhook,
    amount: validWebhook.amount + 1
  };
  assert(!verifyWebhookFingerprint(tamperedWebhook).ok, 'Invalid fingerprint rejected');
});

/* ============================================================
   INVOICE INTEGRATION TESTS
   ============================================================ */

runTest('INVOICE: validateInvoiceRecord passes example', () => {
  const invoiceFile = join(OPS_DIR, 'billing', 'examples', 'invoice-issued-example.json');
  const invoice = JSON.parse(readFileSync(invoiceFile, 'utf8'));
  const result = validateInvoiceRecord(invoice);
  assert(result.failures.length === 0, 'Example invoice validates');
});

runTest('INVOICE: buildInvoiceRecord creates valid invoice', () => {
  const scheduleFile = join(
    OPS_DIR,
    'billing',
    'examples',
    'billing-schedule-example.json'
  );

  const schedule = JSON.parse(readFileSync(scheduleFile, 'utf8'));

  const result = buildInvoiceRecord(
    schedule,
    0,
    {
      issue: true,
      issueDate: '2026-08-15',
      createdAt: '2026-08-15T09:00:00.000Z',
      example: true,
      client: {
        name: 'Example Client',
        company: 'Example Clinic Ltd'
      },
      project: {
        title: 'Grow Website — Example Clinic'
      }
    }
  );

  assert(result.ok, 'Build succeeds');
  assert(result.record.invoice_id, 'Has invoice ID');
  assert(result.record.invoice_fingerprint, 'Has fingerprint');

  const validation = validateInvoiceRecord(result.record);
  assert(validation.failures.length === 0, 'Built invoice validates');
});

/* ============================================================
   END-TO-END PIPELINE TEST
   ============================================================ */

runTest('E2E: Complete token → session → checkout → webhook → reconciliation flow', () => {
  const tokenResult = buildPaymentToken({
    invoice: exampleInvoice,
    request: exampleRequest,
    example: true
  });
  assert(tokenResult.ok, '1. Token created');

  const sessionResult = buildPortalSession({
    token: tokenResult.token,
    paymentRequest: exampleRequest,
    invoice: exampleInvoice,
    example: true
  });
  assert(sessionResult.ok, '2. Portal session created');

  const fakeStripeSession = {
    id: 'cs_test_e2e',
    url: 'https://checkout.stripe.com/pay/cs_test_e2e',
    expires_at: Math.floor(Date.now() / 1000) + 1800,
    payment_status: 'unpaid',
    status: 'open',
    amount_total: Math.round(exampleRequest.amount_requested * 100),
    currency: exampleRequest.currency.toLowerCase(),
    livemode: false,
    metadata: {}
  };

  const attached = attachCheckoutSession(
    sessionResult.session,
    fakeStripeSession
  );
  assert(attached.ok, '3. Checkout session attached');

  const redirected = markCustomerRedirected(attached.session);
  assert(redirected.ok, '4. Customer redirected');

  const webhookReceived = markWebhookReceived(
    redirected.session,
    { event_type: 'checkout.session.completed' }
  );
  assert(webhookReceived.ok, '5. Webhook received');

  assert(
    webhookReceived.session.audit_events.some(
      e => e.detail.includes('WEBHOOK RECEIVED != PAID')
    ),
    '5a. Audit states WEBHOOK RECEIVED != PAID'
  );

  const paymentBuild = buildPaymentRecord(exampleRequest, {
    example: true,
    createdAt: '2026-08-15T09:00:00.000Z'
  });
  assert(paymentBuild.ok, '6. Governed payment record created');

  let paymentRecord = paymentBuild.payment;

  const adapter = new TestPaymentAdapter();

  const providerEvidence = adapter.makeTestEvidence({
    request: exampleRequest,
    invoice: exampleInvoice,
    amount: exampleInvoice.total,
    eventTime: '2026-08-15T14:00:00.000Z'
  });

  const normalized = adapter.normalizePaymentEvidence(providerEvidence, {
    example: true,
    recordedAt: '2026-08-15T14:00:00.000Z'
  });
  assert(normalized.ok, '7. TEST evidence normalized');

  const evidence = normalized.event;

  const eventApplied = applyPaymentEvent(paymentRecord, {
    event_type: 'RECORD_EVENT',
    evidence_ref: evidence.event_id,
    at: evidence.recorded_at
  });
  assert(eventApplied.ok, '8. Payment evidence recorded');

  paymentRecord = eventApplied.record;

  assert(
    paymentRecord.status === 'PROCESSING',
    '8a. Payment remains PROCESSING before reconciliation'
  );

  const adapterOutcome = adapter.reconcilePayment(
    evidence,
    {
      invoice: exampleInvoice,
      request: exampleRequest,
      seenEventIds: new Set()
    }
  );

  assert(adapterOutcome.ok, '9. Reconciliation runs');
  assert(adapterOutcome.outcome === 'EXACT', '9a. Outcome EXACT');

  const reconciliationBuild = buildReconciliation({
    invoice: exampleInvoice,
    request: exampleRequest,
    evidence,
    adapterOutcome,
    opts: {
      paymentId: paymentRecord.payment_id,
      example: true,
      at: '2026-08-15T14:30:00.000Z'
    }
  });

  assert(
    reconciliationBuild.ok,
    '10. Governed reconciliation record created'
  );

  const reconApplied = applyReconciliation(
    paymentRecord,
    exampleInvoice,
    reconciliationBuild.reconciliation,
    {
      at: '2026-08-15T14:30:00.000Z'
    }
  );

  assert(reconApplied.ok, '11. Reconciliation applied');

  assert(
    reconApplied.record.status === 'PAID',
    '11a. Payment marked PAID only after governed reconciliation'
  );

  const reconciled = markReconciled(
    webhookReceived.session,
    reconciliationBuild.reconciliation
  );

  assert(reconciled.ok, '12. Session marked RECONCILED');

  assert(
    reconciled.session.status === 'RECONCILED',
    '12a. Session status RECONCILED'
  );
});

runTest('SECURITY: Token ID has sufficient entropy (256 bits)', () => {
  const ids = new Set();
  for (let i = 0; i < 1000; i++) {
    ids.add(generateTokenId());
  }
  assert(ids.size === 1000, '1000 tokens all unique');
});

runTest('SECURITY: Session ID has sufficient entropy', () => {
  const ids = new Set();
  for (let i = 0; i < 1000; i++) {
    ids.add(generatePortalSessionId());
  }
  assert(ids.size === 1000, '1000 sessions all unique');
});

runTest('SECURITY: Token single-use enforced', () => {
  const tokenResult = buildPaymentToken({ invoice: exampleInvoice, request: exampleRequest, example: true });
  const used1 = markTokenUsed(tokenResult.token);
  assert(used1.ok, 'First use succeeds');
  const used2 = markTokenUsed(used1.token);
  assert(!used2.ok, 'Second use fails');
});

runTest('SECURITY: Redirect never marks PAID', () => {
  const tokenResult = buildPaymentToken({ invoice: exampleInvoice, request: exampleRequest, example: true });
  const sessionResult = buildPortalSession({ token: tokenResult.token, paymentRequest: exampleRequest, invoice: exampleInvoice, example: true });
  const fakeStripeSession = {
    id: 'cs_test_123', url: 'https://checkout.stripe.com/pay/cs_test_123',
    expires_at: Math.floor(Date.now() / 1000) + 1800, payment_status: 'unpaid', status: 'open',
    amount_total: 204000, currency: 'gbp', livemode: false, metadata: {}
  };
  const attached = attachCheckoutSession(sessionResult.session, fakeStripeSession);
  const redirected = markCustomerRedirected(attached.session);
  assert(redirected.session.status === 'CUSTOMER_REDIRECTED', 'Redirect only marks CUSTOMER_REDIRECTED');
  assert(redirected.session.status !== 'RECONCILED', 'Redirect does not mark RECONCILED');
  assert(redirected.session.status !== 'PAID', 'Redirect does not mark PAID');
});

runTest('SECURITY: Webhook receipt never marks PAID', () => {
  const tokenResult = buildPaymentToken({ invoice: exampleInvoice, request: exampleRequest, example: true });
  const sessionResult = buildPortalSession({ token: tokenResult.token, paymentRequest: exampleRequest, invoice: exampleInvoice, example: true });
  const fakeStripeSession = {
    id: 'cs_test_123', url: 'https://checkout.stripe.com/pay/cs_test_123',
    expires_at: Math.floor(Date.now() / 1000) + 1800, payment_status: 'unpaid', status: 'open',
    amount_total: 204000, currency: 'gbp', livemode: false, metadata: {}
  };
  const attached = attachCheckoutSession(sessionResult.session, fakeStripeSession);
  const redirected = markCustomerRedirected(attached.session);
  const webhookReceived = markWebhookReceived(redirected.session, { event_type: 'checkout.session.completed' });
  assert(webhookReceived.session.status === 'WEBHOOK_RECEIVED', 'Webhook only marks WEBHOOK_RECEIVED');
  assert(webhookReceived.session.status !== 'RECONCILED', 'Webhook does not mark RECONCILED');
  assert(webhookReceived.session.status !== 'PAID', 'Webhook does not mark PAID');
  assert(webhookReceived.session.audit_events.some(e => e.detail.includes('WEBHOOK RECEIVED != PAID')), 'Audit explicitly states WEBHOOK RECEIVED != PAID');
});

runTest('SECURITY: Only reconciliation marks RECONCILED', () => {
  const tokenResult = buildPaymentToken({ invoice: exampleInvoice, request: exampleRequest, example: true });
  const sessionResult = buildPortalSession({ token: tokenResult.token, paymentRequest: exampleRequest, invoice: exampleInvoice, example: true });
  const fakeStripeSession = {
    id: 'cs_test_123', url: 'https://checkout.stripe.com/pay/cs_test_123',
    expires_at: Math.floor(Date.now() / 1000) + 1800, payment_status: 'unpaid', status: 'open',
    amount_total: 204000, currency: 'gbp', livemode: false, metadata: {}
  };
  const attached = attachCheckoutSession(sessionResult.session, fakeStripeSession);
  const redirected = markCustomerRedirected(attached.session);
  const webhookReceived = markWebhookReceived(redirected.session, { event_type: 'checkout.session.completed' });
  const reconciled = markReconciled(webhookReceived.session, { outcome: 'EXACT' });
  assert(reconciled.session.status === 'RECONCILED', 'Only reconcile marks RECONCILED');
});

runTest('SECURITY: Amount/currency derives from governed records', () => {
  const checkoutReq = buildCheckoutSessionRequest(exampleRequest, PORTAL_SESSION_EXAMPLE, {
    success_url: 'https://example.com/success', cancel_url: 'https://example.com/cancel'
  });
  assert(checkoutReq.line_items[0].price_data.unit_amount === 204000, 'Amount from request');
  assert(checkoutReq.line_items[0].price_data.currency === 'gbp', 'Currency from request');
});

runTest('SECURITY: Metadata lineage in checkout request', () => {
  const checkoutReq = buildCheckoutSessionRequest(exampleRequest, PORTAL_SESSION_EXAMPLE, {
    success_url: 'https://example.com/success', cancel_url: 'https://example.com/cancel'
  });
  assert(checkoutReq.metadata.nexora_payment_request_id === exampleRequest.request_id, 'Has payment request ID');
  assert(checkoutReq.metadata.nexora_invoice_id === exampleRequest.invoice_id, 'Has invoice ID');
  assert(checkoutReq.metadata.nexora_provider === 'STRIPE', 'Has provider');
  assert(checkoutReq.metadata.nexora_environment === 'TEST', 'Has environment');
  assert(checkoutReq.client_reference_id === PORTAL_SESSION_EXAMPLE.session_id, 'Has portal session ref');
});

runTest('SECURITY: Idempotency keys are deterministic', () => {
  const key1 = deriveIdempotencyKey('REQ-2026-9898-001', 'checkout');
  const key2 = deriveIdempotencyKey('REQ-2026-9898-001', 'checkout');
  assert(key1 === key2, 'Checkout idempotency deterministic');
  const key3 = deriveIdempotencyKey('REQ-2026-9898-001', 'payment_intent');
  assert(key3 !== key1, 'Different operation = different key');
});

runTest('SECURITY: TEST events rejected in PRODUCTION adapter', () => {
  const prodAdapter = new StripeAdapter({ environment: 'PRODUCTION', config: { production_activation_gate: true } });
  const testEvent = { id: 'evt_test_123', type: 'checkout.session.completed', livemode: false, created: Date.now()/1000, data: { object: { id: 'cs_test_123', amount_total: 204000, currency: 'gbp', metadata: {} } } };
  const result = prodAdapter.normalizeWebhookEvent(testEvent);
  assert(!result.ok, 'Rejects TEST event in PRODUCTION');
  assert(result.reasons.some(r => r.includes('Test Stripe event rejected')), 'Reason mentions test event rejected');
});

runTest('SECURITY: PRODUCTION events rejected in TEST adapter', () => {
  const testAdapter = new StripeTestAdapter();
  const liveEvent = { id: 'evt_live_123', type: 'checkout.session.completed', livemode: true, created: Date.now()/1000, data: { object: { id: 'cs_live_123', amount_total: 204000, currency: 'gbp', metadata: {} } } };
  const result = testAdapter.normalizeWebhookEvent(liveEvent);
  assert(!result.ok, 'Rejects LIVE event in TEST');
  assert(result.reasons.some(r => r.includes('Live Stripe event rejected')), 'Reason mentions live event rejected');
});

/* ============================================================
   EXAMPLE FIXTURES TESTS
   ============================================================ */

runTest('FIXTURES: TOKEN_EXAMPLE has valid structure', () => {
  assert(TOKEN_EXAMPLE.schema === TOKEN_SCHEMA, 'Correct schema');
  assert(TOKEN_ID_RE.test(TOKEN_EXAMPLE.token_id), 'Valid token_id format');
  assert(TOKEN_EXAMPLE.invoice_id === 'INV-2026-9898-001', 'Correct invoice');
  assert(TOKEN_EXAMPLE.payment_request_id === 'REQ-2026-9898-001', 'Correct request');
  assert(TOKEN_EXAMPLE.amount === 2040, 'Correct amount');
  assert(TOKEN_EXAMPLE.currency === 'GBP', 'Correct currency');
  assert(TOKEN_STATUS.includes(TOKEN_EXAMPLE.status), 'Valid status');
  assert(TOKEN_EXAMPLE._example === true, 'Marked as example');
});

runTest('FIXTURES: PORTAL_SESSION_EXAMPLE has valid structure', () => {
  assert(PORTAL_SESSION_EXAMPLE.schema === PORTAL_SESSION_SCHEMA, 'Correct schema');
  assert(PORTAL_SESSION_ID_RE.test(PORTAL_SESSION_EXAMPLE.session_id), 'Valid session_id format');
  assert(PORTAL_SESSION_EXAMPLE.token_id === TOKEN_EXAMPLE.token_id, 'Links to token example');
  assert(PORTAL_SESSION_EXAMPLE.invoice_id === 'INV-2026-9898-001', 'Correct invoice');
  assert(PORTAL_SESSION_EXAMPLE.amount === 2040, 'Correct amount');
  assert(PORTAL_SESSION_STATUS.includes(PORTAL_SESSION_EXAMPLE.status), 'Valid status');
  assert(PORTAL_SESSION_EXAMPLE._example === true, 'Marked as example');
});

runTest('FIXTURES: STRIPE_TEST_CONFIG_EXAMPLE validates', () => {
  const result = validateStripeConfig(STRIPE_TEST_CONFIG_EXAMPLE);
  assert(result.ok, 'Test config validates');
  assert(STRIPE_TEST_CONFIG_EXAMPLE._example === true, 'Marked as example');
});

/* ============================================================
   SUMMARY
   ============================================================ */

console.log('\n' + '='.repeat(60));
console.log(`PROP.11 VALIDATION SUMMARY`);
console.log('='.repeat(60));
console.log(`Passed: ${results.passed}`);
console.log(`Failed: ${results.failed}`);
console.log(`Total:  ${results.passed + results.failed}`);

if (results.failed > 0) {
  console.log('\nFAILED TESTS:');
  results.tests.filter(t => t.status === 'FAIL' || t.status === 'ERROR').forEach(t => {
    console.log(`  - ${t.name}${t.error ? ': ' + t.error : ''}`);
  });
  process.exit(1);
} else {
  console.log('\n✓ ALL TESTS PASSED');
  process.exit(0);
}