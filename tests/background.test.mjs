import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  DEFAULT_BG_OPACITY,
  MAX_BG_OPACITY,
  MIN_BG_OPACITY,
  computeScale,
  isTooLargeForStorage,
  needsReencode,
  normalizeBgOpacity,
} from '../js/background.js';
import { defaultState, loadState, normalizeBackground, setBackground } from '../js/storage.js';

/** 一个最小的合法 PNG data URL */
const PNG = 'data:image/png;base64,iVBORw0KGgo=';

test('normalizeBgOpacity 收敛到合法区间', () => {
  assert.equal(normalizeBgOpacity(50), 50);
  assert.equal(normalizeBgOpacity('35'), 35);
  assert.equal(normalizeBgOpacity(52.6), 53);
  assert.equal(normalizeBgOpacity(0), MIN_BG_OPACITY);
  assert.equal(normalizeBgOpacity(999), MAX_BG_OPACITY);
  assert.equal(normalizeBgOpacity('abc'), DEFAULT_BG_OPACITY);
  assert.equal(normalizeBgOpacity(null), DEFAULT_BG_OPACITY);
  assert.equal(normalizeBgOpacity(''), DEFAULT_BG_OPACITY);
});

test('computeScale 只对超出最长边的图片等比缩放', () => {
  assert.deepEqual(computeScale(800, 600), { width: 800, height: 600, scaled: false });
  assert.deepEqual(computeScale(1920, 1080), { width: 1920, height: 1080, scaled: false });
  assert.deepEqual(computeScale(3840, 2160), { width: 1920, height: 1080, scaled: true });
  // 竖图按最长边（高）缩放
  assert.deepEqual(computeScale(1080, 3840), { width: 540, height: 1920, scaled: true });
  // 非常规比例仍保持等比
  assert.deepEqual(computeScale(4000, 100), { width: 1920, height: 48, scaled: true });
});

test('computeScale 对非法尺寸返回零值而不是崩溃', () => {
  assert.deepEqual(computeScale(0, 0), { width: 0, height: 0, scaled: false });
  assert.deepEqual(computeScale('x', 100), { width: 0, height: 0, scaled: false });
  assert.deepEqual(computeScale(undefined, undefined), { width: 0, height: 0, scaled: false });
});

test('isTooLargeForStorage 按字符数判断', () => {
  assert.equal(isTooLargeForStorage('a'.repeat(100), 100), false);
  assert.equal(isTooLargeForStorage('a'.repeat(101), 100), true);
  assert.equal(isTooLargeForStorage(null, 100), false);
});

test('needsReencode 覆盖缩放与超体积两种情形', () => {
  assert.equal(needsReencode({ scaled: false, dataUrl: 'x'.repeat(10), max: 100 }), false);
  assert.equal(needsReencode({ scaled: true, dataUrl: 'x'.repeat(10), max: 100 }), true);
  assert.equal(needsReencode({ scaled: false, dataUrl: 'x'.repeat(200), max: 100 }), true);
});

test('normalizeBackground 只接受本地图片的 base64 data URL', () => {
  assert.deepEqual(normalizeBackground({ dataUrl: PNG, opacity: 40 }), { dataUrl: PNG, opacity: 40 });
  assert.equal(normalizeBackground({ dataUrl: PNG }).opacity, DEFAULT_BG_OPACITY);
  // 外链、危险协议、非 base64 载荷、非图片类型一律拒绝
  assert.equal(normalizeBackground({ dataUrl: 'https://x/a.png', opacity: 40 }), null);
  assert.equal(normalizeBackground({ dataUrl: 'javascript:alert(1)' }), null);
  assert.equal(normalizeBackground({ dataUrl: 'data:image/png;base64,<script>' }), null);
  assert.equal(normalizeBackground({ dataUrl: 'data:text/html;base64,AAAA' }), null);
  assert.equal(normalizeBackground({ dataUrl: 'data:image/png;base64,iVBOR"onload="x' }), null);
  assert.equal(normalizeBackground(null), null);
  assert.equal(normalizeBackground('nope'), null);
  assert.equal(normalizeBackground({}), null);
});

test('setBackground 支持写入与清除，非法值视为清除', () => {
  const state = defaultState();
  setBackground(state, { dataUrl: PNG, opacity: 60 });
  assert.equal(state.settings.background.dataUrl, PNG);
  assert.equal(state.settings.background.opacity, 60);

  assert.equal(setBackground(state, null), null);
  assert.equal(state.settings.background, null);

  setBackground(state, { dataUrl: 'https://x/a.png' });
  assert.equal(state.settings.background, null);
});

test('背景配置随状态持久化并可还原', () => {
  const fake = (raw) => ({ getItem: () => (typeof raw === 'string' ? raw : JSON.stringify(raw)) });
  const loaded = loadState(
    fake({ version: 1, providers: [], sessions: [], settings: { background: { dataUrl: PNG, opacity: 12 } } })
  );
  assert.equal(loaded.settings.background.dataUrl, PNG);
  assert.equal(loaded.settings.background.opacity, 12);
});

test('存量脏数据里的外链背景在加载时被丢弃', () => {
  const fake = (raw) => ({ getItem: () => JSON.stringify(raw) });
  const dirty = loadState(fake({ version: 1, providers: [], sessions: [], settings: { background: { dataUrl: 'https://evil/a.png' } } }));
  assert.equal(dirty.settings.background, null);
  assert.equal(defaultState().settings.background, null);
});
