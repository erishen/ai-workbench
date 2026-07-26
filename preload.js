// preload.js
// 在独立、隔离的上下文中运行；通过 contextBridge 向渲染进程暴露最小且安全的 API。
const { contextBridge, ipcRenderer } = require('electron');

// 允许主进程 -> 渲染进程的单向通道白名单（避免任意 channel 监听）
const VALID_INBOUND_CHANNELS = ['update-message', 'translate:progress'];

contextBridge.exposeInMainWorld('electronAPI', {
  // 主进程 -> 渲染进程（渲染进程主动拉取）
  getAppVersion: () => ipcRenderer.invoke('get-app-version'),

  // 外部大模型设置
  getSettings: () => ipcRenderer.invoke('settings:get'),
  saveSettings: (partial) => ipcRenderer.invoke('settings:save', partial),

  // URL 翻译：返回 { lang, target, translated, url, chars }
  translateUrl: (url) => ipcRenderer.invoke('translate:url', { url }),

  // 主进程 -> 渲染进程（主进程主动推送）
  onMessage: (channel, callback) => {
    if (!VALID_INBOUND_CHANNELS.includes(channel)) return;
    ipcRenderer.on(channel, (_event, ...args) => callback(...args));
  },

  // 翻译进度推送（专用封装）；返回取消订阅函数，供 useEffect 清理，避免重复监听
  onTranslateProgress: (callback) => {
    const handler = (_event, ...args) => callback(...args);
    ipcRenderer.on('translate:progress', handler);
    return () => ipcRenderer.removeListener('translate:progress', handler);
  },
});
