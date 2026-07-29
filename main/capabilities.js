// main/capabilities.js
// 运行环境工具链探测：在 PSE 工作流启动时一次性探测常用工具链是否可用，
// 结果注入 Planner，避免它规划出本机执行不了的任务（例如本机没装 php/composer 却规划 Laravel）。
// 仅用 `command -v`（只读、无副作用），不执行任何安装/变更，绝不请求授权。
const { spawnSync } = require('child_process');
const { buildEnv } = require('./executor');

const TOOLS = [
  'node', 'npm', 'npx',
  'python3', 'python', 'uv',
  'php', 'composer', 'laravel',
  'java', 'mvn', 'gradle',
  'ng', // Angular CLI
  'go', 'cargo', 'ruby',
  'docker', 'git',
];

function has(tool) {
  try {
    const cmd = process.platform === 'win32' ? 'where' : 'command';
    const args = process.platform === 'win32' ? [tool] : ['-v', tool];
    // 与 executor 的执行环境用同一套增强 PATH（含 ~/.npm-global/bin、~/bin 等用户级安装目录），
    // 避免「执行时可用、预检却报缺失」的不一致。
    const res = spawnSync(cmd, args, { encoding: 'utf8', timeout: 5000, env: buildEnv() });
    return !res.error && res.status === 0 && !!res.stdout && res.stdout.trim().length > 0;
  } catch (_) {
    return false;
  }
}

// 返回形如 { node:true, php:false, ..., _stacks:{ phpLaravel:false, nodeFrontend:true, ... } }
function detectCapabilities() {
  const caps = {};
  for (const t of TOOLS) caps[t] = has(t);
  // 派生「技术栈就绪度」，便于 Planner 直观判断缺哪条腿
  caps._stacks = {
    phpLaravel: !!(caps.php && caps.composer && caps.laravel),
    nodeFrontend: !!(caps.node && caps.npm),
    angularCli: !!(caps.node && caps.npm && caps.ng),
    javaSpring: !!(caps.java && (caps.mvn || caps.gradle)),
    pythonFastapi: !!(caps.python3 && caps.uv),
  };
  return caps;
}

module.exports = { detectCapabilities, TOOLS, has };
