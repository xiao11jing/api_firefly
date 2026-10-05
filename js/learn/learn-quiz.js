/**
 * learn-quiz.js — 练习作答记录、正确率窗口与问题状态机（纯逻辑，无 DOM / 存储依赖）
 *
 * 口径约定（见 learn_project.md §3.3）：
 * - 正确率只统计 right/wrong；unresolved（未判定）与 overruled（用户推翻）不进分母
 * - 窗口默认取近 ACCURACY_WINDOW 条作答，面板展示时需标注「AI 判定」
 * - 作答记录只增不改；推翻走 overruleEntry（改 verdict 并登记待解决问题）
 */
import { uid } from '../storage.js';

/** 正确率默认统计窗口（近 N 条作答） */
export const ACCURACY_WINDOW = 10;

/** 相关练习连续答对 N 次即视为解决（resolveByQuiz） */
export const QUIZ_STREAK = 2;

/** 合法判定与问题来源 */
export const VERDICTS = ['right', 'wrong', 'unresolved', 'overruled'];
export const QUESTION_SOURCES = ['chat', 'quiz', 'overrule'];

const COUNTED_VERDICTS = new Set(['right', 'wrong']);

export function normalizeVerdict(value) {
  return VERDICTS.includes(value) ? value : 'unresolved';
}

/** 归一化单条作答记录 */
export function normalizeEntry(entry = {}, fallbackAt = Date.now()) {
  const at = Number.isFinite(entry.at) ? entry.at : fallbackAt;
  return {
    id: entry.id || uid(),
    at,
    question: String(entry.question || '').trim(),
    userAnswer: String(entry.userAnswer == null ? '' : entry.userAnswer),
    verdict: normalizeVerdict(entry.verdict),
    judgedBy: entry.judgedBy === 'user' ? 'user' : 'ai',
    itemRef: typeof entry.itemRef === 'string' && entry.itemRef ? entry.itemRef : null,
  };
}

/** 全部作答记录（按时间升序；缺失时间视为 0 排在最前） */
export function allEntries(topic) {
  const out = [];
  for (const quiz of (topic && topic.quizzes) || []) {
    if (!quiz || !Array.isArray(quiz.entries)) continue;
    for (const entry of quiz.entries) {
      if (!entry) continue;
      out.push({ ...entry, quizId: quiz.id, itemRef: entry.itemRef ?? quiz.itemRef ?? null });
    }
  }
  return out.sort((a, b) => (Number(a.at) || 0) - (Number(b.at) || 0));
}

/** 近 N 条作答（limit <= 0 表示不限） */
export function recentEntries(topic, limit = ACCURACY_WINDOW) {
  const all = allEntries(topic);
  return limit > 0 ? all.slice(-limit) : all;
}

/**
 * 正确率统计。
 * @returns {{window:number, right:number, wrong:number, considered:number,
 *            excluded:number, ratio:number|null}}
 * ratio 为 null 表示窗口内没有可计入的作答（分母为 0）。
 */
export function computeAccuracy(topic, { window = ACCURACY_WINDOW } = {}) {
  const recent = recentEntries(topic, window);
  const counted = recent.filter((e) => COUNTED_VERDICTS.has(e.verdict));
  const right = counted.filter((e) => e.verdict === 'right').length;
  const wrong = counted.length - right;
  return {
    window: recent.length,
    right,
    wrong,
    considered: counted.length,
    excluded: recent.length - counted.length,
    ratio: counted.length ? right / counted.length : null,
  };
}

/** 追加一个练习批次，返回归一化后的 quiz */
export function recordQuiz(topic, batch = {}) {
  const at = Number.isFinite(batch.at) ? batch.at : Date.now();
  const quiz = {
    id: batch.id || uid(),
    at,
    itemRef: typeof batch.itemRef === 'string' && batch.itemRef ? batch.itemRef : null,
    entries: (Array.isArray(batch.entries) ? batch.entries : []).map((e) =>
      normalizeEntry(e || {}, at)
    ),
  };
  topic.quizzes = [...(topic.quizzes || []), quiz];
  topic.updatedAt = at;
  return quiz;
}

/** 向已有批次追加一条作答；quizId 不存在返回 null */
export function appendEntry(topic, quizId, entry = {}) {
  const quiz = ((topic && topic.quizzes) || []).find((q) => q.id === quizId);
  if (!quiz) return null;
  const normalized = normalizeEntry(entry);
  quiz.entries.push(normalized);
  topic.updatedAt = normalized.at;
  return normalized;
}

/** 查找作答记录（跨批次） */
export function findEntry(topic, entryId) {
  for (const quiz of (topic && topic.quizzes) || []) {
    const hit = (quiz.entries || []).find((e) => e.id === entryId);
    if (hit) return { entry: hit, quiz };
  }
  return null;
}

/**
 * 用户推翻一条判定：verdict 改为 overruled，并把该问题登记进待解决清单
 * （source=overrule，带 itemRef 以便后续连续答对自动消解）。重复推翻为 no-op。
 */
export function overruleEntry(topic, entryId, { at = Date.now() } = {}) {
  const found = findEntry(topic, entryId);
  if (!found) return topic;
  const { entry, quiz } = found;
  if (entry.verdict === 'overruled') return topic;
  entry.verdict = 'overruled';
  topic.updatedAt = at;
  if (entry.question) {
    addQuestion(topic, entry.question, {
      source: 'overrule',
      itemRef: entry.itemRef ?? quiz.itemRef ?? null,
      at,
    });
  }
  return topic;
}

/** 登记待解决问题；open 列表中已有同文本则不重复添加。返回问题（或已存在的那条）。 */
export function addQuestion(topic, text, { source = 'chat', itemRef = null, at = Date.now(), id } = {}) {
  const trimmed = String(text || '').trim();
  if (!trimmed) return null;
  topic.questions = topic.questions || [];
  const existing = topic.questions.find((q) => q.status === 'open' && q.text === trimmed);
  if (existing) return existing;
  const question = {
    id: id || uid(),
    text: trimmed,
    status: 'open',
    source: QUESTION_SOURCES.includes(source) ? source : 'chat',
    itemRef: typeof itemRef === 'string' && itemRef ? itemRef : null,
    createdAt: Number.isFinite(at) ? at : Date.now(),
  };
  topic.questions = [...topic.questions, question];
  topic.updatedAt = question.createdAt;
  return question;
}

/** 解决一条待解决问题；已解决或不存在返回 null */
export function resolveQuestion(topic, id, { by = 'user', at = Date.now() } = {}) {
  const question = ((topic && topic.questions) || []).find((q) => q.id === id);
  if (!question || question.status === 'resolved') return null;
  question.status = 'resolved';
  question.resolvedAt = Number.isFinite(at) ? at : Date.now();
  question.resolvedBy = by === 'quiz' ? 'quiz' : 'user';
  topic.updatedAt = question.resolvedAt;
  return question;
}

/**
 * 某条目相关作答连续答对 streak 次 → 消解该条目的 open 问题。
 * @returns {number} 本次解决的问题数
 */
export function resolveByQuiz(topic, { itemRef, streak = QUIZ_STREAK, at = Date.now() } = {}) {
  if (!itemRef || streak < 1) return 0;
  const related = allEntries(topic).filter((e) => e.itemRef === itemRef);
  const tail = related.slice(-streak);
  if (tail.length < streak || !tail.every((e) => e.verdict === 'right')) return 0;
  let resolved = 0;
  for (const q of (topic && topic.questions) || []) {
    if (q.status !== 'open' || q.itemRef !== itemRef) continue;
    q.status = 'resolved';
    q.resolvedAt = Number.isFinite(at) ? at : Date.now();
    q.resolvedBy = 'quiz';
    resolved += 1;
  }
  if (resolved) topic.updatedAt = Number.isFinite(at) ? at : Date.now();
  return resolved;
}

/** 当前 open 的待解决问题（按登记顺序） */
export function openQuestions(topic) {
  return ((topic && topic.questions) || []).filter((q) => q.status === 'open');
}
