# CLAUDE.md — Distributed Task Queue & Job Processing Platform

This file governs all code generation decisions for this project.
Read this entirely before writing any file. Do not deviate from decisions made here.

---

## Project Overview

Build a production-minded distributed task queue and job processing platform with:
- Authenticated REST API for job submission and status checks
- Durable PostgreSQL-backed job store with SKIP LOCKED queue semantics
- Worker fleet with lease / ack / retry / DLQ behavior
- Per-tenant rate limiting and concurrency quotas
- Observability: Prometheus metrics, OpenTelemetry tracing, Pino structured logs
- Real-time React dashboard (responsive: Desktop, Tablet, Mobile) via WebSockets

---

## Technology Stack — Non-Negotiable

| Layer | Choice | Reason |
|---|---|---|
| Runtime | Node.js 20 LTS | Stable, widely supported |
| Language | TypeScript (strict mode) | Type safety across the whole system |
| API framework | Fastify v4 | Better TypeScript support, faster than Express |
| ORM / DB client | `postgres` (raw pg driver) | Show explicit SKIP LOCKED understanding |
| Database | PostgreSQL 16 | Job store + queue + tenant config |
| Auth | API key (header: `x-api-key`) | Simple, auditable for work trial |
| Rate limiting | In-memory sliding window per tenant (no Redis) | Keeps stack simpler; Redis is not required |
| WebSockets | `ws` library on Fastify | Lightweight, standard |
| Metrics | `prom-client` | Standard Prometheus client for Node |
| Tracing | `@opentelemetry/sdk-node` + OTLP exporter → Jaeger | Full trace UI at :16686; Jaeger is free/Apache 2.0 |
| Logging | `pino` + `pino-pretty` (dev) | Structured JSON logs with correlation IDs |
| Frontend | React 18 + Vite + Tailwind CSS + shadcn/ui | TypeScript ecosystem, fast responsive layout |
| Testing | Vitest | Fast, native TypeScript support |
| Containers | Docker + Docker Compose | Single `docker-compose up` must reproduce everything |
| Package manager | pnpm workspaces | Monorepo management |

---

## Monorepo Structure

```
/
├── apps/
│   ├── api/                  # Fastify API server
│   │   ├── src/
│   │   │   ├── routes/       # job.routes.ts, tenant.routes.ts, metrics.routes.ts
│   │   │   ├── middleware/   # auth.ts, rateLimit.ts, tracing.ts
│   │   │   ├── services/     # job.service.ts, quota.service.ts
│   │   │   ├── db/           # client.ts, schema.sql, migrations/
│   │   │   ├── ws/           # websocket.ts (real-time broadcast)
│   │   │   ├── metrics/      # prometheus.ts (prom-client setup)
│   │   │   └── index.ts
│   │   ├── Dockerfile
│   │   └── package.json
│   │
│   ├── worker/               # Worker process
│   │   ├── src/
│   │   │   ├── worker.ts     # Main worker loop
│   │   │   ├── claimer.ts    # SKIP LOCKED claim logic
│   │   │   ├── executor.ts   # Job execution + error handling
│   │   │   ├── leaser.ts     # Heartbeat + lease renewal
│   │   │   └── index.ts
│   │   ├── Dockerfile
│   │   └── package.json
│   │
│   └── dashboard/            # React + Vite frontend
│       ├── src/
│       │   ├── components/   # JobTable, StatusBadge, SubmitForm, DLQPanel, MetricsBar
│       │   ├── hooks/        # useWebSocket.ts, useJobs.ts
│       │   ├── pages/        # Dashboard.tsx, DLQ.tsx
│       │   └── main.tsx
│       ├── Dockerfile
│       └── package.json
│
├── packages/
│   └── shared/               # Shared types only — no business logic here
│       ├── src/
│       │   └── types.ts      # JobStatus, Job, Tenant, WSMessage interfaces
│       └── package.json
│
├── docker/
│   └── prometheus/
│       └── prometheus.yml    # Scrape config for api + worker
│
├── docker-compose.yml
├── CLAUDE.md                 # This file
└── README.md
```

---

## Database Schema — Implement Exactly As Specified

```sql
-- Run in order via apps/api/src/db/migrations/001_init.sql

CREATE EXTENSION IF NOT EXISTS "pgcrypto";

CREATE TABLE tenants (
  id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name         TEXT NOT NULL,
  api_key      TEXT UNIQUE NOT NULL,
  rate_limit_per_minute  INTEGER NOT NULL DEFAULT 100,
  max_concurrent_jobs    INTEGER NOT NULL DEFAULT 10,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE jobs (
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

-- Critical indexes
CREATE INDEX idx_jobs_claim
  ON jobs (status, priority DESC, scheduled_at ASC)
  WHERE status = 'pending';

CREATE INDEX idx_jobs_tenant_status
  ON jobs (tenant_id, status);

CREATE INDEX idx_jobs_lease_expiry
  ON jobs (lease_expires_at)
  WHERE status = 'running';

-- Seed one test tenant
INSERT INTO tenants (name, api_key, rate_limit_per_minute, max_concurrent_jobs)
VALUES ('test-tenant', 'test-api-key-1234', 60, 5);
```

---

## Core Patterns — Implement Exactly As Specified

### 1. SKIP LOCKED Job Claim (claimer.ts)

```sql
UPDATE jobs
SET
  status           = 'running',
  lease_expires_at = NOW() + INTERVAL '30 seconds',
  worker_id        = $1,
  started_at       = NOW(),
  attempts         = attempts + 1,
  updated_at       = NOW()
WHERE id = (
  SELECT j.id
  FROM jobs j
  WHERE j.status = 'pending'
    AND j.scheduled_at <= NOW()
    AND j.tenant_id = ANY($2::uuid[])
  ORDER BY j.priority DESC, j.scheduled_at ASC
  FOR UPDATE SKIP LOCKED
  LIMIT 1
)
RETURNING *;
```

- `$1` = worker UUID (generated once at worker startup)
- `$2` = array of tenant IDs that are under their concurrency quota at claim time

### 2. Lease Heartbeat (leaser.ts)

Worker must renew the lease every 10 seconds:
```sql
UPDATE jobs
SET lease_expires_at = NOW() + INTERVAL '30 seconds', updated_at = NOW()
WHERE id = $1 AND worker_id = $2 AND status = 'running';
```
If this returns 0 rows — another worker reclaimed the job. Abort immediately.

### 3. Ack / Nack (executor.ts)

On success:
```sql
UPDATE jobs SET status = 'completed', completed_at = NOW(), updated_at = NOW()
WHERE id = $1 AND worker_id = $2;
```

On failure:
```sql
UPDATE jobs
SET
  status    = CASE WHEN attempts >= max_attempts THEN 'dead_letter' ELSE 'failed' END,
  error     = $3,
  updated_at = NOW()
WHERE id = $1 AND worker_id = $2
RETURNING status;
```

### 4. Stale Lease Recovery (run every 15s in worker loop)

```sql
UPDATE jobs
SET status = 'pending', worker_id = NULL, lease_expires_at = NULL, updated_at = NOW()
WHERE status = 'running' AND lease_expires_at < NOW();
```

### 5. Idempotency

Job submission must check for existing idempotency_key per tenant:
```sql
INSERT INTO jobs (tenant_id, idempotency_key, payload, priority, max_attempts)
VALUES ($1, $2, $3, $4, $5)
ON CONFLICT (tenant_id, idempotency_key) DO NOTHING
RETURNING *;
```
If RETURNING is empty — duplicate. Return 200 with original job (fetch by idempotency_key).

### 6. Per-Tenant Rate Limiting (in-memory, middleware)

Use a sliding window counter per `tenant_id`. Implementation in `middleware/rateLimit.ts`:
- Store: `Map<tenantId, number[]>` — array of request timestamps
- On each request: prune entries older than 60s, check length against `rate_limit_per_minute`
- On breach: return 429 with `Retry-After` header

### 7. Concurrency Quota (quota.service.ts)

Before claim, fetch tenants whose running job count is under limit:
```sql
SELECT t.id
FROM tenants t
WHERE (
  SELECT COUNT(*) FROM jobs j
  WHERE j.tenant_id = t.id AND j.status = 'running'
) < t.max_concurrent_jobs;
```
Pass resulting tenant IDs into the SKIP LOCKED claim query.

---

## API Endpoints

```
POST   /jobs              Submit a job (auth required)
GET    /jobs/:id          Get job status (auth required)
GET    /jobs              List jobs for tenant (auth required, ?status=pending|running|completed|failed|dead_letter)
POST   /jobs/:id/cancel   Cancel a pending job
GET    /dlq               List dead letter jobs for tenant
POST   /dlq/:id/retry     Re-queue a dead_letter job back to pending
GET    /metrics           Prometheus metrics (no auth — scrape endpoint)
GET    /health            Health check
WS     /ws                WebSocket connection (auth via ?api_key= query param)
```

---

## Prometheus Metrics to Expose

Define all in `apps/api/src/metrics/prometheus.ts`:

```ts
jobs_submitted_total        // Counter, labels: tenant_id
jobs_completed_total        // Counter, labels: tenant_id
jobs_failed_total           // Counter, labels: tenant_id
jobs_dead_lettered_total    // Counter, labels: tenant_id
jobs_pending_gauge          // Gauge, labels: tenant_id
jobs_running_gauge          // Gauge, labels: tenant_id
job_processing_duration_ms  // Histogram, labels: tenant_id
worker_lease_renewals_total // Counter, labels: worker_id
```

---

## WebSocket Protocol

Server broadcasts on every job status change:

```ts
// WSMessage shape (defined in packages/shared/src/types.ts)
{
  type: 'JOB_UPDATE',
  data: {
    id: string,
    tenant_id: string,
    status: JobStatus,
    updated_at: string
  }
}
```

Clients subscribe filtered by their tenant (validated via api_key on connect).

---

## OpenTelemetry Setup

In `apps/api/src/index.ts` — initialize before all imports:
```ts
import { NodeSDK } from '@opentelemetry/sdk-node';
import { OTLPTraceExporter } from '@opentelemetry/exporter-trace-otlp-http';

const sdk = new NodeSDK({
  traceExporter: new OTLPTraceExporter({
    url: process.env.OTEL_EXPORTER_OTLP_ENDPOINT ?? 'http://jaeger:4318/v1/traces'
  })
});
sdk.start();
```

Do the same in `apps/worker/src/index.ts`.

Add named trace spans for:
- Job submission (`job.submit`)
- Job claim (`job.claim`)
- Job ack (`job.ack`)
- Job nack (`job.nack`)
- DLQ promotion (`job.dlq`)

Traces are visible at **http://localhost:16686** (Jaeger UI).

---

## Dashboard Requirements (apps/dashboard)

**Views:**
1. **Dashboard (/)** — live stats bar (pending / running / completed / failed counts), job table with status filter tabs, real-time updates via WebSocket
2. **DLQ (/dlq)** — dead letter jobs table with retry button per row

**Components to build:**
- `MetricsBar` — top strip showing live counts per status
- `JobTable` — sortable table: ID, payload preview, status badge, attempts, created_at, actions
- `StatusBadge` — color-coded: pending=gray, running=blue, completed=green, failed=orange, dead_letter=red
- `SubmitJobForm` — payload textarea, priority slider, idempotency key input, submit button
- `DLQPanel` — same as JobTable but with Retry action

**Responsive breakpoints:** Mobile-first. Stack layout on mobile, side nav on desktop.

**Real-time:** Use `useWebSocket` hook. On `JOB_UPDATE` message — update job in local state without full refetch.

---

## Docker Compose Services

```yaml
services:
  postgres:    # PostgreSQL 16, run migrations on start
  api:         # apps/api — port 3000
  worker:      # apps/worker — scale: 2 replicas
  dashboard:   # apps/dashboard — port 5173
  prometheus:  # port 9090, scrapes api:3000/metrics and worker/metrics
  jaeger:      # port 16686 (UI), 4318 (OTLP HTTP) — free, Apache 2.0
```

---

## Build Order for Claude Code

Follow this sequence strictly. Do not jump ahead.

1. `docker-compose.yml` + `docker/prometheus/prometheus.yml`
2. `packages/shared/src/types.ts`
3. `apps/api/src/db/` — client, schema SQL, migration runner
4. `apps/api` — Fastify server skeleton, health endpoint, Pino logger, OTel init
5. `apps/api/src/middleware/` — auth, rateLimit
6. `apps/api/src/metrics/prometheus.ts`
7. `apps/api/src/routes/job.routes.ts` + `job.service.ts` — submit, status, list, cancel
8. `apps/api/src/routes/dlq.routes.ts` — list DLQ, retry
9. `apps/api/src/ws/websocket.ts` — WebSocket server + broadcast
10. `apps/worker/src/` — claimer, leaser, executor, stale lease recovery, worker loop
11. `apps/dashboard/` — React app, all components, WebSocket hook
12. Tests — `apps/api/src/__tests__/`, `apps/worker/src/__tests__/`
13. `README.md` — architecture decisions, trade-offs, how to run

---

## Testing Requirements

### Unit tests (Vitest)
- `job.service.test.ts` — idempotency key collision, duplicate submission returns original
- `rateLimit.test.ts` — sliding window correctness, 429 on breach
- `quota.service.test.ts` — tenant excluded from claim when at concurrency limit
- `claimer.test.ts` — SKIP LOCKED returns null when no eligible jobs
- `leaser.test.ts` — heartbeat returns false when job stolen; worker aborts

### Concurrency stress test
- `stress.test.ts` — spawn 10 concurrent workers against 50 jobs, assert zero double-execution (every job completed exactly once)

---

## What NOT To Do

- Do NOT use Prisma or TypeORM — raw `postgres` driver only, so SKIP LOCKED SQL is explicit
- Do NOT add Redis — not in scope
- Do NOT add Grafana — not worth the setup for 10% weight
- Do NOT use Express — Fastify only
- Do NOT use `any` types in TypeScript — strict mode is on
- Do NOT put business logic in routes — routes call services, services contain logic
- Do NOT skip the stale lease recovery loop — it is required for durability correctness
- Do NOT use `console.log` anywhere — use Pino logger throughout
- Do NOT hardcode tenant IDs anywhere except seed data

---

## Environment Variables

```env
# apps/api/.env
DATABASE_URL=postgres://postgres:postgres@postgres:5432/taskqueue
PORT=3000
NODE_ENV=development
OTEL_EXPORTER_OTLP_ENDPOINT=http://jaeger:4318/v1/traces
OTEL_SERVICE_NAME=task-queue-api

# apps/worker/.env
DATABASE_URL=postgres://postgres:postgres@postgres:5432/taskqueue
WORKER_CONCURRENCY=3
LEASE_DURATION_SECONDS=30
HEARTBEAT_INTERVAL_SECONDS=10
STALE_LEASE_CHECK_INTERVAL_SECONDS=15
POLL_INTERVAL_MS=500
OTEL_EXPORTER_OTLP_ENDPOINT=http://jaeger:4318/v1/traces
OTEL_SERVICE_NAME=task-queue-worker

# apps/dashboard/.env
VITE_API_URL=http://localhost:3000
VITE_WS_URL=ws://localhost:3000/ws
```

---

## README Trade-offs to Document

Address each of these explicitly:

1. **Why PostgreSQL for the queue instead of Redis/RabbitMQ?** — durability, ACID, simpler ops, SKIP LOCKED is production-proven
2. **At-least-once vs exactly-once** — this system is at-least-once; idempotency keys are the caller's responsibility for exactly-once semantics
3. **Lease duration choice (30s)** — balancing redelivery latency vs false-positive reclaims
4. **In-memory rate limiting trade-off** — works for single API instance; production would need Redis-backed sliding window for multi-instance
5. **Worker autoscaling design** — describe a trigger: if `jobs_pending_gauge > threshold` for 60s, scale worker replicas; could be implemented via K8s HPA on custom metric
6. **DLQ strategy** — dead_letter is a status in the same table; in production you'd move to a separate table or topic to avoid index bloat
