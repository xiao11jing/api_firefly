/**
 * usage.js — token 用量与费用估算（纯逻辑，无 DOM 依赖）
 *
 * 用量优先采用接口返回的 usage 字段（estimated=false）；
 * 接口未返回时按字符数粗略估算，并在展示层以 ≈ 标注（estimated=true）。
 * 单价优先取用户在服务配置里填写的价格，否则匹配内置参考价。
 */

/** 图片的粗略 token 计费量：按 OpenAI 高清档 1024×1024 的 765 tokens 近似 */
export const IMAGE_TOKEN_ESTIMATE = 765;

/**
 * 内置参考价（人民币 / 百万 token）。
 * 国内厂商取官方人民币刊例价；其余按 1 美元 ≈ 7.2 元折算。
 * 仅供估算，可能已过时，可在 API 服务设置里用自己填的单价覆盖。
 */
export const BUILTIN_PRICES = [
  { match: /gpt-4o-mini/i, input: 1.1, output: 4.3 },
  { match: /gpt-4o/i, input: 18, output: 72 },
  { match: /gpt-4\.1-mini/i, input: 2.9, output: 11.5 },
  { match: /gpt-4\.1/i, input: 14, output: 58 },
  { match: /gpt-4-turbo/i, input: 72, output: 216 },
  { match: /o[34]-mini/i, input: 8, output: 32 },
  { match: /claude-3-5-haiku|claude-haiku/i, input: 5.8, output: 29 },
  { match: /claude-3-haiku/i, input: 1.8, output: 9 },
  { match: /claude-3-5-sonnet|claude-3-7-sonnet|claude-sonnet/i, input: 22, output: 108 },
  { match: /claude-3-opus/i, input: 108, output: 540 },
  { match: /claude-opus/i, input: 108, output: 540 },
  { match: /deepseek-reasoner|deepseek-r1/i, input: 4, output: 16 },
  { match: /deepseek/i, input: 2, output: 8 },
  { match: /gemini-2\.5-flash/i, input: 2.2, output: 18 },
  { match: /gemini-2\.0-flash/i, input: 0.7, output: 2.9 },
  { match: /gemini-1\.5-flash/i, input: 0.5, output: 2.2 },
  { match: /gemini-2\.5-pro/i, input: 9, output: 72 },
  { match: /gemini-1\.5-pro/i, input: 9, output: 36 },
  { match: /qwen-max/i, input: 12, output: 48 },
  { match: /qwen/i, input: 2.9, output: 8.6 },
  { match: /moonshot|kimi/i, input: 4.3, output: 18 },
  { match: /glm-4/i, input: 4.3, output: 4.3 },
];

/** 内置上下文窗口兜底值（token） */
export const DEFAULT_CONTEXT_WINDOW = 128000;

/**
 * 内置上下文窗口参考值（token）。同样按「最具体在前」排列，
 * 只用于界面上的占用比例提示，可在 API 服务设置里手动覆盖。
 */
export const BUILTIN_CONTEXT_WINDOWS = [
  { match: /gemini-[12]\.5-pro|gemini-1\.5-pro/i, tokens: 2000000 },
  { match: /gemini/i, tokens: 1000000 },
  { match: /claude/i, tokens: 200000 },
  { match: /gpt-3\.5/i, tokens: 16385 },
  { match: /gpt-4o|gpt-4\.1|gpt-4-turbo|o[34]/i, tokens: 128000 },
  { match: /deepseek/i, tokens: 64000 },
  { match: /qwen|moonshot|kimi|glm-4/i, tokens: 128000 },
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

/**
 * 解析某模型适用的上下文窗口上限。
 * 服务里手填的优先，其次内置参考表，最后用兜底默认值。
 * @returns {{tokens:number, source:'provider'|'builtin'|'default'}}
 */
export function resolveContextWindow(provider, model) {
  const custom = numOrNull(provider && provider.contextLength);
  if (custom !== null && custom > 0) return { tokens: Math.round(custom), source: 'provider' };
  const name = String(model || '');
  const hit = BUILTIN_CONTEXT_WINDOWS.find((entry) => entry.match.test(name));
  return hit
    ? { tokens: hit.tokens, source: 'builtin' }
    : { tokens: DEFAULT_CONTEXT_WINDOW, source: 'default' };
}

/** 上下文占用比例（0~1）；上限非法或缺失时返回 0 */
export function contextRatio(tokens, limit) {
  const t = Math.max(0, numOrNull(tokens) ?? 0);
  const l = numOrNull(limit) ?? 0;
  if (l <= 0) return 0;
  return Math.min(1, t / l);
}

/** 按用量与单价计算费用（人民币），单价单位为「每百万 token」 */
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

/** 费用展示（人民币）：小额给足精度，避免显示成一串 0 */
export function formatCost(cny) {
  const v = numOrNull(cny) ?? 0;
  if (v <= 0) return '¥0';
  if (v < 0.0001) return '<¥0.0001';
  if (v < 1) return `¥${v.toFixed(4)}`;
  if (v < 100) return `¥${v.toFixed(2)}`;
  return `¥${Math.round(v)}`;
}
