const fs = require('fs');
const path = require('path');
const { app } = require('electron');
const keychain = require('./keychain');

// 开发者本地私密配置：在项目根目录放 .env（已被 .gitignore 忽略，不会提交/打包）。
// 打包后的安装包不含 .env，此处静默失败并退回内置默认值，因此分发给他人时不会泄露开发者信息。
try {
  require('dotenv').config();
} catch (e) {
  // dotenv 未安装时忽略
}

// 内置默认值（安全占位，无任何开发者私密信息）。
// 若本地存在 .env，则 BASE_URL/MODEL/API_KEY 来自 .env；否则取占位值。
// 注意：apiKey 不写入 settings.json —— 在 macOS 上改为存系统钥匙串（Keychain），
// 其余字段（baseURL/model）为公开配置，存 settings.json（userData）。
const DEFAULTS = {
  baseURL: process.env.BASE_URL || 'https://api.openai.com/v1',
  model: process.env.MODEL || 'gpt-4o-mini',
  apiKey: process.env.API_KEY || '',
};

// 主模型配置（首个为「主模型」，供聊天/翻译及未指定角色时默认使用）。
// 每条 modelConfig = { id, provider, label, baseURL, model, models:[], keyRef }
//  - keyRef: 该配置 Key 在钥匙串中的 account（默认等于 id；legacy 迁移配置用 'apiKey'）
//  - apiKey: 仅内存返回给 UI 用，绝不写盘
function settingsPath() {
  const dir = app.getPath('userData');
  return path.join(dir, 'settings.json');
}

// 生成稳定且唯一的配置 id
function genConfigId() {
  return 'cfg_' + Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
}

function loadSettings() {
  try {
    const p = settingsPath();
    let data = {};
    if (fs.existsSync(p)) {
      data = JSON.parse(fs.readFileSync(p, 'utf-8'));
      // 迁移：旧版曾把 apiKey 明文存入 settings.json，这里迁移到 Keychain 后删除明文。
      if (typeof data.apiKey === 'string' && data.apiKey) {
        keychain.set(data.apiKey); // legacy 账户
        delete data.apiKey;
        fs.writeFileSync(p, JSON.stringify(data, null, 2), 'utf-8');
      }
    }
    const merged = { ...DEFAULTS, ...data };

    // ---- 构建 modelConfigs ----
    let configs = Array.isArray(merged.modelConfigs) ? merged.modelConfigs : [];
    if (configs.length === 0) {
      // 从旧版单服务商结构迁移：baseURL + model + legacy 钥匙串 key
      const legacyKey = keychain.get(); // legacy 账户 'apiKey'
      const legacyModels = Array.isArray(merged.models) && merged.models.length ? merged.models : [merged.model];
      if (merged.baseURL && merged.model) {
        configs = [
          {
            id: 'cfg_legacy',
            provider: '',
            label: merged.model,
            baseURL: merged.baseURL,
            model: merged.model,
            models: legacyModels,
            keyRef: keychain.LEGACY_ACCOUNT, // 复用 legacy 钥匙串账户
          },
        ];
      } else if (legacyKey) {
        // 仅有 key 没有 baseURL/model 的极旧数据：用默认值兜底
        configs = [
          {
            id: 'cfg_legacy',
            provider: '',
            label: DEFAULTS.model,
            baseURL: DEFAULTS.baseURL,
            model: DEFAULTS.model,
            models: [DEFAULTS.model],
            keyRef: keychain.LEGACY_ACCOUNT,
          },
        ];
      }
    }
    // 解析各配置 Key（仅在内存中，绝不写盘）
    // 防御：为缺失 id 的配置补一个稳定 id，避免下拉框 value 出现 undefined 导致「切换无效」
    const resolved = configs.map((c, i) => {
      const id = c.id || `cfg_gen_${i}`;
      const keyRef = c.keyRef || id;
      return { ...c, id, keyRef, apiKey: keychain.getFor(keyRef) || '' };
    });

    merged.modelConfigs = resolved;
    // 主模型 = 首个配置
    const primary = resolved[0];
    if (primary) {
      merged.baseURL = primary.baseURL;
      merged.model = primary.model;
      merged.apiKey = primary.apiKey;
    }
    return merged;
  } catch (e) {
    return { ...DEFAULTS };
  }
}

function saveSettings(partial) {
  const current = loadSettings();
  const next = { ...current, ...(partial || {}) };

  // 是否传入了 modelConfigs（模型配置列表）
  let configsToSave = current.modelConfigs;
  if (partial && Array.isArray(partial.modelConfigs)) {
    configsToSave = partial.modelConfigs.map((c) => {
      const id = c.id || genConfigId();
      const keyRef = c.keyRef || id;
      // 路由该配置的 apiKey 到钥匙串（按 keyRef 分账户）
      if ('apiKey' in c) keychain.setFor(keyRef, c.apiKey || '');
      // 磁盘只保留 keyRef，不存明文 apiKey
      const { apiKey, ...rest } = c;
      return { ...rest, id, keyRef };
    });
  }

  // 主模型 = 首个配置
  const primary = configsToSave && configsToSave[0];
  const baseURL = primary
    ? primary.baseURL
    : partial && partial.baseURL
    ? partial.baseURL
    : current.baseURL || DEFAULTS.baseURL;
  const model = primary
    ? primary.model
    : partial && partial.model
    ? partial.model
    : current.model || DEFAULTS.model;
  const models = primary
    ? (primary.models && primary.models.length ? primary.models : [primary.model])
    : (current.models && current.models.length ? current.models : [model]);

  const out = {
    baseURL,
    model,
    models,
    modelConfigs: configsToSave || [],
    // 全局代理地址（可选）：留空则运行时回退读取系统 HTTPS_PROXY 环境变量
    proxy: (partial && typeof partial.proxy === 'string') ? partial.proxy : (current.proxy || ''),
  };

  // 兼容：若显式传了顶层 apiKey 且没有任何配置，则写入 legacy 账户
  if (partial && 'apiKey' in partial && (!configsToSave || configsToSave.length === 0)) {
    keychain.set(partial.apiKey || '');
  }

  const p = settingsPath();
  fs.writeFileSync(p, JSON.stringify(out, null, 2), 'utf-8');

  // 返回完整对象（含内存态 apiKey）供渲染进程回填
  const full = { ...out };
  full.apiKey = primary ? keychain.getFor(primary.keyRef) || '' : keychain.get() || '';
  full.modelConfigs = (configsToSave || []).map((c) => ({
    ...c,
    apiKey: keychain.getFor(c.keyRef || c.id) || '',
  }));
  return full;
}

// 按配置 id 解析凭证：优先用指定的 modelConfig id，找不到或为空则回退主配置
// （settings 顶层 baseURL/apiKey/model 已是首个配置解析值）。供聊天/翻译按所选配置
// 取用不同服务商的 baseURL / Key / model，与 PSE 的 roleCreds 语义一致。
function resolveModelConfig(settings, id) {
  const configs = (settings && Array.isArray(settings.modelConfigs) && settings.modelConfigs) || [];
  if (id) {
    const cfg = configs.find((c) => c.id === id);
    if (cfg) {
      return {
        baseURL: cfg.baseURL,
        apiKey: cfg.apiKey,
        model: cfg.model,
        provider: cfg.provider || '',
        label: cfg.label || '',
      };
    }
  }
  return {
    baseURL: (settings && settings.baseURL) || DEFAULTS.baseURL,
    apiKey: settings && settings.apiKey,
    model: (settings && settings.model) || DEFAULTS.model,
    provider: '',
    label: '',
  };
}

module.exports = { loadSettings, saveSettings, DEFAULTS, genConfigId, resolveModelConfig };
