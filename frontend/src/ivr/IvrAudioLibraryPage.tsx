import { useEffect, useState } from 'react';

interface AudioEntry {
  id: string;
  scope: 'public' | 'enterprise';
  name: string;
  description?: string;
  entry_type: 'tts' | 'audio_file' | 'audio_var';
  tts_text?: string;
  audio_url?: string;
  language?: string;
}


export default function IvrAudioLibraryPage() {
  const [entries, setEntries] = useState<AudioEntry[]>([]);
  const [loading, setLoading] = useState(true);

  async function load() {
    setLoading(true);
    try {
      const res = await fetch('/api/ivr/audio-library');
      const json = await res.json();
      setEntries(json.data || []);
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => { void load(); }, []);

  async function createEntry() {
    const name = prompt('语音条目名称', '欢迎语');
    if (!name) return;
    const tts_text = prompt('TTS 文本', '欢迎致电') || '';
    await fetch('/api/ivr/audio-library', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        name,
        scope: 'enterprise',
        entry_type: 'tts',
        tts_text,
        language: 'zh',
      }),
    });
    void load();
  }

  async function remove(id: string) {
    if (!confirm('确认删除？')) return;
    await fetch(`/api/ivr/audio-library/${id}`, { method: 'DELETE' });
    void load();
  }

  return (
    <div className="max-w-4xl space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h2 className="text-lg font-semibold text-gray-900">IVR 语音库</h2>
          <p className="text-sm text-gray-500">Play 节点可从此库选择语音素材</p>
        </div>
        <button type="button" onClick={() => void createEntry()} className="text-sm bg-blue-600 text-white px-4 py-2 rounded-md">+ 新建条目</button>
      </div>

      {loading ? (
        <p className="text-sm text-gray-400">加载中…</p>
      ) : (
        <div className="bg-white border border-gray-200 rounded-lg overflow-hidden">
          <table className="w-full text-sm">
            <thead className="bg-gray-50 border-b">
              <tr>
                <th className="text-left px-4 py-2 text-gray-600">名称</th>
                <th className="text-left px-4 py-2 text-gray-600">类型</th>
                <th className="text-left px-4 py-2 text-gray-600">内容</th>
                <th className="text-right px-4 py-2 text-gray-600">操作</th>
              </tr>
            </thead>
            <tbody>
              {entries.map((e) => (
                <tr key={e.id} className="border-b border-gray-50">
                  <td className="px-4 py-2">{e.name}</td>
                  <td className="px-4 py-2 text-gray-500">{e.entry_type}</td>
                  <td className="px-4 py-2 text-gray-500 truncate max-w-xs">{e.tts_text || e.audio_url || '—'}</td>
                  <td className="px-4 py-2 text-right">
                    {e.scope === 'enterprise' && (
                      <button type="button" onClick={() => void remove(e.id)} className="text-xs text-red-500">删除</button>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
