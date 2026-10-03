import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  exportFilename,
  fenceFor,
  formatDateTime,
  safeFilename,
  sessionToMarkdown,
} from '../js/export.js';

function session(messages, title = '测试会话') {
  return { id: 's1', title, messages, createdAt: 0, updatedAt: 0 };
}

test('safeFilename 清理非法字符与首尾点号', () => {
  assert.equal(safeFilename('a/b\\c:d*e?f"g<h>i|j'), 'a b c d e f g h i j');
  assert.equal(safeFilename('  前后空格  '), '前后空格');
  assert.equal(safeFilename('...隐藏...'), '隐藏');
  assert.equal(safeFilename(''), '会话导出');
  assert.equal(safeFilename(null), '会话导出');
  assert.equal(safeFilename('x'.repeat(100)).length, 60);
  assert.equal(safeFilename('控制\u0000字符'), '控制字符');
});

test('exportFilename 生成 .md 文件名', () => {
  assert.equal(exportFilename({ title: '多模型对比' }), '多模型对比.md');
  assert.equal(exportFilename({ title: '' }), '会话导出.md');
  assert.equal(exportFilename(null), '会话导出.md');
});

test('formatDateTime 输出本地时间且容忍非法输入', () => {
  assert.equal(formatDateTime(new Date(2026, 9, 3, 9, 5)), '2026-10-03 09:05');
  assert.equal(formatDateTime(new Date('invalid')), '');
});

test('fenceFor 避开正文中已有的反引号', () => {
  assert.equal(fenceFor('普通文本'), '```');
  assert.equal(fenceFor('含 ``` 代码块'), '````');
  assert.equal(fenceFor('四连 ```` 引号'), '`````');
});

test('sessionToMarkdown 输出头部信息与分隔线', () => {
  const md = sessionToMarkdown(session([]), { now: new Date(2026, 0, 2, 3, 4) });
  assert.ok(md.startsWith('# 测试会话\n'));
  assert.match(md, /- 导出时间：2026-01-02 03:04/);
  assert.match(md, /- 消息数：0/);
  assert.match(md, /图片附件仅保留文件名/);
  assert.ok(md.endsWith('\n'));
  assert.equal(sessionToMarkdown(null), '');
});

test('sessionToMarkdown 导出正文、附件与用量', () => {
  const md = sessionToMarkdown(
    session([
      {
        id: 'm1',
        role: 'user',
        content: [
          { type: 'text', text: '看下这份文档' },
          { type: 'image', dataUrl: 'data:image/png;base64,AAAA', name: 'a.png' },
          { type: 'file', name: 'notes.md', text: '# 纪要\n含 ``` 内容' },
        ],
      },
      {
        id: 'm2',
        role: 'assistant',
        content: [{ type: 'text', text: '这是回复' }],
        model: { providerId: 'p1', model: 'mock-model' },
        usage: { promptTokens: 42, completionTokens: 108, totalTokens: 150, estimated: false },
        ms: 2600,
      },
    ]),
    { now: new Date(2026, 0, 2, 3, 4), providerName: (id) => (id === 'p1' ? 'Mock 服务' : '') }
  );

  assert.match(md, /## 你/);
  assert.match(md, /看下这份文档/);
  assert.match(md, /> 图片附件：a\.png/);
  assert.match(md, /\*\*文档附件：notes\.md\*\*/);
  // 正文含三连反引号 → 围栏升级为四个
  assert.match(md, /````text\n# 纪要\n含 ``` 内容\n````/);
  assert.match(md, /## AI（Mock 服务 · mock-model）/);
  assert.match(md, /> 用量：提示 42 · 输出 108 · 合计 150 · 用时 2\.6s\n/);
  assert.match(md, /- 模型：Mock 服务 · mock-model/);
  // 图片数据不应被写入
  assert.ok(!md.includes('data:image/png'));
});

test('sessionToMarkdown 标注估算用量与错误回复', () => {
  const md = sessionToMarkdown(
    session([
      {
        id: 'm1',
        role: 'assistant',
        content: [{ type: 'text', text: '请求失败（HTTP 401）：bad key' }],
        error: true,
      },
      {
        id: 'm2',
        role: 'assistant',
        content: [{ type: 'text', text: 'ok' }],
        usage: { promptTokens: 1, completionTokens: 2, totalTokens: 3, estimated: true },
      },
    ])
  );
  assert.match(md, /> 生成失败：请求失败（HTTP 401）：bad key/);
  assert.match(md, /合计 3（估算）/);
  // 未记录模型时不写模型行
  assert.ok(!md.includes('- 模型：'));
});

test('sessionToMarkdown 在回复标题下写明当轮系统提示', () => {
  const md = sessionToMarkdown(
    session([
      { id: 'm1', role: 'user', content: [{ type: 'text', text: '写点什么' }] },
      {
        id: 'm2',
        role: 'assistant',
        content: [{ type: 'text', text: '第一版' }],
        model: { providerId: 'p1', model: 'mock-model' },
        systemPrompt: { name: '写作助手', text: '你是一位严谨的编辑' },
      },
    ]),
    { providerName: () => 'Mock 服务' }
  );
  const headingIdx = md.indexOf('## AI（Mock 服务 · mock-model）');
  const promptIdx = md.indexOf('**系统提示（写作助手）**');
  const bodyIdx = md.indexOf('第一版');
  assert.ok(headingIdx !== -1 && promptIdx !== -1 && bodyIdx !== -1);
  assert.ok(headingIdx < promptIdx && promptIdx < bodyIdx, '系统提示应在标题之后、正文之前');
  assert.match(md, /```text\n你是一位严谨的编辑\n```/);
});

test('sessionToMarkdown 对连续相同的系统提示用「同上」去重', () => {
  const sp = { name: '写作助手', text: '你是一位严谨的编辑' };
  const md = sessionToMarkdown(
    session([
      { id: 'm1', role: 'assistant', content: [{ type: 'text', text: '一' }], systemPrompt: sp },
      { id: 'm2', role: 'assistant', content: [{ type: 'text', text: '二' }], systemPrompt: sp },
      { id: 'm3', role: 'assistant', content: [{ type: 'text', text: '三' }], systemPrompt: sp },
    ])
  );
  assert.equal(md.split('**系统提示（写作助手）**').length - 1, 1);
  assert.equal(md.split('> 系统提示：同上').length - 1, 2);
});

test('sessionToMarkdown 在提示被改动或取消时如实标注', () => {
  const md = sessionToMarkdown(
    session([
      { id: 'm1', role: 'assistant', content: [{ type: 'text', text: '一' }], systemPrompt: { name: 'A', text: '第一版' } },
      { id: 'm2', role: 'assistant', content: [{ type: 'text', text: '二' }], systemPrompt: { name: 'A', text: '第二版' } },
      { id: 'm3', role: 'assistant', content: [{ type: 'text', text: '三' }] },
      { id: 'm4', role: 'assistant', content: [{ type: 'text', text: '四' }] },
    ])
  );
  assert.match(md, /\*\*系统提示（A）\*\*/);
  assert.equal(md.split('第二版').length - 1, 1);
  assert.equal(md.split('> 本轮未使用系统提示').length - 1, 1);
  // 一直没有提示时不写任何提示行
  const plain = sessionToMarkdown(session([{ id: 'm1', role: 'assistant', content: [{ type: 'text', text: '一' }] }]));
  assert.ok(!plain.includes('系统提示'));
});

test('sessionToMarkdown 跳过空的文本片段', () => {
  const md = sessionToMarkdown(session([{ id: 'm1', role: 'assistant', content: [{ type: 'text', text: '   ' }] }]));
  assert.match(md, /## AI\n/);
  assert.ok(!md.includes('   \n'));
});
