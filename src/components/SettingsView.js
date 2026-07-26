import { useState, useEffect } from 'react';
import { isElectron } from '../lib/env';
import { PROVIDERS, ALL_MODELS } from '../config/providers';

export default function SettingsView() {
  const [settings, setSettings] = useState({
    baseURL: 'https://api.openai.com/v1',
    model: 'gpt-4o-mini',
    apiKey: '',
  });
  const [providerId, setProviderId] = useState('');
  const [modelSuggestions, setModelSuggestions] = useState([]);
  const [modelCustom, setModelCustom] = useState(false);
  const [savedTip, setSavedTip] = useState('');
  const [error, setError] = useState('');

  // 当前预设服务商旗下的模型列表（用于 Model 下拉框）
  const providerModels = PROVIDERS.find((p) => p.id === providerId)?.models || [];

  useEffect(() => {
    if (!isElectron) return;
    window.electronAPI.getSettings?.().then((s) => {
      if (s) {
        setSettings({ baseURL: s.baseURL || '', model: s.model || '', apiKey: s.apiKey || '' });
        const match = PROVIDERS.find((p) => p.baseURL === (s.baseURL || ''));
        setProviderId(match ? match.id : '');
        setModelSuggestions(match ? match.models : ALL_MODELS);
        setModelCustom(match ? !match.models.includes(s.model || '') : true);
      }
    }).catch(() => {});
  }, []);

  const onProviderChange = (e) => {
    const id = e.target.value;
    setProviderId(id);
    if (!id) {
      setModelSuggestions(ALL_MODELS);
      setModelCustom(true);
      return;
    }
    const p = PROVIDERS.find((x) => x.id === id);
    if (p) {
      setSettings({ ...settings, baseURL: p.baseURL, model: p.defaultModel });
      setModelSuggestions(p.models);
      setModelCustom(false);
    }
  };

  const onModelSelect = (e) => {
    const v = e.target.value;
    if (v === '__custom__') {
      setModelCustom(true);
      return;
    }
    setSettings({ ...settings, model: v });
  };

  const onBaseUrlChange = (e) => {
    const v = e.target.value;
    const sel = PROVIDERS.find((p) => p.id === providerId);
    // 手动改了 Base URL 且和当前预设不一致 → 自动切到“自定义”
    if (sel && sel.baseURL !== v) setProviderId('');
    setSettings({ ...settings, baseURL: v });
  };

  const onSave = async () => {
    setError('');
    try {
      const saved = await window.electronAPI.saveSettings(settings);
      setSettings(saved);
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
        <p>配置外部大模型（OpenAI 兼容接口）。所有功能模块共用此凭证。</p>
      </header>
      <section className="card">
        <div className="field">
          <label>预设服务商</label>
          <select value={providerId} onChange={onProviderChange}>
            <option value="">自定义 / 其他</option>
            {PROVIDERS.map((p) => (
              <option key={p.id} value={p.id}>{p.label}</option>
            ))}
          </select>
          <div className="hint">选择后自动填充 Base URL 与默认 Model（映射参考 litellm 的 provider 表）</div>
        </div>
        <div className="field">
          <label>Base URL</label>
          <input
            value={settings.baseURL}
            onChange={onBaseUrlChange}
            placeholder="https://api.openai.com/v1"
          />
          <div className="hint">兼容 OpenAI 的 /chat/completions 接口地址，如 DeepSeek / 通义 / 自建网关</div>
        </div>
        <div className="field">
          <label>Model</label>
          {!modelCustom && providerModels.length > 0 ? (
            <select value={providerModels.includes(settings.model) ? settings.model : ''} onChange={onModelSelect}>
              {providerModels.map((m) => (
                <option key={m} value={m}>{m}</option>
              ))}
              <option value="__custom__">自定义…</option>
            </select>
          ) : (
            <input
              list="model-suggestions"
              value={settings.model}
              onChange={(e) => setSettings({ ...settings, model: e.target.value })}
              placeholder="输入模型名，如 gpt-4o-mini"
            />
          )}
          <datalist id="model-suggestions">
            {modelSuggestions.map((m) => (<option key={m} value={m} />))}
          </datalist>
          <div className="hint">
            {!modelCustom && providerModels.length > 0
              ? '下拉选择该服务商的模型；需要其他模型请选「自定义…」'
              : '自由输入模型名（该服务商预设列表里没有你要的模型时）'}
          </div>
        </div>
        <div className="field">
          <label>API Key</label>
          <input
            type="password"
            value={settings.apiKey}
            onChange={(e) => setSettings({ ...settings, apiKey: e.target.value })}
            placeholder="sk-..."
          />
        </div>
        <div className="actions">
          <button className="btn primary" onClick={onSave}>保存设置</button>
          {savedTip && <span className="ok">{savedTip}</span>}
        </div>
        {error && <div className="alert">{error}</div>}
      </section>
    </div>
  );
}
