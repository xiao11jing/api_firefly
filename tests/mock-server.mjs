/**
 * mock-server.mjs — 本地模拟 OpenAI 兼容 API，用于端到端测试
 * 启动：npm run mock  （监听 http://127.0.0.1:8717）
 * 端点：POST /v1/chat/completions（支持 stream / 非 stream / 故意报错）
 */
import http from 'node:http';

const PORT = Number(process.env.MOCK_PORT || 8717);

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization',
};

const SAMPLE = [
  '# 模拟回复\n\n',
  '这是一段 **流式** 回复，用于验证端到端链路。\n\n',
  '```js\nconst sum = (a, b) => a + b;\nconsole.log(sum(1, 2));\n```\n\n',
  '- 第一点\n- 第二点\n\n',
  '最后一段 `inline code` 与 [链接](https://example.com)。',
];

function sseEvent(delta, finish = null) {
  return `data: ${JSON.stringify({
    id: 'chatcmpl-mock',
    object: 'chat.completion.chunk',
    choices: [{ index: 0, delta, finish_reason: finish }],
  })}\n\n`;
}

export function createMockServer() {
  return http.createServer((req, res) => {
  if (req.method === 'OPTIONS') {
    res.writeHead(204, CORS);
    res.end();
    return;
  }

  if (req.method !== 'POST' || !req.url.includes('/chat/completions')) {
    res.writeHead(404, { ...CORS, 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: { message: 'not found' } }));
    return;
  }

  let body = '';
  req.on('data', (c) => (body += c));
  req.on('end', async () => {
    let parsed;
    try {
      parsed = JSON.parse(body);
    } catch {
      res.writeHead(400, { ...CORS, 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: { message: 'invalid json' } }));
      return;
    }

    const auth = req.headers.authorization || '';
    if (auth === 'Bearer bad-key') {
      res.writeHead(401, { ...CORS, 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: { message: 'Invalid API key (mock)' } }));
      return;
    }

    if (parsed.stream) {
      res.writeHead(200, {
        ...CORS,
        'Content-Type': 'text/event-stream; charset=utf-8',
        'Cache-Control': 'no-cache',
      });
      res.write(sseEvent({ role: 'assistant', content: '' }));
      for (const piece of SAMPLE) {
        // 按字符切分，模拟真实 token 流
        for (const ch of piece) {
          res.write(sseEvent({ content: ch }));
          await new Promise((r) => setTimeout(r, 4));
        }
      }
      res.write(sseEvent({}, 'stop'));
      res.write('data: [DONE]\n\n');
      res.end();
      return;
    }

    const text = SAMPLE.join('');
    res.writeHead(200, { ...CORS, 'Content-Type': 'application/json' });
    res.end(
      JSON.stringify({
        id: 'chatcmpl-mock',
        object: 'chat.completion',
        choices: [{ index: 0, message: { role: 'assistant', content: text }, finish_reason: 'stop' }],
        usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
      })
    );
  });
  });
}

const isDirectRun = process.argv[1] && import.meta.url === new URL(`file:///${process.argv[1].replace(/\\/g, '/')}`).href;
if (isDirectRun) {
  const server = createMockServer();
  server.listen(PORT, '127.0.0.1', () => {
    console.log(`mock server ready: http://127.0.0.1:${PORT}/v1/chat/completions`);
  });
}
