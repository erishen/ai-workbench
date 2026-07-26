const fs = require('fs');
const path = require('path');
const { app } = require('electron');

// 开发者本地私密配置：在项目根目录放 .env（已被 .gitignore 忽略，不会提交/打包）。
// 打包后的安装包不含 .env，此处静默失败并退回内置默认值，因此分发给他人时不会泄露开发者信息。
try {
  require('dotenv').config();
} catch (e) {
  // dotenv 未安装时忽略
}

// 内置默认值（安全占位，无任何开发者私密信息）。
// 若本地存在 .env，则 BASE_URL/MODEL/API_KEY 来自 .env；否则取占位值。
// 注意：这里只是“默认值”。用户运行后在设置面板保存的值会写入 settings.json（userData），
// 优先级高于 .env 与内置默认值，且 settings.json 不在项目内、不会被提交或打进安装包。
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
    if (!fs.existsSync(p)) return { ...DEFAULTS };
    const data = JSON.parse(fs.readFileSync(p, 'utf-8'));
    return { ...DEFAULTS, ...data };
  } catch (e) {
    return { ...DEFAULTS };
  }
}

function saveSettings(partial) {
  const current = loadSettings();
  const next = { ...current, ...(partial || {}) };
  const p = settingsPath();
  fs.writeFileSync(p, JSON.stringify(next, null, 2), 'utf-8');
  return next;
}

module.exports = { loadSettings, saveSettings, DEFAULTS };
