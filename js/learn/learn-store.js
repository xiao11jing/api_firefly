/**
 * learn-store.js — Learn 模式数据层（schema / LocalStore / Vault 导出）
 *
 * 分工（见 learn_project.md §4）：
 * - 结构化状态（主题、计划、作答记录、问题清单）→ localStorage
 * - 大文本（资料库提取文本、复盘正文）→ IndexedDB（key-value）
 * - 所有方法为 async，便于将来替换为 FolderStore（文件夹绑定）而不改调用方
 * 依赖均可注入（localStorage / kv），便于 node 单测。
 */
import { uid } from '../storage.js';
import { formatDateTime, safeFilename } from '../export.js';
import { computeAccuracy, openQuestions } from './learn-quiz.js';

export const LEARN_STORAGE_KEY = 'ai-multi-chat-learn-v1';
export const LEARN_SCHEMA_VERSION = 1;

/** 资料提取文本上限（超出截断并打标，防止撑爆存储） */
export const MATERIAL_TEXT_LIMIT = 200 * 1024;

export const LEARN_MODES = ['plan', 'companion'];
export const ITEM_STATUS = ['todo', 'doing', 'done'];
export const QUESTION_SOURCES = ['chat', 'quiz', 'overrule'];
export const REVIEW_KINDS = ['image', 'text', 'pdf', 'html', 'code', 'docx', 'other'];

const IDB_NAME = 'ai-multi-chat-learn';
const IDB_STORE = 'kv';

export class LearnStoreError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'LearnStoreError';
    this.code = code;
  }
}

/* ------------------------------------------------------------------ *
 * schema 构造与归一化
 * ------------------------------------------------------------------ */

export function createLearnState() {
  return { schemaVersion: LEARN_SCHEMA_VERSION, activeTopicId: null, topics: [], vaultPath: null };
}

function numOr(value, fallback) {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

function str(value, fallback = '') {
  const s = String(value == null ? '' : value).trim();
  return s || fallback;
}

export function createTopic(options = {}) {
  const at = numOr(options.at, Date.now());
  return normalizeTopic({
    id: options.id || uid(),
    name: options.name,
    mode: options.mode,
    goal: options.goal,
    availability: options.availability,
    priorStage: options.priorStage,
    createdAt: at,
    updatedAt: at,
  });
}

function normalizeItem(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const title = str(raw.title);
  if (!title) return null;
  return {
    id: str(raw.id, uid()),
    title,
    status: ITEM_STATUS.includes(raw.status) ? raw.status : 'todo',
    note: String(raw.note == null ? '' : raw.note),
  };
}

function normalizeQuestion(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const text = str(raw.text);
  if (!text) return null;
  const resolved = raw.status === 'resolved';
  return {
    id: str(raw.id, uid()),
    text,
    status: resolved ? 'resolved' : 'open',
    source: QUESTION_SOURCES.includes(raw.source) ? raw.source : 'chat',
    itemRef: typeof raw.itemRef === 'string' && raw.itemRef ? raw.itemRef : null,
    createdAt: numOr(raw.createdAt, Date.now()),
    ...(resolved
      ? {
          resolvedAt: numOr(raw.resolvedAt, Date.now()),
          resolvedBy: raw.resolvedBy === 'quiz' ? 'quiz' : 'user',
        }
      : {}),
  };
}

function normalizeQuiz(raw) {
  if (!raw || typeof raw !== 'object') return null;
  return {
    id: str(raw.id, uid()),
    at: numOr(raw.at, Date.now()),
    itemRef: typeof raw.itemRef === 'string' && raw.itemRef ? raw.itemRef : null,
    entries: (Array.isArray(raw.entries) ? raw.entries : [])
      .filter((e) => e && typeof e === 'object')
      .map((e) => ({
        id: str(e.id, uid()),
        at: numOr(e.at, raw.at),
        question: String(e.question == null ? '' : e.question).trim(),
        userAnswer: String(e.userAnswer == null ? '' : e.userAnswer),
        verdict: ['right', 'wrong', 'unresolved', 'overruled'].includes(e.verdict)
          ? e.verdict
          : 'unresolved',
        judgedBy: e.judgedBy === 'user' ? 'user' : 'ai',
        itemRef: typeof e.itemRef === 'string' && e.itemRef ? e.itemRef : null,
      })),
  };
}

function normalizeReview(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const id = str(raw.id);
  if (!id) return null;
  return {
    id,
    at: numOr(raw.at, Date.now()),
    title: str(raw.title, '复盘'),
    bodyRef: str(raw.bodyRef, id),
  };
}

function normalizeMaterial(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const id = str(raw.id);
  if (!id) return null;
  return {
    id,
    name: str(raw.name, '未命名文件'),
    kind: REVIEW_KINDS.includes(raw.kind) ? raw.kind : 'other',
    size: Math.max(0, Math.round(numOr(raw.size, 0))),
    addedAt: numOr(raw.addedAt, Date.now()),
    summary: String(raw.summary == null ? '' : raw.summary),
    truncated: raw.truncated === true,
  };
}

export function normalizeTopic(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const planRaw = raw.plan && typeof raw.plan === 'object' ? raw.plan : {};
  const topic = {
    id: str(raw.id, uid()),
    name: str(raw.name, '未命名主题'),
    mode: LEARN_MODES.includes(raw.mode) ? raw.mode : 'companion',
    goal: String(raw.goal == null ? '' : raw.goal),
    availability: String(raw.availability == null ? '' : raw.availability),
    priorStage: String(raw.priorStage == null ? '' : raw.priorStage),
    createdAt: numOr(raw.createdAt, Date.now()),
    updatedAt: numOr(raw.updatedAt, Date.now()),
    interviewedAt: numOr(raw.interviewedAt, 0) || null,
    plan: {
      updatedAt: numOr(planRaw.updatedAt, numOr(raw.updatedAt, Date.now())),
      items: (Array.isArray(planRaw.items) ? planRaw.items : [])
        .map(normalizeItem)
        .filter(Boolean),
    },
    questions: (Array.isArray(raw.questions) ? raw.questions : [])
      .map(normalizeQuestion)
      .filter(Boolean),
    quizzes: (Array.isArray(raw.quizzes) ? raw.quizzes : [])
      .map(normalizeQuiz)
      .filter(Boolean),
    reviews: (Array.isArray(raw.reviews) ? raw.reviews : [])
      .map(normalizeReview)
      .filter(Boolean),
    materials: (Array.isArray(raw.materials) ? raw.materials : [])
      .map(normalizeMaterial)
      .filter(Boolean),
    sessionIds: (Array.isArray(raw.sessionIds) ? raw.sessionIds : []).filter(
      (s) => typeof s === 'string' && s
    ),
  };
  return topic;
}

/**
 * 读取并归一化状态；损坏回退默认。
 * 迁移占位：schemaVersion 高于当前版本说明数据来自未来版本，整体回退默认；
 * 将来 schemaVersion 变更时在下方加分支做逐版本迁移。
 */
export function normalizeState(raw) {
  if (!raw || typeof raw !== 'object') return createLearnState();
  if (Number(raw.schemaVersion) > LEARN_SCHEMA_VERSION) return createLearnState();
  const topics = (Array.isArray(raw.topics) ? raw.topics : [])
    .map(normalizeTopic)
    .filter(Boolean);
  const active =
    typeof raw.activeTopicId === 'string' && topics.some((t) => t.id === raw.activeTopicId)
      ? raw.activeTopicId
      : null;
  return {
    schemaVersion: LEARN_SCHEMA_VERSION,
    activeTopicId: active,
    topics,
    // 学习工作区（Vault）授权目录：绝对路径或 null（未绑定）
    vaultPath:
      typeof raw.vaultPath === 'string' && raw.vaultPath.trim() ? raw.vaultPath.trim() : null,
  };
}

/* ------------------------------------------------------------------ *
 * IndexedDB key-value（资料文本 / 复盘正文）
 * ------------------------------------------------------------------ */

function createIdbKv(factory) {
  if (!factory) return null;
  let dbPromise = null;
  const open = () => {
    if (!dbPromise) {
      dbPromise = new Promise((resolve, reject) => {
        const req = factory.open(IDB_NAME, 1);
        req.onupgradeneeded = () => {
          const db = req.result;
          if (!db.objectStoreNames.contains(IDB_STORE)) db.createObjectStore(IDB_STORE);
        };
        req.onsuccess = () => resolve(req.result);
        req.onerror = () => reject(req.error);
      }).catch((err) => {
        dbPromise = null; // 打开失败允许下次重试
        throw err;
      });
    }
    return dbPromise;
  };
  const run = (mode, fn) =>
    open().then(
      (db) =>
        new Promise((resolve, reject) => {
          const tx = db.transaction(IDB_STORE, mode);
          const req = fn(tx.objectStore(IDB_STORE));
          tx.oncomplete = () => resolve(req ? req.result : undefined);
          tx.onerror = () => reject(tx.error || new Error('IndexedDB 事务失败'));
          tx.onabort = () => reject(tx.error || new Error('IndexedDB 事务中止'));
        })
    );
  return {
    get: (key) => run('readonly', (s) => s.get(key)),
    set: (key, value) => run('readwrite', (s) => s.put(value, key)),
    del: (key) => run('readwrite', (s) => s.delete(key)),
  };
}

function kvGet(kv, key) {
  if (!kv) throw new LearnStoreError('unavailable', 'IndexedDB 不可用，无法读取大文本数据');
  return Promise.resolve(kv.get(key));
}

function kvSet(kv, key, value) {
  if (!kv) throw new LearnStoreError('unavailable', 'IndexedDB 不可用，无法写入大文本数据');
  return Promise.resolve(kv.set(key, value));
}

/** 资料文本截断到上限，返回 { text, truncated } */
export function clampMaterialText(text) {
  const raw = String(text == null ? '' : text);
  if (raw.length <= MATERIAL_TEXT_LIMIT) return { text: raw, truncated: false };
  return { text: raw.slice(0, MATERIAL_TEXT_LIMIT), truncated: true };
}

/* ------------------------------------------------------------------ *
 * store（local 实现）
 * ------------------------------------------------------------------ */

function isQuotaError(err) {
  return (
    err &&
    (err.name === 'QuotaExceededError' || err.code === 22 || err.code === 1014)
  );
}

/**
 * 创建 Learn 存储。
 * @param {'local'} kind 本期仅 local；FolderStore 在文件夹绑定阶段接入
 * @param {{localStorage?: object, kv?: object, indexedDB?: object}} [deps] 依赖注入（测试用）
 */
export function createLearnStore(kind = 'local', deps = {}) {
  if (kind !== 'local') {
    throw new LearnStoreError(
      'unsupported',
      `暂不支持的存储类型：${kind}（FolderStore 将在文件夹绑定阶段提供）`
    );
  }
  const local =
    deps.localStorage !== undefined
      ? deps.localStorage
      : typeof globalThis !== 'undefined'
        ? globalThis.localStorage
        : null;
  if (!local) throw new LearnStoreError('unavailable', 'localStorage 不可用');

  const kv =
    deps.kv !== undefined
      ? deps.kv
      : createIdbKv(
          deps.indexedDB !== undefined
            ? deps.indexedDB
            : typeof globalThis !== 'undefined'
              ? globalThis.indexedDB
              : null
        );

  async function loadState() {
    let raw;
    try {
      raw = local.getItem(LEARN_STORAGE_KEY);
    } catch {
      return createLearnState(); // 读取失败兜底
    }
    if (!raw) return createLearnState();
    try {
      return normalizeState(JSON.parse(raw));
    } catch {
      return createLearnState(); // 数据损坏兜底
    }
  }

  async function saveState(patch = null) {
    const current = await loadState();
    const next = normalizeState(patch ? { ...current, ...patch } : current);
    try {
      local.setItem(LEARN_STORAGE_KEY, JSON.stringify(next));
    } catch (err) {
      throw new LearnStoreError(
        isQuotaError(err) ? 'quota' : 'write',
        isQuotaError(err) ? '本地存储空间不足，学习数据未能保存' : `学习数据写入失败：${err.message}`
      );
    }
    return next;
  }

  const store = {
    loadState,
    saveState,

    /** 保存资料文本，返回可写入 topic.materials 的元数据（超限自动截断打标） */
    async saveMaterial(meta = {}, text = '') {
      const id = str(meta.id, uid());
      const clamped = clampMaterialText(text);
      await kvSet(kv, `material:${id}`, clamped.text);
      return {
        id,
        name: str(meta.name, '未命名文件'),
        kind: REVIEW_KINDS.includes(meta.kind) ? meta.kind : 'other',
        size: Math.max(0, Math.round(numOr(meta.size, 0))),
        addedAt: numOr(meta.addedAt, Date.now()),
        summary: String(meta.summary == null ? '' : meta.summary),
        truncated: clamped.truncated,
      };
    },

    async loadMaterial(id) {
      const value = await kvGet(kv, `material:${id}`);
      return typeof value === 'string' ? value : null;
    },

    /** 删除资料正文（条目本身由调用方从 topic.materials 移除） */
    async removeMaterial(id) {
      if (!kv || typeof kv.del !== 'function') return;
      await Promise.resolve(kv.del(`material:${id}`));
    },

    async saveReview(id, body) {
      const key = str(id);
      if (!key) throw new LearnStoreError('invalid', '复盘 id 不能为空');
      await kvSet(kv, `review:${key}`, String(body == null ? '' : body));
      return key;
    },

    async loadReview(id) {
      const value = await kvGet(kv, `review:${id}`);
      return typeof value === 'string' ? value : null;
    },

    /** 导出主题为 Vault 目录结构的 Markdown 文件集合：[{ path, content }] */
    async exportVault(topicId) {
      const state = await loadState();
      const topic = state.topics.find((t) => t.id === topicId);
      if (!topic) throw new LearnStoreError('not_found', `学习主题不存在：${topicId}`);
      return exportTopic(topic, { loadReview: (id) => kvGet(kv, `review:${id}`) });
    },
  };
  return store;
}

/* ------------------------------------------------------------------ *
 * Vault 导出渲染（纯函数）
 * ------------------------------------------------------------------ */

function yamlScalar(value) {
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  return JSON.stringify(String(value == null ? '' : value));
}

function frontmatter(fields) {
  const lines = ['---'];
  for (const [key, value] of Object.entries(fields)) lines.push(`${key}: ${yamlScalar(value)}`);
  lines.push('---', '');
  return lines;
}

function itemLine(item) {
  const mark = item.status === 'done' ? 'x' : ' ';
  const suffix = item.status === 'doing' ? '（进行中）' : '';
  const note = item.note ? `  - 备注：${String(item.note).replace(/\s+/g, ' ')}` : '';
  return [`- [${mark}] ${item.title}${suffix}`, note].filter(Boolean);
}

function accuracyLine(topic) {
  const acc = computeAccuracy(topic);
  if (!acc.considered) return '- 暂无作答';
  const percent = Math.round(acc.ratio * 100);
  return `- 近 ${acc.window} 条作答中判对 ${acc.right} · 判错 ${acc.wrong}（${percent}% · AI 判定）`;
}

function currentPlanItem(topic) {
  const items = topic.plan.items;
  return items.find((i) => i.status === 'doing') || items.find((i) => i.status === 'todo') || null;
}

export function renderPlanMarkdown(topic) {
  const lines = frontmatter({
    schemaVersion: LEARN_SCHEMA_VERSION,
    topic: topic.name,
    mode: topic.mode,
    updatedAt: topic.plan.updatedAt,
  });
  lines.push('# 学习计划', '');
  lines.push(`> 主题：${topic.name} · 最后更新：${formatDateTime(new Date(topic.plan.updatedAt))}`, '');
  if (!topic.plan.items.length) {
    lines.push('- 暂无计划条目', '');
  } else {
    for (const item of topic.plan.items) lines.push(...itemLine(item));
    lines.push('');
  }
  return `${lines.join('\n').trimEnd()}\n`;
}

export function renderProgressMarkdown(topic) {
  const lines = frontmatter({
    schemaVersion: LEARN_SCHEMA_VERSION,
    topic: topic.name,
    mode: topic.mode,
    updatedAt: topic.updatedAt,
  });
  lines.push('# 学习进度', '');
  lines.push(`**主题**：${topic.name}`, '');

  lines.push('## 计划状态', '');
  const items = topic.plan.items;
  if (!items.length) {
    lines.push('- 无计划（陪伴模式或计划尚未生成）', '');
  } else {
    const done = items.filter((i) => i.status === 'done').length;
    lines.push(`- 完成度：已完成 ${done} / 共 ${items.length} 条`);
    const current = currentPlanItem(topic);
    lines.push(`- 当前条目：${current ? current.title : '（计划已全部完成）'}`, '');
  }

  lines.push('## 练习正确率', '', accuracyLine(topic), '');

  lines.push('## 待解决问题', '');
  const open = openQuestions(topic);
  if (!open.length) {
    lines.push('- 暂无', '');
  } else {
    for (const q of open) lines.push(`- [ ] ${q.text}`);
    lines.push('');
  }

  lines.push('## 下一步', '');
  if (!items.length) {
    lines.push('- 陪伴模式：跟随用户的安排推进', '');
  } else {
    const current = currentPlanItem(topic);
    lines.push(current ? `- 继续：${current.title}` : '- 计划已全部完成，可生成新计划', '');
  }
  return `${lines.join('\n').trimEnd()}\n`;
}

function formatBytes(size) {
  if (!size) return '0B';
  if (size < 1024) return `${size}B`;
  if (size < 1024 * 1024) return `${(size / 1024).toFixed(1)}KB`;
  return `${(size / 1024 / 1024).toFixed(1)}MB`;
}

export function renderMaterialsIndex(topic) {
  const lines = frontmatter({
    schemaVersion: LEARN_SCHEMA_VERSION,
    topic: topic.name,
    count: topic.materials.length,
  });
  lines.push('# 资料索引', '');
  lines.push('> 原始文件只读；本索引由应用生成，正文提取存在本地数据库中。', '');
  if (!topic.materials.length) {
    lines.push('- 暂无归档资料', '');
  } else {
    for (const m of topic.materials) {
      const bits = [m.kind, formatBytes(m.size), formatDateTime(new Date(m.addedAt))];
      let line = `- \`${m.name}\`（${bits.join(' · ')}）`;
      if (m.summary) line += ` — ${String(m.summary).replace(/\s+/g, ' ')}`;
      lines.push(line);
      if (m.truncated) lines.push('  - 文本提取超过上限，已截断');
    }
    lines.push('');
  }
  return `${lines.join('\n').trimEnd()}\n`;
}

const VERDICT_LABEL = {
  right: '✅ 判对',
  wrong: '❌ 判错',
  unresolved: '❔ 未判定',
  overruled: '↩️ 已推翻',
};

export function renderQuizLog(topic) {
  const lines = frontmatter({
    schemaVersion: LEARN_SCHEMA_VERSION,
    topic: topic.name,
    batches: topic.quizzes.length,
  });
  lines.push('# 练习记录', '');
  if (!topic.quizzes.length) {
    lines.push('> 暂无练习记录', '');
    return `${lines.join('\n').trimEnd()}\n`;
  }
  const itemTitle = (ref) => {
    if (!ref) return null;
    const item = topic.plan.items.find((i) => i.id === ref);
    return item ? item.title : ref;
  };
  for (const quiz of topic.quizzes) {
    const related = itemTitle(quiz.itemRef);
    const heading = `## ${formatDateTime(new Date(quiz.at))}${related ? `（条目：${related}）` : ''}`;
    lines.push(heading, '');
    if (!quiz.entries.length) {
      lines.push('> 本批次无作答', '');
      continue;
    }
    for (const e of quiz.entries) {
      if (e.question) lines.push(`**问**：${e.question}`);
      if (e.userAnswer) lines.push(`**答**：${e.userAnswer}`);
      lines.push(`**判定**：${VERDICT_LABEL[e.verdict] || VERDICT_LABEL.unresolved}`, '');
    }
  }
  return `${lines.join('\n').trimEnd()}\n`;
}

export function renderReviewMarkdown(topic, review, body) {
  const lines = frontmatter({
    schemaVersion: LEARN_SCHEMA_VERSION,
    type: 'review',
    topic: topic.name,
    title: review.title,
    at: review.at,
  });
  lines.push(`# 复盘：${review.title}`, '');
  lines.push(`> 时间：${formatDateTime(new Date(review.at))}`, '');
  const text = typeof body === 'string' && body.trim() ? body.trim() : '（复盘正文缺失）';
  lines.push(text, '');
  return `${lines.join('\n').trimEnd()}\n`;
}

function localDate(at) {
  return formatDateTime(new Date(at)).slice(0, 10);
}

/**
 * 主题 → Vault 文件集合。
 * @param {object} topic
 * @param {{loadReview?: (id:string)=>Promise<string|null>}} [deps]
 * @returns {Promise<Array<{path:string, content:string}>>}
 */
export async function exportTopic(topic, { loadReview = async () => null } = {}) {
  const files = [
    { path: 'learn/plan.md', content: renderPlanMarkdown(topic) },
    { path: 'learn/progress.md', content: renderProgressMarkdown(topic) },
    { path: 'materials/materials.md', content: renderMaterialsIndex(topic) },
    { path: 'exercises/quiz-log.md', content: renderQuizLog(topic) },
  ];
  const reviews = [...topic.reviews].sort((a, b) => a.at - b.at);
  let seq = 0;
  for (const review of reviews) {
    seq += 1;
    const body = await loadReview(review.bodyRef);
    const name = `${localDate(review.at)}-review-${String(seq).padStart(2, '0')}-${safeFilename(
      review.title,
      '复盘'
    )}.md`;
    files.push({ path: `exercises/${name}`, content: renderReviewMarkdown(topic, review, body) });
  }
  return files;
}
