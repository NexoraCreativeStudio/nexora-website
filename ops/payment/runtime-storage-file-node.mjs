/* Nexora — File-based Storage Adapter for Node.js (PROP.13/16)
   Node-only implementation using node:fs — NOT for Cloudflare Workers bundle.
   Import this explicitly in Node test environments only. */

import { readFileSync, writeFileSync, existsSync, mkdirSync, readdirSync, unlinkSync, renameSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { PaymentStorageAdapter, getPrivateDir, getOutDir } from './runtime-storage.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const PAYMENT_DIR = __dirname;

/* ------------------------------------------------------------------ */
/* TEST FILE Adapter — deterministic file-based storage (Node only)   */
/* ------------------------------------------------------------------ */
export class TestFileStorageAdapter extends PaymentStorageAdapter {
  constructor(opts = {}) {
    super({ environment: 'TEST', config: opts.config || {} });
    this.baseDir = opts.baseDir || getPrivateDir();
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

  getAdapterId() {
    return 'TestFileStorageAdapter';
  }
}
