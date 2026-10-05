import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  STORAGE_KEY,
  DEFAULT_THEME,
  MAX_COMPARE_TARGETS,
  MAX_PROMPT_CHARS,
  defaultState,
  loadState,
  saveState,
  createSession,
  deleteSession,
  renameSession,
  getActiveSession,
  addMessage,
  updateMessage,
  removeMessage,
  resetMessage,
  groupMessages,
  sessionTitleFrom,
  saveProvider,
  deleteProvider,
  normalizeTheme,
  setTheme,
  normalizeFontScale,
  setFontScale,
  setCompareEnabled,
  setCompareTargets,
  savePromptTemplate,
  deletePromptTemplate,
  findPromptTemplate,
  setSessionSystemPrompt,
  systemPromptText,
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

test('normalizeFontScale 收敛到 80%~160% 并按 5% 取整', () => {
  assert.equal(normalizeFontScale(1), 1);
  assert.equal(normalizeFontScale(1.3), 1.3);
  assert.equal(normalizeFontScale('1.25'), 1.25);
  assert.equal(normalizeFontScale(0.7), 0.8); // 低于下限收敛
  assert.equal(normalizeFontScale(2), 1.6); // 高于上限收敛
  assert.equal(normalizeFontScale(1.23), 1.25); // 5% 步进取整
  assert.equal(normalizeFontScale('abc'), 1); // 非法回退默认
  assert.equal(normalizeFontScale(null), 1);
  assert.equal(normalizeFontScale(undefined), 1);
});

test('setFontScale 写入并可经存取往返，刷新后保留', () => {
  const st = fakeStorage();
  const state = defaultState();
  assert.equal(setFontScale(state, 1.4), 1.4);
  assert.equal(state.settings.fontScale, 1.4);
  saveState(st, state);
  assert.equal(loadState(st).settings.fontScale, 1.4);
  setFontScale(state, 1);
  saveState(st, state);
  assert.equal(loadState(st).settings.fontScale, 1);
});

test('归一化：非法或缺失主题回退为默认', () => {
  const st = fakeStorage();
  st.setItem(STORAGE_KEY, JSON.stringify({ version: 1, settings: { theme: 'neon' } }));
  assert.equal(loadState(st).settings.theme, DEFAULT_THEME);
  st.setItem(STORAGE_KEY, JSON.stringify({ version: 1 }));
  assert.equal(loadState(st).settings.theme, DEFAULT_THEME);
});

test('对比模式：默认关闭，开关与目标归一化', () => {
  const state = defaultState();
  assert.deepEqual(state.compare, { enabled: false, targets: [] });

  assert.equal(setCompareEnabled(state, true), true);
  const kept = setCompareTargets(state, [
    { providerId: 'p1', model: 'm1' },
    { providerId: 'p2', model: 'm2' },
    { providerId: 'p3', model: 'm3' },
  ]);
  assert.equal(kept.length, MAX_COMPARE_TARGETS);
  assert.deepEqual(kept[0], { providerId: 'p1', model: 'm1' });
  assert.equal(state.compare.enabled, true);

  // 残缺项被丢弃，开关保持不变
  assert.deepEqual(setCompareTargets(state, [{ providerId: 'p1' }, null, { model: 'm' }]), []);
  assert.equal(state.compare.enabled, true);
});

test('对比模式随状态持久化，非法数据回退默认', () => {
  const st = fakeStorage();
  const state = defaultState();
  setCompareEnabled(state, true);
  setCompareTargets(state, [{ providerId: 'p1', model: 'm1' }]);
  saveState(st, state);
  const loaded = loadState(st);
  assert.equal(loaded.compare.enabled, true);
  assert.deepEqual(loaded.compare.targets, [{ providerId: 'p1', model: 'm1' }]);

  st.setItem(STORAGE_KEY, JSON.stringify({ version: 1, compare: { enabled: 'yes', targets: 'x' } }));
  const fallback = loadState(st);
  assert.deepEqual(fallback.compare, { enabled: false, targets: [] });
});

test('删除服务时清理指向它的对比目标', () => {
  const state = defaultState();
  const a = saveProvider(state, { name: 'A', baseUrl: 'https://a.com', models: ['m'] });
  const b = saveProvider(state, { name: 'B', baseUrl: 'https://b.com', models: ['m'] });
  setCompareEnabled(state, true);
  setCompareTargets(state, [
    { providerId: a.id, model: 'm' },
    { providerId: b.id, model: 'm' },
  ]);
  deleteProvider(state, a.id);
  assert.deepEqual(state.compare.targets, [{ providerId: b.id, model: 'm' }]);
});

test('saveProvider 归一化单价：非法或缺失记为 null', () => {
  const state = defaultState();
  const withPrice = saveProvider(state, {
    name: 'X',
    baseUrl: 'https://x.com',
    models: ['m'],
    price: { input: '2.5', output: '10' },
  });
  assert.deepEqual(withPrice.price, { input: 2.5, output: 10 });

  const halfPrice = saveProvider(state, { name: 'Y', baseUrl: 'https://y.com', price: { input: 1 } });
  assert.equal(halfPrice.price, null);
  const noPrice = saveProvider(state, { name: 'Z', baseUrl: 'https://z.com' });
  assert.equal(noPrice.price, null);
});

test('saveProvider 归一化上下文长度：非正数或非法记为 null', () => {
  const state = defaultState();
  const withLen = saveProvider(state, { name: 'A', baseUrl: 'https://a.com', models: ['m'], contextLength: '128000' });
  assert.equal(withLen.contextLength, 128000);

  const rounded = saveProvider(state, { name: 'B', baseUrl: 'https://b.com', models: ['m'], contextLength: 8192.7 });
  assert.equal(rounded.contextLength, 8193);

  for (const bad of [0, -1, '', 'abc', null, undefined]) {
    const p = saveProvider(state, { name: 'C', baseUrl: 'https://c.com', models: ['m'], contextLength: bad });
    assert.equal(p.contextLength, null, `contextLength=${String(bad)} 应记为 null`);
  }
});

test('回复消息记录模型、批次与用量，并随状态持久化', () => {
  const state = defaultState();
  const s = createSession(state);
  const msg = addMessage(state, s.id, {
    role: 'assistant',
    content: [{ type: 'text', text: 'hi' }],
    model: { providerId: 'p1', model: 'm1' },
    batchId: 'b1',
  });
  assert.deepEqual(msg.model, { providerId: 'p1', model: 'm1' });
  assert.equal(msg.batchId, 'b1');

  updateMessage(state, s.id, msg.id, {
    usage: { promptTokens: 10, completionTokens: 5, totalTokens: 15, estimated: false },
    ms: 1200,
  });
  const st = fakeStorage();
  saveState(st, state);
  const [loaded] = loadState(st).sessions[0].messages;
  assert.deepEqual(loaded.model, { providerId: 'p1', model: 'm1' });
  assert.equal(loaded.batchId, 'b1');
  assert.deepEqual(loaded.usage, { promptTokens: 10, completionTokens: 5, totalTokens: 15, estimated: false });
  assert.equal(loaded.ms, 1200);
});

test('归一化：损坏的用量与耗时字段被丢弃', () => {
  const st = fakeStorage();
  st.setItem(
    STORAGE_KEY,
    JSON.stringify({
      version: 1,
      sessions: [
        {
          id: 's1',
          title: 't',
          messages: [
            { id: 'm1', role: 'assistant', content: [{ type: 'text', text: 'a' }], usage: { promptTokens: 'x' }, ms: -5 },
            { id: 'm2', role: 'assistant', content: 'not-an-array' },
          ],
          createdAt: 1,
          updatedAt: 1,
        },
      ],
    })
  );
  const msgs = loadState(st).sessions[0].messages;
  assert.equal(msgs.length, 1);
  assert.equal(msgs[0].usage, undefined);
  assert.equal(msgs[0].ms, undefined);
});

test('removeMessage 与 resetMessage', () => {
  const state = defaultState();
  const s = createSession(state);
  const m = addMessage(state, s.id, { role: 'assistant', content: [{ type: 'text', text: '' }] });
  assert.equal(removeMessage(state, s.id, 'ghost'), false);
  assert.equal(s.messages.length, 1);
  assert.equal(removeMessage(state, s.id, m.id), true);
  assert.equal(s.messages.length, 0);

  const m2 = addMessage(state, s.id, { role: 'assistant', content: [{ type: 'text', text: '错' }], error: true });
  updateMessage(state, s.id, m2.id, { usage: { promptTokens: 1 }, ms: 5 });
  const reset = resetMessage(state, s.id, m2.id);
  assert.deepEqual(reset.content, [{ type: 'text', text: '' }]);
  assert.equal(reset.error, undefined);
  assert.equal(reset.usage, undefined);
  assert.equal(reset.ms, undefined);
});

test('模板库：新建、更新与删除', () => {
  const state = defaultState();
  assert.deepEqual(state.promptTemplates, []);

  const created = savePromptTemplate(state, { name: ' 写作助手 ', content: '你是一位编辑' });
  assert.ok(created.id);
  assert.equal(created.name, '写作助手');
  assert.equal(created.content, '你是一位编辑');
  assert.equal(state.promptTemplates.length, 1);

  const updated = savePromptTemplate(state, { id: created.id, name: '写作助手', content: '改过的正文' });
  assert.equal(updated.id, created.id);
  assert.equal(updated.createdAt, created.createdAt);
  assert.equal(updated.updatedAt >= created.createdAt, true);
  assert.equal(state.promptTemplates.length, 1);
  assert.equal(updated.content, '改过的正文');

  assert.equal(savePromptTemplate(state, { name: '   ', content: 'x' }), null);
  assert.equal(state.promptTemplates.length, 1);
  assert.equal(deletePromptTemplate(state, created.id), true);
  assert.equal(deletePromptTemplate(state, created.id), false);
  assert.equal(findPromptTemplate(state, created.id), null);
});

test('模板正文超过上限时截断', () => {
  const state = defaultState();
  const t = savePromptTemplate(state, { name: '长文本', content: 'x'.repeat(MAX_PROMPT_CHARS + 50) });
  assert.equal(t.content.length, MAX_PROMPT_CHARS);
});

test('归一化：损坏的模板被丢弃、模板名过长被截断', () => {
  const st = fakeStorage();
  st.setItem(
    STORAGE_KEY,
    JSON.stringify({
      version: 1,
      promptTemplates: [
        { id: 't1', name: '  正常  ', content: 'ok', createdAt: 1, updatedAt: 2 },
        { id: '', name: 'no-id', content: 'x' },
        { id: 't2', name: '   ', content: 'x' },
        { id: 't3', name: 'n'.repeat(80), content: 123 },
        'garbage',
      ],
    })
  );
  const templates = loadState(st).promptTemplates;
  assert.equal(templates.length, 2);
  assert.equal(templates[0].name, '正常');
  assert.equal(templates[1].name.length, 60);
  assert.equal(templates[1].content, '123');
});

test('会话系统提示：选定时复制模板正文做快照', () => {
  const state = defaultState();
  const s = createSession(state);
  const t = savePromptTemplate(state, { name: '写作助手', content: '你是一位编辑' });
  assert.equal(systemPromptText(s), '');

  const snap = setSessionSystemPrompt(state, s.id, t);
  assert.deepEqual(snap, { templateId: t.id, name: '写作助手', text: '你是一位编辑' });
  assert.equal(systemPromptText(s), '你是一位编辑');

  // 模板改动或删除都不影响已有会话（快照语义）
  savePromptTemplate(state, { id: t.id, name: '写作助手', content: '全新正文' });
  deletePromptTemplate(state, t.id);
  assert.equal(systemPromptText(s), '你是一位编辑');
  assert.equal(s.systemPrompt.templateId, t.id);
  assert.equal(findPromptTemplate(state, t.id), null);

  // 清空
  assert.equal(setSessionSystemPrompt(state, s.id, null), null);
  assert.equal(systemPromptText(s), '');
});

test('会话系统提示：空正文模板不会被写入，且随状态持久化', () => {
  const state = defaultState();
  const s = createSession(state);
  const blank = savePromptTemplate(state, { name: '空模板', content: '' });
  assert.equal(setSessionSystemPrompt(state, s.id, blank), null);
  assert.equal(s.systemPrompt, null);

  const t = savePromptTemplate(state, { name: 'A', content: '正文' });
  setSessionSystemPrompt(state, s.id, t);
  const st = fakeStorage();
  saveState(st, state);
  const loaded = loadState(st);
  assert.deepEqual(loaded.sessions[0].systemPrompt, { templateId: t.id, name: 'A', text: '正文' });
  assert.equal(systemPromptText(loaded.sessions[0]), '正文');
});

test('回复记录当轮系统提示，归一化后随状态保留', () => {
  const state = defaultState();
  const s = createSession(state);
  const msg = addMessage(state, s.id, { role: 'assistant', content: [{ type: 'text', text: 'ok' }] });
  updateMessage(state, s.id, msg.id, { systemPrompt: { name: '写作助手', text: '你是一位编辑' } });

  const st = fakeStorage();
  saveState(st, state);
  assert.deepEqual(loadState(st).sessions[0].messages[0].systemPrompt, { name: '写作助手', text: '你是一位编辑' });

  // 只有正文、没有名字的旧数据也接受
  st.setItem(
    STORAGE_KEY,
    JSON.stringify({
      version: 1,
      sessions: [
        {
          id: 's1',
          title: 't',
          messages: [{ id: 'm1', role: 'assistant', content: [{ type: 'text', text: 'a' }], systemPrompt: '朴素文本' }],
        },
      ],
    })
  );
  assert.deepEqual(loadState(st).sessions[0].messages[0].systemPrompt, { name: '', text: '朴素文本' });

  // 空白或损坏的提示记录被丢弃
  st.setItem(
    STORAGE_KEY,
    JSON.stringify({
      version: 1,
      sessions: [
        {
          id: 's1',
          title: 't',
          messages: [
            { id: 'm1', role: 'assistant', content: [{ type: 'text', text: 'a' }], systemPrompt: { text: '   ' } },
            { id: 'm2', role: 'assistant', content: [{ type: 'text', text: 'b' }], systemPrompt: 42 },
          ],
        },
      ],
    })
  );
  const msgs = loadState(st).sessions[0].messages;
  assert.equal(msgs[0].systemPrompt, undefined);
  assert.equal(msgs[1].systemPrompt, undefined);
});

test('resetMessage 同时清除系统的提示记录', () => {
  const state = defaultState();
  const s = createSession(state);
  const m = addMessage(state, s.id, { role: 'assistant', content: [{ type: 'text', text: '错' }], error: true });
  updateMessage(state, s.id, m.id, { systemPrompt: { name: 'A', text: 'x' } });
  resetMessage(state, s.id, m.id);
  assert.equal(m.systemPrompt, undefined);
});

test('groupMessages 把同一批次的回复合并为一组', () => {
  const groups = groupMessages([
    { id: 'u1', role: 'user', content: [] },
    { id: 'a1', role: 'assistant', content: [], batchId: 'b1' },
    { id: 'a2', role: 'assistant', content: [], batchId: 'b1' },
    { id: 'u2', role: 'user', content: [] },
    { id: 'a3', role: 'assistant', content: [] },
    { id: 'a4', role: 'assistant', content: [], batchId: 'b2' },
    { id: 'a5', role: 'assistant', content: [], batchId: 'b3' },
  ]);
  assert.deepEqual(
    groups.map((g) => g.map((m) => m.id)),
    [['u1'], ['a1', 'a2'], ['u2'], ['a3'], ['a4'], ['a5']]
  );
  assert.deepEqual(groupMessages(null), []);
  assert.deepEqual(groupMessages([]), []);
});
