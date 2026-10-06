import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const scriptPath = path.join(root, 'scripts', 'check-env.sh');
const script = await readFile(scriptPath, 'utf8');

test('自检脚本存在且为 LF 行尾的 bash 脚本', () => {
  assert.ok(script.startsWith('#!/usr/bin/env bash'), '缺少 bash shebang');
  assert.ok(!script.includes('\r'), '脚本必须是 LF 行尾（CRLF 会在 Linux 上执行失败）');
  assert.ok(script.includes('set -u'));
});

test('覆盖 ARM64 架构与系统版本检查', () => {
  assert.ok(script.includes('uname -m'));
  assert.ok(script.includes('aarch64'));
  assert.ok(script.includes('/etc/os-release'));
});

test('覆盖 Tauri 关键依赖检查', () => {
  assert.ok(script.includes('libwebkit2gtk-4.1'), '缺少 webkit2gtk-4.1 检查');
  assert.ok(
    script.includes('pkg-config --exists webkit2gtk-4.1'),
    'webkit 开发包必须查“已安装”，仅查“可安装”会让构建在后面才炸'
  );
  assert.ok(script.includes('apt-cache'), '应通过 apt-cache 验证源中可用');
  assert.ok(script.includes('cargo') && script.includes('rustc'), '缺少 Rust 工具链检查');
  assert.ok(script.includes('1.90'), '插件要求 rustc ≥ 1.90，必须校验版本');
  assert.ok(script.includes('pkg-config'), '缺少 pkg-config 检查');
  assert.ok(script.includes('build-essential') || script.includes('gcc'), '缺少 C 工具链检查');
  assert.ok(
    script.includes('stdint.h'),
    'C 检查必须是功能性编译测试（ring 曾因缺 libc6-dev 编到第 5 步才炸）'
  );
  assert.ok(script.includes('libc6-dev'), '功能失败要给出 libc6-dev 修复指引');
  assert.ok(script.includes('dpkg-deb'), '缺少 dpkg-deb 打包工具检查');
  assert.ok(script.includes('node'), '缺少 Node.js 检查');
});

test('有汇总与退出码语义（FAIL 时 exit 1）', () => {
  assert.ok(script.includes('PASS'), '应输出通过计数');
  assert.ok(script.includes('FAIL'), '应输出失败计数');
  assert.ok(/if \[ "\$fail" -gt 0 \]/.test(script), '应按 fail 计数判断');
  assert.ok(script.includes('exit 1'));
  assert.ok(script.includes('exit 0'));
});

test('E2E 浏览器探测（缺失时 WARN 并由构建脚本自动装）', () => {
  assert.ok(script.includes('msedge') || script.includes('playwright'), '应探测浏览器');
  assert.ok(script.includes('playwright-core install chromium'), '应指引自动安装命令');
  assert.ok(script.includes('note '), '浏览器缺失只 WARN 不阻塞');
});
