// electron.js
const { app, BrowserWindow, ipcMain } = require('electron');
const path = require('path');
const { loadSettings, saveSettings } = require('./main/settings');
const { translateUrl } = require('./main/translate');

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

  // 用内置 app.isPackaged 判断运行环境，避免依赖打包后缺失的 electron-is-dev 包。
  // 开发模式（pnpm dev / pnpm electron .）走 CRA dev server；打包后走本地 build 产物。
  const isDev = !app.isPackaged;
  const startURL = isDev
    ? 'http://localhost:3000'
    : `file://${path.join(__dirname, './build/index.html')}`;
  mainWindow.loadURL(startURL).catch((err) => {
    console.error('[main] 加载页面失败:', err);
  });

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
