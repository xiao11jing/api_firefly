import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  AVATAR_MAX_DIM,
  DEFAULT_AI_NAME,
  DEFAULT_USER_NAME,
  MAX_PROFILE_NAME,
  avatarInitial,
  defaultProfile,
  normalizeProfileName,
} from '../js/profile.js';
import {
  defaultState,
  loadState,
  normalizeImageDataUrl,
  normalizeProfile,
  updateProfile,
} from '../js/storage.js';

/** 一个最小的合法头像 data URL */
const AVATAR = 'data:image/png;base64,iVBORw0KGgo=';

test('defaultProfile 给出默认名称且没有头像', () => {
  const p = defaultProfile();
  assert.equal(p.user.name, DEFAULT_USER_NAME);
  assert.equal(p.ai.name, DEFAULT_AI_NAME);
  assert.equal(p.user.avatar, null);
  assert.equal(p.ai.avatar, null);
});

test('normalizeProfileName 去空白、合并空格并按字素截断', () => {
  assert.equal(normalizeProfileName('  小明  ', '你'), '小明');
  assert.equal(normalizeProfileName('小  明', '你'), '小 明');
  assert.equal(normalizeProfileName('', '你'), '你');
  assert.equal(normalizeProfileName('   ', '你'), '你');
  assert.equal(normalizeProfileName(null, 'AI'), 'AI');
  assert.equal(normalizeProfileName(123, 'AI'), 'AI');
  assert.equal(normalizeProfileName('a'.repeat(50), 'AI').length, MAX_PROFILE_NAME);
});

test('normalizeProfileName 按字素截断，不劈开 emoji', () => {
  const name = normalizeProfileName('😀'.repeat(30), '你');
  assert.equal(Array.from(name).length, MAX_PROFILE_NAME);
  assert.equal(name, '😀'.repeat(MAX_PROFILE_NAME));
});

test('avatarInitial 取首字素并大写', () => {
  assert.equal(avatarInitial('小明'), '小');
  assert.equal(avatarInitial('ai'), 'A');
  assert.equal(avatarInitial('  Bob'), 'B');
  assert.equal(avatarInitial('😀笑脸'), '😀'); // 代理对不能被劈开
  assert.equal(avatarInitial(''), '?');
  assert.equal(avatarInitial(null), '?');
});

test('normalizeImageDataUrl 只接受本地图片的 base64 data URL', () => {
  assert.equal(normalizeImageDataUrl(AVATAR), AVATAR);
  assert.equal(normalizeImageDataUrl(' https://x/a.png '), null);
  assert.equal(normalizeImageDataUrl('javascript:alert(1)'), null);
  assert.equal(normalizeImageDataUrl('data:image/png;base64,<script>'), null);
  assert.equal(normalizeImageDataUrl('data:text/html;base64,AAAA'), null);
  assert.equal(normalizeImageDataUrl(null), null);
  assert.equal(normalizeImageDataUrl(''), null);
});

test('normalizeProfile 缺失字段回退默认', () => {
  const p = normalizeProfile(undefined);
  assert.deepEqual(p, defaultProfile());
  assert.deepEqual(normalizeProfile('nope'), defaultProfile());
  assert.deepEqual(normalizeProfile({}), defaultProfile());
  assert.deepEqual(normalizeProfile({ user: { name: '  ' } }).user, { name: DEFAULT_USER_NAME, avatar: null });
});

test('normalizeProfile 保留合法值并丢弃非法头像', () => {
  const p = normalizeProfile({
    user: { name: '小明', avatar: AVATAR },
    ai: { name: '助手', avatar: 'https://evil/a.png' },
  });
  assert.deepEqual(p.user, { name: '小明', avatar: AVATAR });
  assert.deepEqual(p.ai, { name: '助手', avatar: null });
});

test('updateProfile 支持单侧更新与清空', () => {
  const state = defaultState();
  updateProfile(state, { user: { name: '小明' } });
  assert.equal(state.settings.profile.user.name, '小明');
  assert.equal(state.settings.profile.ai.name, DEFAULT_AI_NAME, '另一侧不受影响');

  updateProfile(state, { user: { avatar: AVATAR }, ai: { name: '助手' } });
  assert.equal(state.settings.profile.user.name, '小明', '只改头像时名称保留');
  assert.equal(state.settings.profile.user.avatar, AVATAR);
  assert.equal(state.settings.profile.ai.name, '助手');

  // 传 null 表示清除头像
  updateProfile(state, { user: { avatar: null } });
  assert.equal(state.settings.profile.user.avatar, null);
  assert.equal(state.settings.profile.user.name, '小明');

  // 非法头像视为清除，不会写进状态
  updateProfile(state, { ai: { avatar: 'javascript:alert(1)' } });
  assert.equal(state.settings.profile.ai.avatar, null);
});

test('个人资料随状态持久化并可还原', () => {
  const fake = (raw) => ({ getItem: () => JSON.stringify(raw) });
  const loaded = loadState(
    fake({
      version: 1,
      providers: [],
      sessions: [],
      settings: { profile: { user: { name: '小明', avatar: AVATAR }, ai: { name: '助手' } } },
    })
  );
  assert.equal(loaded.settings.profile.user.name, '小明');
  assert.equal(loaded.settings.profile.user.avatar, AVATAR);
  assert.equal(loaded.settings.profile.ai.name, '助手');
});

test('存量脏数据里的非法头像在加载时被丢弃', () => {
  const fake = (raw) => ({ getItem: () => JSON.stringify(raw) });
  const dirty = loadState(
    fake({ version: 1, providers: [], sessions: [], settings: { profile: { user: { name: 'x', avatar: 'https://evil/a.png' } } } })
  );
  assert.equal(dirty.settings.profile.user.avatar, null);
  assert.equal(dirty.settings.profile.user.name, 'x');
  assert.deepEqual(defaultState().settings.profile, defaultProfile());
});
