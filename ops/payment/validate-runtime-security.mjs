/* Nexora — Payment Runtime Security Validator (PROP.13)
   Validates critical runtime security invariants for payment infrastructure.
   Run as a post-deployment/CI check before Production activation. */

import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'path';

const OPS_DIR = join(process.cwd(), 'ops');
const PAYMENT_DIR = join(OPS_DIR, 'payment');
const PRIVATE_DIR = join(PAYMENT_DIR, 'private');

const ERRORS = [];

function fail(message) {
  ERRORS.push(message);
}

function log(message) {
  console.log(`[VALIDATOR] ${message}`);
}

async function validate() {
  log('Starting PROP.13 Runtime Security Validation...');

  // §36.1: Audit for private artifacts
  log('Auditing private/test artifacts...');
  const checkDir = (dir) => {
    if (!existsSync(dir)) return;
    const files = readdirSync(dir, { recursive: true });
    for (const file of files) {
      if (file.endsWith('.json')) {
        fail(`Found potential private test artifact: ${join(dir, file)}`);
      }
    }
  };
  checkDir(join(PRIVATE_DIR, 'test-integration'));
  checkDir(join(PRIVATE_DIR, 'test-runtime'));
  checkDir(join(PRIVATE_DIR, 'test-shared'));

  // §36.2: Verify Production environment configuration
  // Fail-closed test: If we initialize PRODUCTION storage without a client, it should throw.
  log('Verifying PRODUCTION storage fail-closed behavior...');
  const { createStorageAdapter } = await import('./runtime-storage.mjs');
  try {
    createStorageAdapter({ environment: 'PRODUCTION', config: {} });
    fail('PRODUCTION storage initialized without required SharedStorageClient');
  } catch (e) {
    log('PASS: PRODUCTION storage fail-closed (correctly threw on missing config)');
  }

  // §36.3: Verify no Production filesystem dependency
  // Check if any Production adapters are using file paths
  log('Verifying Production storage adapter types...');
  const { ProductionStorageAdapter } = await import('./runtime-storage.mjs');
  const prodAdapter = new ProductionStorageAdapter({
    config: {
      sharedStorageClient: {
        get: async () => null,
        set: async () => ({ ok: true }),
        delete: async () => ({ ok: true }),
        exists: async () => false,
        compareAndSet: async () => ({ ok: true, success: true }),
        setIfAbsent: async () => ({ ok: true, created: true }),
      },
      sharedStorageClientType: 'memory-test'
    }
  });

  if (prodAdapter.sessionKey('test').includes('private/')) {
    fail('Production storage adapter uses filesystem paths');
  }

  // §36.4: Validate webhook verification fail-closed
  log('Verifying Webhook verifier fail-closed...');
  const { createWebhookVerifier } = await import('./webhook-verifier.mjs');
  try {
    createWebhookVerifier({ environment: 'PRODUCTION', config: {} });
    fail('PRODUCTION webhook verifier initialized without webhookSecret');
  } catch (e) {
    log('PASS: PRODUCTION webhook verifier fail-closed (correctly threw on missing secret)');
  }

  if (ERRORS.length > 0) {
    console.error('\n--- VALIDATION FAILED ---');
    ERRORS.forEach(e => console.error(`- ${e}`));
    process.exit(1);
  } else {
    log('\n--- VALIDATION PASSED ---');
    process.exit(0);
  }
}

validate().catch(err => {
  console.error(err);
  process.exit(1);
});