#!/usr/bin/env bash
# check-env.sh —— Tauri 桌面版（.deb / Ubuntu ARM64）构建环境自检
# 在目标 ARM64 机器的项目根目录运行：
#   bash scripts/check-env.sh
# 全部 [FAIL] 为 0 才具备构建条件；[WARN] 项请人工评估。

set -u

pass=0
fail=0
warn=0

ok()   { printf '[OK]   %s\n' "$1"; pass=$((pass + 1)); }
bad()  { printf '[FAIL] %s\n' "$1"; fail=$((fail + 1)); }
note() { printf '[WARN] %s\n' "$1"; warn=$((warn + 1)); }

echo "== Tauri .deb 构建环境自检 =="

# 1. CPU 架构必须是 ARM64
arch="$(uname -m)"
case "$arch" in
  aarch64|arm64) ok "CPU 架构：$arch" ;;
  *) bad "CPU 架构：$arch（.deb 目标为 aarch64/arm64）" ;;
esac

# 2. 系统发行版与版本
ID=""
VERSION_ID=""
if [ -r /etc/os-release ]; then
  # shellcheck disable=SC1091
  . /etc/os-release
  ok "系统：${PRETTY_NAME:-$ID}"
else
  bad "无法读取 /etc/os-release"
fi

# 3. Tauri 2 关键依赖：libwebkit2gtk-4.1（Ubuntu 22.04+ / Debian 12+ 才有）
if command -v apt-cache >/dev/null 2>&1; then
  if command -v pkg-config >/dev/null 2>&1 && pkg-config --exists webkit2gtk-4.1; then
    ok "webkit2gtk-4.1 开发包已安装（pkg-config 可查，可用于构建）"
  elif apt-cache policy libwebkit2gtk-4.1-dev 2>/dev/null | grep -q 'Candidate: [0-9]'; then
    bad "webkit2gtk-4.1-dev 未安装但源里有（sudo apt-get install -y libwebkit2gtk-4.1-dev）"
  else
    bad "apt 源中没有 libwebkit2gtk-4.1-dev（Tauri 2 硬依赖；需 Ubuntu 22.04+ 或补源）"
  fi
  if ldconfig -p 2>/dev/null | grep -q 'libwebkit2gtk-4\.1'; then
    ok "libwebkit2gtk-4.1 运行库已安装"
  else
    note "libwebkit2gtk-4.1 运行库未检测到（目标机安装 .deb 时会作为依赖拉取）"
  fi
else
  bad "未找到 apt-cache（非 Debian/Ubuntu 系发行版？）"
fi

# 4. dpkg-deb（.deb 打包工具）
if command -v dpkg-deb >/dev/null 2>&1; then
  ok "dpkg-deb：$(command -v dpkg-deb)"
else
  bad "缺少 dpkg-deb（安装 dpkg 后重试）"
fi

# 5. Rust 工具链（rustup 安装）；插件要求 rustc ≥ 1.90
if command -v cargo >/dev/null 2>&1 && command -v rustc >/dev/null 2>&1; then
  ok "Rust：$(rustc --version 2>/dev/null)；$(cargo --version 2>/dev/null)"
  rust_ver="$(rustc --version 2>/dev/null | awk '{print $2}')"
  rust_major="${rust_ver%%.*}"
  rust_rest="${rust_ver#*.}"
  rust_minor="${rust_rest%%.*}"
  if [ "$rust_major" -gt 1 ] 2>/dev/null || { [ "$rust_major" -eq 1 ] 2>/dev/null && [ "${rust_minor:-0}" -ge 90 ] 2>/dev/null; }; then
    ok "Rust 版本满足 ≥ 1.90（tauri-plugin-fs/http 要求）"
  else
    bad "Rust ${rust_ver} 过旧（tauri-plugin-fs/http 要求 ≥ 1.90，rustup update 升级）"
  fi
else
  bad "未安装 Rust（curl https://sh.rustup.rs -sSf | sh）"
fi

# 5b. C 工具链与 pkg-config（rustls/ring 的 C 依赖与 webkitgtk-sys 构建需要）
# 必须是功能性检查：只查“cc 存在”会漏掉 libc6-dev 缺失（gcc 在、glibc 头不在），
# 那种情况 ring 要到第 5 步编译几百个 crate 之后才炸（stdint.h: No such file）。
if command -v cc >/dev/null 2>&1 || command -v gcc >/dev/null 2>&1; then
  CC_BIN="$(command -v cc 2>/dev/null || command -v gcc 2>/dev/null)"
  ok "C 编译器：$CC_BIN"
  probe_c="$(mktemp /tmp/check-env-XXXXXX.c)"
  probe_bin="${probe_c}.bin"
  printf '#include <stdint.h>\nint main(void){ uint32_t v = 42; return (int)(v - 42); }\n' >"$probe_c"
  if "$CC_BIN" -o "$probe_bin" "$probe_c" >/dev/null 2>&1 && [ -x "$probe_bin" ]; then
    ok "C 工具链功能可用（stdint.h 编译链接通过）"
  else
    bad "C 编译功能测试失败（多半缺 libc6-dev：sudo apt-get install -y build-essential）"
  fi
  rm -f "$probe_c" "$probe_bin"
else
  bad "缺少 C 编译器（sudo apt-get install -y build-essential）"
fi
if command -v pkg-config >/dev/null 2>&1; then
  ok "pkg-config $(pkg-config --version 2>/dev/null)"
else
  bad "缺少 pkg-config（sudo apt-get install -y pkg-config）"
fi

# 6. Node.js >= 18（前端测试与 Tauri CLI）
if command -v node >/dev/null 2>&1; then
  node_ver="$(node --version | sed 's/^v//')"
  node_major="${node_ver%%.*}"
  if [ -n "$node_major" ] && [ "$node_major" -ge 18 ] 2>/dev/null; then
    ok "Node.js v$node_ver"
  else
    bad "Node.js v$node_ver 过旧（需要 >= 18）"
  fi
else
  bad "未安装 Node.js（需要 >= 18）"
fi

# 7. npm
if command -v npm >/dev/null 2>&1; then
  ok "npm $(npm --version 2>/dev/null)"
else
  bad "未安装 npm"
fi

# 8. git
if command -v git >/dev/null 2>&1; then
  ok "git $(git --version 2>/dev/null | awk '{print $3}')"
else
  note "未安装 git（克隆与提交代码需要）"
fi

# 9. 磁盘剩余空间（工具链 + 依赖 + 打包约需 5GB）
if command -v df >/dev/null 2>&1; then
  avail_kb="$(df -Pk . 2>/dev/null | awk 'NR==2 {print $4}')"
  if [ -n "${avail_kb:-}" ] && [ "$avail_kb" -gt 5242880 ] 2>/dev/null; then
    ok "磁盘可用空间充足（$((avail_kb / 1024 / 1024)) GB）"
  else
    note "磁盘可用空间可能不足 5GB（当前约 $(( ${avail_kb:-0} / 1024 / 1024 )) GB）"
  fi
fi

# 10. E2E 浏览器（msedge / chrome / playwright 自带 chromium，三选一即可）
if [ -x /opt/microsoft/msedge/msedge ] || command -v microsoft-edge >/dev/null 2>&1 \
  || command -v google-chrome >/dev/null 2>&1 || command -v chromium >/dev/null 2>&1 \
  || [ -d "$HOME/.cache/ms-playwright" ]; then
  ok "E2E 浏览器可用（msedge/chrome/chromium 或 playwright 缓存）"
else
  note "未检测到 E2E 浏览器——build-deb.sh 会自动执行 npx playwright-core install chromium"
fi

echo "== 结果：PASS $pass / FAIL $fail / WARN $warn =="
if [ "$fail" -gt 0 ]; then
  echo "存在 FAIL 项，环境不满足构建条件；请按提示处理后重跑本脚本。"
  exit 1
fi
echo "环境自检通过，可以开始构建 .deb。"
exit 0
