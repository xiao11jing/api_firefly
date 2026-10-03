import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  joinUrl,
  buildEndpoint,
  buildHeaders,
  toApiMessage,
  buildChatBody,
  SSEParser,
  extractDelta,
} from '../js/provider.js';

test('joinUrl 处理两侧斜杠', () => {
  assert.equal(joinUrl('https://api.openai.com/', '/v1/chat/completions'), 'https://api.openai.com/v1/chat/completions');
  assert.equal(joinUrl('https://api.openai.com', 'chat/completions'), 'https://api.openai.com/chat/completions');
  assert.equal(joinUrl('https://x.com///', '//path/'), 'https://x.com/path/');
});

test('buildEndpoint 无代理时拼 chat/completions', () => {
  assert.equal(
    buildEndpoint({ baseUrl: 'https://api.openai.com/v1' }),
    'https://api.openai.com/v1/chat/completions'
  );
});

test('buildEndpoint 有代理时做后缀拼接', () => {
  assert.equal(
    buildEndpoint({
      baseUrl: 'https://api.openai.com/v1',
      proxyUrl: 'http://127.0.0.1:8787/proxy/',
    }),
    'http://127.0.0.1:8787/proxy/https://api.openai.com/v1/chat/completions'
  );
});

test('buildHeaders 带/不带 key', () => {
  const withKey = buildHeaders({ apiKey: ' sk-abc ' });
  assert.equal(withKey.Authorization, 'Bearer sk-abc');
  assert.equal(withKey['Content-Type'], 'application/json');
  const noKey = buildHeaders({ apiKey: '' });
  assert.equal(noKey.Authorization, undefined);
});

test('toApiMessage 纯文本合并为字符串', () => {
  const m = toApiMessage({
    role: 'user',
    content: [
      { type: 'text', text: '你好' },
      { type: 'text', text: '，在吗' },
    ],
  });
  assert.deepEqual(m, { role: 'user', content: '你好，在吗' });
});

test('toApiMessage 含图片时转为 vision 数组格式', () => {
  const m = toApiMessage({
    role: 'user',
    content: [
      { type: 'text', text: '这是什么' },
      { type: 'image', dataUrl: 'data:image/png;base64,AAAA', name: 'a.png' },
    ],
  });
  assert.ok(Array.isArray(m.content));
  assert.equal(m.content[0].type, 'text');
  assert.equal(m.content[1].type, 'image_url');
  assert.equal(m.content[1].image_url.url, 'data:image/png;base64,AAAA');
});

test('buildChatBody 默认开启流式', () => {
  const body = buildChatBody({ model: 'gpt-4o-mini', messages: [{ role: 'user', content: 'hi' }] });
  assert.equal(body.stream, true);
  assert.equal(body.model, 'gpt-4o-mini');
  assert.equal(body.messages[0].content, 'hi');
});

test('SSEParser 处理跨块数据与多事件', () => {
  const p = new SSEParser();
  let evts = p.push('data: {"a":1}\n\n');
  assert.deepEqual(evts, ['{"a":1}']);
  // 事件被切断成两块
  evts = p.push('data: {"b"');
  assert.deepEqual(evts, []);
  evts = p.push(':2}\n\ndata: [DONE]\n\n');
  assert.deepEqual(evts, ['{"b":2}']);
  assert.equal(p.done, true);
});

test('SSEParser 忽略心跳注释与 event 行，支持 \\r\\n', () => {
  const p = new SSEParser();
  const evts = p.push(': keep-alive\r\n\nevent: message\r\ndata: {"x":1}\r\n\r\n');
  assert.deepEqual(evts, ['{"x":1}']);
});

test('SSEParser 多行 data 合并', () => {
  const p = new SSEParser();
  const evts = p.push('data: line1\ndata: line2\n\n');
  assert.deepEqual(evts, ['line1\nline2']);
});

test('SSEParser flush 处理无结尾空行的残余', () => {
  const p = new SSEParser();
  assert.deepEqual(p.push('data: {"tail":1}'), []);
  assert.deepEqual(p.flush(), ['{"tail":1}']);
});

test('extractDelta 提取 delta 文本与结束标记', () => {
  const r1 = extractDelta(JSON.stringify({ choices: [{ delta: { content: '你好' }, finish_reason: null }] }));
  assert.equal(r1.text, '你好');
  assert.equal(r1.finishReason, null);
  const r2 = extractDelta(JSON.stringify({ choices: [{ delta: {}, finish_reason: 'stop' }], usage: { total_tokens: 10 } }));
  assert.equal(r2.text, '');
  assert.equal(r2.finishReason, 'stop');
  assert.equal(r2.usage.total_tokens, 10);
});

test('extractDelta 兼容数组形式 content', () => {
  const r = extractDelta(
    JSON.stringify({ choices: [{ delta: { content: [{ type: 'text', text: 'ab' }, { type: 'text', text: 'c' }] } }] })
  );
  assert.equal(r.text, 'abc');
});

test('extractDelta 非法 JSON 抛出友好错误', () => {
  assert.throws(() => extractDelta('not-json'), /无法解析/);
});
