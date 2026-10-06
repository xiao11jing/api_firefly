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
  if apt-cache policy libwebkit2gtk-4.1-dev 2>/dev/null | grep -q 'Candidate: [0-9]'; then
    ok "libwebkit2gtk-4.1-dev 可安装（Tauri 构建依赖）"
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

# 5. Rust 工具链（rustup 安装）
if command -v cargo >/dev/null 2>&1 && command -v rustc >/dev/null 2>&1; then
  ok "Rust：$(rustc --version 2>/dev/null)；$(cargo --version 2>/dev/null)"
else
  bad "未安装 Rust（curl https://sh.rustup.rs -sSf | sh）"
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

echo "== 结果：PASS $pass / FAIL $fail / WARN $warn =="
if [ "$fail" -gt 0 ]; then
  echo "存在 FAIL 项，环境不满足构建条件；请按提示处理后重跑本脚本。"
  exit 1
fi
echo "环境自检通过，可以开始构建 .deb。"
exit 0
