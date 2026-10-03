import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  STORAGE_KEY,
  DEFAULT_THEME,
  defaultState,
  loadState,
  saveState,
  createSession,
  deleteSession,
  renameSession,
  getActiveSession,
  addMessage,
  updateMessage,
  sessionTitleFrom,
  saveProvider,
  deleteProvider,
  normalizeTheme,
  setTheme,
} from '../js/storage.js';

function fakeStorage() {
  const map = new Map();
  return {
    getItem: (k) => (map.has(k) ? map.get(k) : null),
    setItem: (k, v) => map.set(k, String(v)),
    removeItem: (k) => map.delete(k),
    _map: map,
  };
}

test('空存储返回默认状态', () => {
  const s = loadState(fakeStorage());
  assert.deepEqual(s, defaultState());
});

test('保存/加载往返一致', () => {
  const st = fakeStorage();
  const state = defaultState();
  saveProvider(state, { name: 'OpenAI', baseUrl: 'https://api.openai.com/v1', apiKey: 'k', models: ['gpt-4o'] });
  const sess = createSession(state);
  addMessage(state, sess.id, { role: 'user', content: [{ type: 'text', text: 'hello' }] });
  saveState(st, state);

  const loaded = loadState(st);
  assert.equal(loaded.providers.length, 1);
  assert.equal(loaded.providers[0].name, 'OpenAI');
  assert.equal(loaded.sessions.length, 1);
  assert.equal(loaded.sessions[0].messages[0].content[0].text, 'hello');
  assert.equal(loaded.activeSessionId, sess.id);
});

test('损坏的 JSON 回退到默认状态', () => {
  const st = fakeStorage();
  st.setItem(STORAGE_KEY, '{{{bad');
  const s = loadState(st);
  assert.deepEqual(s, defaultState());
});

test('sessionTitleFrom 截断与清洗', () => {
  assert.equal(sessionTitleFrom('  a\n\n b  '), 'a b');
  assert.equal(sessionTitleFrom('x'.repeat(50)), 'x'.repeat(30) + '…');
  assert.equal(sessionTitleFrom(''), '新会话');
});

test('createSession 置顶并激活', () => {
  const state = defaultState();
  const a = createSession(state);
  const b = createSession(state);
  assert.equal(state.sessions[0].id, b.id);
  assert.equal(state.activeSessionId, b.id);
  deleteSession(state, b.id);
  assert.equal(state.activeSessionId, a.id);
});

test('首条用户文本消息自动生成标题', () => {
  const state = defaultState();
  const s = createSession(state);
  addMessage(state, s.id, { role: 'user', content: [{ type: 'text', text: '帮我写一段排序代码' }] });
  assert.equal(getActiveSession(state).title, '帮我写一段排序代码');
  // 第二条不再改标题
  addMessage(state, s.id, { role: 'assistant', content: [{ type: 'text', text: '好的' }] });
  addMessage(state, s.id, { role: 'user', content: [{ type: 'text', text: '换一个' }] });
  assert.equal(getActiveSession(state).title, '帮我写一段排序代码');
});

test('只有附件时用附件名命名会话', () => {
  const state = defaultState();
  const s1 = createSession(state);
  addMessage(state, s1.id, { role: 'user', content: [{ type: 'file', name: '设计稿.pdf', text: 'x' }] });
  assert.equal(s1.title, '设计稿.pdf');

  const s2 = createSession(state);
  addMessage(state, s2.id, {
    role: 'user',
    content: [
      { type: 'image', dataUrl: 'data:image/png;base64,AAA', name: 'a.png' },
      { type: 'image', dataUrl: 'data:image/png;base64,BBB', name: 'b.png' },
    ],
  });
  assert.equal(s2.title, '2 个附件');

  // 正文优先于附件名
  const s3 = createSession(state);
  addMessage(state, s3.id, {
    role: 'user',
    content: [
      { type: 'text', text: '看看这个' },
      { type: 'file', name: 'spec.md', text: 'x' },
    ],
  });
  assert.equal(s3.title, '看看这个');

  // 无文本也无名称时回退
  const s4 = createSession(state);
  addMessage(state, s4.id, { role: 'user', content: [{ type: 'file', text: 'x' }] });
  assert.equal(s4.title, '附件会话');
});

test('renameSession 空标题被忽略', () => {
  const state = defaultState();
  const s = createSession(state);
  renameSession(state, s.id, '   ');
  assert.equal(getActiveSession(state).title, '新会话');
  renameSession(state, s.id, '我的会话');
  assert.equal(getActiveSession(state).title, '我的会话');
});

test('updateMessage 更新流式文本', () => {
  const state = defaultState();
  const s = createSession(state);
  const m = addMessage(state, s.id, { role: 'assistant', content: [{ type: 'text', text: '' }] });
  updateMessage(state, s.id, m.id, { content: [{ type: 'text', text: '部分' }] });
  assert.equal(getActiveSession(state).messages[0].content[0].text, '部分');
});

test('saveProvider 归一化：去尾斜杠、清洗模型列表', () => {
  const state = defaultState();
  const p = saveProvider(state, { name: ' X ', baseUrl: 'https://x.com/v1/', apiKey: ' k ', models: [' a ', '', 'b'] });
  assert.equal(p.baseUrl, 'https://x.com/v1');
  assert.equal(p.apiKey, 'k');
  assert.deepEqual(p.models, ['a', 'b']);
  assert.ok(p.id);
});

test('deleteProvider 同时清除关联的选中模型', () => {
  const state = defaultState();
  const p = saveProvider(state, { name: 'X', baseUrl: 'https://x.com', models: ['m'] });
  state.selectedModel = { providerId: p.id, model: 'm' };
  deleteProvider(state, p.id);
  assert.equal(state.providers.length, 0);
  assert.equal(state.selectedModel, null);
});

test('归一化：activeSessionId 悬空时自动修复', () => {
  const st = fakeStorage();
  st.setItem(
    STORAGE_KEY,
    JSON.stringify({
      version: 1,
      providers: [],
      sessions: [{ id: 's1', title: 't', messages: [], createdAt: 1, updatedAt: 1 }],
      activeSessionId: 'ghost',
      selectedModel: null,
      settings: {},
    })
  );
  const s = loadState(st);
  assert.equal(s.activeSessionId, 's1');
});

test('默认状态带默认主题', () => {
  assert.equal(defaultState().settings.theme, DEFAULT_THEME);
  assert.equal(loadState(fakeStorage()).settings.theme, DEFAULT_THEME);
});

test('normalizeTheme 只接受已知主题', () => {
  assert.equal(normalizeTheme('light'), 'light');
  assert.equal(normalizeTheme('dark'), 'dark');
  assert.equal(normalizeTheme('solarized'), DEFAULT_THEME);
  assert.equal(normalizeTheme(undefined), DEFAULT_THEME);
  assert.equal(normalizeTheme(null), DEFAULT_THEME);
});

test('setTheme 归一化并保留其他设置项', () => {
  const state = defaultState();
  state.settings.custom = 1;
  assert.equal(setTheme(state, 'light'), 'light');
  assert.equal(state.settings.theme, 'light');
  assert.equal(state.settings.custom, 1);
  assert.equal(setTheme(state, 'bogus'), 'dark');
});

test('主题随状态持久化，刷新后保留', () => {
  const st = fakeStorage();
  const state = defaultState();
  setTheme(state, 'light');
  saveState(st, state);
  assert.equal(loadState(st).settings.theme, 'light');
});

test('归一化：非法或缺失主题回退为默认', () => {
  const st = fakeStorage();
  st.setItem(STORAGE_KEY, JSON.stringify({ version: 1, settings: { theme: 'neon' } }));
  assert.equal(loadState(st).settings.theme, DEFAULT_THEME);
  st.setItem(STORAGE_KEY, JSON.stringify({ version: 1 }));
  assert.equal(loadState(st).settings.theme, DEFAULT_THEME);
});
