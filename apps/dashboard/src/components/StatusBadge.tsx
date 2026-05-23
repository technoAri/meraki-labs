import type { JobStatus } from '@task-queue/shared';

const statusStyles: Record<JobStatus, string> = {
  pending: 'bg-gray-100 text-gray-700',
  running: 'bg-blue-100 text-blue-700',
  completed: 'bg-green-100 text-green-700',
  failed: 'bg-orange-100 text-orange-700',
  dead_letter: 'bg-red-100 text-red-700',
};

export function StatusBadge({ status }: { status: JobStatus }) {
  return (
    <span className={`inline-flex items-center px-2.5 py-0.5 rounded-full text-xs font-medium ${statusStyles[status]}`}>
      {status.replace('_', ' ')}
    </span>
  );
}
