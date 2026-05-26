import { useState, Fragment } from 'react';
import type { Job } from '@task-queue/shared';
import { API_URL, API_KEY } from '../config.js';

interface Props {
  jobs: Job[];
  onRetried: () => void;
}

export function DLQPanel({ jobs, onRetried }: Props) {
  const [retryingId, setRetryingId] = useState<string | null>(null);
  const [retryError, setRetryError] = useState<string | null>(null);
  const [expandedId, setExpandedId] = useState<string | null>(null);

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
              <th className="hidden sm:table-cell px-4 py-3 text-left font-medium text-gray-500 uppercase tracking-wider">Attempts</th>
              <th className="px-4 py-3 text-left font-medium text-gray-500 uppercase tracking-wider">Error</th>
              <th className="hidden md:table-cell px-4 py-3 text-left font-medium text-gray-500 uppercase tracking-wider">Updated</th>
              <th className="sm:hidden px-2 py-3" />
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
              <Fragment key={job.id}>
                <tr className="hover:bg-gray-50">
                  <td className="px-4 py-3 font-mono text-xs text-gray-500 max-w-[100px] truncate">{job.id}</td>
                  <td className="hidden sm:table-cell px-4 py-3">{job.attempts}/{job.max_attempts}</td>
                  <td className="px-4 py-3 text-red-600 text-xs max-w-[200px] truncate">{job.error ?? '—'}</td>
                  <td className="hidden md:table-cell px-4 py-3 text-gray-500 whitespace-nowrap">
                    {new Date(job.updated_at).toLocaleString()}
                  </td>
                  <td className="sm:hidden px-2 py-3">
                    <button
                      onClick={() => setExpandedId(expandedId === job.id ? null : job.id)}
                      className="text-gray-400 hover:text-gray-600"
                      aria-label="Toggle details"
                    >
                      <svg className={`w-4 h-4 transition-transform ${expandedId === job.id ? 'rotate-180' : ''}`} fill="none" stroke="currentColor" viewBox="0 0 24 24">
                        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 9l-7 7-7-7" />
                      </svg>
                    </button>
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
                {expandedId === job.id && (
                  <tr className="sm:hidden bg-gray-50">
                    <td colSpan={10} className="px-4 py-3 border-t border-gray-100">
                      <dl className="grid grid-cols-2 gap-x-4 gap-y-2 text-xs">
                        <dt className="text-gray-500">Attempts</dt>
                        <dd>{job.attempts} / {job.max_attempts}</dd>
                        <dt className="text-gray-500">Updated</dt>
                        <dd>{new Date(job.updated_at).toLocaleString()}</dd>
                        <dt className="text-gray-500 col-span-2">Full Error</dt>
                        <dd className="col-span-2 text-red-600 break-all bg-white rounded border border-gray-200 px-2 py-1">
                          {job.error ?? '—'}
                        </dd>
                        <dt className="text-gray-500 col-span-2">Payload</dt>
                        <dd className="col-span-2 font-mono break-all bg-white rounded border border-gray-200 px-2 py-1">
                          {JSON.stringify(job.payload, null, 2)}
                        </dd>
                      </dl>
                    </td>
                  </tr>
                )}
              </Fragment>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
