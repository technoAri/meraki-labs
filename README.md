# Distributed Task Queue & Job Processing Platform

A production-minded distributed task queue built on PostgreSQL with a Node.js/TypeScript monorepo. Designed for horizontal scalability, fault tolerance, and full observability.

---

## Quick Start

```bash
# Clone and start everything (builds all images, runs migrations, seeds test tenant)
docker compose up --build
```

The stack takes ~30 seconds to fully start. PostgreSQL runs migrations automatically on first boot.

| Service | URL | Credentials |
|---|---|---|
| Dashboard | http://localhost | — |
| REST API | http://localhost/v1 | `x-api-key: test-api-key-1234` |
| Prometheus | http://localhost:9091 | — |
| Jaeger (traces) | http://localhost:16687 | — |

To stop and remove all containers (data volumes are preserved):
```bash
docker compose down
```

To also wipe all persisted data (database, Redis):
```bash
docker compose down -v
```

---

## How to Run

### Prerequisites

- Docker Desktop (or Docker Engine + Compose plugin)
- No other processes on port 80, 9091, or 16687

### First run

```bash
docker compose up --build
```

This builds all images from source, runs the PostgreSQL migration (`001_init.sql`), seeds the test tenant, and starts all services.

### Subsequent runs (no code changes)

```bash
docker compose up
```

### After changing source code

```bash
# Rebuild and restart only the changed service (e.g. api)
docker compose build api && docker compose up -d api

# Or rebuild everything
docker compose up --build
```

### Run unit tests (no Docker required)

```bash
pnpm install
pnpm test
```

### Run E2E tests (requires stack to be running)

```bash
docker compose up -d
pnpm --filter @task-queue/e2e test
```

---

## Services & Ports

| Container | Role | Exposed port |
|---|---|---|
| `nginx` | Single entry point — proxies API, serves dashboard static files | **:80** |
| `api` (×2) | Fastify REST API + WebSocket | internal :3000 (no host port) |
| `worker` (×2) | Job executor (SKIP LOCKED claim loop) | none |
| `postgres-primary` | Primary DB — all reads + writes | none (internal) |
| `postgres-replica` | WAL replica — read fallback | none (internal) |
| `redis` | Rate limiting + tenant auth cache + counts cache | none (internal) |
| `prometheus` | Metrics scraping | **:9091** |
| `jaeger` | Distributed trace UI | **:16687** |

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
curl -X POST http://localhost/v1/jobs \
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
curl http://localhost/v1/jobs -H "x-api-key: test-api-key-1234"

# Filter by status: pending | running | completed | failed | dead_letter
curl "http://localhost/v1/jobs?status=pending" -H "x-api-key: test-api-key-1234"

# Get a specific job
curl http://localhost/v1/jobs/<id> -H "x-api-key: test-api-key-1234"

# Live counts per status (Redis-cached, 3s TTL)
curl http://localhost/v1/jobs/counts -H "x-api-key: test-api-key-1234"
# → {"pending":3,"running":1,"completed":47,"failed":2,"dead_letter":1}
```

---

### Cancel a Job

```bash
curl -X POST http://localhost/v1/jobs/<id>/cancel \
  -H "x-api-key: test-api-key-1234"
```

Only works on `pending` jobs. Sets status to `failed` with error `"Cancelled by user"`.

---

### Dead Letter Queue

```bash
# List jobs that exhausted all retry attempts
curl http://localhost/v1/dlq -H "x-api-key: test-api-key-1234"

# Re-queue a dead-lettered job (resets attempts to 0, strips simulation flags from payload)
curl -X POST http://localhost/v1/dlq/<id>/retry \
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

`retryAfter` is seconds until the window has capacity again. Rejected requests do **not** consume a slot in the window — only accepted requests count against the limit.

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

## Dashboard

Open **http://localhost** in a browser. Fully responsive across Desktop, Tablet, and Mobile.

| Feature | How to use |
|---|---|
| MetricsBar | Live counts per status — updated via WebSocket on every job change |
| Submit Job form | Paste any JSON payload, click Submit |
| Status tabs | Filter table: all / pending / running / completed / failed / dead_letter |
| Cancel button | Appears on `pending` rows — cancels immediately |
| Dead Letter Queue | Top-right nav link → lists dead-lettered jobs with per-row Retry button |
| Real-time updates | Table and counts update without page refresh via WebSocket |

**Responsive breakpoints:**

| Breakpoint | Columns shown in job table |
|---|---|
| Mobile (<640px) | ID, Status, Action |
| Tablet (640px+) | + Attempts, + Payload |
| Desktop (768px+) | + Priority, + Created |

---

## Observability

### Health check

```bash
curl http://localhost/health
# → {"status":"ok"}
```

### Prometheus metrics

Open **http://localhost:9091** to browse the Prometheus UI and run queries.

Metrics are also directly scrapeable:
```bash
curl http://localhost/metrics
```

| Metric | Type | Labels | Description |
|---|---|---|---|
| `jobs_submitted_total` | Counter | `tenant_id` | Total jobs submitted |
| `jobs_completed_total` | Counter | `tenant_id` | Successfully completed jobs |
| `jobs_failed_total` | Counter | `tenant_id` | Failed job attempts (includes retries) |
| `jobs_dead_lettered_total` | Counter | `tenant_id` | Jobs that exhausted all retries |
| `jobs_pending_gauge` | Gauge | `tenant_id` | Currently pending jobs |
| `jobs_running_gauge` | Gauge | `tenant_id` | Currently running jobs |
| `job_processing_duration_ms` | Histogram | `tenant_id` | End-to-end processing time per job |
| `worker_lease_renewals_total` | Counter | `worker_id` | Heartbeat renewals per worker (confirms workers are alive) |

**Key queries to try in Prometheus:**
```
# Job throughput rate (last 5 minutes)
rate(jobs_completed_total[5m])

# DLQ growth rate
rate(jobs_dead_lettered_total[5m])

# Current queue depth (autoscaling signal)
jobs_pending_gauge
```

### Jaeger distributed traces

Open **http://localhost:16687** → select service `task-queue-api` or `task-queue-worker` → Search.

Every job operation emits a trace with named spans:

| Span | Service | Description |
|---|---|---|
| `job.submit` | api | Full submit path including idempotency check |
| `job.claim` | worker | SKIP LOCKED claim attempt |
| `job.execute` | worker | Actual job execution |
| `job.ack` | worker | Mark completed |
| `job.nack` | worker | Mark failed / retry / dead_letter |
| `job.lease_renew` | worker | Heartbeat renewal |
| `job.dlq` | worker | Dead-letter event |

Traces link the full path from API request → PostgreSQL → worker execution, making it straightforward to debug slow or failed jobs.

### Structured logs (Pino)

#### Viewing logs

```bash
# Follow logs from a specific container
docker logs meraki-labs-api-1 -f
docker logs meraki-labs-api-2 -f
docker logs meraki-labs-worker-1 -f
docker logs meraki-labs-worker-2 -f

# All services at once
docker compose logs -f

# Filter to errors only
docker compose logs -f | grep '"level":50\|ERROR'

# Follow a specific job through the system
docker compose logs -f | grep '<job-uuid>'
```

#### Log formats

**API (development mode — pino-pretty, human-readable):**
```
[08:12:10.897] INFO (1): Migrations complete
[08:12:25.188] INFO (1): incoming request
    reqId: "req-2"
    req: {
      "method": "POST",
      "url": "/v1/jobs",
      "hostname": "localhost",
      "remoteAddress": "172.19.0.12"
    }
[08:12:25.214] INFO (1): request completed
    reqId: "req-2"
    res: { "statusCode": 201 }
    responseTime: 25.306
```

**Worker (JSON — one object per line):**
```json
{"level":30,"time":1716825600000,"pid":1,"hostname":"worker-1","workerId":"6d510e66-...","msg":"Worker started"}
{"level":30,"time":1716825601000,"pid":1,"hostname":"worker-1","jobId":"d4e5f6-...","tenantId":"6597972f-...","msg":"Claimed job"}
{"level":30,"time":1716825615000,"pid":1,"hostname":"worker-1","count":1,"msg":"Recovered stale leases"}
{"level":50,"time":1716825620000,"pid":1,"hostname":"worker-1","jobId":"d4e5f6-...","err":{"type":"Error","message":"Simulated job failure","stack":"Error: Simulated job failure\n    at simulateWork..."},"msg":"Unhandled executor error"}
```

#### Log level reference

| Level | Value | Used for |
|---|---|---|
| `info` | 30 | Normal operations: job claimed, worker started, migrations complete |
| `warn` | 40 | Degraded but not failing: malformed pg_notify payload |
| `error` | 50 | Failures requiring attention: executor crash, DB connection failure, startup error |

#### System events and what they mean

| Message | Service | Meaning |
|---|---|---|
| `Migrations complete` | api | DB schema is up to date, server is about to start |
| `Server listening at http://0.0.0.0:3000` | api | API replica is ready |
| `Worker started` | worker | Worker loop running, includes `workerId` UUID |
| `Worker metrics server on :9091` | worker | Prometheus scrape endpoint is up |
| `Claimed job` | worker | Job moved from `pending` to `running`, includes `jobId` and `tenantId` |
| `Recovered stale leases` | worker | Crashed worker's jobs reclaimed, includes `count` |
| `Worker stopped` | worker | Graceful shutdown complete (SIGTERM received) |
| `LISTEN job_status_change failed` | api | Redis pub/sub channel failed — WebSocket updates will stop |
| `Malformed job_status_change notification` | api | A pg_notify payload couldn't be parsed as JSON |

#### Error log scenarios

**Job executor crash (worker):**
```json
{"level":50,"jobId":"...","err":{"message":"Simulated job failure","stack":"..."},"msg":"Unhandled executor error"}
```
The job is nacked — either retried or dead-lettered depending on attempt count.

**Worker loop error (worker):**
```json
{"level":50,"err":{"message":"connect ECONNREFUSED 10.0.0.5:5432"},"msg":"Worker loop error"}
```
Transient DB connectivity failure. The worker continues polling on the next interval.

**Fatal startup error (worker):**
```json
{"level":50,"err":{"message":"password authentication failed"},"msg":"Fatal worker error"}
```
Process exits. Container restarts per the `restart: unless-stopped` policy.

**API startup failure (api):**
```
[ERROR] (1): password authentication failed for user "postgres"
```
Process exits with code 1. Container restarts automatically.

**401 Unauthorized (api request log):**
```
[WARN] request completed  reqId: "req-5"  res: { "statusCode": 401 }
```

**429 Rate limited (api request log):**
```
[INFO] request completed  reqId: "req-61"  res: { "statusCode": 429 }  responseTime: 1.2
```

#### Switching to JSON logs in all services

To get raw JSON from the API (e.g. for log aggregation in production), set `NODE_ENV=production` in `docker-compose.yml`:
```yaml
environment:
  NODE_ENV: production   # disables pino-pretty, emits raw JSON
```

Then pipe through `jq` for readable output:
```bash
docker logs meraki-labs-api-1 -f | grep '{"level"' | jq .
```

---

## Edge Cases & Failure Scenarios

These scenarios are all handled by the implementation and documented here for clarity.

### 1. Worker crashes mid-job

**What happens:** The worker process dies while holding a running job. The 30-second lease expires. Every surviving worker runs a stale-lease-recovery sweep every 15 seconds:

```sql
UPDATE jobs SET status = 'pending', worker_id = NULL, lease_expires_at = NULL
WHERE status = 'running' AND lease_expires_at < NOW()
```

**Recovery time:** ≤45 seconds (30s lease TTL + up to 15s until the next sweep).

**No data loss:** The job re-enters `pending` and is claimed by another worker. The `attempts` counter was already incremented on claim, so this counts as one attempt.

---

### 2. Job lease stolen (slow execution + lease expiry)

**What happens:** A job takes longer than 30 seconds AND the heartbeat also fails (e.g. the worker is CPU-starved and can't send renewals). The lease expires and another worker reclaims the job. The original worker eventually tries to ack — but the `WHERE worker_id = $me` condition matches 0 rows, so the ack is silently dropped.

**Key code:** `executor.ts` sets `stolen = true` via the heartbeat callback when `renewLease` returns false. Even if the heartbeat fires late and the job was already reclaimed, the ack UPDATE is a no-op because `worker_id` no longer matches.

**Result:** At-least-once delivery. The job may execute twice. Use `idempotency_key` in the payload handler for exactly-once semantics.

---

### 3. Two workers race for the same job

**What happens:** Both workers enter their claim loop simultaneously and both issue the SKIP LOCKED query.

**Why only one wins:** PostgreSQL's `SELECT ... FOR UPDATE SKIP LOCKED` holds a row-level lock for exactly one transaction. The second transaction skips the locked row and finds nothing (or the next eligible job). This is atomic — no application-level locking required.

---

### 4. Idempotency key collision

**What happens:** The same `idempotency_key` is submitted twice (e.g. a client retries a timed-out HTTP request).

**Implementation:**
```sql
INSERT INTO jobs (...) VALUES (...) ON CONFLICT (tenant_id, idempotency_key) DO NOTHING RETURNING *
```
An empty `RETURNING` means a duplicate was detected. The service then fetches and returns the original job. The second submission gets a `201` with the original job — identical to the first response.

**Guarantee:** Exactly one job is created regardless of how many times the same `idempotency_key` is submitted.

---

### 5. Rate limit exceeded

**What happens:** A tenant sends more than `rate_limit_per_minute` requests within a 60-second rolling window.

**Response:**
```json
HTTP 429 Too Many Requests
{"error": "Rate limit exceeded", "retryAfter": 42}
```

**Important:** Rejected requests are **not** counted against the window. The slot consumed by the over-limit request is immediately removed from the Redis sorted set, so a burst of 200 rejected requests doesn't extend the window beyond 60 seconds.

**Redis unavailable:** Rate limiting fails open — requests are allowed through. The system logs the Redis error but does not block traffic.

---

### 6. Per-tenant concurrency limit

**What happens:** A tenant has 5 jobs already `running` and another job becomes `pending`.

**Implementation:** Before each claim cycle, workers query:
```sql
SELECT t.id FROM tenants t
WHERE (SELECT COUNT(*) FROM jobs WHERE tenant_id = t.id AND status = 'running') < t.max_concurrent_jobs
```
A tenant at its concurrency limit is excluded from the claim query entirely. The pending job stays queued until a running job finishes.

**Note:** The count check and the claim are separate operations — there is a small window where a tenant could briefly exceed its limit under very high concurrency. This is a soft cap, not a hard guarantee. For most workloads the 500ms poll interval makes this negligible.

---

### 7. Scheduled job claimed early

**What happens:** A job is submitted with `scheduled_at` set to a future timestamp.

**Implementation:** The claim query filters `AND j.scheduled_at <= NOW()`. The job sits in `pending` state but is invisible to workers until the scheduled time arrives. It will not be claimed early.

---

### 8. Cancel on non-pending job

**What happens:** A client tries to cancel a job that is already `running`, `completed`, `failed`, or `dead_letter`.

**Response:** `404 Not Found` — the cancel UPDATE's `WHERE status = 'pending'` matches nothing.

---

### 9. PostgreSQL primary failure

**What happens:** The primary database becomes unreachable.

**Read queries:** Automatically fall back to the WAL replica via `readWithFallback()`. Reads may be slightly stale (typically <100ms lag) but continue serving.

**Write queries:** Fail immediately (job submissions, claims, acks). Workers stop claiming new jobs but don't crash — they retry on the next poll cycle.

**Recovery:** When the primary comes back, everything resumes automatically. No manual intervention. Jobs that were `pending` when the primary went down are still there — nothing is lost.

---

### 10. DLQ retry

**What happens:** A job in `dead_letter` is retried via `POST /dlq/:id/retry`.

**Implementation:**
```sql
UPDATE jobs SET status = 'pending', attempts = 0, error = NULL,
  lease_expires_at = NULL, worker_id = NULL, scheduled_at = NOW(),
  payload = payload - 'fail'   -- strips simulation flag so retried job can succeed
WHERE id = $1 AND status = 'dead_letter'
```

`attempts` resets to 0 so the job gets its full `max_attempts` quota again. The `payload - 'fail'` removes the `{"fail": true}` simulation flag atomically — retried jobs are expected to succeed.

---

### 11. Graceful worker shutdown

**What happens:** The container receives SIGTERM (e.g. `docker compose stop` or a Kubernetes pod eviction).

**Implementation:** The worker loop sets `stopped = true` on SIGTERM/SIGINT and exits cleanly after the current poll cycle. In-flight jobs continue executing — they either complete (ack) or the lease expires and another worker reclaims them.

---

## Inspect the Database

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
# Add "ports: ['5433:5432']" to postgres-primary in docker-compose.yml, then:
docker compose up -d postgres-primary
# Connect to localhost:5433, user: postgres, password: postgres, db: taskqueue
```

---

## Running Tests

```bash
# Unit tests (Vitest — no Docker required)
pnpm install
pnpm test
```

| Test file | What it covers |
|---|---|
| `api/job.service.test.ts` | Idempotency collision, new job creation, cancel semantics |
| `api/rateLimit.test.ts` | Redis sliding window correctness, 429 on breach |
| `api/quota.service.test.ts` | Tenant excluded from claim pool at concurrency limit |
| `worker/claimer.test.ts` | SKIP LOCKED returns null when no eligible jobs |
| `worker/leaser.test.ts` | Heartbeat returns false when job stolen |
| `worker/executor.test.ts` | Ack (completed), nack→pending (retry), nack→dead_letter |
| `worker/stress.test.ts` | 10 concurrent workers × 50 jobs — zero double-execution |

```bash
# E2E tests (Playwright — requires stack running)
docker compose up -d
pnpm --filter @task-queue/e2e test
```

### What the E2E suite covers

| Test | What it proves |
|---|---|
| 1. Submit → completed | Normal job lifecycle end-to-end |
| 2. Failing job → DLQ | Retry exhaustion and dead-letter routing |
| 3. Retry from DLQ | Re-queue and re-execution — job completes, leaves DLQ permanently |
| 4. Cancel scheduled job | Cancel endpoint and status transition |
| 5. MetricsBar accuracy | Counts reflect DB truth |
| 6. Idempotency key | Duplicate submission returns original job |
| 7. Health check | GET /health returns ok |
| 8. Invalid API key | Returns 401 |
| 9. Dashboard loads | MetricsBar and status counts visible |
| 10. Submit via form | Job appears in table in real time |
| 11. DLQ page loads | Heading and Back link visible |
| 12. DLQ retry UI | Row disappears on retry, job completes — does not reappear |
| 13. WebSocket real-time | Job submitted via API appears in dashboard without page refresh |
| 14. Rate limiting | 429 returned after limit exceeded |

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

## Design Decisions & Trade-offs

These are choices that are correct for this architecture regardless of scale — not compromises made for the demo.

### 1. Why Fastify instead of Express?

Fastify compiles JSON serialization from route schemas at startup rather than calling `JSON.stringify` at runtime — making it roughly 3× faster than Express on JSON-heavy endpoints. It also ships with first-class TypeScript support (typed request/reply generics, route schemas) and a scoped plugin system where middleware can't accidentally leak across routes. For a job queue API where `/jobs` and `/jobs/counts` are hit on every submit and every dashboard poll, that throughput advantage matters. The trade-off is a steeper learning curve — Fastify's decorator and plugin scoping model is less familiar than Express middleware chains.

### 2. Why PostgreSQL for the queue instead of Redis/RabbitMQ?

`FOR UPDATE SKIP LOCKED` gives row-level locking without a separate broker process. Jobs, tenants, and queue state all live in one durable, ACID-compliant store. Simpler ops, no extra process to monitor, and the data is queryable with plain SQL. The trade-off: Postgres is not purpose-built for queuing — at very high throughput (100k+ jobs/s) a dedicated broker would win.

### 3. At-least-once vs exactly-once

This system guarantees **at-least-once** delivery. A job that times out before ack will be reclaimed and re-executed by another worker. Callers who need exactly-once semantics should supply an `idempotency_key` — the handler must be idempotent itself.

### 4. Lease duration (30 seconds)

30s balances reclaim latency vs false-positive reclaims. The heartbeat fires every 10s, so a 30s lease has 2+ renewals before expiry. A crashed worker's jobs are reclaimed within ≤45s (30s lease + 15s stale-lease-check interval).

### 5. Redis rate limiting — globally consistent across replicas

The original in-memory sliding window (`Map<tenantId, timestamps[]>`) worked correctly for a single API process but breaks with multiple replicas — each instance tracks its own counter, so a tenant could send `N × rate_limit` requests across N replicas. Redis sorted-set sliding window enforces a single global counter shared by all API replicas. The cost is one extra round-trip to Redis per request, which is sub-millisecond on the local network.

### 6. Redis caching strategy

Two caches are used; both are safe to be briefly stale:

- **Tenant auth cache** (`tenant:apikey:{key}`, TTL 5min) — runs on every authenticated request. Tenant API keys almost never change. Eliminates a DB SELECT on the hot path.
- **Job counts cache** (`counts:{tenantId}`, TTL 3s) — the MetricsBar polls this. A GROUP BY aggregation on a large jobs table is expensive; 3s staleness is invisible to users given the WebSocket already delivers real-time updates.

Job rows themselves are **not cached** — they change state every few seconds and the WebSocket real-time path already handles UI updates correctly without a cache.

### 7. PostgreSQL read replica — WAL streaming, not interval-based

WAL (Write-Ahead Log) replication is a **continuous TCP stream**, not a cron job. The replica applies changes within milliseconds of the primary committing them. All traffic normally hits the primary; the replica is a warm standby. If the primary becomes unreachable, read queries automatically fall back to the replica. Write queries (submit, claim, ack, cancel) fail until the primary recovers — jobs are durable and workers resume automatically when it comes back. For zero-downtime write HA, replace with a managed Postgres service (RDS Multi-AZ, Supabase) or add Patroni for automatic primary promotion.

### 8. nginx WebSocket handling — no stickiness needed

A common misconception is that WebSocket connections require sticky sessions when load-balancing. That would be true if API replicas needed to coordinate WS state. Here they don't — each replica independently LISTENs to PostgreSQL's `pg_notify` channel and receives all job status events. A client connected to api-1 gets the same updates as one connected to api-2. nginx simply upgrades the connection and proxies — no sticky routing required.

### 9. Worker autoscaling design

`jobs_pending_gauge` is the natural autoscaling signal. A Kubernetes HPA with a custom metrics adapter could scale worker replicas when `jobs_pending_gauge > threshold` for 60+ seconds. The SKIP LOCKED design makes adding workers safe at any time — new workers immediately join the claim race without coordination or configuration changes.

### 10. Per-tenant concurrency — why not a message broker?

The concurrency limit (`max_concurrent_jobs` per tenant) is enforced at the worker level: before each claim cycle, workers run a `COUNT(*) WHERE status = 'running'` query per tenant and only claim jobs for tenants below their limit. This is a deliberate choice over using a message broker's prefetch/consumer-count mechanism.

A broker controls **global** consumer concurrency — how many messages any consumer can hold unacknowledged at once. It has no concept of a per-tenant limit. To enforce per-tenant caps with a broker you would still need the same `COUNT(*)` query against shared state, plus distributed locking for claiming (since the broker no longer provides atomic row ownership), plus a separate heartbeat coordination layer. You'd have more infrastructure with the same coordination overhead.

`SKIP LOCKED` keeps all three guarantees in a single transaction boundary:

| Guarantee | How SKIP LOCKED provides it | What a broker would need instead |
|---|---|---|
| Atomic per-tenant claim | `SELECT FOR UPDATE SKIP LOCKED` — one statement, one transaction | Broker delivery + Redis SETNX distributed lock |
| Lease heartbeat | `UPDATE WHERE worker_id = $me` — 0 rows = job stolen, atomically | Separate lock TTL refresh + consistency check between broker ack and DB state |
| Per-tenant running count | `COUNT(*) WHERE status = 'running'` — same DB, same transaction | Same query, but now across a broker + DB boundary with no atomicity |

**When to switch:** introduce a message broker when sustained job throughput exceeds ~50k/s (at that point polling and row-level locking strain the primary), or when you need fan-out (one job delivered to multiple independent consumer types). Neither condition applies here.

### 11. Shared database across api and worker

Both services intentionally share the same PostgreSQL instance because the queue's correctness guarantees depend on it. `SKIP LOCKED` gives atomic, distributed job claiming within a single transaction — no two workers can claim the same row. Lease heartbeats let a worker atomically check and renew its hold on a job it's executing. Idempotency key deduplication is enforced by a unique index at the database level. All three of these only work because both services operate on the same rows in the same database.

The natural evolution path if team or scale demands it:
1. **Separate schemas** (`api.*` owns tenants and auth; `worker.*` owns jobs and leases) — establishes ownership boundaries without changing infrastructure
2. **Message broker** (Kafka, RabbitMQ) — only warranted when job throughput exceeds ~100k/s or when the api and worker teams need to deploy fully independently

### 12. DLQ strategy

`dead_letter` is a status value in the same `jobs` table — simple and avoids an extra schema object. In production you'd move dead-lettered rows to a separate table (or a message topic like Kafka) to prevent the `idx_jobs_claim` partial index from bloating with rows that are never eligible for claiming.
