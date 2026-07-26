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

module.exports = { chatCompletion };
