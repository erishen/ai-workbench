# ai-workbench

A local desktop AI workbench built on **Create React App (react-scripts 5)** + **Electron 31**.
Configured on a secure baseline: `nodeIntegration: false` + `contextIsolation: true`. The renderer process talks to the main process only through the `window.electronAPI` bridge exposed by `preload.js`.

中文文档：[README.zh](./README.zh)

## Prerequisites

This project uses **pnpm** (a bundled `.npmrc` sets `shamefully-hoist=true` for react-scripts compatibility).

```bash
pnpm install
```

> The first install downloads the Electron binary (large, requires network). If it is slow, set a mirror:
> `ELECTRON_MIRROR="https://registry.npmmirror.com/-/binary/electron/" pnpm install`

## Common scripts

| Command | Purpose |
| --- | --- |
| `pnpm start` | Start only the CRA dev server (http://localhost:3000, for browser debugging) |
| `pnpm run dev` | **One-shot dev mode**: launches the CRA dev server in the background, then auto-opens the Electron window once port 5180 is ready (`BROWSER=none` avoids a duplicate browser) |
| `pnpm run build` | CRA production build into `build/` (asset paths use `homepage: "./"` for relative paths, avoiding `file://` blank screen) |
| `pnpm run electron` | Launch Electron alone (requires `build/` or a running dev server first) |
| `pnpm run dist` | Package an installer with electron-builder, output to `dist/` |

## Packaging

```bash
pnpm run build   # 1. produce build/
pnpm run dist    # 2. package the platform installer
```

The packaged file list is in `package.json` `build.files` (includes `build/`, `electron.js`, `preload.js`, `main/**/*`) with `asar` enabled. The packaged product name is **Agent Workflow** (set via `productName`).

## Renderer ↔ Main communication

The main process does not expose Node to the renderer; capabilities go through the `preload.js` allow-list bridge:

```js
// in the renderer
const version = await window.electronAPI.getAppVersion(); // returns package.json version

// subscribe to main-process pushes (allow-listed channel: update-message)
window.electronAPI.onMessage('update-message', (payload) => {
  console.log(payload);
});
```

To add a capability, follow two steps:
1. Register it in the main process `electron.js` with `ipcMain.handle('xxx', ...)` or `ipcMain.on('xxx', ...)`.
2. Expose it explicitly in `preload.js` via `contextBridge.exposeInMainWorld` (push channels must be added to the `VALID_INBOUND_CHANNELS` allow-list).

## Directory structure

```
ai-workbench/
├── electron.js        # main process: window, URL loading, IPC handlers
├── preload.js         # preload: contextBridge secure bridge
├── main/              # main-process business logic
│   ├── workflow.js         # PSE orchestration (Planner→Specialist→Evaluator→[Reviewer]→Final)
│   ├── workflow-parse.js   # pure step/phase normalization helpers
│   ├── prompts.js          # role/system prompts + TASK_PROFILES
│   ├── executor.js         # read-only sandboxed command runner + process-group kill
│   ├── capabilities.js     # probe local toolchain, inject into Planner
│   ├── runlog.js           # structured run archive (JSON + markdown)
│   ├── llm.js              # LLM client (streaming)
│   └── project.js          # optional read-only project context collector
├── src/               # React renderer (CRA structure)
│   └── modules/
│       ├── ChatModule.js             # multi-turn LLM chat (streaming)
│       ├── TranslateModule.js        # URL → zh/en translation
│       ├── WorkflowModule.js         # autonomous PSE runner UI
│       └── WorkflowDesignerModule.js # graphical workflow designer
├── build/             # CRA production build output (loaded by Electron when packaged)
└── dist/              # electron-builder packaging output
```

## PSE Workflow module

A desktop **Plan → Execute → Independently Verify** loop that turns a natural-language task into verifiable code/artifacts.
Core idea: **role separation (Planner / Specialist / Evaluator / Reviewer) + evidence-driven verification + governed autonomy**.

- **Planner**: breaks the task into independently executable and verifiable steps (each with acceptance criteria / AC).
- **Specialist**: produces deliverables per step and can run real commands (compile, test, start services, ...).
- **Evaluator**: **collects evidence independently** (exit code, stdout/stderr, port probing, test reports) and decides `PASS` / `PARTIAL` / `FAIL` / `BLOCKED`. It does **not** trust the executor's self-report. (`SKIPPED` is engine-assigned when a later step is skipped by fail-fast; see below.)
- **Reviewer** (optional gate): a second, independent pass that re-verifies before the step is accepted.

Each step runs a configurable `phases` sequence (default `specialist → evaluator`; `reviewer` can be appended). PARTIAL/FAIL from the **last verdict-issuing phase** triggers a bounded whole-step retry (≤ `maxRetry`), with evidence retained each time.

When a step ends `FAIL` or `BLOCKED`, all subsequent steps are marked `SKIPPED` and not executed (**fail-fast**). `SKIPPED` steps never influence the overall verdict, so one genuine failure cannot cascade into a string of false FAILs.

### Two operating modes

- **Autonomous (default)**: leave the designer blank and the engine lets the **Planner auto-decompose** the task at runtime. This is "governed autonomy" — the model decides *how* to achieve each step, while the system constrains *what* it may do (see guardrails below).
- **Orchestrated (optional)**: use the graphical Workflow Designer to pre-author fixed steps (titles, AC, dependencies, per-step `phases`, verify hints, retry limits). The engine then skips the Planner and drives those steps exactly.

### Task-agnostic

The orchestration skeleton is not bound to any stack. Stack-specific "build command / startup verification / expected response" is injected into the Specialist prompt by `TASK_PROFILES` based on task type:

| profile | triggered for | verification shape |
| --- | --- | --- |
| `spring` | Java / Spring Boot projects | `mvn package` + `java -jar` + port probing |
| `python` | Python scripts / services | `python xxx.py` / `pytest` real output |
| `frontend` | React / Vite and similar | `npm install` + `npm run build` / dev-server probing |
| `generic` | others (review, docs, ...) | pick real run/test commands per the step's stack |

Task type is coarsely classified by `detectTaskType(task)`, defaulting to `generic`. A common kernel (create parent dir before writing, reuse the same project dir name across steps/retries, idempotent, never claim undone work) applies to all tasks.

### Local capability awareness

`capabilities.js` probes the **local toolchain** (`command -v` for php/composer/mvn/gradle/node/java/python3/go/...) and injects the result into the Planner, so it only plans tasks the machine can actually run — keeping the autonomous mode reliable instead of hallucinating impossible steps.

### Running & communication

- Main process `main/workflow.js` exposes `workflow:run` (single streaming instance, abortable via AbortController), `workflow:progress` (step/evaluation events), `workflow:stop`, `workflow:designer:list` (returns `hasSteps`), and `workflow:openLogs` (open the run-log directory).
- Renderer `src/modules/WorkflowModule.js` drives the autonomous run and renders the plan / step / evaluation timeline + verdict badge + report copy.
- Renderer `src/modules/WorkflowDesignerModule.js` is the graphical designer: an SVG node canvas with order/dependency arrows and a detail panel; it edits each step's phases / dependencies / verify / retry, then hands the authored steps to `workflow:run`.
- Optional "project picker" (`workflow:pickProject` → `main/project.js`) read-only collects a bounded directory tree + key file summaries to inject project context; reuses the baseURL / model / API Key from Settings, no new credentials.

### Verification discipline & guardrails

- The Evaluator/Reviewer only look at **real run results**, never the Specialist's "I'm done" self-report.
- A step ending `FAIL`/`BLOCKED` triggers **fail-fast**: later steps become `SKIPPED` (not executed, not counted toward the verdict).
- **FAIL is the exception, not the default.** The verification policy is *lenient by default, strict on FAIL*: `FAIL` is reserved for defects that evidence can actually refute — fabricated content, deliverables that cannot run, or acceptance criteria that are substantially unmet. Exploratory / review / collection steps that did the core work (e.g. really read the code, really collected the files) are at most `PARTIAL`, never `FAIL` merely for being "not production-grade" or "improvable". This keeps the loop from over-failing open-ended tasks.
- **Safe degradation:** if a verification phase fails to emit parseable JSON (e.g. the model leaks a `<tool_call>`/XML tag instead of the verdict object), the step is downgraded to `PARTIAL` and the workflow continues — it never crashes the whole run.
- Failed retries are bounded and **leave evidence each time**; if it does not converge, it reports FAIL honestly instead of faking success.
- Command execution is **sandbox-constrained**: a read-only allow-list (`READONLY_ALLOWED`), process-group kill on abort, and removal of `sed`/`awk` to prevent write-ban bypass. It is not an unrestricted shell.
- Every run is archived by `runlog.js` into `~/Library/Application Support/ai-workbench/logs/` as both structured JSON and a human-readable markdown report.

### API key storage

LLM credentials are kept in the **macOS Keychain** (via the `security` command); `settings.json` holds only non-secret config (baseURL / model). The dev default lives in a git-ignored `.env` and is never packaged.

## Workflow Designer

The graphical designer (`src/modules/WorkflowDesignerModule.js`) lets you author a workflow instead of relying on the runtime Planner.

- **Canvas**: draggable SVG nodes connected by arrows — blue = execution order, orange = dependency.
- **Detail panel**: edit each step's title / description / acceptance criteria / `verify` hints / dependencies / `phases` (add, remove, reorder `specialist` / `evaluator` / `reviewer`) / retry limit / retry trigger.
- **Run**: hand the authored steps to `workflow:run`; the engine skips the Planner and drives them exactly. A **"Load example orchestration"** button restores a 3-step sample (specialist → evaluator → reviewer with a dependency chain).
- **Default**: opens blank → autonomous mode (Planner auto-decomposes). The designer is an optional, advanced entry point, not the primary path.

## Chat module

A simple multi-turn chat UI (`src/modules/ChatModule.js`) for talking to any OpenAI-compatible model configured in Settings.

- Responses stream token-by-token.
- Reuses the same baseURL / model / API-key presets as the workflow engine (credentials are stored in the macOS Keychain), so no extra setup is needed.
- Bottom action bar: **Send** (shows a disabled "Replying…" state while streaming) and **Clear conversation**.

## Translate module

Paste a web-page URL (`src/modules/TranslateModule.js`); the module detects whether the page is Chinese or English and translates it into the other language. Handy for reading foreign documentation inline.

---

## Related Articles

- English: [ai_workbench: Desktop AI Workbench](https://erishen.cn/ai_workbench-en/)
- 中文: [ai_workbench：桌面 AI 工作台](https://erishen.cn/ai_workbench/)