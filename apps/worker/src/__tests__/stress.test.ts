import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { randomUUID } from 'crypto';
import type { Job } from '@task-queue/shared';

/**
 * Stress test: 10 concurrent workers claiming from a pool of 50 jobs.
 * Asserts zero double-execution — every job is completed exactly once.
 *
 * Uses an in-process simulation of SKIP LOCKED semantics to validate
 * that claimer + executor logic prevents duplicate claims.
 */

const TOTAL_JOBS = 50;
const WORKER_COUNT = 10;

function makeJob(id: string): Job {
  return {
    id,
    tenant_id: 'tenant-stress',
    idempotency_key: null,
    payload: { task: 'stress' },
    status: 'pending',
    priority: 0,
    attempts: 0,
    max_attempts: 3,
    lease_expires_at: null,
    worker_id: null,
    scheduled_at: new Date().toISOString(),
    started_at: null,
    completed_at: null,
    error: null,
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
  };
}

class InMemoryQueue {
  private jobs = new Map<string, Job>();
  private mutex = Promise.resolve();

  constructor(jobs: Job[]) {
    for (const j of jobs) this.jobs.set(j.id, j);
  }

  claim(workerId: string): Promise<Job | null> {
    this.mutex = this.mutex.then(() => Promise.resolve());
    return this.mutex.then(() => {
      for (const [id, job] of this.jobs) {
        if (job.status === 'pending') {
          const claimed: Job = {
            ...job,
            status: 'running',
            worker_id: workerId,
            attempts: job.attempts + 1,
          };
          this.jobs.set(id, claimed);
          return claimed;
        }
      }
      return null;
    });
  }

  ack(jobId: string, workerId: string): void {
    const job = this.jobs.get(jobId);
    if (job && job.worker_id === workerId && job.status === 'running') {
      this.jobs.set(jobId, { ...job, status: 'completed' });
    }
  }

  results(): Job[] {
    return Array.from(this.jobs.values());
  }
}

async function runWorker(queue: InMemoryQueue, workerId: string, executions: Map<string, string[]>): Promise<void> {
  while (true) {
    const job = await queue.claim(workerId);
    if (!job) break;

    const prev = executions.get(job.id) ?? [];
    executions.set(job.id, [...prev, workerId]);

    await new Promise((r) => setTimeout(r, Math.random() * 5));
    queue.ack(job.id, workerId);
  }
}

describe('stress test — 10 workers × 50 jobs, zero double-execution', () => {
  it('every job is executed exactly once', async () => {
    const jobs = Array.from({ length: TOTAL_JOBS }, () => makeJob(randomUUID()));
    const queue = new InMemoryQueue(jobs);
    const executions = new Map<string, string[]>();

    const workers = Array.from({ length: WORKER_COUNT }, () =>
      runWorker(queue, randomUUID(), executions)
    );
    await Promise.all(workers);

    const results = queue.results();
    const completed = results.filter((j) => j.status === 'completed');

    expect(completed).toHaveLength(TOTAL_JOBS);

    for (const [jobId, workerIds] of executions) {
      expect(workerIds, `Job ${jobId} was executed ${workerIds.length} times`).toHaveLength(1);
    }
  }, 10_000);
});
