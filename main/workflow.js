// main/workflow.js
// PSE 工作流主进程编排：Planner -> Specialist -> Evaluator 闭环。
// 通过 onEvent 把进度流式推给渲染进程（WorkflowModule / WorkflowDesignerModule），由 electron.js 转发为 workflow:progress。
// 末尾含工作流设计器处理器：workflow:designer:save / load / list（WorkflowDesignerModule 用）。
const { ipcMain } = require('electron');
const path = require('path');
const fs = require('fs');
const app = require('electron').app;
const { chatStream } = require('./llm');
const { collectProjectContext } = require('./project');
const { runShellCommand, runReadOnlyCommand, isDangerous, forbiddenReason, requestApproval, resetApprovals, isDirApproved, READONLY_ALLOWED } = require('./executor');
const { saveRunLog } = require('./runlog');
const { detectCapabilities } = require('./capabilities');
const { extractJson, safeParseVerification, extractFrom, extractCommands, stripPromptMarkers, inferProjectDir, normalizePathTok, collectCreatedDirs, normalizeVerdict, computeOverall, normalizeSteps, normalizePhases } = require('./workflow-parse');
const { PLANNER_SYS, SPECIALIST_SYS, EVALUATOR_SYS, REVIEWER_SYS, TASK_PROFILES, SPECIALIST_RULES, renderSpecialistExecRules, detectTaskType } = require('./prompts');

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



// ---- 用户消息构造 ----
function buildPlannerUser(task, projCtx, allowExec, caps) {
  let s = `任务：\n${task}\n`;
  if (projCtx && projCtx.context) {
    s += `\n项目上下文（请基于真实代码拆解，引用真实路径）：\n${projCtx.context}\n`;
  }
  if (allowExec) {
    s += `\n【命令执行已启用·覆盖上文纯文本限制】本次工作流可以实际运行命令取证：你拆出的步骤其验收标准（ac）可包含『运行 X 命令通过』类条款（例如"运行 pytest 相关测试通过"、"运行 npm run build 成功"），Specialist 会实际执行你标注的验证命令并回传真实退出码/输出。请照常给出具体、可验证的 ac。`;
  }
  if (caps && typeof caps === 'object') {
    const avail = Object.keys(caps)
      .filter((k) => k !== '_stacks' && caps[k])
      .join(', ');
    const missing = Object.keys(caps)
      .filter((k) => k !== '_stacks' && !caps[k])
      .join(', ');
    const st = caps._stacks || {};
    const stackLines = Object.keys(st)
      .map((k) => `    - ${k}: ${st[k] ? '就绪' : '缺失所需工具'}`)
      .join('\n');
    s += `\n【运行环境工具链探测结果（本机真实状态，请严格遵守）】
可用工具链（command 存在）：${avail || '（无）'}
缺失工具链：${missing || '（无）'}
技术栈就绪度：
${stackLines}
要求：
- 只能规划【可用工具链】能真正执行的任务；不要假定缺失工具已存在。
- 若任务必须用到【缺失】工具链（例如 Laravel 需要 php/composer/laravel，本机却缺失），你有两种选择：
  (a) 改用已可用的替代技术栈（例如后端改用 Node/uv 或纯前端方案）；或
  (b) 在 plan 的【第一个 step】显式安排"安装依赖"步骤，由 Specialist 尝试安装（需用户授权），后续步骤依赖其成功。若采用 (b)，请让依赖该工具链的后续步骤在 depends 中引用这个"安装"步骤的 id，这样安装失败时它们会被 fail-fast 自动跳过而非必然 FAIL。
- 安装必须是【用户级、免密码】方案，【绝对禁止 sudo】（执行环境无终端可输密码，sudo 命令会被直接拒绝）：npm 全局装用 \`npm install -g --prefix "$HOME/.npm-global" 包名\`；composer 装到 \`$HOME/bin\`；不要往 /usr/local/bin 等系统目录写入。
- 不要凭空规划需要缺失工具却未安排安装的步骤，那会导致 Evaluator 必然判 FAIL。`;
  }
  return s;
}

function buildSpecialistUser(task, step, projCtx, feedback, allowExec, taskProjectDir, taskType, knownDirs) {
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
    s += renderSpecialistExecRules(profile);
    let ruleN = SPECIALIST_RULES.length; // 已渲染 R1..R{ruleN}
    if (taskProjectDir) {
      ruleN += 1;
      s += `
R${ruleN}.【强制复用工程根目录】本任务在步骤1已确立工程根目录「${taskProjectDir}」，你必须【严格且唯一复用】此根目录：所有命令的相对路径都基于它（如 \`cd ${taskProjectDir}\` 后构建，或全程带 \`${taskProjectDir}/\` 前缀）。
- 若本任务是【多组件 / 全栈】任务，每个组件都必须在「${taskProjectDir}」下的【各自子目录】中创建（如 \`${taskProjectDir}/backend\`、\`${taskProjectDir}/frontend\`），绝不在工程容器根层另建平级兄弟目录（如同时建 \`laravel-backend\` 与 \`angular-frontend\` 两个平级目录）。
- 单一组件任务则直接在该根目录内构建，不要在其后加后缀另起新名。
验收路径依赖此根目录名，换名或建兄弟目录会导致产物路径不符被 Evaluator 判 FAIL。`;
    }
    if (knownDirs && knownDirs.size) {
      // 作用域过滤：只保留位于工程根目录 taskProjectDir 下的路径，排除游离的坏路径（如裸名 laravel-backend/config）
      const scoped = taskProjectDir
        ? [...knownDirs].filter((d) => d === taskProjectDir || d.startsWith(taskProjectDir + '/'))
        : [];
      const dirList = scoped.length ? scoped : [...knownDirs];
      ruleN += 1;
      s += `
R${ruleN}.【已创建目录·权威路径·禁止漂移】本任务前序步骤已真实创建以下目录（均相对项目根），后续所有命令【必须严格使用下列完整相对路径】，禁止改写、缩短或另起裸名——例如已知「${taskProjectDir || '<根>'}/laravel-backend」却写成「laravel-backend」即路径漂移错误，会把产物写进错误位置、且验证命令在空目录跑导致 Evaluator 误判 FAIL：
${dirList.map((d) => `- ${d}`).join('\n')}
引用任一组件时请直接复制上面完整路径，不要重新推断或裁剪。`;
    }
  }
  s += `
请产出本步骤的交付物。`;
  return s;
}

function buildEvaluatorUser(task, step, specialistText, projCtx, executions, verifyEvidence, knownDirs, taskProjectDir) {
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
  if (verifyEvidence && verifyEvidence.length) {
    s += `\n【你申请的独立取证结果（框架实跑的只读命令真实输出，请以这些为准重新定论）】\n`;
    verifyEvidence.forEach((ev, i) => {
      if (ev.blocked) {
        s += `取证命令 ${i + 1}（被只读安全策略拒绝，未执行）：${ev.command}\n原因：${ev.error || ''}\n`;
      } else {
        s += `取证命令 ${i + 1}：${ev.command}\n退出码：${ev.exitCode != null ? ev.exitCode : '?'}\n标准输出：\n${ev.stdout || '(空)'}\n标准错误：\n${ev.stderr || '(空)'}\n`;
      }
    });
    s += `\n请仅凭以上真实取证结果，重新判定每条 ac 的 status 与最终 verdict，并给出 evidence。这是最终判定轮，不要再提交新的 verify 字段。`;
  }
  if (knownDirs && knownDirs.size) {
    const scoped = taskProjectDir
      ? [...knownDirs].filter((d) => d === taskProjectDir || d.startsWith(taskProjectDir + '/'))
      : [];
    const dirList = scoped.length ? scoped : [...knownDirs];
    s += `\n【本任务已创建目录（verify 取证命令必须使用下列完整相对路径，禁止裸名/缩短，否则会跑错空目录）】\n${dirList.map((d) => `- ${d}`).join('\n')}`;
  }
  if (step.verify && String(step.verify).trim()) {
    s += `\n【设计器指定验证要点】用户在步骤定义中显式指定的验证方式/命令，请优先据此取证（可将其作为 verify 只读命令提交，如 'cd <工程目录> && <命令>'）：\n${step.verify}\n`;
  }
  s += `\n请基于交付物原文与（如有）命令执行结果给出证据驱动的评估${verifyEvidence && verifyEvidence.length ? '（以独立取证结果为准）' : ''}，只输出 JSON。`;
  return s;
}

// 运行一个「验证阶段」（evaluator / reviewer 共用）：LLM 判 verdict + 可选两阶段独立取证。
// 返回 { verdict, verifications }；verdict 已归一化。与旧引擎的 Evaluator 行为完全一致。
async function runVerificationPhase({ sysPrompt, roleKey, task, step, specialistText, projCtx, executions, createdDirs, taskProjectDir, roleCreds, proxy, signal, on, stepId, projectDir }) {
  const creds = roleCreds(roleKey);
  const base = {
    baseURL: creds.baseURL,
    apiKey: creds.apiKey,
    model: creds.model,
    temperature: 0.2,
    proxy,
    signal,
    maxTokens: 4096,
    onToken: (d) => on({ type: roleKey + '-stream', stepId, delta: d }),
  };
  const first = await chatStream({
    ...base,
    messages: [
      { role: 'system', content: sysPrompt },
      { role: 'user', content: buildEvaluatorUser(task, step, specialistText, projCtx, executions, null, createdDirs, taskProjectDir) },
    ],
  });
  const text = extractFrom(first);
  const verifications = [];
  const parsed = safeParseVerification(text);
  if (!parsed.ok) {
    debugAppend('WORKFLOW-' + roleKey.toUpperCase() + '-RAW', text);
    // 验证阶段返回非 JSON（模型未按规约输出、泄漏了 tool_call/XML 标签等）：
    // 按「默认从宽、FAIL 从严」原则宽松降级为 PARTIAL，不触发 fail-fast、不中断整条工作流。
    return { verdict: parsed.verdict, verifications };
  }
  let verdict = normalizeVerdict(parsed.value);
  if (Array.isArray(parsed.value.verify) && parsed.value.verify.length) {
    on({ type: 'phase', phase: roleKey, message: `独立取证（${parsed.value.verify.length} 条只读命令）：${step.title}` });
    for (const vc of parsed.value.verify.slice(0, 8)) {
      const vr = await runReadOnlyCommand(String(vc || ''), projectDir, { timeoutMs: 30000, signal });
      const entry = {
        command: vr.command,
        exitCode: vr.exitCode,
        stdout: vr.stdout,
        stderr: vr.stderr,
        blocked: vr.exitCode === 'FORBIDDEN',
        error: vr.error,
      };
      verifications.push(entry);
      on({ type: roleKey + '-verify', stepId, entry });
    }
    const second = await chatStream({
      ...base,
      messages: [
        { role: 'system', content: sysPrompt },
        { role: 'user', content: buildEvaluatorUser(task, step, specialistText, projCtx, executions, verifications, createdDirs, taskProjectDir) },
      ],
    });
    const text2 = extractFrom(second);
    try {
      const v2 = extractJson(text2);
      const verdict2 = normalizeVerdict(v2);
      if (Array.isArray(v2.acResults) && v2.acResults.length) {
        verdict = verdict2;
      } else {
        verdict.verdict = verdict2.verdict;
        verdict.feedback = verdict2.feedback;
      }
    } catch (e2) {
      debugAppend('WORKFLOW-' + roleKey.toUpperCase() + '-VERIFY-RAW', text2);
      verdict.feedback = (verdict.feedback || '') + `（${roleKey} 第二阶段取证未解析，取证输出见运行日志）`;
    }
  }
  return { verdict, verifications };
}

// ---- 结果规整 ----

function buildReport(task, results, overall, projCtx) {
  const counts = { PASS: 0, PARTIAL: 0, FAIL: 0, BLOCKED: 0, SKIPPED: 0 };
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
    `**整体结论：** ${overall}（PASS ${counts.PASS} / PARTIAL ${counts.PARTIAL} / FAIL ${counts.FAIL} / BLOCKED ${counts.BLOCKED}${counts.SKIPPED ? ` / SKIPPED ${counts.SKIPPED}` : ''}）`
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
async function runWorkflow({ task, settings, projectDir, signal, onEvent, models, allowExec, taskTypeOverride, maxRetry, steps: presetSteps }) {
  const on = (ev) => {
    try {
      if (typeof onEvent === 'function') onEvent(ev);
    } catch (_) {
      /* 渲染端监听异常不影响主流程 */
    }
  };
  const aborted = () => !!(signal && signal.aborted);
  const MAX_RETRY = (typeof maxRetry === 'number' && maxRetry > 0) ? Math.floor(maxRetry) : 3;
  // 任务类型（决定 Specialist 注入哪套栈相关规则）。允许设计器显式覆盖（仅接受已知类型），
  // 否则回退自动推断。函数声明已提升，此处可直接调用。
  const KNOWN_TYPES = ['spring', 'python', 'frontend', 'generic'];
  const taskType = (taskTypeOverride && KNOWN_TYPES.includes(taskTypeOverride)) ? taskTypeOverride : detectTaskType(task);
  // 运行环境工具链预检：一次性探测常用工具是否可用，注入 Planner，避免规划出本机执行不了的任务。
  // 仅 `command -v`（只读），不安装、不变更、不请求授权。
  const caps = detectCapabilities(); // 探测结果同时注入 Planner 与运行归档
  on({ type: 'capabilities', caps });

  // ---- 运行归档（证据落盘）----
  // 这些变量提升到函数作用域，便于在 final / aborted / error 各分支统一归档，
  // 确保「成功 / 中途停止 / 出错」三类结束都能留下可追溯的运行记录。
  const startedAt = Date.now();
  const runId = 'run_' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
  let plan = null;
  let stepResults = [];
  let projCtx = null;
  let overall = null;
  let summary = null;
  let report = null;

  // 把当前累积的运行证据写入 logs/（开发期在项目根，打包后在 userData），并推送 run-saved 事件给 UI。
  // 任何异常都吞掉，绝不影响主流程。
  const persistRun = (extra = {}) => {
    try {
      const finishedAt = Date.now();
      const saved = saveRunLog({
        runId,
        startedAt,
        finishedAt,
        durationMs: finishedAt - startedAt,
        task,
        taskType,
        projectDir: projCtx ? projCtx.dir : projectDir || null,
        projectName: projCtx ? projCtx.name : null,
        plan,
        steps: stepResults,
        overall,
        summary,
        report,
        caps,
        ...extra,
      });
      if (typeof onEvent === 'function') onEvent({ type: 'run-saved', ...saved });
    } catch (_) {
      /* 归档失败不影响主流程 */
    }
  };
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
    projCtx = null;
    if (projectDir) {
      const pc = collectProjectContext(projectDir);
      if (!pc.ok) throw new Error(`项目上下文采集失败：${pc.error}`);
      projCtx = pc;
      on({ type: 'project', name: pc.name, dir: pc.dir, chars: pc.context.length });
    }

    // 1) Planner（或设计器预置步骤）
    let plan;
    const preset = Array.isArray(presetSteps) ? presetSteps : [];
    if (preset.length > 0) {
      // 设计器显式定义了步��：跳过自动 Planner，直接用用户步骤驱动 Specialist⇄Evaluator 循环。
      plan = {
        analysis: '（由设计器预置步骤驱动，已跳过自动 Planner）',
        steps: normalizeSteps(preset),
      };
      on({ type: 'phase', phase: 'planning', message: `使用设计器预置步骤（${plan.steps.length} 步）…` });
      on({ type: 'planner', fromDesigner: true });
    } else {
      const plannerCreds = roleCreds('planner');
      let planText = '';
      let planErr = null;
      const PLAN_MAX_RETRY = 2; // Planner JSON 解析失败（多为输出被截断）时自动重试，带更紧凑的 prompt
      for (let pr = 0; pr <= PLAN_MAX_RETRY; pr++) {
        const planMessages = [
          {
            role: 'system',
            content:
              PLANNER_SYS +
              (pr > 0
                ? '\n\n【重试·第 ' +
                  pr +
                  ' 次】上一次输出不是合法/完整的 JSON（疑似被截断）。请务必只输出一个【紧凑】JSON 对象：analysis 不超过 30 字；每个 step 只含 id/title/description/depends/ac 字段；不要任何额外解释、不要 markdown 代码围栏。'
                : ''),
          },
          { role: 'user', content: buildPlannerUser(task, projCtx, execEnabled, caps) },
        ];
        const planRes = await chatStream({
          baseURL: plannerCreds.baseURL,
          apiKey: plannerCreds.apiKey,
          model: plannerCreds.model,
          temperature: 0.3,
          proxy,
          signal,
          maxTokens: 4096,
          messages: planMessages,
          onToken: (d) => on({ type: 'plan-stream', delta: d }),
        });
        planText = extractFrom(planRes);
        try {
          plan = extractJson(planText);
          planErr = null;
          break;
        } catch (e) {
          planErr = e;
          debugAppend('WORKFLOW-PLAN-RAW', `--- Planner 尝试 ${pr + 1} 解析失败 ---\n${planText}`);
        }
      }
      if (planErr) {
        throw new Error('Planner 未能生成有效计划（已重试 ' + PLAN_MAX_RETRY + ' 次）：' + planErr.message);
      }
      plan = { analysis: (plan && plan.analysis) || '', steps: normalizeSteps((plan && plan.steps) || []) };
    }
    if (!plan.steps.length) throw new Error('未产出任何步骤（设计器未定义步骤且 Planner 也未生成）');
    on({ type: 'plan', analysis: plan.analysis || '', steps: plan.steps });
    const steps = plan.steps;

    // 2) 逐步按「阶段序列」驱动（specialist → evaluator → reviewer 可增删重排）
    stepResults = [];
    let taskProjectDir = null; // 从步骤1执行的命令推断出的本任务工程目录名，注入后续步骤与重试，防止重试跑偏另建目录
    const createdDirs = new Set(); // 跨步骤累积的真实创建目录，注入后续步骤与 Evaluator 取证，强制路径一致、禁止漂移
    for (let i = 0; i < steps.length; i++) {
      if (aborted()) {
        persistRun({ aborted: true });
        on({ type: 'aborted' });
        return;
      }
      const step = steps[i];
      // ---- fail-fast：前置步骤 FAIL/BLOCKED → 本步骤自动跳过，避免级联空跑 ----
      // stepResults 与 steps 按索引对齐；depends 已归一为 id 串。
      if (Array.isArray(step.depends) && step.depends.length) {
        const blockedBy = [];
        for (const depId of step.depends) {
          const idx = steps.findIndex((s) => s.id === depId);
          if (idx >= 0 && stepResults[idx]) {
            const dv = stepResults[idx].verdict && stepResults[idx].verdict.verdict;
            if (dv === 'FAIL' || dv === 'BLOCKED') {
              blockedBy.push({ depId, title: steps[idx].title, verdict: dv });
            }
          }
        }
        if (blockedBy.length) {
          const verdict = {
            verdict: 'SKIPPED',
            acResults: [],
            feedback: `被 fail-fast 跳过：前置步骤 ${blockedBy
              .map((b) => `"${b.title}"(${b.verdict})`)
              .join('、')} 已失败/受阻，本步骤不可能成功，不再执行以节省时间。`,
          };
          on({ type: 'phase', phase: 'blocked', message: `步骤 ${i + 1} 被 fail-fast 跳过：${step.title}` });
          on({ type: 'step-start', stepId: step.id });
          on({ type: 'evaluator', stepId: step.id, verdict });
          stepResults.push({ ...step, specialist: '', verdict, executions: [], blocked: true });
          continue;
        }
      }
      on({ type: 'phase', phase: 'specialist', message: `Specialist 执行步骤 ${i + 1}：${step.title}` });
      on({ type: 'step-start', stepId: step.id });

      // 阶段序列（结构级可编辑）：默认 ['specialist','evaluator']，与旧引擎行为一致。
      const phases = normalizePhases(step.phases);
      const stepMaxRetry = (typeof step.maxRetry === 'number' && step.maxRetry > 0) ? Math.floor(step.maxRetry) : MAX_RETRY;
      const retryOn =
        Array.isArray(step.retryOn) && step.retryOn.length
          ? step.retryOn.map((x) => String(x).toUpperCase()).filter((x) => ['PASS', 'PARTIAL', 'FAIL', 'BLOCKED'].includes(x))
          : ['PARTIAL'];

      let specText = '';
      let verdict = null;
      let verifications = [];
      let attempt = 0;
      let lastFeedback = '';
      let executions = [];
      // 按阶段序列循环：最后产出的 verdict 属 retryOn 且未达 stepMaxRetry 时，从头重跑（重跑 Specialist）。
      while (true) {
        attempt++;
        verifications = [];
        // 累积本步真实创建的目录，供后续步骤与 Evaluator 取证复用（路径一致性约束）
        collectCreatedDirs(executions).forEach((d) => createdDirs.add(d));

        for (const phase of phases) {
          if (phase === 'specialist') {
            const specCreds = roleCreds('specialist');
            const specRes = await chatStream({
              baseURL: specCreds.baseURL,
              apiKey: specCreds.apiKey,
              model: specCreds.model,
              temperature: 0.4,
              proxy,
              signal,
              maxTokens: 8192,
              messages: [
                { role: 'system', content: SPECIALIST_SYS },
                { role: 'user', content: buildSpecialistUser(task, step, projCtx, lastFeedback, execEnabled, taskProjectDir, taskType, createdDirs) },
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
                  persistRun({ aborted: true });
                  on({ type: 'aborted' });
                  return;
                }
                // 绝对禁止命令（sudo 等交互式提权）：不弹确认、不执行，直接记为失败证据，
                // 让 Evaluator 引导 Specialist 换用户级方案重试。
                const forbidden = forbiddenReason(cmd);
                if (forbidden) {
                  const res = { command: cmd, ok: false, stdout: '', stderr: `命令被禁止执行：${forbidden}`, exitCode: 'FORBIDDEN', timedOut: false, error: forbidden };
                  executions.push(res);
                  on({ type: 'exec-result', stepId: step.id, command: cmd, stdout: '', stderr: res.stderr, exitCode: 'FORBIDDEN' });
                  continue;
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
          } else if (phase === 'evaluator') {
            on({ type: 'phase', phase: 'evaluator', message: `Evaluator 验证步骤 ${i + 1}：${step.title}` });
            const r = await runVerificationPhase({ sysPrompt: EVALUATOR_SYS, roleKey: 'evaluator', task, step, specialistText: specText, projCtx, executions, createdDirs, taskProjectDir, roleCreds, proxy, signal, on, stepId: step.id, projectDir });
            verdict = r.verdict;
            verifications = r.verifications;
          } else if (phase === 'reviewer') {
            on({ type: 'phase', phase: 'reviewer', message: `Reviewer 复核步骤 ${i + 1}：${step.title}` });
            const r = await runVerificationPhase({ sysPrompt: REVIEWER_SYS, roleKey: 'reviewer', task, step, specialistText: specText, projCtx, executions, createdDirs, taskProjectDir, roleCreds, proxy, signal, on, stepId: step.id, projectDir });
            verdict = r.verdict;
            if (r.verifications && r.verifications.length) verifications = r.verifications;
          }
        }

        // 以最后产出的 verdict 决定重试（默认仅 PARTIAL 触发，可由 retryOn 配置为 FAIL 等）
        if (verdict && retryOn.includes(verdict.verdict) && attempt < stepMaxRetry) {
          lastFeedback = verdict.feedback || verdict.verdict;
          on({ type: 'retry', stepId: step.id, attempt, max: stepMaxRetry, reason: lastFeedback });
          continue;
        }
        break;
      }
      // 未配置任何验证阶段时，默认接受 Specialist 交付物（不冤枉）。
      if (!verdict) verdict = { verdict: 'PASS', acResults: [], feedback: '（本步骤未配置验证阶段，默认接受 Specialist 交付物）' };
      on({ type: 'evaluator', stepId: step.id, verdict });
      if (i === 0) taskProjectDir = inferProjectDir(executions) || taskProjectDir;
      stepResults.push({ ...step, specialist: specText, verdict, executions, verifications, dirs: [...createdDirs], phases });
    }

    // 3) 汇总报告
    overall = computeOverall(stepResults);
    const counts = { PASS: 0, PARTIAL: 0, FAIL: 0, BLOCKED: 0, SKIPPED: 0 };
    stepResults.forEach((r) => {
      const v = (r.verdict && r.verdict.verdict) || 'FAIL';
      counts[v] = (counts[v] || 0) + 1;
    });
    summary = `共 ${stepResults.length} 步：PASS ${counts.PASS} / PARTIAL ${counts.PARTIAL} / FAIL ${counts.FAIL} / BLOCKED ${counts.BLOCKED}${counts.SKIPPED ? ` / SKIPPED ${counts.SKIPPED}` : ''}`;
    report = buildReport(task, stepResults, overall, projCtx);
    on({ type: 'final', overall, summary, report, steps: stepResults });
    // 成功归档：留下完整可审计的运行记录
    persistRun();
  } catch (e) {
    debugAppend('WORKFLOW-CATCH', (e && e.stack) || (e && e.message) || String(e));
    const msg = (e && e.message) || String(e);
    if (aborted()) {
      persistRun({ aborted: true });
      on({ type: 'aborted' });
      return;
    }
    // undici 在流式响应中途被对端/网络断开时抛 TypeError: terminated（与用户手动停止不同，
    // 后者 signal.aborted 为真、上面已走 aborted 分支）。此处翻译为清晰文案，避免裸 "terminated"。
    if (msg === 'terminated' || /terminated|the operation was aborted/i.test(msg)) {
      persistRun({ error: '模型连接中断（terminated）' });
      on({
        type: 'error',
        message: '模型连接中断：流式响应中途被网关/网络断开（通常是该网关长响应不稳定，可重试本步骤或切换更稳定的模型）',
      });
      return;
    }
    persistRun({ error: msg });
    on({ type: 'error', message: msg });
  }
}

module.exports = { runWorkflow, extractJson };

// ---- 工作流设计器处理器（WorkflowDesignerModule 用） ----
// 模板保存在 userData/workflows/ 子目录，避免与设置、运行日志等散落文件混淆。
function designerDir() {
  const dir = path.join(app.getPath('userData'), 'workflows');
  try {
    fs.mkdirSync(dir, { recursive: true });
  } catch (_) {
    /* 忽略创建失败，后续读写会报错由调用方兜底 */
  }
  return dir;
}

ipcMain.handle('workflow:designer:save', async (event, definition) => {
  try {
    if (!definition || !definition.id || !definition.name || !String(definition.task || '').trim()) {
      throw new Error('工作流定义缺少必要字段（id / name / task）');
    }
    const filePath = path.join(designerDir(), `${definition.id}.json`);
    const payload = {
      ...definition,
      updatedAt: Date.now(),
    };
    await fs.promises.writeFile(filePath, JSON.stringify(payload, null, 2));
    return { success: true, message: `工作流「${definition.name}」已保存` };
  } catch (error) {
    return { success: false, message: error.message };
  }
});

ipcMain.handle('workflow:designer:load', async (event, id) => {
  try {
    const filePath = path.join(designerDir(), `${id}.json`);
    const content = await fs.promises.readFile(filePath, 'utf8');
    const workflow = JSON.parse(content);
    return { success: true, workflow };
  } catch (error) {
    return { success: false, message: '工作流未找到' };
  }
});

ipcMain.handle('workflow:designer:delete', async (event, id) => {
  try {
    const safeId = String(id || '').trim();
    // 只允许字母/数字/中文/下划线/连字符，防止 ../ 路径穿越
    if (!safeId || !/^[\w一-龥-]+$/.test(safeId)) {
      throw new Error('非法模板 id');
    }
    const filePath = path.join(designerDir(), `${safeId}.json`);
    await fs.promises.unlink(filePath);
    return { success: true, message: '模板已删除' };
  } catch (error) {
    if (error && error.code === 'ENOENT') {
      return { success: false, message: '模板不存在（可能已被删除）' };
    }
    return { success: false, message: error.message };
  }
});

ipcMain.handle('workflow:designer:list', async () => {
  try {
    const dir = designerDir();
    const files = fs.readdirSync(dir).filter((f) => f.endsWith('.json'));
    const list = [];
    for (const f of files) {
      try {
        const wf = JSON.parse(await fs.promises.readFile(path.join(dir, f), 'utf8'));
        list.push({
          id: wf.id,
          name: wf.name || wf.id,
          updatedAt: wf.updatedAt || 0,
          task: String(wf.task || '').slice(0, 80),
          taskTypeOverride: wf.taskTypeOverride || 'auto',
          allowExec: !!wf.allowExec,
          maxRetry: typeof wf.maxRetry === 'number' ? wf.maxRetry : 3,
          projectDir: wf.projectDir || null,
          hasSteps: Array.isArray(wf.steps) && wf.steps.length > 0,
          stepCount: Array.isArray(wf.steps) ? wf.steps.length : 0,
        });
      } catch (_) {
        /* 跳过损坏文件 */
      }
    }
    list.sort((a, b) => b.updatedAt - a.updatedAt);
    return { success: true, list };
  } catch (error) {
    return { success: false, message: error.message, list: [] };
  }
});
