// electron.js
const { app, BrowserWindow, ipcMain, dialog } = require('electron');
const path = require('path');
const fs = require('fs');
const { loadSettings, saveSettings } = require('./main/settings');
const { translateUrl } = require('./main/translate');
const { chatStream } = require('./main/llm');

// ---- 诊断（白屏排查用，确认后可删）----
const dbgLog = '/tmp/aw-debug.log';
const dbg = (s) => { try { fs.appendFileSync(dbgLog, `[${new Date().toISOString()}] ${s}\n`); } catch (e) {} };
dbg('MODULE LOADED');

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
  dbg('createWindow start');
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

  process.on('uncaughtException', (e) => dbg('uncaughtException: ' + (e && e.stack || e)));
  process.on('unhandledRejection', (e) => dbg('unhandledRejection: ' + (e && e.stack || e)));
  mainWindow.webContents.on('console-message', (e, level, message) => dbg('renderer[lvl=' + level + ']: ' + message));
  mainWindow.webContents.on('did-fail-load', (e, errorCode, errorDescription) => { dbg('did-fail-load: ' + errorCode + ' ' + errorDescription); try { dialog.showErrorBox('页面加载失败', 'code=' + errorCode + ' ' + errorDescription); } catch (_) {} });
  mainWindow.webContents.on('crashed', () => dbg('renderer crashed'));

  // 渲染完成后的内容抽样（确认白屏用，验证后可删）
  mainWindow.webContents.on('did-finish-load', () => {
    dbg('did-finish-load');
    setTimeout(() => {
      mainWindow.webContents.executeJavaScript(
        "JSON.stringify({rootLen:(document.getElementById('root')||{}).innerHTML?.length||0,title:document.title,bodyText:(document.body.innerText||'').slice(0,120)})"
      ).then((r) => dbg('RENDER-CHECK: ' + r)).catch((e) => dbg('RENDER-CHECK err: ' + e));
    }, 1500);
  });

  // 生产环境用 loadFile：内部走 pathToFileURL，自动编码 app 名中的空格与 asar 路径，
  // 规避「Agent Workflow.app」含空格导致 file:// 未编码 -> Chromium 解析失败 -> 白屏。
  if (!app.isPackaged) {
    mainWindow.loadURL('http://localhost:3000').then(() => dbg('loadURL resolved')).catch((e) => dbg('load dev url failed: ' + e));
  } else {
    mainWindow.loadFile(path.join(__dirname, 'build', 'index.html'))
      .then(() => dbg('loadFile resolved'))
      .catch((e) => { dbg('loadFile failed: ' + e); try { dialog.showErrorBox('页面加载失败', String(e)); } catch (_) {} });
  }

  mainWindow.on('closed', () => (mainWindow = null));
}

// 渲染进程经 window.electronAPI.getAppVersion() 调用，返回 package.json 的 version
ipcMain.handle('get-app-version', () => app.getVersion());

// ---- Agent Workflow：外部大模型设置 + URL 翻译 ----
ipcMain.handle('settings:get', () => loadSettings());

ipcMain.handle('settings:save', (event, partial) => saveSettings(partial));

ipcMain.handle('translate:url', async (event, { url }) => {
  const settings = loadSettings();
  if (!settings.apiKey) {
    throw new Error('请先在「设置」中填写外部大模型的 API Key');
  }
  return translateUrl(url, settings, (progress) => {
    if (mainWindow) mainWindow.webContents.send('translate:progress', progress);
  });
});

// 多轮对话：渲染端维护完整 messages 历史，主进程逐 token 推回（chat:progress），返回完整内容与用量
ipcMain.handle('chat:message', async (event, { messages }) => {
  const settings = loadSettings();
  if (!settings.apiKey) {
    throw new Error('请先在「设置」中填写外部大模型的 API Key');
  }
  if (!Array.isArray(messages) || messages.length === 0) {
    throw new Error('消息内容为空');
  }
  return chatStream({
    baseURL: settings.baseURL,
    apiKey: settings.apiKey,
    model: settings.model,
    messages,
    temperature: 0.7,
    onToken: (delta) => {
      if (mainWindow) mainWindow.webContents.send('chat:progress', { delta });
    },
  });
});

// 现代 Electron 推荐用 whenReady() 替代已废弃的 app.on('ready')
app.whenReady().then(() => {
  dbg('whenReady resolved');
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
