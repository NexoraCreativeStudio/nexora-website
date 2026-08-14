/* Nexora — Neon PostgreSQL Schema Contract (PROP.16)
   Defines schema requirements for Neon PostgreSQL shared storage.
   No real migrations executed — offline schema artifact only.
   Supports SharedStorageClient contract with atomic CAS and setIfAbsent. */

export const NEON_SCHEMA_VERSION = 'nexora-payment-storage/v1';

/* Conceptual table schema for governed KV storage */
export const NEON_TABLE_SCHEMA = {
  tableName: 'nexora_kv_store',
  columns: [
    { name: 'namespace', type: 'TEXT', notNull: true, description: 'Namespace prefix for isolation (e.g., nexora/payment/STAGING_TEST)' },
    { name: 'key', type: 'TEXT', notNull: true, description: 'Full key within namespace' },
    { name: 'value', type: 'JSONB', notNull: true, description: 'Stored value as JSONB' },
    { name: 'created_at', type: 'TIMESTAMPTZ', notNull: true, default: 'NOW()', description: 'Creation timestamp' },
    { name: 'updated_at', type: 'TIMESTAMPTZ', notNull: true, default: 'NOW()', description: 'Last update timestamp' },
  ],
  primaryKey: ['namespace', 'key'],
  indexes: [
    { name: 'idx_nexora_kv_store_namespace_key_prefix', columns: ['namespace', 'key'], description: 'Prefix listing support' },
  ],
  triggers: [
    {
      name: 'trigger_update_nexora_kv_store_updated_at',
      function: 'update_nexora_kv_store_updated_at',
      timing: 'BEFORE UPDATE',
      description: 'Automatic updated_at timestamp',
    },
  ],
};

/* Unique constraint required for atomic operations */
export const NEON_UNIQUE_CONSTRAINT = {
  name: 'pk_nexora_kv_store',
  columns: ['namespace', 'key'],
  description: 'Composite primary key enables namespace isolation and atomic CAS/setIfAbsent',
};

/* Namespace isolation strategy:
   - Each environment gets unique namespace prefix
   - LOCAL_TEST: nexora:payment:LOCAL_TEST
   - STAGING_TEST: nexora:payment:STAGING_TEST
   - PRODUCTION_DISABLED: nexora:payment:PRODUCTION_DISABLED
   - Keys are prefixed with namespace at application level
   - Database enforces uniqueness per (namespace, key) pair
*/

/* SQL Migration for Neon PostgreSQL (offline artifact)
   Run this in Neon SQL editor or via migration tool.
   No credentials, no network calls required for this artifact. */
export const NEON_MIGRATION_SQL = `-- Nexora Payment KV Store Schema for Neon PostgreSQL
-- Schema version: ${NEON_SCHEMA_VERSION}
-- Supports SharedStorageClient contract with atomic CAS and setIfAbsent
-- Namespace isolation via composite primary key

-- Main KV store table
CREATE TABLE IF NOT EXISTS nexora_kv_store (
  namespace TEXT NOT NULL,
  key TEXT NOT NULL,
  value JSONB NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (namespace, key)
);

-- Index for efficient prefix listing
CREATE INDEX IF NOT EXISTS idx_nexora_kv_store_namespace_key_prefix
ON nexora_kv_store (namespace, key);

-- Updated_at trigger function
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

-- Example namespace isolation (for reference - actual namespaces set via config)
-- INSERT INTO nexora_kv_store (namespace, key, value) VALUES
--   ('nexora:payment:STAGING_TEST', 'session:PSS-abc123', '{"session_id": "PSS-abc123", ...}'),
--   ('nexora:payment:STAGING_TEST', 'payment:PAY-2026-9898-001', '{"payment_id": "PAY-2026-9898-001", ...}'),
--   ('nexora:payment:STAGING_TEST', 'idem:evt_test_abc', '{"idempotency_key": "evt_test_abc", "event_id": "evt_123", ...}');
`;

/* Atomic operation SQL patterns used by NeonPostgreSQLStorageClient */

/* setIfAbsent - uses INSERT ... ON CONFLICT DO NOTHING
   Returns exactly one winner in race conditions.
   PostgreSQL's ON CONFLICT DO NOTHING with RETURNING (xmax = 0) AS created
   provides race-safe single-winner semantics. */
export const SET_IF_ABSENT_SQL = `
INSERT INTO nexora_kv_store (namespace, key, value, created_at, updated_at)
VALUES ($1, $2, $3, NOW(), NOW())
ON CONFLICT (namespace, key) DO NOTHING
RETURNING (xmax = 0) AS created;
`;

/* compareAndSet - uses transaction with SELECT FOR UPDATE
   Ensures linearizable compare-and-set semantics.
   Row is locked for the duration of the transaction. */
export const COMPARE_AND_SET_SQL = `
BEGIN;
SELECT value FROM nexora_kv_store WHERE namespace = $1 AND key = $2 FOR UPDATE;
-- Application compares current value with expected
-- If matched:
INSERT INTO nexora_kv_store (namespace, key, value, created_at, updated_at)
VALUES ($1, $2, $3, NOW(), NOW())
ON CONFLICT (namespace, key) DO UPDATE SET
  value = EXCLUDED.value,
  updated_at = NOW();
COMMIT;
-- If not matched: ROLLBACK;
`;

/* Standard get/set/delete/exists operations */
export const GET_SQL = `SELECT value FROM nexora_kv_store WHERE namespace = $1 AND key = $2;`;
export const SET_SQL = `
INSERT INTO nexora_kv_store (namespace, key, value, created_at, updated_at)
VALUES ($1, $2, $3, NOW(), NOW())
ON CONFLICT (namespace, key) DO UPDATE SET
  value = EXCLUDED.value,
  updated_at = NOW();
`;
export const DELETE_SQL = `DELETE FROM nexora_kv_store WHERE namespace = $1 AND key = $2;`;
export const EXISTS_SQL = `SELECT 1 FROM nexora_kv_store WHERE namespace = $1 AND key = $2 LIMIT 1;`;
export const LIST_BY_PREFIX_SQL = `
SELECT key FROM nexora_kv_store
WHERE namespace = $1 AND key LIKE $2
ORDER BY key;
`;

/* Connection requirements for Neon serverless/HTTP driver:
   - No persistent connections (serverless)
   - HTTP-based query API
   - Transaction support via explicit BEGIN/COMMIT/ROLLBACK
   - Advisory locks not needed - row-level locks via FOR UPDATE suffice
   - Connection string format: postgresql://user:pass@ep-xxx.region.aws.neon.tech/dbname
*/

/* Capacity planning notes for STAGING_TEST:
   - Expected key count: ~1000 keys (sessions, payments, idempotency)
   - Value size: ~2-5 KB per record
   - Total storage: < 10 MB
   - Neon free tier: 0.5 GB storage, 100 hours compute/month
   - Auto-suspend after 5 min inactivity - cold start ~1-2s acceptable for test
*/

export { NEON_SCHEMA_VERSION, NEON_TABLE_SCHEMA, NEON_UNIQUE_CONSTRAINT, NEON_MIGRATION_SQL };