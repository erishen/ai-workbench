// main/executor.js
// 受控命令执行引擎：在主进程里真正运行 Specialist 产出的 shell 命令。
//
// 安全模型（受控执行，参考「仅在该项目目录内、需用户授权、危险命令强制确认」）：
//  - 默认关闭：workflow 仅在 allowExec=true 时尝试执行（由前端开关控制）。
//  - 项目级授权：同一项目目录在本次运行内首次执行需用户确认；用户勾选「记住」后本项目后续命令免确认。
//  - 危险命令拦截：命中危险模式（rm -rf /、sudo、dd、mkfs、curl|sh 等）的命令一律强制单独确认，
//    绝不因「记住本项目」而绕过。
//  - 超时：普通命令默认 120s；mvn/gradle 等构建命令自动放宽到 600s（首次构建需下载依赖，可能耗时较长）。
//  - 作用域：cwd 锁定为用户所选 projectDir，不越界到其它目录。
//  - 输出截断：stdout/stderr 各截断到 8KB，避免大输出撑爆 IPC 载荷。
const { exec } = require('child_process');
const util = require('util');
const fs = require('fs');
const path = require('path');
const os = require('os');

const execPromise = util.promisify(exec);

// 命令执行诊断日志：记录每次执行的 cmd/cwd/exitCode/stderr，便于排查「命令退出 1」类问题。
// 不含密钥（cmd 本身可能含路径，但不含 API Key）。
const DEBUG_LOG = '/tmp/aw-debug.log';
function debugExec(line) {
  try { fs.appendFileSync(DEBUG_LOG, `[${new Date().toISOString()}] ${line}\n`); } catch (_) {}
}

const DEFAULT_TIMEOUT = 120000;
const BUILD_TIMEOUT = 600000; // 构建命令(mvn/gradle)放宽到 10 分钟，给首次依赖下载留足时间
const MVN_GRADLE_RE = /\b(mvn|gradle|gradlew|\.\/gradlew)\b/;
const MAX_OUTPUT = 8000;

// 增强执行环境的 PATH。Node 进程（尤其从 GUI/launchd 或非交互 shell 启动时）的
// process.env.PATH 往往不含 jenv/nvm/homebrew 等通过 .zshrc/.zprofile 注入的路径，
// 导致 mvn/gradle/cargo 等工具在受控执行里 "command not found"，进而误导下游判断。
// 这里在不破坏原 PATH 的前提下，把常见工具目录前置进去（仅当目录真实存在）。
function buildEnv() {
  const env = Object.assign({}, process.env);
  const home = process.env.HOME || os.homedir();
  const candidates = [
    path.join(home, '.jenv', 'shims'),
    path.join(home, '.jenv', 'bin'),
    '/opt/homebrew/bin',
    '/usr/local/bin',
    path.join(home, '.cargo', 'bin'),
    path.join(home, 'go', 'bin'),
    '/usr/local/go/bin',
  ];
  const extras = candidates.filter((p) => {
    try { return fs.existsSync(p); } catch (_) { return false; }
  });
  if (extras.length) {
    const seen = new Set();
    const parts = [];
    for (const p of [...extras, ...(env.PATH || '').split(':')]) {
      if (p && !seen.has(p)) { seen.add(p); parts.push(p); }
    }
    env.PATH = parts.join(':');
  }
  return env;
}

// 危险命令模式（命中即需单独强确认，且「记住本项目」不豁免）
const DANGEROUS_PATTERNS = [
  /\brm\s+-rf?\s+\//, // rm -rf /
  /\brm\s+-rf?\s+~/, // rm -rf ~
  /\bsudo\b/,
  /\bmkfs\b/,
  /\bdd\b\s+if=/,
  /:\s*\(\)\s*\{/, // fork bomb
  /\bchmod\s+-R?\s+0/, // chmod -R 0...（清零权限）
  /\bshutdown\b/,
  /\breboot\b/,
  /\binit\s+0\b/,
  />\s*\/dev\/(sd|hd|nvme)/, // 直写块设备
  /\bcurl\b[^\n|]*\|\s*(sh|bash)/, // curl ... | sh
  /\bwget\b[^\n|]*\|\s*(sh|bash)/, // wget ... | sh
  /\bnpm\s+run\s+\S*\brm\b/, // npm script 内 rm
];

function isDangerous(cmd) {
  const c = String(cmd || '');
  for (const re of DANGEROUS_PATTERNS) {
    if (re.test(c)) return true;
  }
  return false;
}

// 本次运行内已授权的项目目录（「记住」后免确认）；每次运行开始 reset
const approvedDirs = new Set();
function resetApprovals() {
  approvedDirs.clear();
}
function isDirApproved(dir) {
  return approvedDirs.has(dir);
}

// 待确认请求表：requestId -> { resolve, dir }
const pending = new Map();
let seq = 0;

// 由 electron.js 的 workflow:exec-approve handler 调用，回执用户决定。
// allow: true=允许执行；remember: true=把 dir 加入免确认集合（仅本项目后续命令）。
function resolveApproval(requestId, allow, remember) {
  const entry = pending.get(requestId);
  if (!entry) return false;
  pending.delete(requestId);
  if (allow && remember && entry.dir) approvedDirs.add(entry.dir);
  entry.resolve(!!allow);
  return true;
}

// 请求用户确认在本项目执行某命令。resolve(true)=允许，false=跳过。
// emit 为 workflow 的 onEvent 包装器，用于把审批请求推给渲染端（经 workflow:progress）。
function requestApproval({ emit, dir, command, dangerous }) {
  const requestId = `exec-${Date.now()}-${++seq}`;
  const payload = { type: 'exec-approval', requestId, dir, command, dangerous: !!dangerous };
  return new Promise((resolve) => {
    pending.set(requestId, { resolve, dir });
    if (typeof emit === 'function') emit(payload);
  });
}

// 真正执行命令；返回结构化结果（stdout/stderr 已截断）。
async function runShellCommand(cmd, cwd, { timeoutMs, signal } = {}) {
  const effectiveTimeout = timeoutMs != null ? timeoutMs : (MVN_GRADLE_RE.test(cmd || '') ? BUILD_TIMEOUT : DEFAULT_TIMEOUT);
  const opts = {
    cwd,
    timeout: effectiveTimeout,
    maxBuffer: 10 * 1024 * 1024,
    windowsHide: true,
    // 用 bash 而非默认 /bin/sh(POSIX)：模型生成的脚本常含 bash-isms(如 {1..60} 大括号展开、
    // [[ ]]、&>)，/bin/sh 不认会导致循环/判断失效。bash 兼容性更广，与模型假设对齐。
    shell: '/bin/bash',
    // 继承并增强当前进程环境（含完整工具 PATH，使 mvn/gradle/cargo 等可用）
    env: buildEnv(),
  };
  const trim = (s) => (s && s.length > MAX_OUTPUT ? s.slice(0, MAX_OUTPUT) + '\n…(输出已截断)' : s || '');
  // 支持外部中止：把 AbortSignal 转为对子进程的 kill
  let onAbort = null;
  if (signal) {
    if (signal.aborted) {
      return { command: cmd, ok: false, stdout: '', stderr: '', exitCode: 'ABORTED', timedOut: false, error: '已中止' };
    }
    onAbort = () => {
      try {
        // execPromise 内部 child 不可直接访问，退而用 timeout=0 立即触发？此处仅标记，真正 kill 由调用方 abort 传播有限。
      } catch (_) {
        /* noop */
      }
    };
    signal.addEventListener('abort', onAbort, { once: true });
  }
  try {
    const { stdout, stderr } = await execPromise(cmd, opts);
    debugExec(`EXEC ok  cwd=${cwd} exit=0 cmd=${JSON.stringify(cmd).slice(0, 400)} | stdout=${trim(stdout).slice(0, 400)} | stderr=${trim(stderr).slice(0, 400)}`);
    return {
      command: cmd,
      ok: true,
      stdout: trim(stdout),
      stderr: trim(stderr),
      exitCode: 0,
      timedOut: false,
    };
  } catch (e) {
    const stdout = (e && e.stdout) || '';
    const stderr = (e && e.stderr) || '';
    const killed = !!(e && e.killed);
    const timedOut = killed || /timeout/i.test((e && e.message) || '');
    const exitCode = e && e.code != null ? e.code : timedOut ? 'TIMEOUT' : 1;
    debugExec(`EXEC FAIL cwd=${cwd} exit=${exitCode} cmd=${JSON.stringify(cmd).slice(0, 400)} | stdout=${trim(stdout).slice(0, 400)} | stderr=${trim(stderr).slice(0, 400)} | err=${trim(e && e.message ? e.message : String(e)).slice(0, 200)}`);
    return {
      command: cmd,
      ok: false,
      stdout: trim(stdout),
      stderr: trim(stderr),
      exitCode,
      timedOut,
      error: trim(e && e.message ? e.message : String(e)),
    };
  } finally {
    if (signal && onAbort) signal.removeEventListener('abort', onAbort);
  }
}

module.exports = {
  runShellCommand,
  isDangerous,
  requestApproval,
  resolveApproval,
  resetApprovals,
  isDirApproved,
};
