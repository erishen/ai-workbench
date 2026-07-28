// OpenAI 兼容的 chat completions 调用（适配任意外部大模型）
// onLog(entry) 用于把调用细节回传给上层做日志展示（绝不包含 apiKey）

// ---- 代理 + 网络错误诊断增强 ----
// Electron 主进程的全局 fetch（undici）默认不读 HTTP(S)_PROXY 环境变量，
// 且网络层失败时只抛出笼统的 "fetch failed"，不含底层 cause（RST / DNS / 证书等）。
// 以下封装：① 用 undici.ProxyAgent 让请求走系统代理；② 失败时把底层原因拼进错误信息。
let _undici = undefined; // undefined=尚未探测, null=不可用
function getUndici() {
  if (_undici !== undefined) return _undici;
  try {
    _undici = require('undici');
  } catch (e) {
    _undici = null;
  }
  return _undici;
}

// 解析代理地址：优先调用方显式传入，其次回退系统环境变量
function resolveProxy(override) {
  if (override && String(override).trim()) return String(override).trim();
  return (
    process.env.HTTPS_PROXY ||
    process.env.https_proxy ||
    process.env.HTTP_PROXY ||
    process.env.http_proxy ||
    ''
  );
}

// 构造 undici ProxyAgent（仅在确实需要代理且 undici 可用时）
function buildDispatcher(proxyUrl) {
  if (!proxyUrl) return undefined;
  const u = getUndici();
  if (!u || !u.ProxyAgent) return undefined;
  try {
    return new u.ProxyAgent(proxyUrl);
  } catch (_) {
    return undefined;
  }
}

// 包装 fetch：支持代理 dispatcher，并在网络层失败时把底层 cause 拼进错误信息
async function proxiedFetch(url, init, proxyOverride) {
  const proxyUrl = resolveProxy(proxyOverride);
  const dispatcher = buildDispatcher(proxyUrl);
  const u = getUndici();
  // 需要代理时优先用同源 undici.fetch，确保 dispatcher 生效；否则用全局 fetch（行为不变）
  const fetchFn = dispatcher && u && u.fetch ? u.fetch : globalThis.fetch;
  const init2 = dispatcher ? { ...init, dispatcher } : init;
  try {
    return await fetchFn(url, init2);
  } catch (err) {
    const cause = err && err.cause;
    let detail = '';
    if (cause) {
      const code = cause.code || cause.errno || '';
      const msg = cause.message || '';
      detail = code ? `（底层错误: ${code}）` : msg ? `（底层错误: ${msg}）` : '';
    }
    let host = url;
    try {
      host = new URL(url).host;
    } catch (_) {
      /* 保留原串 */
    }
    throw new Error(
      `LLM 请求失败 fetch failed${detail} host=${host}: ${err && err.message ? err.message : String(err)}`
    );
  }
}

// 判断错误是否为「连接层瞬时断开」（可重试）；用户主动停止(signal.aborted)不算。
function isConnectionDrop(e, signal) {
  if (!e) return false;
  if (signal && signal.aborted) return false;
  const m = (e && e.message) || String(e);
  return /terminated|fetch failed|ECONNRESET|ECONNREFUSED|ENOTFOUND|socket hang up|UND_ERR_|the operation was aborted|aborted/i.test(m);
}

function describeDrop(e) {
  const m = (e && e.message) || String(e);
  if (/terminated/i.test(m)) return '流式连接被重置';
  const mm = m.match(/底层错误:\s*([^）]+)/);
  if (mm) return mm[1].trim();
  return m.slice(0, 60);
}

// 对模型调用做「连接断开自动重试」：遇到瞬时网络/网关断开时自愈，
// 避免长流式响应(如 Specialist 步骤)偶发断开导致整轮失败。用户主动停止不重试。
async function withRetry(fn, { signal, maxRetry = 3, onLog, label = '模型调用' } = {}) {
  let lastErr;
  for (let attempt = 1; attempt <= maxRetry; attempt++) {
    try {
      return await fn(attempt);
    } catch (e) {
      lastErr = e;
      if (isConnectionDrop(e, signal)) {
        if (onLog) onLog({ level: 'warn', msg: `⚠ ${label}连接中断（${describeDrop(e)}），第 ${attempt}/${maxRetry} 次尝试失败，正在重试…` });
        if (attempt < maxRetry) continue;
      }
      throw e;
    }
  }
  throw lastErr;
}

async function chatCompletion({ baseURL, apiKey, model, messages, temperature = 0.3, signal, onLog, proxy } = {}) {
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
  const result = await withRetry(async () => {
    const resp = await proxiedFetch(
      url,
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${apiKey}`,
        },
        body: JSON.stringify({ model, messages, temperature }),
        signal,
      },
      proxy
    );
    if (!resp.ok) {
      const text = await resp.text().catch(() => '');
      const elapsed = Date.now() - t0;
      if (onLog) onLog({ level: 'error', msg: `✗ 模型接口返回 HTTP ${resp.status}（耗时 ${elapsed}ms）` });
      throw new Error(`LLM API ${resp.status}: ${text.slice(0, 500)}`);
    }
    const data = await resp.json();
    const content = data?.choices?.[0]?.message?.content ?? '';
    const u = data?.usage || {};
    const usage = {
      promptTokens: Number(u.prompt_tokens) || 0,
      completionTokens: Number(u.completion_tokens) || 0,
      totalTokens: Number(u.total_tokens) || 0,
    };
    const elapsed = Date.now() - t0;
    if (onLog) {
      const tok = usage.totalTokens > 0 ? `，token 输入 ${usage.promptTokens} / 输出 ${usage.completionTokens}` : '';
      onLog({ level: 'model', msg: `← 模型返回 ${content.length} 字符（耗时 ${elapsed}ms${tok}）` });
    }
    return { content, usage };
  }, { signal, maxRetry: 3, onLog, label: '模型' });
  return result;
}

// 流式对话：与 chatCompletion 协议一致，但逐 token 通过 onToken(delta) 回调吐出，
// 适配聊天界面的实时打字效果。返回 { content, usage }。usage 取决于端点是否回传（可能全 0）。
async function chatStream({ baseURL, apiKey, model, messages, temperature = 0.7, signal, onToken, onLog, proxy, maxRetry = 3 } = {}) {
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

  const result = await withRetry(async (attempt) => {
    const t0 = Date.now();
    const resp = await proxiedFetch(
      url,
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${apiKey}`,
        },
        body: JSON.stringify({ model, messages, temperature, stream: true }),
        signal,
      },
      proxy
    );
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
    let reasoningFull = '';
    let fullReasoningLen = 0;
    let usage = { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 };
    const accum = []; // 本次尝试累积的 token，仅成功时回放（避免失败尝试的残缺内容造成重复）
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
          // 部分网关/推理模型会在 SSE 内返回错误对象（HTTP 200 但 body 带 error）。
          // 若不拦截，下面取 delta.content 会得到空串，导致上层静默拿到空内容、误报「无法解析 JSON」。
          if (j.error) {
            const msg = typeof j.error === 'string' ? j.error : j.error.message || JSON.stringify(j.error);
            throw new Error(`LLM 流内错误：${msg}`);
          }
          // 兼容「非增量」事件：少数端点会在末尾用 choices[0].message.content 给出完整内容
          const delta = j.choices?.[0]?.delta?.content || j.choices?.[0]?.message?.content || '';
          if (delta) {
            full += delta;
            accum.push(delta);
          }
          // 推理模型常把思考放在 reasoning_content；结构化输出（Planner/Evaluator）可能
          // 把最终答案也塞进 reasoning 而 content 为空，故完整保留，供上层按需回退解析。
          // 兼容非增量事件 choices[0].message.reasoning_content。
          const reasoning =
            j.choices?.[0]?.delta?.reasoning_content || j.choices?.[0]?.message?.reasoning_content || '';
          if (reasoning) {
            reasoningFull += reasoning;
            fullReasoningLen += reasoning.length;
          }
          if (j.usage) usage = j.usage;
        } catch (err) {
          if (err.message && err.message.startsWith('LLM 流内错误')) throw err;
          /* 跳过非 JSON 行（如注释、心跳） */
        }
      }
    }
    const u = {
      promptTokens: Number(usage.prompt_tokens) || 0,
      completionTokens: Number(usage.completion_tokens) || 0,
      totalTokens: Number(usage.total_tokens) || 0,
    };
    // 本次尝试成功：把累积的 token 回放给上层（回放而非实时，确保只展示成功尝试的完整内容）
    if (onToken) for (const d of accum) onToken(d);
    if (onLog) {
      const tok = u.totalTokens > 0 ? `，token 输入 ${u.promptTokens} / 输出 ${u.completionTokens}` : '';
      const rsn = fullReasoningLen > 0 ? `，思考 ${fullReasoningLen} 字符` : '';
      const tag = attempt > 1 ? `（第 ${attempt} 次尝试）` : '';
      onLog({ level: 'model', msg: `← 对话返回 ${full.length} 字符（耗时 ${elapsed}ms${tok}${rsn}）${tag}` });
    }
    return { content: full, usage: u, reasoningLen: fullReasoningLen, reasoning: reasoningFull };
  }, { signal, maxRetry, onLog, label: '对话' });

  return result;
}

module.exports = { chatCompletion, chatStream };
