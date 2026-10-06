import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  LEARN_SCHEMA_VERSION,
  LEARN_STORAGE_KEY,
  MATERIAL_TEXT_LIMIT,
  LearnStoreError,
  clampMaterialText,
  createLearnState,
  createLearnStore,
  createTopic,
  exportTopic,
  normalizeState,
  normalizeTopic,
  renderPlanMarkdown,
  renderProgressMarkdown,
} from '../js/learn/learn-store.js';
import { recordQuiz, addQuestion } from '../js/learn/learn-quiz.js';

/* ---------------- 测试替身 ---------------- */

function fakeLocal() {
  const map = new Map();
  return {
    getItem: (k) => (map.has(k) ? map.get(k) : null),
    setItem: (k, v) => map.set(k, String(v)),
    _map: map,
  };
}

function fakeKv() {
  const map = new Map();
  return {
    get: (k) => map.get(k),
    set: (k, v) => map.set(k, v),
    del: (k) => map.delete(k),
    _map: map,
  };
}

function makeStore(overrides = {}) {
  return createLearnStore('local', { localStorage: fakeLocal(), kv: fakeKv(), ...overrides });
}

function makeTopic() {
  return normalizeTopic({
    id: 't1',
    name: 'Transformer 架构',
    mode: 'plan',
    goal: '读懂 Self-Attention',
    createdAt: 1000,
    updatedAt: 3000,
    plan: {
      updatedAt: 2000,
      items: [
        { id: 'i1', title: '入门概念', status: 'done' },
        { id: 'i2', title: 'Self-Attention', status: 'doing' },
        { id: 'i3', title: 'Multi-Head', status: 'todo' },
      ],
    },
    questions: [
      { id: 'q1', text: 'QKV 还有点困惑', status: 'open', source: 'chat', itemRef: 'i2', createdAt: 2500 },
      { id: 'q2', text: '已解决的问题', status: 'resolved', source: 'quiz', itemRef: 'i1', createdAt: 1500, resolvedAt: 1600, resolvedBy: 'user' },
    ],
    quizzes: [
      {
        id: 'quiz1',
        at: 2800,
        itemRef: 'i2',
        entries: [
          { id: 'e1', at: 2800, question: 'QKV 是什么', userAnswer: '查询/键/值', verdict: 'right', judgedBy: 'ai' },
          { id: 'e2', at: 2900, question: '注意力怎么算', userAnswer: '瞎写的', verdict: 'wrong', judgedBy: 'ai' },
        ],
      },
    ],
    reviews: [{ id: 'r1', at: 3000, title: '第一次复盘' }],
    materials: [{ id: 'm1', name: 'notes.md', kind: 'text', size: 120, addedAt: 3000, summary: '课堂笔记', truncated: false }],
    sessionIds: ['s1'],
  });
}

/* ---------------- schema 构造与归一化 ---------------- */

test('createLearnState 带当前 schemaVersion', () => {
  const state = createLearnState();
  assert.equal(state.schemaVersion, LEARN_SCHEMA_VERSION);
  assert.equal(state.activeTopicId, null);
  assert.deepEqual(state.topics, []);
});

test('createTopic 默认 companion 模式与名称回退', () => {
  const topic = createTopic({ name: '  英语  ', at: 42 });
  assert.equal(topic.mode, 'companion');
  assert.equal(topic.name, '英语');
  assert.equal(topic.createdAt, 42);
  assert.equal(createTopic({ at: 1 }).name, '未命名主题');
});

test('normalizeState 损坏输入回退默认', () => {
  assert.deepEqual(normalizeState(null), createLearnState());
  assert.deepEqual(normalizeState('garbage'), createLearnState());
  assert.deepEqual(normalizeState({ topics: 'not-array' }), createLearnState());
});

test('normalizeState 对未来版本整体回退（迁移占位）', () => {
  const raw = { schemaVersion: LEARN_SCHEMA_VERSION + 1, topics: [makeTopic()] };
  assert.deepEqual(normalizeState(raw), createLearnState());
});

test('normalizeState 校验 activeTopicId 指向存在的主题', () => {
  const topic = makeTopic();
  assert.equal(normalizeState({ schemaVersion: 1, activeTopicId: 't1', topics: [topic] }).activeTopicId, 't1');
  assert.equal(normalizeState({ schemaVersion: 1, activeTopicId: 'missing', topics: [topic] }).activeTopicId, null);
});

test('normalizeTopic 清洗非法字段并保留有效数据', () => {
  const topic = normalizeTopic({
    id: 't1',
    name: '',
    mode: 'hack',
    plan: { items: [{ title: '  ' }, { title: '有效条目', status: '???' }] },
    questions: [{ text: '' }, { text: '有效问题', status: 'resolved', source: 'bad' }],
    quizzes: [{ id: 'q', at: 5, entries: [{ verdict: 'nope' }, null] }],
    reviews: [null, { at: 1 }],
    materials: [{ id: 'm', kind: 'nope' }],
    sessionIds: ['s1', 42, ''],
  });
  assert.equal(topic.name, '未命名主题');
  assert.equal(topic.mode, 'companion');
  assert.deepEqual(topic.plan.items.map((i) => [i.title, i.status]), [['有效条目', 'todo']]);
  assert.equal(topic.questions.length, 1);
  assert.equal(topic.questions[0].source, 'chat');
  assert.equal(topic.quizzes[0].entries[0].verdict, 'unresolved');
  assert.equal(topic.quizzes[0].entries.length, 1);
  assert.deepEqual(topic.reviews, []);
  assert.equal(topic.materials[0].kind, 'other');
  assert.deepEqual(topic.sessionIds, ['s1']);
});

/* ---------------- 读写与兜底 ---------------- */

test('saveState / loadState 往返且 patch 合并根字段', async () => {
  const store = makeStore();
  const topic = makeTopic();
  await store.saveState({ topics: [topic], activeTopicId: 't1' });
  const loaded = await store.loadState();
  assert.equal(loaded.activeTopicId, 't1');
  assert.equal(loaded.topics[0].name, 'Transformer 架构');
  assert.equal(loaded.topics[0].plan.items.length, 3);

  await store.saveState({ activeTopicId: null });
  const next = await store.loadState();
  assert.equal(next.activeTopicId, null);
  assert.equal(next.topics.length, 1); // patch 不影响其他字段
});

test('读取失败与数据损坏时回退默认状态', async () => {
  const throwing = {
    getItem: () => {
      throw new Error('denied');
    },
    setItem: () => {},
  };
  assert.deepEqual(await createLearnStore('local', { localStorage: throwing, kv: fakeKv() }).loadState(), createLearnState());

  const corrupt = fakeLocal();
  corrupt.setItem(LEARN_STORAGE_KEY, '{not json');
  assert.deepEqual(await makeStore({ localStorage: corrupt }).loadState(), createLearnState());
});

test('配额超限抛 LearnStoreError(quota)，其他写入错误为 write', async () => {
  const quotaLocal = {
    getItem: () => null,
    setItem: () => {
      const err = new Error('quota exceeded');
      err.name = 'QuotaExceededError';
      throw err;
    },
  };
  const store = createLearnStore('local', { localStorage: quotaLocal, kv: fakeKv() });
  await assert.rejects(store.saveState({ topics: [] }), (err) => {
    assert.ok(err instanceof LearnStoreError);
    assert.equal(err.code, 'quota');
    assert.match(err.message, /空间不足/);
    return true;
  });

  const brokenLocal = {
    getItem: () => null,
    setItem: () => {
      throw new Error('disk error');
    },
  };
  const store2 = createLearnStore('local', { localStorage: brokenLocal, kv: fakeKv() });
  await assert.rejects(store2.saveState({ topics: [] }), (err) => {
    assert.equal(err.code, 'write');
    return true;
  });
});

test('不支持的存储类型与缺失依赖有明确错误', () => {
  assert.throws(() => createLearnStore('folder'), (err) => {
    assert.equal(err.code, 'unsupported');
    return true;
  });
  assert.throws(() => createLearnStore('local', { localStorage: null }), (err) => {
    assert.equal(err.code, 'unavailable');
    return true;
  });
});

/* ---------------- 资料与复盘大文本 ---------------- */

test('clampMaterialText 超限截断并打标', () => {
  const ok = clampMaterialText('short');
  assert.deepEqual(ok, { text: 'short', truncated: false });
  const big = clampMaterialText('x'.repeat(MATERIAL_TEXT_LIMIT + 10));
  assert.equal(big.text.length, MATERIAL_TEXT_LIMIT);
  assert.equal(big.truncated, true);
});

test('saveMaterial 截断超限文本并归一化元数据，loadMaterial 取回', async () => {
  const store = makeStore();
  const meta = await store.saveMaterial(
    { id: 'm1', name: ' big.txt ', kind: 'nope', size: -5, summary: 's' },
    'y'.repeat(MATERIAL_TEXT_LIMIT + 5)
  );
  assert.equal(meta.id, 'm1');
  assert.equal(meta.name, 'big.txt');
  assert.equal(meta.kind, 'other');
  assert.equal(meta.size, 0);
  assert.equal(meta.truncated, true);

  const text = await store.loadMaterial('m1');
  assert.equal(text.length, MATERIAL_TEXT_LIMIT);
  assert.equal(await store.loadMaterial('missing'), null);
});

test('kv 不可用时 saveMaterial/loadMaterial 抛 unavailable', async () => {
  const store = makeStore({ kv: null });
  await assert.rejects(store.saveMaterial({ id: 'm' }, 'text'), (err) => {
    assert.equal(err.code, 'unavailable');
    return true;
  });
  await assert.rejects(store.loadMaterial('m'), (err) => {
    assert.equal(err.code, 'unavailable');
    return true;
  });
});

test('复盘正文读写与空 id 校验', async () => {
  const store = makeStore();
  await store.saveReview('r1', '今天搞懂了 QKV');
  assert.equal(await store.loadReview('r1'), '今天搞懂了 QKV');
  assert.equal(await store.loadReview('missing'), null);
  await assert.rejects(store.saveReview('', 'x'), (err) => {
    assert.equal(err.code, 'invalid');
    return true;
  });
});

/* ---------------- Vault 导出 ---------------- */

test('renderPlanMarkdown：状态勾选、进行中标注与空计划', () => {
  const md = renderPlanMarkdown(makeTopic());
  assert.match(md, /^---\nschemaVersion: 1\ntopic: "Transformer 架构"/);
  assert.ok(md.includes('- [x] 入门概念'));
  assert.ok(md.includes('- [ ] Self-Attention（进行中）'));
  assert.ok(md.includes('- [ ] Multi-Head'));
  assert.ok(md.includes('最后更新：'));

  const empty = renderPlanMarkdown(normalizeTopic({ id: 't', name: '空', plan: { items: [] } }));
  assert.ok(empty.includes('- 暂无计划条目'));
});

test('renderProgressMarkdown：完成度、当前条目、正确率口径与 open 问题', () => {
  const md = renderProgressMarkdown(makeTopic());
  assert.ok(md.includes('完成度：已完成 1 / 共 3 条'));
  assert.ok(md.includes('当前条目：Self-Attention'));
  assert.ok(md.includes('近 2 条作答中判对 1 · 判错 1（50% · AI 判定）'));
  assert.ok(md.includes('- [ ] QKV 还有点困惑'));
  assert.ok(md.includes('继续：Self-Attention'));
  assert.ok(!md.includes('已解决的问题')); // resolved 不出现在待解决列表

  const noPlan = renderProgressMarkdown(normalizeTopic({ id: 't', name: '空' }));
  assert.ok(noPlan.includes('无计划（陪伴模式或计划尚未生成）'));
  assert.ok(noPlan.includes('- 暂无作答'));
  assert.ok(noPlan.includes('跟随用户的安排推进'));
});

test('exportVault 返回约定目录结构并渲染复盘', async () => {
  const store = makeStore();
  await store.saveState({ topics: [makeTopic()], activeTopicId: 't1' });
  await store.saveReview('r1', '今天搞懂了 QKV');

  const files = await store.exportVault('t1');
  const paths = files.map((f) => f.path);
  assert.deepEqual(paths.slice(0, 4), [
    'learn/plan.md',
    'learn/progress.md',
    'materials/materials.md',
    'exercises/quiz-log.md',
  ]);
  assert.match(paths[4], /^exercises\/\d{4}-\d{2}-\d{2}-review-01-.*\.md$/);

  const byPath = Object.fromEntries(files.map((f) => [f.path, f.content]));
  assert.ok(byPath['materials/materials.md'].includes('`notes.md`'));
  assert.ok(byPath['materials/materials.md'].includes('课堂笔记'));
  assert.ok(byPath['exercises/quiz-log.md'].includes('**判定**：✅ 判对'));
  assert.ok(byPath['exercises/quiz-log.md'].includes('**判定**：❌ 判错'));
  assert.ok(byPath[paths[4]].includes('今天搞懂了 QKV'));
});

test('exportVault：主题不存在与复盘正文缺失的兜底', async () => {
  const store = makeStore();
  await store.saveState({ topics: [makeTopic()] });
  await assert.rejects(store.exportVault('missing'), (err) => {
    assert.equal(err.code, 'not_found');
    return true;
  });

  const files = await store.exportVault('t1'); // 未写入 r1 正文
  const review = files.find((f) => f.path.startsWith('exercises/') && f.path.includes('review'));
  assert.ok(review.content.includes('（复盘正文缺失）'));
});

test('exportTopic 纯函数可独立使用（复盘按时间排序编号）', async () => {
  const topic = makeTopic();
  topic.reviews = [
    { id: 'r2', at: 5000, title: '第二次', bodyRef: 'r2' },
    { id: 'r1', at: 4000, title: '第一次', bodyRef: 'r1' },
  ];
  const files = await exportTopic(topic, { loadReview: async (id) => `正文-${id}` });
  const reviewPaths = files.filter((f) => f.path.includes('review')).map((f) => f.path);
  assert.equal(reviewPaths.length, 2);
  assert.match(reviewPaths[0], /review-01-第一次\.md$/);
  assert.match(reviewPaths[1], /review-02-第二次\.md$/);
  assert.ok(files.find((f) => f.path === reviewPaths[0]).content.includes('正文-r1'));
});

/* ---------------- 与 learn-quiz 协作 ---------------- */

test('作答与问题状态变化反映到导出的进度文件', async () => {
  const topic = makeTopic();
  topic.questions = [];
  topic.quizzes = [];
  addQuestion(topic, '新的困惑', { itemRef: 'i2', at: 100 });
  recordQuiz(topic, { at: 200, itemRef: 'i2', entries: [{ at: 200, question: 'Q', userAnswer: 'A', verdict: 'right' }] });
  const md = renderProgressMarkdown(topic);
  assert.ok(md.includes('判对 1 · 判错 0（100% · AI 判定）'));
  assert.ok(md.includes('- [ ] 新的困惑'));
});


test('removeMaterial ɾ�����ģ�loadMaterial ���� null', async () => {
  const store = makeStore();
  const meta = await store.saveMaterial({ id: 'm-del', name: 'a.txt', kind: 'text' }, '��������');
  assert.equal(await store.loadMaterial(meta.id), '��������');
  await store.removeMaterial(meta.id);
  assert.equal(await store.loadMaterial(meta.id), null);
});
