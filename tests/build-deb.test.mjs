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
  assert.ok(script.includes('node tests/e2e.mjs'), '跑 E2E');
  assert.ok(script.includes('npm run tauri:build'), '调用 Tauri 打包');
});

test('产物校验：定位 deb 并检查关键内容', () => {
  assert.ok(script.includes("find src-tauri/target"), '应从 target 下查找产物');
  assert.ok(script.includes("bundle/deb/*.deb"), 'deb 路径模式');
  assert.ok(script.includes('dpkg-deb -I'), '输出控制信息');
  assert.ok(script.includes('/usr/bin/ai-multi-chat'), '校验可执行文件');
  assert.ok(script.includes('.desktop'), '校验桌面项');
  assert.ok(script.includes('assets/defaults/'), '校验出厂默认资源');
  assert.ok(script.includes('exit 1'), '任一校验失败即退出');
});

test('E2E 服务管理：复用当前项目服务、拒绝陈旧占用', () => {
  assert.ok(script.includes('js/defaults.js'), '用新文件探测 8800 是否为当前项目');
  assert.ok(script.includes('不是当前项目'), '陈旧服务要给出明确报错');
  assert.ok(script.includes('trap cleanup EXIT'), '退出时清理后台服务');
});

test('可选安装入口', () => {
  assert.ok(script.includes('--install'));
  assert.ok(script.includes('apt-get install -y "$DEB"'));
});
