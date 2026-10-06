import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const script = readFileSync(path.join(root, 'scripts', 'build-deb.sh'), 'utf8');

test('build-deb.sh：bash 脚本、LF 行尾、严格模式', () => {
  assert.ok(script.startsWith('#!/usr/bin/env bash'));
  assert.ok(!script.includes('\r'), '必须是 LF 行尾');
  assert.ok(script.includes('set -euo pipefail'));
});

test('流程覆盖：自检 → 依赖 → 测试 → 打包 → 产物校验', () => {
  assert.ok(script.includes('bash scripts/check-env.sh'), '先跑环境自检');
  assert.ok(script.includes('npm install'), '安装依赖');
  assert.ok(script.includes('node scripts/vendor-tauri.mjs'), '刷新 vendor');
  assert.ok(script.includes('npm test'), '跑单元测试');
  assert.ok(script.includes('playwright-core install chromium'), '缺浏览器时自动安装 chromium');
  assert.ok(
    script.includes("['msedge', 'chrome', 'chromium']"),
    '探测链必须与 e2e 一致且不含 headless-shell 兜底'
  );
  assert.ok(!script.includes("'chromium', null"), '不允许兜底到 headless shell（文件名断言会挂）');
  assert.ok(script.includes('node tests/e2e.mjs'), '跑 E2E');
  assert.ok(script.includes('npm run tauri:build'), '调用 Tauri 打包');
});

test('产物校验：定位 deb 并检查关键内容', () => {
  assert.ok(script.includes("find src-tauri/target"), '应从 target 下查找产物');
  assert.ok(script.includes("bundle/deb/*.deb"), 'deb 路径模式');
  assert.ok(script.includes('dpkg-deb -I'), '输出控制信息');
  assert.ok(
    script.includes("grep -E 'usr/bin/ai-multi-chat$'"),
    '清单路径无前导斜杠（曾误用 /usr/bin 导致假失败）'
  );
  assert.ok(!script.includes("grep -E '/usr/bin/ai-multi-chat'"), '不许再带前导斜杠匹配清单');
  assert.ok(script.includes('.desktop'), '校验桌面项');
  assert.ok(script.includes('dpkg-deb -f "$DEB" Depends'), '校验 Depends 含 webkit');
  assert.ok(script.includes('dpkg-deb -x'), '解包做深度校验');
  assert.ok(
    script.includes("'assets/defaults/avatar.png'"),
    '出厂默认资源以“嵌入二进制”方式校验（deb 清单里没有独立文件）'
  );
  assert.ok(script.includes('Exec=ai-multi-chat'), '校验 desktop 的 Exec');
  assert.ok(
    script.includes('DEB="$(realpath "$DEB")"'),
    'apt 装本地 deb 必须绝对路径（相对路径会被当包名搜源）'
  );
  assert.ok(script.includes('exit 1'), '任一校验失败即退出');
});

test('E2E 服务管理：日志落盘、轮询就绪、拒绝陈旧占用', () => {
  assert.ok(script.includes('js/defaults.js'), '用新文件探测 8800 是否为当前项目');
  assert.ok(script.includes('不是当前项目'), '陈旧服务要给出明确报错');
  assert.ok(script.includes('trap cleanup EXIT'), '退出时清理后台服务');
  assert.ok(script.includes('wait_http'), '必须轮询等待就绪，而不是固定 sleep');
  assert.ok(script.includes('output/build-static.log'), '静态服务日志落盘可排查');
  assert.ok(script.includes('output/build-mock.log'), 'mock 服务日志落盘可排查');
  assert.ok(script.includes('tail -n 30'), '启动超时要打印日志尾部');
  assert.ok(
    !/static-server\.mjs\s*>\/dev\/null/.test(script),
    '服务输出不能吞进 /dev/null（上次排障就是被这个坑了）'
  );
  assert.ok(!/mock-server\.mjs\s*>\/dev\/null/.test(script));
  assert.ok(script.includes('http_ok'), 'HTTP 探测统一入口');
  assert.ok(
    !script.includes('curl '),
    '不依赖 curl（构建机不一定有），探测走 node'
  );
  assert.ok(script.includes('无需任何后台服务'), '向用户说明最终应用不依赖服务');
});

test('可选安装入口', () => {
  assert.ok(script.includes('--install'));
  assert.ok(script.includes('apt-get install -y "$DEB"'));
});
