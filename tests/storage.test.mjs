import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  STORAGE_KEY,
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
