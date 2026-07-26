// 是否运行在 Electron 桌面环境（有主进程桥接 window.electronAPI）
// 浏览器环境无此对象，相关功能会降级提示
export const isElectron = typeof window !== 'undefined' && window.electronAPI;
