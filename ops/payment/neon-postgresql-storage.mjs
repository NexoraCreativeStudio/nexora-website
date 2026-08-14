/* Nexora — Neon PostgreSQL Shared Storage Client (PROP.16)
   Provider-specific adapter implementing SharedStorageClient contract for Neon PostgreSQL.
   Implements atomic compareAndSet and setIfAbsent using PostgreSQL transaction semantics.
   No real connection required for offline validators — supports injection of mock client. */

import { SharedStorageClient } from './runtime-storage.mjs';

/* Neon PostgreSQL Shared Storage Client
   Implements the provider-neutral SharedStorageClient contract using
   PostgreSQL-compatible atomic operations. */
export class NeonPostgreSQLStorageClient extends SharedStorageClient {
  /**
   * @param {Object} opts
   * @param {Object} opts.dbClient - Database client with query method (or mock for tests)
   * @param {string} opts.namespace - Namespace prefix for key isolation (e.g., 'nexora:payment:STAGING_TEST')
   * @param {Object} opts.config - Additional configuration
   */
  constructor(opts = {}) {
    super();

    if (!opts.dbClient || typeof opts.dbClient.query !== 'function') {
      throw new Error('NeonPostgreSQLStorageClient requires dbClient with query method');
    }
    if (!opts.namespace || typeof opts.namespace !== 'string') {
      throw new Error('NeonPostgreSQLStorageClient requires namespace string');
    }

    this.dbClient = opts.dbClient;
    this.namespace = opts.namespace;
    this.config = opts.config || {};
    this.tableName = this.config.tableName || 'nexora_kv_store';
  }

  /* Build fully qualified key with namespace */
  _key(key) {
    return `${this.namespace}:${key}`;
  }

  /* Get value by key */
  async get(key) {
    const fullKey = this._key(key);
    const result = await this.dbClient.query(
      `SELECT value FROM ${this.tableName} WHERE namespace = $1 AND key = $2`,
      [this.namespace, fullKey]
    );
    return result.rows.length > 0 ? result.rows[0].value : null;
  }

  /* Set value by key (overwrites if exists) */
  async set(key, value) {
    const fullKey = this._key(key);
    await this.dbClient.query(
      `INSERT INTO ${this.tableName} (namespace, key, value, created_at, updated_at)
       VALUES ($1, $2, $3, NOW(), NOW())
       ON CONFLICT (namespace, key) DO UPDATE SET
         value = EXCLUDED.value,
         updated_at = NOW()`,
      [this.namespace, fullKey, value]
    );
    return { ok: true };
  }

  /* Delete key */
  async delete(key) {
    const fullKey = this._key(key);
    const result = await this.dbClient.query(
      `DELETE FROM ${this.tableName} WHERE namespace = $1 AND key = $2`,
      [this.namespace, fullKey]
    );
    return { ok: true, deleted: result.rowCount > 0 };
  }

  /* Check if key exists */
  async exists(key) {
    const fullKey = this._key(key);
    const result = await this.dbClient.query(
      `SELECT 1 FROM ${this.tableName} WHERE namespace = $1 AND key = $2 LIMIT 1`,
      [this.namespace, fullKey]
    );
    return result.rows.length > 0;
  }

  /* Atomic compare-and-set: sets value only if current value matches expected.
     Uses PostgreSQL transaction with SELECT FOR UPDATE for linearizable semantics.
     Returns { ok: true, success: true } | { ok: true, success: false } | { ok: false, reason } */
  async compareAndSet(key, expectedValue, newValue) {
    const fullKey = this._key(key);

    try {
      await this.dbClient.query('BEGIN');

      // Lock the row for update to ensure linearizability
      const selectResult = await this.dbClient.query(
        `SELECT value FROM ${this.tableName} WHERE namespace = $1 AND key = $2 FOR UPDATE`,
        [this.namespace, fullKey]
      );

      const currentValue = selectResult.rows.length > 0 ? selectResult.rows[0].value : null;

      if (currentValue === expectedValue) {
        await this.dbClient.query(
          `INSERT INTO ${this.tableName} (namespace, key, value, created_at, updated_at)
           VALUES ($1, $2, $3, NOW(), NOW())
           ON CONFLICT (namespace, key) DO UPDATE SET
             value = EXCLUDED.value,
             updated_at = NOW()`,
          [this.namespace, fullKey, newValue]
        );
        await this.dbClient.query('COMMIT');
        return { ok: true, success: true };
      } else {
        await this.dbClient.query('ROLLBACK');
        return { ok: true, success: false };
      }
    } catch (err) {
      await this.dbClient.query('ROLLBACK').catch(() => {});
      return { ok: false, reason: err.message };
    }
  }

  /* Atomic set-if-absent: sets value only if key does not exist.
     Uses INSERT ... ON CONFLICT DO NOTHING for race-safe single-winner semantics.
     Returns { ok: true, created: true } | { ok: true, created: false } | { ok: false, reason } */
  async setIfAbsent(key, value) {
    const fullKey = this._key(key);

    try {
      const result = await this.dbClient.query(
        `INSERT INTO ${this.tableName} (namespace, key, value, created_at, updated_at)
         VALUES ($1, $2, $3, NOW(), NOW())
         ON CONFLICT (namespace, key) DO NOTHING
         RETURNING (xmax = 0) AS created`,
        [this.namespace, fullKey, value]
      );

      const created = result.rows.length > 0 && result.rows[0].created === true;
      return { ok: true, created };
    } catch (err) {
      return { ok: false, reason: err.message };
    }
  }

  /* List keys by prefix */
  async listByPrefix(prefix) {
    const fullPrefix = this._key(prefix);
    const result = await this.dbClient.query(
      `SELECT key FROM ${this.tableName}
       WHERE namespace = $1 AND key LIKE $2
       ORDER BY key`,
      [this.namespace, `${fullPrefix}%`]
    );

    return result.rows.map(row => {
      // Strip namespace prefix from returned keys
      const fullKey = row.key;
      if (fullKey.startsWith(this.namespace + ':')) {
        return fullKey.slice(this.namespace.length + 1);
      }
      return fullKey;
    });
  }

  getClientType() {
    return 'NeonPostgreSQLStorageClient';
  }

  /* Health check - tests basic connectivity */
  async healthCheck() {
    try {
      await this.dbClient.query('SELECT 1');
      return { ok: true };
    } catch (err) {
      return { ok: false, reason: err.message };
    }
  }
}

/* SQL Schema for Neon PostgreSQL
   Run this migration in Neon to create the required table.
   No credentials required — offline schema artifact. */
export const NEON_SCHEMA_SQL = `
-- Nexora Payment KV Store Schema for Neon PostgreSQL
-- Supports SharedStorageClient contract with atomic CAS and setIfAbsent
-- Namespace isolation via composite primary key

CREATE TABLE IF NOT EXISTS nexora_kv_store (
  namespace TEXT NOT NULL,
  key TEXT NOT NULL,
  value JSONB NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (namespace, key)
);

-- Index for prefix listing
CREATE INDEX IF NOT EXISTS idx_nexora_kv_store_namespace_key_prefix
ON nexora_kv_store (namespace, key);

-- Function for updated_at trigger
CREATE OR REPLACE FUNCTION update_nexora_kv_store_updated_at()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = NOW();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

-- Trigger for automatic updated_at
DROP TRIGGER IF EXISTS trigger_update_nexora_kv_store_updated_at ON nexora_kv_store;
CREATE TRIGGER trigger_update_nexora_kv_store_updated_at
  BEFORE UPDATE ON nexora_kv_store
  FOR EACH ROW EXECUTE FUNCTION update_nexora_kv_store_updated_at();
`;

/* Neon connection abstraction for Cloudflare Workers compatibility.
   Do not open real connection — supports injection of query client.
   Compatible with Neon serverless/HTTP driver interface. */
export class NeonConnection {
  /**
   * @param {Object} opts
   * @param {string} opts.connectionString - Neon connection string (not used directly, for reference)
   * @param {Object} opts.queryClient - Optional pre-configured query client (for Workers HTTP driver)
   */
  constructor(opts = {}) {
    this.connectionString = opts.connectionString;
    this.queryClient = opts.queryClient;
  }

  /* Execute a query - delegates to injected queryClient or throws if not configured */
  async query(sql, params = []) {
    if (!this.queryClient || typeof this.queryClient.query !== 'function') {
      throw new Error('NeonConnection requires queryClient with query method');
    }
    return this.queryClient.query(sql, params);
  }

  /* Close connection (no-op for serverless/HTTP driver) */
  async close() {
    // Serverless/HTTP driver doesn't need explicit close
    return { ok: true };
  }
}

/* Factory for creating Neon client from deployment config */
export function createNeonClient(config) {
  const provider = config.shared_storage_provider;
  if (provider !== 'postgresql' && provider !== 'neon') {
    throw new Error(`createNeonClient requires provider 'postgresql' or 'neon', got '${provider}'`);
  }

  // In real deployment, this would use Neon serverless driver:
  // import { neon } from '@neondatabase/serverless';
  // const sql = neon(process.env.DATABASE_URL);
  // const queryClient = { query: async (sql, params) => sql.query(sql, params) };

  // For offline/testing, require injection
  if (!config._testQueryClient) {
    throw new Error('Neon client requires _testQueryClient for offline testing. Provide a mock query client.');
  }

  return new NeonPostgreSQLStorageClient({
    dbClient: config._testQueryClient,
    namespace: config.shared_storage_namespace || 'nexora:payment:STAGING_TEST',
    config: {
      tableName: config.neon_table_name || 'nexora_kv_store',
    },
  });
}