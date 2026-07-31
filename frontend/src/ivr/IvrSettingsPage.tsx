import { useEffect, useState } from 'react';
import { useIvrReferenceData } from './useIvrReferenceData';

interface HolidayEntry {
  date: string;
  closed: boolean;
}

interface TimeGroup {
  id: string;
  name: string;
  timezone: string;
  schedule: Record<string, [number, number]>;
  holidays?: HolidayEntry[];
}

interface RegionGroup {
  id: string;
  name: string;
  regions: string[];
}

interface GroupCallGroup {
  id: string;
  name: string;
  member_seat_ids: string[];
  strategy: string;
}

type Tab = 'time' | 'region' | 'group_call';

function TimeGroupHolidaysEditor({
  group,
  onSaved,
}: {
  group: TimeGroup;
  onSaved: () => void;
}) {
  const [open, setOpen] = useState(false);
  const [holidays, setHolidays] = useState<HolidayEntry[]>(group.holidays ?? []);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    setHolidays(group.holidays ?? []);
  }, [group.id, group.holidays]);

  async function save() {
    setSaving(true);
    try {
      await fetch('/api/ivr/settings/time-groups', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          id: group.id,
          name: group.name,
          schedule: group.schedule,
          timezone: group.timezone,
          holidays,
        }),
      });
      onSaved();
      setOpen(false);
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="mt-2">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="text-xs text-blue-600"
      >
        {open ? '收起节假日' : '编辑节假日'}
      </button>
      {open && (
        <div className="mt-2 border border-gray-100 rounded-md p-2 space-y-2">
          <p className="text-xs text-gray-500">格式 MM-DD；closed 表示当日闭店</p>
          {holidays.map((h, i) => (
            <div key={i} className="flex gap-2 items-center">
              <input
                className="text-sm border border-gray-300 rounded px-2 py-1 w-24"
                placeholder="10-01"
                value={h.date}
                onChange={(e) => {
                  const next = [...holidays];
                  next[i] = { ...h, date: e.target.value };
                  setHolidays(next);
                }}
              />
              <label className="flex items-center gap-1 text-xs text-gray-600">
                <input
                  type="checkbox"
                  checked={h.closed}
                  onChange={(e) => {
                    const next = [...holidays];
                    next[i] = { ...h, closed: e.target.checked };
                    setHolidays(next);
                  }}
                />
                闭店
              </label>
              <button
                type="button"
                className="text-xs text-red-500"
                onClick={() => setHolidays(holidays.filter((_, j) => j !== i))}
              >
                删
              </button>
            </div>
          ))}
          <div className="flex gap-2">
            <button
              type="button"
              className="text-xs text-blue-600"
              onClick={() => setHolidays([...holidays, { date: '', closed: true }])}
            >
              + 添加
            </button>
            <button
              type="button"
              disabled={saving}
              onClick={() => void save()}
              className="text-xs bg-blue-600 text-white px-2 py-1 rounded disabled:opacity-50"
            >
              {saving ? '保存中…' : '保存节假日'}
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

export default function IvrSettingsPage() {
  const [tab, setTab] = useState<Tab>('time');
  const [timeGroups, setTimeGroups] = useState<TimeGroup[]>([]);
  const [regionGroups, setRegionGroups] = useState<RegionGroup[]>([]);
  const [groupCallGroups, setGroupCallGroups] = useState<GroupCallGroup[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const { seats } = useIvrReferenceData();

  async function loadAll() {
    setLoading(true);
    setError('');
    try {
      const [tg, rg, gc] = await Promise.all([
        fetch('/api/ivr/settings/time-groups').then((r) => r.json()),
        fetch('/api/ivr/settings/region-groups').then((r) => r.json()),
        fetch('/api/ivr/settings/group-call-groups').then((r) => r.json()),
      ]);
      setTimeGroups(tg.data || []);
      setRegionGroups(rg.data || []);
      setGroupCallGroups(gc.data || []);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => { void loadAll(); }, []);

  async function createTimeGroup() {
    const name = prompt('时间组名称', '工作时间');
    if (!name) return;
    await fetch('/api/ivr/settings/time-groups', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name }),
    });
    void loadAll();
  }

  async function createRegionGroup() {
    const name = prompt('区域组名称', '华东区');
    if (!name) return;
    const regions = prompt('区域列表（逗号分隔）', '上海,江苏,浙江')?.split(',').map((s) => s.trim()).filter(Boolean) || [];
    await fetch('/api/ivr/settings/region-groups', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name, regions }),
    });
    void loadAll();
  }

  async function createGroupCallGroup() {
    const name = prompt('群呼组名称', '值班组');
    if (!name) return;
    await fetch('/api/ivr/settings/group-call-groups', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name, member_seat_ids: [], strategy: 'simultaneous' }),
    });
    void loadAll();
  }

  async function editGroupCallMembers(group: GroupCallGroup) {
    if (!seats.length) {
      alert('暂无可用坐席');
      return;
    }
    const selected = prompt(
      `为「${group.name}」选择成员坐席 ID（逗号分隔）\n可用: ${seats.map((s) => s.id).join(', ')}`,
      group.member_seat_ids.join(',')
    );
    if (selected === null) return;
    const member_seat_ids = selected.split(',').map((s) => s.trim()).filter(Boolean);
    await fetch('/api/ivr/settings/group-call-groups', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ id: group.id, name: group.name, member_seat_ids, strategy: group.strategy }),
    });
    void loadAll();
  }

  async function remove(path: string) {
    if (!confirm('确认删除？')) return;
    await fetch(path, { method: 'DELETE' });
    void loadAll();
  }

  const tabs: { id: Tab; label: string }[] = [
    { id: 'time', label: '时间组' },
    { id: 'region', label: '区域组' },
    { id: 'group_call', label: '群呼组' },
  ];

  return (
    <div className="max-w-4xl space-y-6">
      <div>
        <h2 className="text-lg font-semibold text-gray-900">IVR 设置</h2>
        <p className="text-sm text-gray-500">时间组、区域组、群呼组 — 供 IVR 节点引用</p>
      </div>

      <div className="flex gap-2 border-b border-gray-200">
        {tabs.map((t) => (
          <button
            key={t.id}
            type="button"
            onClick={() => setTab(t.id)}
            className={`px-3 py-2 text-sm -mb-px border-b-2 ${tab === t.id ? 'border-blue-600 text-blue-700' : 'border-transparent text-gray-500'}`}
          >
            {t.label}
          </button>
        ))}
      </div>

      {error && <div className="bg-red-50 border border-red-200 rounded-lg p-3 text-sm text-red-600">{error}</div>}
      {loading ? (
        <p className="text-sm text-gray-400">加载中…</p>
      ) : (
        <>
          {tab === 'time' && (
            <section className="space-y-3">
              <button type="button" onClick={() => void createTimeGroup()} className="text-sm bg-blue-600 text-white px-3 py-1.5 rounded-md">+ 新建时间组</button>
              {timeGroups.map((g) => (
                <div key={g.id} className="bg-white border border-gray-200 rounded-lg p-4 flex justify-between items-start">
                  <div className="flex-1">
                    <p className="font-medium text-gray-800">{g.name}</p>
                    <p className="text-xs text-gray-400 mt-1">ID: {g.id} · {g.timezone}</p>
                    {g.holidays?.length ? (
                      <p className="text-xs text-gray-500 mt-1">
                        节假日: {g.holidays.map((h) => `${h.date}${h.closed ? '(闭)' : ''}`).join('、')}
                      </p>
                    ) : (
                      <p className="text-xs text-gray-400 mt-1">暂无节假日配置</p>
                    )}
                    <TimeGroupHolidaysEditor group={g} onSaved={() => void loadAll()} />
                  </div>
                  <button type="button" onClick={() => void remove(`/api/ivr/settings/time-groups/${g.id}`)} className="text-xs text-red-500">删除</button>
                </div>
              ))}
            </section>
          )}
          {tab === 'region' && (
            <section className="space-y-3">
              <button type="button" onClick={() => void createRegionGroup()} className="text-sm bg-blue-600 text-white px-3 py-1.5 rounded-md">+ 新建区域组</button>
              {regionGroups.map((g) => (
                <div key={g.id} className="bg-white border border-gray-200 rounded-lg p-4 flex justify-between">
                  <div>
                    <p className="font-medium text-gray-800">{g.name}</p>
                    <p className="text-xs text-gray-500 mt-1">{g.regions.join('、') || '（无区域）'}</p>
                  </div>
                  <button type="button" onClick={() => void remove(`/api/ivr/settings/region-groups/${g.id}`)} className="text-xs text-red-500">删除</button>
                </div>
              ))}
            </section>
          )}
          {tab === 'group_call' && (
            <section className="space-y-3">
              <button type="button" onClick={() => void createGroupCallGroup()} className="text-sm bg-blue-600 text-white px-3 py-1.5 rounded-md">+ 新建群呼组</button>
              {groupCallGroups.map((g) => (
                <div key={g.id} className="bg-white border border-gray-200 rounded-lg p-4 flex justify-between items-start">
                  <div>
                    <p className="font-medium text-gray-800">{g.name}</p>
                    <p className="text-xs text-gray-400 mt-1">策略: {g.strategy} · 成员: {g.member_seat_ids.join(', ') || '（无）'}</p>
                  </div>
                  <div className="flex gap-2">
                    <button type="button" onClick={() => void editGroupCallMembers(g)} className="text-xs text-blue-600">编辑成员</button>
                    <button type="button" onClick={() => void remove(`/api/ivr/settings/group-call-groups/${g.id}`)} className="text-xs text-red-500">删除</button>
                  </div>
                </div>
              ))}
            </section>
          )}
        </>
      )}
    </div>
  );
}
