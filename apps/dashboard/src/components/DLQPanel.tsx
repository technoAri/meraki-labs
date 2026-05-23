import { useState } from 'react';
import type { Job } from '@task-queue/shared';
import { StatusBadge } from './StatusBadge.js';
import { API_KEY } from '../main.js';

const API_URL = import.meta.env.VITE_API_URL ?? 'http://localhost:3000';

interface Props {
  jobs: Job[];
  onRetried: () => void;
}

export function DLQPanel({ jobs, onRetried }: Props) {
  const [retryingId, setRetryingId] = useState<string | null>(null);
  const [retryError, setRetryError] = useState<string | null>(null);

  const handleRetry = async (id: string) => {
    setRetryingId(id);
    setRetryError(null);
    try {
      const res = await fetch(`${API_URL}/dlq/${id}/retry`, {
        method: 'POST',
        headers: { 'x-api-key': API_KEY },
      });
      if (!res.ok) {
        const body = await res.json().catch(() => ({})) as { error?: string };
        setRetryError(body.error ?? `Retry failed (HTTP ${res.status})`);
        return;
      }
      onRetried();
    } catch {
      setRetryError('Network error — retry failed');
    } finally {
      setRetryingId(null);
    }
  };

  return (
    <div>
      {retryError && (
        <div className="px-4 py-3 bg-red-50 border-b border-red-200 text-red-700 text-sm">{retryError}</div>
      )}
    <div className="overflow-x-auto">
      <table className="min-w-full divide-y divide-gray-200 text-sm">
        <thead className="bg-gray-50">
          <tr>
            <th className="px-4 py-3 text-left font-medium text-gray-500 uppercase tracking-wider">ID</th>
            <th className="px-4 py-3 text-left font-medium text-gray-500 uppercase tracking-wider">Status</th>
            <th className="px-4 py-3 text-left font-medium text-gray-500 uppercase tracking-wider">Attempts</th>
            <th className="px-4 py-3 text-left font-medium text-gray-500 uppercase tracking-wider">Error</th>
            <th className="px-4 py-3 text-left font-medium text-gray-500 uppercase tracking-wider">Updated</th>
            <th className="px-4 py-3" />
          </tr>
        </thead>
        <tbody className="bg-white divide-y divide-gray-200">
          {jobs.length === 0 && (
            <tr>
              <td colSpan={6} className="px-4 py-8 text-center text-gray-400">No dead letter jobs</td>
            </tr>
          )}
          {jobs.map((job) => (
            <tr key={job.id} className="hover:bg-gray-50">
              <td className="px-4 py-3 font-mono text-xs text-gray-500 max-w-[120px] truncate">{job.id}</td>
              <td className="px-4 py-3"><StatusBadge status={job.status} /></td>
              <td className="px-4 py-3">{job.attempts}/{job.max_attempts}</td>
              <td className="px-4 py-3 text-red-600 text-xs max-w-[200px] truncate">{job.error ?? '—'}</td>
              <td className="px-4 py-3 text-gray-500 whitespace-nowrap">
                {new Date(job.updated_at).toLocaleString()}
              </td>
              <td className="px-4 py-3">
                <button
                  onClick={() => void handleRetry(job.id)}
                  disabled={retryingId === job.id}
                  className="text-blue-600 hover:text-blue-800 text-xs font-medium disabled:opacity-50"
                >
                  {retryingId === job.id ? 'Retrying…' : 'Retry'}
                </button>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
    </div>
  );
}
