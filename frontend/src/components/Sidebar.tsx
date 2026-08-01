import { NavLink } from 'react-router-dom';
import { useAuth } from '../hooks/useAuth';

const navItems = [
  { to: '/', label: '仪表盘', icon: '◈' },
  { to: '/specs', label: '话术', icon: '✎' },
  { to: '/outbound', label: '外呼', icon: '▶' },
  { to: '/campaigns', label: 'Campaign', icon: '📣' },
  { to: '/wfm', label: '排班 WFM', icon: '📅' },
  { to: '/inbox', label: '统一收件箱', icon: '💬' },
  { to: '/journey', label: '客户旅程', icon: '🧭' },
  { to: '/developer', label: '开发者', icon: '⌘' },
  { to: '/compliance', label: '合规', icon: '🛡' },
  { to: '/dashboard-custom', label: '自定义仪表盘', icon: '▦' },
  { to: '/proactive-push', label: '主动推送', icon: '⚡' },
  { to: '/intelligence', label: '智能路由', icon: '🧠' },
  { to: '/ivr-flows', label: 'IVR 流程', icon: '🔀' },
  { to: '/ivr-designer', label: 'IVR 设计器', icon: '✏' },
  { to: '/ivr-settings', label: 'IVR 设置', icon: '⏱' },
  { to: '/ivr-monitor', label: 'IVR 监控', icon: '📡' },
  { to: '/ivr-audio-library', label: 'IVR 语音库', icon: '🔊' },
  { to: '/ivr-marketplace', label: 'IVR 市场', icon: '📞' },
  { to: '/screen-recordings', label: '屏幕录制', icon: '🖥' },
  { to: '/remote-assist/observe', label: '远程协助', icon: '◉' },
  { to: '/queues', label: '呼入队列', icon: '⏳' },
  { to: '/did-numbers', label: 'DID', icon: '#' },
  { to: '/calls', label: '通话记录', icon: '☎' },
  { to: '/wallboard', label: 'Wallboard', icon: '▦' },
  { to: '/knowledge', label: '知识库', icon: '📚' },
  { to: '/recordings', label: '录音', icon: '⏺' },
  { to: '/voicemails', label: '语音信箱', icon: '📩' },
  { to: '/qm', label: '质检', icon: '★' },
  { to: '/workbench', label: '工作台', icon: '◉' },
  { to: '/agents', label: '坐席', icon: '⊕' },
  { to: '/settings', label: '设置', icon: '⚙' },
];

export default function Sidebar() {
  const { logout } = useAuth();

  return (
    <aside className="fixed left-0 top-0 bottom-0 w-[260px] bg-slate-800 text-white flex flex-col">
      <div className="px-6 py-5 border-b border-slate-700">
        <h1 className="text-xl font-bold tracking-tight">Converact Console</h1>
        <p className="text-xs text-slate-400 mt-0.5">Call Center Platform</p>
      </div>

      <nav className="flex-1 py-4 space-y-1">
        {navItems.map((item) => (
          <NavLink
            key={item.to}
            to={item.to}
            end={item.to === '/'}
            className={({ isActive }) =>
              `flex items-center gap-3 px-6 py-2.5 text-sm transition-colors ${
                isActive
                  ? 'bg-blue-500/20 text-blue-400 border-l-2 border-blue-400'
                  : 'text-slate-300 hover:bg-slate-700/50 border-l-2 border-transparent'
              }`
            }
          >
            <span className="text-lg">{item.icon}</span>
            {item.label}
          </NavLink>
        ))}
      </nav>

      <div className="p-4 border-t border-slate-700">
        <button
          onClick={logout}
          className="w-full text-left px-2 py-2 text-sm text-slate-400 hover:text-white transition-colors"
        >
          ↩ Sign out
        </button>
      </div>
    </aside>
  );
}
