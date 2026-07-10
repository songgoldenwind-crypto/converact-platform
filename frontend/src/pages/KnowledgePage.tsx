import { useCallback, useEffect, useState } from 'react';
import { apiGet, apiPost } from '../api/client';
import { useAuth } from '../hooks/useAuth';

interface KnowledgeBase {
  id: string;
  name: string;
  description: string | null;
}

interface KnowledgeDocument {
  id: string;
  title: string;
  content: string;
  content_type: string;
}

export default function KnowledgePage() {
  const { tenantId } = useAuth();
  const [bases, setBases] = useState<KnowledgeBase[]>([]);
  const [selectedBaseId, setSelectedBaseId] = useState('');
  const [documents, setDocuments] = useState<KnowledgeDocument[]>([]);
  const [newBaseName, setNewBaseName] = useState('');
  const [newDocTitle, setNewDocTitle] = useState('');
  const [newDocContent, setNewDocContent] = useState('');
  const [searchQuery, setSearchQuery] = useState('');
  const [searchAnswer, setSearchAnswer] = useState('');
  const [analytics, setAnalytics] = useState<{
    total_queries: number;
    hit_rate: number;
    top_queries: Array<{ query: string; count: number }>;
    content_gaps: Array<{ query: string; miss_count: number }>;
  } | null>(null);
  const [error, setError] = useState('');

  const loadBases = useCallback(async () => {
    const rows = await apiGet<KnowledgeBase[]>(`/api/knowledge/bases?tenant_id=${tenantId}`);
    setBases(rows);
    if (!selectedBaseId && rows[0]) setSelectedBaseId(rows[0].id);
  }, [tenantId, selectedBaseId]);

  const loadDocuments = useCallback(async () => {
    if (!selectedBaseId) return;
    const rows = await apiGet<KnowledgeDocument[]>(`/api/knowledge/bases/${selectedBaseId}/documents`);
    setDocuments(rows);
  }, [selectedBaseId]);

  useEffect(() => {
    void loadBases().catch((e) => setError(e instanceof Error ? e.message : '加载失败'));
  }, [loadBases]);

  useEffect(() => {
    void loadDocuments().catch(() => undefined);
  }, [loadDocuments]);

  useEffect(() => {
    void apiGet<typeof analytics>(`/api/knowledge/analytics?tenant_id=${tenantId}`)
      .then(setAnalytics)
      .catch(() => undefined);
  }, [tenantId]);

  async function createBase() {
    if (!newBaseName.trim()) return;
    await apiPost('/api/knowledge/bases', {
      tenant_id: tenantId,
      name: newBaseName.trim()
    });
    setNewBaseName('');
    await loadBases();
  }

  async function addDocument() {
    if (!selectedBaseId || !newDocTitle.trim() || !newDocContent.trim()) return;
    await apiPost(`/api/knowledge/bases/${selectedBaseId}/documents`, {
      tenant_id: tenantId,
      title: newDocTitle.trim(),
      content: newDocContent.trim()
    });
    setNewDocTitle('');
    setNewDocContent('');
    await loadDocuments();
  }

  async function askKnowledge() {
    if (!searchQuery.trim()) return;
    const result = await apiPost<{ data: { answer: string } }>('/api/knowledge/ask', {
      tenant_id: tenantId,
      question: searchQuery.trim(),
      knowledge_base_id: selectedBaseId || undefined
    });
    setSearchAnswer(result.data?.answer || '未找到答案');
  }

  return (
    <div className="max-w-5xl space-y-6">
      <h2 className="text-lg font-semibold text-gray-900">知识库</h2>
      {error && <p className="text-sm text-red-600">{error}</p>}

      <div className="bg-white border border-gray-200 rounded-lg p-4 flex flex-wrap gap-2 items-end">
        <input
          value={newBaseName}
          onChange={(e) => setNewBaseName(e.target.value)}
          placeholder="新知识库名称"
          className="border border-gray-300 rounded-md px-3 py-2 text-sm flex-1 min-w-[200px]"
        />
        <button type="button" onClick={() => void createBase()} className="bg-blue-600 text-white px-4 py-2 rounded-md text-sm">
          创建知识库
        </button>
      </div>

      <div className="flex gap-4 items-center">
        <label className="text-sm text-gray-600">当前知识库</label>
        <select
          value={selectedBaseId}
          onChange={(e) => setSelectedBaseId(e.target.value)}
          className="border border-gray-300 rounded-md px-3 py-2 text-sm"
        >
          {bases.map((base) => (
            <option key={base.id} value={base.id}>
              {base.name}
            </option>
          ))}
        </select>
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
        <div className="bg-white border border-gray-200 rounded-lg p-4 space-y-3">
          <h3 className="font-medium text-gray-800">文档列表</h3>
          {documents.map((doc) => (
            <div key={doc.id} className="border-b border-gray-100 pb-2">
              <p className="font-medium text-sm">{doc.title}</p>
              <p className="text-xs text-gray-500 line-clamp-2">{doc.content}</p>
            </div>
          ))}
          {!documents.length && <p className="text-sm text-gray-400">暂无文档</p>}
        </div>

        <div className="bg-white border border-gray-200 rounded-lg p-4 space-y-3">
          <h3 className="font-medium text-gray-800">添加文档</h3>
          <input
            value={newDocTitle}
            onChange={(e) => setNewDocTitle(e.target.value)}
            placeholder="标题"
            className="w-full border border-gray-300 rounded-md px-3 py-2 text-sm"
          />
          <textarea
            value={newDocContent}
            onChange={(e) => setNewDocContent(e.target.value)}
            placeholder="内容"
            rows={5}
            className="w-full border border-gray-300 rounded-md px-3 py-2 text-sm"
          />
          <button type="button" onClick={() => void addDocument()} className="bg-blue-600 text-white px-4 py-2 rounded-md text-sm">
            保存文档
          </button>
        </div>
      </div>

      <div className="bg-white border border-gray-200 rounded-lg p-4 space-y-3">
        <h3 className="font-medium text-gray-800">智能问答测试</h3>
        <div className="flex gap-2">
          <input
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
            placeholder="输入客户问题…"
            className="flex-1 border border-gray-300 rounded-md px-3 py-2 text-sm"
          />
          <button type="button" onClick={() => void askKnowledge()} className="border border-gray-300 px-4 py-2 rounded-md text-sm">
            查询
          </button>
        </div>
        {searchAnswer && <p className="text-sm text-gray-700 bg-gray-50 rounded-md p-3">{searchAnswer}</p>}
      </div>

      {analytics && (
        <div className="bg-white border rounded-lg p-4 space-y-2">
          <h3 className="font-medium text-sm">使用分析（30天）</h3>
          <p className="text-sm text-gray-600">
            查询 {analytics.total_queries} 次 · 命中率 {(analytics.hit_rate * 100).toFixed(1)}%
          </p>
          {analytics.content_gaps.length > 0 && (
            <div className="text-xs text-amber-700">
              内容缺口：{analytics.content_gaps.slice(0, 3).map((g) => g.query).join('、')}
            </div>
          )}
        </div>
      )}
    </div>
  );
}
