// 核心接口定义
export interface IWorkflow {
  id: string;
  name: string;
  nodes: INode[];
  edges: IEdge[];
  config: { 
    background: { color: string; pattern: Pattern }; 
  };
}

export interface INode {
  id: string;
  type: 'chat' | 'translate' | 'decision' | 'start' | 'end'; 
  position: { x: number; y: number };
  data: { 
    label: string; 
    config?: Record<string, any>; 
  }; 
}

export interface IEdge {
  id: string;
  source: string;
  target: string;
  type: 'default' | 'animated';
  data?: { 
    label?: string; 
    condition?: string; 
  }; 
}

// 枚举类型
export enum Pattern {
  CHECKERBOARD = 'checkerboard',
  SOLID = 'solid'
}

// JSON Schema 示例 (用于主进程校验或前端序列化)
const WorkflowSchemaExample = {
  "id": "wf_001",
  "name": "翻译工作流",
  "nodes": [
    {
      "id": "start_1",
      "type": "start",
      "position": { "x": 100, "y": 100 },
      "data": { "label": "开始" }
    },
    {
      "id": "chat_1",
      "type": "chat",
      "position": { "x": 300, "y": 100 },
      "data": { 
        "label": "AI 问答", 
        "config": { "model": "gpt-4", "prompt": "请总结以下内容：" } 
      }
    },
    {
      "id": "trans_1",
      "type": "translate",
      "position": { "x": 500, "y": 100 },
      "data": { 
        "label": "翻译成中文", 
        "config": { "targetLang": "zh" } 
      }
    }
  ],
  "edges": [
    {
      "id": "e_1",
      "source": "start_1",
      "target": "chat_1",
      "type": "default"
    },
    {
      "id": "e_2",
      "source": "chat_1",
      "target": "trans_1",
      "type": "default"
    }
  ],
  "config": {
    "background": {
      "color": "#f0f0f0",
      "pattern": "checkerboard"
    }
  }};