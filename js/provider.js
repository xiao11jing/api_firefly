/**
 * provider.js — 统一适配层（纯逻辑，无 DOM 依赖）
 * 所有厂商归一为 OpenAI Chat Completions 兼容格式。
 */

/**
 * 可替换的请求通道：桌面版注入本地代理（tauri-plugin-http，Rust 侧发出、天然无 CORS），
 * 网页版与测试走全局 fetch。传入非函数则恢复默认。
 */
let fetchImpl = (input, init) => globalThis.fetch(input, init);

export function setFetch(fn) {
  fetchImpl = typeof fn === 'function' ? fn : (input, init) => globalThis.fetch(input, init);
}

/** 拼接 baseUrl 与路径，容忍两侧多余斜杠 */
export function joinUrl(base, path) {
  const b = String(base || '').trim().replace(/\/+$/, '');
  const p = String(path || '').trim().replace(/^\/+/, '');
  return `${b}/${p}`;
}

/**
 * 计算最终请求地址。
 * 可选代理语义：设置 proxyUrl 后，请求地址 = proxyUrl + 目标地址
 * （代理地址以 / 结尾则直接拼接，否则自动补一个 /）。
 * 若代理本身就是 OpenAI 兼容端点，直接把 baseUrl 指向它即可，无需填写代理。
 */
export function buildEndpoint(provider) {
  const target = joinUrl(provider.baseUrl, 'chat/completions');
  const proxy = String(provider.proxyUrl || '').trim();
  if (!proxy) return target;
  // 以 / 结尾则直接拼接，否则自动补一个 /
  return proxy.replace(/\/+$/, '') + '/' + target;
}

/** 构造请求头；无 key 时不携带 Authorization（兼容无需鉴权的本地端点） */
export function buildHeaders(provider) {
  const headers = { 'Content-Type': 'application/json' };
  const key = String(provider.apiKey || '').trim();
  if (key) headers['Authorization'] = `Bearer ${key}`;
  return headers;
}

/**
 * 文档片段 → 内嵌 prompt 的文本。
 * 前端已把文档文本提取出来，这里用显式标记包裹，便于模型区分正文与附件。
 */
export function filePartToText(part) {
  const name = String((part && part.name) || '未命名文档');
  const body = typeof part.text === 'string' ? part.text.trim() : '';
  const note = part.truncated ? '（文档过长，以下为截断后的内容）' : '';
  return `\n\n【附件文档：${name}】${note}\n${body || '（未能提取到文本内容）'}\n【附件文档结束】\n\n`;
}

/** 单个非图片片段 → 文本 */
function partToText(p) {
  if (p.type === 'file') return filePartToText(p);
  return p.text || '';
}

/**
 * 内部消息 → API 消息。
 * 内部格式：{ role, content: [{type:'text'|'image'|'file', ...}] }
 * 纯文本合并为字符串（最大化兼容只接受 string content 的实现）；
 * 含图片时使用多模态 content 数组（OpenAI vision 标准格式，支持多图）。
 */
export function toApiMessage(msg) {
  if (typeof msg.content === 'string') {
    return { role: msg.role, content: msg.content };
  }
  const parts = Array.isArray(msg.content) ? msg.content : [];
  const hasImage = parts.some((p) => p.type === 'image');
  if (!hasImage) {
    return { role: msg.role, content: parts.map(partToText).join('') };
  }
  const content = parts.map((p) => {
    if (p.type === 'image') {
      return { type: 'image_url', image_url: { url: p.dataUrl } };
    }
    return { type: 'text', text: partToText(p) };
  });
  return { role: msg.role, content };
}

/**
 * 构造请求体。
 * 流式请求额外带上 stream_options.include_usage，让服务端在流末尾回传 usage
 * （OpenAI 兼容格式的标准做法，缺失时前端按字符数估算）。
 */
export function buildChatBody({ model, messages, stream = true, includeUsage = false }) {
  const body = {
    model,
    messages: messages.map(toApiMessage),
    stream,
  };
  if (stream && includeUsage) body.stream_options = { include_usage: true };
  return body;
}

/** SSE 解析器：增量喂入文本块，产出事件 data 字符串数组 */
export class SSEParser {
  constructor() {
    this.buffer = '';
    this.done = false;
  }

  /** @returns {string[]} 本轮新增事件的 data（不含 [DONE]） */
  push(chunk) {
    this.buffer += chunk;
    const events = [];
    let sep;
    while ((sep = findSeparator(this.buffer)) !== -1) {
      const raw = this.buffer.slice(0, sep.index);
      this.buffer = this.buffer.slice(sep.index + sep.length);
      const data = extractEventData(raw);
      if (data === null) continue; // 纯注释/心跳事件
      if (data === '[DONE]') {
        this.done = true;
        continue;
      }
      events.push(data);
    }
    return events;
  }

  /** 流结束时调用：处理未以空行结尾的残余数据 */
  flush() {
    if (!this.buffer.trim()) return [];
    const data = extractEventData(this.buffer);
    this.buffer = '';
    if (data === null || data === '[DONE]') {
      if (data === '[DONE]') this.done = true;
      return [];
    }
    return [data];
  }
}

function findSeparator(buf) {
  const idx2 = buf.indexOf('\n\n');
  const idx4 = buf.indexOf('\r\n\r\n');
  if (idx2 === -1 && idx4 === -1) return -1;
  if (idx4 !== -1 && (idx2 === -1 || idx4 < idx2)) {
    return { index: idx4, length: 4 };
  }
  return { index: idx2, length: 2 };
}

/** 单个 SSE 事件文本 → data 内容；无 data 行返回 null */
function extractEventData(raw) {
  const lines = raw.split(/\r?\n/);
  const dataLines = [];
  for (const line of lines) {
    if (!line || line.startsWith(':')) continue; // 注释/心跳
    if (line.startsWith('data:')) {
      dataLines.push(line.slice(5).replace(/^ /, ''));
    }
    // event:/id:/retry: 行 MVP 阶段忽略
  }
  if (dataLines.length === 0) return null;
  return dataLines.join('\n');
}

/** 解析一条 data 负载，提取增量内容与结束标记 */
export function extractDelta(payload) {
  let json;
  try {
    json = JSON.parse(payload);
  } catch {
    throw new Error('服务端返回了无法解析的数据');
  }
  const choice = (json.choices && json.choices[0]) || {};
  const delta = choice.delta || choice.message || {};
  let text = '';
  if (typeof delta.content === 'string') {
    text = delta.content;
  } else if (Array.isArray(delta.content)) {
    text = delta.content
      .map((c) => (typeof c === 'string' ? c : c.text || ''))
      .join('');
  }
  return {
    text,
    finishReason: choice.finish_reason || null,
    usage: json.usage || null,
  };
}

/** 从非 2xx 响应中提取可读错误信息 */
export async function readApiError(resp) {
  let detail = '';
  try {
    const text = await resp.text();
    try {
      const json = JSON.parse(text);
      detail = (json.error && (json.error.message || json.error)) || json.message || text;
    } catch {
      detail = text;
    }
  } catch {
    detail = resp.statusText || '';
  }
  if (typeof detail !== 'string') detail = JSON.stringify(detail);
  detail = detail.trim();
  const hint = statusHint(resp.status);
  return `请求失败（HTTP ${resp.status}${hint ? '，' + hint : ''}）${detail ? '：' + detail : ''}`;
}

function statusHint(status) {
  switch (status) {
    case 401:
    case 403:
      return '请检查 API Key';
    case 404:
      return '请检查 Base URL 或模型名';
    case 429:
      return '触发限流或余额不足';
    default:
      return '';
  }
}

export class ChatApiError extends Error {
  constructor(message, status) {
    super(message);
    this.name = 'ChatApiError';
    this.status = status;
  }
}

/**
 * 发起流式对话请求。
 * @returns {Promise<{text:string, usage:object|null, aborted:boolean}>}
 */
export async function streamChat({
  provider,
  model,
  messages,
  signal,
  onDelta,
  onDone,
}) {
  const endpoint = buildEndpoint(provider);
  const headers = buildHeaders(provider);
  const body = buildChatBody({ model, messages, stream: true, includeUsage: true });

  let resp;
  try {
    resp = await fetchImpl(endpoint, {
      method: 'POST',
      headers,
      body: JSON.stringify(body),
      signal,
    });
  } catch (err) {
    if (err && err.name === 'AbortError') throw err;
    throw new ChatApiError(
      `网络请求失败：${err && err.message ? err.message : err}（可能是跨域限制或地址不可达，可尝试配置代理）`,
      0
    );
  }

  if (!resp.ok) {
    throw new ChatApiError(await readApiError(resp), resp.status);
  }

  const contentType = (resp.headers.get('content-type') || '').toLowerCase();
  if (!contentType.includes('text/event-stream')) {
    // 服务端忽略 stream 参数，一次性返回 JSON
    const text = await resp.text();
    const { text: content, usage } = extractDelta(text);
    if (onDelta) onDelta(content, content);
    if (onDone) onDone(content);
    return { text: content, usage, aborted: false };
  }

  const reader = resp.body.getReader();
  const decoder = new TextDecoder('utf-8');
  const parser = new SSEParser();
  let full = '';
  let usage = null;
  let aborted = false;

  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      const chunk = decoder.decode(value, { stream: true });
      for (const data of parser.push(chunk)) {
        const { text: delta, usage: u } = extractDelta(data);
        if (u) usage = u;
        if (!delta) continue;
        full += delta;
        if (onDelta) onDelta(delta, full);
      }
      if (parser.done) break;
    }
    // 收尾：处理残余（decoder flush + 未终结事件）
    const tail = decoder.decode();
    if (tail) parser.push(tail);
    for (const data of parser.flush()) {
      const { text: delta, usage: u } = extractDelta(data);
      if (u) usage = u;
      if (delta) {
        full += delta;
        if (onDelta) onDelta(delta, full);
      }
    }
  } catch (err) {
    if (err && err.name === 'AbortError') {
      aborted = true;
    } else {
      throw err;
    }
  } finally {
    try {
      reader.releaseLock();
    } catch {
      /* 忽略 */
    }
  }

  if (onDone) onDone(full);
  return { text: full, usage, aborted };
}
