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
├── main/              # 主进程业务逻辑（workflow / executor / llm / project ...）
├── src/               # React 渲染进程（CRA 结构）
├── build/             # CRA 生产构建产物（打包时由 Electron 加载）
└── dist/              # electron-builder 打包输出
```

## PSE 工作流模块（Workflow）

桌面端的「规划 → 执行 → 独立验证」闭环，用于把自然语言任务落地成可验证的代码/产物。
核心思想是 **Planner / Specialist / Evaluator 三角色分离 + 证据驱动验证**：

- **Planner**：把任务拆解成可独立执行、可独立验收的步骤（每步带验收标准 AC）。
- **Specialist**：按步骤产出交付物，可执行真实命令（编译、跑测试、起服务等）。
- **Evaluator**：**独立采集证据**（退出码、标准输出、端口探活、测试报告）判 PASS / PARTIAL / FAIL / BLOCKED，**不采信执行者自述**；PARTIAL/FAIL 触发有界重试（≤3 次）并保留证据。

### 任务无关化（task-agnostic）

编排骨架不绑定任何技术栈；栈相关的「构建命令 / 启动验证 / 期望响应」由 `TASK_PROFILES` 按任务类型注入到 Specialist 提示词：

| profile | 触发场景 | 验证形态 |
| --- | --- | --- |
| `spring` | Java / Spring Boot 工程 | `mvn package` + `java -jar` + 端口探活 |
| `python` | Python 脚本 / 服务 | `python xxx.py` / `pytest` 跑真实输出 |
| `frontend` | React / Vite 等前端 | `npm install` + `npm run build` / dev server 探活 |
| `generic` | 其他（review、文档等） | 按本步骤技术栈自选真实运行/测试命令取证 |

任务类型由 `detectTaskType(task)` 粗分类，缺省退化为 `generic`；通用内核（写文件前建父目录、跨步骤/重试复用同一工程目录名、幂等、不声称没做的事）对所有任务生效。

### 运行与通信

- 主进程 `main/workflow.js` 提供 `workflow:run`（单实例流式，AbortController 可中止）、`workflow:progress`（步骤/评估事件）、`workflow:stop`。
- 渲染端 `src/modules/WorkflowModule.js` 只负责把任务交给主进程、流式接收事件并呈现计划/步骤/评估时间线 + verdict 徽章 + 报告复制。
- 可选「项目选择」（`workflow:pickProject` → `main/project.js` 只读采集受限目录树 + 关键文件摘要）注入项目上下文；复用「设置」里的 baseURL / model / API Key，不新增凭证。

### 验证纪律

- Evaluator 只看**真实运行结果**，不采纳 Specialist 的"我已完成"自述。
- 失败重试有界且**每次留证据**，收敛不了如实报 FAIL，不假装通过。
- 命令执行受沙箱约束（读根收紧、构建命令超时放宽至 600s），非无限制 shell。
