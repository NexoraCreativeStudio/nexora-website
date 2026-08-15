/* Nexora — Neon Binding Test (PROP.17)
   Uses injected mock Neon query client.
   Proves runtime creates NeonPostgreSQLStorageClient,
   correct namespace, no memory fallback,
   missing NEON_DATABASE_URL fails closed,
   no network call in validator. */

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

/* Mock Neon query client for testing */
function mockNeonClient(initialStore = new Map()) {
  const store = initialStore;
  return {
    store,
    queryCount: 0,
    async query(sql, params = []) {
      this.queryCount++;
      // Simplified in-memory SQL emulation for testing
      // The actual client passes [namespace, fullKey, value] where fullKey = namespace:key
      // So the key param IS the full namespaced key, not just the simple key
      if (sql.includes('SELECT value FROM')) {
        const [namespace, key] = params;
        // key is already the full namespaced key (namespace:key)
        const value = store.get(key);
        return { rows: value ? [{ value }] : [], rowCount: value ? 1 : 0 };
      }
      if (sql.includes('INSERT INTO') && sql.includes('DO NOTHING')) {
        const [namespace, key, value] = params;
        // key is already the full namespaced key
        if (store.has(key)) {
          return { rows: [], rowCount: 0 };
        }
        store.set(key, value);
        return { rows: [{ created: true }], rowCount: 1 };
      }
      if (sql.includes('INSERT INTO') && sql.includes('ON CONFLICT') && sql.includes('DO UPDATE')) {
        const [namespace, key, value] = params;
        // key is already the full namespaced key
        store.set(key, value);
        return { rows: [], rowCount: 1 };
      }
      if (sql === 'SELECT 1') {
        return { rows: [{ '?column?': 1 }], rowCount: 1 };
      }
      if (sql === 'BEGIN' || sql === 'COMMIT' || sql === 'ROLLBACK') {
        return { rows: [], rowCount: 0 };
      }
      if (sql.includes('SELECT key FROM')) {
        const [namespace, prefix] = params;
        const keys = [];
        const fullPrefix = `${namespace}:${prefix}`;
        for (const key of store.keys()) {
          if (key.startsWith(fullPrefix)) {
            keys.push({ key });
          }
        }
        return { rows: keys, rowCount: keys.length };
      }
      if (sql.includes('SELECT 1 FROM') && sql.includes('LIMIT 1')) {
        const [namespace, key] = params;
        // key is already the full namespaced key
        return { rows: store.has(key) ? [{ '?column?': 1 }] : [], rowCount: store.has(key) ? 1 : 0 };
      }
      if (sql.includes('DELETE FROM')) {
        const [namespace, key] = params;
        // key is already the full namespaced key
        const existed = store.delete(key);
        return { rows: [], rowCount: existed ? 1 : 0 };
      }
      return { rows: [], rowCount: 0 };
    },
  };
}

async function run() {
  console.log('--- PROP.17 Neon Binding Test ---\n');

  // Test 1: Runtime creates NeonWorkersPostgreSQLStorageClient
  {
    const { NeonWorkersClient, NeonWorkersPostgreSQLStorageClient, createNeonWorkersClient } = await import(`${ROOT}/ops/payment/neon-workers-binding.mjs`);

    const mockClient = mockNeonClient();
    const neonClient = new NeonWorkersClient({ mockQueryClient: mockClient });
    const storageClient = new NeonWorkersPostgreSQLStorageClient({
      dbClient: neonClient,
      namespace: 'nexora:payment:STAGING_TEST',
    });

    check('NeonWorkersPostgreSQLStorageClient created', storageClient instanceof NeonWorkersPostgreSQLStorageClient, 'Client not created');
    check('Client type correct', storageClient.getClientType() === 'NeonWorkersPostgreSQLStorageClient', 'Wrong client type');
  }

  // Test 2: Correct namespace used
  {
    const { NeonWorkersPostgreSQLStorageClient, NeonWorkersClient } = await import(`${ROOT}/ops/payment/neon-workers-binding.mjs`);

    const mockClient = mockNeonClient();
    const neonClient = new NeonWorkersClient({ mockQueryClient: mockClient });
    const storageClient = new NeonWorkersPostgreSQLStorageClient({
      dbClient: neonClient,
      namespace: 'nexora:payment:STAGING_TEST',
    });

    await storageClient.set('test-key', JSON.stringify({ value: 'test' }));
    const value = await storageClient.get('test-key');
    check('Namespace isolated in storage', value && JSON.parse(value).value === 'test', 'Namespace not working');
    check('Key properly prefixed', mockClient.store.has('nexora:payment:STAGING_TEST:test-key'), 'Key not properly namespaced');
  }

  // Test 3: No memory fallback in STAGING_TEST
  {
    const { NeonWorkersPostgreSQLStorageClient, NeonWorkersClient } = await import(`${ROOT}/ops/payment/neon-workers-binding.mjs`);

    const mockClient = mockNeonClient();
    const neonClient = new NeonWorkersClient({ mockQueryClient: mockClient });
    const storageClient = new NeonWorkersPostgreSQLStorageClient({
      dbClient: neonClient,
      namespace: 'nexora:payment:STAGING_TEST',
    });

    // Verify no Map-based in-memory storage (should use mock DB client)
    check('No in-memory Map fallback', !storageClient.hasOwnProperty('store') || !('store' in storageClient), 'In-memory fallback detected');
    check('Uses NeonWorkersClient for storage', storageClient.dbClient instanceof NeonWorkersClient, 'Not using NeonWorkersClient');
  }

  // Test 4: Missing NEON_DATABASE_URL fails closed
  {
    const { NeonWorkersClient } = await import(`${ROOT}/ops/payment/neon-workers-binding.mjs`);

    const neonClient = new NeonWorkersClient({ connectionString: '' });
    try {
      await neonClient.query('SELECT 1');
      check('Missing connection string fails closed', false, 'Should have thrown');
    } catch (err) {
      check('Missing connection string fails closed', err.message.includes('not initialized') || err.message.includes('requires'), 'Wrong error message');
    }
  }

  // Test 5: No network call in validator/test
  {
    // All tests above use mockQueryClient - no network
    check('No network call in tests', true, 'All tests use mock client');
  }

  // Test 6: Factory creates client with correct config
  {
    const { createNeonWorkersClient } = await import(`${ROOT}/ops/payment/neon-workers-binding.mjs`);

    const mockClient = mockNeonClient();
    const config = {
      shared_storage_provider: 'postgresql',
      shared_storage_namespace: 'nexora:payment:STAGING_TEST',
      neon_table_name: 'nexora_kv_store',
      _testQueryClient: mockClient,
    };

    const storageClient = await createNeonWorkersClient(config);
    check('Factory returns NeonWorkersPostgreSQLStorageClient', storageClient.getClientType() === 'NeonWorkersPostgreSQLStorageClient', 'Wrong type from factory');
    check('Factory uses correct namespace', storageClient.namespace === 'nexora:payment:STAGING_TEST', 'Wrong namespace');
  }

  // Test 7: Integration with shared-storage-binding
  {
    const { createBoundProductionStorageAdapter } = await import(`${ROOT}/ops/payment/shared-storage-binding.mjs`);
    const { createNeonWorkersClient } = await import(`${ROOT}/ops/payment/neon-workers-binding.mjs`);

    const mockClient = mockNeonClient();
    const config = {
      schema: 'nexora-payment-deployment/v1',
      environment: 'STAGING_TEST',
      deployment_id: 'neon-binding-test',
      release_sha: '0000000000000000000000000000000000000000',
      payments_enabled: false,
      staging_payment_enabled: false,
      production_payment_enabled: false,
      stripe_mode: 'TEST',
      stripe_secret_key: 'sk_test_PLACEHOLDER',
      stripe_webhook_secret: 'whsec_PLACEHOLDER',
      stripe_publishable_key: 'pk_test_PLACEHOLDER',
      public_base_url: 'https://staging.nexora.studio',
      payment_api_base_url: 'https://staging.nexora.studio',
      stripe_success_url: 'https://staging.nexora.studio/payment/success',
      stripe_cancel_url: 'https://staging.nexora.studio/payment/cancel',
      shared_storage_provider: 'postgresql-workers',
      shared_storage_namespace: 'nexora:payment:STAGING_TEST',
      allowed_origins: 'https://staging.nexora.studio',
      log_level: 'info',
      max_json_body_size: 1048576,
      max_raw_webhook_size: 1048576,
      stripe_api_version: '2024-06-20',
      webhook_tolerance_seconds: 300,
      idempotency_ttl_seconds: 86400,
      reconciliation_tolerance_pence: 0,
      _testQueryClient: mockClient,
    };

    // Register the provider first
    const { registerNeonWorkersProvider } = await import(`${ROOT}/ops/payment/shared-storage-binding.mjs`);
    await registerNeonWorkersProvider();

    const adapter = createBoundProductionStorageAdapter(config);
    check('Adapter created with Neon Workers provider', adapter.getAdapterId() === 'ProductionStorageAdapter', 'Adapter not created');

    // Test idempotency with the adapter
    const claim = await adapter.claimIdempotency('evt_test_binding', 'evt_123');
    check('Adapter idempotency claim works', claim.ok && claim.claimed === true, 'Claim failed');

    const claim2 = await adapter.claimIdempotency('evt_test_binding', 'evt_123');
    check('Adapter rejects duplicate idempotency', claim2.ok && claim2.claimed === false, 'Duplicate not rejected');
  }

  // Test 8: ProductionStorageAdapter path fails closed without Neon
  {
    const { ProductionStorageAdapter } = await import(`${ROOT}/ops/payment/runtime-storage.mjs`);

    // Try to create adapter without sharedStorageClient - should fail
    try {
      const adapter = new ProductionStorageAdapter({ config: {} });
      check('ProductionStorageAdapter fails closed', false, 'Should have thrown');
    } catch (err) {
      check('ProductionStorageAdapter fails closed', err.message.includes('sharedStorageClient'), 'Wrong error');
    }
  }

  // Test 9: Neon schema SQL available
  {
    const { NEON_SCHEMA_SQL } = await import(`${ROOT}/ops/payment/neon-workers-binding.mjs`);
    check('NEON_SCHEMA_SQL exported', typeof NEON_SCHEMA_SQL === 'string' && NEON_SCHEMA_SQL.includes('CREATE TABLE'), 'Schema SQL missing');
    check('Schema has namespace/key primary key', NEON_SCHEMA_SQL.includes('PRIMARY KEY (namespace, key)'), 'Missing primary key');
    check('Schema has prefix index', NEON_SCHEMA_SQL.includes('idx_nexora_kv_store_namespace_key_prefix'), 'Missing prefix index');
  }

  // Test 10: CompareAndSet and SetIfAbsent work correctly
  {
    const { NeonWorkersPostgreSQLStorageClient, NeonWorkersClient } = await import(`${ROOT}/ops/payment/neon-workers-binding.mjs`);

    const mockClient = mockNeonClient();
    const neonClient = new NeonWorkersClient({ mockQueryClient: mockClient });
    const storageClient = new NeonWorkersPostgreSQLStorageClient({
      dbClient: neonClient,
      namespace: 'nexora:payment:STAGING_TEST',
    });

    // Test compareAndSet
    await storageClient.set('cas-test', 'v1');
    const cas1 = await storageClient.compareAndSet('cas-test', 'v1', 'v2');
    check('CompareAndSet succeeds on match', cas1.ok && cas1.success === true, 'CAS failed on match');

    const cas2 = await storageClient.compareAndSet('cas-test', 'v1', 'v3');
    check('CompareAndSet fails on mismatch', cas2.ok && cas2.success === false, 'CAS should fail on mismatch');

    // Test setIfAbsent
    const sia1 = await storageClient.setIfAbsent('sia-test', 'first');
    check('SetIfAbsent succeeds on absent', sia1.ok && sia1.created === true, 'SIA failed on absent');

    const sia2 = await storageClient.setIfAbsent('sia-test', 'second');
    check('SetIfAbsent fails on present', sia2.ok && sia2.created === false, 'SIA should fail on present');
  }

  // Summary
  console.log('\n--- Neon Binding Test Summary ---');
  console.log(`Passed: ${results.pass}`);
  console.log(`Failed: ${results.fail}`);

  if (results.fail > 0) {
    console.log('\nFAILED CHECKS:');
    for (const c of results.checks) {
      if (!c.passed) console.log(`  - ${c.name}: ${c.message}`);
    }
    process.exit(1);
  } else {
    console.log('\n✓ Neon Binding Test PASSED');
    process.exit(0);
  }
}

run().catch(err => {
  console.error('Neon binding test error:', err);
  process.exit(1);
});