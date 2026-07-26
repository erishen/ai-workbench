# Electron React App

基于 **Create React App (react-scripts 5)** + **Electron 31** 的桌面端基线。
已在安全基线上配置：`nodeIntegration: false` + `contextIsolation: true`，渲染进程仅经 `preload.js` 暴露的 `window.electronAPI` 桥与主进程通信。

## 环境准备

本项目使用 **pnpm**（已附 `.npmrc`：`shamefully-hoist=true` 以兼容 react-scripts）。

```bash
pnpm install
```

> 首次安装会下载 Electron 二进制（较大，需联网）。若下载缓慢，可设置镜像：
> `ELECTRON_MIRROR="https://registry.npmmirror.com/-/binary/electron/" pnpm install`

## 常用脚本

| 命令 | 作用 |
| --- | --- |
| `pnpm start` | 仅启动 CRA 开发服务器（http://localhost:3000，浏览器调试用） |
| `pnpm run dev` | **开发模式一键联动**：后台起 CRA 开发服务器，待 3000 端口就绪后自动拉起 Electron 窗口（已设 `BROWSER=none` 避免重复开浏览器） |
| `pnpm run build` | CRA 生产构建到 `build/`（资源路径已用 `homepage: "./"` 改为相对路径，避免 `file://` 白屏） |
| `pnpm run electron` | 单独启动 Electron（需先有 `build/` 或开发服务器） |
| `pnpm run dist` | 用 electron-builder 打包成安装包，输出到 `dist/` |

## 打包

```bash
pnpm run build   # 1. 先产出 build/
pnpm run dist    # 2. 打包成平台安装包
```

打包文件清单在 `package.json` 的 `build.files` 中（含 `build/`、`electron.js`、`preload.js`），并启用 `asar`。

## 渲染进程 ↔ 主进程通信

主进程能力不向渲染进程暴露 Node，需经 `preload.js` 的白名单桥：

```js
// 渲染进程中
const version = await window.electronAPI.getAppVersion(); // 返回 package.json 的 version

// 订阅主进程主动推送（仅白名单 channel：update-message）
window.electronAPI.onMessage('update-message', (payload) => {
  console.log(payload);
});
```

要新增能力，遵循两步：
1. 主进程 `electron.js` 用 `ipcMain.handle('xxx', ...)` 或 `ipcMain.on('xxx', ...)` 注册；
2. `preload.js` 在 `contextBridge.exposeInMainWorld` 中显式暴露（推送 channel 需加入 `VALID_INBOUND_CHANNELS` 白名单）。

## 目录结构

```
electron-react-app/
├── electron.js        # 主进程：窗口、加载 URL、IPC handler
├── preload.js         # 预加载：contextBridge 安全桥
├── src/               # React 渲染进程（CRA 结构）
├── build/             # CRA 生产构建产物（打包时由 Electron 加载）
└── dist/              # electron-builder 打包输出
```
