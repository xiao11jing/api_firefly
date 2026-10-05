import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  DEFAULT_PET_SCALE,
  PET_SCALE_MAX,
  PET_SCALE_MIN,
  PET_Z_NORMAL,
  PET_Z_TOPMOST,
  normalizePet,
  normalizePetScale,
  petStylePosition,
  petZIndex,
  ratioFromVisual,
} from '../js/pet.js';
import { defaultState, loadState, setPet } from '../js/storage.js';

const viewport = { width: 1440, height: 900 };

// ---------- 缩放归一化 ----------

test('normalizePetScale 收敛到 0.5~2.0 并按 0.1 步进取整', () => {
  assert.equal(normalizePetScale(1), 1);
  assert.equal(normalizePetScale(1.5), 1.5);
  assert.equal(normalizePetScale(0.5), PET_SCALE_MIN);
  assert.equal(normalizePetScale(2), PET_SCALE_MAX);
  assert.equal(normalizePetScale(0.1), 0.5); // 低于下限收敛
  assert.equal(normalizePetScale(9), 2); // 高于上限收敛
  assert.equal(normalizePetScale(1.28), 1.3);
  assert.equal(normalizePetScale('abc'), DEFAULT_PET_SCALE);
  assert.equal(normalizePetScale(null), DEFAULT_PET_SCALE);
  assert.equal(normalizePetScale(undefined), DEFAULT_PET_SCALE);
});

// ---------- 配置归一化 ----------

test('normalizePet 缺省字段回退默认', () => {
  const pet = normalizePet(null);
  assert.deepEqual(pet, { visible: false, topmost: false, scale: 1, position: null });
  assert.deepEqual(normalizePet('x'), normalizePet(null));
});

test('normalizePet：position 为 null 不会被误判成左上角（Number(null)===0 回归）', () => {
  assert.equal(normalizePet({ position: null }).position, null);
  assert.equal(normalizePet({ position: {} }).position, null);
  assert.equal(normalizePet({ position: { x: 'a', y: 0 } }).position, null);
  // 越界的合法数字收敛为 null（未拖动语义由 clamp 后的比例保证）
  assert.equal(normalizePet({ position: { x: 1.2, y: 0.5 } }).position, null);
  const p = normalizePet({ position: { x: 0.25, y: 0.75 } }).position;
  assert.deepEqual(p, { x: 0.25, y: 0.75 });
});

test('normalizePet 只认布尔开关', () => {
  const pet = normalizePet({ visible: 'yes', topmost: 1 });
  assert.equal(pet.visible, false);
  assert.equal(pet.topmost, false);
  const on = normalizePet({ visible: true, topmost: true });
  assert.equal(on.visible, true);
  assert.equal(on.topmost, true);
});

// ---------- 层级 ----------

test('petZIndex 置顶/普通取值', () => {
  assert.equal(petZIndex(true), PET_Z_TOPMOST);
  assert.equal(petZIndex(false), PET_Z_NORMAL);
  assert.equal(petZIndex(undefined), PET_Z_NORMAL);
  assert.ok(PET_Z_TOPMOST > 90 && PET_Z_TOPMOST < 2000); // 盖过提示条、低于开屏
  assert.ok(PET_Z_NORMAL < 60); // 普通时被设置弹层盖住
});

// ---------- 位置换算 ----------

test('petStylePosition 未拖动时落在右下角', () => {
  const { left, top } = petStylePosition(null, viewport, 1, { width: 571, height: 420 });
  assert.equal(left, 1440 - 571 - 24);
  assert.equal(top, 900 - 420 - 24);
});

test('petStylePosition 按归一化比例定位并除以 zoom', () => {
  // ratio 是元素左上角的视口比例（与拖动时存 rect.left 的语义一致）
  const { left, top } = petStylePosition({ x: 0.5, y: 0.5 }, viewport, 1, { width: 100, height: 100 });
  assert.equal(left, 720);
  assert.equal(top, 450);
  const zoomed = petStylePosition({ x: 0.5, y: 0.5 }, viewport, 1.6, { width: 100, height: 100 });
  assert.equal(zoomed.left, 720 / 1.6);
  assert.equal(zoomed.top, 450 / 1.6);
});

test('petStylePosition 把越界位置夹回可视区', () => {
  // 比例为 1 时元素左上角贴右边界 → 夹到 vw-48
  const { left, top } = petStylePosition({ x: 1, y: 1 }, viewport, 1, { width: 200, height: 200 });
  assert.equal(left, 1440 - 48);
  assert.equal(top, 900 - 48);
  // 负比例被夹到 48-w（保证至少 48px 可抓）
  const neg = petStylePosition({ x: -1, y: -1 }, viewport, 1, { width: 200, height: 200 });
  assert.equal(neg.left, 48 - 200);
  assert.equal(neg.top, 48 - 200);
});

test('ratioFromVisual clamp 到 0~1', () => {
  assert.deepEqual(ratioFromVisual(720, 450, viewport), { x: 0.5, y: 0.5 });
  assert.deepEqual(ratioFromVisual(-50, -10, viewport), { x: 0, y: 0 });
  assert.deepEqual(ratioFromVisual(99999, 99999, viewport), { x: 1, y: 1 });
});

// ---------- storage 集成 ----------

test('setPet 合并 patch 并保留其他设置项', () => {
  const state = defaultState();
  setPet(state, { visible: true });
  setPet(state, { scale: 1.5 });
  const pet = setPet(state, { topmost: true });
  assert.equal(pet.visible, true);
  assert.equal(pet.scale, 1.5);
  assert.equal(pet.topmost, true);
  assert.equal(state.settings.theme, 'dark'); // 其他设置不受影响
});

test('桌宠配置经存取往返，非法历史数据被清理', () => {
  const st = {
    getItem: () => JSON.stringify({ settings: { pet: { visible: true, scale: 3, position: { x: 0.4 } } } }),
    setItem: () => {},
  };
  const loaded = loadState(st);
  assert.equal(loaded.settings.pet.visible, true);
  assert.equal(loaded.settings.pet.scale, 2); // 越界收敛
  assert.equal(loaded.settings.pet.position, null); // 残缺 position 清掉
});
