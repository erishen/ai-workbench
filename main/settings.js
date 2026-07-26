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
  model: process.env.MODEL || 'gpt-3.5-turbo',
  apiKey: process.env.API_KEY || '',
};

function settingsPath() {
  const dir = app.getPath('userData');
  return path.join(dir, 'settings.json');
}

function loadSettings() {
  try {
    const p = settingsPath();
    let data = {};
    if (fs.existsSync(p)) {
      data = JSON.parse(fs.readFileSync(p, 'utf-8'));
      // 迁移：旧版曾把 apiKey 明文存入 settings.json，这里迁移到 Keychain 后删除明文。
      if (typeof data.apiKey === 'string' && data.apiKey) {
        keychain.set(data.apiKey);
        delete data.apiKey;
        fs.writeFileSync(p, JSON.stringify(data, null, 2), 'utf-8');
      }
    }
    const merged = { ...DEFAULTS, ...data };
    // Keychain 中的密钥优先于 .env / 占位值
    const kc = keychain.get();
    if (kc) merged.apiKey = kc;
    return merged;
  } catch (e) {
    return { ...DEFAULTS };
  }
}

function saveSettings(partial) {
  const current = loadSettings();
  const next = { ...current, ...(partial || {}) };
  // 仅在调用方显式传入 apiKey 时才更新钥匙串（清空也走这里）。
  if (partial && 'apiKey' in partial) {
    keychain.set(partial.apiKey || '');
  }
  const p = settingsPath();
  // 解构剔除 apiKey，确保它绝不写进 settings.json（明文文件）。
  const { apiKey, ...rest } = next;
  fs.writeFileSync(p, JSON.stringify(rest, null, 2), 'utf-8');
  // 返回完整体（含 apiKey）供渲染进程回填显示；内存中传给本地 UI 是安全的。
  return next;
}

module.exports = { loadSettings, saveSettings, DEFAULTS };
