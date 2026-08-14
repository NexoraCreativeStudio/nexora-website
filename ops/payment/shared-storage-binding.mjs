/* Nexora — Shared Storage Binding (PROP.14/15)
   Provider-neutral runtime binding from environment/config to ProductionStorageAdapter.
   Fails closed if provider not configured. No vendor chosen without Owner decision. */

import { SharedStorageClient, ProductionStorageAdapter, validateStorageAdapter } from './runtime-storage.mjs';
import { validateDeploymentConfig, DEPLOYMENT_ENVIRONMENTS, validateConfigSecurity } from './deployment-config.mjs';

/* Shared storage provider contract — all adapters must implement this */
export const SHARED_STORAGE_PROVIDER_CONTRACT = {
  /* Provider identifier — must be registered in secret manager / deployment config */
  identifier: 'string',           // e.g., 'redis', 'postgresql', 'dynamodb', 'memory-test'

  /* Required client methods (matching SharedStorageClient contract) */
  methods: [
    'get',           // async get(key) -> string | null
    'set',           // async set(key, value) -> { ok: true }
    'delete',        // async delete(key) -> { ok: true } | { ok: false, reason }
    'exists',        // async exists(key) -> boolean
    'compareAndSet', // async compareAndSet(key, expected, newValue) -> { ok: true, success: true } | { ok: true, success: false } | { ok: false, reason }
    'setIfAbsent',   // async setIfAbsent(key, value) -> { ok: true, created: true } | { ok: true, created: false } | { ok: false, reason }
    'listByPrefix',  // async listByPrefix(prefix) -> string[]
  ],

  /* Concurrency guarantees required for payment idempotency */
  concurrency: {
    compareAndSet: 'linearizable',    // Must be atomic — critical for idempotency
    setIfAbsent: 'linearizable',      // Must be atomic — critical for idempotency
    get: 'read-your-writes',          // Must see own writes immediately
    set: 'read-your-writes',          // Must see own writes immediately
  },

  /* Operational requirements */
  operational: {
    latency_p99_ms: 50,
    availability: '99.9%',
    durability: 'sync-replication-2z',
    tls_in_transit: true,
    encryption_at_rest: true,
    namespace_isolation: true,
  },
};

/* Provider registry — Owner registers implementations here */
export const PROVIDER_REGISTRY = new Map();

/* Register a provider implementation (called at startup) */
export function registerProvider(identifier, factory) {
  if (PROVIDER_REGISTRY.has(identifier)) {
    throw new Error(`Provider '${identifier}' already registered`);
  }
  // Validate factory returns object with required methods
  const instance = factory({}); // Test instantiation
  for (const method of SHARED_STORAGE_PROVIDER_CONTRACT.methods) {
    if (typeof instance[method] !== 'function') {
      throw new Error(`Provider '${identifier}' missing required method: ${method}`);
    }
  }
  PROVIDER_REGISTRY.set(identifier, factory);
}

/* Get registered provider factory */
export function getProviderFactory(identifier) {
  return PROVIDER_REGISTRY.get(identifier);
}

/* List registered providers */
export function listProviders() {
  return Array.from(PROVIDER_REGISTRY.keys());
}

/* Deterministic test adapter for LOCAL_TEST — implements SharedStorageClient contract */
export class MemoryTestSharedStorageClient extends SharedStorageClient {
  constructor(opts = {}) {
    super();
    this.store = new Map();
    this.namespace = opts.namespace || 'nexora:payment:LOCAL_TEST';
  }

  getKey(key) {
    return `${this.namespace}:${key}`;
  }

  async get(key) {
    const fullKey = this.getKey(key);
    const value = this.store.get(fullKey);
    return value !== undefined ? value : null;
  }

  async set(key, value) {
    const fullKey = this.getKey(key);
    this.store.set(fullKey, value);
    return { ok: true };
  }

  async delete(key) {
    const fullKey = this.getKey(key);
    const existed = this.store.has(fullKey);
    this.store.delete(fullKey);
    return { ok: true, deleted: existed };
  }

  async exists(key) {
    const fullKey = this.getKey(key);
    return this.store.has(fullKey);
  }

  async compareAndSet(key, expectedValue, newValue) {
    const fullKey = this.getKey(key);
    const current = this.store.get(fullKey);
    if (current === expectedValue) {
      this.store.set(fullKey, newValue);
      return { ok: true, success: true };
    }
    return { ok: true, success: false };
  }

  async setIfAbsent(key, value) {
    const fullKey = this.getKey(key);
    if (this.store.has(fullKey)) {
      return { ok: true, created: false };
    }
    this.store.set(fullKey, value);
    return { ok: true, created: true };
  }

  async listByPrefix(prefix) {
    const fullPrefix = this.getKey(prefix);
    const results = [];
    for (const key of this.store.keys()) {
      if (key.startsWith(fullPrefix)) {
        // Return the original key without namespace
        results.push(key.slice(this.namespace.length + 1));
      }
    }
    return results;
  }

  /* Idempotency methods — for test harness compatibility */
  async checkIdempotency(idempotencyKey) {
    const fullKey = this.getKey(`idem:${idempotencyKey}`);
    const record = this.store.get(fullKey);
    if (record) {
      return { exists: true, eventId: record.event_id };
    }
    return { exists: false };
  }

  async setIdempotency(idempotencyKey, eventId) {
    const fullKey = this.getKey(`idem:${idempotencyKey}`);
    this.store.set(fullKey, { idempotency_key: idempotencyKey, event_id: eventId, created_at: new Date().toISOString() });
    return { ok: true };
  }

  getClientType() {
    return 'MemoryTestSharedStorageClient';
  }

  /* For testing only — clear all data */
  clear() {
    this.store.clear();
  }
}

/* Factory — creates shared storage client from deployment configuration */
export function createSharedStorageClient(config) {
  const validated = validateDeploymentConfig(config);
  if (!validated.ok) {
    throw new Error(`Invalid deployment config for shared storage: ${validated.reasons.join(', ')}`);
  }

  // Security validation
  const security = validateConfigSecurity(config);
  if (!security.ok) {
    throw new Error(`Config security validation failed: ${security.reasons.join(', ')}`);
  }

  const environment = config.environment;

  // LOCAL_TEST: deterministic in-memory adapter
  if (environment === DEPLOYMENT_ENVIRONMENTS.LOCAL_TEST) {
    return new MemoryTestSharedStorageClient({
      namespace: config.shared_storage_namespace || 'nexora:payment:LOCAL_TEST',
    });
  }

  // STAGING_TEST and PRODUCTION_DISABLED: require explicit provider
  const provider = config.shared_storage_provider;
  if (!provider || provider === 'memory' || provider === 'memory-test') {
    throw new Error(
      `${environment} environment requires explicit SHARED_STORAGE_PROVIDER (e.g., 'redis', 'postgresql', 'dynamodb'). ` +
      'Memory adapter is only valid for LOCAL_TEST.'
    );
  }

  // Look up provider in registry
  const factory = PROVIDER_REGISTRY.get(provider);
  if (!factory) {
    throw new Error(
      `SHARED_STORAGE_PROVIDER '${provider}' not registered. ` +
      `OWNER DECISION REQUIRED — PAYMENT SHARED STORAGE PROVIDER. ` +
      `Available providers: ${listProviders().join(', ') || 'none registered'}. ` +
      `See ops/payment/runtime-storage.mjs for the SharedStorageClient contract.`
    );
  }

  // Create provider instance with config
  return factory(config);
}

/* Create ProductionStorageAdapter bound to deployment config */
export function createBoundProductionStorageAdapter(config) {
  const client = createSharedStorageClient(config);

  const adapter = new ProductionStorageAdapter({
    config: {
      sharedStorageClient: client,
      sharedStorageClientType: config.shared_storage_provider,
      keyPrefix: 'nexora:payment:',
      environmentNamespace: config.environment,
    },
  });

  // Validate the adapter
  const validation = validateStorageAdapter(adapter, config.environment === DEPLOYMENT_ENVIRONMENTS.LOCAL_TEST ? 'TEST' : 'PRODUCTION');
  if (!validation.ok) {
    throw new Error(`Bound ProductionStorageAdapter validation failed: ${validation.reason}`);
  }

  return adapter;
}

/* Convenience: create client directly from environment (for endpoint handlers) */
export async function createSharedStorageClientFromEnv(env = process.env) {
  const { buildConfigFromEnv } = await import('./deployment-config.mjs');
  const config = buildConfigFromEnv(env);
  return createSharedStorageClient(config);
}

/* Convenience: create adapter directly from environment (for endpoint handlers) */
export async function createBoundProductionStorageAdapterFromEnv(env = process.env) {
  const { buildConfigFromEnv } = await import('./deployment-config.mjs');
  const config = buildConfigFromEnv(env);
  return createBoundProductionStorageAdapter(config);
}

/* Validate shared storage connectivity (ping/health check) */
export async function validateSharedStorageConnectivity(client) {
  try {
    // Test basic get/set operations to verify connectivity
    const testKey = `health-check-${Date.now()}`;
    const testValue = { test: true, timestamp: new Date().toISOString() };

    await client.set(testKey, testValue);
    const retrieved = await client.get(testKey);
    await client.delete(testKey);

    if (!retrieved || retrieved.test !== true) {
      return { ok: false, reason: 'Connectivity test failed: data mismatch' };
    }

    return { ok: true, reason: 'Shared storage connectivity verified' };
  } catch (err) {
    return { ok: false, reason: `Connectivity test failed: ${err.message}` };
  }
}