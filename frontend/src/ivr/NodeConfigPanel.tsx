import { useEffect, useState } from 'react';
import type { Node } from '@xyflow/react';
import { IVR_NODE_METADATA, type IvrNodeType, type PlayContent, type MenuOption, type ConditionRule, type GlobalShortcut, type VisualMenuItem } from './types';
import { useIvrReferenceData } from './useIvrReferenceData';
import { IVR_BRANCH } from '@converact/shared/ivr/branch-handles';

interface Props {
  node: Node | null;
  nodes: Node[];
  globalShortcuts: GlobalShortcut[];
  onUpdateShortcuts: (shortcuts: GlobalShortcut[]) => void;
  onUpdate: (id: string, data: Record<string, unknown>) => void;
  onDelete: (id: string) => void;
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <label className="block space-y-1">
      <span className="text-xs text-gray-500">{label}</span>
      {children}
    </label>
  );
}

const inputCls = 'w-full text-sm border border-gray-300 rounded-md px-2 py-1.5';

export function NodeConfigPanel({ node, nodes, globalShortcuts, onUpdateShortcuts, onUpdate, onDelete }: Props) {
  if (!node) {
    return (
      <div className="w-72 shrink-0 border-l border-gray-200 bg-white overflow-y-auto">
        <div className="bg-slate-600 text-white px-4 py-2.5 sticky top-0">
          <span className="text-sm font-medium">⚙️ 流程属性</span>
        </div>
        <div className="p-4">
          <GlobalShortcutsEditor shortcuts={globalShortcuts} nodes={nodes} onChange={onUpdateShortcuts} />
        </div>
      </div>
    );
  }

  const type = (node.data as { type: IvrNodeType }).type;
  const meta = IVR_NODE_METADATA[type];
  const data = node.data as Record<string, unknown>;
  const up = (patch: Record<string, unknown>) => onUpdate(node.id, patch);

  return (
    <div className="w-72 shrink-0 border-l border-gray-200 bg-white overflow-y-auto">
      <div className={`${meta.color} text-white px-4 py-2.5 flex items-center justify-between sticky top-0`}>
        <span className="text-sm font-medium">{meta.icon} {meta.label}</span>
        <button
          type="button"
          onClick={() => onDelete(node.id)}
          className="text-xs text-white/70 hover:text-white"
        >
          删除
        </button>
      </div>

      <div className="p-4 space-y-3">
        <Field label="节点名称">
          <input
            className={inputCls}
            value={(data.name as string) || ''}
            onChange={(e) => up({ name: e.target.value })}
          />
        </Field>

        <ConfigForm type={type} data={data} up={up} nodes={nodes} />
      </div>
    </div>
  );
}

function ConfigForm({ type, data, up, nodes }: { type: IvrNodeType; data: Record<string, unknown>; up: (p: Record<string, unknown>) => void; nodes: Node[] }) {
  const refs = useIvrReferenceData();
  switch (type) {
    // --- Traditional ---
    case 'start':
      return <StartConfig data={data} up={up} />;
    case 'play':
      return <PlayConfig data={data} up={up} />;
    case 'flush_audio':
      return (
        <p className="text-xs text-gray-500">
          播完当前音频队列后继续。无配置项；入队由上游 Play 节点完成。
        </p>
      );
    case 'menu':
      return <MenuConfig data={data} up={up} queues={refs.queues} seats={refs.seats} groupCallGroups={refs.groupCallGroups} />;
    case 'collect':
      return <CollectConfig data={data} up={up} />;
    case 'set_var':
      return <SetVarConfig data={data} up={up} />;
    case 'condition':
      return <ConditionConfig data={data} up={up} regionGroups={refs.regionGroups} />;
    case 'time_condition':
      return <TimeConditionConfig data={data} up={up} />;
    case 'queue':
      return <QueueConfig data={data} up={up} />;
    case 'http':
      return <HttpConfig data={data} up={up} />;
    case 'transfer':
      return <TransferConfig data={data} up={up} groupCallGroups={refs.groupCallGroups} />;
    case 'voicemail':
      return <VoicemailConfig data={data} up={up} />;
    case 'sip':
      return <SipConfig data={data} up={up} />;
    case 'disconnect':
      return <DisconnectConfig data={data} up={up} />;
    // --- AI ---
    case 'ai_dialogue':
      return <AiDialogueConfig data={data} up={up} />;
    case 'intent':
      return <IntentConfig data={data} up={up} />;
    case 'knowledge_qa':
      return <KnowledgeQaConfig data={data} up={up} knowledgeBases={refs.knowledgeBases} />;
    case 'avatar_switch':
      return <AvatarSwitchConfig data={data} up={up} />;
    case 'compliance':
      return <ComplianceConfig data={data} up={up} />;
    // --- Video ---
    case 'video_play':
      return <VideoPlayConfig data={data} up={up} />;
    case 'screen_share':
      return <ScreenShareConfig data={data} up={up} />;
    case 'visual_menu':
      return <VisualMenuConfig data={data} up={up} nodes={nodes} />;
    case 'subflow':
      return <SubflowConfig data={data} up={up} flows={refs.flows} />;
    case 'recording':
      return <RecordingConfig data={data} up={up} />;
    case 'webhook':
      return <WebhookConfig data={data} up={up} />;
    default:
      return <p className="text-xs text-gray-400">暂无配置</p>;
  }
}

// --- Reusable sub-forms ---

function GlobalShortcutsEditor({
  shortcuts,
  nodes,
  onChange,
}: {
  shortcuts: GlobalShortcut[];
  nodes: Node[];
  onChange: (next: GlobalShortcut[]) => void;
}) {
  const add = () => {
    onChange([...shortcuts, { digit: '*', action: 'transfer_queue', queueName: 'operator' }]);
  };
  const update = (idx: number, patch: Partial<GlobalShortcut>) => {
    onChange(shortcuts.map((s, i) => (i === idx ? { ...s, ...patch } as GlobalShortcut : s)));
  };
  const remove = (idx: number) => onChange(shortcuts.filter((_, i) => i !== idx));

  return (
    <div className="space-y-3">
      <Field label="全局快捷键">
        <p className="text-xs text-gray-400 mb-2">在菜单/收号等待时优先于节点按键解析</p>
        {shortcuts.length === 0 && (
          <p className="text-xs text-gray-400">暂无快捷键</p>
        )}
        {shortcuts.map((sc, idx) => (
          <div key={idx} className="border border-gray-100 rounded-md p-2 space-y-1.5 mb-2">
            <div className="flex gap-2">
              <input
                className={`${inputCls} w-12`}
                maxLength={1}
                value={sc.digit}
                onChange={(e) => update(idx, { digit: e.target.value })}
                placeholder="#"
              />
              <select
                className={`${inputCls} flex-1`}
                value={sc.action}
                onChange={(e) => {
                  const action = e.target.value as GlobalShortcut['action'];
                  if (action === 'transfer_queue') {
                    update(idx, { action, queueName: 'operator' });
                  } else if (action === 'repeat_last') {
                    update(idx, { action });
                  } else {
                    update(idx, { action, targetNodeId: nodes[0]?.id ?? '' });
                  }
                }}
              >
                <option value="transfer_queue">转队列</option>
                <option value="repeat_last">重播上一提示</option>
                <option value="goto_node">跳转节点</option>
              </select>
              <button type="button" className="text-xs text-red-500" onClick={() => remove(idx)}>删</button>
            </div>
            {sc.action === 'transfer_queue' && (
              <input
                className={inputCls}
                placeholder="队列名"
                value={sc.queueName}
                onChange={(e) => update(idx, { queueName: e.target.value })}
              />
            )}
            {sc.action === 'goto_node' && (
              <>
                <select
                  className={inputCls}
                  value={sc.targetNodeId}
                  onChange={(e) => update(idx, { targetNodeId: e.target.value })}
                >
                  {nodes.map((n) => (
                    <option key={n.id} value={n.id}>
                      {(n.data as { name?: string }).name || n.id}
                    </option>
                  ))}
                </select>
                <label className="flex items-center gap-2 text-xs text-gray-600">
                  <input
                    type="checkbox"
                    checked={!!sc.popSubflow}
                    onChange={(e) => update(idx, { popSubflow: e.target.checked })}
                  />
                  退出子流程栈
                </label>
              </>
            )}
          </div>
        ))}
        <button type="button" onClick={add} className="text-xs text-blue-600 hover:underline">
          + 添加快捷键
        </button>
      </Field>
    </div>
  );
}

function PlayContentsEditor({ contents, up }: { contents: PlayContent[]; up: (p: { contents: PlayContent[] }) => void }) {
  const [audioEntries, setAudioEntries] = useState<Array<{ id: string; name: string; entry_type: string; tts_text?: string; audio_url?: string }>>([]);

  useEffect(() => {
    void fetch('/api/ivr/audio-library')
      .then((r) => r.json())
      .then((json) => setAudioEntries(json.data || []))
      .catch(() => setAudioEntries([]));
  }, []);

  const update = (idx: number, patch: Partial<PlayContent>) => {
    const next = contents.map((c, i) => (i === idx ? { ...c, ...patch } : c));
    up({ contents: next });
  };
  return (
    <div className="space-y-2">
      {contents.map((c, idx) => (
        <div key={idx} className="space-y-1.5 border border-gray-100 rounded-md p-2">
          <select
            className={inputCls}
            value={c.playType}
            onChange={(e) => update(idx, { playType: e.target.value as PlayContent['playType'] })}
          >
            <option value="tts">TTS</option>
            <option value="tts_var">TTS 变量</option>
            <option value="audio">语音文件</option>
            <option value="audio_var">语音变量</option>
          </select>
          {(c.playType === 'tts' || c.playType === 'tts_var') && (
            <>
              <input
                className={inputCls}
                placeholder="TTS 引擎 (ali/cosyvoice)"
                value={c.ttsEngine || ''}
                onChange={(e) => update(idx, { ttsEngine: e.target.value })}
              />
              <textarea
                className={inputCls}
                rows={2}
                placeholder="播放文本 (支持 SSML)"
                value={c.text || ''}
                onChange={(e) => update(idx, { text: e.target.value })}
              />
              {c.playType === 'tts_var' && (
                <input
                  className={inputCls}
                  placeholder="变量名"
                  value={c.variable || ''}
                  onChange={(e) => update(idx, { variable: e.target.value })}
                />
              )}
            </>
          )}
          {(c.playType === 'audio' || c.playType === 'audio_var') && (
            <>
              <select
                className={inputCls}
                value={c.audioLibrary || 'public'}
                onChange={(e) => update(idx, { audioLibrary: e.target.value as 'public' | 'enterprise' })}
              >
                <option value="public">公共语音库</option>
                <option value="enterprise">企业语音库</option>
              </select>
              {audioEntries.length > 0 && (
                <select
                  className={inputCls}
                  value={c.audioFile || ''}
                  onChange={(e) => {
                    const entry = audioEntries.find((a) => a.id === e.target.value);
                    update(idx, {
                      audioFile: e.target.value,
                      text: entry?.tts_text || entry?.name || c.text,
                    });
                  }}
                >
                  <option value="">从语音库选择…</option>
                  {audioEntries.map((a) => (
                    <option key={a.id} value={a.id}>{a.name}</option>
                  ))}
                </select>
              )}
              <input
                className={inputCls}
                placeholder="音频文件 ID 或 URL"
                value={c.audioFile || ''}
                onChange={(e) => update(idx, { audioFile: e.target.value })}
              />
            </>
          )}
          {contents.length > 1 && (
            <button
              type="button"
              onClick={() => up({ contents: contents.filter((_, i) => i !== idx) })}
              className="text-xs text-red-500"
            >
              删除此条
            </button>
          )}
        </div>
      ))}
      <button
        type="button"
        onClick={() => up({ contents: [...contents, { playType: 'tts', ttsEngine: 'ali', text: '' }] })}
        className="text-xs text-blue-600"
      >
        + 添加播放内容
      </button>
    </div>
  );
}

// --- Individual node configs ---

function StartConfig({ data, up }: { data: Record<string, unknown>; up: (p: Record<string, unknown>) => void }) {
  const params = (data.pushParams as Array<{ key: string; source: string }>) || [];
  return (
    <Field label="推送参数">
      <div className="space-y-1">
        {params.map((p, i) => (
          <div key={i} className="flex gap-1">
            <input className={inputCls} placeholder="键" value={p.key} onChange={(e) => { const n = [...params]; n[i] = { ...p, key: e.target.value }; up({ pushParams: n }); }} />
            <input className={inputCls} placeholder="来源变量" value={p.source} onChange={(e) => { const n = [...params]; n[i] = { ...p, source: e.target.value }; up({ pushParams: n }); }} />
          </div>
        ))}
        <button type="button" onClick={() => up({ pushParams: [...params, { key: '', source: '' }] })} className="text-xs text-blue-600">+ 添加参数</button>
      </div>
    </Field>
  );
}

function PlayConfig({ data, up }: { data: Record<string, unknown>; up: (p: Record<string, unknown>) => void }) {
  return (
    <div className="space-y-3">
      <PlayContentsEditor contents={(data.contents as PlayContent[]) || []} up={(p) => up(p)} />
      <label className="flex items-center gap-2 text-sm text-gray-700">
        <input
          type="checkbox"
          checked={data.bargeIn === true}
          onChange={(e) => up({ bargeIn: e.target.checked })}
        />
        允许打断播报（Barge-in）
      </label>
      <Field label="解析失败时">
        <select
          className={inputCls}
          value={(data.onError as string) ?? 'continue'}
          onChange={(e) => up({ onError: e.target.value })}
        >
          <option value="continue">继续播放占位文案</option>
          <option value="branch">走 error 出边（需连线）</option>
        </select>
      </Field>
    </div>
  );
}

function DisconnectConfig({ data, up }: { data: Record<string, unknown>; up: (p: Record<string, unknown>) => void }) {
  return (
    <>
      <Field label="告别音（可选）">
        <PlayContentsEditor contents={(data.contents as PlayContent[]) || []} up={(p) => up(p)} />
      </Field>
      <Field label="结束原因">
        <select
          className={inputCls}
          value={(data.endReason as string) ?? 'completed'}
          onChange={(e) => up({ endReason: e.target.value })}
        >
          <option value="completed">正常完成</option>
          <option value="abandoned">用户放弃</option>
        </select>
      </Field>
    </>
  );
}

const CONDITION_FIELD_PRESETS = [
  { value: 'caller_phone', label: '主叫号码' },
  { value: 'caller_area_code', label: '区号' },
  { value: 'intent_score', label: '意向分' },
  { value: 'kb_result', label: '知识库结果' },
  { value: 'queue_wait_ms', label: '排队时长(ms)' },
  { value: 'last_digit', label: '最后按键' },
] as const;

function MenuConfig({
  data,
  up,
  queues,
  seats,
  groupCallGroups,
}: {
  data: Record<string, unknown>;
  up: (p: Record<string, unknown>) => void;
  queues: Array<{ id: string; name: string }>;
  seats: Array<{ id: string; display_name: string }>;
  groupCallGroups: Array<{ id: string; name: string }>;
}) {
  const options = (data.options as MenuOption[]) || [];

  function routeTargetField(opt: MenuOption, i: number) {
    const patchTarget = (routeTarget: string) => {
      const n = [...options];
      n[i] = { ...opt, routeTarget };
      up({ options: n });
    };
    if (opt.routeType === 'queue' && queues.length > 0) {
      return (
        <select className={`${inputCls} text-xs`} value={opt.routeTarget} onChange={(e) => patchTarget(e.target.value)}>
          <option value="">选择队列…</option>
          {queues.map((q) => <option key={q.id} value={q.name}>{q.name}</option>)}
        </select>
      );
    }
    if (opt.routeType === 'agent' && seats.length > 0) {
      return (
        <select className={`${inputCls} text-xs`} value={opt.routeTarget} onChange={(e) => patchTarget(e.target.value)}>
          <option value="">选择坐席…</option>
          {seats.map((s) => <option key={s.id} value={s.id}>{s.display_name}</option>)}
        </select>
      );
    }
    if (opt.routeType === 'group_call' && groupCallGroups.length > 0) {
      return (
        <select className={`${inputCls} text-xs`} value={opt.routeTarget} onChange={(e) => patchTarget(e.target.value)}>
          <option value="">选择群呼组…</option>
          {groupCallGroups.map((g) => <option key={g.id} value={g.id}>{g.name}</option>)}
        </select>
      );
    }
    if (opt.routeType === 'node') {
      return <span className="text-xs text-gray-400">由画布连线 {IVR_BRANCH.digit(opt.digit)}</span>;
    }
    return (
      <input
        className={`${inputCls} text-xs`}
        placeholder="routeTarget"
        value={opt.routeTarget}
        onChange={(e) => patchTarget(e.target.value)}
      />
    );
  }

  return (
    <div className="space-y-3">
      <Field label="提示语"><PlayContentsEditor contents={(data.prompt as PlayContent[]) || []} up={(p) => up(p)} /></Field>
      <Field label="按键选项">
        <div className="space-y-2">
          {options.map((o, i) => (
            <div key={i} className="border border-gray-100 rounded-md p-2 space-y-1">
              <div className="flex gap-1 items-center">
                <input className="w-8 text-center text-sm border border-gray-300 rounded px-1 py-1" value={o.digit} onChange={(e) => { const n = [...options]; n[i] = { ...o, digit: e.target.value }; up({ options: n }); }} />
                <input className="flex-1 text-sm border border-gray-300 rounded px-1 py-1" placeholder="标签" value={o.label} onChange={(e) => { const n = [...options]; n[i] = { ...o, label: e.target.value }; up({ options: n }); }} />
                <select className="text-xs border border-gray-300 rounded px-1 py-1" value={o.routeType} onChange={(e) => { const n = [...options]; n[i] = { ...o, routeType: e.target.value as MenuOption['routeType'], routeTarget: '' }; up({ options: n }); }}>
                  <option value="node">跳转节点</option>
                  <option value="agent">坐席</option>
                  <option value="queue">队列</option>
                  <option value="extension">分机</option>
                  <option value="group_call">群呼</option>
                </select>
              </div>
              {routeTargetField(o, i)}
            </div>
          ))}
          <button type="button" onClick={() => up({ options: [...options, { digit: String(options.length + 1), label: '', routeType: 'node', routeTarget: '' }] })} className="text-xs text-blue-600">+ 添加按键</button>
        </div>
      </Field>
      <div className="flex gap-2">
        <Field label="超时(秒)"><input type="number" className={inputCls} value={data.timeoutSec as number ?? 5} onChange={(e) => up({ timeoutSec: +e.target.value })} /></Field>
        <Field label="最大重试"><input type="number" className={inputCls} value={data.maxRetries as number ?? 3} onChange={(e) => up({ maxRetries: +e.target.value })} /></Field>
      </div>
      <label className="flex items-center gap-2 text-sm text-gray-700">
        <input
          type="checkbox"
          checked={data.speechEnabled === true}
          onChange={(e) => up({ speechEnabled: e.target.checked })}
        />
        启用语音输入（需生产环境 IVR_SPEECH_PRODUCTION=1）
      </label>
    </div>
  );
}

function CollectConfig({ data, up }: { data: Record<string, unknown>; up: (p: Record<string, unknown>) => void }) {
  return (
    <div className="space-y-3">
      <Field label="提示语"><PlayContentsEditor contents={(data.prompt as PlayContent[]) || []} up={(p) => up(p)} /></Field>
      <div className="flex gap-2">
        <Field label="最小位数"><input type="number" className={inputCls} value={data.minDigits as number ?? 1} onChange={(e) => up({ minDigits: +e.target.value })} /></Field>
        <Field label="最大位数"><input type="number" className={inputCls} value={data.maxDigits as number ?? 6} onChange={(e) => up({ maxDigits: +e.target.value })} /></Field>
      </div>
      <Field label="结束方式">
        <select className={inputCls} value={data.endMode as string ?? 'hash_key'} onChange={(e) => up({ endMode: e.target.value })}>
          <option value="hash_key">按 # 结束</option>
          <option value="max_digits">满最大位数结束</option>
        </select>
      </Field>
      <div className="flex gap-2">
        <Field label="输入等待(秒)"><input type="number" className={inputCls} value={data.inputWaitSec as number ?? 5} onChange={(e) => up({ inputWaitSec: +e.target.value })} /></Field>
        <Field label="超时(秒)"><input type="number" className={inputCls} value={data.timeoutSec as number ?? 10} onChange={(e) => up({ timeoutSec: +e.target.value })} /></Field>
        <Field label="循环次数"><input type="number" className={inputCls} value={data.maxRetries as number ?? 1} onChange={(e) => up({ maxRetries: +e.target.value })} /></Field>
      </div>
      <Field label="存储变量名"><input className={inputCls} value={data.storeVariable as string ?? ''} onChange={(e) => up({ storeVariable: e.target.value })} /></Field>
      <Field label="读回确认">
        <select className={inputCls} value={(data.verifyMode as string) ?? 'none'} onChange={(e) => up({ verifyMode: e.target.value })}>
          <option value="none">无</option>
          <option value="digits">逐位朗读</option>
          <option value="numeric">整段朗读</option>
        </select>
      </Field>
      {(data.verifyMode as string) && (data.verifyMode as string) !== 'none' && (
        <Field label="确认提示模板">
          <input
            className={inputCls}
            placeholder="您输入的是 {{value}}。确认请按 1，重新输入请按 2。"
            value={(data.verifyPromptTemplate as string) ?? ''}
            onChange={(e) => up({ verifyPromptTemplate: e.target.value })}
          />
        </Field>
      )}
    </div>
  );
}

function SetVarConfig({ data, up }: { data: Record<string, unknown>; up: (p: Record<string, unknown>) => void }) {
  return (
    <div className="space-y-3">
      <Field label="变量名"><input className={inputCls} value={data.variableName as string ?? ''} onChange={(e) => up({ variableName: e.target.value })} /></Field>
      <Field label="值类型">
        <select className={inputCls} value={data.valueType as string ?? 'string'} onChange={(e) => up({ valueType: e.target.value })}>
          <option value="string">字符串</option>
          <option value="expression">表达式</option>
        </select>
      </Field>
      <Field label="值"><input className={inputCls} value={data.value as string ?? ''} onChange={(e) => up({ value: e.target.value })} /></Field>
    </div>
  );
}

function ConditionConfig({ data, up, regionGroups }: { data: Record<string, unknown>; up: (p: Record<string, unknown>) => void; regionGroups: Array<{ id: string; name: string }> }) {
  const rules = (data.rules as ConditionRule[]) || [];
  return (
    <div className="space-y-3">
      <Field label="逻辑">
        <select className={inputCls} value={data.logic as string ?? 'and'} onChange={(e) => up({ logic: e.target.value })}>
          <option value="and">并且 (AND)</option>
          <option value="or">或者 (OR)</option>
        </select>
      </Field>
      <Field label="条件规则">
        <div className="space-y-1">
          {rules.map((r, i) => (
            <div key={i} className="flex flex-col gap-1 border border-gray-100 rounded p-1.5">
              <div className="flex gap-1">
                <select
                  className={`${inputCls} text-xs flex-1`}
                  value={CONDITION_FIELD_PRESETS.some((p) => p.value === r.field) ? r.field : '__custom__'}
                  onChange={(e) => {
                    const n = [...rules];
                    n[i] = { ...r, field: e.target.value === '__custom__' ? '' : e.target.value };
                    up({ rules: n });
                  }}
                >
                  <option value="__custom__">自定义字段…</option>
                  {CONDITION_FIELD_PRESETS.map((p) => (
                    <option key={p.value} value={p.value}>{p.label}</option>
                  ))}
                </select>
                {!CONDITION_FIELD_PRESETS.some((p) => p.value === r.field) && (
                  <input className={`${inputCls} text-xs flex-1`} placeholder="字段名" value={r.field} onChange={(e) => { const n = [...rules]; n[i] = { ...r, field: e.target.value }; up({ rules: n }); }} />
                )}
              </div>
              <div className="flex gap-1">
                <select className="text-xs border border-gray-300 rounded px-1 py-1 flex-1" value={r.op} onChange={(e) => { const n = [...rules]; n[i] = { ...r, op: e.target.value as ConditionRule['op'] }; up({ rules: n }); }}>
                  <option value="eq">等于</option><option value="neq">不等于</option>
                  <option value="contains">包含</option><option value="not_contains">不包含</option>
                  <option value="is_empty">为空</option><option value="not_empty">不为空</option>
                  <option value="gt">大于</option><option value="gte">大于等于</option>
                  <option value="lt">小于</option><option value="lte">小于等于</option>
                  <option value="in_range">在范围内</option><option value="not_in_range">不在范围内</option>
                  <option value="in_region_group">属于区域组</option>
                  <option value="matches_regex">正则匹配</option>
                </select>
                {r.op === 'in_region_group' && regionGroups.length > 0 ? (
                  <select className="flex-1 text-sm border border-gray-300 rounded px-1 py-1" value={r.value} onChange={(e) => { const n = [...rules]; n[i] = { ...r, value: e.target.value }; up({ rules: n }); }}>
                    <option value="">选择区域组…</option>
                    {regionGroups.map((g) => <option key={g.id} value={g.id}>{g.name}</option>)}
                  </select>
                ) : r.op === 'matches_regex' ? (
                  <input className="flex-1 text-sm border border-gray-300 rounded px-1 py-1" placeholder="正则表达式" value={r.value} onChange={(e) => { const n = [...rules]; n[i] = { ...r, value: e.target.value }; up({ rules: n }); }} />
                ) : (
                  <input className="flex-1 text-sm border border-gray-300 rounded px-1 py-1" placeholder="值" value={r.value} onChange={(e) => { const n = [...rules]; n[i] = { ...r, value: e.target.value }; up({ rules: n }); }} />
                )}
              </div>
            </div>
          ))}
          <button type="button" onClick={() => up({ rules: [...rules, { field: '', op: 'eq', value: '' }] })} className="text-xs text-blue-600">+ 添加条件</button>
        </div>
      </Field>
      <p className="text-xs text-gray-400">区域判断使用变量 caller_area_code / caller_phone</p>
    </div>
  );
}

function TimeConditionConfig({ data, up }: { data: Record<string, unknown>; up: (p: Record<string, unknown>) => void }) {
  const [timeGroups, setTimeGroups] = useState<Array<{ id: string; name: string }>>([]);
  const [preview, setPreview] = useState<{ active: boolean; at: string } | null>(null);

  useEffect(() => {
    void fetch('/api/ivr/settings/time-groups')
      .then((r) => r.json())
      .then((json) => setTimeGroups(json.data || []))
      .catch(() => setTimeGroups([]));
  }, []);

  const scheduleId = data.scheduleId as string ?? '';

  useEffect(() => {
    if (!scheduleId) {
      setPreview(null);
      return;
    }
    void fetch(`/api/ivr/settings/time-groups/${encodeURIComponent(scheduleId)}/preview`)
      .then((r) => r.json())
      .then((json) => {
        if (json.data?.active != null) {
          setPreview({ active: json.data.active, at: json.data.at });
        } else {
          setPreview(null);
        }
      })
      .catch(() => setPreview(null));
  }, [scheduleId]);

  return (
    <Field label="时间组">
      {timeGroups.length > 0 ? (
        <select
          className={inputCls}
          value={scheduleId}
          onChange={(e) => up({ scheduleId: e.target.value })}
        >
          <option value="">选择时间组…</option>
          {timeGroups.map((g) => (
            <option key={g.id} value={g.id}>{g.name}</option>
          ))}
        </select>
      ) : (
        <input className={inputCls} value={scheduleId} onChange={(e) => up({ scheduleId: e.target.value })} placeholder="时间组 ID" />
      )}
      {preview && (
        <p className={`text-xs mt-1 ${preview.active ? 'text-green-600' : 'text-amber-600'}`}>
          当前{preview.active ? '营业中' : '非营业时间'}（{new Date(preview.at).toLocaleString('zh-CN')}）
        </p>
      )}
      <p className="text-xs text-gray-400 mt-1">
        <a href="/ivr-settings" className="text-blue-600 hover:underline">管理时间组</a>
      </p>
    </Field>
  );
}

function QueueConfig({ data, up }: { data: Record<string, unknown>; up: (p: Record<string, unknown>) => void }) {
  return (
    <div className="space-y-3">
      <Field label="队列名称"><input className={inputCls} value={data.queueName as string ?? ''} onChange={(e) => up({ queueName: e.target.value })} /></Field>
      <Field label="等待音乐（语音库 ID）"><input className={inputCls} placeholder="audio_lib_id" value={(data.waitMusic as string) ?? ''} onChange={(e) => up({ waitMusic: e.target.value })} /></Field>
      <Field label="等待策略">
        <select className={inputCls} value={data.strategy as string ?? 'fifo'} onChange={(e) => up({ strategy: e.target.value })}>
          <option value="fifo">先入先出</option><option value="ring_all">同振</option>
          <option value="random">随机</option><option value="round_robin">轮询</option>
        </select>
      </Field>
      <div className="flex gap-2">
        <Field label="超时(秒)"><input type="number" className={inputCls} value={data.timeoutSec as number ?? 300} onChange={(e) => up({ timeoutSec: +e.target.value })} /></Field>
        <Field label="超时动作">
          <select className={inputCls} value={data.timeoutAction as string ?? 'voicemail'} onChange={(e) => up({ timeoutAction: e.target.value })}>
            <option value="transfer">转接</option><option value="voicemail">留言</option><option value="hangup">挂断</option>
          </select>
        </Field>
      </div>
      <p className="text-xs text-gray-500 leading-relaxed">
        出边：<code className="text-[10px]">out</code> 坐席接通 ·{' '}
        <code className="text-[10px]">timeout</code> 等待超时（由目标节点或 timeoutAction 处理）·{' '}
        <code className="text-[10px]">at_capacity</code> 队列满 ·{' '}
        <code className="text-[10px]">error</code> 入队失败
      </p>
    </div>
  );
}

function HttpConfig({ data, up }: { data: Record<string, unknown>; up: (p: Record<string, unknown>) => void }) {
  return (
    <div className="space-y-3">
      <div className="flex gap-2">
        <Field label="方法">
          <select className={inputCls} value={data.method as string ?? 'GET'} onChange={(e) => up({ method: e.target.value })}>
            <option value="GET">GET</option><option value="POST">POST</option><option value="PUT">PUT</option><option value="DELETE">DELETE</option>
          </select>
        </Field>
        <Field label="超时(秒)"><input type="number" className={inputCls} value={data.timeoutSec as number ?? 10} onChange={(e) => up({ timeoutSec: +e.target.value })} /></Field>
      </div>
      <Field label="URL"><input className={inputCls} placeholder="https://..." value={data.url as string ?? ''} onChange={(e) => up({ url: e.target.value })} /></Field>
      <Field label="重试次数 (5xx/网络)"><input type="number" min={0} max={5} className={inputCls} value={(data.retryCount as number) ?? 0} onChange={(e) => up({ retryCount: +e.target.value })} /></Field>
    </div>
  );
}

function TransferConfig({ data, up, groupCallGroups }: { data: Record<string, unknown>; up: (p: Record<string, unknown>) => void; groupCallGroups: Array<{ id: string; name: string }> }) {
  const targetType = data.targetType as string ?? 'seat_id';
  const productionSupported = targetType === 'seat_id' || targetType === 'group_call';
  return (
    <div className="space-y-3">
      <Field label="目标类型">
        <select className={inputCls} value={targetType} onChange={(e) => up({ targetType: e.target.value })}>
          <option value="seat_id">坐席 ID（生产可用）</option>
          <option value="group_call">群呼组（生产：单成员）</option>
          <option value="agent_ring_all">坐席-同振（未桥接）</option>
          <option value="agent_random">坐席-随机（未桥接）</option>
          <option value="agent_round_robin">坐席-顺振（未桥接）</option>
          <option value="extension">分机（未桥接）</option>
          <option value="queue">队列（未桥接）</option>
          <option value="phone">固话/手机（未桥接）</option>
        </select>
      </Field>
      {!productionSupported ? (
        <p className="text-xs text-amber-700 bg-amber-50 border border-amber-200 rounded px-2 py-1">
          当前生产转接仅支持「坐席 ID」与「单成员群呼」；其它类型会走 failed 出边。
        </p>
      ) : (
        <p className="text-xs text-slate-600 bg-slate-50 border border-slate-200 rounded px-2 py-1">
          同步生产桥接结果只有「接通(out)」或「失败(failed)」。busy / no_answer 需异步 dial 事件，当前不会由盲转产生。
        </p>
      )}
      {targetType === 'group_call' && groupCallGroups.length > 0 ? (
        <Field label="群呼组">
          <select className={inputCls} value={data.targetValue as string ?? ''} onChange={(e) => up({ targetValue: e.target.value })}>
            <option value="">选择群呼组…</option>
            {groupCallGroups.map((g) => <option key={g.id} value={g.id}>{g.name}</option>)}
          </select>
        </Field>
      ) : (
        <Field label={targetType === 'seat_id' ? '目标坐席 ID' : '目标值'}>
          <input
            className={inputCls}
            placeholder={targetType === 'seat_id' ? 'seat_xxx' : '坐席ID/分机号/队列名/手机号'}
            value={data.targetValue as string ?? ''}
            onChange={(e) => up({ targetValue: e.target.value })}
          />
        </Field>
      )}
      <Field label="源坐席 ID（生产必填，或运行时变量 from_seat_id）">
        <input
          className={inputCls}
          placeholder="from_seat_id"
          value={data.fromSeatId as string ?? ''}
          onChange={(e) => up({ fromSeatId: e.target.value })}
        />
      </Field>
      {targetType === 'group_call' ? (
        <Field label="成员坐席 IDs（逗号分隔；生产需恰好 1 个）">
          <input
            className={inputCls}
            placeholder="seat_a,seat_b"
            value={Array.isArray(data.memberSeatIds) ? (data.memberSeatIds as string[]).join(',') : (data.memberSeatIds as string ?? '')}
            onChange={(e) =>
              up({
                memberSeatIds: e.target.value
                  .split(',')
                  .map((s) => s.trim())
                  .filter(Boolean),
              })
            }
          />
        </Field>
      ) : null}
      <Field label="主叫号码"><input className={inputCls} value={data.callerId as string ?? ''} onChange={(e) => up({ callerId: e.target.value })} /></Field>
      <Field label="接通超时(秒)"><input type="number" className={inputCls} value={(data.connectTimeoutSec as number) ?? 15} onChange={(e) => up({ connectTimeoutSec: +e.target.value })} /></Field>
      <Field label="失败策略">
        <select className={inputCls} value={(data.onFailure as string) ?? 'branch'} onChange={(e) => up({ onFailure: e.target.value })}>
          <option value="branch">走失败出边</option><option value="voicemail">留言</option><option value="hangup">挂断</option>
        </select>
      </Field>
      <Field label="转接前提示">
        <PlayContentsEditor
          contents={(data.preTransferPrompt as PlayContent[]) || []}
          up={(p) => up({ preTransferPrompt: p.contents })}
        />
      </Field>
    </div>
  );
}

function VoicemailConfig({ data, up }: { data: Record<string, unknown>; up: (p: Record<string, unknown>) => void }) {
  return (
    <div className="space-y-3">
      <Field label="最大时长(秒)"><input type="number" className={inputCls} value={data.maxDurationSec as number ?? 60} onChange={(e) => up({ maxDurationSec: +e.target.value })} /></Field>
      <Field label="信箱 ID"><input className={inputCls} value={data.mailboxId as string ?? ''} onChange={(e) => up({ mailboxId: e.target.value })} /></Field>
      <Field label="通知 Webhook"><input className={inputCls} placeholder="https://..." value={(data.notifyWebhook as string) ?? ''} onChange={(e) => up({ notifyWebhook: e.target.value })} /></Field>
      <Field label="通知邮箱"><input className={inputCls} placeholder="ops@example.com" value={(data.notifyEmail as string) ?? ''} onChange={(e) => up({ notifyEmail: e.target.value })} /></Field>
    </div>
  );
}

function SipConfig({ data, up }: { data: Record<string, unknown>; up: (p: Record<string, unknown>) => void }) {
  const headers = (data.headers as Array<{ key: string; value: string }>) || [];
  return (
    <div className="space-y-3">
      <Field label="SIP URI"><input className={inputCls} placeholder="sip:{{agent}}@domain" value={data.sipUri as string ?? ''} onChange={(e) => up({ sipUri: e.target.value })} /></Field>
      <Field label="自定义 SIP 头">
        <div className="space-y-1">
          {headers.map((h, i) => (
            <div key={i} className="flex gap-1">
              <input className={`${inputCls} w-1/3`} placeholder="X-Header" value={h.key} onChange={(e) => {
                const next = [...headers];
                next[i] = { ...next[i], key: e.target.value };
                up({ headers: next });
              }} />
              <input className={`${inputCls} flex-1`} placeholder="{{var}}" value={h.value} onChange={(e) => {
                const next = [...headers];
                next[i] = { ...next[i], value: e.target.value };
                up({ headers: next });
              }} />
            </div>
          ))}
          <button type="button" className="text-xs text-blue-600" onClick={() => up({ headers: [...headers, { key: '', value: '' }] })}>+ 添加头</button>
        </div>
      </Field>
    </div>
  );
}

function AiDialogueConfig({ data, up }: { data: Record<string, unknown>; up: (p: Record<string, unknown>) => void }) {
  const triggers = (data.handoffTriggers as string[] | undefined) ?? [];
  return (
    <div className="space-y-3">
      <Field label="AI 角色">
        <select className={inputCls} value={data.role as string ?? 'outbound'} onChange={(e) => up({ role: e.target.value })}>
          <option value="outbound">外呼</option><option value="inbound_support">客服</option>
        </select>
      </Field>
      <Field label="Agent Spec ID"><input className={inputCls} value={data.agentSpecId as string ?? ''} onChange={(e) => up({ agentSpecId: e.target.value })} placeholder="优先于话术脚本 ID" /></Field>
      <Field label="话术脚本 ID"><input className={inputCls} value={data.scriptId as string ?? ''} onChange={(e) => up({ scriptId: e.target.value })} /></Field>
      <div className="flex gap-2">
        <Field label="最大轮数"><input type="number" className={inputCls} value={data.maxTurns as number ?? 10} onChange={(e) => up({ maxTurns: +e.target.value })} /></Field>
        <Field label="超时(秒)"><input type="number" className={inputCls} value={data.timeoutSec as number ?? 30} onChange={(e) => up({ timeoutSec: +e.target.value })} /></Field>
      </div>
      <Field label="转人工触发词（逗号分隔）">
        <input
          className={inputCls}
          value={triggers.join(', ')}
          onChange={(e) => up({ handoffTriggers: e.target.value.split(',').map((s) => s.trim()).filter(Boolean) })}
          placeholder="转人工, 找客服"
        />
      </Field>
    </div>
  );
}

function IntentConfig({ data, up }: { data: Record<string, unknown>; up: (p: Record<string, unknown>) => void }) {
  const dimension = data.dimension as string ?? 'score';
  return (
    <div className="space-y-3">
      <Field label="判断维度">
        <select className={inputCls} value={dimension} onChange={(e) => up({ dimension: e.target.value })}>
          <option value="score">意向分</option><option value="keyword">关键词</option><option value="emotion">情绪</option>
        </select>
      </Field>
      {dimension === 'keyword' ? (
        <>
          <Field label="高意向关键词（逗号分隔）">
            <input
              className={inputCls}
              placeholder="贷款, 感兴趣"
              value={((data.keywords as string[]) || []).join(', ')}
              onChange={(e) => up({ keywords: e.target.value.split(',').map((s) => s.trim()).filter(Boolean) })}
            />
          </Field>
          <Field label="低意向关键词（逗号分隔）">
            <input
              className={inputCls}
              placeholder="不需要, 挂断"
              value={((data.lowKeywords as string[]) || []).join(', ')}
              onChange={(e) => up({ lowKeywords: e.target.value.split(',').map((s) => s.trim()).filter(Boolean) })}
            />
          </Field>
        </>
      ) : (
        <Field label="阈值 (0-1)"><input type="number" step="0.05" min="0" max="1" className={inputCls} value={data.threshold as number ?? 0.7} onChange={(e) => up({ threshold: +e.target.value })} /></Field>
      )}
      <p className="text-xs text-gray-400">关键词模式读变量 <code className="text-[10px]">last_utterance</code> / <code className="text-[10px]">caller_question</code></p>
    </div>
  );
}

function KnowledgeQaConfig({ data, up, knowledgeBases }: { data: Record<string, unknown>; up: (p: Record<string, unknown>) => void; knowledgeBases: Array<{ id: string; name: string }> }) {
  return (
    <div className="space-y-3">
      <Field label="知识库">
        {knowledgeBases.length > 0 ? (
          <select className={inputCls} value={data.knowledgeBaseId as string ?? ''} onChange={(e) => up({ knowledgeBaseId: e.target.value })}>
            <option value="">全部知识库</option>
            {knowledgeBases.map((kb) => <option key={kb.id} value={kb.id}>{kb.name}</option>)}
          </select>
        ) : (
          <input className={inputCls} value={data.knowledgeBaseId as string ?? ''} onChange={(e) => up({ knowledgeBaseId: e.target.value })} />
        )}
      </Field>
      <div className="flex gap-2">
        <Field label="最大结果数"><input type="number" className={inputCls} value={data.maxResults as number ?? 3} onChange={(e) => up({ maxResults: +e.target.value })} /></Field>
        <Field label="无答案动作">
          <select className={inputCls} value={data.noAnswerAction as string ?? 'transfer'} onChange={(e) => up({ noAnswerAction: e.target.value })}>
            <option value="transfer">转接</option><option value="continue">继续</option><option value="voicemail">留言</option>
          </select>
        </Field>
      </div>
      <Field label="问题变量"><input className={inputCls} placeholder="caller_question" value={(data.questionVariable as string) ?? 'caller_question'} onChange={(e) => up({ questionVariable: e.target.value })} /></Field>
      {(data.noAnswerAction as string) === 'transfer' && (
        <Field label="无答案转接目标(队列)"><input className={inputCls} value={(data.noAnswerTarget as string) ?? ''} onChange={(e) => up({ noAnswerTarget: e.target.value })} /></Field>
      )}
      <Field label="答案播报">
        <select className={inputCls} value={(data.answerPlayMode as string) ?? 'none'} onChange={(e) => up({ answerPlayMode: e.target.value })}>
          <option value="none">不播报</option><option value="tts">TTS 全文</option><option value="summary">摘要</option>
        </select>
      </Field>
    </div>
  );
}

function AvatarSwitchConfig({ data, up }: { data: Record<string, unknown>; up: (p: Record<string, unknown>) => void }) {
  return (
    <div className="space-y-3">
      <Field label="切换方向">
        <select className={inputCls} value={data.direction as string ?? 'voice_to_video'} onChange={(e) => up({ direction: e.target.value })}>
          <option value="voice_to_video">语音 → 视频</option><option value="video_to_voice">视频 → 语音</option>
        </select>
      </Field>
      <Field label="Avatar ID"><input className={inputCls} value={data.avatarId as string ?? ''} onChange={(e) => up({ avatarId: e.target.value })} /></Field>
    </div>
  );
}

function ComplianceConfig({ data, up }: { data: Record<string, unknown>; up: (p: Record<string, unknown>) => void }) {
  return (
    <div className="space-y-3">
      <Field label="播报类型">
        <select className={inputCls} value={data.complianceType as string ?? 'ai_disclosure'} onChange={(e) => up({ complianceType: e.target.value })}>
          <option value="ai_disclosure">AI 身份披露</option><option value="recording_consent">录音同意</option><option value="privacy_notice">隐私声明</option>
        </select>
      </Field>
      <Field label="语言"><input className={inputCls} value={data.language as string ?? 'zh'} onChange={(e) => up({ language: e.target.value })} /></Field>
    </div>
  );
}

function VideoPlayConfig({ data, up }: { data: Record<string, unknown>; up: (p: Record<string, unknown>) => void }) {
  return (
    <div className="space-y-3">
      <Field label="视频源">
        <select className={inputCls} value={data.sourceType as string ?? 'prerecorded'} onChange={(e) => up({ sourceType: e.target.value })}>
          <option value="prerecorded">预录制</option><option value="screen_share">屏幕共享</option><option value="avatar">数字人</option>
        </select>
      </Field>
      {data.sourceType === 'prerecorded' && <Field label="视频 URL"><input className={inputCls} value={data.videoUrl as string ?? ''} onChange={(e) => up({ videoUrl: e.target.value })} /></Field>}
      <div className="flex gap-2">
        <label className="flex items-center gap-1 text-xs"><input type="checkbox" checked={data.loop as boolean ?? false} onChange={(e) => up({ loop: e.target.checked })} /> 循环</label>
        <label className="flex items-center gap-1 text-xs"><input type="checkbox" checked={data.skippable as boolean ?? true} onChange={(e) => up({ skippable: e.target.checked })} /> 可跳过</label>
      </div>
    </div>
  );
}

function ScreenShareConfig({ data, up }: { data: Record<string, unknown>; up: (p: Record<string, unknown>) => void }) {
  return (
    <div className="space-y-3">
      <Field label="共享源">
        <select className={inputCls} value={data.source as string ?? 'agent'} onChange={(e) => up({ source: e.target.value })}>
          <option value="agent">坐席</option><option value="ai">AI</option>
        </select>
      </Field>
      <label className="flex items-center gap-1 text-xs"><input type="checkbox" checked={data.allowRemoteControl as boolean ?? false} onChange={(e) => up({ allowRemoteControl: e.target.checked })} /> 允许远程控制</label>
    </div>
  );
}

function VisualMenuConfig({ data, up, nodes }: { data: Record<string, unknown>; up: (p: Record<string, unknown>) => void; nodes: Node[] }) {
  const items = (data.items as VisualMenuItem[]) || [];
  const linkedMenuNodeId = data.linkedMenuNodeId as string | undefined;

  // Find all menu nodes on the canvas for linking
  const menuNodes = nodes.filter((n) => (n.data as Record<string, unknown>).type === 'menu');

  // Sync items from a linked menu node. Branch handles are derived from `digit`
  // via IVR_BRANCH.digit() (SSOT); no separate `action` field is needed — the
  // node renderer / canvas wiring key off `item.digit`, never a stored action.
  function syncFromMenu(menuNodeId: string) {
    const menuNode = nodes.find((n) => n.id === menuNodeId);
    if (!menuNode) return;
    const menuOptions = ((menuNode.data as Record<string, unknown>).options as Array<{ digit: string; label: string }>) || [];
    const syncedItems: VisualMenuItem[] = menuOptions.map((opt) => ({
      id: `item_${opt.digit}`,
      digit: opt.digit,
      label: opt.label,
    }));
    up({ linkedMenuNodeId: menuNodeId, items: syncedItems });
  }

  return (
    <div className="space-y-3">
      <Field label="菜单标题"><input className={inputCls} value={data.title as string ?? ''} onChange={(e) => up({ title: e.target.value })} /></Field>
      <Field label="联动按键菜单">
        <select
          className={inputCls}
          value={linkedMenuNodeId || ''}
          onChange={(e) => { if (e.target.value) syncFromMenu(e.target.value); else up({ linkedMenuNodeId: undefined }); }}
        >
          <option value="">不联动</option>
          {menuNodes.map((n) => (
            <option key={n.id} value={n.id}>{(n.data as Record<string, unknown>).name as string}</option>
          ))}
        </select>
      </Field>
      {linkedMenuNodeId && (
        <p className="text-[10px] text-blue-600">已联动：可视化菜单项自动同步按键菜单的选项</p>
      )}
      <Field label="菜单项">
        <div className="space-y-1">
          {items.map((item, i) => (
            <div key={i} className="flex gap-1">
              <input className="w-8 text-center text-sm border rounded px-1" value={item.digit} onChange={(e) => { const n = [...items]; n[i] = { ...item, digit: e.target.value }; up({ items: n }); }} />
              <input className="flex-1 text-sm border rounded px-1" placeholder="标签" value={item.label} onChange={(e) => { const n = [...items]; n[i] = { ...item, label: e.target.value }; up({ items: n }); }} />
            </div>
          ))}
          <button type="button" onClick={() => up({ items: [...items, { id: `item_${Date.now()}`, digit: String(items.length + 1), label: '' }] })} className="text-xs text-blue-600">+ 添加项</button>
        </div>
      </Field>
    </div>
  );
}

function SubflowConfig({ data, up, flows }: { data: Record<string, unknown>; up: (p: Record<string, unknown>) => void; flows: Array<{ id: string; name: string }> }) {
  const params = (data.params as Array<{ key: string; source: string }>) || [];
  return (
    <div className="space-y-3">
      <Field label="子流程">
        {flows.length > 0 ? (
          <select className={inputCls} value={data.flowId as string ?? ''} onChange={(e) => {
            const flow = flows.find((f) => f.id === e.target.value);
            up({ flowId: e.target.value, flowName: flow?.name });
          }}>
            <option value="">选择子流程…</option>
            {flows.map((f) => <option key={f.id} value={f.id}>{f.name}</option>)}
          </select>
        ) : (
          <input className={inputCls} value={data.flowId as string ?? ''} onChange={(e) => up({ flowId: e.target.value })} />
        )}
      </Field>
      <Field label="传入参数">
        <div className="space-y-1">
          {params.map((p, i) => (
            <div key={i} className="flex gap-1">
              <input className="w-20 text-sm border rounded px-1" placeholder="key" value={p.key} onChange={(e) => { const n = [...params]; n[i] = { ...p, key: e.target.value }; up({ params: n }); }} />
              <input className="flex-1 text-sm border rounded px-1" placeholder="值或 {{变量}}" value={p.source} onChange={(e) => { const n = [...params]; n[i] = { ...p, source: e.target.value }; up({ params: n }); }} />
            </div>
          ))}
          <button type="button" onClick={() => up({ params: [...params, { key: '', source: '' }] })} className="text-xs text-blue-600">+ 添加参数</button>
        </div>
      </Field>
    </div>
  );
}

function RecordingConfig({ data, up }: { data: Record<string, unknown>; up: (p: Record<string, unknown>) => void }) {
  return (
    <div className="space-y-3">
      <Field label="动作">
        <select className={inputCls} value={data.action as string ?? 'start'} onChange={(e) => up({ action: e.target.value })}>
          <option value="start">开始录音</option><option value="stop">停止录音</option>
        </select>
      </Field>
      <Field label="格式">
        <select className={inputCls} value={data.format as string ?? 'wav'} onChange={(e) => up({ format: e.target.value })}>
          <option value="wav">WAV</option><option value="mp3">MP3</option><option value="ogg">OGG</option>
        </select>
      </Field>
    </div>
  );
}

function WebhookConfig({ data, up }: { data: Record<string, unknown>; up: (p: Record<string, unknown>) => void }) {
  return (
    <div className="space-y-3">
      <Field label="事件类型"><input className={inputCls} value={data.eventType as string ?? ''} onChange={(e) => up({ eventType: e.target.value })} /></Field>
      <Field label="URL"><input className={inputCls} value={data.url as string ?? ''} onChange={(e) => up({ url: e.target.value })} /></Field>
      <Field label="方法">
        <select className={inputCls} value={data.method as string ?? 'POST'} onChange={(e) => up({ method: e.target.value })}>
          <option value="POST">POST</option><option value="GET">GET</option>
        </select>
      </Field>
      <Field label="超时(秒)"><input type="number" className={inputCls} value={(data.timeoutSec as number) ?? 10} onChange={(e) => up({ timeoutSec: +e.target.value })} /></Field>
      <Field label="重试次数 (5xx/网络)"><input type="number" min={0} max={5} className={inputCls} value={(data.retryCount as number) ?? 0} onChange={(e) => up({ retryCount: +e.target.value })} /></Field>
      <label className="flex items-center gap-2 text-sm text-gray-700">
        <input type="checkbox" checked={data.async === true} onChange={(e) => up({ async: e.target.checked })} />
        异步发送（不阻塞通话）
      </label>
      <Field label="HMAC Secret Ref"><input className={inputCls} placeholder="integration secret ref id" value={(data.hmacSecretRef as string) ?? ''} onChange={(e) => up({ hmacSecretRef: e.target.value })} /></Field>
    </div>
  );
}
