/**
 * mock-server.mjs — 本地模拟 OpenAI 兼容 API，用于端到端测试
 * 启动：npm run mock  （监听 http://127.0.0.1:8717）
 * 端点：POST /v1/chat/completions（支持 stream / 非 stream / 故意报错）
 *       GET  /last-request（返回最近一次收到的请求体，供端到端校验报文）
 *       GET  /health（返回 MOCK_VERSION，供端到端识别陈旧的常驻进程）
 */
import http from 'node:http';

/** 改动 mock 行为时递增，E2E 会据此提示「需要重启 mock 服务」 */
export const MOCK_VERSION = '3';

const PORT = Number(process.env.MOCK_PORT || 8717);

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization',
};

const SAMPLE_TAIL = [
  '这是一段 **流式** 回复，用于验证端到端链路。\n\n',
  '```js\nconst sum = (a, b) => a + b;\nconsole.log(sum(1, 2));\n```\n\n',
  '- 第一点\n- 第二点\n\n',
  '最后一段 `inline code` 与 [链接](https://example.com)。',
];

/** 样例回复里带上模型名，便于端到端区分不同分支 */
function sampleFor(model) {
  return [`# 模拟回复 (${model})\n\n`, ...SAMPLE_TAIL];
}

/** 回传的用量：固定值，便于前端断言 */
const MOCK_USAGE = { prompt_tokens: 42, completion_tokens: 108, total_tokens: 150 };

/** 模型名含 nousage 时故意不回传 usage，用于验证前端的估算兜底 */
function sendsUsage(model) {
  return !/nousage/i.test(String(model || ''));
}

/** 用户消息要求生成计划时，回复一个 ```plan 块，供前端解析（Learn 模式） */
const PLAN_CUE = /(?:生成|制定|做一份|来一?个|出一?份).{0,6}计划|学习计划/;
function planSample() {
  return [
    '好的，根据你的状态我整理了这份计划：\n\n',
    '```plan\n',
    '[{"title": "理解 Self-Attention 的动机", "note": "先看直觉图"}, {"title": "手写一遍 QKV 计算", "note": ""}, {"title": "做 3 道注意力机制练习", "note": ""}]\n',
    '```\n\n',
    '先从第一条开始，有不清楚的随时打断我。',
  ];
}

function replyFor(parsed) {
  const wantsPlan = (parsed.messages || []).some(
    (m) => m.role === 'user' && typeof m.content === 'string' && PLAN_CUE.test(m.content)
  );
  if (wantsPlan) return planSample();
  return sampleFor(parsed.model);
}

function sseEvent(delta, finish = null) {
  return `data: ${JSON.stringify({
    id: 'chatcmpl-mock',
    object: 'chat.completion.chunk',
    choices: [{ index: 0, delta, finish_reason: finish }],
  })}\n\n`;
}

function sseUsageEvent(usage) {
  return `data: ${JSON.stringify({
    id: 'chatcmpl-mock',
    object: 'chat.completion.chunk',
    choices: [],
    usage,
  })}\n\n`;
}

export function createMockServer() {
  let lastRequest = null;

  return http.createServer((req, res) => {
  if (req.method === 'GET' && req.url.includes('/health')) {
    res.writeHead(200, { ...CORS, 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ ok: true, version: MOCK_VERSION }));
    return;
  }

  // 回看最近一次收到的请求体，便于端到端断言真实发出的报文
  if (req.method === 'GET' && req.url.includes('/last-request')) {
    res.writeHead(200, { ...CORS, 'Content-Type': 'application/json' });
    res.end(JSON.stringify(lastRequest));
    return;
  }

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
    lastRequest = parsed;

    const auth = req.headers.authorization || '';
    if (auth === 'Bearer bad-key') {
      res.writeHead(401, { ...CORS, 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: { message: 'Invalid API key (mock)' } }));
      return;
    }

    if (parsed.stream) {
      const sample = replyFor(parsed);
      res.writeHead(200, {
        ...CORS,
        'Content-Type': 'text/event-stream; charset=utf-8',
        'Cache-Control': 'no-cache',
      });
      res.write(sseEvent({ role: 'assistant', content: '' }));
      for (const piece of sample) {
        // 按字符切分，模拟真实 token 流
        for (const ch of piece) {
          res.write(sseEvent({ content: ch }));
          await new Promise((r) => setTimeout(r, 4));
        }
      }
      res.write(sseEvent({}, 'stop'));
      if (sendsUsage(parsed.model)) res.write(sseUsageEvent(MOCK_USAGE));
      res.write('data: [DONE]\n\n');
      res.end();
      return;
    }

    const text = replyFor(parsed).join('');
    res.writeHead(200, { ...CORS, 'Content-Type': 'application/json' });
    res.end(
      JSON.stringify({
        id: 'chatcmpl-mock',
        object: 'chat.completion',
        choices: [{ index: 0, message: { role: 'assistant', content: text }, finish_reason: 'stop' }],
        ...(sendsUsage(parsed.model) ? { usage: MOCK_USAGE } : {}),
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
