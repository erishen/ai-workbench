import { useState, useEffect } from 'react';
import { isElectron } from '../lib/env';
import { PROVIDERS, ALL_MODELS } from '../config/providers';

// 生成前端临时 id（用于 React key 与钥匙串账户映射；保存时若仍为空由主进程分配）
function newConfigId() {
  return 'cfg_' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
}

// 新建一条空白模型配置
function blankConfig() {
  return { id: newConfigId(), provider: '', label: '', baseURL: '', model: '', models: [], keyRef: '', apiKey: '' };
}

export default function SettingsView() {
  // 模型配置列表：每条 = 一个服务商的凭证（可跨服务商），首个为「主配置」
  const [configs, setConfigs] = useState([]);
  const [savedTip, setSavedTip] = useState('');
  const [error, setError] = useState('');
  const [proxy, setProxy] = useState('');

  useEffect(() => {
    if (!isElectron) return;
    window.electronAPI.getSettings?.().then((s) => {
      if (s && Array.isArray(s.modelConfigs)) {
        setConfigs(s.modelConfigs);
      }
      if (s && typeof s.proxy === 'string') {
        setProxy(s.proxy);
      }
    }).catch(() => {});
  }, []);

  // 切换某条配置的服务商 → 自动填充 baseURL / 默认 model / 该商模型列表
  const onProviderChangeFor = (idx, pid) => {
    setConfigs((prev) => prev.map((c, i) => {
      if (i !== idx) return c;
      const p = PROVIDERS.find((x) => x.id === pid);
      if (p) {
        return { ...c, provider: p.id, baseURL: p.baseURL, model: p.defaultModel, models: p.models };
      }
      return { ...c, provider: '' };
    }));
  };

  // 更新某条配置的任意字段
  const onField = (idx, patch) => {
    setConfigs((prev) => prev.map((c, i) => (i === idx ? { ...c, ...patch } : c)));
  };

  const onAddConfig = () => setConfigs((prev) => [...prev, blankConfig()]);

  const onRemoveConfig = (idx) => setConfigs((prev) => prev.filter((_, i) => i !== idx));

  const onSave = async () => {
    setError('');
    try {
      if (configs.length === 0) {
        setError('请至少配置一个模型');
        return;
      }
      // 校验每条都有 baseURL + model
      const bad = configs.find((c) => !c.baseURL || !c.model);
      if (bad) {
        setError('每条模型配置都需要填写 Base URL 与 Model');
        return;
      }
      const payload = { modelConfigs: configs, proxy };
      const saved = await window.electronAPI.saveSettings(payload);
      setConfigs(saved.modelConfigs && saved.modelConfigs.length ? saved.modelConfigs : []);
      setSavedTip('已保存');
      setTimeout(() => setSavedTip(''), 1500);
    } catch (e) {
      setError(e.message || '保存失败');
    }
  };

  return (
    <div className="module">
      <header className="module-header">
        <h1>设置</h1>
        <p>配置外部大模型（OpenAI 兼容接口）。可添加多个不同服务商的模型配置；聊天、翻译、PSE 工作流均可选用 —— 聊天/翻译默认用主配置，也可在各自模块里手动切换。</p>
      </header>
      <section className="card">
        <div className="hint" style={{ marginBottom: 10 }}>
          每条「模型配置」对应一个服务商的凭证（Base URL + API Key + 模型）。首个为「主配置」，聊天、翻译及未指定角色时默认使用。
        </div>

        <div className="field" style={{ marginBottom: 14 }}>
          <label>代理地址（可选）</label>
          <input
            value={proxy || ''}
            onChange={(e) => setProxy(e.target.value)}
            placeholder="http://127.0.0.1:55306"
          />
          <div className="hint">当模型接口需走代理才能访问时填写（如公司内网 / 需代理的网关）。留空则尝试读取系统 HTTPS_PROXY 环境变量。</div>
        </div>

        {configs.map((c, i) => {
          const pm = PROVIDERS.find((p) => p.id === c.provider)?.models || ALL_MODELS;
          const provLabel = PROVIDERS.find((p) => p.id === c.provider)?.label || '自定义 / 其他';
          return (
            <div className="model-config" key={c.id}>
              <div className="model-config-head">
                <span className="model-config-title">
                  配置 {i + 1}
                  {i === 0 && <span className="model-tag primary" title="主配置：聊天/翻译/PSE 默认使用">主</span>}
                </span>
                {i !== 0 && (
                  <button type="button" className="model-remove" onClick={() => onRemoveConfig(i)} title="移除该配置">✕</button>
                )}
              </div>
              <div className="field">
                <label>服务商</label>
                <select value={c.provider || ''} onChange={(e) => onProviderChangeFor(i, e.target.value)}>
                  <option value="">自定义 / 其他</option>
                  {PROVIDERS.map((p) => (
                    <option key={p.id} value={p.id}>{p.label}</option>
                  ))}
                </select>
                <div className="hint">选择后自动填充 Base URL 与默认 Model（{provLabel}）</div>
              </div>
              <div className="field">
                <label>Base URL</label>
                <input
                  list="provider-baseurls"
                  value={c.baseURL || ''}
                  onChange={(e) => onField(i, { baseURL: e.target.value })}
                  placeholder="https://api.openai.com/v1"
                />
                <div className="hint">兼容 OpenAI 的 /chat/completions 接口地址</div>
              </div>
              <div className="field">
                <label>Model</label>
                <input
                  list={`model-suggestions-${i}`}
                  value={c.model || ''}
                  onChange={(e) => onField(i, { model: e.target.value, label: e.target.value })}
                  placeholder="如 gpt-4o-mini"
                />
                <datalist id={`model-suggestions-${i}`}>
                  {pm.map((m) => (<option key={m} value={m} />))}
                </datalist>
              </div>
              <div className="field">
                <label>API Key（{provLabel}）</label>
                <input
                  type="password"
                  value={c.apiKey || ''}
                  onChange={(e) => onField(i, { apiKey: e.target.value })}
                  placeholder="sk-...（留空则沿用已存钥匙串中的该配置 Key）"
                />
              </div>
            </div>
          );
        })}

        <datalist id="provider-baseurls">
          {PROVIDERS.map((p) => (<option key={p.id} value={p.baseURL} />))}
        </datalist>

        <button type="button" className="btn ghost model-add" onClick={onAddConfig}>
          + 添加模型配置
        </button>

        <div className="actions">
          <button className="btn primary" onClick={onSave}>保存设置</button>
          {savedTip && <span className="ok">{savedTip}</span>}
        </div>
        {error && <div className="alert">{error}</div>}
      </section>
    </div>
  );
}
