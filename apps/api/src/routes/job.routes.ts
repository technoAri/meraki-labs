import type { FastifyInstance } from 'fastify';
import type { JobStatus, Json } from '@task-queue/shared';
import { submitJob, getJob, listJobs, cancelJob, getJobCounts } from '../services/job.service.js';

export async function jobRoutes(app: FastifyInstance): Promise<void> {
  app.post('/jobs', async (request, reply) => {
    const body = request.body as {
      payload: { [key: string]: Json };
      priority?: number;
      max_attempts?: number;
      idempotency_key?: string;
      scheduled_at?: string;
    };

    if (!body?.payload || typeof body.payload !== 'object') {
      return reply.code(400).send({ error: 'payload is required and must be an object' });
    }

    const job = await submitJob({
      tenantId: request.tenant.id,
      payload: body.payload,
      priority: body.priority,
      maxAttempts: body.max_attempts,
      idempotencyKey: body.idempotency_key ?? null,
      scheduledAt: body.scheduled_at ? new Date(body.scheduled_at) : undefined,
    });

    return reply.code(201).send(job);
  });

  app.get('/jobs/counts', async (request) => {
    return getJobCounts(request.tenant.id);
  });

  app.get('/jobs', async (request, reply) => {
    const query = request.query as { status?: string };
    const validStatuses: JobStatus[] = ['pending', 'running', 'completed', 'failed', 'dead_letter'];
    const status = query.status as JobStatus | undefined;

    if (status && !validStatuses.includes(status)) {
      return reply.code(400).send({ error: `status must be one of: ${validStatuses.join(', ')}` });
    }

    const jobs = await listJobs(request.tenant.id, status);
    return jobs;
  });

  app.get<{ Params: { id: string } }>('/jobs/:id', async (request, reply) => {
    const job = await getJob(request.params.id, request.tenant.id);
    if (!job) return reply.code(404).send({ error: 'Job not found' });
    return job;
  });

  app.post<{ Params: { id: string } }>('/jobs/:id/cancel', async (request, reply) => {
    const job = await cancelJob(request.params.id, request.tenant.id);
    if (!job) return reply.code(404).send({ error: 'Job not found or not cancellable' });
    return job;
  });
}
