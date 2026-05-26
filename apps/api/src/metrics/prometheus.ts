import { Registry, Counter, Gauge } from 'prom-client';

export const registry = new Registry();

// Only metrics the API process actually increments.
// Execution metrics (completed, failed, dlq, duration, lease renewals) live in the worker.

export const jobsSubmittedTotal = new Counter({
  name: 'jobs_submitted_total',
  help: 'Total number of jobs submitted',
  labelNames: ['tenant_id'],
  registers: [registry],
});

export const jobsPendingGauge = new Gauge({
  name: 'jobs_pending_gauge',
  help: 'Pending job delta tracked by this process (sum across api+worker for true count)',
  labelNames: ['tenant_id'],
  registers: [registry],
});
