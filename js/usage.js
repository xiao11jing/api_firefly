/**
 * usage.js — token 用量与费用估算（纯逻辑，无 DOM 依赖）
 *
 * 用量优先采用接口返回的 usage 字段（estimated=false）；
 * 接口未返回时按字符数粗略估算，并在展示层以 ≈ 标注（estimated=true）。
 * 单价优先取用户在服务配置里填写的价格，否则匹配内置参考价。
 */

/** 图片的粗略 token 计费量：按 OpenAI 高清档 1024×1024 的 765 tokens 近似 */
export const IMAGE_TOKEN_ESTIMATE = 765;

/** 内置参考价（美元 / 百万 token）。取自各厂商公开定价，仅供估算，可在服务设置中覆盖。 */
export const BUILTIN_PRICES = [
  { match: /gpt-4o-mini/i, input: 0.15, output: 0.6 },
  { match: /gpt-4o/i, input: 2.5, output: 10 },
  { match: /gpt-4\.1-mini/i, input: 0.4, output: 1.6 },
  { match: /gpt-4\.1/i, input: 2, output: 8 },
  { match: /gpt-4-turbo/i, input: 10, output: 30 },
  { match: /o[34]-mini/i, input: 1.1, output: 4.4 },
  { match: /claude-3-5-haiku|claude-haiku/i, input: 0.8, output: 4 },
  { match: /claude-3-haiku/i, input: 0.25, output: 1.25 },
  { match: /claude-3-5-sonnet|claude-3-7-sonnet|claude-sonnet/i, input: 3, output: 15 },
  { match: /claude-3-opus/i, input: 15, output: 75 },
  { match: /claude-opus/i, input: 15, output: 75 },
  { match: /deepseek-reasoner|deepseek-r1/i, input: 0.55, output: 2.19 },
  { match: /deepseek/i, input: 0.27, output: 1.1 },
  { match: /gemini-2\.5-flash/i, input: 0.3, output: 2.5 },
  { match: /gemini-2\.0-flash/i, input: 0.1, output: 0.4 },
  { match: /gemini-1\.5-flash/i, input: 0.075, output: 0.3 },
  { match: /gemini-2\.5-pro/i, input: 1.25, output: 10 },
  { match: /gemini-1\.5-pro/i, input: 1.25, output: 5 },
  { match: /qwen-max/i, input: 1.6, output: 6.4 },
  { match: /qwen/i, input: 0.4, output: 1.2 },
  { match: /moonshot|kimi/i, input: 0.6, output: 2.5 },
  { match: /glm-4/i, input: 0.6, output: 0.6 },
];

/** 数值化；空值与非法值一律返回 null（0 视为合法） */
export function numOrNull(value) {
  if (value === null || value === undefined || value === '') return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

/** 全宽字符（中日韩文字与标点、假名、谚文等）按 1 token 计 */
function isFullWidth(codePoint) {
  return (
    (codePoint >= 0x3000 && codePoint <= 0x303f) ||
    (codePoint >= 0x3040 && codePoint <= 0x30ff) ||
    (codePoint >= 0x3400 && codePoint <= 0x4dbf) ||
    (codePoint >= 0x4e00 && codePoint <= 0x9fff) ||
    (codePoint >= 0xac00 && codePoint <= 0xd7af) ||
    (codePoint >= 0xf900 && codePoint <= 0xfaff) ||
    (codePoint >= 0xff00 && codePoint <= 0xffef)
  );
}

/**
 * 粗略估算 token 数：全宽字符 1 token/字，其余约 4 字符/token。
 * 仅用于接口未返回 usage 时的兜底展示。
 */
export function estimateTokens(text) {
  const s = String(text === null || text === undefined ? '' : text);
  if (!s) return 0;
  let wide = 0;
  let narrow = 0;
  for (const ch of s) {
    if (isFullWidth(ch.codePointAt(0))) wide += 1;
    else narrow += 1;
  }
  return wide + Math.ceil(narrow / 4);
}

/**
 * 估算「实际发出的报文」的提示 token。
 * 入参为 provider.toApiMessage 产出的 API 消息（content 可能是字符串或片段数组）。
 */
export function estimateApiTokens(messages) {
  let total = 0;
  for (const m of Array.isArray(messages) ? messages : []) {
    if (!m) continue;
    if (typeof m.content === 'string') {
      total += estimateTokens(m.content);
      continue;
    }
    for (const part of Array.isArray(m.content) ? m.content : []) {
      if (!part) continue;
      if (part.type === 'image_url') total += IMAGE_TOKEN_ESTIMATE;
      else total += estimateTokens(part.text);
    }
  }
  return total;
}

/** 接口返回的 usage → 记录用结构；缺失时回退到估算值 */
export function usageToRecord(apiUsage, fallback = {}) {
  const p = numOrNull(apiUsage && (apiUsage.prompt_tokens ?? apiUsage.promptTokens));
  const c = numOrNull(apiUsage && (apiUsage.completion_tokens ?? apiUsage.completionTokens));
  const t = numOrNull(apiUsage && (apiUsage.total_tokens ?? apiUsage.totalTokens));
  if (p !== null || c !== null || t !== null) {
    const promptTokens = p ?? 0;
    const completionTokens = c ?? 0;
    return {
      promptTokens,
      completionTokens,
      totalTokens: t ?? promptTokens + completionTokens,
      estimated: false,
    };
  }
  const promptTokens = numOrNull(fallback.promptTokens) ?? 0;
  const completionTokens = numOrNull(fallback.completionTokens) ?? 0;
  return { promptTokens, completionTokens, totalTokens: promptTokens + completionTokens, estimated: true };
}

/** 校验并归一化持久化的用量字段；非法返回 null */
export function normalizeUsage(usage) {
  if (!usage || typeof usage !== 'object') return null;
  const p = numOrNull(usage.promptTokens);
  const c = numOrNull(usage.completionTokens);
  const t = numOrNull(usage.totalTokens);
  if (p === null && c === null && t === null) return null;
  const promptTokens = p ?? 0;
  const completionTokens = c ?? 0;
  return {
    promptTokens,
    completionTokens,
    totalTokens: t ?? promptTokens + completionTokens,
    estimated: !!usage.estimated,
  };
}

/** 单价是否可用（必须成对出现且非负） */
export function isPrice(price) {
  if (!price || typeof price !== 'object') return false;
  const i = numOrNull(price.input);
  const o = numOrNull(price.output);
  return i !== null && o !== null && i >= 0 && o >= 0;
}

/**
 * 解析某模型适用的单价。
 * @returns {{input:number, output:number, source:'provider'|'builtin'}|null}
 */
export function resolvePrice(provider, model) {
  const custom = provider && provider.price;
  if (isPrice(custom)) {
    return { input: Number(custom.input), output: Number(custom.output), source: 'provider' };
  }
  const name = String(model || '');
  const hit = BUILTIN_PRICES.find((entry) => entry.match.test(name));
  return hit ? { input: hit.input, output: hit.output, source: 'builtin' } : null;
}

/** 按用量与单价计算费用（美元），单价单位为「每百万 token」 */
export function computeCost(usage, price) {
  const promptTokens = numOrNull(usage && usage.promptTokens) ?? 0;
  const completionTokens = numOrNull(usage && usage.completionTokens) ?? 0;
  const inputRate = numOrNull(price && price.input) ?? 0;
  const outputRate = numOrNull(price && price.output) ?? 0;
  const input = (promptTokens / 1e6) * inputRate;
  const output = (completionTokens / 1e6) * outputRate;
  return { input, output, total: input + output };
}

/** 数量展示：1000 以下原样，之后用 k 缩写 */
export function formatTokens(n) {
  const v = numOrNull(n) ?? 0;
  if (v < 1000) return String(Math.round(v));
  if (v < 100000) return `${(v / 1000).toFixed(1)}k`;
  return `${Math.round(v / 1000)}k`;
}

/** 费用展示：小额给足精度，避免显示成一串 0 */
export function formatCost(usd) {
  const v = numOrNull(usd) ?? 0;
  if (v <= 0) return '$0';
  if (v < 0.0001) return '<$0.0001';
  if (v < 1) return `$${v.toFixed(4)}`;
  if (v < 100) return `$${v.toFixed(2)}`;
  return `$${Math.round(v)}`;
}
