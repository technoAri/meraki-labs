import { Registry, Counter, Gauge, Histogram } from 'prom-client';

export const registry = new Registry();

export const jobsCompletedTotal = new Counter({
  name: 'jobs_completed_total',
  help: 'Total number of jobs completed',
  labelNames: ['tenant_id'],
  registers: [registry],
});

export const jobsFailedTotal = new Counter({
  name: 'jobs_failed_total',
  help: 'Total number of jobs failed',
  labelNames: ['tenant_id'],
  registers: [registry],
});

export const jobsDeadLetteredTotal = new Counter({
  name: 'jobs_dead_lettered_total',
  help: 'Total number of jobs moved to dead letter queue',
  labelNames: ['tenant_id'],
  registers: [registry],
});

export const jobsPendingGauge = new Gauge({
  name: 'jobs_pending_gauge',
  help: 'Current number of pending jobs',
  labelNames: ['tenant_id'],
  registers: [registry],
});

export const jobsRunningGauge = new Gauge({
  name: 'jobs_running_gauge',
  help: 'Current number of running jobs',
  labelNames: ['tenant_id'],
  registers: [registry],
});

export const jobProcessingDurationMs = new Histogram({
  name: 'job_processing_duration_ms',
  help: 'Job processing duration in milliseconds',
  labelNames: ['tenant_id'],
  buckets: [10, 50, 100, 250, 500, 1000, 2500, 5000, 10000],
  registers: [registry],
});

export const workerLeaseRenewalsTotal = new Counter({
  name: 'worker_lease_renewals_total',
  help: 'Total number of worker lease renewals',
  labelNames: ['worker_id'],
  registers: [registry],
});
