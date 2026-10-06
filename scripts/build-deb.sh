#!/usr/bin/env bash
# build-deb.sh —— 在 Ubuntu ARM64 目标机上一键产出并校验 .deb
#
# 用法（项目根目录）：
#   bash scripts/build-deb.sh                # 自检 → 依赖 → 测试 → 打包 → 产物结构校验
#   bash scripts/build-deb.sh --install      # 额外安装本机构建出的 .deb（sudo，会拉取运行依赖）
#
# 说明：
#   - 第 4 步 E2E 需要两个临时服务（静态页 8800 + mock AI 8717），只为测试存在，
#     脚本退出时自动清理（trap）。**最终应用不依赖任何服务，点图标即用。**
#   - 服务日志：output/build-static.log、output/build-mock.log
#   - 产物：src-tauri/target/**/release/bundle/deb/*.deb
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

echo "-- 确保 E2E 浏览器可用（一次性） --"
# 与 e2e.mjs 同一条候选链；不允许 headless-shell 兜底（导出文件名断言需要完整版引擎）
probe_browser() {
  node -e "
const { chromium } = require('playwright-core');
(async () => {
  for (const channel of ['msedge', 'chrome', 'chromium']) {
    try {
      const b = await chromium.launch({
        channel,
        headless: true,
        chromiumSandbox: false,
      });
      await b.close();
      process.exit(0);
    } catch {}
  }
  process.exit(1);
})();
" 2>/dev/null
}
if ! probe_browser; then
  echo "未检测到可用浏览器，安装 playwright 完整版 chromium（一次性，约 150MB）…"
  npx playwright-core install chromium || {
    echo "chromium 安装失败；若报共享库缺失，先执行： npx playwright-core install-deps chromium" >&2
    exit 1
  }
  if ! probe_browser; then
    echo "错误：chromium 安装后仍无法启动；尝试： npx playwright-core install-deps chromium" >&2
    exit 1
  fi
fi

mkdir -p output
STATIC_LOG="output/build-static.log"
MOCK_LOG="output/build-mock.log"
STATIC_PID=""
MOCK_PID=""
cleanup() {
  [ -n "$STATIC_PID" ] && kill "$STATIC_PID" 2>/dev/null || true
  [ -n "$MOCK_PID" ] && kill "$MOCK_PID" 2>/dev/null || true
}
trap cleanup EXIT

# HTTP 探测统一走 node（构建机不依赖 curl）
http_ok() {
  node -e "fetch(process.argv[1]).then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))" "$1" 2>/dev/null
}
# 轮询等待服务就绪（最多 30s），超时打印日志尾部便于排查
wait_http() { # $1=url $2=名称 $3=日志文件
  local i
  for i in $(seq 1 60); do
    if http_ok "$1"; then return 0; fi
    sleep 0.5
  done
  echo "错误：$2 在 30s 内未能就绪。日志 $3：" >&2
  tail -n 30 "$3" >&2 2>/dev/null || true
  exit 1
}

# 静态服务（8800）：当前项目的在跑就复用；被别的项目占用则明确报错
if http_ok "http://127.0.0.1:8800/js/defaults.js"; then
  echo "复用已运行的静态服务（8800）"
elif http_ok "http://127.0.0.1:8800/"; then
  echo "错误：8800 端口被占用，但不是当前项目（缺 js/defaults.js）。" >&2
  echo "请先停掉旧的 static-server 进程后重跑本脚本。" >&2
  exit 1
else
  : >"$STATIC_LOG"
  node tests/static-server.mjs >>"$STATIC_LOG" 2>&1 &
  STATIC_PID=$!
  wait_http "http://127.0.0.1:8800/js/defaults.js" "静态服务(8800)" "$STATIC_LOG"
  echo "静态服务已就绪（pid $STATIC_PID，日志 $STATIC_LOG）"
fi

# mock AI 服务（8717）：版本一致性由 E2E 自检兜底
if http_ok "http://127.0.0.1:8717/health"; then
  echo "复用已运行的 mock 服务（8717）"
elif http_ok "http://127.0.0.1:8717/"; then
  echo "错误：8717 端口被占用但 /health 不可用，请先停掉旧 mock 进程后重跑本脚本。" >&2
  exit 1
else
  : >"$MOCK_LOG"
  node tests/mock-server.mjs >>"$MOCK_LOG" 2>&1 &
  MOCK_PID=$!
  wait_http "http://127.0.0.1:8717/health" "mock AI 服务(8717)" "$MOCK_LOG"
  echo "mock AI 服务已就绪（pid $MOCK_PID，日志 $MOCK_LOG）"
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

echo "-- 结构与嵌入抽查 --"
# 注意：dpkg-deb -c 列出的路径没有前导斜杠（usr/bin/... 而非 /usr/bin/...）；
# 前端 index.html 与 assets/ 由 Tauri 编译进二进制，不会作为独立文件出现在清单里。
errs=""
CONTENTS="$(dpkg-deb -c "$DEB")"

if ! echo "$CONTENTS" | grep -E 'usr/bin/ai-multi-chat$' >/dev/null; then
  errs="$errs\n  - 缺少 usr/bin/ai-multi-chat 可执行文件"
fi
if ! echo "$CONTENTS" | grep -E '\.desktop$' >/dev/null; then
  errs="$errs\n  - 缺少 .desktop 桌面项"
fi
if ! echo "$CONTENTS" | grep -E 'icons/hicolor/.*/apps/ai-multi-chat\.png' >/dev/null; then
  errs="$errs\n  - 缺少应用图标"
fi

DEPS="$(dpkg-deb -f "$DEB" Depends 2>/dev/null || true)"
if ! echo "$DEPS" | grep -q 'libwebkit2gtk-4\.1'; then
  errs="$errs\n  - Depends 缺少 libwebkit2gtk-4.1（实际：$DEPS）"
fi

# 解包验证：desktop 的 Exec 与已嵌入二进制的前端出厂默认资源
tmpdir="$(mktemp -d)"
if dpkg-deb -x "$DEB" "$tmpdir"; then
  desktop_file="$(find "$tmpdir/usr/share/applications" -name '*.desktop' 2>/dev/null | head -n 1)"
  if [ -z "$desktop_file" ] || ! grep -q '^Exec=ai-multi-chat' "$desktop_file"; then
    errs="$errs\n  - .desktop 的 Exec 不是 ai-multi-chat"
  fi
  app_bin="$tmpdir/usr/bin/ai-multi-chat"
  if [ ! -f "$app_bin" ]; then
    errs="$errs\n  - 解包后找不到二进制"
  else
    for asset in 'assets/defaults/avatar.png' 'assets/defaults/background.png' 'assets/defaults/splash.mp4'; do
      if ! grep -a -q "$asset" "$app_bin"; then
        errs="$errs\n  - 二进制未嵌入前端资源：$asset"
      fi
    done
  fi
else
  errs="$errs\n  - dpkg-deb -x 解包失败"
fi
rm -rf "$tmpdir"

if [ -n "$errs" ]; then
  printf '错误：产物校验未通过：%b\n' "$errs" >&2
  exit 1
fi
echo "结构校验通过（二进制/桌面项/图标/依赖/嵌入资源）"

if [ "$WITH_INSTALL" = "1" ]; then
  echo "== 附加：安装 .deb（sudo apt-get install，可解析运行依赖） =="
  sudo apt-get install -y "$DEB"
  echo "安装完成：应用菜单或命令行 ai-multi-chat 启动，无需任何后台服务。"
fi

echo ""
echo "OK：$DEB"
