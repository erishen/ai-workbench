# ai-workbench

基于 **Create React App (react-scripts 5)** + **Electron 31** 的本地桌面 AI 工作台。
已在安全基线上配置：`nodeIntegration: false` + `contextIsolation: true`，渲染进程仅经 `preload.js` 暴露的 `window.electronAPI` 桥与主进程通信。

English: [README.md](./README.md)

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
| `pnpm run dev` | **开发模式一键联动**：后台起 CRA 开发服务器，待 5180 端口就绪后自动拉起 Electron 窗口（已设 `BROWSER=none` 避免重复开浏览器） |
| `pnpm run build` | CRA 生产构建到 `build/`（资源路径已用 `homepage: "./"` 改为相对路径，避免 `file://` 白屏） |
| `pnpm run electron` | 单独启动 Electron（需先有 `build/` 或开发服务器） |
| `pnpm run dist` | 用 electron-builder 打包成安装包，输出到 `dist/` |

## 打包

```bash
pnpm run build   # 1. 先产出 build/
pnpm run dist    # 2. 打包成平台安装包
```

打包文件清单在 `package.json` 的 `build.files` 中（含 `build/`、`electron.js`、`preload.js`、`main/**/*`），并启用 `asar`。打包后的产品名为 **Agent Workflow**（由 `productName` 设定）。

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
ai-workbench/
├── electron.js        # 主进程：窗口、加载 URL、IPC handler
├── preload.js         # 预加载：contextBridge 安全桥
├── main/              # 主进程业务逻辑
│   ├── workflow.js         # PSE 编排（Planner→Specialist→Evaluator→[Reviewer]→Final）
│   ├── workflow-parse.js   # 纯函数：步骤/阶段归一化
│   ├── prompts.js          # 角色系统提示词 + TASK_PROFILES
│   ├── executor.js         # 只读沙箱命令执行 + 进程组 kill
│   ├── capabilities.js     # 探测本机工具链并注入 Planner
│   ├── runlog.js           # 结构化运行归档（JSON + markdown）
│   ├── llm.js              # LLM 客户端（流式）
│   └── project.js          # 可选：只读项目上下文采集
├── src/               # React 渲染进程（CRA 结构）
│   └── modules/
│       ├── ChatModule.js             # 多轮大模型对话（流式）
│       ├── TranslateModule.js        # 网页 URL → 中英互译
│       ├── WorkflowModule.js         # 自主型 PSE 运行 UI
│       └── WorkflowDesignerModule.js # 图形化工作流设计器
├── build/             # CRA 生产构建产物（打包时由 Electron 加载）
└── dist/              # electron-builder 打包输出
```

## PSE 工作流模块（Workflow）

桌面端的「规划 → 执行 → 独立验证」闭环，用于把自然语言任务落地成可验证的代码/产物。
核心思想是 **角色分离（Planner / Specialist / Evaluator / Reviewer）+ 证据驱动验证 + 受治理自主**：

- **Planner**：把任务拆解成可独立执行、可独立验收的步骤（每步带验收标准 AC）。
- **Specialist**：按步骤产出交付物，可执行真实命令（编译、跑测试、起服务等）。
- **Evaluator**：**独立采集证据**（退出码、标准输出、端口探活、测试报告）判 `PASS` / `PARTIAL` / `FAIL` / `BLOCKED`，**不采信执行者自述**。（`SKIPPED` 由引擎在 fail-fast 跳过后续步骤时赋值，见下文。）
- **Reviewer**（可选闸门）：第二道独立复核，步骤被接受前再验一遍。

每个步骤跑一条可配置的 `phases` 序列（默认 `specialist → evaluator`；可追加 `reviewer`）。**最后一个出 verdict 的阶段**判 PARTIAL/FAIL 时，触发有界「整步重试」（≤ `maxRetry`），且每次保留证据。

当某步判 `FAIL` 或 `BLOCKED` 时，其后续所有步骤会被标记 `SKIPPED` 并不再执行（**fail-fast**）。`SKIPPED` 步骤不计入整体结论，因此一个真实的失败不会级联成一连串假 FAIL。

### 两种运行模式

- **自主型（默认）**：设计器留白，引擎在运行时由 **Planner 自动拆解**任务。这即"受治理自主"——模型决定*怎么*达成每步，系统约束*能做什么*（见下方护栏）。
- **编排型（可选）**：用图形化工作流设计器预先写死步骤（标题、AC、依赖、每步 `phases`、verify 要点、重试上限）。引擎跳过 Planner，严格按这些步骤驱动。

### 任务无关化（task-agnostic）

编排骨架不绑定任何技术栈；栈相关的「构建命令 / 启动验证 / 期望响应」由 `TASK_PROFILES` 按任务类型注入到 Specialist 提示词：

| profile | 触发场景 | 验证形态 |
| --- | --- | --- |
| `spring` | Java / Spring Boot 工程 | `mvn package` + `java -jar` + 端口探活 |
| `python` | Python 脚本 / 服务 | `python xxx.py` / `pytest` 跑真实输出 |
| `frontend` | React / Vite 等前端 | `npm install` + `npm run build` / dev server 探活 |
| `generic` | 其他（review、文档等） | 按本步骤技术栈自选真实运行/测试命令取证 |

任务类型由 `detectTaskType(task)` 粗分类，缺省退化为 `generic`；通用内核（写文件前建父目录、跨步骤/重试复用同一工程目录名、幂等、不声称没做的事）对所有任务生效。

### 本机能力感知

`capabilities.js` 探测**本机工具链**（`command -v` 查 php/composer/mvn/gradle/node/java/python3/go/…）并注入 Planner，使其只规划本机真能执行的任务——从而让自主模式可靠，而不是凭空规划出不可能的步骤。

### 运行与通信

- 主进程 `main/workflow.js` 提供 `workflow:run`（单实例流式，AbortController 可中止）、`workflow:progress`（步骤/评估事件）、`workflow:stop`、`workflow:designer:list`（返回 `hasSteps`）、`workflow:openLogs`（打开运行日志目录）。
- 渲染端 `src/modules/WorkflowModule.js` 驱动自主运行，呈现计划/步骤/评估时间线 + verdict 徽章 + 报告复制。
- 渲染端 `src/modules/WorkflowDesignerModule.js` 即图形化设计器：SVG 节点画布 + 顺序/依赖箭头 + 详情面板；编辑每步的 phases/依赖/verify/重试后，把作者化步骤交给 `workflow:run`。
- 可选「项目选择」（`workflow:pickProject` → `main/project.js` 只读采集受限目录树 + 关键文件摘要）注入项目上下文；复用「设置」里的 baseURL / model / API Key，不新增凭证。

### 验证纪律与护栏

- Evaluator / Reviewer 只看**真实运行结果**，不采纳 Specialist 的"我已完成"自述。
- 某步 `FAIL`/`BLOCKED` 触发 **fail-fast**：后续步骤变为 `SKIPPED`（不执行、不计入结论）。
- **FAIL 是例外，不是默认。** 验证策略「默认从宽、FAIL 从严」：`FAIL` 仅保留给"证据可证伪的缺陷"——虚构内容、无法运行的交付物、验收标准被实质性未满足。探索 / 审查 / 收集类步骤只要做了核心动作（真读了代码、真采集到了文件），**至多判 PARTIAL**，绝不会因为"不够生产级""可改进"就 FAIL。这避免了开放式任务被过度判失败。
- **安全降级**：若验证阶段未能产出可解析的 JSON（例如模型泄漏了 `<tool_call>`/XML 标签而非 verdict 对象），该步降级为 `PARTIAL`、工作流继续，而不会让整条运行崩溃。
- 失败重试有界且**每次留证据**，收敛不了如实报 FAIL，不假装通过。
- 命令执行受**沙箱约束**：只读白名单（`READONLY_ALLOWED`）、中止时杀进程组、移除 `sed`/`awk` 防写禁令绕过——非无限制 shell。
- 每次运行由 `runlog.js` 归档到 `~/Library/Application Support/ai-workbench/logs/`，同时存结构化 JSON 与人读 markdown 报告。

### API Key 存储

LLM 凭证存于 **macOS 系统钥匙串**（经 `security` 命令）；`settings.json` 仅存非敏感配置（baseURL / model）。开发默认值放在 git 忽略的 `.env` 中，绝不打进安装包。

## 工作流设计器（Workflow Designer）

图形化设计器（`src/modules/WorkflowDesignerModule.js`）让你自己编排工作流，而非依赖运行时 Planner。

- **画布**：可拖拽 SVG 节点，箭头连接——蓝色=执行顺序，橙色=依赖。
- **详情面板**：编辑每步的标题 / 描述 / 验收标准 / `verify` 要点 / 依赖 / `phases`（增删重排 `specialist` / `evaluator` / `reviewer`）/ 重试上限 / 触发重试判定。
- **运行**：把作者化步骤交给 `workflow:run`；引擎跳过 Planner 严格按步骤执行。点 **「加载示例编排」** 可恢复一套 3 步样例（specialist → evaluator → reviewer，含依赖链）。
- **默认**：打开即空白 → 自主模式（Planner 自动拆解）。设计器是可选的高级入口，非主路径。

## 对话模块（Chat）

一个轻量多轮对话界面（`src/modules/ChatModule.js`），用于和「设置」中配置的任何 OpenAI 兼容模型聊天。

- 响应逐 token 流式渲染。
- 复用与工作流引擎相同的 baseURL / model / API Key 预设（凭证存于 macOS 钥匙串），无需额外配置。
- 底部操作栏：**发送**（流式期间显示为禁用的「正在回复…」态）与**清空对话**。

## 翻译模块（Translate）

粘贴一个网页 URL（`src/modules/TranslateModule.js`），模块会自动识别页面是中/英文并互译。适合在应用内快速阅读外文文档。

---

## 相关文章
- [不信任执行者：桌面 AI 工作台的验证架构设计](https://erishen.cn/ai_workbench/)
