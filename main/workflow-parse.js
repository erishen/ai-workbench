// main/workflow-parse.js
// PSE 工作流的纯函数层：JSON/命令/路径提取、目录推断、判定归一化。
// 不依赖 electron，可单独在 node 中加载与单测。

// ---- JSON 提取：兼容推理模型、markdown 围栏、尾随逗号、外层包裹 ----
// 入参为字符串，返回解析后的对象/数组；失败抛错并附带上下文。
function extractJson(text) {
  if (typeof text !== 'string') text = String(text == null ? '' : text);
  let s = text;
  // 剥离思考块（推理模型常把答案塞进 reasoning）
  s = s.replace(/<think[\s\S]*?<\/think>/gi, '');
  s = s.replace(/<reasoning[\s\S]*?<\/reasoning>/gi, '');
  // 去掉 markdown 代码围栏，保留内部内容
  s = s.replace(/```[a-zA-Z]*\n?([\s\S]*?)```/g, '$1');
  s = s.trim();
  // 1) 直接解析
  try {
    return JSON.parse(s);
  } catch (_) {
    /* 继续 */
  }
  // 2) 截取最外层 {} 对象
  const firstObj = s.indexOf('{');
  const lastObj = s.lastIndexOf('}');
  if (firstObj !== -1 && lastObj > firstObj) {
    let cand = s.slice(firstObj, lastObj + 1).replace(/,(\s*[}\]])/g, '$1');
    try {
      return JSON.parse(cand);
    } catch (_) {
      /* 继续 */
    }
  }
  // 3) 截取最外层 [] 数组（如 export 提取结果）
  const firstArr = s.indexOf('[');
  const lastArr = s.lastIndexOf(']');
  if (firstArr !== -1 && lastArr > firstArr) {
    let cand = s.slice(firstArr, lastArr + 1).replace(/,(\s*[}\]])/g, '$1');
    try {
      return JSON.parse(cand);
    } catch (_) {
      /* 继续 */
    }
  }
  throw new Error('无法解析为 JSON（原始片段：' + s.slice(0, 200) + '）');
}

// 从 LLM 返回对象中取文本：优先 content，空则回退 reasoning（推理模型常见）
function extractFrom(res) {
  if (!res || typeof res !== 'object') return '';
  const c = typeof res.content === 'string' ? res.content : '';
  if (c && c.trim()) return c;
  const r = typeof res.reasoning === 'string' ? res.reasoning : '';
  return r || '';
}

// 从 Specialist 交付物中提取可执行的 shell 命令（```bash / ```sh / ```shell 围栏）。
// 仅当 allowExec 时由编排器调用；返回命令字符串数组（已 trim）。
function extractCommands(text) {
  const re = /```(?:bash|sh|shell)\n([\s\S]*?)```/gi;
  const out = [];
  let m;
  while ((m = re.exec(typeof text === 'string' ? text : '')) !== null) {
    const code = stripPromptMarkers(m[1] || '').trim();
    if (code) out.push(code);
  }
  return out;
}

// LLM 常在 ```bash 块里把终端回显也写进来（每行带 $ / % / PS C:\> 等提示符前缀）。
// 这些前缀会让 shell 把 $ 当变量、把整行当无效命令，导致命令静默失败或退出码错乱。
// 逐行剥掉行首的提示符标记，只保留真实命令。
function stripPromptMarkers(code) {
  return String(code || '')
    .split('\n')
    .map((line) => line.replace(/^\s*(?:\$|\%|PS\s+[A-Za-z]:\\.*?>|PS>)\s*/, ''))
    .join('\n');
}

// 从步骤1执行的命令里推断本任务选定的「工程目录名」（多文件工程根目录的第一段路径）。
// 仅当能可靠推断时才返回；否则返回 null（不注入，退化到规则⑧的泛化约束）。
function inferProjectDir(executions) {
  if (!Array.isArray(executions)) return null;
  const denylist = new Set(['src', 'test', 'main', 'target', 'build', 'resources', 'pom.xml', '.', '..']);
  for (const ex of executions) {
    const cmd = ex && typeof ex.command === 'string' ? ex.command : '';
    if (!cmd) continue;
    const mk = /mkdir\s+-p\s+([^\n;|&]+)/g;
    let m;
    while ((m = mk.exec(cmd)) !== null) {
      const seg = m[1].trim().split(/\s+/)[0];
      const first = seg.split('/')[0].split('\\')[0];
      if (first && !first.includes('.') && !denylist.has(first)) return first;
    }
    const cat = /cat\s+>\s*['"]?([^'"\n]+?)['"]?\s*<</g;
    while ((m = cat.exec(cmd)) !== null) {
      const seg = m[1].trim().split('/')[0].split('\\')[0];
      if (seg && !seg.includes('.') && !denylist.has(seg)) return seg;
    }
  }
  return null;
}

// 规范化一个路径 token：去引号/去 ./ 前缀/去尾部斜杠；拒绝绝对路径、含命令替换或通配符的写法。
function normalizePathTok(tok) {
  let p = String(tok || '')
    .trim()
    .replace(/^['"]|['"]$/g, '')
    .replace(/^\.\//, '')
    .replace(/\/+$/, '');
  if (!p || p === '.' || p.startsWith('/') || p.includes('$(') || p.includes('*')) return null;
  return p;
}

// 从某一步的执行命令里收集【真实创建的目录】（相对项目根），用于跨步骤路径一致性约束。
// 解析 mkdir -p / cd / cat > 三类；并用「后缀更长者优先」去重，丢弃裸名漂移（如保留
// fullstack-app/laravel-backend、丢弃被它包含的 laravel-backend）。
function collectCreatedDirs(executions) {
  const dirs = new Set();
  if (!Array.isArray(executions)) return dirs;
  for (const ex of executions) {
    const cmd = ex && typeof ex.command === 'string' ? ex.command : '';
    if (!cmd) continue;
    let m;
    const mk = /mkdir\s+-p\s+([^\n;|&]+)/g;
    while ((m = mk.exec(cmd)) !== null) {
      m[1].trim().split(/\s+/).forEach((tok) => {
        const p = normalizePathTok(tok);
        if (p) dirs.add(p);
      });
    }
    const cd = /(?:\bcd\s+)([^\n;|&]+)/g;
    while ((m = cd.exec(cmd)) !== null) {
      const tok = m[1].trim().split(/\s+/)[0];
      const p = normalizePathTok(tok);
      if (p && !p.startsWith('..')) dirs.add(p);
    }
    const cat = /cat\s+>\s*['"]?([^'"\n|&]+?)['"]?\s*(?:<<|$)/g;
    while ((m = cat.exec(cmd)) !== null) {
      const tok = m[1].trim();
      const parts = tok.split('/');
      parts.pop();
      const p = normalizePathTok(parts.join('/'));
      if (p && p !== '.') dirs.add(p);
    }
  }
  // 去重：若某路径是另一更长路径以 "/" + 自身 为后缀，则丢弃较短者（裸名漂移）。
  const list = [...dirs];
  return new Set(
    list.filter(
      (p) => !list.some((q) => q !== p && q.length > p.length && q.endsWith('/' + p))
    )
  );
}

function normalizeVerdict(v) {
  if (!v || typeof v !== 'object') {
    return { verdict: 'FAIL', acResults: [], feedback: 'Evaluator 未返回有效结构' };
  }
  const allowed = ['PASS', 'PARTIAL', 'FAIL', 'BLOCKED'];
  let verdict = String(v.verdict || '').toUpperCase();
  if (!allowed.includes(verdict)) verdict = 'FAIL';
  let acResults = Array.isArray(v.acResults)
    ? v.acResults.map((r) => {
        let st = String(r.status || 'FAIL').toUpperCase();
        if (!['PASS', 'PARTIAL', 'FAIL'].includes(st)) st = 'FAIL';
        return { ac: String(r.ac || ''), status: st, evidence: String(r.evidence || '') };
      })
    : [];
  const feedback = typeof v.feedback === 'string' ? v.feedback : '';
  return { verdict, acResults, feedback };
}

function computeOverall(results) {
  const rank = { PASS: 0, PARTIAL: 1, FAIL: 2, BLOCKED: 3 };
  let max = 0;
  for (const r of results) {
    const v = (r.verdict && r.verdict.verdict) || 'FAIL';
    max = Math.max(max, rank[v] != null ? rank[v] : 2);
  }
  const inv = { 0: 'PASS', 1: 'PARTIAL', 2: 'FAIL', 3: 'BLOCKED' };
  return inv[max];
}

// ---- 步骤归一化：兼容自动 Planner 与「设计器预置步骤」两种来源 ----
// 入参 rawSteps：任意数组（每项可含 id/title/description/depends/ac/verify）。
// 出参：统一结构的步骤数组，供 runWorkflow 的 Specialist⇄Evaluator 循环直接使用。
// 依赖写法（["step-1"] / [1] / "1,2"）统一归一为 id 串；ac 可为数组或每行一条的字符串；
// verify 为设计器显式指定的验证要点/命令，透传给 Evaluator。
function normalizeSteps(rawSteps) {
  return (Array.isArray(rawSteps) ? rawSteps : []).map((s, i) => {
    const src = s && typeof s === 'object' ? s : {};
    let depends = [];
    if (Array.isArray(src.depends)) {
      depends = src.depends.map((d) => (typeof d === 'number' ? `step-${d}` : String(d)));
    } else if (typeof src.depends === 'string' && src.depends.trim()) {
      depends = src.depends
        .split(/[,\s]+/)
        .filter(Boolean)
        .map((d) => (/^\d+$/.test(d) ? `step-${d}` : d));
    }
    let ac = [];
    if (Array.isArray(src.ac)) ac = src.ac.map(String);
    else if (typeof src.ac === 'string' && src.ac.trim()) {
      ac = src.ac.split('\n').map((x) => x.trim()).filter(Boolean);
    }
    const verify =
      Array.isArray(src.verify) ? src.verify.join('\n') : typeof src.verify === 'string' ? src.verify : '';
    return {
      id: src.id || `step-${i + 1}`,
      title: src.title || `步骤 ${i + 1}`,
      description: src.description || '',
      depends,
      ac,
      verify,
      // 结构级字段透传（未提供时留 undefined，由 runWorkflow 回落默认：phases=['specialist','evaluator']、maxRetry=全局、retryOn=['PARTIAL']）
      phases: Array.isArray(src.phases) && src.phases.length ? src.phases : undefined,
      maxRetry: typeof src.maxRetry === 'number' && src.maxRetry > 0 ? src.maxRetry : undefined,
      retryOn: Array.isArray(src.retryOn) && src.retryOn.length ? src.retryOn : undefined,
    };
  });
}

// ---- 阶段序列归一化：把设计器编辑的「每步阶段流水线」规整为可驱动引擎的安全序列 ----
// 合法阶段：specialist（产出+执行命令）/ evaluator（独立验证）/ reviewer（第二道闸门）。
// 默认 ['specialist','evaluator']，与旧引擎行为完全一致；过滤非法值、去重、空/非数组回落默认。
const VALID_PHASES = ['specialist', 'evaluator', 'reviewer'];
function normalizePhases(rawPhases) {
  if (!Array.isArray(rawPhases) || rawPhases.length === 0) return ['specialist', 'evaluator'];
  const seen = new Set();
  const out = [];
  for (const p of rawPhases) {
    const s = String(p || '').toLowerCase();
    if (VALID_PHASES.includes(s) && !seen.has(s)) {
      seen.add(s);
      out.push(s);
    }
  }
  return out.length ? out : ['specialist', 'evaluator'];
}

module.exports = {
  extractJson,
  extractFrom,
  extractCommands,
  stripPromptMarkers,
  inferProjectDir,
  normalizePathTok,
  collectCreatedDirs,
  normalizeVerdict,
  computeOverall,
  normalizeSteps,
  normalizePhases,
};
