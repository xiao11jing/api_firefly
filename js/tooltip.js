/**
 * tooltip.js — 全局悬停提示（替代原生 title，样式可自定义）
 *
 * 页面里所有提示统一写在 data-tip 属性上（多行用 \n），
 * 原生 title 会以系统样式弹出且无法定制，因此一律改用本组件。
 */

/** 悬停出现延迟（原生 title 约 1s，这里更快） */
export const TIP_DELAY_MS = 250;
/** 气泡与目标的间距 */
export const TIP_GAP = 8;
/** 距视口边缘的最小留白 */
export const TIP_MARGIN = 8;

/**
 * 计算气泡位置：默认出现在目标下方居中；
 * 底部放不下翻到上方，水平方向夹紧在视口内。
 */
export function computeTipPosition(targetRect, tipRect, viewport) {
  const width = tipRect.width;
  const height = tipRect.height;
  let x = targetRect.left + targetRect.width / 2 - width / 2;
  x = Math.min(viewport.width - TIP_MARGIN - width, Math.max(TIP_MARGIN, x));
  let y = targetRect.bottom + TIP_GAP;
  if (y + height > viewport.height - TIP_MARGIN) {
    y = targetRect.top - TIP_GAP - height;
    if (y < TIP_MARGIN) y = TIP_MARGIN;
  }
  return { x, y };
}

/** 初始化全局气泡：创建单例元素并绑定悬停/焦点事件。返回单测可用的控制句柄。 */
export function initTooltips(win = window) {
  const doc = win.document;
  const tip = doc.createElement('div');
  tip.id = 'global-tooltip';
  tip.className = 'global-tooltip';
  tip.setAttribute('role', 'tooltip');
  tip.hidden = true;
  doc.body.appendChild(tip);

  let timer = null;
  let current = null; // 当前提示挂载的目标元素

  const hide = () => {
    win.clearTimeout(timer);
    timer = null;
    current = null;
    tip.classList.remove('show');
    tip.hidden = true;
  };

  const showNow = (el) => {
    const text = el.dataset.tip;
    if (!text) {
      hide();
      return;
    }
    current = el;
    tip.textContent = text;
    tip.hidden = false;
    const rect = el.getBoundingClientRect();
    const tipRect = tip.getBoundingClientRect();
    const pos = computeTipPosition(rect, tipRect, {
      width: win.innerWidth,
      height: win.innerHeight,
    });
    tip.style.left = `${Math.round(pos.x)}px`;
    tip.style.top = `${Math.round(pos.y)}px`;
    void tip.offsetWidth; // 先布局再淡入，避免从左上角跳过来
    tip.classList.add('show');
  };

  const targetOf = (node) => (node && typeof node.closest === 'function' ? node.closest('[data-tip]') : null);

  doc.addEventListener('pointerover', (e) => {
    const el = targetOf(e.target);
    if (!el || !el.dataset.tip) return;
    if (el === current) return; // 在同一目标的子元素间移动不重置计时
    win.clearTimeout(timer);
    timer = win.setTimeout(() => showNow(el), TIP_DELAY_MS);
  });

  doc.addEventListener('pointerout', (e) => {
    const el = targetOf(e.target);
    if (!el) return;
    const related = e.relatedTarget;
    if (related && el.contains(related)) return; // 仍停留在目标内部
    if (el === current) hide();
    else win.clearTimeout(timer);
  });

  // 键盘聚焦立即显示，无需等待
  doc.addEventListener('focusin', (e) => {
    const el = targetOf(e.target);
    if (el && el.dataset.tip) showNow(el);
    else hide();
  });
  doc.addEventListener('focusout', hide);

  doc.addEventListener(
    'scroll',
    () => {
      if (current) hide();
    },
    { capture: true }
  );
  doc.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') hide();
  });

  return { hide, showNow };
}
