import { useState, useEffect, useCallback, useRef } from 'react';
import type { Job, JobStatus } from '@task-queue/shared';
import { API_URL, API_KEY } from '../config.js';

export function useJobs(status?: JobStatus) {
  const [jobs, setJobs] = useState<Job[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const jobIdsRef = useRef(new Set<string>());

  const fetchJobs = useCallback(async () => {
    try {
      const url = status ? `${API_URL}/jobs?status=${status}` : `${API_URL}/jobs`;
      const res = await fetch(url, { headers: { 'x-api-key': API_KEY } });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = await res.json() as Job[];
      jobIdsRef.current = new Set(data.map((j) => j.id));
      setJobs(data);
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to fetch jobs');
    } finally {
      setLoading(false);
    }
  }, [status]);

  useEffect(() => { void fetchJobs(); }, [fetchJobs]);

  const hasJob = useCallback((id: string) => jobIdsRef.current.has(id), []);

  const updateJob = useCallback((updated: Partial<Job> & { id: string }) => {
    setJobs((prev) =>
      prev.map((j) => (j.id === updated.id ? { ...j, ...updated } : j))
    );
  }, []);

  const removeJob = useCallback((id: string) => {
    jobIdsRef.current.delete(id);
    setJobs((prev) => prev.filter((j) => j.id !== id));
  }, []);

  return { jobs, loading, error, refetch: fetchJobs, updateJob, removeJob, hasJob };
}
