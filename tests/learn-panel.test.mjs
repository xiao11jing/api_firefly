import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildPanelModel, emptyPanelModel } from '../js/learn/learn-panel.js';
import { addQuestion, recordQuiz, resolveQuestion } from '../js/learn/learn-quiz.js';
import { applyProfile, setPlanItems } from '../js/learn/learn.js';
import { normalizeTopic } from '../js/learn/learn-store.js';

function topic(over = {}) {
  return normalizeTopic({ id: 't1', name: 'Transformer', mode: 'plan', ...over });
}

test('未关联主题返回空态模型', () => {
  const model = buildPanelModel(null);
  assert.equal(model.empty, true);
  assert.ok(model.emptyHint.includes('未关联'));
  assert.deepEqual(emptyPanelModel(), model);
});

test('计划状态：条目映射、完成度与百分比', () => {
  const t = topic();
  setPlanItems(t, [{ title: 'A' }, { title: 'B' }, { title: 'C' }], 1);
  t.plan.items[0].status = 'done';
  t.plan.items[1].status = 'doing';

  const model = buildPanelModel(t);
  assert.equal(model.empty, false);
  assert.equal(model.name, 'Transformer');
  assert.equal(model.modeLabel, '计划驱动');
  assert.equal(model.plan.total, 3);
  assert.equal(model.plan.done, 1);
  assert.equal(model.plan.percent, 33);
  assert.deepEqual(
    model.plan.items.map((i) => [i.title, i.status]),
    [['A', 'done'], ['B', 'doing'], ['C', 'todo']]
  );
});

test('空计划：total 0、percent 0，陪伴模式标注', () => {
  const model = buildPanelModel(normalizeTopic({ id: 't', name: 'x', mode: 'companion' }));
  assert.equal(model.plan.total, 0);
  assert.equal(model.plan.percent, 0);
  assert.equal(model.modeLabel, '陪伴');
  assert.equal(model.accuracy.considered, 0);
});

test('正确率：窗口口径文本与百分比', () => {
  const t = topic();
  recordQuiz(t, {
    at: 10,
    entries: [
      { at: 10, question: 'q1', verdict: 'right' },
      { at: 11, question: 'q2', verdict: 'wrong' },
      { at: 12, question: 'q3', verdict: 'unresolved' },
    ],
  });
  const model = buildPanelModel(t);
  assert.equal(model.accuracy.considered, 2);
  assert.equal(model.accuracy.right, 1);
  assert.equal(model.accuracy.percent, 50);
  assert.equal(model.accuracy.excluded, 1);
  assert.ok(model.accuracy.text.includes('近'));
  assert.ok(model.accuracy.text.includes('AI 判定'));
  assert.ok(model.accuracy.text.includes('3 条'), 'text 用窗口条数');
});

test('无作答时正确率显示暂无记录', () => {
  const model = buildPanelModel(topic());
  assert.equal(model.accuracy.percent, null);
  assert.equal(model.accuracy.considered, 0);
  assert.ok(model.accuracy.text.includes('暂无'));
});

test('待解决问题只含 open，resolved 不出现', () => {
  const t = topic();
  const q1 = addQuestion(t, '困惑一', { source: 'chat' });
  addQuestion(t, '困惑二', { source: 'quiz' });
  resolveQuestion(t, q1.id, { by: 'user', at: 5 });

  const model = buildPanelModel(t);
  assert.equal(model.questions.length, 1);
  assert.equal(model.questions[0].text, '困惑二');
});

test('计划模式缺状态时标记访谈待办', () => {
  assert.equal(buildPanelModel(topic()).interviewPending, true);
  const filled = topic();
  applyProfile(filled, { goal: 'g', priorStage: 's', availability: 'a' });
  assert.equal(buildPanelModel(filled).interviewPending, false);
});
