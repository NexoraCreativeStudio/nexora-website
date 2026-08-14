/* Nexora — Payment Runtime Storage Abstraction (PROP.13)
   Governed storage interface for portal sessions and payment records.
   TEST adapter uses deterministic file storage. PRODUCTION requires explicit
   shared persistent storage adapter — fails closed if unavailable. */

import { readFileSync, writeFileSync, existsSync, mkdirSync, readdirSync, unlinkSync, renameSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';

/* __dirname is ops/payment/ — derive project paths from it correctly. */
const __dirname = dirname(fileURLToPath(import.meta.url));
const PAYMENT_DIR = __dirname;
const OPS_DIR = dirname(PAYMENT_DIR);
const PRIVATE_DIR = join(PAYMENT_DIR, 'private');
const OUT_DIR = join(PAYMENT_DIR, 'out');

export const STORAGE_SCHEMA = 'nexora-payment-storage/v1';
export const STORAGE_ADAPTERS = ['TEST_FILE', 'PRODUCTION_SHARED'];

/* ------------------------------------------------------------------ */
/* Shared Storage Client Contract (PROP.13 §4, §5)                    */
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
/* TEST FILE Adapter — deterministic file-based storage               */
/* ------------------------------------------------------------------ */
export class TestFileStorageAdapter extends PaymentStorageAdapter {
  constructor(opts = {}) {
    super({ environment: 'TEST', config: opts.config || {} });
    this.baseDir = opts.baseDir || PRIVATE_DIR;
    this.ensureDirs();
  }

  ensureDirs() {
    const dirs = [
      join(this.baseDir, 'sessions'),
      join(this.baseDir, 'payments'),
      join(this.baseDir, 'idempotency'),
    ];
    for (const dir of dirs) {
      if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
    }
  }

  sessionPath(sessionId) {
    return join(this.baseDir, 'sessions', `${sessionId}.json`);
  }

  paymentPath(paymentId) {
    return join(this.baseDir, 'payments', `${paymentId}.json`);
  }

  idempotencyPath(key) {
    return join(this.baseDir, 'idempotency', `${key}.json`);
  }

  /* Atomic write with rename for crash safety */
  atomicWrite(filePath, data) {
    const tempPath = filePath + '.tmp';
    writeFileSync(tempPath, JSON.stringify(data, null, 2), 'utf8');
    // On POSIX, rename is atomic
    renameSync(tempPath, filePath);
  }

  async createSession(session) {
    if (!session || !session.session_id) throw new Error('Session must have session_id');
    if (existsSync(this.sessionPath(session.session_id))) {
      throw new Error(`Session ${session.session_id} already exists`);
    }
    this.atomicWrite(this.sessionPath(session.session_id), session);
    return { ok: true, session };
  }

  async getSession(sessionId) {
    const path = this.sessionPath(sessionId);
    if (!existsSync(path)) return null;
    return JSON.parse(readFileSync(path, 'utf8'));
  }

  async updateSession(session) {
    if (!session || !session.session_id) throw new Error('Session must have session_id');
    const path = this.sessionPath(session.session_id);
    if (!existsSync(path)) throw new Error(`Session ${session.session_id} not found`);
    this.atomicWrite(path, session);
    return { ok: true, session };
  }

  async findSessionByCheckoutSessionId(checkoutSessionId) {
    const sessionDir = join(this.baseDir, 'sessions');
    if (!existsSync(sessionDir)) return null;
    for (const file of readdirSync(sessionDir)) {
      if (file.endsWith('.json')) {
        const session = JSON.parse(readFileSync(join(sessionDir, file), 'utf8'));
        if (session.stripe_checkout_session_id === checkoutSessionId) {
          return session;
        }
      }
    }
    return null;
  }

  async createPayment(payment) {
    if (!payment || !payment.payment_id) throw new Error('Payment must have payment_id');
    if (existsSync(this.paymentPath(payment.payment_id))) {
      throw new Error(`Payment ${payment.payment_id} already exists`);
    }
    this.atomicWrite(this.paymentPath(payment.payment_id), payment);
    return { ok: true, payment };
  }

  async getPayment(paymentId) {
    const path = this.paymentPath(paymentId);
    if (!existsSync(path)) return null;
    return JSON.parse(readFileSync(path, 'utf8'));
  }

  async updatePayment(payment) {
    if (!payment || !payment.payment_id) throw new Error('Payment must have payment_id');
    const path = this.paymentPath(payment.paymentId || payment.payment_id);
    if (!existsSync(path)) throw new Error(`Payment ${payment.payment_id} not found`);
    this.atomicWrite(path, payment);
    return { ok: true, payment };
  }

  async findPaymentByRequestId(requestId) {
    const paymentDir = join(this.baseDir, 'payments');
    if (!existsSync(paymentDir)) return null;
    for (const file of readdirSync(paymentDir)) {
      if (file.endsWith('.json')) {
        const payment = JSON.parse(readFileSync(join(paymentDir, file), 'utf8'));
        if (payment.payment_request_id === requestId) {
          return payment;
        }
      }
    }
    return null;
  }

  async checkIdempotency(idempotencyKey) {
    const path = this.idempotencyPath(idempotencyKey);
    if (existsSync(path)) {
      const record = JSON.parse(readFileSync(path, 'utf8'));
      return { exists: true, eventId: record.event_id };
    }
    return { exists: false };
  }

  async setIdempotency(idempotencyKey, eventId) {
    const path = this.idempotencyPath(idempotencyKey);
    this.atomicWrite(path, { idempotency_key: idempotencyKey, event_id: eventId, created_at: new Date().toISOString() });
    return { ok: true };
  }

  /* Atomic claim using file-based locking (TEST only) */
  async claimIdempotency(idempotencyKey, eventId) {
    const path = this.idempotencyPath(idempotencyKey);
    if (existsSync(path)) {
      const record = JSON.parse(readFileSync(path, 'utf8'));
      return { ok: true, claimed: false, eventId: record.event_id };
    }
    this.atomicWrite(path, { idempotency_key: idempotencyKey, event_id: eventId, created_at: new Date().toISOString() });
    return { ok: true, claimed: true };
  }
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

  // TEST/SANDBOX
  return new TestFileStorageAdapter({
    baseDir: opts.config?.baseDir || PRIVATE_DIR,
  });
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

export { PRIVATE_DIR, OUT_DIR };