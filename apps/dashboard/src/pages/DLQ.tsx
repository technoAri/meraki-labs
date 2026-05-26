import { Link } from 'react-router-dom';
import type { WSMessage } from '@task-queue/shared';
import { useJobs } from '../hooks/useJobs.js';
import { useWebSocket } from '../hooks/useWebSocket.js';
import { DLQPanel } from '../components/DLQPanel.js';

export default function DLQ() {
  const { jobs, loading, loadingMore, error, hasMore, refetch, loadMore, removeJob } = useJobs('dead_letter');

  useWebSocket((msg: WSMessage) => {
    if (msg.type === 'JOB_UPDATE') {
      if (msg.data.status === 'dead_letter') {
        void refetch();
      } else {
        removeJob(msg.data.id);
      }
    }
  });

  return (
    <div className="min-h-screen bg-gray-100">
      <nav className="bg-white border-b border-gray-200 px-4 sm:px-6 py-3 flex items-center justify-between">
        <h1 className="text-lg font-semibold text-gray-900">Dead Letter Queue</h1>
        <Link to="/" className="text-sm text-blue-600 hover:text-blue-800 font-medium">
          ← Back to Dashboard
        </Link>
      </nav>

      <div className="max-w-7xl mx-auto px-4 sm:px-6 py-6">
        {error && (
          <div className="bg-red-50 border border-red-200 text-red-700 rounded-md px-4 py-3 text-sm mb-4">{error}</div>
        )}

        <div className="bg-white rounded-lg border border-gray-200 overflow-hidden">
          <div className="px-4 py-3 border-b border-gray-200">
            <h2 className="text-sm font-semibold text-gray-700">
              Failed jobs that exhausted all retry attempts
            </h2>
          </div>
          {loading ? (
            <div className="px-4 py-8 text-center text-gray-400 text-sm">Loading…</div>
          ) : (
            <DLQPanel
              jobs={jobs}
              onRetried={() => void refetch()}
              hasMore={hasMore}
              loadingMore={loadingMore}
              onLoadMore={loadMore}
            />
          )}
        </div>
      </div>
    </div>
  );
}
