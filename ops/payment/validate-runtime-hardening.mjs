/* Nexora — PROP.12 Payment Runtime Hardening Validator
   Validates storage abstraction, webhook verification, idempotency,
   and governance invariants (redirect != PAID, webhook != PAID, etc.). */

import { readFileSync, writeFileSync, existsSync, mkdirSync, readdirSync, unlinkSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash, timingSafeEqual } from 'node:crypto';

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = join(__dirname, '..', '..');

// Import PROP.11 modules
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
  PAYMENT_SCHEMA, PAYMENT_REQUEST_SCHEMA, WEBHOOK_EVENT_SCHEMA, RECONCILIATION_SCHEMA,
  PAYMENT_STATUSES, PAYMENT_ENVIRONMENTS, PROVIDER_IDS,
  buildPaymentRequest, buildPaymentRecord, applyPaymentEvent, applyReconciliation,
  buildReconciliation,
  TestPaymentAdapter, PaymentProviderAdapter,
  sha256hex, buildWebhookFingerprint, verifyWebhookFingerprint,
  validatePaymentRecord, validateWebhookEvent
} from './payment-validation.mjs';

import {
  INVOICE_SCHEMA, INVOICE_STATUSES, INVOICE_TYPES,
  buildInvoiceRecord, validateInvoiceRecord
} from '../billing/billing-validation.mjs';

// Import PROP.12 modules
import {
  createStorageAdapter,
  ProductionStorageAdapter,
  validateStorageAdapter,
  PRIVATE_DIR
} from './runtime-storage.mjs';
import { TestFileStorageAdapter } from './runtime-storage-file-node.mjs';

import {
  createWebhookVerifier,
  TestDeterministicVerifier,
  StripeOfficialVerifier,
  validateWebhookVerifier,
  constantTimeEqual,
  hmacSha256Hex
} from './webhook-verifier.mjs';

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

async function runTest(name, fn) {
  console.log(`\n▸ ${name}`);
  try {
    await fn();
  } catch (e) {
    results.failed++;
    results.tests.push({ name, status: 'ERROR', error: e.message });
    console.error(`  ✗ ${name} — ${e.message}`);
  }
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

/* Test fixtures */
const exampleInvoice = JSON.parse(
  readFileSync(join(root, 'ops/billing/examples/invoice-issued-example.json'), 'utf8')
);

const exampleRequest = JSON.parse(
  readFileSync(join(root, 'ops/payment/examples/payment-request-example.json'), 'utf8')
);

/* ============================================================
   PROP.12 RUNTIME STORAGE TESTS
   ============================================================ */

console.log('\n=== PROP.12 RUNTIME STORAGE TESTS ===\n');

runTest('STORAGE: TestFileStorageAdapter creates session', async () => {
  const adapter = new TestFileStorageAdapter({ baseDir: join(PRIVATE_DIR, 'test-runtime') });
  const session = {
    schema: PORTAL_SESSION_SCHEMA,
    session_id: 'PSS-TESTSTORAGE00000000000000000000000000000000000000000000',
    token_id: TOKEN_EXAMPLE.token_id,
    invoice_id: 'INV-2026-9898-001',
    invoice_number: 'NX-INV-2026-0001',
    payment_request_id: 'REQ-2026-9898-001',
    amount: 2040,
    currency: 'GBP',
    status: 'CREATED',
    stripe_checkout_session_id: null,
    stripe_checkout_session_url: null,
    stripe_checkout_session_expires_at: null,
    created_at: '2026-08-15T09:00:00.000Z',
    expires_at: '2026-08-15T09:30:00.000Z',
    completed_at: null,
    failed_at: null,
    failure_reason: null,
    audit_events: [],
    _example: true
  };

  const result = await adapter.createSession(session);
  assert(result.ok, 'createSession returns ok');
  assert(result.session.session_id === session.session_id, 'session_id preserved');

  // Verify it's persisted
  const retrieved = await adapter.getSession(session.session_id);
  assert(retrieved !== null, 'session persisted and retrievable');
  assert(retrieved.session_id === session.session_id, 'retrieved session_id matches');
});

runTest('STORAGE: TestFileStorageAdapter updates session', async () => {
  const adapter = new TestFileStorageAdapter({ baseDir: join(PRIVATE_DIR, 'test-runtime') });
  const session = {
    schema: PORTAL_SESSION_SCHEMA,
    session_id: 'PSS-TESTSTORAGE00000000000000000000000000000000000000000001',
    token_id: TOKEN_EXAMPLE.token_id,
    invoice_id: 'INV-2026-9898-001',
    invoice_number: 'NX-INV-2026-0001',
    payment_request_id: 'REQ-2026-9898-001',
    amount: 2040,
    currency: 'GBP',
    status: 'CREATED',
    stripe_checkout_session_id: null,
    stripe_checkout_session_url: null,
    stripe_checkout_session_expires_at: null,
    created_at: '2026-08-15T09:00:00.000Z',
    expires_at: '2026-08-15T09:30:00.000Z',
    completed_at: null,
    failed_at: null,
    failure_reason: null,
    audit_events: [],
    _example: true
  };

  await adapter.createSession(session);

  session.status = 'CHECKOUT_CREATED';
  session.stripe_checkout_session_id = 'cs_test_123';
  session.audit_events = [{ event: 'checkout_session_attached', at: '2026-08-15T09:01:00.000Z', event_id: 'evt001', detail: 'Attached' }];

  const result = await adapter.updateSession(session);
  assert(result.ok, 'updateSession returns ok');

  const retrieved = await adapter.getSession(session.session_id);
  assert(retrieved.status === 'CHECKOUT_CREATED', 'status updated');
  assert(retrieved.stripe_checkout_session_id === 'cs_test_123', 'checkout session ID updated');
});

runTest('STORAGE: TestFileStorageAdapter findSessionByCheckoutSessionId', async () => {
  const adapter = new TestFileStorageAdapter({ baseDir: join(PRIVATE_DIR, 'test-runtime') });
  const session = {
    schema: PORTAL_SESSION_SCHEMA,
    session_id: 'PSS-TESTSTORAGE00000000000000000000000000000000000000000002',
    token_id: TOKEN_EXAMPLE.token_id,
    invoice_id: 'INV-2026-9898-001',
    invoice_number: 'NX-INV-2026-0001',
    payment_request_id: 'REQ-2026-9898-001',
    amount: 2040,
    currency: 'GBP',
    status: 'CHECKOUT_CREATED',
    stripe_checkout_session_id: 'cs_test_findme',
    stripe_checkout_session_url: 'https://checkout.stripe.com/pay/cs_test_findme',
    stripe_checkout_session_expires_at: '2026-08-15T09:30:00.000Z',
    created_at: '2026-08-15T09:00:00.000Z',
    expires_at: '2026-08-15T09:30:00.000Z',
    completed_at: null,
    failed_at: null,
    failure_reason: null,
    audit_events: [],
    _example: true
  };

  await adapter.createSession(session);
  const found = await adapter.findSessionByCheckoutSessionId('cs_test_findme');
  assert(found !== null, 'session found by checkout_session_id');
  assert(found.session_id === session.session_id, 'correct session returned');
});

runTest('STORAGE: TestFileStorageAdapter creates payment record', async () => {
  const adapter = new TestFileStorageAdapter({ baseDir: join(PRIVATE_DIR, 'test-runtime') });
  const payment = {
    schema: PAYMENT_SCHEMA,
    payment_id: 'PAY-2026-9898-002',
    payment_request_id: 'REQ-2026-9898-001',
    invoice_id: 'INV-2026-9898-001',
    provider: 'STRIPE',
    environment: 'TEST',
    status: 'CREATED',
    amount_expected: 2040,
    amount_received: 0,
    amount_remaining: 2040,
    currency: 'GBP',
    created_at: '2026-08-15T09:00:00.000Z',
    updated_at: '2026-08-15T09:00:00.000Z',
    evidence: [],
    audit_events: [],
    _example: true
  };

  const result = await adapter.createPayment(payment);
  assert(result.ok, 'createPayment returns ok');

  const retrieved = await adapter.getPayment(payment.payment_id);
  assert(retrieved !== null, 'payment persisted and retrievable');
  assert(retrieved.payment_id === payment.payment_id, 'payment_id matches');
});

runTest('STORAGE: TestFileStorageAdapter idempotency check/set', async () => {
  const adapter = new TestFileStorageAdapter({ baseDir: join(PRIVATE_DIR, 'test-runtime') });

  const check1 = await adapter.checkIdempotency('idem-key-test-001');
  assert(check1.exists === false, 'idempotency key initially does not exist');

  await adapter.setIdempotency('idem-key-test-001', 'evt-123456789012345678901234');

  const check2 = await adapter.checkIdempotency('idem-key-test-001');
  assert(check2.exists === true, 'idempotency key now exists');
  assert(check2.eventId === 'evt-123456789012345678901234', 'event_id preserved');
});

runTest('STORAGE: createStorageAdapter factory returns TEST adapter for TEST env', async () => {
  const adapter = await createStorageAdapter({ environment: 'TEST', config: { baseDir: join(PRIVATE_DIR, 'test-factory') } });
  assert(adapter instanceof TestFileStorageAdapter, 'returns TestFileStorageAdapter for TEST');
  const validation = validateStorageAdapter(adapter, 'TEST');
  assert(validation.ok, 'validateStorageAdapter passes for TEST adapter');
});

runTest('STORAGE: createStorageAdapter factory throws for PRODUCTION without config', () => {
  assertThrows(
    () => createStorageAdapter({ environment: 'PRODUCTION', config: {} }),
    'throws when PRODUCTION config missing sharedStorageClient'
  );
});

runTest('STORAGE: validateStorageAdapter rejects TestFileStorageAdapter in PRODUCTION', () => {
  const adapter = new TestFileStorageAdapter();
  const validation = validateStorageAdapter(adapter, 'PRODUCTION');
  assert(!validation.ok, 'rejects TEST adapter in PRODUCTION');
  assert(validation.reason.includes('TestFileStorageAdapter'), 'reason mentions adapter name');
});

runTest('STORAGE: State shared/recoverable through configured adapter (not handler-local Map)', async () => {
  // Simulate two separate "handler instances" using same adapter
  const adapter1 = new TestFileStorageAdapter({ baseDir: join(PRIVATE_DIR, 'test-shared') });
  const adapter2 = new TestFileStorageAdapter({ baseDir: join(PRIVATE_DIR, 'test-shared') });

  const session = {
    schema: PORTAL_SESSION_SCHEMA,
    session_id: 'PSS-TESTSHARED000000000000000000000000000000000000000000000',
    token_id: TOKEN_EXAMPLE.token_id,
    invoice_id: 'INV-2026-9898-001',
    invoice_number: 'NX-INV-2026-0001',
    payment_request_id: 'REQ-2026-9898-001',
    amount: 2040,
    currency: 'GBP',
    status: 'CREATED',
    stripe_checkout_session_id: null,
    stripe_checkout_session_url: null,
    stripe_checkout_session_expires_at: null,
    created_at: '2026-08-15T09:00:00.000Z',
    expires_at: '2026-08-15T09:30:00.000Z',
    completed_at: null,
    failed_at: null,
    failure_reason: null,
    audit_events: [],
    _example: true
  };

  await adapter1.createSession(session);

  // Second handler retrieves state created by first
  const retrieved = await adapter2.getSession(session.session_id);
  assert(retrieved !== null, 'state recoverable through adapter');
  assert(retrieved.session_id === session.session_id, 'correct session recovered');
});

/* ============================================================
   PROP.12 WEBHOOK VERIFIER TESTS
   ============================================================ */

console.log('\n=== PROP.12 WEBHOOK VERIFIER TESTS ===\n');

runTest('VERIFIER: TestDeterministicVerifier accepts valid-format test signature', async () => {
  const verifier = new TestDeterministicVerifier();
  const result = await verifier.verify(
    '{"id":"evt_test_123","type":"checkout.session.completed"}',
    't=1234567890,v1=abc123def456',
    'whsec_test'
  );
  assert(result.ok === true, 'verify returns ok');
  assert(result.verified === true, 'verified is true');
  assert(result.environment === 'TEST', 'environment is TEST');
  assert(result.note.includes('TEST MODE'), 'note indicates TEST mode');
});

runTest('VERIFIER: TestDeterministicVerifier rejects missing signature', async () => {
  const verifier = new TestDeterministicVerifier();
  const result = await verifier.verify('{}', '', 'whsec_test');
  assert(result.ok === false, 'rejects missing signature');
  assert(result.verified === false, 'verified is false');
  assert(result.reason.includes('Missing Stripe-Signature'), 'reason mentions missing header');
});

runTest('VERIFIER: TestDeterministicVerifier rejects malformed signature', async () => {
  const verifier = new TestDeterministicVerifier();
  const result = await verifier.verify('{}', 'invalid-signature', 'whsec_test');
  assert(result.ok === false, 'rejects malformed signature');
  assert(result.verified === false, 'verified is false');
  assert(result.reason.includes('Invalid test signature format'), 'reason mentions invalid format');
});

runTest('VERIFIER: createWebhookVerifier factory returns TEST adapter for TEST env', () => {
  const verifier = createWebhookVerifier({ environment: 'TEST', config: {} });
  assert(verifier instanceof TestDeterministicVerifier, 'returns TestDeterministicVerifier for TEST');
  const validation = validateWebhookVerifier(verifier, 'TEST');
  assert(validation.ok, 'validateWebhookVerifier passes for TEST verifier');
});

runTest('VERIFIER: createWebhookVerifier factory throws for PRODUCTION without webhookSecret', () => {
  assertThrows(
    () => createWebhookVerifier({ environment: 'PRODUCTION', config: {} }),
    'throws when PRODUCTION config missing webhookSecret'
  );
});

runTest('VERIFIER: validateWebhookVerifier rejects TestDeterministicVerifier in PRODUCTION', () => {
  const verifier = new TestDeterministicVerifier();
  const validation = validateWebhookVerifier(verifier, 'PRODUCTION');
  assert(!validation.ok, 'rejects TEST verifier in PRODUCTION');
  assert(validation.reason.includes('TestDeterministicVerifier'), 'reason mentions verifier name');
});

runTest('VERIFIER: StripeOfficialVerifier requires Stripe SDK (fails closed without)', async () => {
  // In this test environment, stripe SDK is not available
  // The verifier constructor should not throw, but verify should fail
  const verifier = new StripeOfficialVerifier({
    config: { webhookSecret: 'whsec_test123456789012345678901234', secretKey: 'sk_live_test' }
  });
  const result = await verifier.verify('{}', 't=123,v1=abc', 'whsec_test');
  assert(result.ok === false, 'verify fails without Stripe SDK');
  assert(result.verified === false, 'verified is false');
  assert(result.reason.includes('Stripe SDK not available'), 'reason mentions missing SDK');
});

runTest('VERIFIER: constantTimeEqual works correctly', () => {
  assert(constantTimeEqual('abc', 'abc') === true, 'equal strings return true');
  assert(constantTimeEqual('abc', 'abd') === false, 'different strings return false');
  assert(constantTimeEqual('abc', 'abcd') === false, 'different length returns false');
});

runTest('VERIFIER: hmacSha256Hex produces valid output', async () => {
  const hash = await hmacSha256Hex('secret', 'payload');
  assert(hash.length === 64, 'hash is 64 hex chars');
  assert(/^[0-9a-f]{64}$/.test(hash), 'hash is valid hex');
});

/* ============================================================
   PROP.9/11 GOVERNANCE INVARIANT TESTS (must remain intact)
   ============================================================ */

console.log('\n=== PROP.9/11 GOVERNANCE INVARIANT TESTS ===\n');

runTest('INVARIANT: Redirect never marks PAID', () => {
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

runTest('INVARIANT: Webhook receipt never marks PAID', () => {
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

runTest('INVARIANT: Only reconciliation marks RECONCILED', () => {
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

runTest('INVARIANT: Wrong amount remains unsettled', () => {
  const adapter = new TestPaymentAdapter();
  const raw = adapter.makeTestEvidence({
    request: exampleRequest,
    invoice: exampleInvoice,
    amount: 1500 // Wrong amount
  });
  const normalized = adapter.normalizePaymentEvidence(raw, { example: true });
  const result = adapter.reconcilePayment(normalized.event, {
    invoice: exampleInvoice,
    request: exampleRequest,
    seenEventIds: new Set()
  });
  assert(!result.ok, 'Wrong amount reconciliation rejected');
  assert(result.outcome === 'WRONG_AMOUNT', 'Outcome is WRONG_AMOUNT');
});

runTest('INVARIANT: Wrong currency remains unsettled', () => {
  const adapter = new TestPaymentAdapter();
  const raw = adapter.makeTestEvidence({
    request: exampleRequest,
    invoice: exampleInvoice,
    amount: 2040,
    // We'll force currency mismatch by modifying
  });
  const normalized = adapter.normalizePaymentEvidence(raw, { example: true });
  normalized.event.currency = 'USD'; // Force wrong currency
  const result = adapter.reconcilePayment(normalized.event, {
    invoice: exampleInvoice,
    request: exampleRequest,
    seenEventIds: new Set()
  });
  assert(!result.ok, 'Wrong currency reconciliation rejected');
  assert(result.outcome === 'WRONG_CURRENCY', 'Outcome is WRONG_CURRENCY');
});

runTest('INVARIANT: PRODUCTION_PAYMENT_ENABLED remains false (default)', async () => {
  const { createActivationChecklist, isProductionReady, ACTIVATION_GATES } = await import('./production-checklist.mjs');
  const checklist = createActivationChecklist();
  assert(checklist.production_payment_enabled === false, 'production_payment_enabled is false by default');
  assert(isProductionReady(checklist.gates) === false, 'production not ready by default');
});

runTest('INVARIANT: TEST events rejected in PRODUCTION adapter', async () => {
  const { StripeAdapter } = await import('./stripe-adapter.mjs');
  const prodAdapter = new StripeAdapter({ environment: 'PRODUCTION', config: { production_activation_gate: false } });
  const rawEvent = {
    id: 'evt_test_123',
    type: 'checkout.session.completed',
    created: Math.floor(Date.now() / 1000),
    livemode: false,
    data: { object: { id: 'cs_test_123', amount_total: 204000, currency: 'gbp', metadata: {} } },
  };
  const result = prodAdapter.normalizeWebhookEvent(rawEvent, { signatureVerified: true });
  assert(!result.ok, 'TEST event rejected in PRODUCTION adapter');
});

runTest('INVARIANT: PRODUCTION events rejected in TEST adapter', async () => {
  const { StripeTestAdapter } = await import('./stripe-adapter.mjs');
  const testAdapter = new StripeTestAdapter();
  const rawEvent = {
    id: 'evt_live_123',
    type: 'checkout.session.completed',
    created: Math.floor(Date.now() / 1000),
    livemode: true,
    data: { object: { id: 'cs_live_123', amount_total: 204000, currency: 'gbp', metadata: {} } },
  };
  const result = testAdapter.normalizeWebhookEvent(rawEvent, { signatureVerified: true });
  assert(!result.ok, 'LIVE event rejected in TEST adapter');
});

/* ============================================================
   INTEGRATION TEST: Full flow through storage adapter
   ============================================================ */

console.log('\n=== INTEGRATION TESTS ===\n');

runTest('INTEGRATION: Complete flow uses storage adapter (no handler-local Map)', async () => {
  // This test simulates the API handlers using the storage adapter
  // instead of in-memory Maps

  const storage = new TestFileStorageAdapter({ baseDir: join(PRIVATE_DIR, 'test-integration') });
  const verifier = new TestDeterministicVerifier();

  // 1. Create token
  const tokenResult = buildPaymentToken({ invoice: exampleInvoice, request: exampleRequest, example: true });
  assert(tokenResult.ok, 'Token created');

  // 2. Create portal session via storage
  const sessionResult = buildPortalSession({ token: tokenResult.token, paymentRequest: exampleRequest, invoice: exampleInvoice, example: true });
  assert(sessionResult.ok, 'Portal session built');
  await storage.createSession(sessionResult.session);

  // 3. Attach checkout session
  const fakeStripeSession = {
    id: 'cs_test_integration',
    url: 'https://checkout.stripe.com/pay/cs_test_integration',
    expires_at: Math.floor(Date.now() / 1000) + 1800,
    payment_status: 'unpaid',
    status: 'open',
    amount_total: 204000,
    currency: 'gbp',
    livemode: false,
    metadata: { nexora_payment_request_id: 'REQ-2026-9898-001' }
  };
  const attached = attachCheckoutSession(sessionResult.session, fakeStripeSession);
  assert(attached.ok, 'Checkout session attached');
  await storage.updateSession(attached.session);

  // 4. Mark customer redirected
  const redirected = markCustomerRedirected(attached.session);
  assert(redirected.ok, 'Customer redirected');
  await storage.updateSession(redirected.session);

  // 5. Simulate webhook: verify signature
  const sigResult = await verifier.verify(
    JSON.stringify({ id: 'evt_test_123', type: 'checkout.session.completed' }),
    't=1234567890,v1=abc123',
    'whsec_test'
  );
  assert(sigResult.verified === true, 'Signature verified (TEST mode)');

  // 6. Normalize webhook event
  const stripeAdapter = new StripeTestAdapter();
  const testEvent = stripeAdapter.makeTestWebhookEvent(exampleRequest, 'checkout.session.completed');
  const normalized = stripeAdapter.normalizeWebhookEvent(testEvent, { signatureVerified: true });
  assert(normalized.ok, 'Webhook normalized');

  // 7. Check idempotency
  const idemCheck = await storage.checkIdempotency(normalized.event.idempotency_key);
  assert(idemCheck.exists === false, 'Idempotency key not yet used');

  // 8. Find session by checkout_session_id
  const foundSession = await storage.findSessionByCheckoutSessionId('cs_test_integration');
  assert(foundSession !== null, 'Session found by checkout_session_id');

  // 9. Mark webhook received
  const webhookReceived = markWebhookReceived(foundSession, normalized.event);
  assert(webhookReceived.ok, 'Webhook received marked');
  await storage.updateSession(webhookReceived.session);

  // 10. Create payment record
  const paymentBuild = buildPaymentRecord(exampleRequest, { example: true, createdAt: '2026-08-15T09:00:00.000Z' });
  assert(paymentBuild.ok, 'Payment record built');
  await storage.createPayment(paymentBuild.payment);

  // 11. Apply webhook event to payment
  const evidence = normalized.event;
  const eventApplied = applyPaymentEvent(paymentBuild.payment, {
    event_type: 'RECORD_EVENT',
    evidence_ref: evidence.event_id,
    at: evidence.recorded_at
  });
  assert(eventApplied.ok, 'Payment evidence recorded');
  await storage.updatePayment(eventApplied.record);

  // 12. Reconcile
  const adapter = new TestPaymentAdapter();
  const adapterOutcome = adapter.reconcilePayment(evidence, {
    invoice: exampleInvoice,
    request: exampleRequest,
    seenEventIds: new Set()
  });
  assert(adapterOutcome.ok, 'Reconciliation runs');
  assert(adapterOutcome.outcome === 'EXACT', 'Outcome EXACT');

  // 13. Apply reconciliation
  const recBuild = buildReconciliation({
    invoice: exampleInvoice,
    request: exampleRequest,
    evidence,
    adapterOutcome,
    opts: { paymentId: paymentBuild.payment.payment_id, example: true, at: '2026-08-15T14:30:00.000Z' }
  });
  assert(recBuild.ok, 'Reconciliation record built');

  const reconApplied = applyReconciliation(eventApplied.record, exampleInvoice, recBuild.reconciliation, { at: '2026-08-15T14:30:00.000Z' });
  assert(reconApplied.ok, 'Reconciliation applied');
  assert(reconApplied.record.status === 'PAID', 'Payment marked PAID after reconciliation');
  await storage.updatePayment(reconApplied.record);

  // 14. Mark session reconciled
  const reconciled = markReconciled(webhookReceived.session, recBuild.reconciliation);
  assert(reconciled.ok, 'Session marked RECONCILED');
  await storage.updateSession(reconciled.session);

  // 15. Set idempotency
  await storage.setIdempotency(normalized.event.idempotency_key, normalized.event.event_id);

  // 16. Verify duplicate webhook rejected
  const idemCheck2 = await storage.checkIdempotency(normalized.event.idempotency_key);
  assert(idemCheck2.exists === true, 'Duplicate webhook detected via idempotency');
  assert(idemCheck2.eventId === normalized.event.event_id, 'Correct event_id returned');
});

/* ============================================================
   SUMMARY
   ============================================================ */

console.log('\n' + '='.repeat(60));
console.log(`PROP.12 RUNTIME HARDENING VALIDATION SUMMARY`);
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
  console.log('\n✓ ALL PROP.12 TESTS PASSED');
  console.log('PRODUCTION_PAYMENT_ENABLED = false (unchanged)');
  console.log('PROP.12 DOES NOT ACTIVATE LIVE PAYMENTS.');
  process.exit(0);
}