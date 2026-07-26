import { useState, useEffect, useRef } from 'react';
import { isElectron } from '../lib/env';

function fmtTime(ts) {
  const d = new Date(ts || Date.now());
  const p = (n) => String(n).padStart(2, '0');
  return `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}

export default function TranslateModule() {
  const [url, setUrl] = useState('');
  const [loading, setLoading] = useState(false);
  const [logs, setLogs] = useState([]);
  const [progress, setProgress] = useState(null); // { index, total }
  const [error, setError] = useState('');
  const [result, setResult] = useState(null);
  const [usage, setUsage] = useState(null); // 实时累计 token（来自进度推送）
  const logBoxRef = useRef(null);

  useEffect(() => {
    if (!isElectron) return;
    const off = window.electronAPI.onTranslateProgress?.((p) => {
      setLogs((prev) => [...prev, p]);
      if (typeof p.index === 'number' && typeof p.total === 'number') {
        setProgress({ index: p.index, total: p.total });
      }
      if (p.usage) setUsage(p.usage);
    });
    // 返回清理函数：StrictMode 下组件卸载时移除监听器，避免重复订阅导致日志翻倍
    return off;
  }, []);

  useEffect(() => {
    if (logBoxRef.current) {
      logBoxRef.current.scrollTop = logBoxRef.current.scrollHeight;
    }
  }, [logs]);

  const onTranslate = async () => {
    setError('');
    setResult(null);
    setLogs([]);
    setProgress(null);
    setUsage(null);
    if (!url.trim()) {
      setError('请输入要翻译的页面 URL');
      return;
    }
    setLoading(true);
    try {
      const res = await window.electronAPI.translateUrl(url.trim());
      setResult(res);
    } catch (e) {
      setError(e.message || '翻译失败');
    } finally {
      setLoading(false);
    }
  };

  const onCopy = () => {
    if (result?.translated) navigator.clipboard?.writeText(result.translated);
  };

  const langLabel = result
    ? result.lang === 'zh'
      ? '中文 → 英文'
      : '英文 → 中文'
    : '';
  const pct = progress && progress.total ? Math.round((progress.index / progress.total) * 100) : 0;

  return (
    <div className="module">
      <header className="module-header">
        <h1>页面翻译</h1>
        <p>输入网页 URL，调用外部大模型自动识别中/英文并互译。</p>
      </header>
      <section className="card">
        <div className="field">
          <label>页面 URL</label>
          <input
            value={url}
            onChange={(e) => setUrl(e.target.value)}
            onKeyDown={(e) => e.key === 'Enter' && onTranslate()}
            placeholder="https://example.com/some-article"
          />
        </div>
        <div className="actions">
          <button className="btn primary" onClick={onTranslate} disabled={loading}>
            {loading ? '翻译中…' : '开始翻译'}
          </button>
          {progress && (
            <span className="muted">
              翻译中 {progress.index}/{progress.total}
              {usage && usage.totalTokens > 0 ? ` · 已用 ${usage.totalTokens} tokens` : ''}
            </span>
          )}
        </div>
        {loading && progress && (
          <div className="progress">
            <div className="progress-bar" style={{ width: `${pct}%` }} />
          </div>
        )}
        {error && <div className="alert">{error}</div>}
      </section>

      {logs.length > 0 && (
        <section className="card">
          <div className="log-head">
            <span>运行日志</span>
            <span className="muted">{logs.length} 条</span>
          </div>
          <div className="log-box" ref={logBoxRef}>
            {logs.map((l, i) => (
              <div key={i} className={`log-line lv-${l.level || 'info'}`}>
                <span className="log-time">{fmtTime(l.ts)}</span>
                <span className="log-msg">{l.msg}</span>
              </div>
            ))}
          </div>
        </section>
      )}

      {result && (
        <section className="card">
          <div className="result-head">
            <span className="badge">{langLabel}</span>
            {result?.usage && result.usage.totalTokens > 0 && (
              <span className="badge token">
                token 输入 {result.usage.promptTokens} / 输出 {result.usage.completionTokens} / 合计 {result.usage.totalTokens}
              </span>
            )}
            <span className="muted">
              原文 {result.chars} 字 ·{' '}
              <a href={result.url} target="_blank" rel="noopener noreferrer" style={{ color: '#9ecbff' }}>
                源页面
              </a>
            </span>
            <button className="btn ghost" style={{ marginLeft: 'auto' }} onClick={onCopy}>
              复制译文
            </button>
          </div>
          <pre className="result-text">{result.translated}</pre>
        </section>
      )}
    </div>
  );
}

