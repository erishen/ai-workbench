import React, { useState, useEffect, useRef } from 'react';

const TASK_TYPES = [
  { value: 'auto', label: '自动推断' },
  { value: 'spring', label: 'Spring Boot（Java）' },
  { value: 'python', label: 'Python（FastAPI / uv）' },
  { value: 'frontend', label: '前端（Vite / React）' },
  { value: 'generic', label: '通用' },
];

const PHASE_TYPES = [
  { value: 'specialist', label: 'Specialist（产出+执行）' },
  { value: 'evaluator', label: 'Evaluator（验证）' },
  { value: 'reviewer', label: 'Reviewer（复核）' },
];

function slugify(s) {
  const base = String(s || '')
    .trim()
    .toLowerCase()
    .replace(/[^\w一-龥]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40);
  return base || 'wf-' + Date.now().toString(36);
}

// 默认工作流模板工厂：每次调用生成全新 _key，避免编辑互相污染。
// 预置一套可编辑的 PSE 步骤（方案设计 → 实现产出 → 验证交付），
// 示范 specialist/evaluator/reviewer 三阶段与依赖链，打开设计器即非空白。
function makeStepKey() {
  return Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
}
function buildDefaultTemplate() {
  const k1 = makeStepKey();
  const k2 = makeStepKey();
  const k3 = makeStepKey();
  return [
    {
      _key: k1,
      title: '方案调研与设计',
      description: '明确目标与约束，产出可执行方案与目录结构',
      ac: '已梳理需求与验收标准\n已确定技术选型与目录结构',
      verify: '',
      depends: [],
      phases: ['specialist', 'evaluator'],
      maxRetry: 3,
      retryOn: ['PARTIAL'],
      x: 28,
      y: 22,
    },
    {
      _key: k2,
      title: '实现与产出',
      description: '按方案落地代码/配置，产出可验证交付物',
      ac: '核心功能已实现\n关键命令可成功执行（如构建/启动）',
      verify: '如：cd <目录> && <构建或启动命令> --version',
      depends: [k1],
      phases: ['specialist', 'evaluator'],
      maxRetry: 3,
      retryOn: ['PARTIAL'],
      x: 240,
      y: 120,
    },
    {
      _key: k3,
      title: '验证与交付',
      description: '独立复核交付物是否满足验收标准，汇总最终报告',
      ac: '验收标准全部 PASS\n已产出最终交付说明',
      verify: '',
      depends: [k2],
      phases: ['specialist', 'evaluator', 'reviewer'],
      maxRetry: 3,
      retryOn: ['PARTIAL'],
      x: 452,
      y: 220,
    },
  ];
}

const NODE_W = 184;
const NODE_H = 80;
const CANVAS_W = 860;
const CANVAS_H = 440;

// 计算矩形边框上的交点（用于连线箭头的端点，避免箭头被节点遮住）
function borderPoint(cx, cy, w, h, towardX, towardY) {
  const dx = towardX - cx;
  const dy = towardY - cy;
  if (dx === 0 && dy === 0) return { x: cx, y: cy };
  const hw = w / 2;
  const hh = h / 2;
  const scale = 1 / Math.max(Math.abs(dx) / hw, Math.abs(dy) / hh);
  return { x: cx + dx * scale, y: cy + dy * scale };
}

// 管道示意图：开始 → Planner → Specialist ⇄ Evaluator → Final。暗色工作台风格。
function PipelineDiagram() {
  const stage = (x, label, sub) => (
    <g>
      <rect x={x} y={20} width={96} height={48} rx={9} fill="#1f6feb22" stroke="#3b82f6" strokeWidth="1.5" />
      <text x={x + 48} y={42} textAnchor="middle" fontSize="13" fill="#dbeafe" fontWeight="600">{label}</text>
      <text x={x + 48} y={58} textAnchor="middle" fontSize="10" fill="#93b4e0">{sub}</text>
    </g>
  );
  const arrow = (x1, x2, color) => (
    <line x1={x1} y1={44} x2={x2} y2={44} stroke={color} strokeWidth="1.5" markerEnd="url(#aw)" />
  );
  return (
    <svg viewBox="0 0 720 96" width="100%" style={{ maxWidth: 760, display: 'block' }}>
      <defs>
        <marker id="aw" markerWidth="9" markerHeight="9" refX="6" refY="3" orient="auto">
          <path d="M0,0 L6,3 L0,6 Z" fill="#6b8bb5" />
        </marker>
        <marker id="aw2" markerWidth="9" markerHeight="9" refX="6" refY="3" orient="auto">
          <path d="M0,0 L6,3 L0,6 Z" fill="#e0a458" />
        </marker>
      </defs>
      {stage(10, '开始', '')}
      {arrow(106, 146, '#6b8bb5')}
      {stage(150, 'Planner', '拆分 + AC')}
      {arrow(246, 286, '#6b8bb5')}
      {stage(290, 'Specialist', '执行产出')}
      {/* 重试环：Evaluator → Specialist */}
      <path d="M478,72 C478,92 338,92 338,72" fill="none" stroke="#e0a458" strokeWidth="1.5" markerEnd="url(#aw2)" />
      <text x={408} y={90} textAnchor="middle" fontSize="9" fill="#e0a458">证据不符 → 局部重试 ≤ N</text>
      {arrow(386, 426, '#6b8bb5')}
      {stage(430, 'Evaluator', '证据验收')}
      {arrow(526, 566, '#6b8bb5')}
      {stage(570, 'Final', '汇总报告')}
    </svg>
  );
}

function phaseLabel(ev) {
  const map = {
    planner: 'Planner 正在拆解任务…',
    specialist: ev.message ? `Specialist：${ev.message}` : 'Specialist 执行中…',
    evaluator: ev.message ? `Evaluator：${ev.message}` : 'Evaluator 验证中…',
    blocked: `步骤被跳过（前置失败）：${ev.message || ''}`,
  };
  return map[ev.phase] || ev.message || ev.phase || '';
}

export default function WorkflowDesignerApp() {
  const [def, setDef] = useState({
    id: '',
    name: '',
    task: '',
    projectDir: '',
    projectName: '',
    taskTypeOverride: 'auto',
    allowExec: true,
    maxRetry: 3,
    steps: [],  // 默认回归自主型：留白即走 Planner 自动拆解
  });
  const [savedList, setSavedList] = useState([]);
  const [running, setRunning] = useState(false);
  const [stopping, setStopping] = useState(false);
  const [progress, setProgress] = useState([]); // { t, kind, label }
  const [finalReport, setFinalReport] = useState(null);
  const [runSaved, setRunSaved] = useState(null);
  const [msg, setMsg] = useState('');
  const unsubRef = useRef(null);
  const canvasRef = useRef(null);
  const dragRef = useRef(null);
  const handlersRef = useRef(null);
  const [selectedKey, setSelectedKey] = useState(null);

  const update = (patch) => setDef((d) => ({ ...d, ...patch }));
  const setTransient = (m) => {
    setMsg(m || '');
  };

  // 步骤编排（设计器预置步骤）：定义后运行时跳过自动 Planner，直接按序驱动 Specialist⇄Evaluator。
  const newStepKey = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
  const updateStepByKey = (key, patch) =>
    setDef((d) => ({ ...d, steps: d.steps.map((s) => (s._key === key ? { ...s, ...patch } : s)) }));
  const onAddStep = () =>
    setDef((d) => {
      const n = d.steps.length;
      const x = 28 + (n % 4) * 212;
      const y = 22 + Math.floor(n / 4) * 132;
      return {
        ...d,
        steps: [
          ...d.steps,
          {
            _key: newStepKey(),
            title: '',
            description: '',
            ac: '',
            verify: '',
            depends: [],
            phases: ['specialist', 'evaluator'],
            maxRetry: 3,
            retryOn: ['PARTIAL'],
            x,
            y,
          },
        ],
      };
    });
  const onRemoveStep = (key) =>
    setDef((d) => ({
      ...d,
      steps: d.steps
        .filter((s) => s._key !== key)
        .map((s) => ({ ...s, depends: (s.depends || []).filter((k) => k !== key) })),
    }));

  // 拖拽节点：鼠标按下记录偏移，window 级 mousemove 持续更新坐标，mouseup 解绑。
  const onNodeMouseDown = (e, st) => {
    if (e.button !== 0) return;
    e.preventDefault();
    const canvas = canvasRef.current;
    if (!canvas) return;
    const nodeRect = e.currentTarget.getBoundingClientRect();
    dragRef.current = { key: st._key, dx: e.clientX - nodeRect.left, dy: e.clientY - nodeRect.top };
    if (!handlersRef.current) {
      handlersRef.current = {
        move: (ev) => {
          const d = dragRef.current;
          const cv = canvasRef.current;
          if (!d || !cv) return;
          const rect = cv.getBoundingClientRect();
          let nx = ev.clientX - rect.left - d.dx;
          let ny = ev.clientY - rect.top - d.dy;
          nx = Math.max(0, Math.min(CANVAS_W - NODE_W, nx));
          ny = Math.max(0, Math.min(CANVAS_H - NODE_H, ny));
          setDef((cur) => ({ ...cur, steps: cur.steps.map((s) => (s._key === d.key ? { ...s, x: nx, y: ny } : s)) }));
        },
        up: () => {
          dragRef.current = null;
          if (handlersRef.current) {
            window.removeEventListener('mousemove', handlersRef.current.move);
            window.removeEventListener('mouseup', handlersRef.current.up);
          }
        },
      };
    }
    window.addEventListener('mousemove', handlersRef.current.move);
    window.addEventListener('mouseup', handlersRef.current.up);
  };

  const refreshList = async () => {
    try {
      const r = await window.electronAPI.listWorkflows();
      if (r && r.success) setSavedList(r.list || []);
    } catch (_) {
      /* 忽略 */
    }
  };

  useEffect(() => {
    refreshList();
    return () => {
      if (unsubRef.current) {
        try {
          unsubRef.current();
        } catch (_) {
          /* ignore */
        }
      }
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const handleEvent = (ev) => {
    if (!ev || !ev.type) return;
    switch (ev.type) {
      case 'capabilities':
        setProgress((p) => [...p, { t: Date.now(), kind: 'info', label: '运行环境工具链探测完成' }]);
        break;
      case 'project':
        setProgress((p) => [...p, { t: Date.now(), kind: 'info', label: `已载入项目上下文：${ev.name}（${ev.chars} 字符）` }]);
        break;
      case 'phase':
        setProgress((p) => [
          ...p,
          { t: Date.now(), kind: ev.phase === 'evaluator' || ev.phase === 'blocked' ? 'warn' : 'info', label: phaseLabel(ev) },
        ]);
        break;
      case 'planner':
        setProgress((p) => [...p, { t: Date.now(), kind: 'info', label: ev.fromDesigner ? '使用设计器预置步骤（已跳过自动 Planner）' : 'Planner 拆解完成' }]);
        break;
      case 'specialist':
        setProgress((p) => [...p, { t: Date.now(), kind: 'info', label: `Specialist：${ev.message || ''}` }]);
        break;
      case 'evaluator': {
        const v = ev.verdict;
        const kind = v === 'PASS' ? 'ok' : v === 'FAIL' || v === 'BLOCKED' ? 'error' : 'warn';
        setProgress((p) => [...p, { t: Date.now(), kind, label: `步骤「${ev.title || ''}」判决：${v || ''}` }]);
        break;
      }
      case 'step-start':
        setProgress((p) => [...p, { t: Date.now(), kind: 'info', label: `▶ 步骤开始：${ev.stepId || ''}` }]);
        break;
      case 'retry':
        setProgress((p) => [...p, { t: Date.now(), kind: 'warn', label: `↻ 重试（${ev.attempt}/${ev.max}）：${ev.reason || ''}` }]);
        break;
      case 'final':
        setFinalReport(ev);
        setRunning(false);
        setStopping(false);
        setProgress((p) => [...p, { t: Date.now(), kind: 'info', label: `工作流结束：整体 ${ev.overall}` }]);
        break;
      case 'run-saved':
        setRunSaved(ev);
        setProgress((p) => [...p, { t: Date.now(), kind: 'ok', label: `本次运行已归档：${ev.jsonPath || ''}` }]);
        break;
      case 'aborted':
        setRunning(false);
        setStopping(false);
        setProgress((p) => [...p, { t: Date.now(), kind: 'warn', label: '用户已停止' }]);
        break;
      case 'error':
        setRunning(false);
        setStopping(false);
        setProgress((p) => [...p, { t: Date.now(), kind: 'error', label: `错误：${ev.message || ''}` }]);
        break;
      default:
        break;
    }
  };

  const ensureSub = () => {
    if (!unsubRef.current && window.electronAPI.onWorkflowProgress) {
      unsubRef.current = window.electronAPI.onWorkflowProgress(handleEvent);
    }
  };

  const onPickProject = async () => {
    try {
      const r = await window.electronAPI.workflowPickProject();
      if (r && !r.canceled && r.dir) {
        update({ projectDir: r.dir, projectName: r.name });
        setTransient('已选择项目：' + r.name);
      }
    } catch (e) {
      setTransient('选择目录失败：' + e.message);
    }
  };

  // saveAs=true 时强制生成新 id（另存为新模板，不覆盖原模板）
  const onSave = async (saveAs = false) => {
    const name = def.name.trim();
    const task = def.task.trim();
    if (!name) return setTransient('请填写模板名称');
    if (!task) return setTransient('请填写任务内容');
    const id = saveAs || !def.id ? slugify(name) + '-' + Date.now().toString(36).slice(-4) : def.id;
    const payload = { ...def, id, name, task };
    try {
      const r = await window.electronAPI.saveWorkflow(payload);
      setTransient(r.message || (r.success ? '已保存' : '保存失败'));
      if (r.success) {
        update({ id });
        await refreshList();
      }
    } catch (e) {
      setTransient('保存异常：' + e.message);
    }
  };

  // 新建：清空表单（不动已保存模板），从头配置
  const onNew = () => {
    setDef({
      id: '',
      name: '',
      task: '',
      projectDir: '',
      projectName: '',
      taskTypeOverride: 'auto',
      allowExec: true,
      maxRetry: 3,
      steps: [],  // 默认回归自主型：留白即走 Planner 自动拆解
    });
    setFinalReport(null);
    setProgress([]);
    setRunSaved(null);
    setTransient('已新建空白模板（自主模式）');
  };

  const onLoad = async (id) => {
    try {
      const r = await window.electronAPI.loadWorkflow(id);
      if (r && r.success && r.workflow) {
        const wf = r.workflow;
        setDef({
          id: wf.id,
          name: wf.name || '',
          task: wf.task || '',
          projectDir: wf.projectDir || '',
          projectName: wf.projectName || '',
          taskTypeOverride: wf.taskTypeOverride || 'auto',
          allowExec: !!wf.allowExec,
          maxRetry: typeof wf.maxRetry === 'number' ? wf.maxRetry : 3,
          steps: (Array.isArray(wf.steps) ? wf.steps : []).map((s, i) => ({
            _key: s._key || newStepKey(),
            title: s.title || '',
            description: s.description || '',
            ac: typeof s.ac === 'string' ? s.ac : Array.isArray(s.ac) ? s.ac.join('\n') : '',
            verify: s.verify || '',
            depends: Array.isArray(s.depends) ? s.depends : [],
            phases: Array.isArray(s.phases) && s.phases.length ? s.phases : ['specialist', 'evaluator'],
            maxRetry: typeof s.maxRetry === 'number' && s.maxRetry > 0 ? s.maxRetry : 3,
            retryOn: Array.isArray(s.retryOn) && s.retryOn.length ? s.retryOn : ['PARTIAL'],
            x: typeof s.x === 'number' ? s.x : 28 + (i % 4) * 212,
            y: typeof s.y === 'number' ? s.y : 22 + Math.floor(i / 4) * 132,
          })),
        });
        setFinalReport(null);
        setProgress([]);
        setRunSaved(null);
        setTransient('已载入：「' + (wf.name || id) + '」');
      } else {
        setTransient(r.message || '载入失败');
      }
    } catch (e) {
      setTransient('载入异常：' + e.message);
    }
  };

  const onDelete = async (id, name) => {
    // eslint-disable-next-line no-restricted-globals
    if (!window.confirm(`确定删除模板「${name || id}」？此操作不可撤销。`)) return;
    try {
      const r = await window.electronAPI.deleteWorkflow(id);
      setTransient(r.message || (r.success ? '已删除' : '删除失败'));
      if (r.success) {
        // 若删的是当前载入的模板，解除 id 绑定（表单内容保留，可另存）
        if (def.id === id) update({ id: '' });
        await refreshList();
      }
    } catch (e) {
      setTransient('删除异常：' + e.message);
    }
  };

  const onRun = async () => {
    const task = def.task.trim();
    if (!task) return setTransient('请先填写任务内容');
    setTransient('');
    setFinalReport(null);
    setProgress([]);
    setRunSaved(null);
    setRunning(true);
    ensureSub();
    try {
      const r = await window.electronAPI.workflowRunEx({
        task,
        projectDir: def.projectDir || null,
        allowExec: !!def.allowExec,
        taskTypeOverride: def.taskTypeOverride === 'auto' ? undefined : def.taskTypeOverride,
        maxRetry: def.maxRetry,
        steps:
          def.steps && def.steps.length
            ? def.steps.map((s) => ({
                id: s._key,
                title: s.title || '',
                description: s.description || '',
                ac: s.ac || '',
                verify: s.verify || '',
                depends: Array.isArray(s.depends) ? s.depends.filter((k) => k !== s._key) : [],
                phases: Array.isArray(s.phases) && s.phases.length ? s.phases : ['specialist', 'evaluator'],
                maxRetry: typeof s.maxRetry === 'number' && s.maxRetry > 0 ? s.maxRetry : 3,
                retryOn: Array.isArray(s.retryOn) && s.retryOn.length ? s.retryOn : ['PARTIAL'],
              }))
            : undefined,
      });
      if (!r || !r.started) setTransient('启动失败');
    } catch (e) {
      setRunning(false);
      setTransient('启动异常：' + e.message);
    }
  };

  const onStop = async () => {
    setStopping(true);
    try {
      await window.electronAPI.workflowStop();
    } catch (_) {
      /* ignore */
    }
  };

  const onOpenLogs = async () => {
    try {
      await window.electronAPI.workflowOpenLogs();
    } catch (_) {
      /* ignore */
    }
  };

  const onCopy = () => {
    if (finalReport && finalReport.report) {
      navigator.clipboard?.writeText(finalReport.report).catch(() => {});
    }
  };

  // 图形化画布派生数据：选中节点、连线（顺序 + 显式依赖）
  const selectedStep = def.steps.find((s) => s._key === selectedKey) || null;
  const stepIndexByKey = {};
  def.steps.forEach((s, i) => {
    stepIndexByKey[s._key] = i;
  });
  const edges = [];
  def.steps.forEach((s, i) => {
    (s.depends || []).forEach((depKey) => {
      const di = stepIndexByKey[depKey];
      if (di != null && di !== i) edges.push({ from: di, to: i, kind: 'dep' });
    });
  });
  for (let i = 1; i < def.steps.length; i++) {
    edges.push({ from: i - 1, to: i, kind: 'seq' });
  }
  const nodeCenter = (i) => ({ x: def.steps[i].x + NODE_W / 2, y: def.steps[i].y + NODE_H / 2 });

  return (
    <div style={{ padding: '24px 28px', maxWidth: 920, margin: '0 auto', color: '#e6e9ef' }}>
      <h2 style={{ margin: '0 0 4px' }}>工作流设计器</h2>
      <p style={{ margin: '0 0 18px', color: '#9aa6b8', fontSize: 13 }}>
        可视化配置 PSE 工作流（Planner → Specialist ⇄ Evaluator → Final）。在下方画布中拖拽节点、定义固定步骤编排（跳过自动 Planner），保存为可复用模板，一键执行真实引擎。
      </p>

      <div style={{ background: 'rgba(17,21,31,0.6)', border: '1px solid #232b3a', borderRadius: 10, padding: '14px 16px', marginBottom: 18 }}>
        <PipelineDiagram />
      </div>

      {/* 配置表单 */}
      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 14, marginBottom: 16 }}>
        <label style={{ display: 'flex', flexDirection: 'column', gap: 6, fontSize: 13 }}>
          <span style={{ color: '#9aa6b8' }}>模板名称</span>
          <input
            className="text-input"
            value={def.name}
            placeholder="例如：Laravel+Angular 全栈脚手架"
            onChange={(e) => update({ name: e.target.value })}
            style={inputStyle}
          />
        </label>
        <label style={{ display: 'flex', flexDirection: 'column', gap: 6, fontSize: 13 }}>
          <span style={{ color: '#9aa6b8' }}>任务类型（可选覆盖）</span>
          <select value={def.taskTypeOverride} onChange={(e) => update({ taskTypeOverride: e.target.value })} style={inputStyle}>
            {TASK_TYPES.map((t) => (
              <option key={t.value} value={t.value}>{t.label}</option>
            ))}
          </select>
        </label>
        <label style={{ display: 'flex', flexDirection: 'column', gap: 6, fontSize: 13, gridColumn: '1 / -1' }}>
          <span style={{ color: '#9aa6b8' }}>任务内容（自然语言，描述要产出什么）</span>
          <textarea
            value={def.task}
            placeholder="例如：在 research 目录下初始化一个 Laravel 后端 + Angular 前端，统一放在 fullstack-app/ 下，并配置数据库迁移与联调代理。"
            rows={3}
            onChange={(e) => update({ task: e.target.value })}
            style={{ ...inputStyle, resize: 'vertical', fontFamily: 'inherit' }}
          />
        </label>
        <label style={{ display: 'flex', flexDirection: 'column', gap: 6, fontSize: 13, gridColumn: '1 / -1' }}>
          <span style={{ color: '#9aa6b8' }}>项目目录（可选；留空则为纯文本任务模式）</span>
          <div style={{ display: 'flex', gap: 8 }}>
            <input className="text-input" value={def.projectDir} readOnly placeholder="未选择" style={{ ...inputStyle, flex: 1 }} />
            <button className="btn ghost" onClick={onPickProject}>选择目录</button>
          </div>
          {def.projectName ? <span style={{ fontSize: 12, color: '#7fd1a0' }}>已选：{def.projectName}</span> : null}
        </label>
        <label style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 13 }}>
          <input type="checkbox" checked={def.allowExec} onChange={(e) => update({ allowExec: e.target.checked })} />
          <span>允许命令执行（Specialist 可实际运行命令取证）</span>
        </label>
        <label style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 13 }}>
          <span style={{ color: '#9aa6b8' }}>重试上限</span>
          <input
            type="number"
            min={1}
            max={5}
            value={def.maxRetry}
            onChange={(e) => update({ maxRetry: Math.max(1, Math.min(5, Number(e.target.value) || 3)) })}
            style={{ ...inputStyle, width: 70 }}
          />
        </label>
      </div>

      {/* 步骤编排画布（图形化·定义后跳过自动 Planner） */}
      <div style={{ background: 'rgba(17,21,31,0.6)', border: '1px solid #232b3a', borderRadius: 10, padding: '14px 16px', marginBottom: 18 }}>
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 8 }}>
          <div style={{ fontSize: 14, fontWeight: 600 }}>步骤编排画布（图形化）</div>
          <button className="btn ghost" onClick={onAddStep} style={{ padding: '4px 12px' }}>+ 添加步骤</button>
        </div>
        <p style={{ margin: '0 0 12px', color: '#9aa6b8', fontSize: 12 }}>
          拖动画布上的节点调整布局，点击节点编辑细节；蓝色箭头表示执行顺序、橙色箭头表示显式依赖（前置步骤）。定义步骤后运行将跳过自动 Planner。
        </p>

        {def.steps.length === 0 ? (
          <div style={{ fontSize: 13, color: '#6b7688', padding: '18px 4px', display: 'flex', alignItems: 'center', gap: 14, flexWrap: 'wrap' }}>
            <span>留白即<b style={{ color: '#9aa6b8' }}>自主模式</b>：运行时由 Planner 自动拆解任务。</span>
            <button className="btn ghost" onClick={() => setDef(d => ({ ...d, steps: buildDefaultTemplate() }))} style={{ padding: '4px 12px' }}>+ 加载示例编排</button>
            <span style={{ fontSize: 12 }}>或点「+ 添加步骤」手动编排（可选高级模式）。</span>
          </div>
        ) : (
          <div
            style={{ position: 'relative', width: CANVAS_W, height: CANVAS_H, background: '#0a0f1a', border: '1px solid #232b3a', borderRadius: 8, overflow: 'auto' }}
            ref={canvasRef}
            onClick={() => setSelectedKey(null)}
          >
            <svg width={CANVAS_W} height={CANVAS_H} style={{ position: 'absolute', left: 0, top: 0, pointerEvents: 'none' }}>
              <defs>
                <marker id="seqArrow" markerWidth="9" markerHeight="9" refX="7" refY="3" orient="auto"><path d="M0,0 L7,3 L0,6 Z" fill="#3b6ea5" /></marker>
                <marker id="depArrow" markerWidth="9" markerHeight="9" refX="7" refY="3" orient="auto"><path d="M0,0 L7,3 L0,6 Z" fill="#e0a458" /></marker>
              </defs>
              {edges.map((e, ei) => {
                const a = nodeCenter(e.from);
                const b = nodeCenter(e.to);
                const start = borderPoint(a.x, a.y, NODE_W, NODE_H, b.x, b.y);
                const end = borderPoint(b.x, b.y, NODE_W, NODE_H, a.x, a.y);
                return (
                  <line
                    key={'e' + ei}
                    x1={start.x}
                    y1={start.y}
                    x2={end.x}
                    y2={end.y}
                    stroke={e.kind === 'dep' ? '#e0a458' : '#3b6ea5'}
                    strokeWidth={e.kind === 'dep' ? 2 : 1.3}
                    markerEnd={e.kind === 'dep' ? 'url(#depArrow)' : 'url(#seqArrow)'}
                  />
                );
              })}
            </svg>
            {def.steps.map((st, idx) => {
              const sel = st._key === selectedKey;
              return (
                <div
                  key={st._key}
                  onMouseDown={(e) => onNodeMouseDown(e, st)}
                  onClick={(e) => {
                    e.stopPropagation();
                    setSelectedKey(st._key);
                  }}
                  style={{
                    position: 'absolute',
                    left: st.x,
                    top: st.y,
                    width: NODE_W,
                    height: NODE_H,
                    boxSizing: 'border-box',
                    background: sel ? '#13233f' : '#0e1726',
                    border: `1px solid ${sel ? '#3b82f6' : '#2a3344'}`,
                    borderRadius: 8,
                    padding: '8px 10px',
                    cursor: 'grab',
                    userSelect: 'none',
                    boxShadow: sel ? '0 0 0 2px rgba(59,130,246,0.3)' : 'none',
                  }}
                >
                  <div style={{ fontSize: 11, color: '#6b8bb5', marginBottom: 2 }}>步骤 {idx + 1}</div>
                  <div style={{ fontSize: 13, fontWeight: 600, color: '#e6e9ef', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
                    {st.title || '（未命名）'}
                  </div>
                  <div style={{ fontSize: 11, color: '#7f8aa0', marginTop: 4, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
                    {(st.phases || ['specialist', 'evaluator']).join('→')}
                  </div>
                </div>
              );
            })}
          </div>
        )}

        {/* 选中节点的详情面板 */}
        {selectedStep ? (
          <div style={{ border: '1px solid #2a3344', borderRadius: 8, padding: 12, background: '#0d1320', marginTop: 12 }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 10 }}>
              <span style={{ fontWeight: 600, fontSize: 14 }}>
                编辑 · 步骤 {def.steps.findIndex((s) => s._key === selectedKey) + 1}：{selectedStep.title || '（未命名）'}
              </span>
              <button className="btn danger" style={{ marginLeft: 'auto', padding: '4px 10px' }} onClick={() => { onRemoveStep(selectedKey); setSelectedKey(null); }}>删除步骤</button>
            </div>
            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12 }}>
              <label style={{ display: 'flex', flexDirection: 'column', gap: 4, fontSize: 12 }}>
                <span style={{ color: '#9aa6b8' }}>标题</span>
                <input className="text-input" value={selectedStep.title || ''} onChange={(e) => updateStepByKey(selectedKey, { title: e.target.value })} style={inputStyle} />
              </label>
              <label style={{ display: 'flex', flexDirection: 'column', gap: 4, fontSize: 12 }}>
                <span style={{ color: '#9aa6b8' }}>验证要点（可选·验证命令/说明）</span>
                <input className="text-input" value={selectedStep.verify || ''} onChange={(e) => updateStepByKey(selectedKey, { verify: e.target.value })} style={inputStyle} placeholder="如：cd <目录> && php artisan --version" />
              </label>
              <label style={{ display: 'flex', flexDirection: 'column', gap: 4, fontSize: 12, gridColumn: '1 / -1' }}>
                <span style={{ color: '#9aa6b8' }}>描述（要产出什么）</span>
                <textarea value={selectedStep.description || ''} rows={2} placeholder="自然语言描述该步骤的交付物"
                  onChange={(e) => updateStepByKey(selectedKey, { description: e.target.value })} style={{ ...inputStyle, resize: 'vertical', fontFamily: 'inherit' }} />
              </label>
              <label style={{ display: 'flex', flexDirection: 'column', gap: 4, fontSize: 12, gridColumn: '1 / -1' }}>
                <span style={{ color: '#9aa6b8' }}>验收标准 AC（每行一条）</span>
                <textarea value={selectedStep.ac || ''} rows={2}
                  placeholder={'- composer 安装完成\n- 能 php artisan --version'}
                  onChange={(e) => updateStepByKey(selectedKey, { ac: e.target.value })} style={{ ...inputStyle, resize: 'vertical', fontFamily: 'inherit' }} />
              </label>
              {/* 阶段编排（结构级）：定义该步骤内部的阶段流水线 specialist/evaluator/reviewer 可增删重排 */}
              <div style={{ gridColumn: '1 / -1', borderTop: '1px solid #232b3a', paddingTop: 10, marginTop: 2 }}>
                <div style={{ fontSize: 12, color: '#9aa6b8', marginBottom: 6 }}>阶段编排（结构级·该步骤内部流水线）</div>
                {(selectedStep.phases || ['specialist', 'evaluator']).map((ph, pi) => (
                  <div key={ph} style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 6 }}>
                    <span style={{ fontSize: 12, width: 18, color: '#6b8bb5' }}>{pi + 1}.</span>
                    <span style={{ fontSize: 13, background: '#0e1726', border: '1px solid #2a3344', borderRadius: 6, padding: '4px 10px', minWidth: 170 }}>
                      {PHASE_TYPES.find((p) => p.value === ph) ? PHASE_TYPES.find((p) => p.value === ph).label : ph}
                    </span>
                    <button className="btn ghost" style={{ padding: '2px 8px' }} disabled={pi === 0} onClick={() => {
                      const cur = selectedStep.phases || ['specialist', 'evaluator'];
                      if (pi === 0) return;
                      const next = cur.slice();
                      const t = next[pi - 1]; next[pi - 1] = next[pi]; next[pi] = t;
                      updateStepByKey(selectedKey, { phases: next });
                    }}>↑</button>
                    <button className="btn ghost" style={{ padding: '2px 8px' }} disabled={pi === (selectedStep.phases || ['specialist', 'evaluator']).length - 1} onClick={() => {
                      const cur = selectedStep.phases || ['specialist', 'evaluator'];
                      if (pi >= cur.length - 1) return;
                      const next = cur.slice();
                      const t = next[pi + 1]; next[pi + 1] = next[pi]; next[pi] = t;
                      updateStepByKey(selectedKey, { phases: next });
                    }}>↓</button>
                    <button className="btn danger" style={{ padding: '2px 8px' }} onClick={() => {
                      const cur = selectedStep.phases || ['specialist', 'evaluator'];
                      updateStepByKey(selectedKey, { phases: cur.filter((p) => p !== ph) });
                    }}>删除</button>
                  </div>
                ))}
                <div style={{ display: 'flex', gap: 6, marginTop: 4, flexWrap: 'wrap' }}>
                  {PHASE_TYPES.filter((p) => !(selectedStep.phases || ['specialist', 'evaluator']).includes(p.value)).map((p) => (
                    <button key={p.value} className="btn ghost" style={{ padding: '2px 8px', fontSize: 12 }} onClick={() => {
                      const cur = selectedStep.phases || ['specialist', 'evaluator'];
                      updateStepByKey(selectedKey, { phases: [...cur, p.value] });
                    }}>+ {p.label}</button>
                  ))}
                  {(selectedStep.phases || ['specialist', 'evaluator']).length === 0 ? <span style={{ fontSize: 12, color: '#6b7688' }}>至少保留一个阶段</span> : null}
                </div>
                <div style={{ display: 'flex', gap: 18, marginTop: 10, alignItems: 'center', flexWrap: 'wrap' }}>
                  <label style={{ fontSize: 13, display: 'flex', alignItems: 'center', gap: 6 }}>
                    <span style={{ color: '#9aa6b8' }}>本步重试上限</span>
                    <input type="number" min={1} max={10} value={selectedStep.maxRetry || 3}
                      onChange={(e) => updateStepByKey(selectedKey, { maxRetry: Math.max(1, Math.min(10, Number(e.target.value) || 3)) })}
                      style={{ ...inputStyle, width: 64 }} />
                  </label>
                  <div style={{ fontSize: 13, display: 'flex', alignItems: 'center', gap: 10 }}>
                    <span style={{ color: '#9aa6b8' }}>触发重试的判定</span>
                    {['PARTIAL', 'FAIL'].map((v) => {
                      const cur = selectedStep.retryOn || ['PARTIAL'];
                      const checked = cur.includes(v);
                      return (
                        <label key={v} style={{ fontSize: 12, display: 'flex', alignItems: 'center', gap: 4, cursor: 'pointer' }}>
                          <input type="checkbox" checked={checked} onChange={(e) => {
                            const next = e.target.checked ? [...cur, v] : cur.filter((x) => x !== v);
                            updateStepByKey(selectedKey, { retryOn: next });
                          }} />
                          {v}
                        </label>
                      );
                    })}
                  </div>
                </div>
              </div>
              <div style={{ gridColumn: '1 / -1' }}>
                <span style={{ color: '#9aa6b8', fontSize: 12 }}>依赖（运行前需先通过的前置步骤）</span>
                <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8, marginTop: 6 }}>
                  {def.steps.filter((s) => s._key !== selectedKey).map((s) => {
                    const checked = (selectedStep.depends || []).includes(s._key);
                    return (
                      <label key={s._key} style={{ fontSize: 12, display: 'flex', alignItems: 'center', gap: 4, background: '#0e1726', border: '1px solid #2a3344', borderRadius: 6, padding: '4px 8px', cursor: 'pointer' }}>
                        <input
                          type="checkbox"
                          checked={checked}
                          onChange={(e) => {
                            const cur = selectedStep.depends || [];
                            const next = e.target.checked ? [...cur, s._key] : cur.filter((k) => k !== s._key);
                            updateStepByKey(selectedKey, { depends: next });
                          }}
                        />
                        {s.title || '（未命名）'}
                      </label>
                    );
                  })}
                  {def.steps.length <= 1 ? <span style={{ fontSize: 12, color: '#6b7688' }}>至少 2 个步骤才能设依赖</span> : null}
                </div>
              </div>
            </div>
          </div>
        ) : (
          <div style={{ fontSize: 12, color: '#6b7688', marginTop: 12 }}>点击画布上的节点进行编辑；拖动节点可调整布局，箭头表示执行顺序 / 依赖关系。</div>
        )}
      </div>

      {/* 操作按钮 */}
      <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap', alignItems: 'center', marginBottom: 10 }}>
        <button className="btn" onClick={() => onSave(false)}>{def.id ? '保存修改' : '保存模板'}</button>
        {def.id ? <button className="btn ghost" onClick={() => onSave(true)}>另存为新模板</button> : null}
        <button className="btn ghost" onClick={onNew}>新建</button>
        <button className="btn ghost" onClick={refreshList}>刷新列表</button>
        {!running ? (
          <button className="btn primary" onClick={onRun}>执行</button>
        ) : (
          <button className="btn danger" onClick={onStop} disabled={stopping}>
            {stopping ? '停止中…' : '停止'}
          </button>
        )}
        <button className="btn ghost" onClick={onOpenLogs}>运行日志目录</button>
        {def.id ? (
          <span style={{ fontSize: 12, color: '#6b8bb5' }}>正在编辑：{def.id}</span>
        ) : null}
      </div>
      {msg ? (
        <div style={{ fontSize: 13, color: '#9aa6b8', marginBottom: 14 }}>{msg}</div>
      ) : null}

      {/* 已保存模板列表 */}
      <div style={{ marginBottom: 18 }}>
        <div style={{ fontSize: 13, color: '#9aa6b8', marginBottom: 8 }}>已保存模板（{savedList.length}）</div>
        {savedList.length === 0 ? (
          <div style={{ fontSize: 13, color: '#6b7688' }}>暂无模板，配置后点「保存模板」。</div>
        ) : (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
            {savedList.map((w) => (
              <div
                key={w.id}
                style={{
                  display: 'flex',
                  alignItems: 'center',
                  gap: 10,
                  background: 'rgba(17,21,31,0.5)',
                  border: '1px solid #232b3a',
                  borderRadius: 8,
                  padding: '8px 12px',
                }}
              >
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div style={{ fontWeight: 600, fontSize: 14 }}>{w.name}</div>
                  <div style={{ fontSize: 12, color: '#7f8aa0', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
                    {w.task || '（无任务）'}
                  </div>
                </div>
                <span style={{ fontSize: 11, color: '#6b7688' }}>
                  {w.taskTypeOverride !== 'auto' ? w.taskTypeOverride : '自动'} · 重试{w.maxRetry}
                  {w.projectDir ? ' · 含项目' : ''}
                  {w.hasSteps ? ` · ${w.stepCount} 步骤` : ''}
                </span>
                <button className="btn ghost" style={{ padding: '4px 10px' }} onClick={() => onLoad(w.id)}>载入</button>
                <button className="btn danger" style={{ padding: '4px 10px' }} onClick={() => onDelete(w.id, w.name)}>删除</button>
              </div>
            ))}
          </div>
        )}
      </div>

      {/* 执行进度时间线 */}
      {(running || progress.length > 0) && (
        <div style={{ marginBottom: 18 }}>
          <div style={{ fontSize: 13, color: '#9aa6b8', marginBottom: 8 }}>执行进度</div>
          <div style={{ background: '#0d1320', border: '1px solid #232b3a', borderRadius: 8, padding: 12, maxHeight: 320, overflowY: 'auto' }}>
            {progress.map((line, i) => (
              <div key={i} className={`wf-log-line ${line.kind === 'ok' ? 'ok' : line.kind === 'error' ? 'error' : line.kind === 'warn' ? 'warn' : ''}`}>
                <span className="wf-log-time">{new Date(line.t).toLocaleTimeString()}</span>
                <span className="wf-log-msg">{line.label}</span>
              </div>
            ))}
            {running ? <div className="wf-log-line"><span className="wf-log-msg" style={{ color: '#6b8bb5' }}>…运行中</span></div> : null}
          </div>
        </div>
      )}

      {/* 最终报告 */}
      {finalReport && (
        <div style={{ marginBottom: 18 }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 8 }}>
            <span style={{ fontSize: 14, fontWeight: 600 }}>最终报告（整体 {finalReport.overall}）</span>
            <span style={{ fontSize: 12, color: '#9aa6b8' }}>{finalReport.summary}</span>
            <button className="btn ghost" style={{ marginLeft: 'auto', padding: '4px 10px' }} onClick={onCopy}>复制报告</button>
          </div>
          <pre className="result-text" style={{ maxHeight: 420, background: '#0d1320' }}>{finalReport.report}</pre>
          {runSaved ? (
            <div style={{ fontSize: 12, color: '#7fd1a0', marginTop: 8 }}>
              ✓ 本次运行已归档：{runSaved.jsonPath}
              {runSaved.mdPath ? `（附 ${runSaved.mdPath}）` : ''}
            </div>
          ) : null}
        </div>
      )}
    </div>
  );
}

const inputStyle = {
  background: '#0d1320',
  border: '1px solid #2a3344',
  borderRadius: 8,
  color: '#e6e9ef',
  padding: '8px 10px',
  fontSize: 13,
  outline: 'none',
};
