import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  ACCURACY_WINDOW,
  QUIZ_STREAK,
  addQuestion,
  allEntries,
  appendEntry,
  computeAccuracy,
  normalizeEntry,
  openQuestions,
  overruleEntry,
  recentEntries,
  recordQuiz,
  resolveByQuiz,
  resolveQuestion,
} from '../js/learn/learn-quiz.js';

let seq = 0;
function entry(at, verdict, extra = {}) {
  seq += 1;
  return { id: `e${seq}`, at, question: extra.question || `问题${at}`, userAnswer: '答', verdict, ...extra };
}

function topicWith(entries, itemRef = null) {
  return {
    id: 't1',
    name: '主题',
    updatedAt: 0,
    plan: { updatedAt: 0, items: [] },
    questions: [],
    quizzes: entries.length ? [{ id: 'q1', at: entries[0].at, itemRef, entries }] : [],
    reviews: [],
    materials: [],
    sessionIds: [],
  };
}

/* ---------------- 正确率窗口与分母 ---------------- */

test('分母只含 right/wrong，unresolved 与 overruled 不计入', () => {
  const topic = topicWith([
    entry(1, 'right'),
    entry(2, 'wrong'),
    entry(3, 'unresolved'),
    entry(4, 'overruled'),
  ]);
  const acc = computeAccuracy(topic);
  assert.equal(acc.window, 4);
  assert.equal(acc.considered, 2);
  assert.equal(acc.right, 1);
  assert.equal(acc.wrong, 1);
  assert.equal(acc.excluded, 2);
  assert.equal(acc.ratio, 0.5);
});

test('默认窗口只取近 10 条作答', () => {
  assert.equal(ACCURACY_WINDOW, 10);
  const entries = [];
  for (let i = 1; i <= 12; i++) entries.push(entry(i, i <= 2 ? 'wrong' : 'right'));
  const topic = topicWith(entries);
  assert.equal(allEntries(topic).length, 12);
  assert.equal(recentEntries(topic).length, 10);
  const acc = computeAccuracy(topic);
  assert.equal(acc.window, 10);
  assert.equal(acc.considered, 10);
  assert.equal(acc.right, 10); // 前两条 wrong 被窗口截掉
  assert.equal(acc.ratio, 1);
});

test('空数据与全部未判定时 ratio 为 null', () => {
  assert.equal(computeAccuracy(topicWith([])).ratio, null);
  assert.equal(computeAccuracy(topicWith([])).considered, 0);
  const allUnresolved = topicWith([entry(1, 'unresolved'), entry(2, 'overruled')]);
  const acc = computeAccuracy(allUnresolved);
  assert.equal(acc.considered, 0);
  assert.equal(acc.ratio, null);
  assert.equal(acc.excluded, 2);
});

test('作答按时间升序合并多个批次', () => {
  const topic = topicWith([entry(10, 'wrong')]);
  recordQuiz(topic, { at: 5, entries: [entry(5, 'right')] });
  const all = allEntries(topic);
  assert.deepEqual(all.map((e) => e.at), [5, 10]);
});

/* ---------------- 批次与记录 ---------------- */

test('recordQuiz 归一化条目与非法判定', () => {
  const topic = topicWith([]);
  const quiz = recordQuiz(topic, {
    at: 100,
    itemRef: '',
    entries: [{ at: undefined, question: ' 什么是 QKV ', verdict: '胡说' }],
  });
  assert.equal(quiz.itemRef, null);
  assert.equal(topic.quizzes.length, 1);
  assert.equal(topic.updatedAt, 100);
  const e = quiz.entries[0];
  assert.equal(e.verdict, 'unresolved'); // 非法判定回退
  assert.equal(e.question, '什么是 QKV'); // 去除首尾空白
  assert.equal(e.at, 100); // 缺时间回退批次时间
  assert.ok(e.id);
  assert.equal(e.judgedBy, 'ai');
});

test('appendEntry 追加到指定批次，批次不存在返回 null', () => {
  const topic = topicWith([]);
  const quiz = recordQuiz(topic, { at: 10, entries: [] });
  const added = appendEntry(topic, quiz.id, { at: 11, question: 'Q', verdict: 'right' });
  assert.equal(topic.quizzes[0].entries.length, 1);
  assert.equal(topic.updatedAt, 11);
  assert.equal(added.verdict, 'right');
  assert.equal(appendEntry(topic, 'nope', {}), null);
});

test('normalizeEntry 保留显式 itemRef，空串归 null', () => {
  assert.equal(normalizeEntry({ itemRef: 'i1' }).itemRef, 'i1');
  assert.equal(normalizeEntry({ itemRef: '' }).itemRef, null);
  assert.equal(normalizeEntry({}).itemRef, null);
});

/* ---------------- 问题状态机 ---------------- */

test('addQuestion 去重 open 同文本，resolved 后可重新登记', () => {
  const topic = topicWith([]);
  const q1 = addQuestion(topic, 'QKV 是什么', { source: 'chat', at: 1 });
  const dup = addQuestion(topic, '  QKV 是什么 ', { at: 2 });
  assert.equal(dup.id, q1.id);
  assert.equal(topic.questions.length, 1);
  resolveQuestion(topic, q1.id, { by: 'user', at: 3 });
  const again = addQuestion(topic, 'QKV 是什么', { at: 4 });
  assert.notEqual(again.id, q1.id);
  assert.equal(topic.questions.length, 2);
  assert.equal(openQuestions(topic).length, 1);
});

test('addQuestion 空文本返回 null，非法 source 归为 chat', () => {
  const topic = topicWith([]);
  assert.equal(addQuestion(topic, '   '), null);
  const q = addQuestion(topic, '目标', { source: 'hack' });
  assert.equal(q.source, 'chat');
});

test('resolveQuestion 标记解决者，重复解决返回 null', () => {
  const topic = topicWith([]);
  const q = addQuestion(topic, '不懂 attention', { itemRef: 'i1', at: 1 });
  const done = resolveQuestion(topic, q.id, { by: 'quiz', at: 5 });
  assert.equal(done.status, 'resolved');
  assert.equal(done.resolvedBy, 'quiz');
  assert.equal(done.resolvedAt, 5);
  assert.equal(resolveQuestion(topic, q.id, { by: 'user', at: 6 }), null);
  assert.equal(resolveQuestion(topic, 'missing'), null);
});

/* ---------------- 推翻与连续答对 ---------------- */

test('overruleEntry 改判定并登记 overrule 问题（继承 itemRef）', () => {
  const topic = topicWith([entry(1, 'right', { question: '多头注意力有几个头' })], 'i1');
  overruleEntry(topic, topic.quizzes[0].entries[0].id, { at: 9 });
  const e = topic.quizzes[0].entries[0];
  assert.equal(e.verdict, 'overruled');
  assert.equal(topic.questions.length, 1);
  const q = topic.questions[0];
  assert.equal(q.status, 'open');
  assert.equal(q.source, 'overrule');
  assert.equal(q.itemRef, 'i1');
  assert.equal(q.text, '多头注意力有几个头');
  // 重复推翻为 no-op
  overruleEntry(topic, e.id, { at: 10 });
  assert.equal(topic.questions.length, 1);
  assert.equal(topic.updatedAt, 9);
});

test('overruleEntry 对不存在的记录是 no-op', () => {
  const topic = topicWith([entry(1, 'right')]);
  overruleEntry(topic, 'missing', { at: 2 });
  assert.equal(topic.quizzes[0].entries[0].verdict, 'right');
  assert.equal(topic.questions.length, 0);
});

test('resolveByQuiz 连续答对 QUIZ_STREAK 次才消解同条目问题', () => {
  assert.equal(QUIZ_STREAK, 2);
  const topic = topicWith([], 'i1');
  addQuestion(topic, '这块没懂', { itemRef: 'i1', at: 1 });
  addQuestion(topic, '别的问题', { itemRef: 'i2', at: 2 });
  recordQuiz(topic, { at: 3, itemRef: 'i1', entries: [entry(3, 'right', { itemRef: 'i1' })] });

  // 只有一次答对 → 不消解
  assert.equal(resolveByQuiz(topic, { itemRef: 'i1', at: 4 }), 0);
  assert.equal(openQuestions(topic).length, 2);

  recordQuiz(topic, { at: 5, itemRef: 'i1', entries: [entry(5, 'right', { itemRef: 'i1' })] });
  assert.equal(resolveByQuiz(topic, { itemRef: 'i1', at: 6 }), 1);
  assert.equal(topic.questions[0].status, 'resolved');
  assert.equal(topic.questions[0].resolvedBy, 'quiz');
  assert.equal(topic.questions[1].status, 'open'); // 其他条目的问题不受影响
});

test('resolveByQuiz 尾部出现错题或缺 itemRef 时返回 0', () => {
  const topic = topicWith([], 'i1');
  addQuestion(topic, '没懂', { itemRef: 'i1', at: 1 });
  recordQuiz(topic, {
    at: 3,
    itemRef: 'i1',
    entries: [entry(3, 'right', { itemRef: 'i1' }), entry(4, 'wrong', { itemRef: 'i1' })],
  });
  assert.equal(resolveByQuiz(topic, { itemRef: 'i1' }), 0);
  assert.equal(resolveByQuiz(topic, { itemRef: null }), 0);
  assert.equal(openQuestions(topic).length, 1);
});
