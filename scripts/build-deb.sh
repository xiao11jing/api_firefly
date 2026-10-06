#!/usr/bin/env bash
# build-deb.sh —— 在 Ubuntu ARM64 目标机上一键产出并校验 .deb
#
# 用法（项目根目录）：
#   bash scripts/build-deb.sh                # 环境自检 → 依赖 → 测试 → 打包 → 产物结构校验
#   bash scripts/build-deb.sh --install      # 额外安装本机构建出的 .deb（需 sudo，会拉取运行依赖）
#
# 前置：bash scripts/check-env.sh 全绿（Rust ≥ 1.90、Node ≥ 18、webkit2gtk-4.1 等）。
# 产物：src-tauri/target/**/release/bundle/deb/*.deb
set -euo pipefail
cd "$(dirname "$0")/.."

WITH_INSTALL=0
if [ "${1:-}" = "--install" ]; then WITH_INSTALL=1; fi

echo "== 1/6 环境自检 =="
bash scripts/check-env.sh

echo "== 2/6 安装前端依赖 =="
npm install --no-audit --no-fund

echo "== 3/6 刷新 vendor（@tauri-apps 官方 ESM） =="
node scripts/vendor-tauri.mjs

echo "== 4/6 全量测试（单测 + E2E） =="
npm test

# E2E 需要静态服务与 mock 服务；端口已被当前项目的正确服务占用时直接复用
STATIC_PID=""
MOCK_PID=""
cleanup() {
  [ -n "$STATIC_PID" ] && kill "$STATIC_PID" 2>/dev/null || true
  [ -n "$MOCK_PID" ] && kill "$MOCK_PID" 2>/dev/null || true
}
trap cleanup EXIT

if curl -sf http://127.0.0.1:8800/js/defaults.js >/dev/null 2>&1; then
  echo "复用已运行的静态服务（8800）"
elif curl -sf -o /dev/null http://127.0.0.1:8800/ 2>/dev/null; then
  echo "错误：8800 端口被占用，但不是当前项目的静态服务（缺 js/defaults.js）。" >&2
  echo "请先停掉旧服务（例如 E:\\api 或其它目录启动的 static-server）后重跑。" >&2
  exit 1
else
  node tests/static-server.mjs >/dev/null 2>&1 &
  STATIC_PID=$!
  sleep 1
fi

if curl -sf http://127.0.0.1:8717/health >/dev/null 2>&1; then
  echo "复用已运行的 mock 服务（8717）"
else
  node tests/mock-server.mjs >/dev/null 2>&1 &
  MOCK_PID=$!
  sleep 1
fi

node tests/e2e.mjs

echo "== 5/6 Tauri 构建 .deb（首次编译依赖树较慢，属正常） =="
npm run tauri:build

echo "== 6/6 产物结构校验 =="
DEB="$(find src-tauri/target -path '*/bundle/deb/*.deb' -printf '%T@ %p\n' 2>/dev/null | sort -rn | head -n 1 | cut -d' ' -f2-)"
if [ -z "$DEB" ] || [ ! -f "$DEB" ]; then
  echo "错误：未找到 .deb 产物（src-tauri/target/**/bundle/deb/*.deb）" >&2
  exit 1
fi

echo "-- dpkg-deb -I（控制信息） --"
dpkg-deb -I "$DEB"

echo "-- 关键内容抽查（可执行文件 / 桌面项 / 图标 / 前端资源） --"
CONTENTS="$(dpkg-deb -c "$DEB")"
echo "$CONTENTS" | grep -E '/usr/bin/ai-multi-chat' >/dev/null \
  || { echo "错误：缺少 /usr/bin/ai-multi-chat 可执行文件" >&2; exit 1; }
echo "$CONTENTS" | grep -E '\.desktop' >/dev/null \
  || { echo "错误：缺少 .desktop 桌面项" >&2; exit 1; }
echo "$CONTENTS" | grep -E 'index\.html' >/dev/null \
  || { echo "错误：缺少前端 index.html" >&2; exit 1; }
echo "$CONTENTS" | grep -E 'assets/defaults/(avatar\.png|background\.png|splash\.mp4)' >/dev/null \
  || { echo "错误：缺少出厂默认资源" >&2; exit 1; }

if [ "$WITH_INSTALL" = "1" ]; then
  echo "== 附加：安装 .deb（sudo apt-get install，可解析运行依赖） =="
  sudo apt-get install -y "$DEB"
  echo "安装完成：应用菜单或命令行 ai-multi-chat 启动。"
fi

echo ""
echo "OK：$DEB"
