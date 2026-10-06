import { test } from 'node:test';
import assert from 'node:assert/strict';
import { statSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

import {
  DEFAULT_AVATAR_SRC,
  DEFAULT_BACKGROUND_SRC,
  DEFAULT_SPLASH_SRC,
  effectiveAvatarSrc,
  effectiveBackground,
  splashEnabledOf,
} from '../js/defaults.js';
import { DEFAULT_AI_NAME, defaultProfile } from '../js/profile.js';
import { DEFAULT_BG_OPACITY } from '../js/background.js';
import { defaultState, loadState, setSplashEnabled } from '../js/storage.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

test('出厂默认资源文件存在且非空', () => {
  for (const rel of [DEFAULT_AVATAR_SRC, DEFAULT_BACKGROUND_SRC, DEFAULT_SPLASH_SRC]) {
    const abs = path.join(root, rel);
    const st = statSync(abs);
    assert.ok(st.size > 1000, `${rel} 应为非空资源文件，实际 ${st.size} 字节`);
    assert.ok(!rel.startsWith('/') && !rel.includes('..'), `${rel} 必须是站内相对路径`);
  }
});

test('资源路径约定在 assets/defaults 下', () => {
  assert.equal(DEFAULT_AVATAR_SRC, 'assets/defaults/avatar.png');
  assert.equal(DEFAULT_BACKGROUND_SRC, 'assets/defaults/background.png');
  assert.equal(DEFAULT_SPLASH_SRC, 'assets/defaults/splash.mp4');
});

test('AI 默认名称为 Firefly、默认头像为空（渲染时取内置图）', () => {
  assert.equal(DEFAULT_AI_NAME, 'Firefly');
  const p = defaultProfile();
  assert.equal(p.ai.avatar, null);
  assert.equal(p.user.avatar, null);
});

test('effectiveAvatarSrc：AI 未设置用出厂默认图', () => {
  assert.equal(effectiveAvatarSrc('ai', null), DEFAULT_AVATAR_SRC);
});

test('effectiveAvatarSrc：自定义头像优先', () => {
  assert.equal(effectiveAvatarSrc('ai', 'data:image/png;base64,AAA'), 'data:image/png;base64,AAA');
  assert.equal(effectiveAvatarSrc('user', 'data:image/png;base64,BBB'), 'data:image/png;base64,BBB');
});

test('effectiveAvatarSrc：用户侧没有默认图（首字占位）', () => {
  assert.equal(effectiveAvatarSrc('user', null), '');
  assert.equal(effectiveAvatarSrc('user', undefined), '');
});

test('effectiveBackground：未设置时用出厂默认背景与默认透明度', () => {
  const bg = effectiveBackground(null);
  assert.equal(bg.dataUrl, DEFAULT_BACKGROUND_SRC);
  assert.equal(bg.opacity, DEFAULT_BG_OPACITY);
  assert.equal(bg.isDefault, true);
});

test('effectiveBackground：自定义背景原样透传', () => {
  const custom = { dataUrl: 'data:image/png;base64,CCC', opacity: 70 };
  const bg = effectiveBackground(custom);
  assert.equal(bg.dataUrl, custom.dataUrl);
  assert.equal(bg.opacity, 70);
  assert.equal(bg.isDefault, false);
});

test('splashEnabledOf：缺省为开、仅显式 false 为关', () => {
  assert.equal(splashEnabledOf(undefined), true);
  assert.equal(splashEnabledOf(null), true);
  assert.equal(splashEnabledOf({}), true);
  assert.equal(splashEnabledOf({ splashEnabled: true }), true);
  assert.equal(splashEnabledOf({ splashEnabled: false }), false);
});

test('defaultState 开屏默认开启', () => {
  assert.equal(defaultState().settings.splashEnabled, true);
});

test('旧数据（无 splashEnabled 字段）归一为开，显式 false 保持关', () => {
  const mk = (splashEnabled) => {
    const s = defaultState();
    if (splashEnabled === undefined) delete s.settings.splashEnabled;
    else s.settings.splashEnabled = splashEnabled;
    return { getItem: () => JSON.stringify(s) };
  };
  assert.equal(loadState(mk(undefined)).settings.splashEnabled, true);
  assert.equal(loadState(mk(false)).settings.splashEnabled, false);
  assert.equal(loadState(mk(true)).settings.splashEnabled, true);
});

test('setSplashEnabled 就地更新并回传生效值', () => {
  const state = defaultState();
  assert.equal(setSplashEnabled(state, false), false);
  assert.equal(state.settings.splashEnabled, false);
  assert.equal(setSplashEnabled(state, true), true);
  assert.equal(state.settings.splashEnabled, true);
  assert.equal(setSplashEnabled(state, undefined), true, '非显式 false 一律按开处理');
});
