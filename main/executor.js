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
const fs = require('fs');
const path = require('path');
const os = require('os');

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
    path.join(home, '.local', 'bin'),
    path.join(home, '.npm-global', 'bin'), // 用户级 npm -g --prefix 安装目录（免 sudo 方案）
    path.join(home, 'bin'), // 用户级 composer 等安装目录
    path.join(home, '.composer', 'vendor', 'bin'), // composer global require 的可执行目录
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

// 预处理：剥离「整行注释」（行首可选空白后接 #），用于守卫匹配前。
// 避免模型在注释里写「避免需要 sudo」之类文字误触发 sudo 守卫，导致整条命令被拒。
// 仅去独立注释行，保留行内 #（如 URL/字符串），以免改变命令语义。
function stripCommentLines(cmd) {
  return String(cmd || '')
    .split('\n')
    .filter((line) => !/^\s*#/.test(line))
    .join('\n');
}

// 危险命令模式（命中即需单独强确认，且「记住本项目」不豁免）
const DANGEROUS_PATTERNS = [
  /\brm\s+-rf?\s+\//, // rm -rf /
  /\brm\s+-rf?\s+~/, // rm -rf ~
  /\bsudo\s+[\w-]/, // sudo 作为命令出现（后接空白+命令词/选项）；注释或字符串里的 sudo 不命中
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
  const c = stripCommentLines(cmd);
  for (const re of DANGEROUS_PATTERNS) {
    if (re.test(c)) return true;
  }
  return false;
}

// 绝对禁止的命令模式（不弹确认、直接拒绝执行）。
// 核心是交互式提权类：sudo 从「控制终端」(启动 pnpm dev / app 的那个 shell) 读密码，
// 密码提示不会出现在 Electron UI 里，只会挂死到超时，且存在把提权交给模型生成命令的安全风险。
const FORBIDDEN_PATTERNS = [
  { re: /\bsudo\s+[\w-]/, why: 'sudo 需要在终端交互输入密码（UI 收不到提示，只会挂到超时），且不允许把提权交给自动生成的命令。请改用用户级方案：npm 全局装 --prefix "$HOME/.npm-global"、composer 装 --install-dir="$HOME/bin"，并把对应 bin 目录加入 PATH。' },
  { re: /\bsu\s+(-|\w)/, why: 'su 切换用户是交互式提权，禁止。' },
  { re: /\bpasswd\b/, why: 'passwd 是交互式命令，禁止。' },
];

// 返回 null=允许；否则返回禁止原因（给 Evaluator/Specialist 的可读证据）。
function forbiddenReason(cmd) {
  const c = stripCommentLines(cmd);
  for (const { re, why } of FORBIDDEN_PATTERNS) {
    if (re.test(c)) return why;
  }
  return null;
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
  // 双保险：即使调用方忘了预检，这里也拒绝禁止命令（sudo 等），避免挂死在终端密码提示。
  const forbidden = forbiddenReason(cmd);
  if (forbidden) {
    debugExec(`EXEC FORBIDDEN cwd=${cwd} cmd=${JSON.stringify(cmd).slice(0, 400)} | why=${forbidden.slice(0, 200)}`);
    return { command: cmd, ok: false, stdout: '', stderr: `命令被禁止执行：${forbidden}`, exitCode: 'FORBIDDEN', timedOut: false, error: forbidden };
  }
  if (signal && signal.aborted) {
    return { command: cmd, ok: false, stdout: '', stderr: '', exitCode: 'ABORTED', timedOut: false, error: '已中止' };
  }
  const effectiveTimeout = timeoutMs != null ? timeoutMs : (MVN_GRADLE_RE.test(cmd || '') ? BUILD_TIMEOUT : DEFAULT_TIMEOUT);
  const opts = {
    cwd,
    timeout: effectiveTimeout,
    maxBuffer: 10 * 1024 * 1024,
    windowsHide: true,
    // 剥离控制终端(新会话)：漏网的交互式命令(如 sudo)会立即报 "no tty" 失败，
    // 而不是在启动 app 的那个终端里静默等待密码输入直到超时。
    detached: true,
    // 用 bash 而非默认 /bin/sh(POSIX)：模型生成的脚本常含 bash-isms(如 {1..60} 大括号展开、
    // [[ ]]、&>)，/bin/sh 不认会导致循环/判断失效。bash 兼容性更广，与模型假设对齐。
    shell: '/bin/bash',
    // 继承并增强当前进程环境（含完整工具 PATH，使 mvn/gradle/cargo 等可用）
    env: buildEnv(),
  };
  const trim = (s) => (s && s.length > MAX_OUTPUT ? s.slice(0, MAX_OUTPUT) + '\n…(输出已截断)' : s || '');
  return new Promise((resolve) => {
    // 手动持有 child，便于在中止时杀死整个进程组（detached 下 child.pid 为进程组 leader）。
    const child = exec(cmd, opts, (err, stdout, stderr) => {
      if (signal) signal.removeEventListener('abort', onAbort);
      const out = (stdout || '').toString();
      const errOut = (stderr || '').toString();
      if (!err) {
        debugExec(`EXEC ok  cwd=${cwd} exit=0 cmd=${JSON.stringify(cmd).slice(0, 400)} | stdout=${trim(out).slice(0, 400)} | stderr=${trim(errOut).slice(0, 400)}`);
        resolve({ command: cmd, ok: true, stdout: trim(out), stderr: trim(errOut), exitCode: 0, timedOut: false });
        return;
      }
      const killed = !!err.killed;
      const timedOut = killed || /timeout/i.test(err.message || '');
      const exitCode = err.code != null ? err.code : timedOut ? 'TIMEOUT' : 1;
      debugExec(`EXEC FAIL cwd=${cwd} exit=${exitCode} cmd=${JSON.stringify(cmd).slice(0, 400)} | stdout=${trim(out).slice(0, 400)} | stderr=${trim(errOut).slice(0, 400)} | err=${trim(err.message ? err.message : String(err)).slice(0, 200)}`);
      resolve({
        command: cmd,
        ok: false,
        stdout: trim(out),
        stderr: trim(errOut),
        exitCode,
        timedOut,
        error: trim(err.message ? err.message : String(err)),
      });
    });
    // 中止信号：杀掉整个进程组（含 bash 的子命令），真正停止运行中的命令。
    const onAbort = () => {
      try {
        if (typeof child.pid === 'number') process.kill(-child.pid, 'SIGKILL');
      } catch (_) {
        /* 进程可能已退出 */
      }
      resolve({ command: cmd, ok: false, stdout: '', stderr: '', exitCode: 'ABORTED', timedOut: false, error: '已中止' });
    };
    if (signal) signal.addEventListener('abort', onAbort, { once: true });
  });
}

// ---- Evaluator 只读取证执行器 ----
// 给 Evaluator 一双「独立眼睛」：它可以要求框架实跑一批【只读】命令来确认产物是否真实存在，
// 而不是只信 Specialist 自报的 `ls` 输出。这是「证据驱动验证、不采信执行者自述」的工程化落地。
//
// 安全契约（比受控执行更严，因为它由 LLM 自行生成、不走用户授权弹窗）：
//  - 命令首词必须在只读白名单内（ls/find/cat/grep/...）；
//  - 整条命令不得出现任何写/改/删类令牌（rm/mv/cp/dd/chmod/curl/xargs/...）；
//  - 禁止重定向(>)、命令替换($()/反引号) 等可能写入或逃逸的语法；
//  - 命中 FORBIDDEN（sudo/su/passwd）或 DANGEROUS 模式一律拒绝。
// 任何违例都返回 exitCode='FORBIDDEN' + 可读原因（作为 Evaluator 的反馈证据），绝不执行。
// 只读白名单：基础只读命令 + 框架只读健康检查命令（验证脚手架是否真实落地，属只读取证）。
// 注意：sed/awk 已移出（sed -i 能绕过写禁令就地改文件）；npm/npx 仍禁止（npm install 会写 node_modules）。
const READONLY_ALLOWED = [
  'ls', 'find', 'cat', 'grep', 'rg', 'head', 'tail', 'wc', 'stat', 'test', 'file',
  'readlink', 'pwd', 'echo', 'printenv', 'realpath', 'du', 'tree',
  'sort', 'uniq', 'cut', 'tr', 'basename', 'dirname',
  // 框架只读健康检查命令
  'cd', 'php', 'composer', 'mvn', 'gradle', 'ng', 'node', 'java', 'python', 'python3',
  'go', 'cargo', 'ruby', 'bundle', 'dotnet', 'rails', 'pytest', 'tsc', 'jest', 'yarn', 'pnpm',
];
const READONLY_DESTRUCTIVE = [
  'rm', 'mv', 'cp', 'dd', 'mkfs', 'chmod', 'chown', 'chgrp', 'touch', 'ln', 'mkdir',
  'rmdir', 'git', 'npm', 'npx', 'curl', 'wget', 'kill', 'pkill', 'tee', 'shutdown',
  'reboot', 'eval', 'exec', 'source', 'xargs', 'sudo', 'su', 'passwd',
];
// 禁止：重定向(>) / 命令替换($()) / 反引号。链式(; && ||) 放行（由 READONLY_DESTRUCTIVE 令牌扫描兜底），
// 这样 Evaluator 可用 `cd <目录> && <只读命令>` 进入子目录取证。
const READONLY_FORBIDDEN_RE = /(>>?|\$\(|`)/;

function readOnlyReason(cmd) {
  const c = String(cmd || '').trim();
  if (!c) return '空命令';
  const fr = forbiddenReason(c);
  if (fr) return fr;
  if (isDangerous(c)) return '命令命中危险模式，已拒绝';
  const firstTok = c.split(/\s+/)[0];
  if (!READONLY_ALLOWED.includes(firstTok)) {
    return `只读取证只允许以以下命令之一开头：${READONLY_ALLOWED.join(' ')}（当前以 "${firstTok}" 开头）`;
  }
  // 整条命令扫描破坏性令牌（覆盖管道后续、&&/; 之后的命令）
  const toks = c.split(/\s+|[|;]|\|\||&&/).filter(Boolean);
  for (const t of toks) {
    const bare = t.replace(/^[|;&]/, '');
    if (READONLY_DESTRUCTIVE.includes(bare)) {
      return `只读取证禁止写/改/删类命令（含管道/链式的 "${bare}"），请用 find/ls/cat/grep 取证`;
    }
  }
  if (READONLY_FORBIDDEN_RE.test(c)) {
    return '只读取证禁止重定向(>)、命令替换($()/反引号)、以及 ;/&&/|| 链式写';
  }
  return null;
}

// 与 runShellCommand 同底层，但强制只读安全契约。返回结构一致；额外带 readOnly:true。
async function runReadOnlyCommand(cmd, cwd, { timeoutMs, signal } = {}) {
  const reason = readOnlyReason(cmd);
  if (reason) {
    debugExec(`READONLY BLOCKED cwd=${cwd} cmd=${JSON.stringify(cmd).slice(0, 400)} | why=${reason.slice(0, 200)}`);
    return {
      command: cmd,
      ok: false,
      stdout: '',
      stderr: `只读取证命令被拒绝：${reason}`,
      exitCode: 'FORBIDDEN',
      timedOut: false,
      error: reason,
      readOnly: true,
    };
  }
  const res = await runShellCommand(cmd, cwd, { timeoutMs: timeoutMs || 30000, signal });
  res.readOnly = true;
  return res;
}

module.exports = {
  runShellCommand,
  runReadOnlyCommand,
  readOnlyReason,
  READONLY_ALLOWED,
  buildEnv,
  isDangerous,
  forbiddenReason,
  requestApproval,
  resolveApproval,
  resetApprovals,
  isDirApproved,
};
