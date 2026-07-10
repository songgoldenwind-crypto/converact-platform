import { useEffect, useState } from 'react';
import { apiGet } from '../api/client';
import { useAuth } from '../hooks/useAuth';

interface AgentSeat {
  id: string;
  display_name: string;
  user_id: string;
  status: string;
  skills: string[];
  current_call_session_id?: string | null;
  last_heartbeat_at?: string | null;
}

const statusStyles: Record<string, string> = {
  idle: 'bg-green-100 text-green-700',
  busy: 'bg-yellow-100 text-yellow-700',
  offline: 'bg-gray-100 text-gray-500',
};

function formatHeartbeat(iso: string): string {
  const diff = Date.now() - new Date(iso).getTime();
  const seconds = Math.floor(diff / 1000);
  if (seconds < 60) return `${seconds}s ago`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  return `${Math.floor(minutes / 60)}h ago`;
}

export default function AgentSeatsPage() {
  const { tenantId } = useAuth();
  const [agents, setAgents] = useState<AgentSeat[]>([]);
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    apiGet<AgentSeat[]>(`/api/call-center/seats?tenant_id=${tenantId}`)
      .then(setAgents)
      .catch((e) => setError(e.message))
      .finally(() => setLoading(false));
  }, [tenantId]);

  return (
    <div>
      <h2 className="text-lg font-semibold text-gray-900 mb-4">Agent Seats</h2>

      {error && (
        <div className="bg-red-50 border border-red-200 rounded-lg p-4 text-sm text-red-600 mb-4">
          {error}
        </div>
      )}

      <div className="bg-white rounded-lg shadow-sm border border-gray-200 overflow-hidden">
        <table className="w-full">
          <thead>
            <tr className="bg-gray-50 border-b border-gray-200">
              <th className="px-4 py-3 text-left text-xs font-medium text-gray-500 uppercase">Name</th>
              <th className="px-4 py-3 text-left text-xs font-medium text-gray-500 uppercase">Status</th>
              <th className="px-4 py-3 text-left text-xs font-medium text-gray-500 uppercase">Skills</th>
              <th className="px-4 py-3 text-left text-xs font-medium text-gray-500 uppercase">Current Call</th>
              <th className="px-4 py-3 text-left text-xs font-medium text-gray-500 uppercase">Last Heartbeat</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-gray-100">
            {loading ? (
              <tr>
                <td colSpan={5} className="px-4 py-8 text-center text-sm text-gray-400">
                  Loading...
                </td>
              </tr>
            ) : agents.length === 0 ? (
              <tr>
                <td colSpan={5} className="px-4 py-8 text-center text-sm text-gray-400">
                  No agents configured
                </td>
              </tr>
            ) : (
              agents.map((agent) => (
                <tr key={agent.id} className="hover:bg-gray-50 transition-colors">
                  <td className="px-4 py-3 text-sm font-medium text-gray-900">{agent.display_name}</td>
                  <td className="px-4 py-3">
                    <span
                      className={`inline-block px-2 py-0.5 rounded text-xs font-medium ${
                        statusStyles[agent.status] ?? 'bg-gray-100 text-gray-500'
                      }`}
                    >
                      {agent.status}
                    </span>
                  </td>
                  <td className="px-4 py-3 text-sm text-gray-600">
                    {agent.skills.length > 0 ? agent.skills.join(', ') : '—'}
                  </td>
                  <td className="px-4 py-3 text-sm text-gray-600">
                    {agent.current_call_session_id ?? '—'}
                  </td>
                  <td className="px-4 py-3 text-sm text-gray-400">
                    {agent.last_heartbeat_at ? formatHeartbeat(agent.last_heartbeat_at) : '—'}
                  </td>
                </tr>
              ))
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}
