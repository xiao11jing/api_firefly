import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  INTERVIEW_FIELDS,
  INTERVIEW_MAX_QUESTIONS,
  INTERVIEW_SKIP_HINT,
  PLAN_MAX_ITEMS,
  advancePlan,
  applyProfile,
  currentItem,
  detectAdvanceCue,
  interviewBrief,
  markItemStatus,
  missingProfile,
  needsInterview,
  parsePlanItems,
  setPlanItems,
} from '../js/learn/learn.js';
import { createTopic, normalizeTopic } from '../js/learn/learn-store.js';

function planTopic(over = {}) {
  return normalizeTopic({
    id: 't1',
    name: 'Transformer',
    mode: 'plan',
    plan: { updatedAt: 1, items: [] },
    ...over,
  });
}

/* ---------------- 访谈 ---------------- */

test('计划模式缺状态且无计划时需要访谈，最多 3 问并带跳过出口', () => {
  const topic = planTopic();
  assert.deepEqual(missingProfile(topic), ['priorStage', 'goal', 'availability']);
  assert.equal(needsInterview(topic), true);

  const brief = interviewBrief(topic);
  assert.ok(brief.questions.length <= INTERVIEW_MAX_QUESTIONS);
  assert.equal(brief.questions.length, INTERVIEW_FIELDS.length);
  assert.ok(brief.questions.every((q) => typeof q === 'string' && q.endsWith('？')));
  assert.equal(brief.skipHint, INTERVIEW_SKIP_HINT);
  assert.equal(brief.max, 3);
});

test('陪伴模式、已有计划、已访谈或状态齐全都不再访谈', () => {
  const companion = normalizeTopic({ id: 't', name: 'x', mode: 'companion' });
  assert.equal(needsInterview(companion), false);

  const withPlan = planTopic();
  withPlan.plan.items.push({ id: 'i1', title: 'A', note: '', status: 'todo' });
  assert.equal(needsInterview(withPlan), false);

  const done = planTopic();
  applyProfile(done, { goal: '读懂论文', priorStage: '第三章', availability: '每天1小时' });
  assert.equal(needsInterview(done), false);
  assert.equal(done.interviewedAt > 0, true);

  const skipped = planTopic();
  applyProfile(skipped, {}, 123); // 全空不算访谈完成
  assert.equal(skipped.interviewedAt, null);
  assert.equal(needsInterview(skipped), true);
});

test('applyProfile 只写非空字段并去空白', () => {
  const topic = planTopic();
  topic.goal = '旧目标';
  applyProfile(topic, { goal: '  新目标  ', priorStage: '', availability: '  ' }, 999);
  assert.equal(topic.goal, '新目标');
  assert.equal(topic.priorStage, '');
  assert.equal(topic.availability, '');
  assert.equal(topic.interviewedAt, 999);
  // 已有值不被空串清掉
  applyProfile(topic, { goal: '' }, 1000);
  assert.equal(topic.goal, '新目标');
});

/* ---------------- 计划状态流转 ---------------- */

test('setPlanItems 重建计划并保留同名已完成条目', () => {
  const topic = planTopic();
  setPlanItems(topic, [{ title: 'A', note: '' }, { title: 'B', note: 'n' }], 10);
  topic.plan.items[0].status = 'done';

  setPlanItems(topic, [{ title: 'A' }, { title: 'C' }], 20);
  assert.deepEqual(
    topic.plan.items.map((i) => [i.title, i.status]),
    [['A', 'done'], ['C', 'todo']]
  );
  assert.equal(topic.plan.updatedAt, 20);
  assert.equal(topic.plan.items[1].note, '');
});

test('markItemStatus 合法流转与拒绝', () => {
  const topic = planTopic();
  setPlanItems(topic, [{ title: 'A' }], 1);
  const item = topic.plan.items[0];
  assert.equal(markItemStatus(topic, item.id, 'doing', 2).status, 'doing');
  assert.equal(markItemStatus(topic, item.id, 'doing', 3), null); // 同状态
  assert.equal(markItemStatus(topic, item.id, 'hacked', 4), null); // 非法状态
  assert.equal(markItemStatus(topic, 'missing', 'done', 5), null); // 非法 id
  assert.equal(markItemStatus(topic, item.id, 'done', 6).status, 'done');
  assert.equal(topic.plan.updatedAt, 6);
});

test('advancePlan：进行中完成并启动下一条', () => {
  const topic = planTopic();
  setPlanItems(topic, [{ title: 'A' }, { title: 'B' }], 1);
  markItemStatus(topic, topic.plan.items[0].id, 'doing', 2);

  const moved = advancePlan(topic, 3);
  assert.equal(moved.completed.title, 'A');
  assert.equal(moved.started.title, 'B');
  assert.deepEqual(topic.plan.items.map((i) => i.status), ['done', 'doing']);
  assert.equal(topic.plan.updatedAt, 3);
});

test('advancePlan：无进行中时启动第一条；全部完成返回 null', () => {
  const fresh = planTopic();
  setPlanItems(fresh, [{ title: 'A' }, { title: 'B' }], 1);
  const started = advancePlan(fresh, 2);
  assert.equal(started.completed, null);
  assert.equal(started.started.title, 'A');
  assert.equal(fresh.plan.items[0].status, 'doing');

  const finished = planTopic();
  setPlanItems(finished, [{ title: 'A' }], 1);
  advancePlan(finished, 2); // A → doing
  const last = advancePlan(finished, 3); // A → done，无下一条
  assert.equal(last.completed.title, 'A');
  assert.equal(last.started, null);
  assert.equal(advancePlan(finished, 4), null); // 全部完成
  assert.equal(advancePlan(planTopic(), 5), null); // 空计划
});

test('currentItem 优先进行中，其次第一条未开始', () => {
  const topic = planTopic();
  assert.equal(currentItem(topic), null);
  setPlanItems(topic, [{ title: 'A' }, { title: 'B' }], 1);
  assert.equal(currentItem(topic).title, 'A'); // 第一条 todo
  markItemStatus(topic, topic.plan.items[1].id, 'doing', 2);
  assert.equal(currentItem(topic).title, 'B'); // doing 优先
  topic.plan.items.forEach((i) => { i.status = 'done'; });
  assert.equal(currentItem(topic), null);
});

/* ---------------- 推进语与计划解析 ---------------- */

test('detectAdvanceCue 识别推进语而非普通句子', () => {
  for (const s of ['下一步', '我们继续推进', '换个话题吧', '接着学第四章', '继续下一个知识点']) {
    assert.equal(detectAdvanceCue(s), true, s);
  }
  for (const s of ['', '这个概念怎么理解', '请解释 QKV', '计划先放一放']) {
    assert.equal(detectAdvanceCue(s), false, JSON.stringify(s));
  }
  assert.equal(detectAdvanceCue(null), false);
});

test('parsePlanItems 解析 ```plan 代码块', () => {
  const reply = [
    '好的，计划如下：',
    '',
    '```plan',
    '[{"title": "理解 Self-Attention", "note": "先看直觉图"}, {"title": "手写 QKV", "note": ""}]',
    '```',
    '先从第一条开始。',
  ].join('\n');
  const items = parsePlanItems(reply);
  assert.equal(items.length, 2);
  assert.deepEqual(items[0], { title: '理解 Self-Attention', note: '先看直觉图' });
  assert.equal(items[1].title, '手写 QKV');
});

test('parsePlanItems 支持 json 块与字符串数组，拒绝非法输入', () => {
  assert.deepEqual(parsePlanItems('```json\n["A", "B"]\n```'), [
    { title: 'A', note: '' },
    { title: 'B', note: '' },
  ]);
  assert.equal(parsePlanItems('```plan\n{not json}\n```'), null);
  assert.equal(parsePlanItems('```plan\n{"title":"A"}\n```'), null); // 非数组
  assert.equal(parsePlanItems('没有任何代码块'), null);
  assert.equal(parsePlanItems('```plan\n[]\n```'), null); // 空数组
  assert.equal(parsePlanItems('```plan\n[{"title":"  "}]\n```'), null); // 全空白标题
  assert.equal(parsePlanItems(''), null);
});

test('parsePlanItems 截断超长并限制条目上限', () => {
  const many = JSON.stringify(
    Array.from({ length: PLAN_MAX_ITEMS + 3 }, (_, i) => ({ title: `条目${i}` }))
  );
  const items = parsePlanItems('```plan\n' + many + '\n```');
  assert.equal(items.length, PLAN_MAX_ITEMS);

  const long = parsePlanItems('```plan\n[{"title":"' + 'x'.repeat(120) + '"}]\n```');
  assert.equal(long[0].title.length, 80);
});
