/**
 * learn.js — Learn 模式流程逻辑（访谈、计划推进、AI 计划解析；纯逻辑无 DOM）
 */
import { uid } from '../storage.js';
import { ITEM_STATUS } from './learn-store.js';
import { recordQuiz, resolveByQuiz, resolveQuestion } from './learn-quiz.js';

/** 开场访谈最多问几个问题 */
export const INTERVIEW_MAX_QUESTIONS = 3;

/** 访谈的跳过出口文案（提示词与面板共用） */
export const INTERVIEW_SKIP_HINT = '先按默认走，边聊边校准';

/** 访谈覆盖的三个状态字段与对应问题 */
export const INTERVIEW_FIELDS = [
  { key: 'priorStage', question: '你目前学到哪一步了？' },
  { key: 'goal', question: '这次想达到什么目标？' },
  { key: 'availability', question: '大概每周能投入多少时间？' },
];

/** 计划条目上限（与提示词里的生成约束一致） */
export const PLAN_MAX_ITEMS = 12;

/** AI 生成计划的输出格式说明（嵌入提示词，由 parsePlanItems 解析） */
export const PLAN_FORMAT_HINT_TEXT = [
  '生成或更新学习计划时，把计划作为 JSON 数组放进 ```plan 代码块输出；',
  '数组元素形如 {"title": "条目名", "note": "备注（可空）"}，最多 12 条，title 不超过 80 字。',
  '示例：',
  '```plan',
  '[{"title": "理解 Self-Attention 的动机", "note": "先看直觉图"}, {"title": "手写 QKV 计算", "note": ""}]',
  '```',
].join('\n');

/** 用户消息里的「推进计划」语义线索（模式一自动推进一格） */
const ADVANCE_CUE = /下一步|继续推进|继续下一个|接着学|推进下|换个话题/;

/** 仍未提供的状态字段 key 列表 */
export function missingProfile(topic) {
  return INTERVIEW_FIELDS.filter((f) => {
    const v = topic && topic[f.key];
    return !String(v == null ? '' : v).trim();
  }).map((f) => f.key);
}

/**
 * 是否需要开场访谈：计划模式、未访谈过、还没有计划、且缺状态。
 * 已生成计划或用户填过资料后不再重复问。
 */
export function needsInterview(topic) {
  if (!topic || topic.mode !== 'plan') return false;
  if (topic.interviewedAt || (topic.plan && topic.plan.items.length)) return false;
  return missingProfile(topic).length > 0;
}

/** 访谈简报：待问问题（不超过上限）与跳过出口 */
export function interviewBrief(topic) {
  const missing = missingProfile(topic);
  const questions = missing
    .slice(0, INTERVIEW_MAX_QUESTIONS)
    .map((key) => INTERVIEW_FIELDS.find((f) => f.key === key).question);
  return { questions, skipHint: INTERVIEW_SKIP_HINT, max: INTERVIEW_MAX_QUESTIONS };
}

/** 记录访谈结果（至少填了一项才算完成访谈；空值保持原样） */
export function applyProfile(topic, patch = {}, at = Date.now()) {
  let answered = false;
  for (const { key } of INTERVIEW_FIELDS) {
    const value = patch[key];
    if (typeof value !== 'string') continue;
    const clean = value.trim();
    if (clean) {
      topic[key] = clean;
      answered = true;
    }
  }
  if (answered) {
    topic.interviewedAt = Number.isFinite(at) ? at : Date.now();
    topic.updatedAt = topic.interviewedAt;
  }
  return topic;
}

/** 当前条目：优先进行中，其次第一条未开始 */
export function currentItem(topic) {
  const items = (topic && topic.plan && topic.plan.items) || [];
  return items.find((i) => i.status === 'doing') || items.find((i) => i.status === 'todo') || null;
}

/**
 * 用 AI 输出的条目重建计划；已完成（done）的同名条目保留完成状态。
 */
export function setPlanItems(topic, items, at = Date.now()) {
  const doneTitles = new Set(
    topic.plan.items.filter((i) => i.status === 'done').map((i) => i.title)
  );
  topic.plan.items = items.map((it) => ({
    id: uid(),
    title: it.title,
    note: it.note || '',
    status: doneTitles.has(it.title) ? 'done' : 'todo',
  }));
  topic.plan.updatedAt = Number.isFinite(at) ? at : Date.now();
  topic.updatedAt = topic.plan.updatedAt;
  return topic.plan.items;
}

/** 单条目状态流转；非法 id / 状态返回 null */
export function markItemStatus(topic, itemId, status, at = Date.now()) {
  if (!ITEM_STATUS.includes(status)) return null;
  const item = topic.plan.items.find((i) => i.id === itemId);
  if (!item || item.status === status) return null;
  item.status = status;
  topic.plan.updatedAt = Number.isFinite(at) ? at : Date.now();
  topic.updatedAt = topic.plan.updatedAt;
  return item;
}

/**
 * 推进一格：当前进行中 → 已完成，第一条未开始 → 进行中；
 * 没有进行中时仅启动第一条。全部完成或空计划返回 null。
 */
export function advancePlan(topic, at = Date.now()) {
  const items = topic.plan.items;
  if (!items.length) return null;
  let completed = null;
  const doing = items.find((i) => i.status === 'doing');
  if (doing) {
    doing.status = 'done';
    completed = doing;
  } else if (!items.some((i) => i.status === 'todo')) {
    return null; // 全部 done
  }
  const next = items.find((i) => i.status === 'todo');
  if (next) next.status = 'doing';
  topic.plan.updatedAt = Number.isFinite(at) ? at : Date.now();
  topic.updatedAt = topic.plan.updatedAt;
  return { completed, started: next || null };
}

/** 用户消息是否带有「推进计划」语义 */
export function detectAdvanceCue(text) {
  return ADVANCE_CUE.test(String(text || ''));
}

/**
 * 从 AI 回复里解析 ```plan（其次 ```json）代码块中的计划条目。
 * 解析失败或没有有效条目返回 null。
 */
export function parsePlanItems(text) {
  const src = String(text || '');
  const fence =
    src.match(/```plan\s*\n?([\s\S]*?)```/i) || src.match(/```json\s*\n?([\s\S]*?)```/i);
  if (!fence) return null;
  let parsed;
  try {
    parsed = JSON.parse(fence[1].trim());
  } catch {
    return null;
  }
  if (!Array.isArray(parsed)) return null;
  const items = [];
  for (const raw of parsed) {
    const title =
      typeof raw === 'string' ? raw : raw && typeof raw === 'object' ? raw.title || raw.name : '';
    const cleanTitle = String(title || '').trim().slice(0, 80);
    if (!cleanTitle) continue;
    const note = raw && typeof raw === 'object' ? String(raw.note == null ? '' : raw.note) : '';
    items.push({ title: cleanTitle, note: note.trim().slice(0, 200) });
    if (items.length >= PLAN_MAX_ITEMS) break;
  }
  return items.length ? items : null;
}


/* ---------------- �� AI �Ľṹ��Լ����quiz / verdict / review ---------------- */

/** ������ϰ������༸�⣨����ʾ�����Լ��һ�£� */
export const MAX_QUIZ_PER_BATCH = 3;

function matchFence(text, lang) {
  const re = new RegExp('```' + lang + '\\s*\\n?([\\s\\S]*?)```', 'i');
  return String(text || '').match(re);
}

/** ���� ```quiz �� �� [{ q }]������Ч��Ŀ���� null */
export function parseQuizBlock(text) {
  const fence = matchFence(text, 'quiz');
  if (!fence) return null;
  let parsed;
  try {
    parsed = JSON.parse(fence[1].trim());
  } catch {
    return null;
  }
  if (!Array.isArray(parsed)) return null;
  const items = [];
  for (const raw of parsed) {
    const q = typeof raw === 'string' ? raw : raw && (raw.q || raw.question);
    const clean = String(q || '').trim();
    if (!clean) continue;
    items.push({ q: clean.slice(0, 300) });
    if (items.length >= MAX_QUIZ_PER_BATCH) break;
  }
  return items.length ? items : null;
}

/** ���� ```verdict �� �� [{ i, v }]�����˷Ƿ��� */
export function parseVerdictBlock(text) {
  const fence = matchFence(text, 'verdict');
  if (!fence) return null;
  let parsed;
  try {
    parsed = JSON.parse(fence[1].trim());
  } catch {
    return null;
  }
  if (!Array.isArray(parsed)) return null;
  const out = [];
  for (const raw of parsed) {
    if (!raw || typeof raw !== 'object') continue;
    const i = Number(raw.i);
    const v = raw.v;
    if (!Number.isInteger(i) || i < 0) continue;
    if (v !== 'right' && v !== 'wrong') continue;
    out.push({ i, v });
  }
  return out.length ? out : null;
}

/** ���� ```review �� �� { title, body, advance, resolved }�����Ϸ����� null */
export function parseReviewBlock(text) {
  const fence = matchFence(text, 'review');
  if (!fence) return null;
  let parsed;
  try {
    parsed = JSON.parse(fence[1].trim());
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null;
  const title = String(parsed.title || '').trim().slice(0, 80);
  if (!title) return null;
  const body = String(parsed.body == null ? '' : parsed.body);
  const resolved = Array.isArray(parsed.resolved)
    ? parsed.resolved.map((x) => String(x || '').trim()).filter(Boolean).slice(0, 10)
    : [];
  return { title, body, advance: parsed.advance === true, resolved };
}

/** �ظ���� ```quiz �� �� ¼��һ��δ�ж����Σ�������ǰ�ƻ���Ŀ�����޿鷵�� null */
export function recordQuizFromReply(topic, text, { at = Date.now(), itemRef } = {}) {
  const items = parseQuizBlock(text);
  if (!items) return null;
  const ref =
    itemRef !== undefined ? itemRef : (currentItem(topic) && currentItem(topic).id) || null;
  return recordQuiz(topic, {
    at,
    itemRef: ref,
    entries: items.map((item) => ({
      question: item.q,
      verdict: 'unresolved',
      userAnswer: '',
      at,
    })),
  });
}

/**
 * �ظ���� ```verdict �� �� �Ǽǵ����һ����δ�ж�������Ρ�
 * userAnswer ȡ�û����ֻظ�ԭ�ģ�ȫ�� right ���й�����Ŀʱ���������������⡣
 * @returns {number} �Ǽǳɹ�������
 */
export function applyVerdicts(topic, text, { userAnswer = '', at = Date.now() } = {}) {
  const verdicts = parseVerdictBlock(text);
  if (!verdicts) return 0;
  const quiz = [...topic.quizzes].reverse().find((q) =>
    (q.entries || []).some((e) => e.verdict === 'unresolved')
  );
  if (!quiz) return 0;
  let changed = 0;
  for (const v of verdicts) {
    const entry = quiz.entries[v.i];
    if (!entry || entry.verdict !== 'unresolved') continue;
    entry.verdict = v.v;
    entry.userAnswer = String(userAnswer || '').slice(0, 500);
    entry.at = at;
    changed += 1;
  }
  if (changed) {
    topic.updatedAt = at;
    if (quiz.itemRef) resolveByQuiz(topic, { itemRef: quiz.itemRef, at });
  }
  return changed;
}

/**
 * �ظ���� ```review �� �� ���̽ṹ�������ģ��ɵ��÷� saveReview �־û�����
 * �޿鷵�� null��
 */
export function buildReviewFromReply(topic, text, { at = Date.now() } = {}) {
  const parsed = parseReviewBlock(text);
  if (!parsed) return null;
  const id = uid();
  return { id, at, title: parsed.title, body: parsed.body, bodyRef: id, advance: parsed.advance, resolved: parsed.resolved };
}

/**
 * �Ѹ���д�����⣺reviews ׷�� + �� advance �ƽ��ƻ� + �� resolved �������⡣
 * @returns {{advanced: boolean, resolvedCount: number}}
 */
export function applyReview(topic, review, { at = Date.now() } = {}) {
  topic.reviews = [
    ...(topic.reviews || []),
    { id: review.id, at: review.at, title: review.title, bodyRef: review.bodyRef },
  ];
  let advanced = false;
  if (review.advance && topic.mode === 'plan') advanced = !!advancePlan(topic, at);
  let resolvedCount = 0;
  for (const text of review.resolved || []) {
    const q = (topic.questions || []).find((x) => x.status === 'open' && x.text === text);
    if (q) {
      resolveQuestion(topic, q.id, { by: 'user', at });
      resolvedCount += 1;
    }
  }
  topic.updatedAt = at;
  return { advanced, resolvedCount };
}
