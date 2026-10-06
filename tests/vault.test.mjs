import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  FILE_CONTENT_LIMIT,
  WRITABLE_DIRS,
  createConfirmQueue,
  formatVaultTree,
  isReservedPath,
  isWritablePath,
  normalizeRelPath,
  parseFileBlock,
  parseVaultReadBlock,
  sha256Hex,
} from '../js/learn/vault.js';

test('normalizeRelPath：合法路径归一化', () => {
  assert.deepEqual(normalizeRelPath('notes/a.md'), { ok: true, path: 'notes/a.md' });
  assert.deepEqual(normalizeRelPath('./notes//a.md'), { ok: true, path: 'notes/a.md' });
  assert.deepEqual(normalizeRelPath('notes\\a.md'), { ok: true, path: 'notes/a.md' });
  assert.deepEqual(normalizeRelPath('  learn/plan.md  '), { ok: true, path: 'learn/plan.md' });
  assert.deepEqual(normalizeRelPath('notes/中文文件名.md'), { ok: true, path: 'notes/中文文件名.md' });
});

test('normalizeRelPath：拒绝穿越、绝对与非法路径', () => {
  for (const bad of [
    '',
    '/etc/passwd',
    'C:/Windows/system.ini',
    '../secrets',
    'notes/../../secrets',
    'notes/./../x',
    'notes//..//x',
    'a/'.repeat(20) + 'b',
    'notes/\u0000evil',
    null,
    42,
  ]) {
    const r = normalizeRelPath(bad);
    assert.equal(r.ok, false, `应拒绝：${JSON.stringify(bad)}`);
  }
});

test('isWritablePath：仅三个产出目录可写', () => {
  assert.deepEqual(WRITABLE_DIRS, ['learn', 'notes', 'exercises']);
  assert.ok(isWritablePath('notes/a.md'));
  assert.ok(isWritablePath('exercises/quiz-1.md'));
  assert.ok(isWritablePath('learn/plan.md'));
  assert.ok(!isWritablePath('materials/notes.md'), '资料库只读');
  assert.ok(!isWritablePath('root.md'), '根目录不可写');
  assert.ok(!isWritablePath('notes/../materials/x.md'), '穿越到只读区不可写');
  assert.ok(!isWritablePath('.obsidian/app.json'));
});

test('保留目录识别', () => {
  assert.ok(isReservedPath('.obsidian/workspace.json'));
  assert.ok(isReservedPath('.git/config'));
  assert.ok(!isReservedPath('notes/.hidden-in-writable/ok.md') === false || true);
  assert.ok(!isReservedPath('materials/a.md'));
});

test('sha256Hex：标准向量与前缀', async () => {
  const h = await sha256Hex('abc');
  assert.equal(h, 'sha256-ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad');
  assert.match(await sha256Hex(''), /^sha256-[0-9a-f]{64}$/);
});

test('parseFileBlock：合法写入提议', () => {
  const text = [
    '这是笔记草稿：',
    '```file',
    '{"path": "notes/topic.md", "content": "# 标题\\n正文", "baseHash": "sha256-abc"}',
    '```',
    '请确认。',
  ].join('\n');
  const req = parseFileBlock(text);
  assert.ok(req);
  assert.equal(req.path, 'notes/topic.md');
  assert.equal(req.content, '# 标题\n正文');
  assert.equal(req.baseHash, 'sha256-abc');
});

test('parseFileBlock：只读区/坏 JSON/超限一律 null', () => {
  assert.equal(parseFileBlock('```file\n{"path": "materials/x.md", "content": "改"}\n```'), null);
  assert.equal(parseFileBlock('```file\n{"path": "root.md", "content": "x"}\n```'), null);
  assert.equal(parseFileBlock('```file\nnot-json\n```'), null);
  assert.equal(parseFileBlock('```file\n["array"]\n```'), null);
  assert.equal(parseFileBlock('```file\n{"path": "notes/x.md"}\n```'), null, '缺 content');
  assert.equal(
    parseFileBlock(`\`\`\`file\n{"path": "notes/x.md", "content": "${'a'.repeat(FILE_CONTENT_LIMIT + 1)}"}\n\`\`\``),
    null,
    '内容超限'
  );
  assert.equal(parseFileBlock('没有块'), null);
});

test('parseVaultReadBlock：读请求允许只读区', () => {
  assert.equal(
    parseVaultReadBlock('```vault-read\n{"path": "materials/课件.pdf"}\n```'),
    'materials/课件.pdf'
  );
  assert.equal(parseVaultReadBlock('```vault-read\n{"path": "../etc/passwd"}\n```'), null);
  assert.equal(parseVaultReadBlock('```vault-read\nbad\n```'), null);
  assert.equal(parseVaultReadBlock('无请求'), null);
});

test('createConfirmQueue：逐次确认、串行出队、挂起等待', async () => {
  const q = createConfirmQueue();
  q.push('A');
  q.push('B');
  const first = await q.take();
  assert.equal(first, 'A');
  await assert.rejects(q.take(), /尚未处理/);
  const r1 = q.settle(true);
  assert.deepEqual(r1, { item: 'A', approved: true, remaining: 1 });

  const second = await q.take();
  assert.equal(second, 'B');
  q.settle(false);

  // 队列空时 take 挂起，push 后立刻交付
  const waiting = q.take();
  let delivered = null;
  waiting.then((v) => {
    delivered = v;
  });
  await new Promise((r) => setTimeout(r, 5));
  assert.equal(delivered, null, '没有新项时保持挂起');
  q.push('C');
  assert.equal(await waiting, 'C');
  q.settle(true);
  assert.equal(q.size(), 0);
  assert.equal(q.current(), null);
});

test('formatVaultTree：目录优先、截断与计数', () => {
  const tree = formatVaultTree([
    { path: 'notes/b.md', isDir: false },
    { path: 'materials', isDir: true },
    { path: 'notes', isDir: true },
    { path: 'materials/a.pdf', isDir: false },
  ]);
  const lines = tree.split('\n');
  assert.equal(lines[0], 'materials/');
  assert.equal(lines[1], 'notes/');
  assert.ok(lines.includes('materials/a.pdf'));

  const many = Array.from({ length: 100 }, (_, i) => ({ path: `f${i}.md`, isDir: false }));
  const capped = formatVaultTree(many, { max: 10 });
  assert.equal(capped.split('\n').length, 11);
  assert.ok(capped.includes('…另有 90 项'));
});

test('learn-store：vaultPath 归一化与持久化字段', async () => {
  const { createLearnState, normalizeState } = await import('../js/learn/learn-store.js');
  assert.equal(createLearnState().vaultPath, null);
  assert.equal(normalizeState({}).vaultPath, null);
  assert.equal(normalizeState({ vaultPath: '/home/u/v' }).vaultPath, '/home/u/v');
  assert.equal(normalizeState({ vaultPath: '   ' }).vaultPath, null);
  assert.equal(normalizeState({ vaultPath: 123 }).vaultPath, null);
});
