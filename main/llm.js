// OpenAI 兼容的 chat completions 调用（适配任意外部大模型）
// onLog(entry) 用于把调用细节回传给上层做日志展示（绝不包含 apiKey）
async function chatCompletion({ baseURL, apiKey, model, messages, temperature = 0.3, onLog } = {}) {
  const cleanBase = String(baseURL || '').replace(/\/+$/, '');
  const url = cleanBase + '/chat/completions';
  let host = cleanBase;
  try {
    host = new URL(cleanBase).host;
  } catch (_) {
    /* 保留原始字符串 */
  }
  if (onLog) {
    onLog({ level: 'model', msg: `→ 调用大模型  host=${host}  model=${model}  messages=${messages.length}` });
  }
  const t0 = Date.now();
  const resp = await fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify({ model, messages, temperature }),
  });
  const elapsed = Date.now() - t0;
  if (!resp.ok) {
    const text = await resp.text().catch(() => '');
    if (onLog) onLog({ level: 'error', msg: `✗ 模型接口返回 HTTP ${resp.status}（耗时 ${elapsed}ms）` });
    throw new Error(`LLM API ${resp.status}: ${text.slice(0, 500)}`);
  }
  const data = await resp.json();
  const content = data?.choices?.[0]?.message?.content ?? '';
  // token 用量（部分非标准端点可能不返回 usage，此时各项为 0）
  const u = data?.usage || {};
  const usage = {
    promptTokens: Number(u.prompt_tokens) || 0,
    completionTokens: Number(u.completion_tokens) || 0,
    totalTokens: Number(u.total_tokens) || 0,
  };
  if (onLog) {
    const tok = usage.totalTokens > 0 ? `，token 输入 ${usage.promptTokens} / 输出 ${usage.completionTokens}` : '';
    onLog({ level: 'model', msg: `← 模型返回 ${content.length} 字符（耗时 ${elapsed}ms${tok}）` });
  }
  // 返回译文内容 + token 用量，供上层统计
  return { content, usage };
}

// 流式对话：与 chatCompletion 协议一致，但逐 token 通过 onToken(delta) 回调吐出，
// 适配聊天界面的实时打字效果。返回 { content, usage }。usage 取决于端点是否回传（可能全 0）。
async function chatStream({ baseURL, apiKey, model, messages, temperature = 0.7, onToken, onLog } = {}) {
  const cleanBase = String(baseURL || '').replace(/\/+$/, '');
  const url = cleanBase + '/chat/completions';
  let host = cleanBase;
  try {
    host = new URL(cleanBase).host;
  } catch (_) {
    /* 保留原始字符串 */
  }
  if (onLog) {
    onLog({ level: 'model', msg: `→ 对话调用 host=${host} model=${model} messages=${messages.length}` });
  }
  const t0 = Date.now();
  const resp = await fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify({ model, messages, temperature, stream: true }),
  });
  const elapsed = Date.now() - t0;
  if (!resp.ok) {
    const text = await resp.text().catch(() => '');
    if (onLog) onLog({ level: 'error', msg: `✗ 对话接口返回 HTTP ${resp.status}` });
    throw new Error(`LLM API ${resp.status}: ${text.slice(0, 500)}`);
  }
  const reader = resp.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  let full = '';
  let usage = { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 };
  // 解析 SSE：每行 "data: {...}"，以 [DONE] 结束
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    const lines = buffer.split('\n');
    buffer = lines.pop() || '';
    for (const line of lines) {
      const t = line.trim();
      if (!t.startsWith('data:')) continue;
      const data = t.slice(5).trim();
      if (data === '[DONE]') continue;
      try {
        const j = JSON.parse(data);
        const delta = j.choices?.[0]?.delta?.content || '';
        if (delta) {
          full += delta;
          if (onToken) onToken(delta);
        }
        if (j.usage) usage = j.usage;
      } catch (_) {
        /* 跳过非 JSON 行（如注释、心跳） */
      }
    }
  }
  const u = {
    promptTokens: Number(usage.prompt_tokens) || 0,
    completionTokens: Number(usage.completion_tokens) || 0,
    totalTokens: Number(usage.total_tokens) || 0,
  };
  if (onLog) {
    const tok = u.totalTokens > 0 ? `，token 输入 ${u.promptTokens} / 输出 ${u.completionTokens}` : '';
    onLog({ level: 'model', msg: `← 对话返回 ${full.length} 字符（耗时 ${elapsed}ms${tok}）` });
  }
  return { content: full, usage: u };
}

module.exports = { chatCompletion, chatStream };
