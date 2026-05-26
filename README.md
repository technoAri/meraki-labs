# Distributed Task Queue & Job Processing Platform

A production-minded distributed task queue built on PostgreSQL with a Node.js/TypeScript monorepo. Designed for horizontal scalability, fault tolerance, and full observability.

---

## Quick Start

```bash
docker compose up --build
```

| Service | URL | Notes |
|---|---|---|
| Gateway (API + Dashboard) | http://localhost:80 | nginx — single entry point |
| Prometheus | http://localhost:9091 | Metrics UI |
| Jaeger | http://localhost:16687 | Distributed traces |

**Test API key:** `test-api-key-1234`

---

## Features & API Reference

### Authentication

Every API request requires:
```
x-api-key: test-api-key-1234
```

The seeded test tenant has a **60 req/min** rate limit and **5 max concurrent jobs**.

---

### Job Submission

```bash
curl -X POST http://localhost/jobs \
  -H "x-api-key: test-api-key-1234" \
  -H "Content-Type: application/json" \
  -d '{
    "payload":         { "task": "send-email", "to": "user@example.com" },
    "priority":        10,
    "max_attempts":    5,
    "idempotency_key": "order-123-email",
    "scheduled_at":    "2026-06-01T09:00:00Z"
  }'
```

| Field | Type | Default | Description |
|---|---|---|---|
| `payload` | object | required | Arbitrary JSON passed to the worker |
| `priority` | integer | 0 | Higher = claimed first |
| `max_attempts` | integer | 3 | Retries before landing in DLQ |
| `idempotency_key` | string | null | Duplicate submissions return the original job |
| `scheduled_at` | ISO 8601 | now | Job won't be claimed until this time |

Submit `{"fail": true}` in the payload to simulate a failing job (useful for DLQ testing).

---

### Job Queries

```bash
# Get all jobs (newest first, limit 100)
curl http://localhost/jobs -H "x-api-key: test-api-key-1234"

# Filter by status: pending | running | completed | failed | dead_letter
curl "http://localhost/jobs?status=pending" -H "x-api-key: test-api-key-1234"

# Get a specific job
curl http://localhost/jobs/<id> -H "x-api-key: test-api-key-1234"

# Live counts per status (Redis-cached, 3s TTL)
curl http://localhost/jobs/counts -H "x-api-key: test-api-key-1234"
# → {"pending":3,"running":1,"completed":47,"failed":2,"dead_letter":1}
```

---

### Cancel a Job

```bash
curl -X POST http://localhost/jobs/<id>/cancel \
  -H "x-api-key: test-api-key-1234"
```

Only works on `pending` jobs. Sets status to `failed` with error `"Cancelled by user"`.

---

### Dead Letter Queue

```bash
# List jobs that exhausted all retry attempts
curl http://localhost/dlq -H "x-api-key: test-api-key-1234"

# Re-queue a dead-lettered job (resets attempts to 0)
curl -X POST http://localhost/dlq/<id>/retry \
  -H "x-api-key: test-api-key-1234"
```

---

### Job Lifecycle

```
submitted
    │
    ▼
 pending ──► running ──► completed
               │
               └── (on failure, attempts < max_attempts) ──► pending  (retry)
               └── (on failure, attempts >= max_attempts) ──► dead_letter
```

- Workers poll every 500ms with `SELECT ... FOR UPDATE SKIP LOCKED`
- Each claim holds a **30s lease**, renewed by heartbeat every 10s
- A crashed worker's jobs are auto-reclaimed within ≤45s (30s lease + 15s stale-check)

---

### Rate Limiting

Enforced globally across all API replicas via Redis sliding window.

```
HTTP 429 Too Many Requests
{"error": "Rate limit exceeded", "retryAfter": 42}
```

`retryAfter` is seconds until the window has room again.

---

### WebSocket — Real-time Updates

```
ws://localhost/ws?api_key=test-api-key-1234
```

Pushes a message on every job status change:
```json
{
  "type": "JOB_UPDATE",
  "data": {
    "id": "abc-123",
    "tenant_id": "...",
    "status": "completed",
    "updated_at": "2026-05-25T..."
  }
}
```

Each API replica independently receives all `pg_notify` events from PostgreSQL, so WebSocket clients on any replica get all updates — no sticky sessions needed.

---

### Observability

```bash
# Prometheus metrics (no auth required — scrape endpoint)
curl http://localhost/metrics

# Health check
curl http://localhost/health
# → {"status":"ok"}
```

| Metric | Type | Description |
|---|---|---|
| `jobs_submitted_total` | Counter | Per tenant |
| `jobs_completed_total` | Counter | Per tenant |
| `jobs_failed_total` | Counter | Per tenant |
| `jobs_dead_lettered_total` | Counter | Per tenant |
| `jobs_pending_gauge` | Gauge | Current pending count |
| `jobs_running_gauge` | Gauge | Current running count |
| `job_processing_duration_ms` | Histogram | Processing time per job |
| `worker_lease_renewals_total` | Counter | Heartbeat count per worker |

---

### Dashboard UI

Open **http://localhost** in a browser.

| Feature | How to use |
|---|---|
| MetricsBar | Live counts — updated via WebSocket on every job change |
| Submit Job form | Paste any JSON payload, click Submit |
| Status tabs | Filter table: all / pending / running / completed / failed / dead_letter |
| Cancel button | Appears on `pending` rows |
| Dead Letter Queue | Top-right nav link → lists dead-lettered jobs with per-row Retry button |
| Real-time updates | Table and counts update without page refresh |

---

### Inspect the Database

```bash
# Open a psql shell on the primary
docker exec -it meraki-labs-postgres-primary-1 psql -U postgres -d taskqueue

# Useful queries
SELECT status, COUNT(*) FROM jobs GROUP BY status;
SELECT * FROM jobs ORDER BY created_at DESC LIMIT 10;
SELECT * FROM tenants;

# Check WAL replication lag
SELECT client_addr, state, sent_lsn, replay_lsn FROM pg_stat_replication;
```

To connect with a GUI tool (TablePlus, pgAdmin, DBeaver), temporarily expose the port:
```bash
docker compose stop postgres-primary
# Add "ports: ['5433:5432']" to postgres-primary in docker-compose.yml, then:
docker compose up -d postgres-primary
# Connect to localhost:5433, user: postgres, password: postgres, db: taskqueue
```

---

## Architecture

```
                        ┌──────────────────────────────────────────┐
  Browser / API Client  │              nginx  :80                  │
        │               │  Round-robin HTTP · WebSocket upgrade     │
        └──────────────►│  Serves dashboard static files           │
                        └────────────┬─────────────────────────────┘
                                     │
                     ┌───────────────┴───────────────┐
                     │                               │
              ┌──────▼──────┐                 ┌──────▼──────┐
              │   api-1     │                 │   api-2     │
              │  Fastify    │                 │  Fastify    │
              └──────┬──────┘                 └──────┬──────┘
                     │                               │
                     └───────────┬───────────────────┘
                                 │
                    ┌────────────▼────────────┐
                    │         Redis           │
                    │  rate limiting · cache  │
                    └─────────────────────────┘
                                 │
                    ┌────────────▼────────────┐
                    │   postgres-primary      │  ◄── all reads + writes
                    └────────────┬────────────┘
                                 │ WAL stream (continuous, ~ms lag)
                    ┌────────────▼────────────┐
                    │   postgres-replica      │  ◄── read fallback if primary fails
                    └─────────────────────────┘
                                 │
                    ┌────────────┴────────────┐
                    │       Workers           │
                    │   worker-1   worker-2   │  ◄── SKIP LOCKED claim
                    └─────────────────────────┘
```

### Request flow

1. Client hits **nginx :80** — the only exposed entry point
2. nginx round-robins HTTP requests across **api-1** and **api-2**
3. Each API replica checks **Redis** for tenant auth cache (avoids DB hit on every request) and enforces rate limits via a Redis sorted-set sliding window
4. All DB reads and writes go to **postgres-primary**
5. If postgres-primary is unreachable, read-only queries fall back to **postgres-replica** automatically
6. **Workers** connect directly to postgres-primary (internal only, not through nginx) and race for jobs via `FOR UPDATE SKIP LOCKED`
7. On every job status change, workers fire `pg_notify` → both API replicas receive it independently → each broadcasts to their own connected WebSocket clients

---

## Running Tests

```bash
# Unit tests (Vitest)
pnpm install
pnpm test

# E2E tests (Playwright — requires stack to be running)
docker compose up -d
pnpm --filter @task-queue/e2e test
```

### What the E2E suite covers

| Scenario | What it proves |
|---|---|
| Submit → completed | Normal job lifecycle works end-to-end |
| Submit failing job → DLQ | Retry exhaustion and dead-letter routing |
| Retry from DLQ | Re-queue and re-execution path |
| Cancel scheduled job | Cancel endpoint and status transition |
| MetricsBar accuracy | Counts reflect DB truth, not local list window |
| WebSocket real-time | Status updates arrive without page refresh |

---

## Design Decisions

These are choices that are correct for this architecture regardless of scale — not compromises made for the demo.

### Shared database across api and worker

Both services intentionally share the same PostgreSQL instance because the queue's correctness guarantees depend on it. `SKIP LOCKED` gives atomic, distributed job claiming within a single transaction — no two workers can claim the same row. Lease heartbeats let a worker atomically check and renew its hold on a job it's executing. Idempotency key deduplication is enforced by a unique index at the database level. All three of these only work because both services operate on the same rows in the same database.

Splitting the database would mean replacing these with distributed coordination primitives: a Saga pattern for atomic claiming, distributed locking for leases, and a deduplication store for idempotency. That's significant complexity for no correctness or throughput benefit at this scale.

The natural evolution path if team or scale demands it:
1. **Separate schemas** (`api.*` owns tenants and auth; `worker.*` owns jobs and leases) — establishes ownership boundaries without changing infrastructure
2. **Message broker** (Kafka, RabbitMQ) — only warranted when job throughput exceeds ~100k/s or when the api and worker teams need to deploy fully independently

---

## Architecture Decisions & Trade-offs

### 1. Why Fastify instead of Express?

Fastify compiles JSON serialization from route schemas at startup rather than calling `JSON.stringify` at runtime — making it roughly 3× faster than Express on JSON-heavy endpoints. It also ships with first-class TypeScript support (typed request/reply generics, route schemas) and a scoped plugin system where middleware can't accidentally leak across routes. For a job queue API where `/jobs` and `/jobs/counts` are hit on every submit and every dashboard poll, that throughput advantage matters. The trade-off is a steeper learning curve — Fastify's decorator and plugin scoping model is less familiar than Express middleware chains.

### 2. Why PostgreSQL for the queue instead of Redis/RabbitMQ?

`FOR UPDATE SKIP LOCKED` gives row-level locking without a separate broker process. Jobs, tenants, and queue state all live in one durable, ACID-compliant store. Simpler ops, no extra process to monitor, and the data is queryable with plain SQL. The trade-off: Postgres is not purpose-built for queuing — at very high throughput (100k+ jobs/s) a dedicated broker would win.

### 2. At-least-once vs exactly-once

This system guarantees **at-least-once** delivery. A job that times out before ack will be reclaimed and re-executed by another worker. Callers who need exactly-once semantics should supply an `idempotency_key` — the handler must be idempotent itself.

### 3. Lease duration (30 seconds)

30s balances reclaim latency vs false-positive reclaims. The heartbeat fires every 10s, so a 30s lease has 2+ renewals before expiry. A crashed worker's jobs are reclaimed within ≤45s (30s lease + 15s stale-lease-check interval).

### 4. Redis rate limiting — globally consistent across replicas

The original in-memory sliding window (`Map<tenantId, timestamps[]>`) worked correctly for a single API process but breaks with multiple replicas — each instance tracks its own counter, so a tenant could send `N × rate_limit` requests across N replicas. Redis sorted-set sliding window enforces a single global counter shared by all API replicas. The cost is one extra round-trip to Redis per request, which is sub-millisecond on the local network.

### 5. Redis caching strategy

Two caches are used; both are safe to be briefly stale:

- **Tenant auth cache** (`tenant:apikey:{key}`, TTL 5min) — runs on every authenticated request. Tenant API keys almost never change. Eliminates a DB SELECT on the hot path.
- **Job counts cache** (`counts:{tenantId}`, TTL 3s) — the MetricsBar polls this. A GROUP BY aggregation on a large jobs table is expensive; 3s staleness is invisible to users given the WebSocket already delivers real-time updates.

Job rows themselves are **not cached** — they change state every few seconds and the WebSocket real-time path already handles UI updates correctly without a cache.

### 6. PostgreSQL read replica — WAL streaming, not interval-based

WAL (Write-Ahead Log) replication is a **continuous TCP stream**, not a cron job. The replica applies changes within milliseconds of the primary committing them. All traffic normally hits the primary; the replica is a warm standby. If the primary becomes unreachable, read queries automatically fall back to the replica. Write queries (submit, claim, ack, cancel) fail until the primary recovers — jobs are durable and workers resume automatically when it comes back. For zero-downtime write HA, replace with a managed Postgres service (RDS Multi-AZ, Supabase) or add Patroni for automatic primary promotion.

### 7. nginx WebSocket handling — no stickiness needed

A common misconception is that WebSocket connections require sticky sessions when load-balancing. That would be true if API replicas needed to coordinate WS state. Here they don't — each replica independently LISTENs to PostgreSQL's `pg_notify` channel and receives all job status events. A client connected to api-1 gets the same updates as one connected to api-2. nginx simply upgrades the connection and proxies — no sticky routing required.

### 8. Worker autoscaling design

`jobs_pending_gauge` is the natural autoscaling signal. A Kubernetes HPA with a custom metrics adapter could scale worker replicas when `jobs_pending_gauge > threshold` for 60+ seconds. The SKIP LOCKED design makes adding workers safe at any time — new workers immediately join the claim race without coordination or configuration changes.

### 9. DLQ strategy

`dead_letter` is a status value in the same `jobs` table — simple and avoids an extra schema object. In production you'd move dead-lettered rows to a separate table (or a message topic like Kafka) to prevent the `idx_jobs_claim` partial index from bloating with rows that are never eligible for claiming.
