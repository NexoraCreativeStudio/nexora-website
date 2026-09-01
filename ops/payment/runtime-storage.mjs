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
    if (!opts.config?.sharedStorageNamespace) {
      throw new Error('PRODUCTION storage requires config.sharedStorageNamespace (e.g., "nexora/payment/STAGING_TEST")');
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
    this.sharedStorageNamespace = opts.config.sharedStorageNamespace;
  }

  /* Key format uses sharedStorageNamespace from config (e.g., nexora/payment/STAGING_TEST:session:...) */
  sessionKey(sessionId) {
    return `${this.sharedStorageNamespace}:session:${sessionId}`;
  }

  paymentKey(paymentId) {
    return `${this.sharedStorageNamespace}:payment:${paymentId}`;
  }

  idempotencyKey(key) {
    return `${this.sharedStorageNamespace}:idem:${key}`;
  }

  async createSession(session) {
    if (!session || !session.session_id) throw new Error('Session must have session_id');
    const key = this.sessionKey(session.session_id);
    // DEBUG: log key construction
    if (process.env.NEXORA_DEBUG_STORAGE_KEYS === 'true') {
      console.error('[ProductionStorageAdapter.createSession] session_id:', session.session_id, 'adapter_key:', key, 'provider_namespace:', this.sharedStorageNamespace);
    }
    const created = await this.client.setIfAbsent(key, JSON.stringify(session));
    if (!created.ok || !created.created) {
      throw new Error(`Session ${session.session_id} already exists`);
    }
    // Secondary index: checkout_session_id -> session_id
    if (session.stripe_checkout_session_id) {
      const idxKey = this.checkoutIndexKey(session.stripe_checkout_session_id);
      await this.client.set(idxKey, JSON.stringify(session.session_id));
    }
    // Secondary index: token_id -> session_id
    if (session.token_id) {
      const idxKey = this.tokenIndexKey(session.token_id);
      await this.client.set(idxKey, JSON.stringify(session.session_id));
    }
    return { ok: true, session };
  }

  async getSession(sessionId) {
    const key = this.sessionKey(sessionId);
    // DEBUG: log key construction
    if (process.env.NEXORA_DEBUG_STORAGE_KEYS === 'true') {
      console.error('[ProductionStorageAdapter.getSession] session_id:', sessionId, 'adapter_key:', key, 'provider_namespace:', this.sharedStorageNamespace);
    }
    const data = await this.client.get(key);
    if (!data) return null;
    // Neon JSONB driver returns already-parsed objects; file adapter returns strings
    return typeof data === 'string' ? JSON.parse(data) : data;
  }

  async updateSession(session) {
    if (!session || !session.session_id) throw new Error('Session must have session_id');
    const key = this.sessionKey(session.session_id);
    const exists = await this.client.exists(key);
    if (!exists) throw new Error(`Session ${session.session_id} not found`);
    await this.client.set(key, JSON.stringify(session));
    return { ok: true, session };
  }

  /* Secondary index helpers */
  checkoutIndexKey(checkoutSessionId) {
    return `${this.sharedStorageNamespace}:idx:checkout:${checkoutSessionId}`;
  }

  requestIndexKey(requestId) {
    return `${this.sharedStorageNamespace}:idx:request:${requestId}`;
  }

  async findSessionByCheckoutSessionId(checkoutSessionId) {
    const idxKey = this.checkoutIndexKey(checkoutSessionId);
    const sessionId = await this.client.get(idxKey);
    if (!sessionId) return null;
    // Neon JSONB driver auto-parses JSON strings (returns plain string);
    // file adapter returns raw JSON string (with quotes).
    // Handle both: try parse, fallback to raw if already a plain string.
    let parsed = sessionId;
    if (typeof sessionId === 'string' && sessionId.startsWith('"')) {
      try { parsed = JSON.parse(sessionId); } catch { parsed = sessionId; }
    }
    return this.getSession(parsed);
  }

  /* Secondary index: token_id -> session_id */
  tokenIndexKey(tokenId) {
    return `${this.sharedStorageNamespace}:idx:token:${tokenId}`;
  }

  async getSessionByTokenId(tokenId) {
    const idxKey = this.tokenIndexKey(tokenId);
    const sessionId = await this.client.get(idxKey);
    if (!sessionId) return null;
    // Neon JSONB driver auto-parses JSON strings (returns plain string);
    // file adapter returns raw JSON string (with quotes).
    // Handle both: try parse, fallback to raw if already a plain string.
    let parsed = sessionId;
    if (typeof sessionId === 'string' && sessionId.startsWith('"')) {
      try { parsed = JSON.parse(sessionId); } catch { parsed = sessionId; }
    }
    return this.getSession(parsed);
  }

  async createPayment(payment) {
    if (!payment || !payment.payment_id) throw new Error('Payment must have payment_id');
    const key = this.paymentKey(payment.payment_id);
    const created = await this.client.setIfAbsent(key, JSON.stringify(payment));
    if (!created.ok || !created.created) {
      throw new Error(`Payment ${payment.payment_id} already exists`);
    }
    // Secondary index: payment_request_id -> payment_id
    if (payment.payment_request_id) {
      const idxKey = this.requestIndexKey(payment.payment_request_id);
      await this.client.set(idxKey, JSON.stringify(payment.payment_id));
    }
    return { ok: true, payment };
  }

  async getPayment(paymentId) {
    const key = this.paymentKey(paymentId);
    const data = await this.client.get(key);
    if (!data) return null;
    return typeof data === 'string' ? JSON.parse(data) : data;
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
    const idxKey = this.requestIndexKey(requestId);
    const paymentId = await this.client.get(idxKey);
    if (!paymentId) return null;
    // Neon JSONB driver auto-parses JSON strings (returns plain string);
    // file adapter returns raw JSON string (with quotes).
    // Handle both: try parse, fallback to raw if already a plain string.
    let parsed = paymentId;
    if (typeof paymentId === 'string' && paymentId.startsWith('"')) {
      try { parsed = JSON.parse(paymentId); } catch { parsed = paymentId; }
    }
    return this.getPayment(parsed);
  }

  async checkIdempotency(idempotencyKey) {
    const key = this.idempotencyKey(idempotencyKey);
    const data = await this.client.get(key);
    if (!data) return { exists: false };
    const record = typeof data === 'string' ? JSON.parse(data) : data;
    return { exists: true, eventId: record.event_id };
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
    if (!existing) return { ok: true, claimed: false, eventId: null };
    const record = typeof existing === 'string' ? JSON.parse(existing) : existing;
    return { ok: true, claimed: false, eventId: record ? record.event_id : null };
  }

  /* Generic get/set/delete for arbitrary keys (delegates to underlying client) */
  async get(key) {
    const data = await this.client.get(key);
    if (!data) return null;
    return typeof data === 'string' ? JSON.parse(data) : data;
  }

  async set(key, value) {
    return await this.client.set(key, value);
  }

  async delete(key) {
    return await this.client.delete(key);
  }

  async exists(key) {
    return await this.client.exists(key);
  }
}

/* ------------------------------------------------------------------ */
/* TEST Adapter Registry (PROP.17)                                    */
/* ------------------------------------------------------------------ */
let _TestFileStorageAdapter = null;
export function setTestFileStorageAdapter(adapter) {
  _TestFileStorageAdapter = adapter;
}

/* Factory — creates adapter based on environment and config         */
export function createStorageAdapter(opts = {}) {
  const environment = opts.environment || 'TEST';

  if (environment === 'PRODUCTION') {
    if (!opts.config?.sharedStorageClient || !opts.config?.sharedStorageClientType) {
      throw new Error('PRODUCTION environment requires explicit sharedStorageClient and sharedStorageClientType in config');
    }
    return new ProductionStorageAdapter(opts);
  }

  // TEST/SANDBOX — use Node-only file adapter (set via setTestFileStorageAdapter)
  if (environment === 'TEST') {
    if (!_TestFileStorageAdapter) {
      throw new Error('TEST environment requires TestFileStorageAdapter to be set via setTestFileStorageAdapter');
    }
    return new _TestFileStorageAdapter({
      baseDir: opts.config?.baseDir || _PRIVATE_DIR || getPrivateDirSync(),
    });
  }

  throw new Error(`Unknown environment: ${environment}`);
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
  // Using runtime variable prevents Wrangler from statically analyzing and bundling the import
  const testFileAdapterPath = './runtime-storage-file-node.mjs';
  const { TestFileStorageAdapter } = require(testFileAdapterPath);
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
  // ProductionStorageAdapter is a wrapper - validate the underlying client type
  if (adapter.getAdapterId() === 'ProductionStorageAdapter' && adapter.client) {
    const clientType = adapter.client.getClientType();
    if (environment === 'PRODUCTION' && clientType === 'MemoryTestSharedStorageClient') {
      return { ok: false, reason: 'MemoryTestSharedStorageClient must not be used in PRODUCTION' };
    }
    // ProductionStorageAdapter wrapping MemoryTestSharedStorageClient is OK for TEST
    return { ok: true };
  }
  if (environment === 'PRODUCTION' && adapter.getAdapterId() === 'TestFileStorageAdapter') {
    return { ok: false, reason: 'TestFileStorageAdapter must not be used in PRODUCTION' };
  }
  return { ok: true };
}

export { getPrivateDir, getOutDir };