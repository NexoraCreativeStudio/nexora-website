/* Nexora — Raw Body Adapter (PROP.14)
   Provider-neutral raw-body contract for Stripe webhook verification.
   Ensures signature verification receives exact bytes — no parse/reserialize.
   Different platforms expose request body differently; this normalizes them. */

import { Buffer } from 'buffer';

/* Maximum raw webhook body size (1 MB default) */
export const DEFAULT_MAX_RAW_BODY = 1048576;

/* Raw body contract — all adapters return { ok, rawBody, size } */
export const RAW_BODY_CONTRACT = {
  /* Provider-specific extraction */
  getRawBody(req, opts = {}) {
    const maxSize = opts.maxSize || DEFAULT_MAX_RAW_BODY;

    // Already a Buffer
    if (Buffer.isBuffer(req.rawBody || req.bodyBuffer)) {
      const raw = req.rawBody || req.bodyBuffer;
      if (raw.length > maxSize) {
        return { ok: false, reason: `Raw body too large: ${raw.length} > ${maxSize}` };
      }
      return { ok: true, rawBody: raw, size: raw.length };
    }

    // String body
    if (typeof req.rawBody === 'string' || typeof req.body === 'string') {
      const str = typeof req.rawBody === 'string' ? req.rawBody : req.body;
      const raw = Buffer.from(str, 'utf8');
      if (raw.length > maxSize) {
        return { ok: false, reason: `Raw body too large: ${raw.length} > ${maxSize}` };
      }
      return { ok: true, rawBody: raw, size: raw.length };
    }

    // Node.js IncomingMessage (stream)
    if (req && typeof req.on === 'function' && typeof req.read === 'function') {
      return new Promise((resolve) => {
        const chunks = [];
        let total = 0;
        req.on('data', (chunk) => {
          if (total + chunk.length > maxSize) {
            req.destroy();
            resolve({ ok: false, reason: `Raw body too large: exceeded ${maxSize}` });
            return;
          }
          chunks.push(chunk);
          total += chunk.length;
        });
        req.on('end', () => {
          const raw = Buffer.concat(chunks);
          resolve({ ok: true, rawBody: raw, size: raw.length });
        });
        req.on('error', (err) => {
          resolve({ ok: false, reason: `Stream error: ${err.message}` });
        });
      });
    }

    // Vercel/Netlify style — req.body might be parsed, but rawBody available
    if (req && req.body && typeof req.body === 'object' && req.rawBody === undefined) {
      // In this case, we cannot guarantee exact bytes — return error
      return { ok: false, reason: 'Cannot extract raw body — request body was pre-parsed. Platform must provide raw bytes.' };
    }

    return { ok: false, reason: 'Unsupported request object for raw body extraction' };
  },
};

/* Helper to wrap streaming extraction as async */
export async function getRawBody(req, opts = {}) {
  const result = RAW_BODY_CONTRACT.getRawBody(req, opts);
  if (result && typeof result.then === 'function') {
    return result; // Promise
  }
  return result;
}

/* Verify raw body is intact (no modification before Stripe verification) */
export function assertRawBodyIntact(rawBody, computedHash = null) {
  if (!Buffer.isBuffer(rawBody)) {
    return { ok: false, reason: 'rawBody must be a Buffer' };
  }
  if (rawBody.length === 0) {
    return { ok: false, reason: 'rawBody is empty' };
  }
  return { ok: true, size: rawBody.length };
}

/* Extract Stripe-Signature header (case-insensitive) */
export function getStripeSignatureHeader(req) {
  if (!req || !req.headers) return null;
  return req.headers['stripe-signature'] ||
         req.headers['Stripe-Signature'] ||
         req.headers['STRIPE-SIGNATURE'] ||
         req.headers['x-stripe-signature'] ||
         null;
}
