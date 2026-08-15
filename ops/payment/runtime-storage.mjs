/* Nexora — Payment Runtime Storage Abstraction (PROP.13/16)
   Governed storage interface for portal sessions and payment records.
   Provider-neutral interfaces — no Node.js or Cloudflare Workers dependencies.
   TEST adapter uses deterministic file storage (Node-only, separate module).
   PRODUCTION requires explicit shared persistent storage adapter — fails closed if unavailable. */

/* Path constants are lazily initialized to avoid top-level fileURLToPath(import.meta.url)
   execution which fails in Cloudflare Workers bundling (validation error 10021).
   These are only used by Node-only TEST file adapter (runtime-storage-file-node.mjs). */
let _PRIVATE_DIR = null;
let _OUT_DIR = null;
let _require = null;

async function getNodeRequire() {
  if (_require !== null) return _require;
  // In ES modules, require is not available by default.
  // Use createRequire to get a require function that works in ES modules.
  // This only runs in Node.js context (TEST environment).
  const { createRequire } = await import('module');
  _require = createRequire(import.meta.url);
  return _require;
}

async function initNodePaths() {
  if (_PRIVATE_DIR !== null) return;
  // This function only runs in Node.js context (TEST environment)
  // Dynamic import to avoid bundling node:url/node:path in Workers
  const require = getNodeRequire();
  const { fileURLToPath } = require('node:url');
  const { join, dirname } = require('node:path');
  const __dirname = dirname(fileURLToPath(import.meta.url));
  const PAYMENT_DIR = __dirname;
  _PRIVATE_DIR = join(PAYMENT_DIR, 'private');
  _OUT_DIR = join(PAYMENT_DIR, 'out');
}

async function getPrivateDir() {
  await initNodePaths();
  return _PRIVATE_DIR;
}

async function getOutDir() {
  await initNodePaths();
  return _OUT_DIR;
}

export const STORAGE_SCHEMA = 'nexora-payment-storage/v1';
export const STORAGE_ADAPTERS = ['TEST_FILE', 'PRODUCTION_SHARED'];

/* ------------------------------------------------------------------ */
/* Shared Storage Client Contract (PROP.13 §4, §5, PROP.16)           */
/* Provider-neutral interface for shared persistent storage.          */
/* All PRODUCTION adapters MUST implement this contract.              */
/* ------------------------------------------------------------------ */
export class SharedStorageClient {
  /* Get value by key. Returns string or null if not found. */
  async get(key) { throw new Error('Not implemented'); }

  /* Set value by key. Overwrites if exists. Returns { ok: true }. */
  async set(key, value) { throw new Error('Not implemented'); }

  /* Delete key. Returns { ok: true } or { ok: false, reason }. */
  async delete(key) { throw new Error('Not implemented'); }

  /* Check if key exists. Returns boolean. */
  async exists(key) { throw new Error('Not implemented'); }

  /* Atomic compare-and-set: sets value only if current value matches expected.
     Returns { ok: true, success: true } or { ok: true, success: false } or { ok: false, reason }.
     REQUIRED for atomic idempotency (PROP.13 §6). */
  async compareAndSet(key, expectedValue, newValue) { throw new Error('Not implemented'); }

  /* Atomic set-if-absent: sets value only if key does not exist.
     Returns { ok: true, created: true } or { ok: true, created: false } or { ok: false, reason }.
     REQUIRED for atomic idempotency (PROP.13 §6). */
  async setIfAbsent(key, value) { throw new Error('Not implemented'); }

  /* List keys by prefix. Returns array of keys. Optional for secondary indexes. */
  async listByPrefix(prefix) { throw new Error('Not implemented'); }

  /* Adapter identification */
  getClientType() { return this.constructor.name; }
}

/* ------------------------------------------------------------------ */
/* Storage Interface (all adapters must implement)                    */
/* ------------------------------------------------------------------ */
export class PaymentStorageAdapter {
  constructor({ environment = 'TEST', config = {} }) {
    this.environment = environment;
    this.config = config;
  }

  /* Session operations */
  async createSession(session) { throw new Error('Not implemented'); }
  async getSession(sessionId) { throw new Error('Not implemented'); }
  async updateSession(session) { throw new Error('Not implemented'); }
  async findSessionByCheckoutSessionId(checkoutSessionId) { throw new Error('Not implemented'); }

  /* Payment record operations */
  async createPayment(payment) { throw new Error('Not implemented'); }
  async getPayment(paymentId) { throw new Error('Not implemented'); }
  async updatePayment(payment) { throw new Error('Not implemented'); }
  async findPaymentByRequestId(requestId) { throw new Error('Not implemented'); }

  /* Idempotency — MUST be atomic in PRODUCTION (PROP.13 §6) */
  async checkIdempotency(idempotencyKey) { throw new Error('Not implemented'); }
  async setIdempotency(idempotencyKey, eventId) { throw new Error('Not implemented'); }
  /* Atomic claim: returns { ok: true, claimed: true } if first, { ok: true, claimed: false, eventId } if duplicate, { ok: false, reason } on error */
  async claimIdempotency(idempotencyKey, eventId) { throw new Error('Not implemented'); }

  /* Adapter identification */
  getAdapterId() { return this.constructor.name; }
}

/* ------------------------------------------------------------------ */
/* PRODUCTION Adapter — requires explicit shared persistent storage  */
/* ------------------------------------------------------------------ */
export class ProductionStorageAdapter extends PaymentStorageAdapter {
  constructor(opts = {}) {
    if (!opts.config?.sharedStorageClient) {
      throw new Error('PRODUCTION storage requires config.sharedStorageClient implementing SharedStorageClient');
    }
    if (!opts.config?.sharedStorageClientType) {
      throw new Error('PRODUCTION storage requires config.sharedStorageClientType (e.g., "redis", "postgresql", "dynamodb")');
    }
    // Validate client implements required methods
    const client = opts.config.sharedStorageClient;
    const requiredMethods = ['get', 'set', 'delete', 'exists', 'compareAndSet', 'setIfAbsent'];
    for (const method of requiredMethods) {
      if (typeof client[method] !== 'function') {
        throw new Error(`SharedStorageClient missing required method: ${method}`);
      }
    }
    super({ environment: 'PRODUCTION', config: opts.config });
    this.client = opts.config.sharedStorageClient;
    this.clientType = opts.config.sharedStorageClientType;
    this.keyPrefix = opts.config.keyPrefix || 'nexora:payment:';
    this.envNamespace = opts.config.environmentNamespace || 'production';
  }

  /* Key format: nexora:payment:{environment}:{type}:{id} */
  sessionKey(sessionId) {
    return `${this.keyPrefix}${this.envNamespace}:session:${sessionId}`;
  }

  paymentKey(paymentId) {
    return `${this.keyPrefix}${this.envNamespace}:payment:${paymentId}`;
  }

  idempotencyKey(key) {
    return `${this.keyPrefix}${this.envNamespace}:idem:${key}`;
  }

  async createSession(session) {
    if (!session || !session.session_id) throw new Error('Session must have session_id');
    const key = this.sessionKey(session.session_id);
    const created = await this.client.setIfAbsent(key, JSON.stringify(session));
    if (!created.ok || !created.created) {
      throw new Error(`Session ${session.session_id} already exists`);
    }
    return { ok: true, session };
  }

  async getSession(sessionId) {
    const key = this.sessionKey(sessionId);
    const data = await this.client.get(key);
    return data ? JSON.parse(data) : null;
  }

  async updateSession(session) {
    if (!session || !session.session_id) throw new Error('Session must have session_id');
    const key = this.sessionKey(session.session_id);
    const exists = await this.client.exists(key);
    if (!exists) throw new Error(`Session ${session.session_id} not found`);
    await this.client.set(key, JSON.stringify(session));
    return { ok: true, session };
  }

  async findSessionByCheckoutSessionId(checkoutSessionId) {
    // Requires secondary index — implement based on clientType
    throw new Error(`findSessionByCheckoutSessionId not implemented for ${this.clientType} — add secondary index`);
  }

  async createPayment(payment) {
    if (!payment || !payment.payment_id) throw new Error('Payment must have payment_id');
    const key = this.paymentKey(payment.payment_id);
    const created = await this.client.setIfAbsent(key, JSON.stringify(payment));
    if (!created.ok || !created.created) {
      throw new Error(`Payment ${payment.payment_id} already exists`);
    }
    return { ok: true, payment };
  }

  async getPayment(paymentId) {
    const key = this.paymentKey(paymentId);
    const data = await this.client.get(key);
    return data ? JSON.parse(data) : null;
  }

  async updatePayment(payment) {
    if (!payment || !payment.payment_id) throw new Error('Payment must have payment_id');
    const key = this.paymentKey(payment.payment_id);
    const exists = await this.client.exists(key);
    if (!exists) throw new Error(`Payment ${payment.payment_id} not found`);
    await this.client.set(key, JSON.stringify(payment));
    return { ok: true, payment };
  }

  async findPaymentByRequestId(requestId) {
    throw new Error(`findPaymentByRequestId not implemented for ${this.clientType} — add secondary index`);
  }

  async checkIdempotency(idempotencyKey) {
    const key = this.idempotencyKey(idempotencyKey);
    const data = await this.client.get(key);
    return data ? { exists: true, eventId: JSON.parse(data).event_id } : { exists: false };
  }

  async setIdempotency(idempotencyKey, eventId) {
    const key = this.idempotencyKey(idempotencyKey);
    await this.client.set(key, JSON.stringify({ idempotency_key: idempotencyKey, event_id: eventId, created_at: new Date().toISOString() }));
    return { ok: true };
  }

  /* Atomic claim using compareAndSet (PRODUCTION - concurrency safe) */
  async claimIdempotency(idempotencyKey, eventId) {
    const key = this.idempotencyKey(idempotencyKey);
    const value = JSON.stringify({ idempotency_key: idempotencyKey, event_id: eventId, created_at: new Date().toISOString() });

    // Use setIfAbsent for atomic claim
    const result = await this.client.setIfAbsent(key, value);
    if (!result.ok) {
      return { ok: false, reason: result.reason || 'setIfAbsent failed' };
    }
    if (result.created) {
      return { ok: true, claimed: true };
    }
    // Key already existed - check what's there
    const existing = await this.client.get(key);
    return { ok: true, claimed: false, eventId: existing ? JSON.parse(existing).event_id : null };
  }
}

/* ------------------------------------------------------------------ */
/* Factory — creates adapter based on environment and config         */
/* ------------------------------------------------------------------ */
export function createStorageAdapter(opts = {}) {
  const environment = opts.environment || 'TEST';

  if (environment === 'PRODUCTION') {
    if (!opts.config?.sharedStorageClient || !opts.config?.sharedStorageClientType) {
      throw new Error('PRODUCTION environment requires explicit sharedStorageClient and sharedStorageClientType in config');
    }
    return new ProductionStorageAdapter(opts);
  }

  // TEST/SANDBOX — use Node-only file adapter (imported dynamically to avoid bundling node:fs in Workers)
  // This dynamic import prevents node:fs from being bundled in Cloudflare Workers
  if (environment === 'TEST') {
    return createTestFileStorageAdapter(opts);
  }

  throw new Error(`Unknown environment: ${environment}`);
}

/* Dynamic factory for TestFileStorageAdapter to avoid bundling node:fs */
async function createTestFileStorageAdapter(opts = {}) {
  const { TestFileStorageAdapter } = await import('./runtime-storage-file-node.mjs');
  return new TestFileStorageAdapter({
    baseDir: opts.config?.baseDir || await getPrivateDir(),
  });
}

/* Synchronous version for environments where dynamic import works */
export function createStorageAdapterSync(opts = {}) {
  const environment = opts.environment || 'TEST';

  if (environment === 'PRODUCTION') {
    if (!opts.config?.sharedStorageClient || !opts.config?.sharedStorageClientType) {
      throw new Error('PRODUCTION environment requires explicit sharedStorageClient and sharedStorageClientType in config');
    }
    return new ProductionStorageAdapter(opts);
  }

  // TEST/SANDBOX — use Node-only file adapter
  // This import path will fail in Cloudflare Workers (as intended - TEST environment shouldn't run there)
  const { TestFileStorageAdapter } = require('./runtime-storage-file-node.mjs');
  // getPrivateDir is now async, but this sync function only runs in Node.js TEST context
  // where initNodePaths has already run or will run synchronously via require
  return new TestFileStorageAdapter({
    baseDir: opts.config?.baseDir || _PRIVATE_DIR || getPrivateDirSync(),
  });
}

function getPrivateDirSync() {
  if (_PRIVATE_DIR !== null) return _PRIVATE_DIR;
  // Synchronous initialization for createStorageAdapterSync
  const { createRequire } = require('module');
  const req = createRequire(import.meta.url);
  const { fileURLToPath } = req('node:url');
  const { join, dirname } = req('node:path');
  const __dirname = dirname(fileURLToPath(import.meta.url));
  const PAYMENT_DIR = __dirname;
  _PRIVATE_DIR = join(PAYMENT_DIR, 'private');
  _OUT_DIR = join(PAYMENT_DIR, 'out');
  return _PRIVATE_DIR;
}

/* ------------------------------------------------------------------ */
/* Validation helper                                                 */
/* ------------------------------------------------------------------ */
export function validateStorageAdapter(adapter, environment) {
  if (!adapter || typeof adapter !== 'object') {
    return { ok: false, reason: 'adapter must be an object' };
  }
  const requiredMethods = [
    'createSession', 'getSession', 'updateSession', 'findSessionByCheckoutSessionId',
    'createPayment', 'getPayment', 'updatePayment', 'findPaymentByRequestId',
    'checkIdempotency', 'setIdempotency', 'claimIdempotency'
  ];
  if (!requiredMethods.every(m => typeof adapter[m] === 'function')) {
    return { ok: false, reason: 'adapter missing required methods' };
  }
  if (environment === 'PRODUCTION' && adapter.getAdapterId() === 'TestFileStorageAdapter') {
    return { ok: false, reason: 'TestFileStorageAdapter must not be used in PRODUCTION' };
  }
  if (environment === 'TEST' && adapter.getAdapterId() === 'ProductionStorageAdapter') {
    return { ok: false, reason: 'ProductionStorageAdapter requires PRODUCTION environment' };
  }
  return { ok: true };
}

export { getPrivateDir, getOutDir };