/**
 * storage.js — 本地持久化（纯逻辑，storage 参数可注入，便于测试）
 */
import { isPrice, normalizeUsage } from './usage.js';

export const STORAGE_KEY = 'ai-multi-chat-v1';

/** 支持的界面主题 */
export const THEMES = ['dark', 'light'];
export const DEFAULT_THEME = 'dark';

/** 对比模式最多同时对比的模型数 */
export const MAX_COMPARE_TARGETS = 2;

/** 主题归一化：未知取值回退到默认主题 */
export function normalizeTheme(value) {
  return THEMES.includes(value) ? value : DEFAULT_THEME;
}

export function defaultState() {
  return {
    version: 1,
    providers: [],
    sessions: [],
    activeSessionId: null,
    selectedModel: null, // { providerId, model }
    settings: { theme: DEFAULT_THEME },
    compare: { enabled: false, targets: [] }, // targets: [{ providerId, model }]
  };
}

/** 生成简单唯一 id */
export function uid() {
  if (typeof crypto !== 'undefined' && crypto.randomUUID) {
    return crypto.randomUUID();
  }
  return `id-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

/** 读取并归一化状态；数据损坏时回退到默认值 */
export function loadState(storage) {
  let raw;
  try {
    raw = storage.getItem(STORAGE_KEY);
  } catch {
    return defaultState();
  }
  if (!raw) return defaultState();
  try {
    const parsed = JSON.parse(raw);
    return normalizeState(parsed);
  } catch {
    return defaultState();
  }
}

export function saveState(storage, state) {
  storage.setItem(STORAGE_KEY, JSON.stringify(state));
}

/** 设置界面主题，返回生效后的取值 */
export function setTheme(state, theme) {
  state.settings = { ...(state.settings || {}), theme: normalizeTheme(theme) };
  return state.settings.theme;
}

/** 开关对比模式，返回生效后的取值 */
export function setCompareEnabled(state, enabled) {
  state.compare = { ...normalizeCompare(state.compare), enabled: !!enabled };
  return state.compare.enabled;
}

/** 设置对比目标（最多 MAX_COMPARE_TARGETS 个），返回归一化后的列表 */
export function setCompareTargets(state, targets) {
  state.compare = { ...normalizeCompare(state.compare), targets };
  state.compare = normalizeCompare(state.compare);
  return state.compare.targets;
}

function normalizeState(s) {
  const base = defaultState();
  if (!s || typeof s !== 'object') return base;
  const state = {
    version: 1,
    providers: Array.isArray(s.providers) ? s.providers.filter(isProvider) : [],
    sessions: Array.isArray(s.sessions) ? s.sessions.map(normalizeSession).filter(Boolean) : [],
    activeSessionId: typeof s.activeSessionId === 'string' ? s.activeSessionId : null,
    selectedModel:
      s.selectedModel && typeof s.selectedModel === 'object'
        ? {
            providerId: String(s.selectedModel.providerId || ''),
            model: String(s.selectedModel.model || ''),
          }
        : null,
    settings: {
      ...(s.settings && typeof s.settings === 'object' ? s.settings : {}),
      theme: normalizeTheme(s.settings && s.settings.theme),
    },
    compare: normalizeCompare(s.compare),
  };
  if (state.activeSessionId && !state.sessions.some((x) => x.id === state.activeSessionId)) {
    state.activeSessionId = state.sessions.length ? state.sessions[0].id : null;
  }
  return state;
}

function isProvider(p) {
  return p && typeof p === 'object' && typeof p.name === 'string' && typeof p.baseUrl === 'string';
}

function normalizeTarget(t) {
  if (!t || typeof t !== 'object') return null;
  const providerId = String(t.providerId || '');
  const model = String(t.model || '');
  return providerId && model ? { providerId, model } : null;
}

function normalizeCompare(compare) {
  if (!compare || typeof compare !== 'object') return { enabled: false, targets: [] };
  const targets = Array.isArray(compare.targets)
    ? compare.targets.map(normalizeTarget).filter(Boolean).slice(0, MAX_COMPARE_TARGETS)
    : [];
  return { enabled: compare.enabled === true, targets };
}

function normalizeMessage(m) {
  if (!m || typeof m !== 'object' || typeof m.id !== 'string' || !Array.isArray(m.content)) return null;
  const msg = {
    id: m.id,
    role: m.role === 'assistant' ? 'assistant' : 'user',
    content: m.content,
    createdAt: typeof m.createdAt === 'number' ? m.createdAt : Date.now(),
  };
  if (m.error) msg.error = true;
  const model = normalizeTarget(m.model);
  if (model) msg.model = model;
  if (typeof m.batchId === 'string' && m.batchId) msg.batchId = m.batchId;
  const usage = normalizeUsage(m.usage);
  if (usage) msg.usage = usage;
  if (typeof m.ms === 'number' && Number.isFinite(m.ms) && m.ms >= 0) msg.ms = m.ms;
  return msg;
}

function normalizeSession(s) {
  if (!s || typeof s !== 'object' || typeof s.id !== 'string') return null;
  return {
    id: s.id,
    title: typeof s.title === 'string' && s.title ? s.title : '新会话',
    model: s.model && typeof s.model === 'object' ? s.model : null,
    messages: Array.isArray(s.messages) ? s.messages.map(normalizeMessage).filter(Boolean) : [],
    createdAt: typeof s.createdAt === 'number' ? s.createdAt : Date.now(),
    updatedAt: typeof s.updatedAt === 'number' ? s.updatedAt : Date.now(),
  };
}

/** 从首条用户消息生成会话标题 */
export function sessionTitleFrom(text, max = 30) {
  const t = String(text || '')
    .replace(/\s+/g, ' ')
    .trim();
  if (!t) return '新会话';
  return t.length > max ? t.slice(0, max) + '…' : t;
}

export function createSession(state, model = null) {
  const now = Date.now();
  const session = {
    id: uid(),
    title: '新会话',
    model,
    messages: [],
    createdAt: now,
    updatedAt: now,
  };
  state.sessions.unshift(session);
  state.activeSessionId = session.id;
  return session;
}

export function deleteSession(state, id) {
  const idx = state.sessions.findIndex((s) => s.id === id);
  if (idx === -1) return;
  state.sessions.splice(idx, 1);
  if (state.activeSessionId === id) {
    state.activeSessionId = state.sessions.length ? state.sessions[0].id : null;
  }
}

export function renameSession(state, id, title) {
  const s = state.sessions.find((x) => x.id === id);
  const t = String(title || '').trim();
  if (!s || !t) return;
  s.title = t.slice(0, 60);
  s.updatedAt = Date.now();
}

export function getActiveSession(state) {
  return state.sessions.find((s) => s.id === state.activeSessionId) || null;
}

/** 追加消息；首条用户消息决定标题（优先正文，其次附件名） */
export function addMessage(state, sessionId, message) {
  const s = state.sessions.find((x) => x.id === sessionId);
  if (!s) return null;
  const model = normalizeTarget(message.model);
  const batchId = typeof message.batchId === 'string' && message.batchId ? message.batchId : null;
  const msg = {
    id: uid(),
    role: message.role,
    content: message.content,
    createdAt: Date.now(),
    ...(message.error ? { error: true } : {}),
    ...(model ? { model } : {}),
    ...(batchId ? { batchId } : {}),
  };
  s.messages.push(msg);
  s.updatedAt = Date.now();
  if (s.messages.length === 1 && msg.role === 'user') applyTitleFromMessage(s, msg);
  return msg;
}

/** 删除一条消息（用于清理没有产出任何内容的占位回复） */
export function removeMessage(state, sessionId, messageId) {
  const s = state.sessions.find((x) => x.id === sessionId);
  if (!s) return false;
  const idx = s.messages.findIndex((m) => m.id === messageId);
  if (idx === -1) return false;
  s.messages.splice(idx, 1);
  s.updatedAt = Date.now();
  return true;
}

/** 把一条回复重置为待流式写入的空状态（用于重新生成） */
export function resetMessage(state, sessionId, messageId) {
  const s = state.sessions.find((x) => x.id === sessionId);
  if (!s) return null;
  const m = s.messages.find((x) => x.id === messageId);
  if (!m) return null;
  m.content = [{ type: 'text', text: '' }];
  delete m.error;
  delete m.usage;
  delete m.ms;
  s.updatedAt = Date.now();
  return m;
}

/**
 * 按「对比批次」把消息分组：同一 batchId 的连续回复合成一组，供左右分栏渲染。
 * @returns {Array<Array<object>>}
 */
export function groupMessages(messages) {
  const list = Array.isArray(messages) ? messages : [];
  const groups = [];
  let current = null;
  for (const m of list) {
    if (m && m.role === 'assistant' && typeof m.batchId === 'string' && m.batchId) {
      if (current && current.batchId === m.batchId) {
        current.items.push(m);
        continue;
      }
      current = { batchId: m.batchId, items: [m] };
      groups.push(current);
      continue;
    }
    current = null;
    groups.push({ batchId: null, items: [m] });
  }
  return groups.map((g) => g.items);
}

function applyTitleFromMessage(session, msg) {
  const parts = Array.isArray(msg.content) ? msg.content : [];
  const text = parts.find((p) => p.type === 'text' && p.text && p.text.trim());
  if (text) {
    session.title = sessionTitleFrom(text.text);
    return;
  }
  const files = parts.filter((p) => p.type === 'file' || p.type === 'image');
  if (files.length === 1) session.title = sessionTitleFrom(files[0].name || '附件会话');
  else if (files.length > 1) session.title = `${files.length} 个附件`;
}

/** 更新已有消息（用于流式追加文本） */
export function updateMessage(state, sessionId, messageId, patch) {
  const s = state.sessions.find((x) => x.id === sessionId);
  if (!s) return null;
  const m = s.messages.find((x) => x.id === messageId);
  if (!m) return null;
  Object.assign(m, patch);
  s.updatedAt = Date.now();
  return m;
}

export function saveProvider(state, provider) {
  const clean = {
    id: provider.id || uid(),
    name: String(provider.name || '').trim() || '未命名服务',
    baseUrl: String(provider.baseUrl || '').trim().replace(/\/+$/, ''),
    apiKey: String(provider.apiKey || '').trim(),
    proxyUrl: String(provider.proxyUrl || '').trim(),
    price: isPrice(provider.price)
      ? { input: Number(provider.price.input), output: Number(provider.price.output) }
      : null,
    models: Array.isArray(provider.models)
      ? provider.models.map((m) => String(m).trim()).filter(Boolean)
      : [],
  };
  const idx = state.providers.findIndex((p) => p.id === clean.id);
  if (idx === -1) state.providers.push(clean);
  else state.providers[idx] = clean;
  return clean;
}

export function deleteProvider(state, id) {
  const idx = state.providers.findIndex((p) => p.id === id);
  if (idx !== -1) state.providers.splice(idx, 1);
  if (state.selectedModel && state.selectedModel.providerId === id) {
    state.selectedModel = null;
  }
  const compare = normalizeCompare(state.compare);
  if (compare.targets.some((t) => t.providerId === id)) {
    state.compare = { ...compare, targets: compare.targets.filter((t) => t.providerId !== id) };
  }
}
