import { useState, Fragment } from 'react';
import type { Job, JobStatus } from '@task-queue/shared';
import { StatusBadge } from './StatusBadge.js';

interface Props {
  jobs: Job[];
  onCancel?: (id: string) => void;
  filterStatus?: JobStatus | 'all';
  hasMore?: boolean;
  loadingMore?: boolean;
  onLoadMore?: () => void;
}

export function JobTable({ jobs, onCancel, filterStatus = 'all', hasMore, loadingMore, onLoadMore }: Props) {
  const [expandedId, setExpandedId] = useState<string | null>(null);
  const filtered = filterStatus === 'all' ? jobs : jobs.filter((j) => j.status === filterStatus);

  return (
    <div className="overflow-x-auto">
      <table className="min-w-full divide-y divide-gray-200 text-sm">
        <thead className="bg-gray-50">
          <tr>
            <th className="px-4 py-3 text-left font-medium text-gray-500 uppercase tracking-wider">ID</th>
            <th className="px-4 py-3 text-left font-medium text-gray-500 uppercase tracking-wider">Status</th>
            <th className="hidden md:table-cell px-4 py-3 text-left font-medium text-gray-500 uppercase tracking-wider">Priority</th>
            <th className="hidden sm:table-cell px-4 py-3 text-left font-medium text-gray-500 uppercase tracking-wider">Attempts</th>
            <th className="hidden sm:table-cell px-4 py-3 text-left font-medium text-gray-500 uppercase tracking-wider">Payload</th>
            <th className="hidden md:table-cell px-4 py-3 text-left font-medium text-gray-500 uppercase tracking-wider">Created</th>
            <th className="sm:hidden px-2 py-3" />
            {onCancel && <th className="px-4 py-3" />}
          </tr>
        </thead>
        <tbody className="bg-white divide-y divide-gray-200">
          {filtered.length === 0 && (
            <tr>
              <td colSpan={10} className="px-4 py-8 text-center text-gray-400">No jobs found</td>
            </tr>
          )}
          {filtered.map((job) => (
            <Fragment key={job.id}>
              <tr className="hover:bg-gray-50">
                <td className="px-4 py-3 font-mono text-xs text-gray-500 max-w-[100px] truncate">{job.id}</td>
                <td className="px-4 py-3"><StatusBadge status={job.status} /></td>
                <td className="hidden md:table-cell px-4 py-3">{job.priority}</td>
                <td className="hidden sm:table-cell px-4 py-3">{job.attempts}/{job.max_attempts}</td>
                <td className="hidden sm:table-cell px-4 py-3 font-mono text-xs max-w-[200px] truncate">
                  {JSON.stringify(job.payload)}
                </td>
                <td className="hidden md:table-cell px-4 py-3 text-gray-500 whitespace-nowrap">
                  {new Date(job.created_at).toLocaleString()}
                </td>
                <td className="sm:hidden px-2 py-3">
                  <button
                    onClick={() => setExpandedId(expandedId === job.id ? null : job.id)}
                    className="text-gray-400 hover:text-gray-600 transition-transform"
                    aria-label="Toggle details"
                  >
                    <svg className={`w-4 h-4 transition-transform ${expandedId === job.id ? 'rotate-180' : ''}`} fill="none" stroke="currentColor" viewBox="0 0 24 24">
                      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 9l-7 7-7-7" />
                    </svg>
                  </button>
                </td>
                {onCancel && (
                  <td className="px-4 py-3">
                    {job.status === 'pending' && (
                      <button
                        onClick={() => onCancel(job.id)}
                        className="text-red-600 hover:text-red-800 text-xs font-medium"
                      >
                        Cancel
                      </button>
                    )}
                  </td>
                )}
              </tr>
              {expandedId === job.id && (
                <tr className="sm:hidden bg-gray-50">
                  <td colSpan={10} className="px-4 py-3 border-t border-gray-100">
                    <dl className="grid grid-cols-2 gap-x-4 gap-y-2 text-xs">
                      <dt className="text-gray-500">Priority</dt>
                      <dd>{job.priority}</dd>
                      <dt className="text-gray-500">Attempts</dt>
                      <dd>{job.attempts} / {job.max_attempts}</dd>
                      <dt className="text-gray-500">Created</dt>
                      <dd>{new Date(job.created_at).toLocaleString()}</dd>
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
      {hasMore && (
        <div className="px-4 py-3 border-t border-gray-200 text-center">
          <button
            onClick={onLoadMore}
            disabled={loadingMore}
            className="text-sm text-blue-600 hover:text-blue-800 font-medium disabled:opacity-50"
          >
            {loadingMore ? 'Loading…' : 'Load more'}
          </button>
        </div>
      )}
    </div>
  );
}
