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
| REST API | http://localhost/v1 | `x-api-key: test-e2e-key-5678` (300/min) |
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
pnpm install   # installs on your host machine — only needed for tests
pnpm test
```

### Run E2E tests (requires stack to be running)

```bash
docker compose up -d
pnpm install   # if not already done
pnpm --filter @task-queue/e2e test
```

> **Note on node_modules:** Each Dockerfile runs `pnpm install` inside the build — the services need no `npm install` on your host. You only need `pnpm install` locally if you want to run unit or E2E tests outside Docker.

---

## Services & Ports

| Container | Role | Exposed port |
|---|---|---|
| `nginx` | Single entry point — proxies API, serves dashboard static files | **:80** |
| `api` (×2) | Fastify REST API + WebSocket | internal :3000 (no host port) |
| `worker` (×2) | Job executor (SKIP LOCKED claim loop) — each process handles up to 3 concurrent jobs (`WORKER_CONCURRENCY=3`), so 2 workers = 6 jobs in-flight max | none |
| `postgres-primary` | Primary DB — all reads + writes | none (internal) |
| `postgres-replica` | WAL replica — read fallback | none (internal) |
| `redis` | Rate limiting + tenant auth cache + counts cache | none (internal) |
| `prometheus` | Metrics scraping | **:9091** |
| `jaeger` | Distributed trace UI | **:16687** |

---

## Features & API Reference

### Authentication

Every API request requires an `x-api-key` header. Two tenants are pre-seeded:

| Key | Rate limit | Concurrency | When to use |
|---|---|---|---|
| `test-api-key-1234` | 60/min | 5 jobs | Rate-limit testing only |
| `test-e2e-key-5678` | 300/min | 20 jobs | Everything else — exploration, DLQ tests, dashboard |

A **tenant** is an API client identified by its key — each tenant has its own isolated job namespace, rate limit, and concurrency quota. The dashboard is pre-configured with `test-e2e-key-5678`.

```
x-api-key: test-e2e-key-5678
```

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
# List jobs — newest first, 50 per page
curl http://localhost/v1/jobs -H "x-api-key: test-api-key-1234"
# → {"data": [...], "nextCursor": "<token>|null"}

# Next page — pass the cursor from the previous response
curl "http://localhost/v1/jobs?cursor=<token>" -H "x-api-key: test-api-key-1234"

# Filter by status: pending | running | completed | failed | dead_letter
curl "http://localhost/v1/jobs?status=pending" -H "x-api-key: test-api-key-1234"

# Custom page size (max 200)
curl "http://localhost/v1/jobs?limit=20" -H "x-api-key: test-api-key-1234"

# Get a specific job
curl http://localhost/v1/jobs/<id> -H "x-api-key: test-api-key-1234"

# Live counts per status (Redis-cached, 3s TTL)
curl http://localhost/v1/jobs/counts -H "x-api-key: test-api-key-1234"
# → {"pending":3,"running":1,"completed":47,"failed":2,"dead_letter":1}
```

Pagination uses a **cursor**, not an offset. The cursor encodes the position of the last item on the current page — new jobs inserted between requests never cause duplicates or skipped rows.

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
# List dead-lettered jobs — 50 per page, newest first
curl http://localhost/v1/dlq -H "x-api-key: test-api-key-1234"
# → {"data": [...], "nextCursor": "<token>|null"}

# Next page
curl "http://localhost/v1/dlq?cursor=<token>" -H "x-api-key: test-api-key-1234"

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

**Burst behavior:** If you send all 60 allowed requests within one second, every slot expires at approximately the same time (~60 seconds later). You'll see a near-full-window wait before requests are accepted again. This is correct sliding window behavior, not a bug — spread requests over time to avoid it.

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
| Load more | Bottom of job table and DLQ table — cursor-paginated, 50 rows per page |
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

---

### Prometheus — metrics & alerts

**Open: http://localhost:9091**

Prometheus is a time-series metrics store. It scrapes both the API and worker every 15 seconds and lets you query the history with PromQL expressions.

#### Navigating the UI

| Tab | What it does |
|---|---|
| **Graph** | Type a PromQL query and see the result as a number or chart. Start here. |
| **Alerts** | Shows all configured alert rules and their current state: `inactive` (not firing), `pending` (condition met, waiting), or `firing` (problem confirmed). |
| **Status → Targets** | Shows whether Prometheus can reach the API and worker scrape endpoints. If a row shows `DOWN`, that service is unreachable. |
| **Status → Rules** | Lists all loaded alert rules with their last evaluation result. |

#### First thing to try

1. Go to **http://localhost:9091/graph**
2. Paste this query and press **Execute**:
```
sum(jobs_pending_gauge)
```
This shows the true pending queue depth (submits happen in the API, claims in the worker — `sum` combines both). Switch to the **Graph** tab to watch it over time as you submit jobs.

#### Metrics

| Metric | Source | Type | Description |
|---|---|---|---|
| `jobs_submitted_total` | api | Counter | Total jobs received via POST /jobs |
| `jobs_pending_gauge` | api + worker | Gauge | Queue depth delta — api tracks +1 submit / -1 cancel, worker tracks -1 on claim. Use `sum()` for the true total. |
| `jobs_completed_total` | worker | Counter | Successfully completed jobs |
| `jobs_failed_total` | worker | Counter | Failed attempts (includes retries before DLQ) |
| `jobs_dead_lettered_total` | worker | Counter | Jobs that exhausted all retries |
| `jobs_running_gauge` | worker | Gauge | Currently executing jobs |
| `job_processing_duration_ms` | worker | Histogram | End-to-end latency per job |
| `worker_lease_renewals_total` | worker | Counter | Heartbeat renewals — confirms workers are alive |

#### Useful queries

```
# Current pending queue depth
sum(jobs_pending_gauge)

# Job throughput — completions per second (last 5 min)
rate(jobs_completed_total[5m])

# DLQ growth rate — should stay at 0 in a healthy system
rate(jobs_dead_lettered_total[5m])

# Are workers alive? Heartbeat renewals confirm the lease loop is running
rate(worker_lease_renewals_total[1m])
```

#### Alert rules

Five alert rules are pre-configured in `infra/prometheus/alerts.yml`. Open **http://localhost:9091/alerts** to see their current state:

| Alert | Fires when | Severity |
|---|---|---|
| `DLQGrowing` | DLQ growth rate > 0 for 1 minute | warning |
| `QueueBacklogHigh` | Pending queue > 20 jobs for 2 minutes | warning |
| `HighFailureRate` | >50% of job attempts failing for 2 minutes | warning |
| `APIDown` | API scrape target unreachable for 30 seconds | critical |
| `WorkerDown` | Worker scrape target unreachable for 30 seconds | critical |

**How to trigger an alert to see it fire:**
```bash
# Trigger DLQGrowing — submit 3 failing jobs (max_attempts=1 so they DLQ immediately)
for i in 1 2 3; do
  curl -s -X POST http://localhost/v1/jobs \
    -H "x-api-key: test-e2e-key-5678" \
    -H "Content-Type: application/json" \
    -d '{"payload": {"fail": true}, "max_attempts": 1}'
done
# Wait ~60s, then refresh http://localhost:9091/alerts — DLQGrowing moves to FIRING
```

**Alert states explained:**
- `inactive` — rule is evaluated, condition is false (normal)
- `pending` — condition is true but hasn't lasted long enough yet (the `for` duration)
- `firing` — condition has been true long enough, alert is confirmed

> In production, alerts route through [Alertmanager](https://prometheus.io/docs/alerting/latest/alertmanager/) to Slack, PagerDuty, or email. Here they're visible in the UI only — no Alertmanager is configured since this is a self-contained demo.

---

### Jaeger — distributed traces

**Open: http://localhost:16687**

Jaeger records the exact execution path of individual operations — every DB query, every function call — with precise timings. Where Prometheus tells you *how many* jobs failed, Jaeger tells you *why a specific job* failed and *where* time was spent.

#### Navigating the UI

Select a service from the left panel dropdown and click **Find Traces**:
- `task-queue-api` — traces for job submissions, status checks, DLQ operations
- `task-queue-worker` — traces for job claims, execution, ack/nack, heartbeats

Click any result row to open a timeline of nested spans with per-span timings.

#### First thing to try

1. Submit a job:
```bash
curl -s -X POST http://localhost/v1/jobs \
  -H "x-api-key: test-e2e-key-5678" \
  -H "Content-Type: application/json" \
  -d '{"payload": {"task": "hello"}}'
```
2. Go to **http://localhost:16687**, select `task-queue-api`, click **Find Traces**
3. Click the `job.submit` trace — you see the full submit path with DB timing

#### What each span means

| Span | Service | What you see inside |
|---|---|---|
| `job.submit` | api | Idempotency check + INSERT — total time from request to DB commit |
| `job.claim` | worker | SKIP LOCKED UPDATE — how long it took to claim a pending job |
| `job.execute` | worker | Actual execution time — how long the job's work took |
| `job.ack` | worker | UPDATE to `completed` — DB write after successful execution |
| `job.nack` | worker | UPDATE to `pending` or `dead_letter` — DB write after failure |
| `job.lease_renew` | worker | Heartbeat UPDATE — confirms the worker is still alive |
| `job.dlq` | worker | Child span inside `job.nack` — only appears when a job is dead-lettered |

#### Reading a trace

A typical successful job produces this span tree in the worker:
```
job.claim       (e.g. 3ms  — claim from DB)
job.execute     (e.g. 250ms — simulated work)
  job.ack       (e.g. 2ms  — write completed status)
```

A failed job that retries looks like:
```
job.claim       (3ms)
job.execute     (150ms)
  job.nack      (2ms)   ← status set back to 'pending'
```

A job that exhausts retries and dead-letters:
```
job.claim       (3ms)
job.execute     (150ms)
  job.nack      (2ms)
    job.dlq     (0ms)   ← child span marking the DLQ event
```

If a span is unexpectedly long, that's where to look first — it will be visually wider in the timeline.

### Structured logs (Pino)

Both services use [Pino](https://github.com/pinojs/pino) for structured logging. They emit different formats depending on `NODE_ENV`:

---

#### API logs (pino-pretty, human-readable)

The API runs with `NODE_ENV=development` so logs are formatted by pino-pretty — colorized and multi-line.

**How to view:**
```bash
# Docker Compose auto-names replicas as <project>-<service>-<n>
docker logs meraki-labs-api-1 -f
docker logs meraki-labs-api-2 -f

# Or follow all API replicas at once without naming them individually
docker compose logs api -f
```

**What you see:**
```
[08:12:10.897] INFO (1): Migrations complete
[08:12:10.909] INFO (1): Server listening at http://0.0.0.0:3000

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

[08:13:01.512] WARN (1): Malformed job_status_change notification

[08:13:05.001] ERROR (1): LISTEN job_status_change failed
    err: {
      "type": "Error",
      "message": "Connection terminated unexpectedly"
    }
```

Every request gets a `reqId` that links the `incoming request` and `request completed` lines together. Use it to correlate request logs:
```bash
docker logs meraki-labs-api-1 2>&1 | grep "req-42"
```

---

#### Worker logs (raw JSON)

The worker emits raw Pino JSON — one object per line.

**How to view:**
```bash
# Raw JSON (container names are auto-generated by Docker Compose)
docker logs meraki-labs-worker-1 -f

# Or follow all worker replicas at once
docker compose logs worker -f

# Readable with jq (requires jq installed)
docker compose logs worker -f | jq .
```

**What you see:**
```json
{"level":30,"time":1716825600000,"pid":1,"hostname":"43624d78516e","workerId":"6d510e66-3339-4ea2-80bc-f87dc13bbccf","msg":"Worker started"}
{"level":30,"time":1716825601000,"pid":1,"hostname":"43624d78516e","msg":"Worker metrics server on :9091"}
{"level":30,"time":1716825602000,"pid":1,"hostname":"43624d78516e","jobId":"d4e5f6-...","tenantId":"6597972f-...","msg":"Claimed job"}
{"level":30,"time":1716825615000,"pid":1,"hostname":"43624d78516e","count":2,"msg":"Recovered stale leases"}
{"level":50,"time":1716825620000,"pid":1,"hostname":"43624d78516e","jobId":"d4e5f6-...","err":{"type":"Error","message":"Simulated job failure","stack":"Error: Simulated job failure\n    at simulateWork (executor.js:22:9)"},"msg":"Unhandled executor error"}
{"level":30,"time":1716825700000,"pid":1,"hostname":"43624d78516e","msg":"Worker stopped"}
```

**Log level values:** `30` = info, `40` = warn, `50` = error

---

#### System logs

System logs are `info`-level events that confirm the lifecycle of each service. They are always emitted — no configuration needed.

| Log message | Service | When it appears |
|---|---|---|
| `Migrations complete` | api | DB schema applied, server is about to bind |
| `Server listening at http://0.0.0.0:3000` | api | Replica is ready to accept requests |
| `Worker started` | worker | Worker loop is running — `workerId` field identifies this instance |
| `Worker metrics server on :9091` | worker | Prometheus scrape endpoint is up |
| `Claimed job` | worker | Job moved `pending → running` — `jobId` and `tenantId` always present |
| `Recovered stale leases` | worker | Expired leases reclaimed — `count` field shows how many jobs were re-queued |
| `Worker stopped` | worker | Clean shutdown after SIGTERM |

**How to monitor system events in real time:**
```bash
# Watch all system events across all worker replicas
docker compose logs worker -f | grep "Claimed job\|Recovered\|started\|stopped"

# Watch only stale lease recovery (indicates a worker crashed)
docker compose logs worker -f | grep "Recovered stale leases"

# Count how many jobs have been claimed across all workers (since container start)
docker compose logs worker | grep -c "Claimed job"
```

---

#### Error logs

Error logs are `error`-level (`"level":50` in JSON, `ERROR` in pino-pretty). Every error in the system has a specific message and known recovery behaviour.

**How to monitor errors across all services:**
```bash
# All errors in real time across every container
docker compose logs -f | grep -E '"level":50|ERROR'

# Worker errors only with jq (all replicas)
docker compose logs worker -f | jq 'select(.level == 50)'

# API errors only (pino-pretty ERROR lines with context)
docker compose logs api -f | grep -A2 "ERROR"
```

**Implemented error events:**

| Error message | Service | Cause | Recovery |
|---|---|---|---|
| `Unhandled executor error` | worker | Job threw an uncaught exception | Job is nacked — retried or dead-lettered based on attempt count |
| `Worker loop error` | worker | Transient DB failure during poll/claim cycle | Worker sleeps 500ms and retries automatically |
| `Fatal worker error` | worker | Startup failure (bad DB credentials, missing env var) | Container exits → Docker restarts it (`restart: unless-stopped`) |
| `LISTEN job_status_change failed` | api | pg_notify channel setup failed | WebSocket updates stop for that replica; API requests still work |
| API startup error (no message field) | api | DB unreachable at boot, port conflict | Container exits → Docker restarts it |

**Example: spotting a job that failed and landed in DLQ:**
```bash
# Find the error that caused a specific job to dead-letter
docker compose logs worker | grep '<job-uuid>'

# Output shows the claim, then the executor error:
# {"msg":"Claimed job","jobId":"d4e5f6","tenantId":"..."}
# {"msg":"Unhandled executor error","jobId":"d4e5f6","err":{"message":"Simulated job failure",...}}
```

**Example: detecting a worker crash (stale lease recovery fires):**
```bash
docker compose logs worker | grep "Recovered stale leases"
# {"msg":"Recovered stale leases","count":3}
# count > 0 means at least one worker died mid-job
```

---

#### Switching to JSON logs for all services

To emit raw JSON from the API (useful when shipping logs to Datadog, CloudWatch, Loki, etc.), change `NODE_ENV` in `docker-compose.yml`:

```yaml
# In the api service environment block:
NODE_ENV: production   # disables pino-pretty, emits raw JSON
```

Then rebuild and restart:
```bash
docker compose build api && docker compose up -d api
```

All logs can then be parsed uniformly:
```bash
docker logs meraki-labs-api-1 -f | grep '{"level"' | jq .
docker logs meraki-labs-worker-1 -f | jq .
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

## Reproducing Edge Cases

All scenarios below run against a live stack (`docker compose up`). Open a second terminal and run `docker compose logs -f` to watch events as they happen. Commands use `test-e2e-key-5678` (300/min limit) unless the scenario is specifically about rate limiting.

---

### 1. Worker crash mid-job

```bash
# Terminal 1 — watch for stale lease recovery
docker compose logs worker -f | grep "Recovered stale leases"

# Terminal 2 — submit a job, then immediately kill one worker
curl -s -X POST http://localhost/v1/jobs \
  -H "x-api-key: test-e2e-key-5678" \
  -H "Content-Type: application/json" \
  -d '{"payload": {"task": "important-work"}}' | jq .id

docker kill meraki-labs-worker-1
```

Within ≤45 seconds the surviving worker logs `"Recovered stale leases"` with `"count":1` and reclaims the job.

---

### 2 & 3. Lease theft / SKIP LOCKED race

These are verified by unit and stress tests rather than a manual trigger:
- **Lease theft** — `leaser.test.ts`: `renewLease` returns `false` when `worker_id` no longer matches, causing the original worker to abort.
- **SKIP LOCKED race** — `stress.test.ts`: 10 concurrent workers × 50 jobs with zero double-execution confirmed.

---

### 4. Idempotency key collision

```bash
# Submit twice with the same idempotency_key
for i in 1 2; do
  curl -s -X POST http://localhost/v1/jobs \
    -H "x-api-key: test-e2e-key-5678" \
    -H "Content-Type: application/json" \
    -d '{"payload": {"task": "send-invoice"}, "idempotency_key": "invoice-order-99"}' | jq .id
done
# Both lines print the same UUID
```

---

### 5. Rate limit exceeded

```bash
# Send 65 requests against the 60/min tenant
for i in $(seq 1 65); do
  curl -s -o /dev/null -w "%{http_code}\n" \
    http://localhost/v1/jobs/counts \
    -H "x-api-key: test-api-key-1234"
done
# First 60 → 200, remainder → 429 with {"error":"Rate limit exceeded","retryAfter":...}
```

---

### 6. Per-tenant concurrency cap

```bash
# Submit 6 jobs in parallel against the 5-concurrent tenant (test-api-key-1234)
for i in $(seq 1 6); do
  curl -s -X POST http://localhost/v1/jobs \
    -H "x-api-key: test-api-key-1234" \
    -H "Content-Type: application/json" \
    -d "{\"payload\": {\"task\": \"job-$i\"}}" &
done
wait

# Immediately query DB — 5 running, 1 still pending
docker exec meraki-labs-postgres-primary-1 psql -U postgres -d taskqueue \
  -c "SELECT status, COUNT(*) FROM jobs GROUP BY status ORDER BY status;"
```

The 6th job stays `pending` until one of the 5 running jobs completes.

---

### 7. Scheduled job claimed early

```bash
# Submit with a far-future scheduled_at
curl -s -X POST http://localhost/v1/jobs \
  -H "x-api-key: test-e2e-key-5678" \
  -H "Content-Type: application/json" \
  -d '{"payload": {"task": "future-report"}, "scheduled_at": "2099-01-01T00:00:00Z"}' | jq .

# Verify it stays pending indefinitely (scheduled_at is in 2099)
curl -s "http://localhost/v1/jobs?status=pending" \
  -H "x-api-key: test-e2e-key-5678" | jq '.data[0] | {id, status, scheduled_at}'
```

---

### 8. Cancel on non-pending job

```bash
# Submit and capture the job ID
ID=$(curl -s -X POST http://localhost/v1/jobs \
  -H "x-api-key: test-e2e-key-5678" \
  -H "Content-Type: application/json" \
  -d '{"payload": {"task": "quick"}}' | jq -r .id)

# Wait for it to complete
sleep 3

# Try to cancel a completed job
curl -s -o /dev/null -w "%{http_code}\n" \
  -X POST "http://localhost/v1/jobs/$ID/cancel" \
  -H "x-api-key: test-e2e-key-5678"
# → 404 (WHERE status = 'pending' matched nothing)
```

---

### 9. PostgreSQL primary failure

```bash
# Stop the primary
docker stop meraki-labs-postgres-primary-1

# Reads still work via the WAL replica
curl -s http://localhost/v1/jobs -H "x-api-key: test-e2e-key-5678" | jq '.data | length'

# Writes fail gracefully (500)
curl -s -o /dev/null -w "%{http_code}\n" \
  -X POST http://localhost/v1/jobs \
  -H "x-api-key: test-e2e-key-5678" \
  -H "Content-Type: application/json" \
  -d '{"payload": {"task": "test"}}'

# Restore — all services resume automatically, no data lost
docker start meraki-labs-postgres-primary-1
```

---

### 10. DLQ and retry

```bash
# Submit a job that will exhaust its retries
JOB=$(curl -s -X POST http://localhost/v1/jobs \
  -H "x-api-key: test-e2e-key-5678" \
  -H "Content-Type: application/json" \
  -d '{"payload": {"fail": true}, "max_attempts": 2}')
ID=$(echo $JOB | jq -r .id)

# Wait for dead_letter (~10s for 2 failed attempts)
sleep 12
curl -s "http://localhost/v1/jobs/$ID" -H "x-api-key: test-e2e-key-5678" | jq .status
# → "dead_letter"

# Retry — strips the fail flag, resets attempts to 0
curl -s -X POST "http://localhost/v1/dlq/$ID/retry" \
  -H "x-api-key: test-e2e-key-5678" | jq .

# Job completes successfully this time
sleep 3
curl -s "http://localhost/v1/jobs/$ID" -H "x-api-key: test-e2e-key-5678" | jq .status
# → "completed"
```

---

### 11. Graceful worker shutdown

```bash
# Terminal 1 — watch for clean shutdown message
docker compose logs worker -f | grep "Worker stopped\|Recovered"

# Terminal 2 — stop all workers (sends SIGTERM)
docker compose stop worker
# Logs show: {"msg":"Worker stopped"} per replica — no crash, no abrupt exit

# Restart workers — they resume immediately
docker compose up -d worker
```

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

### Test API keys

Two tenants are seeded automatically on first `docker compose up`:

| Key | Rate limit | Used by |
|---|---|---|
| `test-e2e-key-5678` | 300/min | All functional E2E tests + dashboard UI |
| `test-api-key-1234` | 60/min | Rate-limiting test only |

The dashboard bundle is built with `test-e2e-key-5678` (baked in at image build time via `VITE_API_KEY`). Playwright's `extraHTTPHeaders` uses the same key so browser-level fetch calls and API-level test requests authenticate as the same tenant. The rate-limit test uses `test-api-key-1234` in isolation so its 60/min window is never depleted by the rest of the suite.

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
  Browser / API Client
          │
          ▼
┌─────────────────────────────────────────────┐
│                 nginx  :80                  │
│   Round-robin HTTP · WebSocket upgrade      │
│   Serves dashboard static files             │
└───────────────┬─────────────────────────────┘
                │
       ┌────────┴─────────┐
       │                  │
┌──────▼──────┐    ┌──────▼──────┐
│   api-1     │    │   api-2     │      ┌─────────────────────┐
│  Fastify    │    │  Fastify    │      │      Workers        │
│  WS server  │    │  WS server  │      │  worker-1  worker-2 │
└──────┬──────┘    └──────┬──────┘      └──────────┬──────────┘
       │                  │                         │
       └────────┬─────────┘                         │ (direct — no nginx)
                │                                   │
       ┌────────▼────────┐                          │
       │      Redis      │                          │
       │  rate limit     │                          │
       │  tenant cache   │                          │
       │  counts cache   │                          │
       └────────┬────────┘                          │
                │                                   │
       ┌────────▼──────────────────────────────────▼┐
       │            postgres-primary                 │
       │         all reads + writes                  │
       │  pg_notify ──► api-1 LISTEN                 │
       │            ──► api-2 LISTEN ──► WS clients  │
       └────────────────────┬────────────────────────┘
                            │ WAL stream (continuous, ~ms lag)
               ┌────────────▼────────────┐
               │    postgres-replica     │
               │  read fallback only     │
               └─────────────────────────┘
```

### Request flow

1. Client hits **nginx :80** — the only exposed entry point
2. nginx round-robins HTTP requests across **api-1** and **api-2**
3. Each API replica checks **Redis** for tenant auth (TTL-cached, avoids a DB hit) and enforces rate limits via a Redis sorted-set sliding window
4. All DB reads and writes go to **postgres-primary**; if it's unreachable, read-only queries fall back to **postgres-replica** automatically
5. **Workers** connect directly to postgres-primary — they bypass nginx and Redis entirely, connecting straight to the DB and racing for jobs via `FOR UPDATE SKIP LOCKED`
6. On every job status change, workers fire `pg_notify('job_status_change')` → both API replicas independently LISTEN and receive the event → each broadcasts a `JOB_UPDATE` WebSocket message to its own connected clients

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

To demonstrate horizontal scaling locally:

```bash
# Scale up to 4 workers — they join the claim race immediately
docker compose up --scale worker=4 -d

# Watch all four workers claiming jobs in real time
docker compose logs worker -f | grep "Claimed job"

# Scale back down safely — SIGTERM triggers graceful shutdown
docker compose up --scale worker=1 -d
```

No configuration changes, no coordination protocol, no downtime. This is the same model Kubernetes uses — the HPA just automates the `--scale` decision based on `jobs_pending_gauge`.

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

### 13. Cursor-based pagination instead of offset

`GET /jobs` and `GET /dlq` use cursor-based pagination rather than `LIMIT N OFFSET M`. The cursor encodes the `(created_at, id)` tuple of the last row on the current page as a base64url JSON string. The next page query is:

```sql
WHERE (created_at, id) < ($cursor_ts, $cursor_id)
ORDER BY created_at DESC, id DESC
LIMIT $page_size + 1   -- fetch one extra to detect hasMore without COUNT
```

**Why not offset?** Jobs are inserted continuously. With offset pagination, a new job submitted between page 1 and page 2 shifts all rows down by one — the first row of page 2 would be a duplicate of the last row of page 1. Cursor pagination is immune to concurrent inserts because it uses a stable absolute position, not a relative row count.

**The +1 trick:** Fetching `limit + 1` rows lets us detect whether a next page exists without issuing a separate `COUNT(*)` query, which would require a full index scan.
