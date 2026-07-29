import ChatModule from '../modules/ChatModule';
import TranslateModule from '../modules/TranslateModule';
import WorkflowModule from '../modules/WorkflowModule';
import WorkflowDesignerApp from '../modules/WorkflowDesignerModule';

// 功能模块注册表：后续新增 AI 工作流，只需在此数组加一项 + 写一个模块组件。
// component 直接绑定渲染组件，App 按 active 渲染对应模块 —— 新增模块无需改动 App.js。
// 注意：设置（SettingsView）是全局凭证视图，不属于功能模块，由 Sidebar 单独处理。
export const MODULES = [
  {
    id: 'chat',
    name: '大模型对话',
    icon: '💬',
    desc: '与任意 OpenAI 兼容大模型多轮对话（流式输出）。',
    component: ChatModule,
  },
  {
    id: 'translate',
    name: '页面翻译',
    icon: '🌐',
    desc: '输入网页 URL，自动识别中/英文并互译（中→英、英→中）。',
    component: TranslateModule,
  },
  {
    id: 'workflow',
    name: '工作流编排',
    icon: '🔄',
    desc: 'Planner-Specialist-Evaluator 工作流引擎（证据驱动验证）。',
    component: WorkflowModule,
  },
  {
    id: 'designer',
    name: '工作流设计器',
    icon: '🧩',
    desc: '可视化配置 PSE 工作流（Planner/Specialist/Evaluator），保存为可复用模板并一键执行真实引擎。',
    component: WorkflowDesignerApp,
  },
];
