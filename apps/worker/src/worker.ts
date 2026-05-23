import { randomUUID } from 'crypto';
import { sql } from './db.js';
import { claimJob } from './claimer.js';
import { executeJob } from './executor.js';
import { logger } from './logger.js';

const POLL_INTERVAL_MS = Number(process.env.POLL_INTERVAL_MS ?? 500);
const STALE_LEASE_CHECK_INTERVAL_MS = Number(process.env.STALE_LEASE_CHECK_INTERVAL_SECONDS ?? 15) * 1000;
const WORKER_CONCURRENCY = Number(process.env.WORKER_CONCURRENCY ?? 3);

export const workerId = randomUUID();
let running = 0;
let stopped = false;

async function recoverStaleLeases(): Promise<void> {
  const result = await sql`
    UPDATE jobs
    SET status = 'pending', worker_id = NULL, lease_expires_at = NULL, updated_at = NOW()
    WHERE status = 'running' AND lease_expires_at < NOW()
  `;
  if ((result.count ?? 0) > 0) {
    logger.info({ count: result.count }, 'Recovered stale leases');
  }
}

async function getEligibleTenantIds(): Promise<string[]> {
  const rows = await sql<{ id: string }[]>`
    SELECT t.id
    FROM tenants t
    WHERE (
      SELECT COUNT(*) FROM jobs j
      WHERE j.tenant_id = t.id AND j.status = 'running'
    ) < t.max_concurrent_jobs
  `;
  return rows.map((r) => r.id);
}

export async function runWorkerLoop(): Promise<void> {
  logger.info({ workerId }, 'Worker started');

  const staleLeaseTimer = setInterval(recoverStaleLeases, STALE_LEASE_CHECK_INTERVAL_MS);

  while (!stopped) {
    if (running < WORKER_CONCURRENCY) {
      try {
        const eligibleTenantIds = await getEligibleTenantIds();
        const job = await claimJob(workerId, eligibleTenantIds);

        if (job) {
          running++;
          logger.info({ jobId: job.id, tenantId: job.tenant_id }, 'Claimed job');
          executeJob(job, workerId)
            .catch((err) => logger.error({ err, jobId: job.id }, 'Unhandled executor error'))
            .finally(() => { running--; });
        }
      } catch (err) {
        logger.error({ err }, 'Worker loop error');
      }
    }

    await new Promise((resolve) => setTimeout(resolve, POLL_INTERVAL_MS));
  }

  clearInterval(staleLeaseTimer);
  logger.info('Worker stopped');
}

process.on('SIGTERM', () => { stopped = true; });
process.on('SIGINT', () => { stopped = true; });
