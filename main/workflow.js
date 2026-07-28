// main/workflow.js
// PSE 工作流主进程编排：Planner -> Specialist -> Evaluator 闭环。
// 通过 onEvent 把进度流式推给渲染进程（WorkflowModule），由 electron.js 转发为 workflow:progress。
// 同时保留历史遗留的 workflow:designer:* / workflow:execute 处理器（WorkflowDesignerModule 用）。
const { ipcMain } = require('electron');
const path = require('path');
const fs = require('fs');
const app = require('electron').app;
const { chatStream } = require('./llm');
const { collectProjectContext } = require('./project');
const { runShellCommand, isDangerous, requestApproval, resetApprovals, isDirApproved } = require('./executor');

// 调试落盘：仅本机排查用，不含任何密钥。
function debugAppend(tag, text) {
  try {
    const stamp = new Date().toISOString();
    fs.appendFileSync(
      '/tmp/aw-debug.log',
      `\n[${stamp}] ${tag}\n${String(text == null ? '' : text).slice(0, 4000)}\n`
    );
  } catch (_) {
    /* 忽略写入失败 */
  }
}

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
    const code = (m[1] || '').trim();
    if (code) out.push(code);
  }
  return out;
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

// ---- 角色提示词 ----
const PLANNER_SYS = `你是一位资深技术负责人 / 架构师，负责把用户的任务拆解成可独立执行、可独立验收的子步骤。
你将驱动一个 Plan-Specialist-Evaluator 工作流：你只做"拆解"（Planner），后续由 Specialist 产出交付物、Evaluator 独立验证。

【输出格式】
只输出一个 JSON 对象（不要任何额外解释、不要 markdown 代码围栏）：
{
  "analysis": "对任务的简要分析（100字内）",
  "steps": [
    {
      "id": "step-1",
      "title": "步骤标题",
      "description": "这一步要做什么",
      "ac": ["验收标准1（可凭交付物文本核验）", "验收标准2", "验收标准3"]
    }
  ]
}
要求：
- steps 数量 2~5 个，按执行顺序排列，上一阶段的产出可作为下一阶段的输入。
- 每个 step 的 ac（Acceptance Criteria）必须是【仅通过阅读 Specialist 的文字交付物即可核验】的条款，例如：
  "交付物中列出至少 3 个潜在 bug 并各自给出证据/文件位置"、"交付物包含 XX 文件的改造方案"、"交付物给出了可运行的代码示例"。
- 严禁写出【需要真正执行才能验证】的 AC，例如："单元测试运行通过"、"构建/打包成功"、"服务能启动"、"集成测试通过"。本工作流是纯文本框架，无法运行代码。

【重要能力边界】
你是一个纯文本规划智能体，不能运行代码、不能构建、不能启动服务、不能执行测试。因此所有 AC 都必须是"可审阅文本"级别，绝不能依赖运行结果。

【基于项目上下文（如提供）】
若用户输入中包含「项目上下文」（目录结构 + 关键文件），你必须基于真实代码拆解步骤，引用真实存在的文件路径与模块名，不得凭空臆造项目中不存在的文件或函数。
若未提供项目上下文，则步骤保持通用、任务导向，不假设具体项目结构。

只输出 JSON。`;

const SPECIALIST_SYS = `你是一位资深工程师，负责执行当前这一个步骤，产出具体交付物。
你会收到：任务背景、当前步骤（标题/描述/验收标准）、以及（可选的）项目上下文与上一轮评审反馈。

要求：
- 直接产出该步骤的交付物，用 Markdown 组织，结构清晰。
- 若步骤涉及代码，请在交付物中给出完整、可运行的代码片段（用代码块包裹并标注语言）。
- 若提供了项目上下文，必须基于真实文件与模块作答，引用真实路径，不得虚构项目中不存在的文件或函数；若某项无法基于现有代码给出，明确说明限制。
- 交付物应当能支撑该步骤的验收标准（ac）：每条 ac 都应能在你的交付物中找到对应证据。
- 不要输出 JSON，直接输出交付物正文。`;

const EVALUATOR_SYS = `你是一位独立评审工程师（Evaluator），负责验证 Specialist 的交付物是否满足该步骤的验收标准（ac）。
关键原则：证据驱动、不采信执行者自述。
- 你必须从交付物原文中引用证据（摘录关键句子/片段）来证明每条 ac 是否满足，而不是听信 Specialist "已完成" 的声明。
- 若本步骤提供了【命令执行结果】一节，应优先以真实输出为证据：依赖运行结果的 ac 可据「退出码」与「标准输出/标准错误」直接判 PASS/FAIL，不必再判 BLOCKED。非零退出码通常表明该验证未通过。
- 若某 ac 实质上需要运行才能验证、且又没有提供命令执行结果，才判为 BLOCKED 并在 evidence 中说明原因。

【输出格式】
只输出一个 JSON 对象（不要任何额外解释、不要 markdown 代码围栏）：
{
  "verdict": "PASS" | "PARTIAL" | "FAIL" | "BLOCKED",
  "acResults": [
    { "ac": "验收标准原文", "status": "PASS" | "PARTIAL" | "FAIL", "evidence": "从交付物或命令执行结果摘录的证据（一句话或代码片段）" }
  ],
  "feedback": "若未完全通过，说明缺了什么、错在哪里；若通过则为空字符串"
}
判定指引：
- PASS：所有 ac 都有充分证据满足。
- PARTIAL：核心完成但存在可指明的具体小缺口（feedback 必须说明，Specialist 将据此重试）。
- FAIL：实质性未满足，或虚构了不存在的内容。
- BLOCKED：因需要运行/外部依赖而无法基于文本验证，且未提供命令执行结果。
只输出 JSON。`;

// ---- 任务类型画像：把「栈相关」的执行/验证规则外置，Specialist 按检测出的任务类型注入对应规则；
//      通用内核（写前建父目录、复用目录名、幂等、不声称没做）对所有任务恒定。对齐 "verify_fn 一等公民 / task-agnostic"。 ----
const TASK_PROFILES = {
  spring: {
    label: 'Spring Boot / Maven / Gradle 工程',
    scaffold: '若用脚手架工具（如 Spring Initializr、Maven/Gradle archetype），应【真正调用】该工具；若手写配置请如实描述。',
    multiFile: '多文件工程（Maven/Gradle）必须先建独立工程根目录，pom.xml/build.gradle 与 src/ 全部建在里面，绝不直接铺在 cwd 根层。',
    build: '运行 mvn/gradle 构建（尤其新工程首次）需下载依赖，可能耗时数十秒到数分钟，属正常；可先 `mvn dependency:resolve` 预热。executor 对构建命令已放宽超时。',
    verify: '【启动并验证 HTTP 服务】先 `mvn -q package -DskipTests` 打 jar，再用 `java -jar target/*.jar > /tmp/app.log 2>&1 &` 后台启动并记录 PID；用端口探活循环（非 grep 写死日志）等待就绪后 curl 校验响应，最后 kill PID 收尾。服务端口以你的配置为准。',
  },
  python: {
    label: 'Python 脚本 / 应用',
    scaffold: '若用脚手架（如 Poetry / Cookiecutter），应【真正调用】；若手写请如实描述。',
    multiFile: '多文件 Python 工程（含包/模块）建议建独立目录，源码与 tests/ 放里面，绝不直接铺在 cwd 根层。',
    build: '可用 `python -m venv` 建虚拟环境、`pip install -r requirements.txt` 装依赖；首次安装可能较慢，属正常。',
    verify: '【验证】直接运行脚本取证：例如 `python main.py` 或 `pytest`；以真实标准输出/退出码为证据（如断言输出包含某串、或 pytest 全绿）。不要伪造输出。',
  },
  frontend: {
    label: '前端组件 / 应用（React/Vue 等）',
    scaffold: '若用脚手架（如 Vite / npm create / create-react-app），应【真正调用】；若手写请如实描述。',
    multiFile: '多文件前端工程需建独立目录，package.json 与 src/ 放里面，绝不直接铺在 cwd 根层。',
    build: '运行 `npm install` 安装依赖（首次较慢）；用 `npm run build` 验证可构建成功。executor 对构建命令已放宽超时。',
    verify: '【验证】若 ac 要求"构建成功"，运行 `npm run build` 并以退出码/输出为证据；若要求"启动 dev server 可访问"，用 `npm run dev` 后台启动并 curl 探活对应端口后 kill。',
  },
  generic: {
    label: '通用代码任务',
    scaffold: '若用脚手架/生成工具，应【真正调用】该工具；若手写配置请如实描述。',
    multiFile: '多文件工程必须建独立工程根目录，所有文件建在里面，绝不直接铺在 cwd 根层（cwd 通常是工程容器，已平铺多个项目）。',
    build: '运行构建/安装命令（尤其首次）可能较慢，属正常，不要据此误判失败；executor 对长命令已放宽超时。',
    verify: '【验证】按本步骤技术栈选用合适的真实运行/测试命令取证（如运行脚本、跑测试、构建），以其真实退出码与输出为证据；HTTP 服务用端口探活；不要伪造输出。',
  },
};

// 从任务文本粗分类（命中即采用，未命中退回 generic）。足够驱动规则注入；Planner 仍按任务自由拆解。
function detectTaskType(task) {
  const t = String(task || '').toLowerCase();
  if (/spring|maven|gradle|spring\s*boot|pom\.xml|build\.gradle|java\s*(后端|工程|项目|服务|api)/.test(t)) return 'spring';
  if (/python|\bpy\b|脚本|斐波那契|fibonacci|pip|pytest|django|flask|fastapi/.test(t)) return 'python';
  if (/react|vue|前端|组件|component|vite|next\.js|nuxt|tsx|jsx|angular|svelte/.test(t)) return 'frontend';
  return 'generic';
}

// ---- 用户消息构造 ----
function buildPlannerUser(task, projCtx, allowExec) {
  let s = `任务：\n${task}\n`;
  if (projCtx && projCtx.context) {
    s += `\n项目上下文（请基于真实代码拆解，引用真实路径）：\n${projCtx.context}\n`;
  }
  if (allowExec) {
    s += `\n【命令执行已启用·覆盖上文纯文本限制】本次工作流可以实际运行命令取证：你拆出的步骤其验收标准（ac）可包含『运行 X 命令通过』类条款（例如"运行 pytest 相关测试通过"、"运行 npm run build 成功"），Specialist 会实际执行你标注的验证命令并回传真实退出码/输出。请照常给出具体、可验证的 ac。`;
  }
  return s;
}

function buildSpecialistUser(task, step, projCtx, feedback, allowExec, taskProjectDir, taskType) {
  const profile = TASK_PROFILES[taskType] || TASK_PROFILES.generic;
  let s = `任务背景：
${task}

当前步骤：
标题：${step.title}
描述：${step.description}
验收标准(ac)：
${step.ac
    .map((a, i) => `${i + 1}. ${a}`)
    .join('\n')}
`;
  if (feedback) s += `
上一轮 Evaluator 反馈（请针对性补强）：
${feedback}
`;
  if (projCtx && projCtx.context) s += `
项目上下文（基于真实代码作答）：
${projCtx.context}
`;
  if (allowExec) {
    s += `
【命令执行已启用·重要】你交付物中的 \`\`\`bash 代码块会被【真正执行】于所选项目目录(cwd)，执行结果(退出码/输出)会作为证据回传。务必遵守：
① 本步骤若要产出文件/目录，必须用 bash 实际创建：用 \`mkdir -p 路径\` 建目录、用 \`cat > 文件 <<'EOF' ... EOF\` 或 \`printf '%s\\n' ... > 文件\` 写文件。写文件前务必先 \`mkdir -p $(dirname 目标文件路径)\` 把父目录(含嵌套子目录)建好再写入，否则报 No such file or directory。
② 验证命令(grep/ls/test)只能放在创建命令之后，且只能检查你【确实创建过】的文件/目录，路径必须与创建时完全一致。
③ 目录规则：cwd 已是所选项目目录，不要再 \`cd /绝对路径\` 切换；用相对路径；新建子目录先 \`mkdir -p\`。
④ 命令应幂等、安全(只读或创建用途)，不要破坏性命令。
⑤ ${profile.scaffold}
⑥ 不要只创建配置/空目录就声称"项目已生成"：关键源码文件也要一并创建，否则 Evaluator 验证时找不到这些文件会判 FAIL。
⑦ ${profile.multiFile}
⑧ 若任务跨多个步骤构建【同一个】工程，步骤1确定的工程目录名后续步骤必须【严格复用同一名称】，不要另起新名；整个任务只应存在一个工程目录。
⑨ ${profile.build}
⑩ ${profile.verify}
`;
  }
  if (taskProjectDir) {
    s += `
⑪【强制复用工程目录名】本任务在步骤1已创建工程根目录「${taskProjectDir}」，你必须【严格且唯一复用】此名称：所有命令的相对路径都基于它（如 \`cd ${taskProjectDir}\` 后构建，或全程带 \`${taskProjectDir}/\` 前缀），绝对不要另起新目录名，也不要写成 \`src/\` 或在其后加后缀。验收路径依赖此名称，换名会导致产物路径不符被 Evaluator 判 FAIL。`;
  }
  s += `
请产出本步骤的交付物。`;
  return s;
}

function buildEvaluatorUser(task, step, specialistText, projCtx, executions) {
  let s = `任务背景：\n${task}\n\n待验证步骤：\n标题：${step.title}\n验收标准(ac)：\n${step.ac
    .map((a, i) => `${i + 1}. ${a}`)
    .join('\n')}\n\nSpecialist 交付物：\n${specialistText}\n`;
  if (projCtx && projCtx.context) {
    s += `\n项目上下文（用于核验收据是否基于真实代码）：\n${projCtx.context}\n`;
  }
  if (Array.isArray(executions) && executions.length) {
    s += `\n【命令执行结果（真实证据，优先据此判断 AC）】\n`;
    executions.forEach((ex, i) => {
      if (ex.denied) {
        s += `命令 ${i + 1}（被用户拒绝执行，已跳过）：\n${ex.command}\n`;
      } else if (ex.blocked) {
        s += `命令 ${i + 1}（被安全策略拦截）：\n${ex.command}\n`;
      } else {
        s += `命令 ${i + 1}：${ex.command}\n退出码：${ex.exitCode != null ? ex.exitCode : '?'}${ex.timedOut ? '（超时）' : ''}\n标准输出：\n${ex.stdout || '(空)'}\n标准错误：\n${ex.stderr || '(空)'}\n`;
      }
    });
    s += `\n若某条 ac 依赖运行结果，以上述真实输出为证据判断；非零退出码通常表明该验证未通过。\n`;
  }
  s += `\n请基于交付物原文与（如有）命令执行结果给出证据驱动的评估，只输出 JSON。`;
  return s;
}

// ---- 结果规整 ----
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

function buildReport(task, results, overall, projCtx) {
  const counts = { PASS: 0, PARTIAL: 0, FAIL: 0, BLOCKED: 0 };
  results.forEach((r) => {
    const v = (r.verdict && r.verdict.verdict) || 'FAIL';
    counts[v] = (counts[v] || 0) + 1;
  });
  const lines = [];
  lines.push('# PSE 工作流报告');
  lines.push('');
  lines.push(`**任务：** ${task}`);
  if (projCtx) lines.push(`**项目：** ${projCtx.name}（${projCtx.dir}）`);
  lines.push(
    `**整体结论：** ${overall}（PASS ${counts.PASS} / PARTIAL ${counts.PARTIAL} / FAIL ${counts.FAIL} / BLOCKED ${counts.BLOCKED}）`
  );
  lines.push('');
  results.forEach((r, i) => {
    lines.push(`## 步骤 ${i + 1}：${r.title} — ${r.verdict ? r.verdict.verdict : 'FAIL'}`);
    if (r.description) lines.push(`> ${r.description}`);
    if (r.verdict && Array.isArray(r.verdict.acResults) && r.verdict.acResults.length) {
      lines.push('**验收核验：**');
      r.verdict.acResults.forEach((a) => {
        lines.push(`- [${a.status}] ${a.ac}${a.evidence ? ` — ${a.evidence}` : ''}`);
      });
    }
    if (r.verdict && r.verdict.feedback) lines.push(`**Evaluator 反馈：** ${r.verdict.feedback}`);
    lines.push('**Specialist 交付物：**');
    lines.push((r.specialist || '(空)').trim());
    lines.push('');
    if (Array.isArray(r.executions) && r.executions.length) {
      lines.push('**命令执行（真实证据）：**');
      r.executions.forEach((ex, i) => {
        if (ex.denied) {
          lines.push(`${i + 1}. （用户拒绝执行）\n\`\`\`\n${ex.command}\n\`\`\``);
        } else {
          const status = ex.timedOut ? '超时' : `退出码 ${ex.exitCode != null ? ex.exitCode : '?'}`;
          lines.push(`${i + 1}. ${status}\n\`\`\`bash\n${ex.command}\n\`\`\``);
          if (ex.stdout) lines.push(`标准输出：\n\`\`\`\n${ex.stdout}\n\`\`\``);
          if (ex.stderr) lines.push(`标准错误：\n\`\`\`\n${ex.stderr}\n\`\`\``);
        }
      });
      lines.push('');
    }
  });
  return lines.join('\n');
}

// ---- 主入口 ----
// 契约（与 electron.js / WorkflowModule 对齐）：
//   runWorkflow({ task, settings:{baseURL,apiKey,model,modelConfigs}, projectDir, signal, onEvent,
//                models:{planner,specialist,evaluator}, allowExec })  // 角色级「模型配置 id」覆盖，缺省回退主模型
//   - models[role] 为某条 modelConfig 的 id；按 id 解析出该服务商的 baseURL+apiKey+model。
//   - 找不到对应配置时回退为「主模型」(settings 的首个 modelConfig 解析值)。
//   - allowExec=true 时，Specialist 产出的 ```bash 代码块会被实际执行（受控：项目授权 + 危险命令强确认 + 超时）。
//   onEvent(ev) 支持：phase / project / plan-stream / plan / step-start / specialist /
//                    evaluator-stream / evaluator / retry / final / error / aborted /
//                    exec-approval / exec-start / exec-result
async function runWorkflow({ task, settings, projectDir, signal, onEvent, models, allowExec }) {
  const on = (ev) => {
    try {
      if (typeof onEvent === 'function') onEvent(ev);
    } catch (_) {
      /* 渲染端监听异常不影响主流程 */
    }
  };
  const aborted = () => !!(signal && signal.aborted);
  const MAX_RETRY = 3;
  // 任务类型（决定 Specialist 注入哪套栈相关规则）；函数声明已提升，此处可直接调用。
  const taskType = detectTaskType(task);
  // 全局代理（来自设置或系统环境变量），透传给所有模型调用的 fetch
  const proxy = (settings && typeof settings.proxy === 'string' && settings.proxy) || '';
  const execEnabled = !!allowExec && !!projectDir; // 必须有项目目录才有 cwd，否则无法执行
  resetApprovals(); // 每次运行重置「记住的项目」授权记忆
  // 按角色解析凭证：优先用指定的 modelConfig id，找不到则回退主模型(settings 首个配置)。
  const roleCreds = (role) => {
    const id = models && typeof models === 'object' ? models[role] : undefined;
    const configs = (settings && Array.isArray(settings.modelConfigs) && settings.modelConfigs) || [];
    if (id) {
      const cfg = configs.find((c) => c.id === id);
      if (cfg) {
        return { baseURL: cfg.baseURL, apiKey: cfg.apiKey, model: cfg.model };
      }
    }
    // 回退：主模型（settings 顶层已为首个配置解析值）
    return {
      baseURL: settings && settings.baseURL,
      apiKey: settings && settings.apiKey,
      model: (settings && settings.model) || 'gpt-4o-mini',
    };
  };
  try {
    on({ type: 'phase', phase: 'planning', message: 'Planner 正在拆解任务…' });

    // 项目上下文（可选）
    let projCtx = null;
    if (projectDir) {
      const pc = collectProjectContext(projectDir);
      if (!pc.ok) throw new Error(`项目上下文采集失败：${pc.error}`);
      projCtx = pc;
      on({ type: 'project', name: pc.name, dir: pc.dir, chars: pc.context.length });
    }

    // 1) Planner
    const plannerCreds = roleCreds('planner');
    const planRes = await chatStream({
      baseURL: plannerCreds.baseURL,
      apiKey: plannerCreds.apiKey,
      model: plannerCreds.model,
      temperature: 0.3,
      proxy,
      signal,
      messages: [
        { role: 'system', content: PLANNER_SYS },
        { role: 'user', content: buildPlannerUser(task, projCtx, execEnabled) },
      ],
      onToken: (d) => on({ type: 'plan-stream', delta: d }),
    });
    const planText = extractFrom(planRes);
    let plan;
    try {
      plan = extractJson(planText);
    } catch (e) {
      debugAppend('WORKFLOW-PLAN-RAW', planText);
      throw new Error('Planner 未能生成有效计划：' + e.message);
    }
    const rawSteps = Array.isArray(plan.steps) ? plan.steps : [];
    if (!rawSteps.length) throw new Error('Planner 未产出任何步骤');
    const steps = rawSteps.map((s, i) => ({
      id: s.id || `step-${i + 1}`,
      title: s.title || `步骤 ${i + 1}`,
      description: s.description || '',
      ac: Array.isArray(s.ac) ? s.ac : [],
    }));
    on({ type: 'plan', analysis: plan.analysis || '', steps });

    // 2) 逐步 Specialist -> Evaluator
    const stepResults = [];
    let taskProjectDir = null; // 从步骤1执行的命令推断出的本任务工程目录名，注入后续步骤与重试，防止重试跑偏另建目录
    for (let i = 0; i < steps.length; i++) {
      if (aborted()) {
        on({ type: 'aborted' });
        return;
      }
      const step = steps[i];
      on({ type: 'phase', phase: 'specialist', message: `Specialist 执行步骤 ${i + 1}：${step.title}` });
      on({ type: 'step-start', stepId: step.id });

      let specText = '';
      let verdict = null;
      let attempt = 0;
      let lastFeedback = '';
      let executions = [];
      // PARTIAL 自动重试 Specialist（≤ MAX_RETRY）
      while (true) {
        attempt++;
        const specCreds = roleCreds('specialist');
        const specRes = await chatStream({
          baseURL: specCreds.baseURL,
          apiKey: specCreds.apiKey,
          model: specCreds.model,
          temperature: 0.4,
          proxy,
          signal,
          messages: [
            { role: 'system', content: SPECIALIST_SYS },
            { role: 'user', content: buildSpecialistUser(task, step, projCtx, lastFeedback, execEnabled, taskProjectDir, taskType) },
          ],
          onToken: (d) => on({ type: 'specialist', stepId: step.id, delta: d }),
        });
        specText = extractFrom(specRes);

        // ---- 受控命令执行：提取 Specialist 交付物中的 ```bash 块并实际运行 ----
        executions = [];
        if (execEnabled) {
          const cmds = extractCommands(specText);
          for (const cmd of cmds) {
            if (aborted()) {
              on({ type: 'aborted' });
              return;
            }
            const dangerous = isDangerous(cmd);
            // 「记住本项目」后非危险命令免确认；危险命令一律强制单独确认
            let allowed = isDirApproved(projectDir) && !dangerous;
            if (!allowed) {
              const approved = await requestApproval({ emit: on, dir: projectDir, command: cmd, dangerous });
              if (!approved) {
                executions.push({ command: cmd, denied: true });
                on({ type: 'exec-result', stepId: step.id, command: cmd, denied: true });
                continue;
              }
            }
            on({ type: 'exec-start', stepId: step.id, command: cmd, dangerous });
            const res = await runShellCommand(cmd, projectDir, { signal });
            executions.push(res);
            on({
              type: 'exec-result',
              stepId: step.id,
              command: cmd,
              stdout: res.stdout,
              stderr: res.stderr,
              exitCode: res.exitCode,
              timedOut: res.timedOut,
              error: res.error,
            });
          }
        }

        on({ type: 'phase', phase: 'evaluator', message: `Evaluator 验证步骤 ${i + 1}：${step.title}` });
        const evalCreds = roleCreds('evaluator');
        const evalRes = await chatStream({
          baseURL: evalCreds.baseURL,
          apiKey: evalCreds.apiKey,
          model: evalCreds.model,
          temperature: 0.2,
          proxy,
          signal,
          messages: [
            { role: 'system', content: EVALUATOR_SYS },
            { role: 'user', content: buildEvaluatorUser(task, step, specText, projCtx, executions) },
          ],
          onToken: (d) => on({ type: 'evaluator-stream', stepId: step.id, delta: d }),
        });
        const evalText = extractFrom(evalRes);
        let v;
        try {
          v = extractJson(evalText);
        } catch (e) {
          debugAppend('WORKFLOW-EVAL-RAW', evalText);
          throw new Error(`Evaluator 步骤 ${i + 1} 返回无法解析：${e.message}`);
        }
        verdict = normalizeVerdict(v);

        if (verdict.verdict === 'PARTIAL' && attempt < MAX_RETRY) {
          lastFeedback = verdict.feedback;
          on({ type: 'retry', stepId: step.id, attempt, max: MAX_RETRY, reason: verdict.feedback || 'PARTIAL' });
          continue;
        }
        break;
      }
      on({ type: 'evaluator', stepId: step.id, verdict });
      if (i === 0) taskProjectDir = inferProjectDir(executions) || taskProjectDir;
      stepResults.push({ ...step, specialist: specText, verdict, executions });
    }

    // 3) 汇总报告
    const overall = computeOverall(stepResults);
    const counts = { PASS: 0, PARTIAL: 0, FAIL: 0, BLOCKED: 0 };
    stepResults.forEach((r) => {
      const v = (r.verdict && r.verdict.verdict) || 'FAIL';
      counts[v] = (counts[v] || 0) + 1;
    });
    const summary = `共 ${stepResults.length} 步：PASS ${counts.PASS} / PARTIAL ${counts.PARTIAL} / FAIL ${counts.FAIL} / BLOCKED ${counts.BLOCKED}`;
    const report = buildReport(task, stepResults, overall, projCtx);
    on({ type: 'final', overall, summary, report, steps: stepResults });
  } catch (e) {
    debugAppend('WORKFLOW-CATCH', (e && e.stack) || (e && e.message) || String(e));
    if (aborted()) {
      on({ type: 'aborted' });
      return;
    }
    // undici 在流式响应中途被对端/网络断开时抛 TypeError: terminated（与用户手动停止不同，
    // 后者 signal.aborted 为真、上面已走 aborted 分支）。此处翻译为清晰文案，避免裸 "terminated"。
    const msg = (e && e.message) || String(e);
    if (msg === 'terminated' || /terminated|the operation was aborted/i.test(msg)) {
      on({
        type: 'error',
        message: '模型连接中断：流式响应中途被网关/网络断开（通常是该网关长响应不稳定，可重试本步骤或切换更稳定的模型）',
      });
      return;
    }
    on({ type: 'error', message: msg });
  }
}

module.exports = { runWorkflow, extractJson };

// ---- 历史遗留：工作流设计器处理器（WorkflowDesignerModule 用，保持向后兼容） ----
class WorkflowExecutor {
  static async execute(workflowId) {
    return {
      status: 'success',
      output: `工作流 ${workflowId} 执行完成`,
      logs: [{ nodeId: 'chat', message: 'AI 处理中' }],
    };
  }
}

ipcMain.handle('workflow:designer:save', async (event, definition) => {
  try {
    if (!definition.id || !definition.nodes || !definition.edges) {
      throw new Error('工作流定义缺少必要字段');
    }
    const filePath = path.join(app.getPath('userData'), `${definition.id}.json`);
    await fs.promises.writeFile(filePath, JSON.stringify(definition, null, 2));
    return { success: true, message: `工作流 ${definition.id} 已保存` };
  } catch (error) {
    return { success: false, message: error.message };
  }
});

ipcMain.handle('workflow:designer:load', async (event, id) => {
  try {
    const filePath = path.join(app.getPath('userData'), `${id}.json`);
    const content = await fs.promises.readFile(filePath, 'utf8');
    const workflow = JSON.parse(content);
    return { success: true, workflow };
  } catch (error) {
    return { success: false, message: '工作流未找到' };
  }
});

ipcMain.handle('workflow:execute', async (event, workflowId) => {
  try {
    const result = await WorkflowExecutor.execute(workflowId);
    event.sender.send('workflow:result', {
      nodeId: workflowId,
      output: result.output,
      timestamp: Date.now(),
    });
    return { status: 'success', result };
  } catch (error) {
    return { status: 'error', message: error.message };
  }
});
