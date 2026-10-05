import { test } from 'node:test';
import assert from 'node:assert/strict';
import { TIP_GAP, TIP_MARGIN, computeTipPosition } from '../js/tooltip.js';

const viewport = { width: 1000, height: 800 };

test('空间充足时出现在目标下方居中', () => {
  const target = { left: 400, top: 100, width: 120, bottom: 130 };
  const tip = { width: 80, height: 30 };
  const pos = computeTipPosition(target, tip, viewport);
  assert.equal(pos.x, 400 + 60 - 40); // 目标中心对齐
  assert.equal(pos.y, 130 + TIP_GAP);
});

test('底部放不下时翻到目标上方', () => {
  const target = { left: 400, top: 740, width: 120, bottom: 770 };
  const tip = { width: 80, height: 30 };
  const pos = computeTipPosition(target, tip, viewport);
  assert.equal(pos.y, 740 - TIP_GAP - 30);
});

test('上下都放不下时贴住视口顶部', () => {
  const target = { left: 400, top: 300, width: 120, bottom: 340 };
  const tip = { width: 80, height: 760 }; // 下方放不下，翻到上方也为负值
  const pos = computeTipPosition(target, tip, viewport);
  assert.equal(pos.y, TIP_MARGIN);
});

test('水平方向夹紧在视口内', () => {
  const tip = { width: 200, height: 30 };
  // 贴左边缘的目标：x 不能小于边距
  const left = computeTipPosition({ left: 0, top: 100, width: 40, bottom: 130 }, tip, viewport);
  assert.equal(left.x, TIP_MARGIN);
  // 贴右边缘的目标：x 不能超出右边距
  const right = computeTipPosition({ left: 980, top: 100, width: 40, bottom: 130 }, tip, viewport);
  assert.equal(right.x, viewport.width - TIP_MARGIN - 200);
});
