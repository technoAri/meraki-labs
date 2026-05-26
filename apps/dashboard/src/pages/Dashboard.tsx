import { useState } from 'react';
import { Link } from 'react-router-dom';
import type { JobStatus, WSMessage } from '@task-queue/shared';
import { useJobs } from '../hooks/useJobs.js';
import { useJobCounts } from '../hooks/useJobCounts.js';
import { useWebSocket } from '../hooks/useWebSocket.js';
import { MetricsBar } from '../components/MetricsBar.js';
import { JobTable } from '../components/JobTable.js';
import { SubmitJobForm } from '../components/SubmitJobForm.js';
import { API_URL, API_KEY } from '../config.js';

const STATUS_TABS = ['all', 'pending', 'running', 'completed', 'failed', 'dead_letter'] as const;
type TabValue = typeof STATUS_TABS[number];

export default function Dashboard() {
  const [activeTab, setActiveTab] = useState<TabValue>('all');
  const [cancelError, setCancelError] = useState<string | null>(null);
  const { jobs, loading, error, refetch, updateJob, hasJob } = useJobs();
  const { counts, refetchCounts } = useJobCounts();

  useWebSocket((msg: WSMessage) => {
    if (msg.type === 'JOB_UPDATE') {
      void refetchCounts();
      if (hasJob(msg.data.id)) {
        updateJob({ id: msg.data.id, status: msg.data.status, updated_at: msg.data.updated_at });
      } else {
        void refetch();
      }
    }
  });

  const handleCancel = async (id: string) => {
    setCancelError(null);
    const res = await fetch(`${API_URL}/jobs/${id}/cancel`, {
      method: 'POST',
      headers: { 'x-api-key': API_KEY },
    });
    if (!res.ok) {
      const body = await res.json().catch(() => ({})) as { error?: string };
      setCancelError(body.error ?? `Cancel failed (HTTP ${res.status})`);
    }
    void refetch();
    void refetchCounts();
  };

  return (
    <div className="min-h-screen bg-gray-100">
      <nav className="bg-white border-b border-gray-200 px-4 sm:px-6 py-3 flex items-center justify-between">
        <h1 className="text-lg font-semibold text-gray-900">Task Queue</h1>
        <Link to="/dlq" className="text-sm text-red-600 hover:text-red-800 font-medium">
          Dead Letter Queue
        </Link>
      </nav>

      <div className="max-w-7xl mx-auto px-4 sm:px-6 py-6 space-y-6">
        {error && (
          <div className="bg-red-50 border border-red-200 text-red-700 rounded-md px-4 py-3 text-sm">{error}</div>
        )}
        {cancelError && (
          <div className="bg-red-50 border border-red-200 text-red-700 rounded-md px-4 py-3 text-sm">{cancelError}</div>
        )}

        <MetricsBar counts={counts} />

        <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
          <div className="lg:col-span-1 bg-white rounded-lg border border-gray-200 p-4">
            <h2 className="text-sm font-semibold text-gray-700 mb-4">Submit Job</h2>
            <SubmitJobForm onSubmitted={() => { void refetch(); void refetchCounts(); }} />
          </div>

          <div className="lg:col-span-2 bg-white rounded-lg border border-gray-200 overflow-hidden">
            <div className="border-b border-gray-200 px-4 flex space-x-1 overflow-x-auto">
              {STATUS_TABS.map((tab) => (
                <button
                  key={tab}
                  onClick={() => setActiveTab(tab)}
                  className={`py-3 px-3 text-sm font-medium border-b-2 whitespace-nowrap transition-colors ${
                    activeTab === tab
                      ? 'border-blue-500 text-blue-600'
                      : 'border-transparent text-gray-500 hover:text-gray-700'
                  }`}
                >
                  {tab.replace('_', ' ')}
                </button>
              ))}
            </div>
            {loading ? (
              <div className="px-4 py-8 text-center text-gray-400 text-sm">Loading…</div>
            ) : (
              <JobTable
                jobs={jobs}
                filterStatus={activeTab as JobStatus | 'all'}
                onCancel={(id) => void handleCancel(id)}
              />
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
