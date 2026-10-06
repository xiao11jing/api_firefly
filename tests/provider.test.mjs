import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  joinUrl,
  buildEndpoint,
  buildHeaders,
  toApiMessage,
  buildChatBody,
  filePartToText,
  SSEParser,
  extractDelta,
  setFetch,
  streamChat,
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

test('toApiMessage 支持多张图片：保持片段顺序', () => {
  const m = toApiMessage({
    role: 'user',
    content: [
      { type: 'text', text: '对比这两张图' },
      { type: 'image', dataUrl: 'data:image/png;base64,AAA', name: 'a.png' },
      { type: 'image', dataUrl: 'data:image/png;base64,BBB', name: 'b.png' },
    ],
  });
  assert.ok(Array.isArray(m.content));
  assert.equal(m.content.length, 3);
  assert.deepEqual(m.content[0], { type: 'text', text: '对比这两张图' });
  assert.equal(m.content[1].image_url.url, 'data:image/png;base64,AAA');
  assert.equal(m.content[2].image_url.url, 'data:image/png;base64,BBB');
});

test('toApiMessage 纯文档（无图片）内嵌为字符串并带标记', () => {
  const m = toApiMessage({
    role: 'user',
    content: [
      { type: 'text', text: '总结一下' },
      { type: 'file', name: 'note.md', text: '# 标题\n正文' },
    ],
  });
  assert.equal(typeof m.content, 'string');
  assert.match(m.content, /总结一下/);
  assert.match(m.content, /【附件文档：note\.md】/);
  assert.match(m.content, /# 标题\n正文/);
  assert.match(m.content, /【附件文档结束】/);
});

test('toApiMessage 图文与文档混排：图片走 vision，文档走文本片段', () => {
  const m = toApiMessage({
    role: 'user',
    content: [
      { type: 'text', text: '检查图纸和说明' },
      { type: 'image', dataUrl: 'data:image/png;base64,AAA', name: 'a.png' },
      { type: 'file', name: 'spec.pdf', text: '规格说明', pages: 3 },
    ],
  });
  assert.ok(Array.isArray(m.content));
  assert.equal(m.content.length, 3);
  assert.equal(m.content[1].type, 'image_url');
  assert.equal(m.content[2].type, 'text');
  assert.match(m.content[2].text, /【附件文档：spec\.pdf】/);
  assert.match(m.content[2].text, /规格说明/);
});

test('filePartToText 处理空文本、截断与缺名', () => {
  assert.match(filePartToText({ name: 'a.txt', text: '   ' }), /未能提取到文本内容/);
  assert.match(filePartToText({ name: 'a.txt', text: 'x', truncated: true }), /截断后的内容/);
  assert.match(filePartToText({ text: 'x' }), /【附件文档：未命名文档】/);
  assert.ok(!filePartToText({ name: 'a.txt', text: 'x' }).includes('截断'));
});

test('buildChatBody 默认开启流式', () => {
  const body = buildChatBody({ model: 'gpt-4o-mini', messages: [{ role: 'user', content: 'hi' }] });
  assert.equal(body.stream, true);
  assert.equal(body.model, 'gpt-4o-mini');
  assert.equal(body.messages[0].content, 'hi');
  assert.equal('stream_options' in body, false);
});

test('buildChatBody 请求用量时带上 stream_options', () => {
  const withUsage = buildChatBody({
    model: 'm',
    messages: [{ role: 'user', content: 'hi' }],
    includeUsage: true,
  });
  assert.deepEqual(withUsage.stream_options, { include_usage: true });

  // 非流式请求不带该字段
  const noStream = buildChatBody({ model: 'm', messages: [], stream: false, includeUsage: true });
  assert.equal('stream_options' in noStream, false);
});

test('extractDelta 支持仅含 usage 的收尾事件', () => {
  const r = extractDelta(JSON.stringify({ choices: [], usage: { prompt_tokens: 42, completion_tokens: 108, total_tokens: 150 } }));
  assert.equal(r.text, '');
  assert.equal(r.usage.total_tokens, 150);
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

test('setFetch：streamChat 走注入的本地请求通道', async () => {
  const calls = [];
  setFetch(async (url, init) => {
    calls.push({ url, init });
    return new Response(JSON.stringify({ choices: [{ delta: { content: '通道OK' } }] }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    });
  });
  try {
    const r = await streamChat({
      provider: { baseUrl: 'https://api.example.com/v1', apiKey: 'k' },
      model: 'm1',
      messages: [{ role: 'user', content: 'hi' }],
    });
    assert.equal(r.text, '通道OK');
    assert.equal(calls.length, 1);
    assert.ok(calls[0].url.startsWith('https://api.example.com/v1/chat/completions'));
    assert.equal(calls[0].init.method, 'POST');
  } finally {
    setFetch(null); // 恢复默认，避免污染其它用例
  }
});

test('setFetch(null) 恢复全局 fetch', async () => {
  setFetch(null);
  // 默认通道应指向全局 fetch（这里只验证引用关系，不发真请求）
  const original = globalThis.fetch;
  let used = 0;
  globalThis.fetch = async () => {
    used++;
    return new Response(JSON.stringify({ choices: [{ delta: { content: 'x' } }] }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    });
  };
  try {
    const r = await streamChat({
      provider: { baseUrl: 'http://127.0.0.1:9/v1' },
      model: 'm',
      messages: [{ role: 'user', content: 'hi' }],
    });
    assert.equal(r.text, 'x');
    assert.equal(used, 1, '应调用全局 fetch');
  } finally {
    globalThis.fetch = original;
  }
});
