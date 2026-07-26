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
      const res = await window.electronAPI.chatMessage(history);
      const final = streamRef.current || res.content || '';
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

  return (
    <div className="module">
      <header className="module-header">
        <h1>大模型对话</h1>
        <p>与任意 OpenAI 兼容大模型多轮对话（流式输出）。使用「设置」中配置的服务商与模型。</p>
      </header>

      <section className="card">
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
        </div>

        {error && <div className="alert">{error}</div>}
      </section>
    </div>
  );
}
