/* Nexora — Neon PostgreSQL Workers Runtime Binding (PROP.17)
   Cloudflare Workers-compatible Neon PostgreSQL client using @neondatabase/serverless.
   Implements SharedStorageClient contract for STAGING_TEST deployment.
   No real connection in validators — supports mock injection for offline testing. */

import { SharedStorageClient } from './runtime-storage.mjs';

/* Neon Workers Client
   Wraps @neondatabase/serverless for Cloudflare Workers compatibility.
   Provides query interface matching NeonPostgreSQLStorageClient expectations. */
export class NeonWorkersClient {
  /**
   * @param {Object} opts
   * @param {string} opts.connectionString - Neon connection string (from env binding)
   * @param {Object|Function} opts.mockQueryClient - Optional mock for offline testing (object with query method, or query function)
   */
  constructor(opts = {}) {
    this.connectionString = opts.connectionString;
    this.mockQueryClient = opts.mockQueryClient;
    this._sql = null;
    this._initialized = false;
  }

  /* Initialize the Neon serverless client (lazy) */
  async _init() {
    if (this._initialized) return;

    if (this.mockQueryClient) {
      // Offline testing mode - use injected mock
      // Support both object with query method and direct query function
      this._sql = typeof this.mockQueryClient === 'function'
        ? this.mockQueryClient
        : this.mockQueryClient.query.bind(this.mockQueryClient);
      this._initialized = true;
      return;
    }

    if (!this.connectionString) {
      throw new Error('NeonWorkersClient requires connectionString or mockQueryClient');
    }

    // Dynamic import to avoid bundling issues in non-Workers environments
    const { neon } = await import('@neondatabase/serverless');
    this._sql = neon(this.connectionString);
    this._initialized = true;
  }

  /* Execute a query - compatible with NeonPostgreSQLStorageClient expectations */
  async query(sql, params = []) {
    await this._init();

    if (!this._sql || typeof this._sql !== 'function') {
      throw new Error('Neon client not initialized');
    }

    try {
      // @neondatabase/serverless returns array of rows directly
      // Mock query client also returns array of rows directly
      const result = await this._sql(sql, params);
      return Array.isArray(result) ? { rows: result, rowCount: result.length } : result;
    } catch (err) {
      throw new Error(`Neon query failed: ${err.message}`);
    }
  }

  /* Close connection (no-op for serverless) */
  async close() {
    // Serverless driver doesn't need explicit close
    return { ok: true };
  }

  /* Health check */
  async healthCheck() {
    try {
      await this.query('SELECT 1');
      return { ok: true };
    } catch (err) {
      return { ok: false, reason: err.message };
    }
  }
}

/* Neon PostgreSQL Storage Client for Workers
   Implements SharedStorageClient contract using NeonWorkersClient. */
export class NeonWorkersPostgreSQLStorageClient extends SharedStorageClient {
  /**
   * @param {Object} opts
   * @param {NeonWorkersClient} opts.dbClient - NeonWorkersClient instance
   * @param {string} opts.namespace - Namespace prefix (e.g., 'nexora:payment:STAGING_TEST')
   * @param {Object} opts.config - Additional configuration
   */
  constructor(opts = {}) {
    super();

    if (!opts.dbClient || typeof opts.dbClient.query !== 'function') {
      throw new Error('NeonWorkersPostgreSQLStorageClient requires dbClient with query method');
    }
    if (!opts.namespace || typeof opts.namespace !== 'string') {
      throw new Error('NeonWorkersPostgreSQLStorageClient requires namespace string');
    }

    this.dbClient = opts.dbClient;
    this.namespace = opts.namespace;
    this.config = opts.config || {};
    this.tableName = this.config.tableName || 'nexora_kv_store';
  }

  /* Build fully qualified key with namespace.
     If key already starts with the namespace, avoid double-prefixing. */
  _key(key) {
    if (key.startsWith(this.namespace + ':')) {
      return key;
    }
    const fullKey = `${this.namespace}:${key}`;
    // DEBUG: log namespace prefixing
    if (process.env.NEXORA_DEBUG_STORAGE_KEYS === 'true') {
      console.error('[NeonWorkersClient._key] input_key:', key, 'provider_namespace:', this.namespace, 'final_key:', fullKey);
    }
    return fullKey;
  }

  /* Get value by key */
  async get(key) {
    const fullKey = this._key(key);
    // DEBUG
    if (process.env.NEXORA_DEBUG_STORAGE_KEYS === 'true') {
      console.error('[NeonWorkersClient.get] provider_namespace:', this.namespace, 'final_key:', fullKey);
    }
    const result = await this.dbClient.query(
      `SELECT value FROM ${this.tableName} WHERE namespace = $1 AND key = $2`,
      [this.namespace, fullKey]
    );
    return result.rows.length > 0 ? result.rows[0].value : null;
  }

  /* Set value by key (overwrites if exists) */
  async set(key, value) {
    const fullKey = this._key(key);
    // DEBUG
    if (process.env.NEXORA_DEBUG_STORAGE_KEYS === 'true') {
      console.error('[NeonWorkersClient.set] provider_namespace:', this.namespace, 'final_key:', fullKey);
    }
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
    // DEBUG: log key divergence
    if (process.env.NEXORA_DEBUG_STORAGE_KEYS === 'true') {
      console.error('[NeonWorkersClient.exists] input_key:', key, 'provider_namespace:', this.namespace, 'final_key:', fullKey);
    }
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
    // DEBUG: log key divergence
    if (process.env.NEXORA_DEBUG_STORAGE_KEYS === 'true') {
      console.error('[NeonWorkersClient.setIfAbsent] input_key:', key, 'provider_namespace:', this.namespace, 'final_key:', fullKey);
    }

    try {
      const result = await this.dbClient.query(
        `INSERT INTO ${this.tableName} (namespace, key, value, created_at, updated_at)
         VALUES ($1, $2, $3, NOW(), NOW())
         ON CONFLICT (namespace, key) DO NOTHING
         RETURNING (xmax = 0) AS created`,
        [this.namespace, fullKey, value]
      );

      const created = result.rows.length > 0 && result.rows[0].created === true;
      // DEBUG: log result
      if (process.env.NEXORA_DEBUG_STORAGE_KEYS === 'true') {
        console.error('[NeonWorkersClient.setIfAbsent] created:', created, 'provider_namespace:', this.namespace, 'final_key:', fullKey);
      }
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
      const fullKey = row.key;
      if (fullKey.startsWith(this.namespace + ':')) {
        return fullKey.slice(this.namespace.length + 1);
      }
      return fullKey;
    });
  }

  getClientType() {
    return 'NeonWorkersPostgreSQLStorageClient';
  }

  /* Health check */
  async healthCheck() {
    return await this.dbClient.healthCheck();
  }
}

/* Factory for creating Neon Workers client from deployment config */
export async function createNeonWorkersClient(config) {
  const provider = config.shared_storage_provider;
  // Accept both Workers-specific providers and generic ones
  const validProviders = ['postgresql', 'neon', 'postgresql-workers', 'neon-workers'];
  if (!validProviders.includes(provider)) {
    throw new Error(`createNeonWorkersClient requires provider 'postgresql', 'neon', 'postgresql-workers', or 'neon-workers', got '${provider}'`);
  }

  // Get connection string from env (in Workers, this comes from secret binding)
  const connectionString = config.neon_database_url || process.env.NEON_DATABASE_URL;

  // For offline testing, allow mock injection
  const mockQueryClient = config._testQueryClient;

  const neonClient = new NeonWorkersClient({
    connectionString,
    mockQueryClient,
  });

  return new NeonWorkersPostgreSQLStorageClient({
    dbClient: neonClient,
    namespace: config.shared_storage_namespace || 'nexora:payment:STAGING_TEST',
    config: {
      tableName: config.neon_table_name || 'nexora_kv_store',
    },
  });
}

/* Re-export schema from canonical source */
export { NEON_SCHEMA_SQL } from './neon-postgresql-storage.mjs';

/* Export for shared-storage-binding integration (createNeonWorkersClient exported at line 243, classes at lines 11/81) */