import './App.css';
import { useState, useEffect } from 'react';
import { isElectron } from './lib/env';
import { MODULES } from './config/modules';
import Sidebar from './components/Sidebar';
import SettingsView from './components/SettingsView';

export default function App() {
  const [version, setVersion] = useState('');
  const [active, setActive] = useState(MODULES[0]?.id || 'translate');

  useEffect(() => {
    if (!isElectron) return;
    window.electronAPI.getAppVersion?.().then(setVersion).catch(() => {});
  }, []);

  // 根据 active 渲染对应模块组件；设置是独立的全局视图
  const activeModule = MODULES.find((m) => m.id === active);
  const ActiveComponent = activeModule ? activeModule.component : null;

  return (
    <div className="layout">
      <Sidebar active={active} onSelect={setActive} />
      <main className="content">
        {active === 'settings' ? (
          <SettingsView />
        ) : ActiveComponent ? (
          <ActiveComponent />
        ) : null}
        {!isElectron && (
          <div className="alert muted" style={{ marginTop: 16 }}>
            提示：翻译功能需在 Electron 桌面环境中运行（浏览器环境无主进程桥接）。
          </div>
        )}
        {version && <div className="version">App version: {version}</div>}
      </main>
    </div>
  );
}
