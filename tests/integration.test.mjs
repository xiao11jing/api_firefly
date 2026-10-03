import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createMockServer } from './mock-server.mjs';
import { streamChat, buildEndpoint, ChatApiError } from '../js/provider.js';

let server;
let baseUrl;

before(async () => {
  server = createMockServer();
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address();
  baseUrl = `http://127.0.0.1:${port}/v1`;
});

after(() => server.close());

test('streamChat 端到端：SSE 流式拼出完整回复', async () => {
  const chunks = [];
  const result = await streamChat({
    provider: { baseUrl, apiKey: 'ok' },
    model: 'mock-model',
    messages: [{ role: 'user', content: [{ type: 'text', text: 'hi' }] }],
    onDelta: (delta, full) => chunks.push(delta),
  });
  assert.ok(result.text.includes('# 模拟回复'));
  assert.ok(result.text.includes('```js'));
  assert.ok(result.text.includes('- 第一点'));
  assert.equal(result.aborted, false);
  // 增量拼接与全文一致
  assert.equal(chunks.join(''), result.text);
  // 多次增量（流式确实分片）
  assert.ok(chunks.length > 10);
});

test('streamChat 端到端：错误 key 返回友好错误', async () => {
  await assert.rejects(
    streamChat({
      provider: { baseUrl, apiKey: 'bad-key' },
      model: 'mock-model',
      messages: [{ role: 'user', content: [{ type: 'text', text: 'hi' }] }],
    }),
    (err) => {
      assert.ok(err instanceof ChatApiError);
      assert.equal(err.status, 401);
      assert.match(err.message, /Invalid API key/);
      assert.match(err.message, /API Key/);
      return true;
    }
  );
});

test('streamChat 端到端：网络不可达给出可读错误', async () => {
  await assert.rejects(
    streamChat({
      provider: { baseUrl: 'http://127.0.0.1:1/v1', apiKey: '' },
      model: 'm',
      messages: [],
    }),
    (err) => {
      assert.match(err.message, /网络请求失败/);
      return true;
    }
  );
});

test('streamChat 端到端：流式响应也能拿到 usage', async () => {
  const result = await streamChat({
    provider: { baseUrl, apiKey: 'ok' },
    model: 'mock-model',
    messages: [{ role: 'user', content: [{ type: 'text', text: 'hi' }] }],
  });
  assert.deepEqual(result.usage, { prompt_tokens: 42, completion_tokens: 108, total_tokens: 150 });
  assert.ok(result.text.includes('# 模拟回复 (mock-model)'));
});

test('streamChat 端到端：请求带 stream_options，服务端不回 usage 时为 null', async () => {
  const result = await streamChat({
    provider: { baseUrl, apiKey: 'ok' },
    model: 'mock-nousage',
    messages: [{ role: 'user', content: [{ type: 'text', text: 'hi' }] }],
  });
  assert.equal(result.usage, null);
  const last = await fetch(baseUrl.replace(/\/v1$/, '') + '/last-request').then((r) => r.json());
  assert.deepEqual(last.stream_options, { include_usage: true });
});

test('buildEndpoint 与 mock 实际地址一致', () => {
  assert.equal(buildEndpoint({ baseUrl }), `${baseUrl}/chat/completions`);
});

test('mock server 记录最近一次请求，便于端到端校验报文', async () => {
  await streamChat({
    provider: { baseUrl, apiKey: 'ok' },
    model: 'mock-model',
    messages: [
      {
        role: 'user',
        content: [
          { type: 'text', text: '看下附件' },
          { type: 'image', dataUrl: 'data:image/png;base64,AAA', name: 'a.png' },
          { type: 'file', name: 'note.md', text: '正文内容' },
        ],
      },
    ],
  });

  const resp = await fetch(baseUrl.replace(/\/v1$/, '') + '/last-request');
  assert.equal(resp.status, 200);
  const body = await resp.json();
  assert.equal(body.stream, true);
  assert.equal(body.model, 'mock-model');
  const content = body.messages[0].content;
  assert.ok(Array.isArray(content));
  assert.equal(content[0].text, '看下附件');
  assert.equal(content[1].type, 'image_url');
  assert.equal(content[1].image_url.url, 'data:image/png;base64,AAA');
  assert.match(content[2].text, /【附件文档：note\.md】/);
  assert.match(content[2].text, /正文内容/);
});
