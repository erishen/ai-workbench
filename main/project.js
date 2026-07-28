// main/project.js
// 项目上下文采集：为 PSE 工作流提供「所选项目目录」的真实上下文。
// 设计目标：轻量、只读、有硬上限 —— 不递归进重型目录、不读大文件、总字数封顶，
// 保证注入提示词的上下文可控（不撑爆 token）。
const fs = require('fs');
const path = require('path');

// 不进入的目录（重型/无信息量）
const IGNORE_DIRS = new Set([
  'node_modules', '.git', 'dist', 'build', 'out', '.next', '.cache',
  'coverage', '__pycache__', '.venv', 'venv', '.idea', '.vscode',
  'target', 'vendor', '.pnpm-store', '.turbo', 'tmp',
]);

// 目录树限制
const MAX_DEPTH = 3;
const MAX_ENTRIES = 200;

// 关键文件（按优先级）与读取限制
const KEY_FILES = [
  'README.md', 'readme.md', 'README.zh-CN.md',
  'package.json', 'pyproject.toml', 'requirements.txt',
  'Cargo.toml', 'go.mod', 'pom.xml', 'Makefile', 'docker-compose.yml',
];
const MAX_FILE_CHARS = 2000; // 单文件截断
const MAX_TOTAL_CHARS = 9000; // 上下文总封顶

// 生成受限目录树文本
function buildTree(root) {
  const lines = [];
  let count = 0;

  function walk(dir, depth, prefix) {
    if (depth > MAX_DEPTH || count >= MAX_ENTRIES) return;
    let entries;
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch (_) {
      return;
    }
    // 目录在前、按名排序；隐藏文件放最后
    entries.sort((a, b) => {
      if (a.isDirectory() !== b.isDirectory()) return a.isDirectory() ? -1 : 1;
      return a.name.localeCompare(b.name);
    });
    for (const ent of entries) {
      if (count >= MAX_ENTRIES) {
        lines.push(`${prefix}… (已截断)`);
        return;
      }
      if (ent.name.startsWith('.') && ent.name !== '.env.example') continue;
      if (ent.isDirectory()) {
        if (IGNORE_DIRS.has(ent.name)) continue;
        lines.push(`${prefix}${ent.name}/`);
        count++;
        walk(path.join(dir, ent.name), depth + 1, prefix + '  ');
      } else {
        lines.push(`${prefix}${ent.name}`);
        count++;
      }
    }
  }

  walk(root, 1, '');
  return lines.join('\n');
}

// 读取关键文件（截断）
function readKeyFiles(root) {
  const parts = [];
  let total = 0;
  for (const name of KEY_FILES) {
    const fp = path.join(root, name);
    try {
      const st = fs.statSync(fp);
      if (!st.isFile()) continue;
      let text = fs.readFileSync(fp, 'utf8');
      if (text.length > MAX_FILE_CHARS) text = text.slice(0, MAX_FILE_CHARS) + '\n…(截断)';
      if (total + text.length > MAX_TOTAL_CHARS) break;
      total += text.length;
      parts.push(`--- ${name} ---\n${text}`);
    } catch (_) {
      /* 不存在则跳过 */
    }
  }
  return parts.join('\n\n');
}

/**
 * 采集项目上下文。返回 { ok, name, dir, context, error }。
 * context 为可直接注入提示词的文本（目录树 + 关键文件摘要），总字数有硬上限。
 */
function collectProjectContext(projectDir) {
  try {
    const dir = path.resolve(projectDir);
    const st = fs.statSync(dir);
    if (!st.isDirectory()) return { ok: false, error: '所选路径不是目录' };

    const name = path.basename(dir);
    const tree = buildTree(dir);
    const keyFiles = readKeyFiles(dir);

    let context =
      `项目名称：${name}\n项目路径：${dir}\n\n` +
      `项目目录结构（已省略 node_modules/.git 等，深度≤${MAX_DEPTH}）：\n${tree || '(空目录)'}\n`;
    if (keyFiles) context += `\n关键文件内容摘要：\n${keyFiles}\n`;
    if (context.length > MAX_TOTAL_CHARS + 3000) context = context.slice(0, MAX_TOTAL_CHARS + 3000) + '\n…(项目上下文已截断)';

    return { ok: true, name, dir, context };
  } catch (e) {
    return { ok: false, error: e && e.message ? e.message : String(e) };
  }
}

module.exports = { collectProjectContext };
