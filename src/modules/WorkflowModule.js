import { useState, useEffect, useRef } from 'react';
import { isElectron } from '../lib/env';

// PSE 工作流模块：把 Plan-Specialist-Evaluator 思想做成可视化编排。
// 渲染端只负责把任务交给主进程、流式接收事件并呈现时间线；真正的角色扮演与重试在主进程(main/workflow.js)。
// 复用「设置」中的 baseURL / model / Key。

// 示例任务：针对「所选项目」的具体执行任务模板，均依赖项目上下文（Planner 据真实代码拆步、Evaluator 据真实代码验证）。
// 聚焦已有项目的实操：审查/测试/重构/实现指定需求/文档/安全，不涉从零新建项目。点击填入后若未选项目会提示先选。
const EXAMPLES = [
  { icon: '🔍', title: '代码审查与诊断', prompt: '对当前所选项目做一次全面代码审查：① 梳理项目结构与核心模块职责；② 找出技术债、潜在 bug 与可改进点；③ 按优先级输出改进清单（含问题、影响、建议）。基于项目真实代码，不得凭空臆断。' },
  { icon: '🧪', title: '单元测试补全', prompt: '为当前所选项目的核心模块补充单元测试：① 识别需覆盖的关键函数与分支；② 为正常路径、边界值、异常输入分别编写测试；③ 给出覆盖率说明与遗留风险。测试需贴合项目现有依赖与测试风格。' },
  { icon: '🏗️', title: '重构方案设计', prompt: '审查当前所选项目的代码结构并提出重构方案：① 指出耦合过重、职责不清、重复代码等问题；② 给出分步重构方案（每步可独立验证、不破坏现有行为）；③ 说明每步的验收标准与风险。' },
  { icon: '✨', title: '实现指定需求', prompt: '基于当前所选项目的现有架构，实现用户指定的一个具体需求或修复一个明确缺陷：① 定位需要改动的相关模块与文件；② 在现有代码风格内给出改动方案与可运行实现；③ 说明改动的影响范围与验收方式。不得凭空新建与项目无关的模块。' },
  { icon: '📝', title: '文档完善', prompt: '为当前所选项目完善文档：① 梳理现有文档缺口；② 撰写或更新 README（简介、安装、使用、目录结构）；③ 为关键模块补充使用说明与示例。内容须与项目实际代码一致。' },
  { icon: '🔒', title: '依赖与安全审查', prompt: '审查当前所选项目的依赖与代码安全：① 检查依赖清单（版本、已知漏洞、未用依赖）；② 审查代码安全风险（凭证硬编码、输入校验、SSRF 等）；③ 输出风险清单与修复建议。基于项目真实依赖文件。' },
];

const VERDICT_LABEL = { PASS: 'PASS 通过', PARTIAL: 'PARTIAL 部分通过', FAIL: 'FAIL 未通过', BLOCKED: 'BLOCKED 无法验证' };

function VerdictBadge({ verdict }) {
  if (!verdict) return null;
  const v = (verdict.verdict || '').toUpperCase();
  if (!v) return null;
  return <span className={`badge ${v.toLowerCase()}`}>{VERDICT_LABEL[v] || v}</span>;
}

function StepCard({ step, active, executions }) {
  const verdict = step.verdict;
  const evaluating = step.phase === 'evaluator' && !verdict;
  return (
    <div className={`wf-step ${active ? 'wf-step active' : ''}`}>
      <div className="wf-step-head">
        <span className="wf-step-no">{step.index + 1}</span>
        <span className="wf-step-title">{step.title}</span>
        {verdict ? (
          <VerdictBadge verdict={verdict} />
        ) : step.phase !== 'pending' ? (
          <span className="badge token">{step.phase === 'specialist' ? '执行中' : '评估中'}</span>
        ) : null}
      </div>

      {step.description && <div className="muted" style={{ marginBottom: 8 }}>{step.description}</div>}

      {Array.isArray(step.ac) && step.ac.length > 0 && (
        <ul className="wf-ac">
          {step.ac.map((a, i) => {
            // 若 Evaluator 已给出该 AC 的核验结果，则着色
            const r = verdict && Array.isArray(verdict.acResults) ? verdict.acResults.find((x) => x.ac === a) : null;
            const cls = r ? (r.status === 'PASS' ? 'ok' : 'no') : '';
            return (
              <li key={i} className={cls}>
                {a}
                {r && r.evidence ? <span className="muted"> — {r.evidence}</span> : null}
              </li>
            );
          })}
        </ul>
      )}

      <div className="muted" style={{ fontSize: 12, margin: '6px 0 2px' }}>Specialist 交付物</div>
      <pre className="wf-sub">{step.specialist || (step.phase === 'specialist' ? '（生成中…）' : '—')}</pre>

      {Array.isArray(executions) && executions.length > 0 && (
        <div className="wf-exec">
          <div className="muted" style={{ fontSize: 12, margin: '8px 0 2px' }}>命令执行（真实证据）</div>
          {executions.map((ex, i) => (
            <div key={i} className={`wf-exec-item ${ex.denied ? 'denied' : ex.status === 'ok' ? 'ok' : 'no'}`}>
              <pre className="wf-exec-cmd">{ex.command}</pre>
              {ex.status === 'running' || ex.status === 'dangerous' ? (
                <div className="muted">执行中…</div>
              ) : ex.denied ? (
                <div className="muted">已拒绝执行</div>
              ) : (
                <pre className="wf-exec-out">
{`退出码 ${ex.exitCode != null ? ex.exitCode : '?'}${ex.timedOut ? '（超时）' : ''}`}
{`${ex.stdout ? `\n--- stdout ---\n${ex.stdout}` : ''}`}
{`${ex.stderr ? `\n--- stderr ---\n${ex.stderr}` : ''}`}
{`${!ex.stdout && !ex.stderr && ex.error ? `\n${ex.error}` : ''}`}
                </pre>
              )}
            </div>
          ))}
        </div>
      )}

      {evaluating && step.evaluatorThinking && (
        <pre className="wf-think">{step.evaluatorThinking}</pre>
      )}

      {verdict && (
        <div className="wf-eval">
          <div className="wf-eval-head">
            <VerdictBadge verdict={verdict} />
            {step.retries > 0 && <span className="wf-retry">局部重试 {step.retries} 次</span>}
          </div>
          {Array.isArray(verdict.acResults) && verdict.acResults.length > 0 && (
            <ul className="wf-ac" style={{ marginTop: 8 }}>
              {verdict.acResults.map((r, i) => (
                <li key={i} className={r.status === 'PASS' ? 'ok' : 'no'}>
                  <strong>{r.ac}</strong>：{r.evidence || '—'}
                </li>
              ))}
            </ul>
          )}
          {verdict.feedback && <div className="wf-eval-feedback">评估反馈：{verdict.feedback}</div>}
        </div>
      )}
    </div>
  );
}

const PROJECT_STORAGE_KEY = 'workflow.projectDir';

export default function WorkflowModule() {
  const [task, setTask] = useState('');
  // 所选项目：{ dir, name } | null；记住上次选择（localStorage）
  const [project, setProject] = useState(() => {
    try {
      const raw = localStorage.getItem(PROJECT_STORAGE_KEY);
      return raw ? JSON.parse(raw) : null;
    } catch (_) {
      return null;
    }
  });
  const [projectInfo, setProjectInfo] = useState(null); // { name, dir, chars } 主进程实际读取结果
  const [running, setRunning] = useState(false);
  const [stopping, setStopping] = useState(false);
  const [phase, setPhase] = useState(null); // { phase, message }
  const [planThinking, setPlanThinking] = useState('');
  const [analysis, setAnalysis] = useState('');
  const [steps, setSteps] = useState([]); // [{ id,index,title,description,ac,phase,specialist,evaluatorThinking,verdict,retries }]
  const [finalReport, setFinalReport] = useState(null); // { overall, summary, report, steps }
  const [runSaved, setRunSaved] = useState(null); // { jsonPath, mdPath, error } 本次运行归档结果
  const [error, setError] = useState('');
  const [aborted, setAborted] = useState(false);
  const [needProject, setNeedProject] = useState(false); // 点示例后若未选项目，提示先选
  const [copied, setCopied] = useState(false);
  const [rawLog, setRawLog] = useState([]); // 原始事件日志：[{ t, kind, label }]
  const [logOpen, setLogOpen] = useState(true);

  // 导出代码相关状态
  const [exporting, setExporting] = useState(false);
  const [fileList, setFileList] = useState(null); // [{path, content, language, checked}]
  const [exportDir, setExportDir] = useState('');
  const [writeResult, setWriteResult] = useState(null); // [{path, ok, existed, error}]
  const [overwriteMode, setOverwriteMode] = useState(false);
  const [sandbox, setSandbox] = useState(true); // 默认写入 _pse_export/ 沙箱，不碰现有文件
  const [forceCritical, setForceCritical] = useState(false); // 非沙箱模式下是否允许覆盖关键源文件
  const [exportError, setExportError] = useState('');

  // 多模型配置：从「设置」读取已配的模型配置列表（每条含 id/baseURL/model 等），
  // 按角色（Planner/Specialist/Evaluator）分别选用不同的「模型配置」（可跨服务商）。
  const [wfConfigs, setWfConfigs] = useState([]); // 模型配置列表
  const [roleModels, setRoleModels] = useState({ planner: '', specialist: '', evaluator: '' });

  // 受控命令执行开关（默认关）。开启后 Specialist 产出的 ```bash 块会实际运行，
  // 但每次运行均需用户逐项/按项目授权，危险命令强制确认。
  const [allowExec, setAllowExec] = useState(false);
  const [approval, setApproval] = useState(null); // { requestId, dir, command, dangerous }
  const [rememberApproval, setRememberApproval] = useState(false);
  const [executionsByStep, setExecutionsByStep] = useState({}); // stepId -> [{command,status,stdout,stderr,exitCode,denied,timedOut,dangerous}]

  // 载入「设置」中的模型配置，默认三角色均用主配置（列表首个）
  useEffect(() => {
    if (!isElectron) return;
    window.electronAPI.getSettings?.().then((s) => {
      if (s) {
        const list = Array.isArray(s.modelConfigs) && s.modelConfigs.length ? s.modelConfigs : [];
        const primary = list[0] ? list[0].id : '';
        setWfConfigs(list);
        setRoleModels({ planner: primary, specialist: primary, evaluator: primary });
      }
    }).catch(() => {});
  }, []);

  const traceRef = useRef(null);
  const logRef = useRef(null);
  const runStartRef = useRef(0); // 本次运行起点，用于计算相对耗时
  const stepTitleRef = useRef({}); // stepId -> title，便于日志显示步骤名

  // 注册进度监听（仅挂载一次）
  useEffect(() => {
    if (!isElectron) return;
    const off = window.electronAPI.onWorkflowProgress?.((ev) => {
      if (!ev || typeof ev !== 'object') return;
      switch (ev.type) {
        case 'phase':
          setPhase({ phase: ev.phase, message: ev.message });
          setRawLog((l) => [...l, { t: Date.now(), kind: 'phase', label: ev.message }]);
          break;
        case 'project':
          setProjectInfo({ name: ev.name, dir: ev.dir, chars: ev.chars });
          setRawLog((l) => [...l, { t: Date.now(), kind: 'info', label: `已载入项目上下文：${ev.name}（${ev.chars} 字符）` }]);
          break;
        case 'capabilities': {
          const c = ev.caps || {};
          const avail = Object.keys(c).filter((k) => k !== '_stacks' && c[k]).join(', ');
          const missing = Object.keys(c).filter((k) => k !== '_stacks' && !c[k]).join(', ');
          setRawLog((l) => [
            ...l,
            { t: Date.now(), kind: 'info', label: `运行环境工具链探测：${avail || '（无可用）'}` },
            { t: Date.now(), kind: 'warn', label: missing ? `缺失工具链：${missing}` : '缺失工具链：无（全可用）' },
          ]);
          break;
        }
        case 'plan-stream':
          if (typeof ev.delta === 'string') setPlanThinking((t) => t + ev.delta);
          break;
        case 'plan':
          setAnalysis(ev.analysis || '');
          setSteps(
            (ev.steps || []).map((s, i) => ({
              id: s.id || `step-${i + 1}`,
              index: typeof s.index === 'number' ? s.index : i,
              title: s.title || `步骤 ${i + 1}`,
              description: s.description || '',
              ac: Array.isArray(s.ac) ? s.ac : [],
              phase: 'pending',
              specialist: '',
              evaluatorThinking: '',
              verdict: null,
              retries: 0,
            }))
          );
          stepTitleRef.current = {};
          (ev.steps || []).forEach((s, i) => {
            stepTitleRef.current[s.id || `step-${i + 1}`] = s.title || `步骤 ${i + 1}`;
          });
          setRawLog((l) => [...l, { t: Date.now(), kind: 'info', label: `计划已生成：${(ev.steps || []).length} 个步骤` }]);
          break;
        case 'step-start':
          setSteps((prev) =>
            prev.map((s) => (s.id === ev.stepId ? { ...s, phase: 'specialist' } : s))
          );
          break;
        case 'specialist':
          if (typeof ev.delta === 'string') {
            setSteps((prev) =>
              prev.map((s) => (s.id === ev.stepId ? { ...s, specialist: s.specialist + ev.delta } : s))
            );
          }
          break;
        case 'evaluator-stream':
          if (typeof ev.delta === 'string') {
            setSteps((prev) =>
              prev.map((s) => (s.id === ev.stepId ? { ...s, evaluatorThinking: s.evaluatorThinking + ev.delta } : s))
            );
          }
          break;
        case 'evaluator': {
          setSteps((prev) =>
            prev.map((s) => (s.id === ev.stepId ? { ...s, verdict: ev.verdict, evaluatorThinking: '', phase: 'done' } : s))
          );
          const vv = ((ev.verdict && ev.verdict.verdict) || '').toUpperCase();
          const vt = stepTitleRef.current[ev.stepId] || ev.stepId;
          setRawLog((l) => [...l, { t: Date.now(), kind: `v-${vv.toLowerCase()}`, label: `步骤「${vt}」判决：${vv}` }]);
          break;
        }
        case 'evaluator-verify': {
          const e = ev.entry || {};
          const cmd = (e.command || '').trim();
          const vt = stepTitleRef.current[ev.stepId] || ev.stepId;
          setRawLog((l) => [
            ...l,
            { t: Date.now(), kind: 'verify', label: `🔍 Evaluator 独立取证（步骤「${vt}」）：${cmd.slice(0, 80)}${cmd.length > 80 ? '…' : ''}` },
            ...(e.blocked
              ? [{ t: Date.now(), kind: 'warn', label: `↳ 被只读安全策略拒绝：${String(e.error || '').slice(0, 160)}` }]
              : (e.stdout || '').trim()
                ? [{ t: Date.now(), kind: 'dim', label: `↳ ${e.stdout.trim().slice(0, 400).replace(/\n/g, ' ⏎ ')}` }]
                : []),
          ]);
          break;
        }
        case 'retry': {
          setSteps((prev) =>
            prev.map((s) =>
              s.id === ev.stepId ? { ...s, specialist: '', evaluatorThinking: '', phase: 'specialist', retries: ev.attempt } : s
            )
          );
          const rt = stepTitleRef.current[ev.stepId] || ev.stepId;
          setRawLog((l) => [...l, { t: Date.now(), kind: 'retry', label: `步骤「${rt}」${ev.reason || 'PARTIAL'}，第 ${ev.attempt}/${ev.max} 次重试` }]);
          break;
        }
        case 'exec-approval':
          // 主进程请求用户授权在 evt.dir 执行命令；弹出确认框，等待用户回执
          setApproval({ requestId: ev.requestId, dir: ev.dir, command: ev.command, dangerous: !!ev.dangerous });
          setRawLog((l) => [...l, { t: Date.now(), kind: 'info', label: `⚡ 请求执行命令授权：${(ev.command || '').slice(0, 60)}` }]);
          break;
        case 'exec-start':
          setExecutionsByStep((prev) => ({
            ...prev,
            [ev.stepId]: [
              ...(prev[ev.stepId] || []),
              { command: ev.command, status: ev.dangerous ? 'dangerous' : 'running', dangerous: !!ev.dangerous },
            ],
          }));
          break;
        case 'exec-result': {
          const entry = {
            command: ev.command,
            status: ev.denied ? 'denied' : ev.exitCode === 0 ? 'ok' : 'no',
            denied: !!ev.denied,
            stdout: ev.stdout || '',
            stderr: ev.stderr || '',
            exitCode: ev.exitCode,
            timedOut: !!ev.timedOut,
            error: ev.error || '',
          };
          setExecutionsByStep((prev) => {
            const arr = prev[ev.stepId] || [];
            // 更新该 step 下最后一条匹配 command 的 running/dangerous 项；找不到则追加
            let idx = -1;
            for (let k = arr.length - 1; k >= 0; k--) {
              if (arr[k].command === ev.command && (arr[k].status === 'running' || arr[k].status === 'dangerous')) {
                idx = k;
                break;
              }
            }
            if (idx === -1) return { ...prev, [ev.stepId]: [...arr, entry] };
            const next = arr.slice();
            next[idx] = entry;
            return { ...prev, [ev.stepId]: next };
          });
          setRawLog((l) => [
            ...l,
            {
              t: Date.now(),
              kind: ev.denied ? 'info' : ev.exitCode === 0 ? 'info' : 'error',
              label: `⚡ 命令退出 ${ev.exitCode != null ? ev.exitCode : '?'}${ev.timedOut ? '(超时)' : ''}：${(ev.command || '').slice(0, 50)}`,
            },
          ]);
          break;
        }
        case 'final':
          setFinalReport(ev);
          setRunning(false);
          setStopping(false);
          setRawLog((l) => [...l, { t: Date.now(), kind: 'final', label: `工作流结束：整体 ${ev.overall}` }]);
          break;
        case 'run-saved':
          setRunSaved(ev && ev.error ? { error: ev.error } : ev);
          break;
        case 'error':
          setError(ev.message || '工作流出错');
          setRunning(false);
          setStopping(false);
          setRawLog((l) => [...l, { t: Date.now(), kind: 'error', label: `出错：${ev.message || '工作流出错'}` }]);
          break;
        case 'aborted':
          setAborted(true);
          setRunning(false);
          setStopping(false);
          setRawLog((l) => [...l, { t: Date.now(), kind: 'error', label: '已被用户停止' }]);
          break;
        default:
          break;
      }
    });
    return off;
  }, []);

  // 进度变化时滚动到底部
  useEffect(() => {
    if (traceRef.current) traceRef.current.scrollTop = traceRef.current.scrollHeight;
  }, [steps, planThinking, finalReport, phase]);

  // 原始日志追加时滚到底
  useEffect(() => {
    if (logRef.current) logRef.current.scrollTop = logRef.current.scrollHeight;
  }, [rawLog]);

  const onPickProject = async () => {
    if (running) return;
    try {
      const res = await window.electronAPI.workflowPickProject?.();
      if (res && !res.canceled && res.dir) {
        const p = { dir: res.dir, name: res.name || res.dir };
        setProject(p);
        setProjectInfo(null);
        setNeedProject(false);
        try {
          localStorage.setItem(PROJECT_STORAGE_KEY, JSON.stringify(p));
        } catch (_) {
          /* 存储不可用时忽略 */
        }
      }
    } catch (e) {
      setError(e && e.message ? e.message : '选择项目失败');
    }
  };

  const onClearProject = () => {
    if (running) return;
    setProject(null);
    setProjectInfo(null);
    try {
      localStorage.removeItem(PROJECT_STORAGE_KEY);
    } catch (_) {
      /* 忽略 */
    }
  };

  // 点击示例任务：填入输入框并清掉旧错误提示（不清结果，用户可对比/重跑）。
  // 示例均依赖项目上下文，若未选项目则提示先选（不阻止填入，方便用户先看内容）
  const onPickExample = (prompt) => {
    if (running) return;
    setError('');
    setTask(prompt);
    setNeedProject(!project);
  };

  const onRun = async () => {
    const text = task.trim();
    if (!text || running) return;
    // 收敛为「针对所选项目执行任务」：未选项目则拦截，避免跑成通用开发器
    if (!project) {
      setError('请先选择项目目录：本工具针对所选项目执行具体任务。');
      return;
    }
    // 重置
    setError('');
    setAborted(false);
    setPlanThinking('');
    setAnalysis('');
    setSteps([]);
    setFinalReport(null);
    setProjectInfo(null);
    setRunSaved(null);
    setExecutionsByStep({});
    setApproval(null);
    runStartRef.current = Date.now();
    stepTitleRef.current = {};
    setRawLog([{ t: runStartRef.current, kind: 'start', label: '▶ 工作流启动' + (project ? `（项目：${project.name}）` : '') + (allowExec ? ' · 命令执行已启用' : '') }]);
    setPhase({ phase: 'planning', message: '准备启动工作流…' });
    setRunning(true);
    setStopping(false);
    try {
      await window.electronAPI.workflowRun(
        text,
        project ? project.dir : undefined,
        roleModels && (roleModels.planner || roleModels.specialist || roleModels.evaluator)
          ? roleModels
          : undefined,
        allowExec
      );
    } catch (e) {
      setError(e && e.message ? e.message : '启动工作流失败');
      setRunning(false);
    }
  };

  const onStop = async () => {
    if (!running) return;
    setStopping(true);
    try {
      await window.electronAPI.workflowStop();
    } catch (_) {
      /* 忽略 */
    }
  };

  // 受控命令执行：用户对授权弹窗的回执（允许/拒绝 + 是否记住本项目本运行）
  const onApproveExec = async (allow) => {
    if (!approval) return;
    const { requestId } = approval;
    setApproval(null);
    try {
      await window.electronAPI.workflowExecApprove({ requestId, allow, remember: rememberApproval });
    } catch (_) {
      /* 忽略回执失败 */
    }
  };

  const onClear = () => {
    if (running) return;
    setTask('');
    setError('');
    setAborted(false);
    setPlanThinking('');
    setAnalysis('');
    setSteps([]);
    setFinalReport(null);
    setPhase(null);
    setRunSaved(null);
    setRawLog([]);
  };

  const onCopy = async () => {
    if (!finalReport || !finalReport.report) return;
    try {
      await navigator.clipboard.writeText(finalReport.report);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch (_) {
      /* 剪贴板不可用时忽略 */
    }
  };

  // 日志时间格式化：绝对时钟(HH:MM:SS) + 相对本次运行起点的耗时(+Xs)
  const fmtClock = (t) => new Date(t).toTimeString().slice(0, 8);
  const fmtElapsed = (t) => (runStartRef.current ? `+${((t - runStartRef.current) / 1000).toFixed(1)}s` : '');
  const onCopyLog = async () => {
    if (!rawLog.length) return;
    const text = rawLog.map((e) => `[${fmtClock(e.t)} ${fmtElapsed(e.t)}] ${e.label}`).join('\n');
    try {
      await navigator.clipboard.writeText(text);
    } catch (_) {
      /* 剪贴板不可用时忽略 */
    }
  };

  // 导出代码：从交付物提取文件 -> 用户确认 -> 写入选定目录
  const onExportExtract = async () => {
    if (!finalReport || !finalReport.steps) return;
    setExportError('');
    setFileList(null);
    setWriteResult(null);
    setExporting(true);
    try {
      const files = await window.electronAPI.exportExtract(finalReport.steps);
      if (!files || files.length === 0) {
        setExportError('未从交付物中提取到可落地的代码文件');
      } else {
        setFileList(files.map((f) => ({ ...f, checked: true })));
      }
    } catch (e) {
      setExportError(e && e.message ? e.message : '提取失败');
    } finally {
      setExporting(false);
    }
  };

  const onPickExportDir = async () => {
    try {
      const res = await window.electronAPI.pickExportDir();
      if (res && !res.canceled && res.dir) setExportDir(res.dir);
    } catch (e) {
      setExportError(e && e.message ? e.message : '选择目录失败');
    }
  };

  const onExportWrite = async () => {
    if (!fileList || !exportDir) return;
    const selected = fileList.filter((f) => f.checked);
    if (selected.length === 0) return;
    setExportError('');
    setWriteResult(null);
    try {
      const result = await window.electronAPI.exportWrite(exportDir, selected, {
        overwrite: overwriteMode,
        sandbox,
        forceCritical,
      });
      setWriteResult(result);
    } catch (e) {
      setExportError(e && e.message ? e.message : '写入失败');
    }
  };

  const onToggleFile = (i) => {
    setFileList((prev) => prev.map((f, idx) => (idx === i ? { ...f, checked: !f.checked } : f)));
  };

  const onEditPath = (i, newPath) => {
    setFileList((prev) => prev.map((f, idx) => (idx === i ? { ...f, path: newPath } : f)));
  };

  const activeStepId = steps.find((s) => s.phase === 'specialist' || s.phase === 'evaluator')?.id;

  return (
    <div className="module">
      <header className="module-header">
        <h1>PSE 工作流</h1>
        <p>
          针对所选项目的任务执行器：Plan-Specialist-Evaluator 编排先由 Planner 拆解带验收标准的子步骤，再逐步由 Specialist 执行，最后由
          Evaluator 独立验证（证据驱动、不采信执行者自述，PARTIAL 自动重试）。请先选择项目目录，再运行任务。
        </p>
      </header>

      <section className="card">
        {/* 项目选择：可选。选定后 Planner/Specialist/Evaluator 将基于该项目的目录树与关键文件工作 */}
        <div className="wf-project">
          <button className="btn ghost" onClick={onPickProject} disabled={running}>
            📁 选择项目
          </button>
          {project ? (
            <span className="wf-project-badge" title={project.dir}>
              {project.name}
              <button className="wf-project-clear" onClick={onClearProject} disabled={running} title="清除项目">
                ✕
              </button>
            </span>
          ) : (
            <span className="muted" style={{ fontSize: 12 }}>
              未选择项目（可选）：选定后，三角色将基于该项目的目录结构与关键文件进行规划与验证
            </span>
          )}
          {projectInfo && (
            <span className="muted" style={{ fontSize: 12 }}>
              已载入项目上下文 {projectInfo.chars} 字符
            </span>
          )}
        </div>

        {/* 示例任务：围绕所选项目的开发任务，点选填入；未选项目时给出引导 */}
        <div className="wf-examples">
          <div className="wf-examples-head">💡 示例任务 · 基于所选项目 · 点击填入</div>
          <div className="wf-examples-grid">
            {EXAMPLES.map((ex) => (
              <button
                key={ex.title}
                type="button"
                className="wf-example"
                onClick={() => onPickExample(ex.prompt)}
                disabled={running}
                title={ex.prompt}
              >
                <span className="wf-example-icon">{ex.icon}</span>
                <span className="wf-example-title">{ex.title}</span>
              </button>
            ))}
          </div>
        </div>

        {needProject && (
          <div className="alert" style={{ borderColor: 'rgba(255,212,121,0.4)', color: '#ffd479', background: 'rgba(255,212,121,0.1)', marginTop: 8 }}>
            💡 该任务基于项目上下文工作，请先点击上方「选择项目」选取一个项目目录。
          </div>
        )}

        {/* 角色级模型配置选择：从「设置」的模型配置列表中分别指定 Planner/Specialist/Evaluator，
            每条配置自带服务商(baseURL+Key)，因此可跨服务商选用。最实用场景是把
            Evaluator 配成更强/更可靠的模型配置以提升验证收敛率。留空则回退主配置。 */}
        {wfConfigs.length > 0 && (
          <div className="wf-roles">
            <div className="wf-roles-head">🧩 按角色选用模型配置（来自「设置」，可跨服务商）</div>
            <div className="wf-roles-grid">
              {[
                { key: 'planner', label: 'Planner 规划' },
                { key: 'specialist', label: 'Specialist 执行' },
                { key: 'evaluator', label: 'Evaluator 验证' },
              ].map(({ key, label }) => (
                <label className="wf-role" key={key}>
                  <span className="wf-role-label">{label}</span>
                  <select
                    value={roleModels[key] || ''}
                    onChange={(e) => setRoleModels((prev) => ({ ...prev, [key]: e.target.value }))}
                    disabled={running}
                  >
                    <option value="">主配置（{wfConfigs[0].label || wfConfigs[0].model}）</option>
                    {wfConfigs.map((c) => (
                      <option key={c.id} value={c.id}>{c.label || c.model}（{c.model}）</option>
                    ))}
                  </select>
                </label>
              ))}
            </div>
            <div className="hint" style={{ marginTop: 6 }}>
              每条配置对应一个服务商的凭证。不指定则三角色都用主配置。建议把「Evaluator 验证」设为更强/更可靠的配置，可显著提升 PSE 一次收敛到 PASS 的概率。
            </div>
          </div>
        )}

        <label
          className="wf-exec-toggle"
          title="开启后，Specialist 产出的命令会在所选项目目录内实际运行（需你逐项/按项目授权，危险命令强制确认，默认 120s 超时）。关闭则保持纯文本，最安全。"
        >
          <input type="checkbox" checked={allowExec} onChange={(e) => setAllowExec(e.target.checked)} disabled={running} />
          ⚡ 允许执行命令（实验性）— 在所选项目内运行 Specialist 产出的命令
        </label>

        <textarea
          className="chat-input"
          value={task}
          onChange={(e) => setTask(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && (e.metaKey || e.ctrlKey) && !running) {
              e.preventDefault();
              onRun();
            }
          }}
          placeholder={running ? '工作流运行中…' : '描述一个针对所选项目的任务，例如：「为 src/order 模块补充单元测试，覆盖金额计算与状态流转」'}
          disabled={running}
          style={{ minHeight: 96 }}
        />
        <div className="chat-tools">
          {!running ? (
            <button className="btn primary" onClick={onRun} disabled={!task.trim()}>
              运行工作流
            </button>
          ) : (
            <button className="btn ghost" onClick={onStop} disabled={stopping}>
              {stopping ? '正在停止…' : '停止'}
            </button>
          )}
          <button className="btn ghost" onClick={onClear} disabled={running || (!task && !steps.length && !finalReport)}>
            清空
          </button>
          <span className="muted" style={{ fontSize: 12 }}>Cmd / Ctrl + Enter 运行</span>
        </div>
        {error && <div className="alert">{error}</div>}
        {aborted && !error && <div className="alert" style={{ borderColor: 'rgba(255,212,121,0.4)', color: '#ffd479', background: 'rgba(255,212,121,0.1)' }}>工作流已被用户停止。</div>}
      </section>

      {phase && running && (
        <div className="wf-phase">● {phase.message}</div>
      )}

      {/* 规划中（Planner 实时思考） */}
      {running && steps.length === 0 && planThinking && (
        <section className="card">
          <div className="log-head">Planner 规划中…</div>
          <pre className="wf-think">{planThinking}</pre>
        </section>
      )}

      {/* 计划概览 */}
      {analysis && (
        <section className="card">
          <div className="log-head">计划分析</div>
          <div className="muted" style={{ whiteSpace: 'pre-wrap', lineHeight: 1.6 }}>{analysis}</div>
        </section>
      )}

      {/* 步骤时间线 */}
      {steps.length > 0 && (
        <div className="wf-steps">
          {steps.map((s) => (
            <StepCard key={s.id} step={s} active={s.id === activeStepId} executions={executionsByStep[s.id] || []} />
          ))}
        </div>
      )}

      {/* 受控命令执行：授权弹窗（主进程在用户所选项目内执行命令前弹出，等待 Allow/Deny） */}
      {approval && (
        <div className="exec-modal-mask" onClick={() => onApproveExec(false)}>
          <div className="exec-modal" onClick={(e) => e.stopPropagation()}>
            <div className="exec-modal-title">⚡ 授权执行命令{approval.dangerous ? '（危险命令·强制确认）' : ''}</div>
            <div className="muted" style={{ fontSize: 12, marginBottom: 8 }}>
              工作流请求在以下项目目录内执行命令：
            </div>
            <div className="exec-modal-dir" title={approval.dir}>{approval.dir}</div>
            <pre className="exec-modal-cmd">{approval.command}</pre>
            {approval.dangerous && (
              <div className="alert" style={{ margin: '8px 0', borderColor: 'rgba(255,120,120,0.5)', color: '#ff9b9b', background: 'rgba(255,120,120,0.12)' }}>
                ⚠️ 该命令命中危险模式，即使你此前「记住本项目」也会被强制单独确认。请仔细核对。
              </div>
            )}
            <label className="wf-export-overwrite" style={{ margin: '6px 0 12px' }}>
              <input type="checkbox" checked={rememberApproval} onChange={(e) => setRememberApproval(e.target.checked)} disabled={approval.dangerous} />
              始终允许本项目（本次运行）{approval.dangerous ? '· 危险命令不可豁免' : ''}
            </label>
            <div className="chat-tools" style={{ justifyContent: 'flex-end' }}>
              <button className="btn ghost" onClick={() => onApproveExec(false)}>拒绝</button>
              <button className="btn primary" onClick={() => onApproveExec(true)}>允许执行</button>
            </div>
          </div>
        </div>
      )}

      {/* 最终报告 */}
      {finalReport && (
        <section className="card">
          <div className="result-head">
            <span className={`badge ${finalReport.overall.toLowerCase()}`}>
              {finalReport.overall === 'PASS' ? '全部通过' : finalReport.overall === 'FAIL' ? '未通过' : finalReport.overall === 'BLOCKED' ? '已阻塞' : '部分通过'}
            </span>
            <span className="muted">{finalReport.summary}</span>
            <button className="btn ghost" style={{ marginLeft: 'auto' }} onClick={onCopy}>
              {copied ? '已复制' : '复制报告'}
            </button>
            <button className="btn ghost" onClick={() => window.electronAPI.workflowOpenLogs?.()} title="打开运行日志目录（每次运行的结构化记录归档在此）">
              运行日志目录
            </button>
          </div>
          <pre className="result-text" style={{ maxHeight: 520 }}>{finalReport.report}</pre>
          {runSaved && !runSaved.error && (
            <div className="muted" style={{ marginTop: 6, fontSize: 12 }} title={runSaved.jsonPath}>
              ✓ 本次运行已归档：{runSaved.jsonPath ? runSaved.jsonPath.split('/').slice(-1)[0] : ''}（JSON + Markdown）
            </div>
          )}
          {runSaved && runSaved.error && (
            <div className="muted" style={{ marginTop: 6, fontSize: 12, color: '#ff9b9b' }}>
              运行记录归档失败：{runSaved.error}
            </div>
          )}

          {/* 非 PASS 时提示：导出的代码未经 Evaluator 验证 */}
          {finalReport.overall !== 'PASS' && (
            <div className="muted" style={{ margin: '8px 0' }}>
              本工作流未全部通过（{finalReport.overall}），导出代码未经 Evaluator 验证，请人工复核后再写入。
            </div>
          )}

          {/* 导出代码：从交付物提取文件 -> 用户确认 -> 写入选定目录 */}
          <div className="wf-export">
            <div className="wf-export-head">
              <button className="btn primary" onClick={onExportExtract} disabled={exporting}>
                {exporting ? '提取中…' : fileList ? '重新提取代码' : '导出代码'}
              </button>
              {fileList && fileList.length > 0 && (
                <>
                  <button className="btn ghost" onClick={onPickExportDir}>选择目录</button>
                  {exportDir && <span className="wf-export-dir" title={exportDir}>{exportDir}</span>}
                  <label className="wf-export-overwrite" title="推荐开启：导出文件写入 _pse_export/ 子目录，绝不覆盖现有源码">
                    <input type="checkbox" checked={sandbox} onChange={(e) => setSandbox(e.target.checked)} />
                    安全沙箱（推荐）
                  </label>
                  {!sandbox && (
                    <>
                      <label className="wf-export-overwrite" title="非沙箱模式下，覆盖 preload.js/electron.js/src/ 等关键源文件需单独确认">
                        <input type="checkbox" checked={forceCritical} onChange={(e) => setForceCritical(e.target.checked)} />
                        确认覆盖关键源文件
                      </label>
                      <label className="wf-export-overwrite">
                        <input type="checkbox" checked={overwriteMode} onChange={(e) => setOverwriteMode(e.target.checked)} />
                        覆盖其他已存在
                      </label>
                    </>
                  )}
                  <button className="btn primary" onClick={onExportWrite} disabled={!exportDir} style={{ marginLeft: 'auto' }}>
                    写入 {fileList.filter((f) => f.checked).length} 个文件
                  </button>
                </>
              )}
            </div>

            {exportError && <div className="alert">{exportError}</div>}

            {fileList && fileList.length > 0 && (
              <div className="wf-export-list">
                {fileList.map((f, i) => {
                  const r = writeResult && writeResult.results ? writeResult.results.find((x) => x.path === f.path) : null;
                  return (
                    <div key={i} className="wf-export-file">
                      <div className="wf-export-file-row">
                        <input type="checkbox" checked={f.checked} onChange={() => onToggleFile(i)} />
                        <input className="wf-export-path" value={f.path} onChange={(e) => onEditPath(i, e.target.value)} />
                        <span className="badge token">{f.language}</span>
                        {r && (r.ok
                          ? <span className="badge pass">已写入{r.existed ? '(覆盖)' : ''}</span>
                          : <span className="badge fail">{r.existed ? '已存在' : (r.error || '失败')}</span>)}
                      </div>
                      <pre className="wf-export-preview">{(f.content || '').slice(0, 200)}{f.content && f.content.length > 200 ? '…' : ''}</pre>
                    </div>
                  );
                })}
              </div>
            )}

            {writeResult && (
              <div className="wf-export-summary">
                写入完成：{writeResult.written} 成功 / {writeResult.skipped} 跳过 / {writeResult.blocked} 已阻止
                {writeResult.sandboxDir && (
                  <div className="muted">文件位于沙箱：{writeResult.sandboxDir}（请审阅后手动复制所需文件，不自动覆盖现有源码）</div>
                )}
                {writeResult.criticalBlocked > 0 && (
                  <span className="muted"> · {writeResult.criticalBlocked} 个关键源文件已阻止覆盖</span>
                )}
              </div>
            )}
          </div>
        </section>
      )}

      {/* 原始事件日志：按时间顺序记录 阶段/计划/判决/重试/结束（含时钟与相对耗时） */}
      {rawLog.length > 0 && (
        <section className="card">
          <div className="log-head" style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
            <button className="wf-log-toggle" onClick={() => setLogOpen((o) => !o)}>
              {logOpen ? '▾' : '▸'} 原始事件日志
            </button>
            <span className="muted" style={{ fontSize: 12 }}>{rawLog.length} 条</span>
            <button className="btn ghost" style={{ marginLeft: 'auto' }} onClick={onCopyLog}>
              复制日志
            </button>
          </div>
          {logOpen && (
            <div className="wf-log" ref={logRef}>
              {rawLog.map((e, i) => (
                <div key={i} className={`wf-log-line ${e.kind}`}>
                  <span className="wf-log-time">{fmtClock(e.t)}</span>
                  <span className="wf-log-el">{fmtElapsed(e.t)}</span>
                  <span className="wf-log-msg">{e.label}</span>
                </div>
              ))}
            </div>
          )}
        </section>
      )}
    </div>
  );
}
