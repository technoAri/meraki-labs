import type { JobCounts } from '../hooks/useJobCounts.js';

interface Props {
  counts: JobCounts;
}

export function MetricsBar({ counts }: Props) {
  return (
    <div className="grid grid-cols-2 sm:grid-cols-5 gap-3 mb-6">
      <Tile label="Pending" count={counts.pending} color="bg-gray-50 border-gray-200 text-gray-700" />
      <Tile label="Running" count={counts.running} color="bg-blue-50 border-blue-200 text-blue-700" />
      <Tile label="Completed" count={counts.completed} color="bg-green-50 border-green-200 text-green-700" />
      <Tile label="Failed" count={counts.failed} color="bg-orange-50 border-orange-200 text-orange-700" />
      <Tile label="Dead Letter" count={counts.dead_letter} color="bg-red-50 border-red-200 text-red-700" />
    </div>
  );
}

function Tile({ label, count, color }: { label: string; count: number; color: string }) {
  return (
    <div className={`border rounded-lg p-4 ${color}`}>
      <div className="text-2xl font-bold">{count}</div>
      <div className="text-sm font-medium mt-1">{label}</div>
    </div>
  );
}
