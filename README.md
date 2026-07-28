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
| `pnpm run dev` | **One-shot dev mode**: launches the CRA dev server in the background, then auto-opens the Electron window once port 3000 is ready (`BROWSER=none` avoids a duplicate browser) |
| `pnpm run build` | CRA production build into `build/` (asset paths use `homepage: "./"` for relative paths, avoiding `file://` blank screen) |
| `pnpm run electron` | Launch Electron alone (requires `build/` or a running dev server first) |
| `pnpm run dist` | Package an installer with electron-builder, output to `dist/` |

## Packaging

```bash
pnpm run build   # 1. produce build/
pnpm run dist    # 2. package the platform installer
```

The packaged file list is in `package.json` `build.files` (includes `build/`, `electron.js`, `preload.js`) with `asar` enabled. The packaged product name is **Agent Workflow** (set via `productName`).

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
├── main/              # main-process business logic (workflow / executor / llm / project ...)
├── src/               # React renderer (CRA structure)
├── build/             # CRA production build output (loaded by Electron when packaged)
└── dist/              # electron-builder packaging output
```

## PSE Workflow module

A desktop "Plan → Execute → Independently Verify" loop that turns a natural-language task into verifiable code/artifacts.
Core idea: **Planner / Specialist / Evaluator role separation + evidence-driven verification**.

- **Planner**: breaks the task into independently executable and independently verifiable steps (each with acceptance criteria / AC).
- **Specialist**: produces deliverables per step and can run real commands (compile, run tests, start services, ...).
- **Evaluator**: **collects evidence independently** (exit code, stdout/stderr, port probing, test reports) and decides PASS / PARTIAL / FAIL / BLOCKED. It does **not** trust the executor's self-report. PARTIAL/FAIL triggers bounded retries (≤3) with evidence retained each time.

### Task-agnostic

The orchestration skeleton is not bound to any stack. Stack-specific "build command / startup verification / expected response" is injected into the Specialist prompt by `TASK_PROFILES` based on task type:

| profile | triggered for | verification shape |
| --- | --- | --- |
| `spring` | Java / Spring Boot projects | `mvn package` + `java -jar` + port probing |
| `python` | Python scripts / services | `python xxx.py` / `pytest` real output |
| `frontend` | React / Vite and similar | `npm install` + `npm run build` / dev-server probing |
| `generic` | others (review, docs, ...) | pick real run/test commands per the step's stack |

Task type is coarsely classified by `detectTaskType(task)`, defaulting to `generic`. A common kernel (create parent dir before writing, reuse the same project dir name across steps/retries, idempotent, never claim undone work) applies to all tasks.

### Running & communication

- Main process `main/workflow.js` exposes `workflow:run` (single streaming instance, abortable via AbortController), `workflow:progress` (step/evaluation events), `workflow:stop`.
- Renderer `src/modules/WorkflowModule.js` only hands the task to the main process and renders the plan / step / evaluation timeline + verdict badge + report copy.
- Optional "project picker" (`workflow:pickProject` → `main/project.js`) read-only collects a bounded directory tree + key file summaries to inject project context; reuses the baseURL / model / API Key from Settings, no new credentials.

### Verification discipline

- The Evaluator only looks at **real run results**, never the Specialist's "I'm done" self-report.
- Failed retries are bounded and **leave evidence each time**; if it does not converge, it reports FAIL honestly instead of faking success.
- Command execution is sandbox-constrained (tightened read roots, build-command timeout relaxed to 600s), not an unrestricted shell.
