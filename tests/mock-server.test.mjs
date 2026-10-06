import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import net from 'node:net';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { MOCK_VERSION, createMockServer } from './mock-server.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

function freePort() {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.once('error', reject);
    srv.listen(0, '127.0.0.1', () => {
      const { port } = srv.address();
      srv.close(() => resolve(port));
    });
  });
}

test('createMockServer /health 返回 MOCK_VERSION', async () => {
  const server = createMockServer();
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address();
  try {
    const res = await fetch(`http://127.0.0.1:${port}/health`);
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.version, MOCK_VERSION);
  } finally {
    server.close();
  }
});

// 回归：isDirectRun 曾用手工拼接的 file:/// URL 比较，在 Linux 上相对路径/符号链接
// 场景恒为 false —— 直接运行时静默退出、端口永远起不来（构建脚本 30s 超时的根因）。
test('直接运行入口真的会监听并打印启动日志', async () => {
  const port = await freePort();
  const child = spawn(process.execPath, ['tests/mock-server.mjs'], {
    cwd: root,
    env: { ...process.env, MOCK_PORT: String(port) },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let out = '';
  child.stdout.on('data', (d) => (out += d));
  child.stderr.on('data', (d) => (out += d));
  try {
    let ready = false;
    for (let i = 0; i < 50; i++) {
      if (child.exitCode !== null) break;
      try {
        const res = await fetch(`http://127.0.0.1:${port}/health`);
        if (res.ok) {
          ready = true;
          break;
        }
      } catch {
        /* 未就绪，继续等 */
      }
      await new Promise((r) => setTimeout(r, 100));
    }
    assert.ok(
      ready,
      `mock 直接运行未就绪（exit=${child.exitCode}）——输出：${out || '(空)'}`
    );
    assert.ok(out.includes('mock server ready'), '应打印启动日志（构建脚本靠它排查）');
  } finally {
    child.kill();
  }
});
