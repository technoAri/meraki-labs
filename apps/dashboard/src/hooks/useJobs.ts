import { useState, useEffect, useCallback, useRef } from 'react';
import type { Job, JobStatus } from '@task-queue/shared';
import { API_URL, API_KEY } from '../config.js';

interface PagedResponse {
  data: Job[];
  nextCursor: string | null;
}

export function useJobs(status?: JobStatus) {
  const [jobs, setJobs] = useState<Job[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const jobIdsRef = useRef(new Set<string>());

  const fetchPage = useCallback(async (cursor?: string, append = false) => {
    if (append) setLoadingMore(true); else setLoading(true);
    try {
      const params = new URLSearchParams();
      if (status) params.set('status', status);
      if (cursor) params.set('cursor', cursor);
      const qs = params.toString();
      const url = `${API_URL}/jobs${qs ? `?${qs}` : ''}`;
      const res = await fetch(url, { headers: { 'x-api-key': API_KEY } });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const { data, nextCursor: nc } = await res.json() as PagedResponse;

      if (append) {
        setJobs((prev) => {
          const fresh = data.filter((j) => !jobIdsRef.current.has(j.id));
          fresh.forEach((j) => jobIdsRef.current.add(j.id));
          return [...prev, ...fresh];
        });
      } else {
        jobIdsRef.current = new Set(data.map((j) => j.id));
        setJobs(data);
      }
      setNextCursor(nc);
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to fetch jobs');
    } finally {
      if (append) setLoadingMore(false); else setLoading(false);
    }
  }, [status]);

  useEffect(() => { void fetchPage(); }, [fetchPage]);

  const refetch = useCallback(() => fetchPage(), [fetchPage]);
  const loadMore = useCallback(() => {
    if (nextCursor) void fetchPage(nextCursor, true);
  }, [fetchPage, nextCursor]);

  const hasJob = useCallback((id: string) => jobIdsRef.current.has(id), []);

  const updateJob = useCallback((updated: Partial<Job> & { id: string }) => {
    setJobs((prev) => prev.map((j) => (j.id === updated.id ? { ...j, ...updated } : j)));
  }, []);

  const removeJob = useCallback((id: string) => {
    jobIdsRef.current.delete(id);
    setJobs((prev) => prev.filter((j) => j.id !== id));
  }, []);

  return {
    jobs, loading, loadingMore, error,
    hasMore: nextCursor !== null,
    refetch, loadMore, updateJob, removeJob, hasJob,
  };
}
