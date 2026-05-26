# CLAUDE.md — Distributed Task Queue & Job Processing Platform

This file governs all code generation decisions for this project.
Read this entirely before writing any file. Do not deviate from decisions made here.

---

## Project Overview

Build a production-minded distributed task queue and job processing platform with:
- nginx API gateway load-balancing across multiple API replicas
- Authenticated REST API for job submission and status checks
- Durable PostgreSQL-backed job store with SKIP LOCKED queue semantics
- PostgreSQL WAL streaming replication — primary handles all reads + writes; replica is a warm standby for read fallback if primary fails
- Redis for distributed rate limiting and hot-path caching (tenant auth, job counts)
- Worker fleet with lease / ack / retry / DLQ behavior
- Per-tenant rate limiting and concurrency quotas
- Observability: Prometheus metrics, OpenTelemetry tracing, Pino structured logs
- Real-time React dashboard (responsive: Desktop, Tablet, Mobile) via WebSockets
- Playwright E2E test suite covering the full job lifecycle

---

## Technology Stack

| Layer | Choice | Reason |
|---|---|---|
| Runtime | Node.js 20 LTS | Stable, widely supported |
| Language | TypeScript (strict mode) | Type safety across the whole system |
| API framework | Fastify v4 | Better TypeScript support, faster than Express |
| ORM / DB client | `postgres` (raw pg driver) | Explicit SKIP LOCKED understanding |
| Database | PostgreSQL 16 (bitnami/postgresql) | Job store + queue + tenant config; bitnami image enables WAL replication via env vars |
| DB replication | WAL streaming (primary → replica) | Read fallback on primary failure; all traffic normally hits primary |
| Cache / rate limit store | Redis 7 | Distributed rate limiting across API replicas; tenant auth cache; job counts cache |
| Gateway / LB | nginx | Single entry point on :80, round-robin across API replicas; sticky WS upgrade |
| Auth | API key (header: `x-api-key`) | Simple, auditable |
| Rate limiting | Redis sliding window per tenant | Globally consistent across all API replicas |
| WebSockets | `ws` library on Fastify | Each API replica independently LISTENs to pg_notify and broadcasts to its own connected clients |
| Metrics | `prom-client` | Standard Prometheus client for Node |
| Tracing | `@opentelemetry/sdk-node` + OTLP exporter → Jaeger | Full trace UI at :16686 |
| Logging | `pino` + `pino-pretty` (dev) | Structured JSON logs with correlation IDs |
| Frontend | React 18 + Vite + Tailwind CSS | TypeScript ecosystem, fast responsive layout |
| Unit testing | Vitest | Fast, native TypeScript support |
| E2E testing | Playwright | Browser-level proof that the full job lifecycle works |
| Containers | Docker + Docker Compose | Single `docker compose up` reproduces everything |
| Package manager | pnpm workspaces | Monorepo management |

---

## Monorepo Structure

```
/
├── apps/
│   ├── api/                  # Fastify API server
│   │   ├── src/
│   │   │   ├── routes/       # job.routes.ts, dlq.routes.ts, metrics.routes.ts
│   │   │   ├── middleware/   # auth.ts, rateLimit.ts
│   │   │   ├── services/     # job.service.ts, quota.service.ts
│   │   │   ├── db/           # client.ts (primary + replica pools), schema.sql, migrations/
│   │   │   ├── cache/        # redis.ts (client), tenantCache.ts, countsCache.ts
│   │   │   ├── ws/           # websocket.ts (real-time broadcast via pg_notify LISTEN)
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
│   ├── dashboard/            # React + Vite frontend (served by nginx gateway)
│   │   ├── src/
│   │   │   ├── components/   # JobTable, StatusBadge, SubmitJobForm, DLQPanel, MetricsBar
│   │   │   ├── hooks/        # useWebSocket.ts, useJobs.ts, useJobCounts.ts
│   │   │   ├── pages/        # Dashboard.tsx, DLQ.tsx
│   │   │   └── main.tsx
│   │   ├── Dockerfile
│   │   └── package.json
│   │
│   └── e2e/                  # Playwright end-to-end tests
│       ├── tests/
│       │   └── job-lifecycle.spec.ts
│       ├── playwright.config.ts
│       └── package.json
│
├── packages/
│   └── shared/               # Shared types only — no business logic
│       ├── src/
│       │   └── types.ts      # JobStatus, Job, Tenant, WSMessage, Json interfaces
│       └── package.json
│
├── docker/
│   ├── nginx/
│   │   └── nginx.conf        # Gateway: LB across API replicas, WS upgrade
│   └── prometheus/
│       └── prometheus.yml    # Scrape config for api replicas + workers
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

CREATE INDEX idx_jobs_claim
  ON jobs (status, priority DESC, scheduled_at ASC)
  WHERE status = 'pending';

CREATE INDEX idx_jobs_tenant_status
  ON jobs (tenant_id, status);

CREATE INDEX idx_jobs_lease_expiry
  ON jobs (lease_expires_at)
  WHERE status = 'running';

INSERT INTO tenants (name, api_key, rate_limit_per_minute, max_concurrent_jobs)
VALUES ('test-tenant', 'test-api-key-1234', 60, 5);
```

---

## Core Patterns

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

### 2. Lease Heartbeat (leaser.ts)

Worker renews the lease every 10 seconds:
```sql
UPDATE jobs
SET lease_expires_at = NOW() + INTERVAL '30 seconds', updated_at = NOW()
WHERE id = $1 AND worker_id = $2 AND status = 'running';
```
Returns 0 rows → job was stolen. Worker aborts immediately.

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
  status           = CASE WHEN attempts >= max_attempts THEN 'dead_letter' ELSE 'pending' END,
  worker_id        = CASE WHEN attempts >= max_attempts THEN worker_id ELSE NULL END,
  lease_expires_at = CASE WHEN attempts >= max_attempts THEN lease_expires_at ELSE NULL END,
  error            = $3,
  updated_at       = NOW()
WHERE id = $1 AND worker_id = $2
RETURNING status, updated_at;
```

### 4. Stale Lease Recovery (every 15s)

```sql
UPDATE jobs
SET status = 'pending', worker_id = NULL, lease_expires_at = NULL, updated_at = NOW()
WHERE status = 'running' AND lease_expires_at < NOW();
```

### 5. Idempotency

```sql
INSERT INTO jobs (tenant_id, idempotency_key, payload, priority, max_attempts)
VALUES ($1, $2, $3, $4, $5)
ON CONFLICT (tenant_id, idempotency_key) DO NOTHING
RETURNING *;
```
Empty RETURNING → duplicate. Fetch and return original by idempotency_key.

### 6. Per-Tenant Rate Limiting — Redis sliding window

Implementation in `middleware/rateLimit.ts`. Uses Redis ZADD + ZREMRANGEBYSCORE for a sorted-set sliding window — globally consistent across all API replicas:

```
key:   ratelimit:{tenantId}
type:  sorted set (score = timestamp ms, member = timestamp ms)

On each request:
  ZREMRANGEBYSCORE key 0 (now - 60000)   # prune old entries
  ZADD key now now                        # add this request
  ZCARD key                               # count in window
  EXPIRE key 61                           # auto-cleanup

If ZCARD > rate_limit_per_minute → 429
```

### 7. Concurrency Quota (quota.service.ts)

```sql
SELECT t.id
FROM tenants t
WHERE (
  SELECT COUNT(*) FROM jobs j
  WHERE j.tenant_id = t.id AND j.status = 'running'
) < t.max_concurrent_jobs;
```

### 8. Tenant Auth Cache — Redis

Implementation in `cache/tenantCache.ts`. Avoids a DB hit on every authenticated request:

```
key:   tenant:apikey:{apiKey}
value: tenantId (string)
TTL:   300s

On auth:
  1. GET tenant:apikey:{apiKey} from Redis
  2. If hit → use cached tenantId
  3. If miss → SELECT from DB, SET in Redis with TTL
```

### 9. Job Counts Cache — Redis

Implementation in `cache/countsCache.ts`. Prevents repeated GROUP BY aggregation when the dashboard polls:

```
key:   counts:{tenantId}
value: JSON { pending, running, completed, failed, dead_letter }
TTL:   3s

Invalidated (deleted) on any JOB_UPDATE pg_notify for that tenant.
```

### 10. PostgreSQL Read Replica Fallback

`apps/api/src/db/client.ts` exports two pools:

```ts
export const sql = postgres(process.env.DATABASE_URL);        // primary — all writes + normal reads
export const sqlRead = postgres(process.env.DATABASE_READ_URL // replica
  ?? process.env.DATABASE_URL);                               // falls back to primary if replica not configured
```

All SELECT-only queries in services use `sqlRead`. All INSERT/UPDATE/DELETE use `sql`.
If `DATABASE_READ_URL` is not set (e.g. local dev without replica), both point to the same DB — no code change needed.

Workers always use `sql` (primary) because claim/ack/nack are all writes.

---

## API Endpoints

```
POST   /jobs              Submit a job (auth required)
GET    /jobs/counts       Live counts per status for tenant (auth required)
GET    /jobs/:id          Get job status (auth required)
GET    /jobs              List jobs for tenant (auth required, ?status=...)
POST   /jobs/:id/cancel   Cancel a pending job
GET    /dlq               List dead letter jobs for tenant
POST   /dlq/:id/retry     Re-queue a dead_letter job back to pending
GET    /metrics           Prometheus metrics (no auth — scrape endpoint)
GET    /health            Health check
WS     /ws                WebSocket connection (auth via ?api_key= query param)
```

---

## Prometheus Metrics

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

```ts
{
  type: 'JOB_UPDATE',
  data: { id: string, tenant_id: string, status: JobStatus, updated_at: string }
}
```

Each API replica independently LISTENs to `pg_notify('job_status_change')` and broadcasts to its own pool of connected WebSocket clients. No cross-replica coordination needed — every client receives updates regardless of which replica it connected to.

nginx uses `proxy_http_version 1.1` + `Upgrade` / `Connection` headers to correctly proxy WebSocket connections.

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

Named spans: `job.submit`, `job.claim`, `job.ack`, `job.nack`, `job.dlq`

---

## Dashboard Requirements

**Views:**
1. **Dashboard (/)** — MetricsBar (real DB counts via `/jobs/counts`), job table with status filter tabs, real-time updates via WebSocket
2. **DLQ (/dlq)** — dead letter jobs table with retry button per row

**Hooks:**
- `useJobs(status?)` — fetches job list, exposes `updateJob`, `removeJob`, `hasJob`
- `useJobCounts()` — fetches `/jobs/counts`, exposes `refetchCounts`
- `useWebSocket(onMessage)` — connects to WS with exponential backoff reconnection

**Real-time:** On `JOB_UPDATE` — update job in local state without full refetch. Refetch counts on every WS event.

---

## Docker Compose Services

```yaml
services:
  nginx:             # Gateway on :80 — LB to api replicas, serves dashboard static files
  api:               # Fastify API — 2 replicas, no host port (internal only)
  worker:            # Worker — 2 replicas
  postgres-primary:  # bitnami/postgresql:16, WAL primary, runs migrations
  postgres-replica:  # bitnami/postgresql:16, WAL replica (read fallback)
  redis:             # Redis 7 — rate limiting + caches
  dashboard:         # React build (static) — served via nginx
  prometheus:        # :9090, scrapes api replicas + workers
  jaeger:            # :16686 UI, :4318 OTLP
```

---

## nginx Gateway Config (docker/nginx/nginx.conf)

```nginx
upstream api_backend {
    server api:3000;          # Docker round-robins across all api replicas
}

server {
    listen 80;

    # API + WebSocket
    location / {
        proxy_pass         http://api_backend;
        proxy_http_version 1.1;
        proxy_set_header   Upgrade $http_upgrade;
        proxy_set_header   Connection "upgrade";
        proxy_set_header   Host $host;
        proxy_set_header   X-Real-IP $remote_addr;
    }
}
```

Dashboard is built as static files and served directly by nginx (COPY dist into nginx image).

---

## Build Order

1. `docker-compose.yml` + `docker/nginx/nginx.conf` + `docker/prometheus/prometheus.yml`
2. `packages/shared/src/types.ts`
3. `apps/api/src/db/client.ts` — primary + replica pools
4. `apps/api/src/cache/` — redis.ts, tenantCache.ts, countsCache.ts
5. `apps/api` — Fastify skeleton, health, Pino, OTel
6. `apps/api/src/middleware/` — auth (with Redis tenant cache), rateLimit (Redis sliding window)
7. `apps/api/src/metrics/prometheus.ts`
8. `apps/api/src/routes/` — job.routes.ts, dlq.routes.ts
9. `apps/api/src/ws/websocket.ts`
10. `apps/worker/src/` — claimer, leaser, executor, stale lease recovery
11. `apps/dashboard/` — React app, all components, hooks
12. `apps/e2e/` — Playwright job lifecycle tests
13. Unit tests — `apps/api/src/__tests__/`, `apps/worker/src/__tests__/`
14. `README.md`

---

## Testing Requirements

### Unit tests (Vitest)
- `job.service.test.ts` — idempotency key collision, duplicate submission returns original
- `rateLimit.test.ts` — Redis sliding window correctness, 429 on breach
- `quota.service.test.ts` — tenant excluded when at concurrency limit
- `claimer.test.ts` — SKIP LOCKED returns null when no eligible jobs
- `leaser.test.ts` — heartbeat returns false when job stolen

### Stress test
- `stress.test.ts` — 10 concurrent workers × 50 jobs, zero double-execution

### Playwright E2E (`apps/e2e/tests/job-lifecycle.spec.ts`)
Runs against the live stack (`docker compose up`). Covers:
1. Submit a normal job → appears in table → transitions to completed
2. Submit a failing job (`{"fail": true}`) → exhausts retries → lands in DLQ
3. Retry from DLQ → job disappears from DLQ, reappears as pending
4. Cancel a scheduled (future) job → status becomes failed
5. MetricsBar counts match `GET /jobs/counts` response
6. WebSocket delivers real-time status updates without page refresh

---

## Environment Variables

```env
# apps/api
DATABASE_URL=postgres://postgres:postgres@postgres-primary:5432/taskqueue
DATABASE_READ_URL=postgres://postgres:postgres@postgres-replica:5432/taskqueue
REDIS_URL=redis://redis:6379
PORT=3000
NODE_ENV=development
OTEL_EXPORTER_OTLP_ENDPOINT=http://jaeger:4318/v1/traces
OTEL_SERVICE_NAME=task-queue-api
CORS_ORIGIN=http://localhost:80

# apps/worker
DATABASE_URL=postgres://postgres:postgres@postgres-primary:5432/taskqueue
WORKER_CONCURRENCY=3
LEASE_DURATION_SECONDS=30
HEARTBEAT_INTERVAL_SECONDS=10
STALE_LEASE_CHECK_INTERVAL_SECONDS=15
POLL_INTERVAL_MS=500
OTEL_EXPORTER_OTLP_ENDPOINT=http://jaeger:4318/v1/traces
OTEL_SERVICE_NAME=task-queue-worker

# apps/dashboard
VITE_API_URL=http://localhost:80
VITE_WS_URL=ws://localhost:80/ws
```

---

## What NOT To Do

- Do NOT use Prisma or TypeORM — raw `postgres` driver only
- Do NOT add Grafana — not in scope
- Do NOT use Express — Fastify only
- Do NOT use `any` types — strict mode is on
- Do NOT put business logic in routes — routes call services
- Do NOT skip the stale lease recovery loop
- Do NOT use `console.log` — Pino logger throughout
- Do NOT hardcode tenant IDs except in seed data
- Do NOT route workers through nginx — workers are internal consumers, they connect directly to postgres-primary
- Do NOT cache write results in Redis — only cache reads that are safe to be briefly stale (tenant lookup, counts)
- Do NOT use separate read pool in workers — workers only do writes (claim/ack/nack/heartbeat)

---

## Architecture Decisions to Document in README

1. **Why PostgreSQL for the queue** — SKIP LOCKED, ACID, durable, queryable
2. **At-least-once vs exactly-once** — at-least-once; idempotency keys for exactly-once
3. **Lease duration (30s)** — balances reclaim latency vs false-positive
4. **Redis rate limiting** — globally consistent across replicas; single-instance in-memory would allow N×limit bypass
5. **Redis caching strategy** — tenant auth (hot path, rarely changes), counts (aggregation, 3s TTL); job rows not cached (change too frequently, WS handles real-time)
6. **Read replica strategy** — all traffic to primary; replica as warm standby for read fallback; WAL is continuous (ms lag), not interval-based
7. **Worker autoscaling** — `jobs_pending_gauge` as HPA signal; SKIP LOCKED makes adding workers safe at any time
8. **DLQ strategy** — status in same table; production would use separate table/topic
9. **nginx WS stickiness** — not needed; each replica independently receives all pg_notify events
