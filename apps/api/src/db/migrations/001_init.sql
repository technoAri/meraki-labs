CREATE EXTENSION IF NOT EXISTS "pgcrypto";

CREATE TABLE IF NOT EXISTS tenants (
  id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name         TEXT NOT NULL,
  api_key      TEXT UNIQUE NOT NULL,
  rate_limit_per_minute  INTEGER NOT NULL DEFAULT 100,
  max_concurrent_jobs    INTEGER NOT NULL DEFAULT 10,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS jobs (
  id               UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id        UUID NOT NULL REFERENCES tenants(id),
  idempotency_key  TEXT,
  payload          JSONB NOT NULL,
  status           TEXT NOT NULL DEFAULT 'pending'
                   CHECK (status IN ('pending','running','completed','failed','dead_letter')),
  priority         INTEGER NOT NULL DEFAULT 0,
  attempts         INTEGER NOT NULL DEFAULT 0,
  max_attempts     INTEGER NOT NULL DEFAULT 3,
  lease_expires_at TIMESTAMPTZ,
  worker_id        TEXT,
  scheduled_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  started_at       TIMESTAMPTZ,
  completed_at     TIMESTAMPTZ,
  error            TEXT,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (tenant_id, idempotency_key)
);

CREATE INDEX IF NOT EXISTS idx_jobs_claim
  ON jobs (status, priority DESC, scheduled_at ASC)
  WHERE status = 'pending';

CREATE INDEX IF NOT EXISTS idx_jobs_tenant_status
  ON jobs (tenant_id, status);

CREATE INDEX IF NOT EXISTS idx_jobs_lease_expiry
  ON jobs (lease_expires_at)
  WHERE status = 'running';

INSERT INTO tenants (name, api_key, rate_limit_per_minute, max_concurrent_jobs)
VALUES ('test-tenant', 'test-api-key-1234', 60, 5)
ON CONFLICT (api_key) DO NOTHING;
