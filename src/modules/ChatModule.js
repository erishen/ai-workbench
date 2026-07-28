import { useState, useEffect, useRef } from 'react';
import { isElectron } from '../lib/env';

// 大模型对话模块：多轮对话 + 流式输出。
// 渲染端维护完整 messages 历史，每次把整段历史发给主进程；主进程逐 token 推回（chat:progress），
// 渲染端增量拼接显示。使用「设置」中配置的服务商 baseURL / model / Key。
export default function ChatModule() {
  const [messages, setMessages] = useState([]); // [{ role: 'user'|'assistant', content }]
  const [input, setInput] = useState('');
  const [streaming, setStreaming] = useState(false);
  const [streamContent, setStreamContent] = useState(''); // 流式期间最后一条 assistant 的实时内容
  const [error, setError] = useState('');
  const [usage, setUsage] = useState(null); // 本轮 token 用量
  const [usedModel, setUsedModel] = useState(null); // 后端本轮实际调用的模型（自证切换是否生效）
  const [configs, setConfigs] = useState([]); // 模型配置列表（来自「设置」）
  const [configId, setConfigId] = useState(''); // 当前选用的模型配置 id（默认主配置）
  const streamRef = useRef(''); // 流式累积（ref 避免闭包拿到旧值）
  const boxRef = useRef(null);

  // 注册流式推送监听：仅挂载时注册一次，返回清理函数避免 StrictMode 双订阅
  useEffect(() => {
    if (!isElectron) return;
    const off = window.electronAPI.onChatProgress?.((p) => {
      if (p && typeof p.delta === 'string') {
        streamRef.current += p.delta;
        setStreamContent(streamRef.current);
      }
    });
    return off;
  }, []);

  // 载入「设置」中的模型配置列表，默认选用主配置（列表首个）
  useEffect(() => {
    if (!isElectron) return;
    window.electronAPI.getSettings?.().then((s) => {
      if (s && Array.isArray(s.modelConfigs) && s.modelConfigs.length) {
        setConfigs(s.modelConfigs);
        setConfigId(s.modelConfigs[0].id);
      }
    }).catch(() => {});
  }, []);

  // 消息或流式内容变化时滚到底部
  useEffect(() => {
    if (boxRef.current) boxRef.current.scrollTop = boxRef.current.scrollHeight;
  }, [messages, streamContent]);

  const onSend = async () => {
    const text = input.trim();
    if (!text || streaming) return;
    setError('');
    const userMsg = { role: 'user', content: text };
    const history = [...messages, userMsg];
    // 先放一条空的 assistant 占位，流式期间由 streamContent 填充
    setMessages([...history, { role: 'assistant', content: '' }]);
    setInput('');
    streamRef.current = '';
    setStreamContent('');
    setStreaming(true);
    setUsage(null);
    try {
      const res = await window.electronAPI.chatMessage(history, configId || undefined);
      const final = streamRef.current || res.content || '';
      setUsedModel(
        res && res.model
          ? { model: res.model, label: res.label || res.provider || '', endpoint: res.endpoint || '' }
          : null
      );
      setMessages((prev) => {
        const c = [...prev];
        c[c.length - 1] = { role: 'assistant', content: final };
        return c;
      });
      if (res.usage && res.usage.totalTokens > 0) setUsage(res.usage);
    } catch (e) {
      const msg = e && e.message ? e.message : '对话失败';
      setError(msg);
      // 把空占位替换为错误提示
      setMessages((prev) => {
        const c = [...prev];
        const last = c[c.length - 1];
        if (last && last.role === 'assistant' && !last.content) {
          c[c.length - 1] = { role: 'assistant', content: '⚠️ ' + msg };
        }
        return c;
      });
    } finally {
      setStreaming(false);
    }
  };

  const onClear = () => {
    if (streaming) return;
    setMessages([]);
    setStreamContent('');
    setUsage(null);
    setError('');
  };

  const onKeyDown = (e) => {
    // Cmd/Ctrl + Enter 发送
    if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
      e.preventDefault();
      onSend();
    }
  };

  const active = configs.find((c) => c.id === configId) || configs[0] || null;

  return (
    <div className="module">
      <header className="module-header">
        <h1>大模型对话</h1>
        <p>与任意 OpenAI 兼容大模型多轮对话（流式输出）。可在下方切换「设置」中已配置的模型（支持跨服务商）；切换模型会清空当前对话历史。</p>
      </header>

      <section className="card">
        {configs.length > 0 && (
          <div className="model-pick">
            <label>使用模型配置</label>
            <select
              value={configId}
              onChange={(e) => {
                const next = e.target.value;
                if (next === configId) return; // 选了同一个配置不重置
                setConfigId(next);
                // 切换模型配置时清空历史：避免把上一模型的对话上下文（含其自称）带给新模型
                setMessages([]);
                setStreamContent('');
                setUsage(null);
                setUsedModel(null);
                setError('');
              }}
              disabled={streaming}
            >
              {configs.map((c, i) => {
                let host = '';
                try { host = new URL(c.baseURL).host; } catch (_) { /* ignore */ }
                return (
                  <option key={c.id} value={c.id}>
                    {c.label || c.provider || c.model} · {c.model}{i === 0 ? '（主）' : ''}{host ? ' @ ' + host : ''}
                  </option>
                );
              })}
            </select>
            {active && (() => {
              let host = '';
              try { host = new URL(active.baseURL).host; } catch (_) { /* ignore */ }
              return (
                <div className="model-active">
                  当前生效：{active.label || active.provider || active.model} · {active.model}{host ? ' @ ' + host : ''}
                </div>
              );
            })()}
            <div className="hint">⚠️ 切换模型配置会清空当前会话历史，开始一段新对话。</div>
          </div>
        )}
        <div className="chat-box" ref={boxRef}>
          {messages.length === 0 && !streaming && (
            <div className="muted" style={{ textAlign: 'center', padding: '34px 0' }}>
              还没有对话，在下方输入消息开始。（Cmd / Ctrl + Enter 发送）
            </div>
          )}
          {messages.map((m, i) => {
            const isLastAssistant =
              m.role === 'assistant' && i === messages.length - 1 && streaming;
            const content = isLastAssistant ? streamContent : m.content;
            return (
              <div key={i} className={`chat-msg ${m.role}`}>
                <div className="chat-avatar">{m.role === 'user' ? '🧑' : '🤖'}</div>
                <div className={`chat-bubble ${isLastAssistant ? 'chat-cursor' : ''}`}>
                  {content || (isLastAssistant ? '' : '…')}
                </div>
              </div>
            );
          })}
        </div>

        <textarea
          className="chat-input"
          value={input}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={onKeyDown}
          placeholder={streaming ? '正在生成…' : '输入消息，Cmd / Ctrl + Enter 发送'}
          disabled={streaming}
        />

        <div className="chat-tools">
          <button className="btn primary" onClick={onSend} disabled={streaming || !input.trim()}>
            {streaming ? '生成中…' : '发送'}
          </button>
          <button className="btn ghost" onClick={onClear} disabled={streaming || messages.length === 0}>
            清空对话
          </button>
          {usage && usage.totalTokens > 0 && (
            <span className="badge token">
              token 输入 {usage.promptTokens} / 输出 {usage.completionTokens} / 合计 {usage.totalTokens}
            </span>
          )}
          {usedModel && (
            <span className="badge used">
              本次后端实际调用：{usedModel.label ? usedModel.label + ' · ' : ''}{usedModel.model}
              {usedModel.endpoint ? ' @ ' + usedModel.endpoint : ''}
            </span>
          )}
          {!usedModel && messages.length > 0 && (
            <span className="badge used warn">本次未返回模型信息（可能仍是旧主进程）</span>
          )}
        </div>

        {error && <div className="alert">{error}</div>}
      </section>
    </div>
  );
}
