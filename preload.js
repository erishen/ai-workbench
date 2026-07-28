// preload.js
// 在独立、隔离的上下文中运行；通过 contextBridge 向渲染进程暴露最小且安全的 API。
const { contextBridge, ipcRenderer } = require('electron');

// 允许主进程 -> 渲染进程的单向通道白名单（避免任意 channel 监听）
const VALID_INBOUND_CHANNELS = [
  'update-message',
  'translate:progress',
  'chat:progress',
  'workflow:progress',
  'workflow:result',
];

contextBridge.exposeInMainWorld('electronAPI', {
  // 主进程 -> 渲染进程（渲染进程主动拉取）
  getAppVersion: () => ipcRenderer.invoke('get-app-version'),

  // 外部大模型设置
  getSettings: () => ipcRenderer.invoke('settings:get'),
  saveSettings: (partial) => ipcRenderer.invoke('settings:save', partial),

  // URL 翻译：返回 { lang, target, translated, url, chars }
  // configId 可选：指定「设置」中的某条模型配置（跨服务商）；不传则用主配置
  translateUrl: (url, configId) => ipcRenderer.invoke('translate:url', { url, configId }),

  // PSE 工作流：项目选择 / 运行 / 停止（对应 electron.js 的 workflow:* handler）
  // allowExec: 是否启用「受控命令执行」（Specialist 产出的命令经用户授权后实际运行）
  workflowPickProject: () => ipcRenderer.invoke('workflow:pickProject'),
  workflowRun: (task, projectDir, models, allowExec) =>
    ipcRenderer.invoke('workflow:run', { task, projectDir, models, allowExec }),
  workflowStop: () => ipcRenderer.invoke('workflow:stop'),

  // 受控命令执行：用户对「在某项目执行命令」授权弹窗的回执（对应 electron.js 的 workflow:exec-approve）
  workflowExecApprove: (payload) => ipcRenderer.invoke('workflow:exec-approve', payload),

  // 代码导出：从交付物提取文件 / 选择目录 / 写盘（对应 electron.js 的 export:* handler）
  exportExtract: (steps) => ipcRenderer.invoke('export:extract', { steps }),
  pickExportDir: () => ipcRenderer.invoke('export:pickDir'),
  exportWrite: (dir, files, opts = {}) =>
    ipcRenderer.invoke('export:write', {
      dir,
      files,
      overwrite: !!opts.overwrite,
      sandbox: opts.sandbox !== false, // 默认沙箱
      forceCritical: !!opts.forceCritical,
    }),

  // 工作流设计器（WorkflowDesignerModule 用；对应 main/workflow.js 的 workflow:designer:* handler）
  saveWorkflow: (definition) => ipcRenderer.invoke('workflow:designer:save', definition),
  loadWorkflow: (id) => ipcRenderer.invoke('workflow:designer:load', id),

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

  // 多轮对话：发送完整 messages 历史，返回 { content, usage }
  // configId 可选：指定「设置」中的某条模型配置（跨服务商）；不传则用主配置
  chatMessage: (messages, configId) => ipcRenderer.invoke('chat:message', { messages, configId }),

  // 对话流式推送（专用封装）；返回取消订阅函数，供 useEffect 清理，避免重复监听
  onChatProgress: (callback) => {
    const handler = (_event, ...args) => callback(...args);
    ipcRenderer.on('chat:progress', handler);
    return () => ipcRenderer.removeListener('chat:progress', handler);
  },

  // 工作流进度推送（专用封装）；返回取消订阅函数，供 useEffect 清理，避免重复监听
  onWorkflowProgress: (callback) => {
    const handler = (_event, ...args) => callback(...args);
    ipcRenderer.on('workflow:progress', handler);
    return () => ipcRenderer.removeListener('workflow:progress', handler);
  },
});
