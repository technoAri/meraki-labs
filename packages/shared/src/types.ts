export type JobStatus = 'pending' | 'running' | 'completed' | 'failed' | 'dead_letter';

export type Json = string | number | boolean | null | Json[] | { [key: string]: Json };

export interface Tenant {
  id: string;
  name: string;
  api_key: string;
  rate_limit_per_minute: number;
  max_concurrent_jobs: number;
  created_at: string;
}

export interface Job {
  id: string;
  tenant_id: string;
  idempotency_key: string | null;
  payload: { [key: string]: Json };
  status: JobStatus;
  priority: number;
  attempts: number;
  max_attempts: number;
  lease_expires_at: string | null;
  worker_id: string | null;
  scheduled_at: string;
  started_at: string | null;
  completed_at: string | null;
  error: string | null;
  created_at: string;
  updated_at: string;
}

export interface WSMessage {
  type: 'JOB_UPDATE';
  data: {
    id: string;
    tenant_id: string;
    status: JobStatus;
    updated_at: string;
  };
}
