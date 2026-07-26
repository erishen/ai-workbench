// electron.js
const { app, BrowserWindow, ipcMain } = require('electron');
const path = require('path');

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

  (async () => {
    const isDev = (await import('electron-is-dev')).default;
    const startURL = isDev
      ? 'http://localhost:3000'
      : `file://${path.join(__dirname, '../build/index.html')}`;
    mainWindow.loadURL(startURL);
  })();

  mainWindow.on('closed', () => (mainWindow = null));
}

// 渲染进程经 window.electronAPI.getAppVersion() 调用，返回 package.json 的 version
ipcMain.handle('get-app-version', () => app.getVersion());

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
