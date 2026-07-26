// keychain.js
// macOS 系统钥匙串（Keychain）封装，用于安全存储 API Key。
// 这样用户的密钥只存在系统钥匙串里，~/Library 下的 settings.json 不再含明文。
//
// 非 macOS 环境（如开发用 Linux）不生效，调用方回退到明文文件存储并提示。
const { execFileSync } = require('child_process');

const SERVICE = 'com.erishen.agentworkflow';
const ACCOUNT = 'apiKey';
const IS_MAC = process.platform === 'darwin';

// 读取钥匙串中的 API Key（不存在/被拒则返回 undefined）
function get() {
  if (!IS_MAC) return undefined;
  try {
    const out = execFileSync(
      'security',
      ['find-generic-password', '-s', SERVICE, '-a', ACCOUNT, '-w'],
      { encoding: 'utf8' }
    );
    return out.trim() || undefined;
  } catch (e) {
    return undefined;
  }
}

// 写入/删除钥匙串中的 API Key。
// key 为空字符串或 falsy 时仅删除，不写入。
function set(key) {
  if (!IS_MAC) return;
  try {
    // 先删后增，避免重复条目
    try {
      execFileSync('security', ['delete-generic-password', '-s', SERVICE, '-a', ACCOUNT], { stdio: 'ignore' });
    } catch (e) {
      /* 不存在时忽略 */
    }
    if (key) {
      // -T 让当前运行的应用与 security 自身都能访问，避免每次读取都弹授权框
      execFileSync(
        'security',
        ['add-generic-password', '-s', SERVICE, '-a', ACCOUNT, '-w', key, '-T', process.execPath, '-T', '/usr/bin/security'],
        { stdio: 'ignore' }
      );
    }
  } catch (e) {
    /* 写入失败静默忽略（如钥匙串锁定） */
  }
}

module.exports = { get, set, IS_MAC, SERVICE, ACCOUNT };
