/* Nexora — Shared Storage Binding (PROP.14)
   Provider-neutral runtime binding from environment/config to ProductionStorageAdapter.
   Fails closed if provider not configured. No vendor chosen without Owner decision. */

import { SharedStorageClient, ProductionStorageAdapter, validateStorageAdapter } from './runtime-storage.mjs';
import { validateDeploymentConfig, DEPLOYMENT_ENVIRONMENTS } from './deployment-config.mjs';

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
};

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

  // Provider-specific implementations would be registered here
  // For now, fail closed with clear message about Owner decision needed
  throw new Error(
    `SHARED_STORAGE_PROVIDER '${provider}' not implemented. ` +
    `OWNER DECISION REQUIRED — PAYMENT SHARED STORAGE PROVIDER. ` +
    `Supported providers must implement SharedStorageClient contract. ` +
    `See ops/payment/runtime-storage.mjs for the contract.`
  );
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

/* Provider registration for future Owner decisions */
/*
export const PROVIDER_REGISTRY = {
  'redis': (config) => new RedisSharedStorageClient(config),
  'postgresql': (config) => new PostgresSharedStorageClient(config),
  'dynamodb': (config) => new DynamoDBSharedStorageClient(config),
};

function createSharedStorageClient(config) {
  const provider = config.shared_storage_provider;
  const factory = PROVIDER_REGISTRY[provider];
  if (!factory) {
    throw new Error(`Unknown shared storage provider: ${provider}`);
  }
  return factory(config);
}
*/