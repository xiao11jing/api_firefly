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

/* ---------------- è®¿è°ˆ ---------------- */

test('è®¡åˆ’æ¨¡å¼ç¼ºçŠ¶æ€ä¸”æ— è®¡åˆ’æ—¶éœ€è¦è®¿è°ˆï¼Œæœ€å¤š 3 é—®å¹¶å¸¦è·³è¿‡å‡ºå£', () => {
  const topic = planTopic();
  assert.deepEqual(missingProfile(topic), ['priorStage', 'goal', 'availability']);
  assert.equal(needsInterview(topic), true);

  const brief = interviewBrief(topic);
  assert.ok(brief.questions.length <= INTERVIEW_MAX_QUESTIONS);
  assert.equal(brief.questions.length, INTERVIEW_FIELDS.length);
  assert.ok(brief.questions.every((q) => typeof q === 'string' && q.endsWith('ï¼Ÿ')));
  assert.equal(brief.skipHint, INTERVIEW_SKIP_HINT);
  assert.equal(brief.max, 3);
});

test('é™ªä¼´æ¨¡å¼ã€å·²æœ‰è®¡åˆ’ã€å·²è®¿è°ˆæˆ–çŠ¶æ€é½å…¨éƒ½ä¸å†è®¿è°ˆ', () => {
  const companion = normalizeTopic({ id: 't', name: 'x', mode: 'companion' });
  assert.equal(needsInterview(companion), false);

  const withPlan = planTopic();
  withPlan.plan.items.push({ id: 'i1', title: 'A', note: '', status: 'todo' });
  assert.equal(needsInterview(withPlan), false);

  const done = planTopic();
  applyProfile(done, { goal: 'è¯»æ‡‚è®ºæ–‡', priorStage: 'ç¬¬ä¸‰ç« ', availability: 'æ¯å¤©1å°æ—¶' });
  assert.equal(needsInterview(done), false);
  assert.equal(done.interviewedAt > 0, true);

  const skipped = planTopic();
  applyProfile(skipped, {}, 123); // å…¨ç©ºä¸ç®—è®¿è°ˆå®Œæˆ
  assert.equal(skipped.interviewedAt, null);
  assert.equal(needsInterview(skipped), true);
});

test('applyProfile åªå†™éžç©ºå­—æ®µå¹¶åŽ»ç©ºç™½', () => {
  const topic = planTopic();
  topic.goal = 'æ—§ç›®æ ‡';
  applyProfile(topic, { goal: '  æ–°ç›®æ ‡  ', priorStage: '', availability: '  ' }, 999);
  assert.equal(topic.goal, 'æ–°ç›®æ ‡');
  assert.equal(topic.priorStage, '');
  assert.equal(topic.availability, '');
  assert.equal(topic.interviewedAt, 999);
  // å·²æœ‰å€¼ä¸è¢«ç©ºä¸²æ¸…æŽ‰
  applyProfile(topic, { goal: '' }, 1000);
  assert.equal(topic.goal, 'æ–°ç›®æ ‡');
});

/* ---------------- è®¡åˆ’çŠ¶æ€æµè½¬ ---------------- */

test('setPlanItems é‡å»ºè®¡åˆ’å¹¶ä¿ç•™åŒåå·²å®Œæˆæ¡ç›®', () => {
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

test('markItemStatus åˆæ³•æµè½¬ä¸Žæ‹’ç»', () => {
  const topic = planTopic();
  setPlanItems(topic, [{ title: 'A' }], 1);
  const item = topic.plan.items[0];
  assert.equal(markItemStatus(topic, item.id, 'doing', 2).status, 'doing');
  assert.equal(markItemStatus(topic, item.id, 'doing', 3), null); // åŒçŠ¶æ€
  assert.equal(markItemStatus(topic, item.id, 'hacked', 4), null); // éžæ³•çŠ¶æ€
  assert.equal(markItemStatus(topic, 'missing', 'done', 5), null); // éžæ³• id
  assert.equal(markItemStatus(topic, item.id, 'done', 6).status, 'done');
  assert.equal(topic.plan.updatedAt, 6);
});

test('advancePlanï¼šè¿›è¡Œä¸­å®Œæˆå¹¶å¯åŠ¨ä¸‹ä¸€æ¡', () => {
  const topic = planTopic();
  setPlanItems(topic, [{ title: 'A' }, { title: 'B' }], 1);
  markItemStatus(topic, topic.plan.items[0].id, 'doing', 2);

  const moved = advancePlan(topic, 3);
  assert.equal(moved.completed.title, 'A');
  assert.equal(moved.started.title, 'B');
  assert.deepEqual(topic.plan.items.map((i) => i.status), ['done', 'doing']);
  assert.equal(topic.plan.updatedAt, 3);
});

test('advancePlanï¼šæ— è¿›è¡Œä¸­æ—¶å¯åŠ¨ç¬¬ä¸€æ¡ï¼›å…¨éƒ¨å®Œæˆè¿”å›ž null', () => {
  const fresh = planTopic();
  setPlanItems(fresh, [{ title: 'A' }, { title: 'B' }], 1);
  const started = advancePlan(fresh, 2);
  assert.equal(started.completed, null);
  assert.equal(started.started.title, 'A');
  assert.equal(fresh.plan.items[0].status, 'doing');

  const finished = planTopic();
  setPlanItems(finished, [{ title: 'A' }], 1);
  advancePlan(finished, 2); // A â†’ doing
  const last = advancePlan(finished, 3); // A â†’ doneï¼Œæ— ä¸‹ä¸€æ¡
  assert.equal(last.completed.title, 'A');
  assert.equal(last.started, null);
  assert.equal(advancePlan(finished, 4), null); // å…¨éƒ¨å®Œæˆ
  assert.equal(advancePlan(planTopic(), 5), null); // ç©ºè®¡åˆ’
});

test('currentItem ä¼˜å…ˆè¿›è¡Œä¸­ï¼Œå…¶æ¬¡ç¬¬ä¸€æ¡æœªå¼€å§‹', () => {
  const topic = planTopic();
  assert.equal(currentItem(topic), null);
  setPlanItems(topic, [{ title: 'A' }, { title: 'B' }], 1);
  assert.equal(currentItem(topic).title, 'A'); // ç¬¬ä¸€æ¡ todo
  markItemStatus(topic, topic.plan.items[1].id, 'doing', 2);
  assert.equal(currentItem(topic).title, 'B'); // doing ä¼˜å…ˆ
  topic.plan.items.forEach((i) => { i.status = 'done'; });
  assert.equal(currentItem(topic), null);
});

/* ---------------- æŽ¨è¿›è¯­ä¸Žè®¡åˆ’è§£æž ---------------- */

test('detectAdvanceCue è¯†åˆ«æŽ¨è¿›è¯­è€Œéžæ™®é€šå¥å­', () => {
  for (const s of ['ä¸‹ä¸€æ­¥', 'æˆ‘ä»¬ç»§ç»­æŽ¨è¿›', 'æ¢ä¸ªè¯é¢˜å§', 'æŽ¥ç€å­¦ç¬¬å››ç« ', 'ç»§ç»­ä¸‹ä¸€ä¸ªçŸ¥è¯†ç‚¹']) {
    assert.equal(detectAdvanceCue(s), true, s);
  }
  for (const s of ['', 'è¿™ä¸ªæ¦‚å¿µæ€Žä¹ˆç†è§£', 'è¯·è§£é‡Š QKV', 'è®¡åˆ’å…ˆæ”¾ä¸€æ”¾']) {
    assert.equal(detectAdvanceCue(s), false, JSON.stringify(s));
  }
  assert.equal(detectAdvanceCue(null), false);
});

test('parsePlanItems è§£æž ```plan ä»£ç å—', () => {
  const reply = [
    'å¥½çš„ï¼Œè®¡åˆ’å¦‚ä¸‹ï¼š',
    '',
    '```plan',
    '[{"title": "ç†è§£ Self-Attention", "note": "å…ˆçœ‹ç›´è§‰å›¾"}, {"title": "æ‰‹å†™ QKV", "note": ""}]',
    '```',
    'å…ˆä»Žç¬¬ä¸€æ¡å¼€å§‹ã€‚',
  ].join('\n');
  const items = parsePlanItems(reply);
  assert.equal(items.length, 2);
  assert.deepEqual(items[0], { title: 'ç†è§£ Self-Attention', note: 'å…ˆçœ‹ç›´è§‰å›¾' });
  assert.equal(items[1].title, 'æ‰‹å†™ QKV');
});

test('parsePlanItems æ”¯æŒ json å—ä¸Žå­—ç¬¦ä¸²æ•°ç»„ï¼Œæ‹’ç»éžæ³•è¾“å…¥', () => {
  assert.deepEqual(parsePlanItems('```json\n["A", "B"]\n```'), [
    { title: 'A', note: '' },
    { title: 'B', note: '' },
  ]);
  assert.equal(parsePlanItems('```plan\n{not json}\n```'), null);
  assert.equal(parsePlanItems('```plan\n{"title":"A"}\n```'), null); // éžæ•°ç»„
  assert.equal(parsePlanItems('æ²¡æœ‰ä»»ä½•ä»£ç å—'), null);
  assert.equal(parsePlanItems('```plan\n[]\n```'), null); // ç©ºæ•°ç»„
  assert.equal(parsePlanItems('```plan\n[{"title":"  "}]\n```'), null); // å…¨ç©ºç™½æ ‡é¢˜
  assert.equal(parsePlanItems(''), null);
});

test('parsePlanItems æˆªæ–­è¶…é•¿å¹¶é™åˆ¶æ¡ç›®ä¸Šé™', () => {
  const many = JSON.stringify(
    Array.from({ length: PLAN_MAX_ITEMS + 3 }, (_, i) => ({ title: `æ¡ç›®${i}` }))
  );
  const items = parsePlanItems('```plan\n' + many + '\n```');
  assert.equal(items.length, PLAN_MAX_ITEMS);

  const long = parsePlanItems('```plan\n[{"title":"' + 'x'.repeat(120) + '"}]\n```');
  assert.equal(long[0].title.length, 80);
});


/* ---------------- quiz / verdict / review ½á¹¹»¯¿é ---------------- */

import {
  MAX_QUIZ_PER_BATCH,
  applyReview,
  applyVerdicts,
  buildReviewFromReply,
  parseQuizBlock,
  parseReviewBlock,
  parseVerdictBlock,
  recordQuizFromReply,
} from '../js/learn/learn.js';

test('parseQuizBlock£ºÌâÄ¿Êý×é¡¢×Ö·û´®ÏîÓëÉÏÏÞ', () => {
  const text = 'Á·Ï°£º\n```quiz\n[{"q": "ÌâÄ¿Ò»"}, {"question": "ÌâÄ¿¶þ"}, "ÌâÄ¿Èý", "ÌâÄ¿ËÄ"]\n```\n';
  const items = parseQuizBlock(text);
  assert.equal(items.length, MAX_QUIZ_PER_BATCH); // µÚ 4 Ìâ±»½Ø¶Ï
  assert.deepEqual(items.map((i) => i.q), ['ÌâÄ¿Ò»', 'ÌâÄ¿¶þ', 'ÌâÄ¿Èý']);

  assert.equal(parseQuizBlock('```quiz\n[]\n```'), null);
  assert.equal(parseQuizBlock('```quiz\n[{"q":"  "}]\n```'), null);
  assert.equal(parseQuizBlock('```quiz\n{bad}\n```'), null);
  assert.equal(parseQuizBlock('Ã»ÓÐ´úÂë¿é'), null);
});

test('parseVerdictBlock£º¹ýÂË·Ç·¨Ïî', () => {
  const items = parseVerdictBlock('```verdict\n[{"i":0,"v":"right"},{"i":1,"v":"wrong"},{"i":-1,"v":"right"},{"i":2,"v":"maybe"},{"i":"x","v":"right"},5]\n```');
  assert.deepEqual(items, [
    { i: 0, v: 'right' },
    { i: 1, v: 'wrong' },
  ]);
  assert.equal(parseVerdictBlock('```verdict\n[]\n```'), null);
  assert.equal(parseVerdictBlock('```verdict\nnope\n```'), null);
  assert.equal(parseVerdictBlock('ÎÞ¿é'), null);
});

test('parseReviewBlock£ººÏ·¨ÓëÄ¬ÈÏÖµ', () => {
  const ok = parseReviewBlock('```review\n{"title":"¸´ÅÌÒ»","body":"## Òªµã\\n- a","advance":true,"resolved":["ÎÊÌâ¼×"]}\n```');
  assert.deepEqual(ok, {
    title: '¸´ÅÌÒ»',
    body: '## Òªµã\n- a',
    advance: true,
    resolved: ['ÎÊÌâ¼×'],
  });

  const minimal = parseReviewBlock('```review\n{"title":"Ö»ÓÐ±êÌâ"}\n```');
  assert.equal(minimal.body, '');
  assert.equal(minimal.advance, false);
  assert.deepEqual(minimal.resolved, []);

  assert.equal(parseReviewBlock('```review\n{"body":"Ã»ÓÐ±êÌâ"}\n```'), null);
  assert.equal(parseReviewBlock('```review\n[1,2]\n```'), null);
  assert.equal(parseReviewBlock('ÎÞ¿é'), null);
});

test('recordQuizFromReply£ºÂ¼ÈëÎ´ÅÐ¶¨Åú´Î²¢¹ØÁªµ±Ç°ÌõÄ¿', () => {
  const t = planTopic();
  assert.equal(recordQuizFromReply(t, 'Ã»ÓÐÌâÄ¿'), null);

  setPlanItems(t, [{ title: 'A' }, { title: 'B' }], 1);
  markItemStatus(t, t.plan.items[1].id, 'doing', 2); // µ±Ç°ÌõÄ¿ = B

  const quiz = recordQuizFromReply(t, '```quiz\n[{"q":"Q1"},{"q":"Q2"}]\n```', { at: 10 });
  assert.equal(t.quizzes.length, 1);
  assert.equal(quiz.entries.length, 2);
  assert.equal(quiz.itemRef, t.plan.items[1].id);
  assert.ok(quiz.entries.every((e) => e.verdict === 'unresolved' && e.userAnswer === ''));
});

test('applyVerdicts£ºµÇ¼Çµ½×î½üÎ´ÅÐ¶¨Åú´Î£¬´øÓÃ»§×÷´ðÔ­ÎÄ', () => {
  const t = planTopic();
  setPlanItems(t, [{ title: 'A' }], 1);
  recordQuizFromReply(t, '```quiz\n[{"q":"Q1"}]\n```', { at: 10 });

  // »¹Ã»ÓÐÅú´ÎÊ±·µ»Ø 0
  const empty = planTopic();
  assert.equal(applyVerdicts(empty, '```verdict\n[{"i":0,"v":"right"}]\n```'), 0);

  const n = applyVerdicts(t, '```verdict\n[{"i":0,"v":"right"}]\n```', {
    userAnswer: '´ð£º²éÑ¯¼üÖµ',
    at: 20,
  });
  assert.equal(n, 1);
  const entry = t.quizzes[0].entries[0];
  assert.equal(entry.verdict, 'right');
  assert.equal(entry.userAnswer, '´ð£º²éÑ¯¼üÖµ');

  // ÒÑÅÐ¶¨ºó²»ÔÙÖØ¸´µÇ¼Ç
  assert.equal(applyVerdicts(t, '```verdict\n[{"i":0,"v":"wrong"}]\n```', { at: 21 }), 0);
  // Ô½½çÐòºÅ±»ºöÂÔ
  const t2 = planTopic();
  recordQuizFromReply(t2, '```quiz\n[{"q":"Q1"}]\n```', { at: 10 });
  assert.equal(applyVerdicts(t2, '```verdict\n[{"i":5,"v":"right"}]\n```'), 0);
});

test('applyReview£º×·¼Ó¸´ÅÌ¡¢°´ advance ÍÆ½ø¼Æ»®¡¢°´ resolved Ïû½âÎÊÌâ', () => {
  const t = planTopic();
  setPlanItems(t, [{ title: 'A' }, { title: 'B' }], 1);
  markItemStatus(t, t.plan.items[0].id, 'doing', 2);
  const q = addQuestion(t, 'QKV À§»ó', { source: 'chat' });

  const review = buildReviewFromReply(t, '```review\n{"title":"¸´ÅÌ","body":"ÕýÎÄ","advance":true,"resolved":["QKV À§»ó"]}\n```', { at: 30 });
  assert.ok(review);
  const result = applyReview(t, review, { at: 30 });

  assert.equal(t.reviews.length, 1);
  assert.equal(t.reviews[0].title, '¸´ÅÌ');
  assert.equal(t.reviews[0].bodyRef, review.id);
  assert.equal(result.advanced, true);
  assert.equal(result.resolvedCount, 1);
  assert.deepEqual(t.plan.items.map((i) => i.status), ['done', 'doing']);
  assert.equal(t.questions.find((x) => x.id === q.id).status, 'resolved');

  // ÎÞ¿é·µ»Ø null
  assert.equal(buildReviewFromReply(t, 'ÆÕÍ¨»Ø¸´'), null);
  // Åã°éÄ£Ê½²»ÍÆ½ø¼Æ»®
  const c = normalizeTopic({ id: 'c', name: 'x', mode: 'companion' });
  const rev2 = buildReviewFromReply(c, '```review\n{"title":"r","advance":true}\n```', { at: 1 });
  const r2 = applyReview(c, rev2, { at: 1 });
  assert.equal(r2.advanced, false);
  assert.equal(c.reviews.length, 1);
});


import { addQuestion } from '../js/learn/learn-quiz.js';
