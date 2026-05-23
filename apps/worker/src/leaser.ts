import { trace } from '@opentelemetry/api';
import { sql } from './db.js';
import { workerLeaseRenewalsTotal } from './metrics.js';

const tracer = trace.getTracer('worker.leaser');

export async function renewLease(jobId: string, workerId: string): Promise<boolean> {
  return tracer.startActiveSpan('job.lease_renew', async (span) => {
    try {
      const result = await sql`
        UPDATE jobs
        SET lease_expires_at = NOW() + INTERVAL '30 seconds', updated_at = NOW()
        WHERE id = ${jobId} AND worker_id = ${workerId} AND status = 'running'
      `;
      const renewed = (result.count ?? 0) > 0;
      if (renewed) {
        workerLeaseRenewalsTotal.inc({ worker_id: workerId });
      }
      return renewed;
    } finally {
      span.end();
    }
  });
}

export function startLeaseHeartbeat(
  jobId: string,
  workerId: string,
  intervalSeconds: number,
  onStolenCallback: () => void
): NodeJS.Timeout {
  return setInterval(async () => {
    const ok = await renewLease(jobId, workerId);
    if (!ok) {
      onStolenCallback();
    }
  }, intervalSeconds * 1000);
}
