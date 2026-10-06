/**
 * defaults.js —— 出厂默认资源（随安装包内置，用户未设置时生效）
 *
 * 用户在设置里做过的选择始终优先；「移除 / 恢复默认」清除覆盖后回到这里声明的内置资源。
 * 路径相对 index.html，网页版与桌面版资源目录同一结构（Tauri 打包时原样进 bundle）。
 */

import { DEFAULT_BG_OPACITY } from './background.js';

export const DEFAULT_AVATAR_SRC = 'assets/defaults/avatar.png';
export const DEFAULT_BACKGROUND_SRC = 'assets/defaults/background.png';
export const DEFAULT_SPLASH_SRC = 'assets/defaults/splash.mp4';

/**
 * 某身份当前应展示的头像地址。
 * 自定义图片优先；AI 未设置时用出厂默认头像；用户侧没有默认（回到名称首字占位）。
 */
export function effectiveAvatarSrc(side, custom) {
  if (custom) return custom;
  return side === 'ai' ? DEFAULT_AVATAR_SRC : '';
}

/**
 * 当前生效的背景：自定义优先；未设置时使用出厂默认背景（透明度取内置默认值）。
 * isDefault 标记供设置面板区分「出厂默认」与「用户已设置」两种状态。
 */
export function effectiveBackground(bg) {
  if (bg && bg.dataUrl) {
    return { dataUrl: bg.dataUrl, opacity: bg.opacity, isDefault: false };
  }
  return { dataUrl: DEFAULT_BACKGROUND_SRC, opacity: DEFAULT_BG_OPACITY, isDefault: true };
}

/** 开屏动画开关：仅显式 false 为关；旧数据缺字段视为开（出厂默认开） */
export function splashEnabledOf(settings) {
  return !settings || settings.splashEnabled !== false;
}
