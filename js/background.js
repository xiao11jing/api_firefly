/**
 * background.js — 应用背景图的纯逻辑（无 DOM 依赖）
 *
 * 背景图会以 data URL 存进 localStorage，而浏览器存储只有约 5MB，
 * 所以选图后先等比缩放并重新编码，把体积压到可存储范围内。
 */

/** 原图体积上限（超出直接拒绝，缩放也救不回解码成本） */
export const MAX_BG_SOURCE_BYTES = 12 * 1024 * 1024;
/** 缩放后最长边上限 */
export const BG_MAX_DIM = 1920;
/** 压缩后 data URL 的字符上限（约 1.2MB 图片，给会话数据留出余量） */
export const MAX_BG_DATA_URL_CHARS = 1_600_000;
/** 重新编码为 JPEG 时的质量 */
export const BG_JPEG_QUALITY = 0.82;

export const MIN_BG_OPACITY = 5;
export const MAX_BG_OPACITY = 100;
export const DEFAULT_BG_OPACITY = 35;

/** 透明度归一化：非法值回退默认，超出范围收敛到边界 */
export function normalizeBgOpacity(value, fallback = DEFAULT_BG_OPACITY) {
  if (value === '' || value == null) return fallback;
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(MAX_BG_OPACITY, Math.max(MIN_BG_OPACITY, Math.round(n)));
}

/**
 * 等比缩放到最长边不超过 max。
 * 未超出时 scaled 为 false，调用方可直接沿用原图（保留 PNG 透明通道）。
 */
export function computeScale(width, height, max = BG_MAX_DIM) {
  const w = Math.max(0, Math.floor(Number(width) || 0));
  const h = Math.max(0, Math.floor(Number(height) || 0));
  if (!w || !h) return { width: 0, height: 0, scaled: false };
  const longest = Math.max(w, h);
  if (longest <= max) return { width: w, height: h, scaled: false };
  const k = max / longest;
  return {
    width: Math.max(1, Math.round(w * k)),
    height: Math.max(1, Math.round(h * k)),
    scaled: true,
  };
}

/** data URL 是否超出可存储上限 */
export function isTooLargeForStorage(dataUrl, max = MAX_BG_DATA_URL_CHARS) {
  return String(dataUrl || '').length > max;
}

/** 是否需要走画布重新编码：尺寸需缩放，或虽未超尺寸但体积已超出存储上限 */
export function needsReencode({ scaled, dataUrl, max = MAX_BG_DATA_URL_CHARS }) {
  return !!scaled || isTooLargeForStorage(dataUrl, max);
}
