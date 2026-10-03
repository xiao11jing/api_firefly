import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  IMAGE_TOKEN_ESTIMATE,
  computeCost,
  estimateApiTokens,
  estimateTokens,
  formatCost,
  formatTokens,
  isPrice,
  normalizeUsage,
  numOrNull,
  resolvePrice,
  usageToRecord,
} from '../js/usage.js';

test('numOrNull 区分 0 与空值', () => {
  assert.equal(numOrNull(0), 0);
  assert.equal(numOrNull('0'), 0);
  assert.equal(numOrNull(12.5), 12.5);
  assert.equal(numOrNull(''), null);
  assert.equal(numOrNull(null), null);
  assert.equal(numOrNull(undefined), null);
  assert.equal(numOrNull('abc'), null);
  assert.equal(numOrNull(Infinity), null);
});

test('estimateTokens 中文按字计、英文按四字符计', () => {
  assert.equal(estimateTokens('你好世界'), 4);
  assert.equal(estimateTokens('hello'), 2);
  assert.equal(estimateTokens(''), 0);
  assert.equal(estimateTokens(null), 0);
  // 中英混排：2 宽字 + 4 窄字符
  assert.equal(estimateTokens('中文abcd'), 2 + 1);
  // 全宽标点也按宽字计
  assert.equal(estimateTokens('，。'), 2);
});

test('estimateApiTokens 按报文形态统计并计入图片常量', () => {
  const total = estimateApiTokens([
    { role: 'system', content: 'hello' },
    { role: 'user', content: '你好' },
    {
      role: 'user',
      content: [
        { type: 'text', text: '看图' },
        { type: 'image_url', image_url: { url: 'data:image/png;base64,AAAA' } },
      ],
    },
  ]);
  assert.equal(total, 2 + 2 + 2 + IMAGE_TOKEN_ESTIMATE);
  assert.equal(estimateApiTokens(null), 0);
});

test('usageToRecord 优先采用接口返回的用量', () => {
  const r = usageToRecord({ prompt_tokens: 42, completion_tokens: 108, total_tokens: 150 });
  assert.deepEqual(r, { promptTokens: 42, completionTokens: 108, totalTokens: 150, estimated: false });
  // 驼峰命名同样支持
  const camel = usageToRecord({ promptTokens: 5, completionTokens: 7 });
  assert.equal(camel.totalTokens, 12);
  assert.equal(camel.estimated, false);
});

test('usageToRecord 缺字段时补齐并回退估算', () => {
  const partial = usageToRecord({ prompt_tokens: 10 });
  assert.deepEqual(partial, { promptTokens: 10, completionTokens: 0, totalTokens: 10, estimated: false });

  const estimated = usageToRecord(null, { promptTokens: 100, completionTokens: 20 });
  assert.deepEqual(estimated, { promptTokens: 100, completionTokens: 20, totalTokens: 120, estimated: true });

  const empty = usageToRecord(undefined);
  assert.deepEqual(empty, { promptTokens: 0, completionTokens: 0, totalTokens: 0, estimated: true });
});

test('normalizeUsage 丢弃非法数据', () => {
  assert.equal(normalizeUsage(null), null);
  assert.equal(normalizeUsage({}), null);
  assert.equal(normalizeUsage({ promptTokens: 'x' }), null);
  assert.deepEqual(normalizeUsage({ promptTokens: 3, completionTokens: 4, estimated: 1 }), {
    promptTokens: 3,
    completionTokens: 4,
    totalTokens: 7,
    estimated: true,
  });
});

test('isPrice 要求成对且非负', () => {
  assert.equal(isPrice({ input: 1, output: 2 }), true);
  assert.equal(isPrice({ input: 0, output: 0 }), true);
  assert.equal(isPrice({ input: 1 }), false);
  assert.equal(isPrice({ input: 1, output: -1 }), false);
  assert.equal(isPrice({ input: null, output: 2 }), false);
  assert.equal(isPrice(null), false);
});

test('resolvePrice 优先用户配置，其次内置参考价', () => {
  const custom = resolvePrice({ price: { input: 1, output: 3 } }, 'gpt-4o');
  assert.deepEqual(custom, { input: 1, output: 3, source: 'provider' });

  const builtin = resolvePrice({ price: null }, 'gpt-4o-mini');
  assert.equal(builtin.source, 'builtin');
  assert.equal(builtin.input, 0.15);

  assert.equal(resolvePrice({}, 'unknown-model-xyz'), null);
  assert.equal(resolvePrice(null, null), null);
});

test('resolvePrice 内置表按最长特征匹配', () => {
  // mini 应命中 mini 档，而不是 4o 档
  assert.equal(resolvePrice({}, 'gpt-4o-mini').output, 0.6);
  assert.equal(resolvePrice({}, 'gpt-4o').output, 10);
  assert.equal(resolvePrice({}, 'deepseek-reasoner').output, 2.19);
  assert.equal(resolvePrice({}, 'deepseek-chat').output, 1.1);
  assert.equal(resolvePrice({}, 'claude-3-5-haiku-20241022').input, 0.8);
  assert.equal(resolvePrice({}, 'claude-3-5-sonnet-20241022').input, 3);
});

test('computeCost 按每百万 token 换算', () => {
  const cost = computeCost({ promptTokens: 1e6, completionTokens: 1e6 }, { input: 2.5, output: 10 });
  assert.equal(cost.input, 2.5);
  assert.equal(cost.output, 10);
  assert.equal(cost.total, 12.5);

  const small = computeCost({ promptTokens: 1000, completionTokens: 500 }, { input: 3, output: 15 });
  assert.equal(small.total, 0.003 + 0.0075);
  assert.equal(computeCost(null, null).total, 0);
});

test('formatTokens 缩写与边界', () => {
  assert.equal(formatTokens(0), '0');
  assert.equal(formatTokens(999), '999');
  assert.equal(formatTokens(1200), '1.2k');
  assert.equal(formatTokens(99999), '100.0k');
  assert.equal(formatTokens(123456), '123k');
});

test('formatCost 小额给出足够精度', () => {
  assert.equal(formatCost(0), '$0');
  assert.equal(formatCost(0.00001), '<$0.0001');
  assert.equal(formatCost(0.00123), '$0.0012');
  assert.equal(formatCost(0.5), '$0.5000');
  assert.equal(formatCost(1.234), '$1.23');
  assert.equal(formatCost(123.4), '$123');
});
