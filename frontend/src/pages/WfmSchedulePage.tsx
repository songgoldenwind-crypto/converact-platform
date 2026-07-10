import { useCallback, useEffect, useState } from 'react';
import { apiGet, apiPost, apiPut } from '../api/client';
import { useAuth } from '../hooks/useAuth';

interface ScheduleRow {
  id: string;
  agent_seat_id: string;
  shift_start: string;
  shift_end: string;
  status: string;
}

interface AdherenceRow {
  seat_id: string;
  display_name: string;
  scheduled: boolean;
  shift_start: string | null;
  shift_end: string | null;
  actual_status: string;
  adherent: boolean;
  deviation_minutes: number;
}

interface ShiftSwap {
  id: string;
  requester_seat_id: string;
  reason: string;
  status: string;
}

export default function WfmSchedulePage() {
  const { tenantId } = useAuth();
  const [date, setDate] = useState(new Date().toISOString().slice(0, 10));
  const [schedules, setSchedules] = useState<ScheduleRow[]>([]);
  const [adherence, setAdherence] = useState<AdherenceRow[]>([]);
  const [swaps, setSwaps] = useState<ShiftSwap[]>([]);
  const [error, setError] = useState('');

  const load = useCallback(async () => {
    const [schedRows, adhRows, swapRows] = await Promise.all([
      apiGet<ScheduleRow[]>(`/api/wfm/schedules?tenant_id=${tenantId}&date=${date}`),
      apiGet<AdherenceRow[]>(`/api/wfm/adherence?tenant_id=${tenantId}&date=${date}`),
      apiGet<ShiftSwap[]>(`/api/wfm/shift-swaps?tenant_id=${tenantId}`)
    ]);
    setSchedules(schedRows);
    setAdherence(adhRows);
    setSwaps(swapRows);
  }, [tenantId, date]);

  useEffect(() => {
    void load().catch((e) => setError(e.message));
  }, [load]);

  async function generateSchedule() {
    await apiPost('/api/wfm/schedule', { tenant_id: tenantId, target_date: date });
    await load();
  }

  async function moveShift(scheduleId: string, shift_start: string, shift_end: string) {
    await apiPut(`/api/wfm/schedules/${scheduleId}`, { shift_start, shift_end });
    await load();
  }

  return (
    <div className="max-w-5xl space-y-6">
      <div className="flex items-center justify-between">
        <h2 className="text-lg font-semibold text-gray-900">WFM 排班</h2>
        <input
          type="date"
          value={date}
          onChange={(e) => setDate(e.target.value)}
          className="border border-gray-300 rounded-md px-3 py-2 text-sm"
        />
      </div>
      {error && <p className="text-sm text-red-600">{error}</p>}

      <div className="flex gap-2">
        <button type="button" onClick={() => void generateSchedule()} className="bg-blue-600 text-white px-4 py-2 rounded-md text-sm">
          自动生成排班
        </button>
      </div>

      <div className="bg-white border border-gray-200 rounded-lg overflow-hidden">
        <table className="w-full text-sm">
          <thead className="bg-gray-50 text-gray-600">
            <tr>
              <th className="text-left px-4 py-2">坐席</th>
              <th className="text-left px-4 py-2">班次</th>
              <th className="text-left px-4 py-2">状态</th>
              <th className="text-left px-4 py-2">遵守度</th>
              <th className="text-left px-4 py-2">调整</th>
            </tr>
          </thead>
          <tbody>
            {adherence.map((row) => {
              const sched = schedules.find((s) => s.agent_seat_id === row.seat_id);
              return (
                <tr key={row.seat_id} className="border-t border-gray-100">
                  <td className="px-4 py-2">{row.display_name}</td>
                  <td className="px-4 py-2">
                    {row.shift_start && row.shift_end ? `${row.shift_start}–${row.shift_end}` : '—'}
                  </td>
                  <td className="px-4 py-2">{row.actual_status}</td>
                  <td className={`px-4 py-2 ${row.adherent ? 'text-green-600' : 'text-red-600'}`}>
                    {row.adherent ? '合规' : `偏差 ${row.deviation_minutes}m`}
                  </td>
                  <td className="px-4 py-2">
                    {sched && (
                      <button
                        type="button"
                        className="text-blue-600 text-xs"
                        onClick={() => void moveShift(sched.id, '10:00', '18:00')}
                      >
                        拖至 10–18
                      </button>
                    )}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>

      <div className="bg-white border border-gray-200 rounded-lg p-4">
        <h3 className="font-medium mb-3">换班申请</h3>
        <ul className="space-y-2 text-sm">
          {swaps.map((swap) => (
            <li key={swap.id} className="flex justify-between border-b border-gray-100 pb-2">
              <span>{swap.requester_seat_id} — {swap.reason}</span>
              <span className="text-gray-500">{swap.status}</span>
            </li>
          ))}
          {!swaps.length && <li className="text-gray-400">暂无申请</li>}
        </ul>
      </div>
    </div>
  );
}
