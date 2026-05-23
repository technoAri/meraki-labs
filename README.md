# Distributed Task Queue & Job Processing Platform

A production-minded task queue built on PostgreSQL with a Node.js/TypeScript monorepo.

## Quick Start

```bash
docker-compose up --build
```

| Service | URL |
|---|---|
| API | http://localhost:3000 |
| Dashboard | http://localhost:5173 |
| Prometheus | http://localhost:9090 |
| Jaeger (traces) | http://localhost:16686 |

**Test API key:** `test-api-key-1234`

## Example Requests

```bash
# Submit a job
curl -X POST http://localhost:3000/jobs \
  -H "x-api-key: test-api-key-1234" \
  -H "Content-Type: application/json" \
  -d '{"payload": {"task": "send-email", "to": "user@example.com"}, "priority": 5}'

# List jobs
curl http://localhost:3000/jobs -H "x-api-key: test-api-key-1234"

# Get specific job
curl http://localhost:3000/jobs/<id> -H "x-api-key: test-api-key-1234"

# Retry a dead-lettered job
curl -X POST http://localhost:3000/dlq/<id>/retry -H "x-api-key: test-api-key-1234"
```

## Architecture

```
┌──────────┐    HTTP/WS    ┌─────────────┐    SQL (SKIP LOCKED)   ┌────────────┐
│Dashboard │ ────────────► │  Fastify API│ ◄────────────────────► │ PostgreSQL │
└──────────┘               └─────────────┘                         └────────────┘
                                                                         ▲
                           ┌─────────────┐    claim / ack / nack         │
                           │  Worker ×2  │ ────────────────────────────► │
                           └─────────────┘
```

## Trade-offs

### 1. Why PostgreSQL instead of Redis/RabbitMQ?

`FOR UPDATE SKIP LOCKED` gives us row-level locking without a separate broker process. Jobs, tenants, and queue state all live in one durable, ACID-compliant store. Simpler ops, no extra process to monitor, and the data is queryable with plain SQL. The trade-off is that Postgres is not purpose-built for queuing; at very high throughput (100k+ jobs/s) a dedicated broker would win.

### 2. At-least-once vs exactly-once

This system guarantees **at-least-once** delivery. A job that times out before the worker can ack it will be reclaimed and re-executed by another worker. Callers who need exactly-once semantics should supply an `idempotency_key`; the handler must be idempotent itself.

### 3. Lease duration (30 seconds)

30s is a balance: short enough that a crashed worker's jobs are reclaimed quickly (within 30s + stale-lease-check interval of 15s = ≤45s), long enough that a slow job with a healthy heartbeat is not falsely reclaimed. The heartbeat fires every 10s, so a 30s lease has 2+ renewals before it expires.

### 4. In-memory rate limiting trade-off

The sliding window (`Map<tenantId, timestamps[]>`) works correctly for a single API process. If the API is scaled horizontally, each instance maintains its own counter — a tenant could submit `N * rate_limit` requests across N replicas. A production multi-instance deployment would move this counter into Redis (or a DB table) to enforce a global limit.

### 5. Worker autoscaling design

The `jobs_pending_gauge` metric is the natural autoscaling signal. A Kubernetes HPA with a custom metric adapter could watch this gauge and scale worker replicas when `jobs_pending_gauge > threshold` for 60+ seconds. The SKIP LOCKED design makes adding workers safe at any time — new workers immediately participate in the claim race without coordination.

### 6. DLQ strategy

`dead_letter` is a status value in the same `jobs` table, not a separate table or topic. This is simple and avoids an extra schema object for a work-trial scope. In production you'd move dead-lettered rows to a separate table (or a message topic) to prevent the `idx_jobs_claim` partial index from bloating with rows that are never eligible for claiming.

## Running Tests

```bash
pnpm install
pnpm test
```
