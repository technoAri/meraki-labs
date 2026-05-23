import { useState, useEffect, useCallback } from 'react';
import { API_KEY } from '../main.js';

const API_URL = import.meta.env.VITE_API_URL ?? 'http://localhost:3000';

export interface JobCounts {
  pending: number;
  running: number;
  completed: number;
  failed: number;
  dead_letter: number;
}

const ZERO_COUNTS: JobCounts = { pending: 0, running: 0, completed: 0, failed: 0, dead_letter: 0 };

export function useJobCounts() {
  const [counts, setCounts] = useState<JobCounts>(ZERO_COUNTS);

  const fetchCounts = useCallback(async () => {
    try {
      const res = await fetch(`${API_URL}/jobs/counts`, { headers: { 'x-api-key': API_KEY } });
      if (!res.ok) return;
      const data = await res.json() as JobCounts;
      setCounts(data);
    } catch {
      // silently ignore — MetricsBar shows stale counts rather than crashing
    }
  }, []);

  useEffect(() => { void fetchCounts(); }, [fetchCounts]);

  return { counts, refetchCounts: fetchCounts };
}
