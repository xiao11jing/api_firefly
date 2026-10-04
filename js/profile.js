/**
 * profile.js — 用户与 AI 的名称/头像（纯逻辑，无 DOM 依赖）
 *
 * 名称与头像全局生效（不按会话区分），随状态一起存在本地。
 */

export const PROFILE_SIDES = ['user', 'ai'];

export const DEFAULT_USER_NAME = '你';
export const DEFAULT_AI_NAME = 'AI';

/** 名称的字素上限 */
export const MAX_PROFILE_NAME = 24;

/** 头像缩放后的最长边（比背景图小得多，头像最大只显示到 52px） */
export const AVATAR_MAX_DIM = 256;
/** 头像 data URL 的字符上限（约 300KB，为会话数据留足 localStorage 余量） */
export const AVATAR_MAX_DATA_URL_CHARS = 400000;

export function defaultProfile() {
  return {
    user: { name: DEFAULT_USER_NAME, avatar: null },
    ai: { name: DEFAULT_AI_NAME, avatar: null },
  };
}

/** 名称归一化：合并空白、按字素截断；为空则回退到默认名 */
export function normalizeProfileName(value, fallback) {
  const name = typeof value === 'string' ? value.trim().replace(/\s+/g, ' ') : '';
  if (!name) return fallback;
  return Array.from(name).slice(0, MAX_PROFILE_NAME).join('');
}

/** 取首个字素作为默认头像的占位字符（正确处理 emoji 等代理对） */
export function avatarInitial(name) {
  const chars = Array.from(String(name == null ? '' : name).trim());
  return chars.length ? chars[0].toUpperCase() : '?';
}
