#!/usr/bin/env bash
# Agent Workflow — macOS 安装助手
# 作用：绕过 Gatekeeper 对「未签名/未公证」App 的拦截（无需 $99 开发者账号）。
# 适用：面向技术用户分发 dmg 时，让用户双击运行本脚本即可安装并打开。
#
# 用法：
#   1) 把本脚本与 "Agent Workflow-*.dmg" 放在同一目录
#   2) chmod +x install-mac.sh
#   3) ./install-mac.sh
#
# 说明：脚本会挂载 dmg、把 .app 拷到 /Applications、移除下载隔离标记、
#       并把该 app 加入本机 Gatekeeper 白名单（sudo 需输入开机密码）。
#       白名单按 app 哈希添加，仅本机、仅此 app 生效，安全。

set -euo pipefail

APP_NAME="Agent Workflow"
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
DMG="$(ls -1 "$SCRIPT_DIR"/"${APP_NAME}"-*.dmg 2>/dev/null | head -1 || true)"

if [[ -z "$DMG" ]]; then
  echo "✗ 未找到 ${APP_NAME}-*.dmg，请把 dmg 与本脚本放同一目录。" >&2
  exit 1
fi
echo "▶ 使用安装包：$DMG"

MOUNT="$(hdiutil attach "$DMG" -nobrowse -noautoopen | awk -F'\t' '/Volumes/{print $NF}' | head -1)"
cleanup() { [[ -d "$MOUNT" ]] && hdiutil detach "$MOUNT" -quiet 2>/dev/null || true; }
trap cleanup EXIT

SRC="$MOUNT/${APP_NAME}.app"
if [[ ! -d "$SRC" ]]; then
  echo "✗ dmg 内未找到 ${APP_NAME}.app" >&2
  exit 1
fi

echo "▶ 拷贝到 /Applications ..."
rm -rf "/Applications/${APP_NAME}.app"
cp -R "$SRC" "/Applications/${APP_NAME}.app"

echo "▶ 移除下载隔离标记 ..."
xattr -dr com.apple.quarantine "/Applications/${APP_NAME}.app" 2>/dev/null || true

echo "▶ 加入本机 Gatekeeper 白名单（如提示请输入开机密码）..."
sudo spctl --add "/Applications/${APP_NAME}.app"

echo "✓ 安装完成，正在打开 ..."
open "/Applications/${APP_NAME}.app"
