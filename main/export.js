// main/export.js
// 导出代码：从 PSE 工作流各步 Specialist 交付物中提取可落地的代码文件，
// 经用户确认后写入选定目录。PSE 负责"想"，用户确认后"写"——不擅自覆盖。
const fs = require('fs');
const path = require('path');
const { chatCompletion } = require('./llm');
const { extractJson } = require('./workflow');

const EXTRACT_SYS = `你是文件提取器。从用户给出的工作流各步骤交付物中，提取出所有可落地为文件的代码。
规则：
- 只提取完整、可直接作为文件保存的代码；跳过片段示例、伪代码、行内注释说明。
- 基于交付物内容（通常会提到"在 XX 文件中"）推断合理的相对路径，如 main/knowledge.js、src/modules/KnowledgeModule.js。
- content 为该文件的完整代码，不要包裹 markdown 代码围栏，不要额外解释。
- language 为代码语言（js、css、json、md 等）。
只输出一个 JSON 数组（不要任何额外解释、不要 markdown 围栏）：
[{"path":"相对路径","content":"文件完整内容","language":"语言"}]
若交付物中没有可落地的完整代码，输出空数组 []。`;

function guessLang(p) {
  const ext = path.extname(p).toLowerCase();
  const map = { '.js': 'js', '.jsx': 'jsx', '.ts': 'ts', '.tsx': 'tsx', '.css': 'css', '.json': 'json', '.md': 'md', '.html': 'html', '.py': 'py' };
  return map[ext] || 'text';
}

// 调 LLM 从各步交付物提取代码文件清单 [{path, content, language}]
async function extractFiles({ steps, settings }) {
  if (!settings || !settings.apiKey) {
    throw new Error('请先在「设置」中填写外部大模型的 API Key');
  }
  if (!Array.isArray(steps) || steps.length === 0) {
    throw new Error('没有可提取的步骤交付物');
  }
  const blocks = steps
    .map((s, i) => `## 步骤 ${i + 1}：${s.title || ''}\n交付物：\n${s.specialist || ''}`)
    .join('\n\n');
  const res = await chatCompletion({
    baseURL: settings.baseURL,
    apiKey: settings.apiKey,
    model: settings.model,
    temperature: 0,
    messages: [
      { role: 'system', content: EXTRACT_SYS },
      { role: 'user', content: `以下是 PSE 工作流各步骤的交付物，请从中提取可落地的代码文件：\n\n${blocks}` },
    ],
  });
  let arr = extractJson(res.content);
  if (!Array.isArray(arr)) arr = [];
  return arr
    .filter((f) => f && typeof f.path === 'string' && typeof f.content === 'string')
    .map((f) => ({
      path: String(f.path).trim().replace(/^[/\\]+/, ''), // 去掉前导 / 或 \，保持相对路径
      content: f.content,
      language: typeof f.language === 'string' && f.language ? f.language : guessLang(f.path),
    }));
}

// 关键源文件：即使非沙箱模式、用户勾选强制，也默认阻止覆盖（防 PSE 草稿吞掉工作源码）
const CRITICAL_REL = /^((preload\.js|electron\.js|package\.json|package-lock\.json|yarn\.lock|pnpm-lock\.yaml)$|main[\\/]|src[\\/]|build[\\/]|node_modules[\\/]|out[\\/]|dist[\\/])/i;

// 把文件清单写入选定目录。
// 安全策略（防止 PSE 草稿盲写覆盖工作源码）：
//  - sandbox=true（默认）：所有文件写入 <dir>/_pse_export/<时间戳>/ 子目录，绝不触碰 dir 下的任何现有文件；
//  - sandbox=false（专家模式）：直接写入 dir，但命中 CRITICAL_REL 且已存在的文件一律阻止覆盖（除非 forceCritical）；
//    其余已存在文件按 overwrite 决定跳过/覆盖。
// 返回 { results:[{path,ok,existed,blocked,error}], sandboxDir, written, skipped, blocked, criticalBlocked }
function writeFiles(dir, files, { overwrite = false, sandbox = true, forceCritical = false } = {}) {
  const base = path.resolve(dir);
  // 沙箱目录：<dir>/_pse_export/<时间戳>/，保证与现有文件物理隔离
  const sandboxDir = sandbox
    ? path.join(base, '_pse_export', new Date().toISOString().replace(/[:.]/g, '-'))
    : null;
  const root = sandboxDir || base;
  if (sandboxDir) {
    try {
      fs.mkdirSync(root, { recursive: true });
    } catch (_) {
      /* 目录创建失败会在下方写入时以错误体现 */
    }
  }
  const results = [];
  let written = 0;
  let skipped = 0;
  let blocked = 0;
  let criticalBlocked = 0;
  for (const f of files) {
    const rel = String(f.path || '').trim().replace(/^[/\\]+/, '');
    if (!rel) {
      results.push({ path: rel, ok: false, existed: false, blocked: false, error: '空路径' });
      skipped++;
      continue;
    }
    const abs = path.resolve(root, rel);
    // 路径穿越防护：不允许 .. 脱离 root
    if (abs !== root && !abs.startsWith(root + path.sep)) {
      results.push({ path: rel, ok: false, existed: false, blocked: false, error: '路径越界' });
      skipped++;
      continue;
    }
    const existed = fs.existsSync(abs);
    // 非沙箱 + 命中关键源文件 + 已存在 + 未强制 => 阻止覆盖（核心护栏）
    if (!sandbox && existed && !forceCritical && CRITICAL_REL.test(rel)) {
      results.push({
        path: rel,
        ok: false,
        existed: true,
        blocked: true,
        error: '关键源文件，已阻止覆盖（如需覆盖请勾选「确认覆盖关键源文件」）',
      });
      blocked++;
      criticalBlocked++;
      continue;
    }
    // 非沙箱 + 已存在 + 未勾覆盖 => 跳过（沙箱模式文件都在新目录，不会 existed）
    // 例外：已勾「确认覆盖关键源文件」的关键文件，允许落到下方写入分支覆盖
    if (existed && !overwrite && !sandbox && !(forceCritical && CRITICAL_REL.test(rel))) {
      results.push({ path: rel, ok: false, existed: true, blocked: false, error: '已存在（未覆盖）' });
      skipped++;
      continue;
    }
    try {
      fs.mkdirSync(path.dirname(abs), { recursive: true });
      fs.writeFileSync(abs, f.content || '');
      results.push({ path: rel, ok: true, existed, blocked: false, error: null });
      written++;
    } catch (e) {
      results.push({ path: rel, ok: false, existed, blocked: false, error: e && e.message ? e.message : String(e) });
      skipped++;
    }
  }
  return { results, sandboxDir, written, skipped, blocked, criticalBlocked };
}

module.exports = { extractFiles, writeFiles };
