// 预设服务商：参考 litellm 的 provider → base_url 映射，均为暴露 OpenAI 兼容
// /chat/completions 的接口。新增内部模型只需在对应 provider 的 models 里补一项；
// 新增服务商在此数组加一项即可。UI 端（设置面板）会据此自动填充 Base URL / Model。
//
// 注意：models 为「官方在售型号快照（2026-07 核查）」，厂商迭代很快；
// 设置面板始终保留「自定义 Model」输入框，可填任意当前有效 ID。
export const PROVIDERS = [
  {
    id: 'openai',
    label: 'OpenAI',
    baseURL: 'https://api.openai.com/v1',
    defaultModel: 'gpt-5.5',
    models: [
      'gpt-5.5',
      'gpt-5.4',
      'gpt-5.4-mini',
      'gpt-5.4-nano',
      'gpt-5-mini',
      'gpt-5-nano',
      'gpt-5-pro',
      'o3',
      'gpt-4.1',
      'gpt-4.1-mini',
    ],
  },
  {
    id: 'deepseek',
    label: 'DeepSeek',
    baseURL: 'https://api.deepseek.com',
    defaultModel: 'deepseek-v4-flash',
    // deepseek-chat / deepseek-reasoner 已于 2026/07/24 废弃，对应 v4 的非思考/思考模式
    models: ['deepseek-v4-flash', 'deepseek-v4-pro'],
  },
  {
    id: 'qwen',
    label: '通义千问 (阿里 DashScope)',
    baseURL: 'https://dashscope.aliyuncs.com/compatible-mode/v1',
    defaultModel: 'qwen-max',
    models: [
      'qwen-max', // 已升级至 Qwen3-Max
      'qwen-plus', // 已升级至 Qwen3.5-Plus
      'qwen-turbo', // 已升级至 Qwen3.5-Flash
      'qwen-long',
      'qwen3-235b-a22b',
      'qwen3-32b',
      'qwen3-coder-plus',
    ],
  },
  {
    id: 'zhipu',
    label: '智谱 GLM',
    baseURL: 'https://open.bigmodel.cn/api/paas/v4',
    defaultModel: 'glm-5.2',
    models: [
      'glm-5.2', // 2026-06 旗舰，1M 上下文
      'glm-5.1',
      'glm-5',
      'glm-4.7',
      'glm-4.7-flash',
      'glm-4.6',
      'glm-4.5-air',
    ],
  },
  {
    id: 'moonshot',
    label: '月之暗面 Kimi',
    baseURL: 'https://api.moonshot.cn/v1',
    defaultModel: 'kimi-k3',
    models: [
      'kimi-k3', // 2026 旗舰，2.8T 参数，1M 上下文
      'kimi-k2.7-code',
      'kimi-k2.7-code-highspeed',
      'kimi-k2.6',
      'kimi-k2.5',
      'moonshot-v1-8k',
      'moonshot-v1-32k',
      'moonshot-v1-128k',
    ],
  },
  {
    id: 'baichuan',
    label: '百川智能',
    baseURL: 'https://api.baichuan-ai.com/v1',
    defaultModel: 'baichuan4', // 2026-03 发布的新一代旗舰基座
    models: ['baichuan4', 'baichuan3-turbo', 'baichuan3-turbo-128k'],
  },
  {
    id: 'yi',
    label: '零一万物 Yi',
    baseURL: 'https://api.lingyiwanwu.com/v1',
    defaultModel: 'yi-lightning', // 2026-04 更新的旗舰，性价比极高
    models: ['yi-lightning', 'yi-large', 'yi-large-turbo', 'yi-vision'],
  },
  {
    id: 'siliconflow',
    label: '硅基流动 SiliconFlow',
    baseURL: 'https://api.siliconflow.cn/v1',
    defaultModel: 'deepseek-ai/DeepSeek-V3',
    models: [
      'deepseek-ai/DeepSeek-V3',
      'deepseek-ai/DeepSeek-R1',
      'Qwen/Qwen3-235B-A22B',
      'Qwen/Qwen3-Coder-Plus',
      'meta-llama/Llama-4-Scout-17B-16E-Instruct',
    ],
  },
  {
    id: 'groq',
    label: 'Groq',
    baseURL: 'https://api.groq.com/openai/v1',
    defaultModel: 'llama-4-scout-17b-16e-instruct',
    models: [
      'llama-4-scout-17b-16e-instruct',
      'llama-4-maverick-17b-128e-instruct',
      'deepseek-r1-distill-llama-70b',
      'qwen3-32b',
      'gemma-2-9b-it',
    ],
  },
  {
    id: 'together',
    label: 'Together AI',
    baseURL: 'https://api.together.xyz/v1',
    defaultModel: 'meta-llama/Llama-4-Maverick-17B-128E-Instruct',
    models: [
      'meta-llama/Llama-4-Maverick-17B-128E-Instruct',
      'meta-llama/Llama-4-Scout-17B-16E-Instruct',
      'deepseek-ai/DeepSeek-V3',
      'Qwen/Qwen3-235B-A22B',
    ],
  },
  {
    id: 'openrouter',
    label: 'OpenRouter',
    baseURL: 'https://openrouter.ai/api/v1',
    defaultModel: 'openai/gpt-5.5',
    models: [
      'openai/gpt-5.5',
      'anthropic/claude-opus-4-7',
      'google/gemini-2.5-pro',
      'deepseek/deepseek-v4-pro',
      'meta-llama/llama-4-maverick',
    ],
  },
  {
    id: 'fireworks',
    label: 'Fireworks AI',
    baseURL: 'https://api.fireworks.ai/inference/v1',
    defaultModel: 'accounts/fireworks/models/llama-4-scout-17b-16e-instruct',
    models: [
      'accounts/fireworks/models/llama-4-scout-17b-16e-instruct',
      'accounts/fireworks/models/llama-4-maverick-17b-128e-instruct',
      'accounts/fireworks/models/deepseek-r1',
      'accounts/fireworks/models/qwen3-32b',
    ],
  },
  {
    id: 'mistral',
    label: 'Mistral AI',
    baseURL: 'https://api.mistral.ai/v1',
    defaultModel: 'mistral-large-latest', // Mistral Large 3
    models: [
      'mistral-large-latest', // Mistral Large 3（675B MoE，256k）
      'mistral-medium-latest', // Mistral Medium 3.5
      'mistral-small-latest', // Mistral Small 4
      'ministral-8b-latest',
      'codestral-latest',
    ],
  },
  {
    id: 'perplexity',
    label: 'Perplexity',
    baseURL: 'https://api.perplexity.ai',
    defaultModel: 'sonar-pro',
    models: ['sonar', 'sonar-pro', 'sonar-reasoning', 'sonar-reasoning-pro'],
  },
  {
    id: 'ollama',
    label: 'Ollama (本地)',
    baseURL: 'http://localhost:11434/v1',
    defaultModel: 'llama4',
    models: ['llama4', 'qwen3', 'deepseek-r1', 'gemma3', 'mistral-small'],
  },
  {
    id: 'lmstudio',
    label: 'LM Studio (本地)',
    baseURL: 'http://localhost:1234/v1',
    defaultModel: 'local-model',
    models: ['local-model', 'llama-4-instruct', 'qwen3-instruct', 'deepseek-r1'],
  },
  {
    id: 'vllm',
    label: 'vLLM (本地)',
    baseURL: 'http://localhost:8000/v1',
    defaultModel: 'default',
    models: ['default'],
  },
  {
    id: 'agnes',
    label: 'Agnes AI',
    baseURL: 'https://apihub.agnes-ai.com/v1',
    defaultModel: 'agnes-2.0-flash',
    models: ['agnes-2.0-flash'],
  },
];

// 自定义时给一个通用模型建议（去重合并所有 provider 的模型）
export const ALL_MODELS = [...new Set(PROVIDERS.flatMap((p) => p.models))];
