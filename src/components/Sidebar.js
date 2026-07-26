import Brand from './Brand';
import { MODULES } from '../config/modules';

// 侧边栏：上半部分是功能模块列表，底部是独立的「设置」（与模块在视觉/语义上区分）
export default function Sidebar({ active, onSelect }) {
  return (
    <aside className="sidebar">
      <Brand />
      <div className="nav-label">功能模块</div>
      <nav className="nav">
        {MODULES.map((m) => (
          <button
            key={m.id}
            className={`nav-item ${active === m.id ? 'active' : ''}`}
            onClick={() => onSelect(m.id)}
          >
            <span className="nav-icon">{m.icon}</span>
            <span>{m.name}</span>
          </button>
        ))}
        <div className="nav-coming">更多 AI 模块即将上线…</div>
      </nav>
      <div className="sidebar-footer">
        <button
          className={`nav-item settings ${active === 'settings' ? 'active' : ''}`}
          onClick={() => onSelect('settings')}
        >
          <span className="nav-icon">⚙️</span>
          <span>设置</span>
        </button>
      </div>
    </aside>
  );
}
