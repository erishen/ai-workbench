// main/runlog.js
// 每次 PSE 运行的「证据归档」：把结构化的 Planner 计划 / 各步 Specialist 交付物 /
// Evaluator 判定+证据 / 整体结论 / 最终报告全文，落盘到 logs 目录，
// 同时生成一份人读版 .md，使「证据驱动验证」可被审计、可追溯（不再运行完即焚）。
// 注意：本文件只记运行证据，不含任何 API Key（apiKey 由 chatStream 单独透传，不进消息体）。
const fs = require('fs');
const path = require('path');
const { app } = require('electron');

// 日志根目录：
//  - 开发期（!app.isPackaged）：项目根下的 logs/（即 work/research/ai-workbench/logs），
//    方便直接查看、纳入 .gitignore；
//  - 打包后（app.isPackaged）：userData/logs 才是稳定可写位置（应用可能在 /Applications，
//    项目目录未必存在）。
// 返回第一个可成功创建并写入的目录；都失败则退到系统临时目录。
function logsDir() {
  const candidates = [];
  if (!app.isPackaged) {
    candidates.push(path.join(__dirname, '..', 'logs')); // main/ -> 项目根/logs
  }
  candidates.push(path.join(app.getPath('userData'), 'logs'));
  for (const dir of candidates) {
    try {
      fs.mkdirSync(dir, { recursive: true });
      return dir;
    } catch (_) {
      /* 该候选不可用，尝试下一个 */
    }
  }
  // 兜底：系统临时目录
  const fallback = path.join(app.getPath('temp') || require('os').tmpdir(), 'ai-workbench-logs');
  try {
    fs.mkdirSync(fallback, { recursive: true });
  } catch (_) {
    /* 兜底失败也无所谓，调用方已吞异常 */
  }
  return fallback;
}

// 任务文本 -> 文件安全的 slug（保留中文）
function slugify(s, max = 48) {
  const out = String(s || 'task')
    .toLowerCase()
    .replace(/[^\w一-龥]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, max);
  return out || 'task';
}

// 生成人读版 Markdown（与 buildReport 同源信息，但面向「运行记录存档」而非「交付报告」）
function buildRunMarkdown(d) {
  const lines = [];
  lines.push(`# PSE 运行记录`);
  lines.push('');
  lines.push(`- 运行 ID：${d.runId || '-'}`);
  lines.push(`- 开始：${d.startedAt ? new Date(d.startedAt).toLocaleString() : '-'}`);
  lines.push(`- 结束：${d.finishedAt ? new Date(d.finishedAt).toLocaleString() : '-'}`);
  lines.push(`- 耗时：${typeof d.durationMs === 'number' ? (d.durationMs / 1000).toFixed(1) + 's' : '-'}`);
  lines.push(`- 任务类型：${d.taskType || '-'}`);
  lines.push(`- 项目：${d.projectName || '-'}${d.projectDir ? '（' + d.projectDir + '）' : ''}`);
  if (d.caps && typeof d.caps === 'object') {
    const avail = Object.keys(d.caps).filter((k) => k !== '_stacks' && d.caps[k]).join(', ');
    const missing = Object.keys(d.caps).filter((k) => k !== '_stacks' && !d.caps[k]).join(', ');
    lines.push(`- 运行环境工具链：可用=${avail || '（无）'}；缺失=${missing || '（无）'}`);
  }
  lines.push(`- 整体结论：${d.overall || (d.error ? 'ERROR' : '-')}`);
  if (d.summary) lines.push(`- 概要：${d.summary}`);
  if (d.error) lines.push(`- 错误信息：${d.error}`);
  if (d.aborted) lines.push(`- 状态：用户中途停止（partial）`);
  lines.push('');
  if (d.plan && typeof d.plan === 'object') {
    lines.push('## 计划（Planner）');
    if (d.plan.analysis) lines.push('> ' + d.plan.analysis);
    if (Array.isArray(d.plan.steps) && d.plan.steps.length) {
      d.plan.steps.forEach((s, i) => {
        lines.push(`${i + 1}. ${s.title || s.id || ''}${s.description ? ' — ' + s.description : ''}`);
      });
    }
    lines.push('');
  }
  const steps = Array.isArray(d.steps) ? d.steps : [];
  if (steps.length) {
    steps.forEach((r, i) => {
      const v = r.verdict ? r.verdict.verdict : 'FAIL';
      lines.push(`## 步骤 ${i + 1}：${r.title || r.id || ''} — ${v}`);
      if (r.description) lines.push(`> ${r.description}`);
      if (r.verdict && Array.isArray(r.verdict.acResults) && r.verdict.acResults.length) {
        lines.push('**验收核验：**');
        r.verdict.acResults.forEach((a) => {
          lines.push(`- [${a.status}] ${a.ac}${a.evidence ? ` — ${a.evidence}` : ''}`);
        });
      }
      if (r.verdict && r.verdict.feedback) lines.push(`**Evaluator 反馈：** ${r.verdict.feedback}`);
      lines.push('**Specialist 交付物：**');
      lines.push('```');
      lines.push((r.specialist || '(空)').trim());
      lines.push('```');
      const exs = Array.isArray(r.executions) ? r.executions : [];
      if (exs.length) {
        lines.push('**命令执行（真实证据）：**');
        exs.forEach((ex, j) => {
          if (ex.denied) {
            lines.push(`${j + 1}. （用户拒绝执行）`);
            lines.push('```');
            lines.push(ex.command || '');
            lines.push('```');
          } else {
            const status = ex.timedOut ? '超时' : `退出码 ${ex.exitCode != null ? ex.exitCode : '?'}`;
            lines.push(`${j + 1}. ${status}`);
            lines.push('```bash');
            lines.push(ex.command || '');
            lines.push('```');
            if (ex.stdout) {
              lines.push('标准输出：');
              lines.push('```');
              lines.push(ex.stdout);
              lines.push('```');
            }
            if (ex.stderr) {
              lines.push('标准错误：');
              lines.push('```');
              lines.push(ex.stderr);
              lines.push('```');
            }
          }
        });
      }
      lines.push('');
    });
  } else {
    lines.push('_（无已完成步骤）_');
    lines.push('');
  }
  return lines.join('\n');
}

// 归档一次运行。data 由 workflow.js 在 final / aborted / error 时调用。
// 返回 { jsonPath, mdPath } 或 { error }。任何异常都在内部吞掉，绝不影响主流程。
function saveRunLog(data) {
  try {
    const dir = logsDir();
    const started = data && data.startedAt ? new Date(data.startedAt) : new Date();
    const ts = started.toISOString().replace(/[:.]/g, '-');
    const base = `${ts}-${slugify(data && data.task)}`;
    const jsonPath = path.join(dir, base + '.json');
    const mdPath = path.join(dir, base + '.md');
    fs.writeFileSync(jsonPath, JSON.stringify(data, null, 2), 'utf-8');
    fs.writeFileSync(mdPath, buildRunMarkdown(data), 'utf-8');
    return { jsonPath, mdPath };
  } catch (e) {
    return { error: e && e.message ? e.message : String(e) };
  }
}

// 返回最近的运行记录文件（.json）路径，按时间倒序；用于 UI 展示历史。
function listRunLogs(limit = 50) {
  try {
    const dir = logsDir();
    return fs
      .readdirSync(dir)
      .filter((f) => f.endsWith('.json'))
      .map((f) => path.join(dir, f))
      .sort()
      .reverse()
      .slice(0, limit);
  } catch (_) {
    return [];
  }
}

module.exports = { saveRunLog, listRunLogs, logsDir, buildRunMarkdown };
