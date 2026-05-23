import type { Job, JobStatus } from '@task-queue/shared';
import { StatusBadge } from './StatusBadge.js';

interface Props {
  jobs: Job[];
  onCancel?: (id: string) => void;
  filterStatus?: JobStatus | 'all';
}

export function JobTable({ jobs, onCancel, filterStatus = 'all' }: Props) {
  const filtered = filterStatus === 'all' ? jobs : jobs.filter((j) => j.status === filterStatus);

  return (
    <div className="overflow-x-auto">
      <table className="min-w-full divide-y divide-gray-200 text-sm">
        <thead className="bg-gray-50">
          <tr>
            <th className="px-4 py-3 text-left font-medium text-gray-500 uppercase tracking-wider">ID</th>
            <th className="px-4 py-3 text-left font-medium text-gray-500 uppercase tracking-wider">Status</th>
            <th className="px-4 py-3 text-left font-medium text-gray-500 uppercase tracking-wider">Priority</th>
            <th className="px-4 py-3 text-left font-medium text-gray-500 uppercase tracking-wider">Attempts</th>
            <th className="px-4 py-3 text-left font-medium text-gray-500 uppercase tracking-wider">Payload</th>
            <th className="px-4 py-3 text-left font-medium text-gray-500 uppercase tracking-wider">Created</th>
            {onCancel && <th className="px-4 py-3" />}
          </tr>
        </thead>
        <tbody className="bg-white divide-y divide-gray-200">
          {filtered.length === 0 && (
            <tr>
              <td colSpan={7} className="px-4 py-8 text-center text-gray-400">No jobs found</td>
            </tr>
          )}
          {filtered.map((job) => (
            <tr key={job.id} className="hover:bg-gray-50">
              <td className="px-4 py-3 font-mono text-xs text-gray-500 max-w-[120px] truncate">{job.id}</td>
              <td className="px-4 py-3"><StatusBadge status={job.status} /></td>
              <td className="px-4 py-3">{job.priority}</td>
              <td className="px-4 py-3">{job.attempts}/{job.max_attempts}</td>
              <td className="px-4 py-3 font-mono text-xs max-w-[200px] truncate">
                {JSON.stringify(job.payload)}
              </td>
              <td className="px-4 py-3 text-gray-500 whitespace-nowrap">
                {new Date(job.created_at).toLocaleString()}
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
          ))}
        </tbody>
      </table>
    </div>
  );
}
