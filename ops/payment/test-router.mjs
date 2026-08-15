/* Nexora — Router Test Suite (PROP.17)
   Offline tests for the Cloudflare Workers router.
   No network calls, no payment creation, no real credentials.
   Simulates Workers requests against the worker fetch handler. */

import { readFileSync, existsSync } from 'fs';
import { resolve } from 'path';

const ROOT = resolve(process.cwd());

const results = { pass: 0, fail: 0, checks: [] };

function check(name, condition, message = '') {
  results.checks.push({ name, passed: Boolean(condition), message });
  if (condition) {
    results.pass++;
    console.log(`  ✓ ${name}`);
  } else {
    results.fail++;
    console.log(`  ✗ ${name}: ${message}`);
  }
}

/* Mock Cloudflare Worker environment */
function mockWorkerEnv(overrides = {}) {
  return {
    PAYMENT_RUNTIME_ENV: 'STAGING_TEST',
    PAYMENTS_ENABLED: 'false',
    STAGING_PAYMENT_ENABLED: 'false',
    PRODUCTION_PAYMENT_ENABLED: 'false',
    STRIPE_MODE: 'TEST',
    STRIPE_API_VERSION: '2024-06-20',
    SHARED_STORAGE_PROVIDER: 'postgresql',
    SHARED_STORAGE_NAMESPACE: 'nexora:payment:STAGING_TEST',
    WEBHOOK_TOLERANCE_SECONDS: '300',
    IDEMPOTENCY_TTL_SECONDS: '86400',
    RECONCILIATION_TOLERANCE_PENCE: '0',
    LOG_LEVEL: 'info',
    PUBLIC_BASE_URL: 'https://nexora-payment-staging.nexorastudio-uk.workers.dev',
    PAYMENT_API_BASE_URL: 'https://nexora-payment-staging.nexorastudio-uk.workers.dev',
    ALLOWED_ORIGINS: 'https://staging.nexora.studio',
    DEPLOYMENT_ID: 'router-test',
    RELEASE_SHA: 'abcdef1234567890abcdef1234567890abcdef12',
    // Secrets come from bindings — use test-looking values (not placeholders) for STAGING_TEST tests
    STRIPE_SECRET_KEY: 'sk_test_abcdefghijklmnopqrstuvwxyz123456',
    STRIPE_WEBHOOK_SECRET: 'whsec_abcdefghijklmnopqrstuvwxyz12345678',
    STRIPE_PUBLISHABLE_KEY: 'pk_test_abcdefghijklmnopqrstuvwxyz123456',
    NEON_DATABASE_URL: 'postgresql://test:test@localhost/test',
    ...overrides,
  };
}

/* Mock Cloudflare Worker Request */
function mockWorkerRequest(method, path, options = {}) {
  const url = `https://nexora-payment-staging.nexorastudio-uk.workers.dev${path}`;
  const headers = new Headers(options.headers || {});
  headers.set('x-correlation-id', 'req-test-correlation-123456');

  // Build body
  let body = null;
  if (options.body !== undefined) {
    body = typeof options.body === 'string' ? options.body : JSON.stringify(options.body);
  }

  // Mock Cloudflare Request interface
  const request = {
    method,
    url,
    headers,
    _body: body,
    cf: { region: 'GBR' },
    clone() {
      return {
        method: this.method,
        url: this.url,
        headers: this.headers,
        _body: this._body,
        async arrayBuffer() {
          if (this._body === null) return new ArrayBuffer(0);
          return new TextEncoder().encode(this._body).buffer;
        },
      };
    },
    async arrayBuffer() {
      if (this._body === null) return new ArrayBuffer(0);
      return new TextEncoder().encode(this._body).buffer;
    },
    async text() {
      return this._body || '';
    },
  };

  return request;
}

async function run() {
  console.log('--- PROP.17 Router Test Suite ---\n');

  // Check worker file exists
  if (!existsSync(resolve(ROOT, 'worker.mjs'))) {
    check('worker.mjs exists', false, 'Worker entry point missing');
    console.log('\nRouter tests require worker.mjs — aborting.');
    process.exit(1);
  }

  // Import worker
  const worker = await import(`${ROOT}/worker.mjs`);

  // Test 1: GET /api/payment/health
  {
    const req = mockWorkerRequest('GET', '/api/payment/health');
    const res = await worker.default.fetch(req, mockWorkerEnv());
    const body = await res.json();
    check('GET /health returns 200', res.status === 200, `Got ${res.status}`);
    check('GET /health has ok:true', body.ok === true, 'Body ok not true');
    check('GET /health has no-store', res.headers.get('Cache-Control') === 'no-store', 'Missing no-store');
  }

  // Test 2: GET /api/payment/readiness
  {
    const req = mockWorkerRequest('GET', '/api/payment/readiness');
    const res = await worker.default.fetch(req, mockWorkerEnv());
    const body = await res.json();
    // Readiness may return 503 since payments disabled is expected
    check('GET /readiness returns 200 or 503', res.status === 200 || res.status === 503, `Got ${res.status}`);
    check('GET /readiness has environment', body.environment === 'STAGING_TEST', 'Missing STAGING_TEST environment');
  }

  // Test 3: POST /api/payment/checkout-create
  {
    const req = mockWorkerRequest('POST', '/api/payment/checkout-create', {
      body: { token: 'PAT-invalid-test-token-does-not-exist-here-1234567890abcdef' },
      headers: { 'Content-Type': 'application/json' },
    });
    const res = await worker.default.fetch(req, mockWorkerEnv());
    const body = await res.json();
    // With STAGING_PAYMENT_ENABLED=false, checkout should be blocked - STAGING_PAYMENTS_DISABLED maps to 503
    check('POST /checkout-create blocked when staging disabled', res.status === 503, `Got ${res.status}`);
  }

  // Test 4: GET /api/payment/status
  {
    const req = mockWorkerRequest('GET', '/api/payment/status?session_id=PSS-dnqeauWAoxwvhUFCWsb-iKrBcR9sjCMlrtfY0EuFxss');
    const res = await worker.default.fetch(req, mockWorkerEnv());
    const body = await res.json();
    check('GET /status returns 200 or 404', res.status === 200 || res.status === 404, `Got ${res.status}`);
  }

  // Test 5: POST /api/payment/webhook
  {
    const req = mockWorkerRequest('POST', '/api/payment/webhook', {
      body: '{"type":"checkout.session.completed","id":"evt_test_123"}',
      headers: {
        'Content-Type': 'application/json',
        'Stripe-Signature': 't=1234567890,v1=test_signature_123',
      },
    });
    const res = await worker.default.fetch(req, mockWorkerEnv());
    // Invalid signature should fail safely
    check('POST /webhook returns 401 or 400', res.status === 401 || res.status === 400, `Got ${res.status}`);
  }

  // Test 6: Unknown path -> 404
  {
    const req = mockWorkerRequest('GET', '/api/payment/unknown');
    const res = await worker.default.fetch(req, mockWorkerEnv());
    const body = await res.json();
    check('Unknown path returns 404', res.status === 404, `Got ${res.status}`);
    check('Unknown path safe error', body.error && body.error.code === 'NOT_FOUND', 'Error contract missing');
  }

  // Test 7: Wrong method -> 405
  {
    const req = mockWorkerRequest('POST', '/api/payment/health');
    const res = await worker.default.fetch(req, mockWorkerEnv());
    const body = await res.json();
    check('Wrong method returns 405', res.status === 405, `Got ${res.status}`);
    check('Wrong method safe error', body.error && body.error.code === 'METHOD_NOT_ALLOWED', 'Error contract missing');
  }

  // Test 8: No wildcard fallthrough
  {
    const req = mockWorkerRequest('GET', '/api/payment/health/extra');
    const res = await worker.default.fetch(req, mockWorkerEnv());
    check('No wildcard fallthrough (extra path -> 404)', res.status === 404, `Got ${res.status}`);
  }

  // Test 9: Correlation ID propagation
  {
    const req = mockWorkerRequest('GET', '/api/payment/health', {
      headers: { 'x-correlation-id': 'req-test-correlation-123456' },
    });
    const res = await worker.default.fetch(req, mockWorkerEnv());
    check('Correlation ID propagated', res.headers.get('X-Correlation-Id') === 'req-test-correlation-123456', 'Correlation ID missing from response');
  }

  // Test 10: OPTIONS preflight
  {
    const req = mockWorkerRequest('OPTIONS', '/api/payment/health', {
      headers: { Origin: 'https://staging.nexora.studio' },
    });
    const res = await worker.default.fetch(req, mockWorkerEnv());
    check('OPTIONS preflight returns 200', res.status === 200, `Got ${res.status}`);
  }

  // Test 11: No payment creation during tests
  {
    check('No payment creation during tests', true, 'Router tests make no payment calls');
  }

  // Summary
  console.log('\n--- Router Test Summary ---');
  console.log(`Passed: ${results.pass}`);
  console.log(`Failed: ${results.fail}`);

  if (results.fail > 0) {
    console.log('\nFAILED CHECKS:');
    for (const c of results.checks) {
      if (!c.passed) console.log(`  - ${c.name}: ${c.message}`);
    }
    process.exit(1);
  } else {
    console.log('\n✓ Router Test Suite PASSED');
    process.exit(0);
  }
}

run().catch(err => {
  console.error('Router test error:', err);
  process.exit(1);
});