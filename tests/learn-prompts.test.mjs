import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  LEARN_IDENTITY,
  LEARN_SYSTEM,
  MODE_COMPANION,
  MODE_PLAN,
  assembleLearnSystem,
  buildTopicContext,
} from '../js/learn/learn-prompts.js';
import { PLAN_FORMAT_HINT_TEXT, applyProfile, setPlanItems } from '../js/learn/learn.js';
import { addQuestion } from '../js/learn/learn-quiz.js';
import { createTopic, normalizeTopic } from '../js/learn/learn-store.js';

function planTopic(over = {}) {
  return normalizeTopic({
    id: 't1',
    name: 'Transformer 架构',
    mode: 'plan',
    ...over,
  });
}

function companionTopic(over = {}) {
  return normalizeTopic({ id: 't2', name: '英语精读', mode: 'companion', ...over });
}

/* ---------------- 装配顺序与模式差异 ---------------- */

test('装配顺序：常驻规则 → 人格 → 模式 → 上下文 → 用户模板', () => {
  const topic = planTopic();
  const userText = '用户的自定义系统提示';
  const full = assembleLearnSystem({ topic, userText });

  const order = [
    LEARN_SYSTEM,
    LEARN_IDENTITY,
    MODE_PLAN,
    '## 当前学习上下文',
    userText,
  ].map((part) => full.indexOf(part));
  assert.ok(order.every((i) => i >= 0), `缺失片段：${JSON.stringify(order)}`);
  for (let i = 1; i < order.length; i++) {
    assert.ok(order[i] > order[i - 1], `第 ${i} 段顺序错误：${JSON.stringify(order)}`);
  }
});

test('模式差异：计划驱动带 MODE_PLAN，陪伴带 MODE_COMPANION，互不掺入', () => {
  const plan = assembleLearnSystem({ topic: planTopic() });
  assert.ok(plan.includes(MODE_PLAN));
  assert.ok(!plan.includes(MODE_COMPANION));

  const companion = assembleLearnSystem({ topic: companionTopic() });
  assert.ok(companion.includes(MODE_COMPANION));
  assert.ok(!companion.includes(MODE_PLAN));
});

test('无主题时原样返回用户模板，空模板返回空串', () => {
  assert.equal(assembleLearnSystem({ topic: null, userText: '  仅用户模板  ' }), '仅用户模板');
  assert.equal(assembleLearnSystem({ topic: null }), '');
  assert.equal(assembleLearnSystem({ topic: planTopic(), userText: '' }).includes(LEARN_SYSTEM), true);
});

/* ---------------- 常驻规则与模式文案 ---------------- */

test('常驻规则覆盖只读目录、禁机械百分比与禁伪造写入', () => {
  assert.ok(LEARN_SYSTEM.includes('materials/'));
  assert.ok(LEARN_SYSTEM.includes('只读'));
  assert.ok(LEARN_SYSTEM.includes('learn/plan.md'));
  assert.ok(LEARN_SYSTEM.includes('不得声称已经写入'));
  assert.ok(LEARN_SYSTEM.includes('不输出「掌握度 xx%」'));
  assert.ok(LEARN_SYSTEM.includes('txt、md、json、pdf'));
});

test('计划模式包含访谈上限、跳过出口与计划格式', () => {
  assert.ok(MODE_PLAN.includes('最多问 3 个问题'));
  assert.ok(MODE_PLAN.includes('先按默认走，边聊边校准'));
  assert.ok(MODE_PLAN.includes(PLAN_FORMAT_HINT_TEXT));
  assert.ok(MODE_PLAN.includes('主动提议更新计划'));
  assert.ok(MODE_PLAN.includes('让用户先作答'));
});

test('陪伴模式不主导节奏且克制纠错', () => {
  assert.ok(MODE_COMPANION.includes('不制定计划'));
  assert.ok(MODE_COMPANION.includes('默认不主动纠错'));
  assert.ok(MODE_COMPANION.includes('他说继续才推进'));
});

/* ---------------- 动态上下文 ---------------- */

test('缺状态的计划主题在上下文里给出访谈三问与跳过出口', () => {
  const ctx = buildTopicContext(planTopic());
  assert.ok(ctx.includes('### 开场访谈'));
  assert.ok(ctx.includes('1. 你目前学到哪一步了？'));
  assert.ok(ctx.includes('2. 这次想达到什么目标？'));
  assert.ok(ctx.includes('3. 大概每周能投入多少时间？'));
  assert.ok(ctx.includes('先按默认走，边聊边校准'));
  assert.ok(ctx.includes('尚未生成计划'));
});

test('填完状态或生成计划后不再出现访谈指示', () => {
  const topic = planTopic();
  applyProfile(topic, { goal: '读懂论文', priorStage: '第三章', availability: '每天一小时' });
  setPlanItems(topic, [{ title: '条目一' }], 10);
  const ctx = buildTopicContext(topic);
  assert.ok(!ctx.includes('开场访谈'));
  assert.ok(ctx.includes('目标：读懂论文'));
  assert.ok(ctx.includes('[未开始] 条目一'));
  assert.ok(!ctx.includes('尚未生成计划'));
});

test('上下文列出计划状态、待解决问题与资料清单', () => {
  const topic = planTopic();
  setPlanItems(topic, [{ title: 'A' }, { title: 'B' }], 1);
  topic.plan.items[0].status = 'doing';
  topic.plan.items[1].status = 'done';
  addQuestion(topic, 'QKV 还没懂', { source: 'chat' });
  topic.materials.push({
    id: 'm1',
    name: 'notes.md',
    kind: 'text',
    size: 10,
    addedAt: 1,
    summary: '',
    truncated: false,
  });

  const ctx = buildTopicContext(topic);
  assert.ok(ctx.includes('共 2 条，已完成 1'));
  assert.ok(ctx.includes('[进行中] A'));
  assert.ok(ctx.includes('[已完成] B'));
  assert.ok(ctx.includes('### 待解决问题'));
  assert.ok(ctx.includes('QKV 还没懂'));
  assert.ok(ctx.includes('### 资料库（只读）'));
  assert.ok(ctx.includes('notes.md（text）'));
});

test('陪伴主题的上下文不含计划小节', () => {
  const ctx = buildTopicContext(companionTopic());
  assert.ok(!ctx.includes('### 学习计划'));
  assert.ok(ctx.includes('模式：陪伴'));
  assert.equal(buildTopicContext(null), '');
});

test('createTopic 默认陪伴模式，上下文标注模式', () => {
  const topic = createTopic({ name: '测试主题', at: 1 });
  assert.equal(topic.mode, 'companion');
  const ctx = buildTopicContext(topic);
  assert.ok(ctx.includes('主题：测试主题（模式：陪伴）'));
});
