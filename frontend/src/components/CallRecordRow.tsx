interface CallRecord {
  id: string;
  phone: string;
  started_at: string;
  duration_seconds: number;
  status: string;
  intent_score?: number;
  qm_score?: number;
}

const statusColors: Record<string, string> = {
  completed: 'bg-green-100 text-green-700',
  in_progress: 'bg-yellow-100 text-yellow-700',
  failed: 'bg-red-100 text-red-700',
  pending: 'bg-gray-100 text-gray-600',
};

function formatDuration(seconds: number): string {
  const m = Math.floor(seconds / 60);
  const s = seconds % 60;
  return `${m}:${String(s).padStart(2, '0')}`;
}

function formatTime(iso: string): string {
  return new Date(iso).toLocaleString();
}

export default function CallRecordRow({
  record,
  onDial
}: {
  record: CallRecord;
  onDial?: (phone: string) => void;
}) {
  const colorClass = statusColors[record.status] ?? 'bg-gray-100 text-gray-600';

  return (
    <tr className="hover:bg-gray-50 transition-colors">
      <td className="px-4 py-3 text-sm text-gray-600">{formatTime(record.started_at)}</td>
      <td className="px-4 py-3 text-sm font-medium text-gray-900">{record.phone}</td>
      <td className="px-4 py-3 text-sm text-gray-600">{formatDuration(record.duration_seconds)}</td>
      <td className="px-4 py-3">
        <span className={`inline-block px-2 py-0.5 rounded text-xs font-medium ${colorClass}`}>
          {record.status}
        </span>
      </td>
      <td className="px-4 py-3 text-sm text-gray-600">{record.intent_score ?? '—'}</td>
      <td className="px-4 py-3 text-sm text-gray-600">{record.qm_score ?? '—'}</td>
      <td className="px-4 py-3">
        {onDial ? (
          <button
            type="button"
            onClick={() => onDial(record.phone)}
            className="text-xs text-blue-500 hover:text-blue-700 font-medium"
          >
            拨号
          </button>
        ) : (
          <button type="button" className="text-xs text-blue-500 hover:text-blue-700 font-medium">
            查看
          </button>
        )}
      </td>
    </tr>
  );
}

export type { CallRecord };
