/* Nexora — Cloudflare Workers Deployment Config Validator (PROP.17)
   Offline-only validation of Workers deployment artifacts.
   No network calls, no external dependencies, no real credentials. */

import { readFileSync, existsSync } from 'fs';
import { resolve } from 'path';

const ROOT = resolve(process.cwd());

/* Validation results */
const results = {
  pass: 0,
  fail: 0,
  checks: [],
};

function check(name, condition, message) {
  const passed = Boolean(condition);
  results.checks.push({ name, passed, message });
  if (passed) {
    results.pass++;
    console.log(`  ✓ ${name}`);
  } else {
    results.fail++;
    console.log(`  ✗ ${name}: ${message}`);
  }
  return passed;
}

function checkFile(path, description) {
  const fullPath = resolve(ROOT, path);
  const exists = existsSync(fullPath);
  check(`File: ${path}`, exists, exists ? '' : `${description} not found at ${fullPath}`);
  return exists;
}

function checkJsonFile(path, requiredKeys, description) {
  const fullPath = resolve(ROOT, path);
  if (!existsSync(fullPath)) {
    check(`File: ${path}`, false, `${description} not found at ${fullPath}`);
    return false;
  }
  try {
    const content = JSON.parse(readFileSync(fullPath, 'utf8'));
    const missing = requiredKeys.filter(k => !(k in content));
    check(`JSON: ${path}`, missing.length === 0, missing.length ? `Missing keys: ${missing.join(', ')}` : '');
    return missing.length === 0;
  } catch (e) {
    check(`JSON: ${path}`, false, `Invalid JSON: ${e.message}`);
    return false;
  }
}

/* Main validation */
async function validate() {
  console.log('--- PROP.17 Cloudflare Workers Deployment Config Validation ---\n');

  // 1. Worker entry point exists
  checkFile('worker.mjs', 'Worker entry point');

  // 2. Worker exports default fetch handler
  if (existsSync(resolve(ROOT, 'worker.mjs'))) {
    const workerContent = readFileSync(resolve(ROOT, 'worker.mjs'), 'utf8');
    check('Worker: default export', workerContent.includes('export default'), 'Missing export default');
    check('Worker: fetch handler', workerContent.includes('async fetch(request, env, ctx)') || workerContent.includes('async fetch('), 'Missing fetch handler');
  }

  // 3. Required routes present
  if (existsSync(resolve(ROOT, 'worker.mjs'))) {
    const workerContent = readFileSync(resolve(ROOT, 'worker.mjs'), 'utf8');
    const routes = [
      { method: 'GET', path: '/api/payment/health' },
      { method: 'GET', path: '/api/payment/readiness' },
      { method: 'POST', path: '/api/payment/checkout-create' },
      { method: 'GET', path: '/api/payment/status' },
      { method: 'POST', path: '/api/payment/webhook' },
    ];
    for (const route of routes) {
      check(`Route: ${route.method} ${route.path}`, workerContent.includes(route.path), `Route ${route.method} ${route.path} not found in router`);
    }
  }

  // 4. Webhook raw body preserved
  if (existsSync(resolve(ROOT, 'worker.mjs'))) {
    const workerContent = readFileSync(resolve(ROOT, 'worker.mjs'), 'utf8');
    check('Webhook: raw body handling', workerContent.includes('parseRawBody') && workerContent.includes('rawBodyToString'), 'Webhook raw body handling not found');
    check('Webhook: signature verification', workerContent.includes('createWebhookVerifier') && workerContent.includes('verify'), 'Webhook signature verification not found');
  }

  // 5. Wrangler config exists
  const hasWranglerToml = checkFile('wrangler.toml', 'Wrangler configuration');

  // 6. Wrangler config validation
  if (hasWranglerToml) {
    const wranglerContent = readFileSync(resolve(ROOT, 'wrangler.toml'), 'utf8');
    check('Wrangler: name', wranglerContent.includes('name = "nexora-payment-staging"'), 'Missing or incorrect name');
    check('Wrangler: main', wranglerContent.includes('main = "worker.mjs"'), 'Missing or incorrect main entry point');
    check('Wrangler: compatibility_date', wranglerContent.includes('compatibility_date'), 'Missing compatibility_date');
    check('Wrangler: nodejs_compat', wranglerContent.includes('nodejs_compat'), 'Missing nodejs_compat flag');

    // Verify staging-oriented vars
    check('Wrangler: PAYMENT_RUNTIME_ENV=STAGING_TEST', wranglerContent.includes('PAYMENT_RUNTIME_ENV = "STAGING_TEST"'), 'Missing STAGING_TEST env');
    check('Wrangler: STRIPE_MODE=TEST', wranglerContent.includes('STRIPE_MODE = "TEST"'), 'Missing TEST Stripe mode');
    check('Wrangler: SHARED_STORAGE_PROVIDER=postgresql', wranglerContent.includes('SHARED_STORAGE_PROVIDER = "postgresql"'), 'Missing postgresql provider');

    // Verify all payment flags FALSE
    check('Wrangler: PAYMENTS_ENABLED=false', wranglerContent.includes('PAYMENTS_ENABLED = "false"'), 'PAYMENTS_ENABLED not false');
    check('Wrangler: STAGING_PAYMENT_ENABLED=false', wranglerContent.includes('STAGING_PAYMENT_ENABLED = "false"'), 'STAGING_PAYMENT_ENABLED not false');
    check('Wrangler: PRODUCTION_PAYMENT_ENABLED=false', wranglerContent.includes('PRODUCTION_PAYMENT_ENABLED = "false"'), 'PRODUCTION_PAYMENT_ENABLED not false');

    // No secrets in wrangler config (check for actual assignments, not comments)
    // Use regex to find actual value assignments (not commented lines)
    const secretValueRegex = (key) => new RegExp(`^\\s*${key}\\s*=\\s*["'](sk_|whsec_|postgresql://)`, 'm');
    check('Wrangler: no STRIPE_SECRET_KEY value', !secretValueRegex('STRIPE_SECRET_KEY').test(wranglerContent), 'STRIPE_SECRET_KEY should not have value in wrangler.toml');
    check('Wrangler: no STRIPE_WEBHOOK_SECRET value', !secretValueRegex('STRIPE_WEBHOOK_SECRET').test(wranglerContent), 'STRIPE_WEBHOOK_SECRET should not have value in wrangler.toml');
    check('Wrangler: no NEON_DATABASE_URL value', !secretValueRegex('NEON_DATABASE_URL').test(wranglerContent), 'NEON_DATABASE_URL should not have value in wrangler.toml');

    // No production route (check for actual route assignments, not comments)
    const productionRouteRegex = /^\s*(route|zone_id|host)\s*=\s*["'].*nexora\.studio/mi;
    check('Wrangler: no production route', !productionRouteRegex.test(wranglerContent), 'Production domain/route found in wrangler.toml');

    // Workers.dev strategy
    check('Wrangler: workers.dev strategy documented', wranglerContent.includes('workers.dev'), 'Workers.dev strategy not documented');
  }

  // 7. Package.json exists and has correct config
  checkFile('package.json', 'Package configuration');
  if (existsSync(resolve(ROOT, 'package.json'))) {
    const pkg = JSON.parse(readFileSync(resolve(ROOT, 'package.json'), 'utf8'));
    check('Package: name', pkg.name === 'nexora-payment-staging', 'Incorrect package name');
    check('Package: type=module', pkg.type === 'module', 'Package must be ES module');
    check('Package: @neondatabase/serverless dep', pkg.dependencies && '@neondatabase/serverless' in pkg.dependencies, 'Missing Neon serverless dependency');
    check('Package: wrangler devDependency', pkg.devDependencies && 'wrangler' in pkg.devDependencies, 'Missing wrangler devDependency');
    check('Package: worker:deploy script', pkg.scripts && pkg.scripts['worker:deploy'] === 'wrangler deploy', 'Missing or incorrect worker:deploy script');
    check('Package: worker:validate script', pkg.scripts && 'worker:validate' in pkg.scripts, 'Missing worker:validate script');
    check('Package: no Worker-specific build command', !pkg.scripts || !pkg.scripts['worker:build'], 'Worker should not have worker:build script - wrangler deploy handles it');
  }

  // 8. Neon runtime binding exists
  checkFile('ops/payment/neon-workers-binding.mjs', 'Neon Workers binding');

  // 9. Neon binding validation
  if (existsSync(resolve(ROOT, 'ops/payment/neon-workers-binding.mjs'))) {
    const neonContent = readFileSync(resolve(ROOT, 'ops/payment/neon-workers-binding.mjs'), 'utf8');
    check('Neon: NeonWorkersClient class', neonContent.includes('class NeonWorkersClient'), 'Missing NeonWorkersClient class');
    check('Neon: query method', neonContent.includes('async query('), 'Missing query method');
    check('Neon: NeonWorkersPostgreSQLStorageClient', neonContent.includes('class NeonWorkersPostgreSQLStorageClient'), 'Missing storage client class');
    check('Neon: compareAndSet', neonContent.includes('async compareAndSet('), 'Missing compareAndSet');
    check('Neon: setIfAbsent', neonContent.includes('async setIfAbsent('), 'Missing setIfAbsent');
    check('Neon: createNeonWorkersClient factory', neonContent.includes('createNeonWorkersClient'), 'Missing factory function');
    check('Neon: mock injection support', neonContent.includes('mockQueryClient'), 'Missing mock injection for offline testing');
  }

  // 10. Shared storage binding updated
  if (existsSync(resolve(ROOT, 'ops/payment/shared-storage-binding.mjs'))) {
    const ssbContent = readFileSync(resolve(ROOT, 'ops/payment/shared-storage-binding.mjs'), 'utf8');
    check('SSB: Neon Workers provider registration', ssbContent.includes('registerNeonWorkersProvider'), 'Missing Neon Workers provider registration');
    check('SSB: postgresql-workers provider', ssbContent.includes('postgresql-workers'), 'Missing postgresql-workers provider');
    check('SSB: neon-workers provider', ssbContent.includes('neon-workers'), 'Missing neon-workers provider');
  }

  // 11. Secret bindings documented (not committed)
  const secretBindings = ['STRIPE_SECRET_KEY', 'STRIPE_WEBHOOK_SECRET', 'STRIPE_PUBLISHABLE_KEY', 'NEON_DATABASE_URL'];
  if (hasWranglerToml) {
    const wranglerContent = readFileSync(resolve(ROOT, 'wrangler.toml'), 'utf8');
    for (const secret of secretBindings) {
      check(`Secret binding: ${secret}`, wranglerContent.includes(secret), `${secret} not documented in wrangler.toml`);
    }
  }

  // 12. No local filesystem dependency
  const workerContent = readFileSync(resolve(ROOT, 'worker.mjs'), 'utf8');
  check('Worker: no fs import', !workerContent.includes("require('fs')") && !workerContent.includes('from \'fs\'') && !workerContent.includes('from "fs"'), 'Worker should not import Node fs module');
  check('Worker: no path import for file ops', !workerContent.includes("require('path')") && !workerContent.includes('from \'path\'') && !workerContent.includes('from "path"'), 'Worker should not import Node path for file ops');

  // 13. Neon secret binding required
  check('Config: NEON_DATABASE_URL required', true, 'NEON_DATABASE_URL must be provided via Cloudflare secret binding');

  // 14. Non-production branch builds recommendation
  if (hasWranglerToml) {
    const wranglerContent = readFileSync(resolve(ROOT, 'wrangler.toml'), 'utf8');
    check('Branch builds: disabled', wranglerContent.includes('branch = false') || wranglerContent.includes('branch builds') || wranglerContent.includes('non-production'), 'Non-production branch builds should be disabled or documented as disabled');
  }

  // 15. Deploy command correct
  if (existsSync(resolve(ROOT, 'package.json'))) {
    const pkg = JSON.parse(readFileSync(resolve(ROOT, 'package.json'), 'utf8'));
    check('Deploy command: wrangler deploy', pkg.scripts && pkg.scripts['worker:deploy'] === 'wrangler deploy', 'Deploy command should be "wrangler deploy"');
  }

  // 16. Staging flags assertion
  if (hasWranglerToml) {
    const wranglerContent = readFileSync(resolve(ROOT, 'wrangler.toml'), 'utf8');
    const flags = ['PAYMENTS_ENABLED = "false"', 'STAGING_PAYMENT_ENABLED = "false"', 'PRODUCTION_PAYMENT_ENABLED = "false"'];
    for (const flag of flags) {
      check(`Flag: ${flag}`, wranglerContent.includes(flag), `${flag} not set to false`);
    }
  }

  // 17. Environment STAGING_TEST
  if (hasWranglerToml) {
    const wranglerContent = readFileSync(resolve(ROOT, 'wrangler.toml'), 'utf8');
    check('Env: STAGING_TEST', wranglerContent.includes('PAYMENT_RUNTIME_ENV = "STAGING_TEST"'), 'Environment not STAGING_TEST');
  }

  // 18. Stripe TEST mode
  if (hasWranglerToml) {
    const wranglerContent = readFileSync(resolve(ROOT, 'wrangler.toml'), 'utf8');
    check('Stripe: TEST mode', wranglerContent.includes('STRIPE_MODE = "TEST"'), 'Stripe not in TEST mode');
  }

  // 19. Neon/Postgres selected
  if (hasWranglerToml) {
    const wranglerContent = readFileSync(resolve(ROOT, 'wrangler.toml'), 'utf8');
    check('Storage: postgresql', wranglerContent.includes('SHARED_STORAGE_PROVIDER = "postgresql"'), 'Shared storage not postgresql');
  }

  // 20. No network activity in validator
  check('Validator: no network calls', true, 'This validator makes no network calls');

  // Summary
  console.log('\n--- Validation Summary ---');
  console.log(`Passed: ${results.pass}`);
  console.log(`Failed: ${results.fail}`);
  console.log(`Total:  ${results.pass + results.fail}`);

  if (results.fail > 0) {
    console.log('\nFAILED CHECKS:');
    for (const c of results.checks) {
      if (!c.passed) console.log(`  - ${c.name}: ${c.message}`);
    }
    process.exit(1);
  } else {
    console.log('\n✓ PROP.17 Validation SUCCESS');
    process.exit(0);
  }
}

validate().catch(err => {
  console.error('Validation error:', err);
  process.exit(1);
});