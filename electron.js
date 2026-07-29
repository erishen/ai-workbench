// electron.js
const { app, BrowserWindow, ipcMain, dialog, shell } = require('electron');
const path = require('path');
const fs = require('fs');
const { loadSettings, saveSettings, resolveModelConfig } = require('./main/settings');
const { translateUrl } = require('./main/translate');
const { chatStream } = require('./main/llm');
const { runWorkflow } = require('./main/workflow');
const { resetApprovals, resolveApproval } = require('./main/executor');
const { extractFiles, writeFiles } = require('./main/export');
const { logsDir } = require('./main/runlog');

// 调试落盘：仅本机排查用，不含任何密钥。聊天/翻译模块切换模型是否生效，可直接看 /tmp/aw-debug.log。
function debugAppend(tag, text) {
  try {
    const stamp = new Date().toISOString();
    fs.appendFileSync(
      '/tmp/aw-debug.log',
      `\n[${stamp}] ${tag}\n${String(text == null ? '' : text).slice(0, 2000)}\n`
    );
  } catch (_) {
    /* 忽略写入失败 */
  }
}

// dev 模式：主进程文件（electron.js / preload.js / main/*）改动后自动硬重启，
// 免去手动退出再跑 pnpm dev。纯 UI(src/) 改动由 CRA 自带 HMR 热更，不在此监听。
if (!app.isPackaged) {
  try {
    require('electron-reload')(
      [path.join(__dirname, 'electron.js'), path.join(__dirname, 'preload.js'), path.join(__dirname, 'main')],
      {
        electron: path.join(__dirname, 'node_modules', '.bin', 'electron'),
        hardResetMethod: 'exit',
        forceHardReset: true,
      }
    );
  } catch (err) {
    console.warn('[dev] electron-reload 未启用:', err.message);
  }
}

let mainWindow;

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1000,
    height: 720,
    webPreferences: {
      // 安全基线：关闭 Node 集成、开启上下文隔离，仅经 preload 桥暴露有限 API
      nodeIntegration: false,
      contextIsolation: true,
      preload: path.join(__dirname, 'preload.js'),
    },
  });

  // 全局异常兜底：写 stderr，便于 dev 控制台排查（不再写临时文件）
  process.on('uncaughtException', (e) => console.error('[main] uncaughtException:', (e && e.stack) || e));
  process.on('unhandledRejection', (e) => console.error('[main] unhandledRejection:', (e && e.stack) || e));
  mainWindow.webContents.on('did-fail-load', (_e, errorCode, errorDescription) => {
    try { dialog.showErrorBox('页面加载失败', `code=${errorCode} ${errorDescription}`); } catch (_) {}
  });
  mainWindow.webContents.on('crashed', () => console.error('[main] renderer crashed'));

  // 生产环境用 loadFile：内部走 pathToFileURL，自动编码 app 名中的空格与 asar 路径，
  // 规避「Agent Workflow.app」含空格导致 file:// 未编码 -> Chromium 解析失败 -> 白屏。
  if (!app.isPackaged) {
    // dev 端口与 package.json 的 dev 脚本（PORT / ELECTRON_DEV_PORT）对齐，避免 wait-on 硬绑 3000 因端口冲突静默卡死
    const DEV_PORT = process.env.ELECTRON_DEV_PORT || 3000;
    mainWindow.loadURL('http://localhost:' + DEV_PORT).catch((e) => console.error('[main] load dev url failed:', e));
  } else {
    mainWindow.loadFile(path.join(__dirname, 'build', 'index.html'))
      .catch((e) => { try { dialog.showErrorBox('页面加载失败', String(e)); } catch (_) {} });
  }

  mainWindow.on('closed', () => (mainWindow = null));
}

// 渲染进程经 window.electronAPI.getAppVersion() 调用，返回 package.json 的 version
ipcMain.handle('get-app-version', () => app.getVersion());

// ---- Agent Workflow：外部大模型设置 + URL 翻译 ----
ipcMain.handle('settings:get', () => loadSettings());

ipcMain.handle('settings:save', (event, partial) => saveSettings(partial));

ipcMain.handle('translate:url', async (event, { url, configId }) => {
  const settings = loadSettings();
  const { baseURL, apiKey, model, provider, label } = resolveModelConfig(settings, configId);
  const proxy = settings.proxy || '';
  let endpoint = baseURL || '';
  try { endpoint = new URL(baseURL).host; } catch (_) { /* 保留原串 */ }
  debugAppend('TRANSLATE-RECV', `configId=${JSON.stringify(configId)} -> provider=${provider || ''} label=${label || ''} model=${model} endpoint=${endpoint} keyLen=${apiKey ? apiKey.length : 0} url=${url || ''}`);
  if (!apiKey) {
    throw new Error('请先在「设置」中填写外部大模型的 API Key');
  }
  return translateUrl(url, { baseURL, apiKey, model, proxy }, (progress) => {
    if (mainWindow) mainWindow.webContents.send('translate:progress', progress);
  });
});

// 截断对话历史，避免长对话撑爆上下文窗口：按字符数粗略估算，从最早轮次丢弃整轮(user+assistant)。
// 作为安全阀(非精确 token 控制)，始终保留最后两条，避免丢光上下文。
function trimMessages(messages, maxChars = 16000) {
  const len = (m) => (m && m.content ? m.content.length : 0);
  const total = messages.reduce((n, m) => n + len(m), 0);
  if (total <= maxChars || messages.length <= 2) return messages;
  const trimmed = [...messages];
  while (trimmed.length > 2 && trimmed.reduce((n, m) => n + len(m), 0) > maxChars) {
    trimmed.shift();
  }
  return trimmed;
}

// 多轮对话：渲染端维护完整 messages 历史，主进程截断后逐 token 推回（chat:progress），返回完整内容与用量
ipcMain.handle('chat:message', async (event, { messages, configId }) => {
  const settings = loadSettings();
  const { baseURL, apiKey, model, provider, label } = resolveModelConfig(settings, configId);
  const proxy = settings.proxy || '';
  let endpoint = baseURL || '';
  try { endpoint = new URL(baseURL).host; } catch (_) { /* 保留原串 */ }
  console.log('[chat:message] configId=', JSON.stringify(configId), '-> resolved model=', model, 'baseURL=', baseURL);
  debugAppend('CHAT-RECV', `configId=${JSON.stringify(configId)} -> provider=${provider || ''} label=${label || ''} model=${model} endpoint=${endpoint} keyLen=${apiKey ? apiKey.length : 0}`);
  if (!apiKey) {
    throw new Error('请先在「设置」中填写外部大模型的 API Key');
  }
  if (!Array.isArray(messages) || messages.length === 0) {
    throw new Error('消息内容为空');
  }
  const res = await chatStream({
    baseURL,
    apiKey,
    model,
    messages: trimMessages(messages),
    temperature: 0.7,
    proxy,
    onToken: (delta) => {
      if (mainWindow) mainWindow.webContents.send('chat:progress', { delta });
    },
  });
  debugAppend('CHAT-CALL', `endpoint=${endpoint} model=${model} -> got ${res.content ? res.content.length : 0} chars`);
  // 把后端实际调用的模型 + 端点回传渲染端，便于在界面直接确认「切换是否真的生效」
  return { ...res, model, provider, label, endpoint };
});

// PSE 工作流：Planner->Specialist->Evaluator 编排，主进程流式推送进度（workflow:progress）。
// 同一时刻仅允许一个工作流运行；通过 AbortController 支持「停止」。
let workflowAbort = null;

// 项目目录选择：弹系统目录选择器，返回 { canceled, dir, name }
ipcMain.handle('workflow:pickProject', async () => {
  const res = await dialog.showOpenDialog(mainWindow, {
    title: '选择项目目录',
    properties: ['openDirectory'],
  });
  if (res.canceled || !res.filePaths || !res.filePaths.length) {
    return { canceled: true };
  }
  const dir = res.filePaths[0];
  return { canceled: false, dir, name: path.basename(dir) };
});

ipcMain.handle('workflow:run', async (event, { task, projectDir, models, allowExec, taskTypeOverride, maxRetry, steps }) => {
  const settings = loadSettings();
  if (!settings.apiKey) {
    throw new Error('请先在「设置」中填写外部大模型的 API Key');
  }
  if (!task || !String(task).trim()) {
    throw new Error('任务内容为空');
  }
  // projectDir 可选；给了就必须真实存在且是目录（防止渲染端传入过期路径）
  if (projectDir) {
    try {
      if (!fs.statSync(projectDir).isDirectory()) throw new Error('不是目录');
    } catch (e) {
      throw new Error(`项目目录不可用：${projectDir}（${e.message}）。请重新选择项目。`);
    }
  }
  if (workflowAbort) {
    throw new Error('已有工作流在运行，请先点击「停止」');
  }
  const ac = new AbortController();
  workflowAbort = ac;
  resetApprovals(); // 每次运行重置「记住的项目」授权记忆
  // 异步执行，进度通过 webContents.send 推送；结束后清空 running 标记
  runWorkflow({
    task: String(task).trim(),
    settings,
    projectDir: projectDir || null,
    signal: ac.signal,
    models: models && typeof models === 'object' ? models : undefined,
    allowExec: !!allowExec,
    taskTypeOverride: typeof taskTypeOverride === 'string' ? taskTypeOverride : undefined,
    maxRetry: typeof maxRetry === 'number' ? maxRetry : undefined,
    steps: Array.isArray(steps) && steps.length ? steps : undefined,
    onEvent: (ev) => {
      if (mainWindow) mainWindow.webContents.send('workflow:progress', ev);
    },
  })
    .then(() => { workflowAbort = null; })
    .catch((e) => {
      workflowAbort = null;
      if (mainWindow) mainWindow.webContents.send('workflow:progress', { type: 'error', message: e && e.message ? e.message : String(e) });
    });
  return { started: true };
});

// 受控命令执行：渲染端对用户授权弹窗的回执（允许/拒绝 + 是否记住本项目）。
// 由 main/executor.js 的 requestApproval 等待此回执后继续。
ipcMain.handle('workflow:exec-approve', (event, { requestId, allow, remember }) => {
  return resolveApproval(requestId, !!allow, !!remember);
});

ipcMain.handle('workflow:stop', () => {
  if (workflowAbort) {
    workflowAbort.abort();
    workflowAbort = null;
    return true;
  }
  return false;
});

// 打开运行日志目录（开发期项目根 logs/，打包后 userData/logs）：每次 PSE 运行的结构化记录都归档在那里。
ipcMain.handle('workflow:openLogs', async () => {
  const dir = logsDir();
  try {
    await shell.openPath(dir);
  } catch (_) {
    /* 打开失败不影响主流程 */
  }
  return dir;
});

// 导出代码：从工作流交付物提取代码文件 -> 用户确认 -> 写入选定目录
ipcMain.handle('export:extract', async (event, { steps }) => {
  const settings = loadSettings();
  return extractFiles({ steps, settings });
});

ipcMain.handle('export:write', async (event, { dir, files, overwrite, sandbox, forceCritical }) => {
  if (!dir) throw new Error('未选择导出目录');
  return writeFiles(dir, files || [], {
    overwrite: !!overwrite,
    sandbox: sandbox !== false, // 默认开启沙箱，绝不碰现有文件
    forceCritical: !!forceCritical,
  });
});

ipcMain.handle('export:pickDir', async () => {
  const res = await dialog.showOpenDialog(mainWindow, {
    title: '选择导出目录',
    properties: ['openDirectory'],
  });
  if (res.canceled || !res.filePaths || !res.filePaths.length) {
    return { canceled: true };
  }
  return { canceled: false, dir: res.filePaths[0] };
});

// 现代 Electron 推荐用 whenReady() 替代已废弃的 app.on('ready')
app.whenReady().then(() => {
  createWindow();

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      createWindow();
    }
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    app.quit();
  }
});
