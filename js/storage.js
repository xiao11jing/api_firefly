/**
 * storage.js — 本地持久化（纯逻辑，storage 参数可注入，便于测试）
 */
import { isPrice, normalizeUsage, numOrNull } from './usage.js';
import { normalizeBgOpacity } from './background.js';
import { DEFAULT_AI_NAME, DEFAULT_USER_NAME, defaultProfile, normalizeProfileName } from './profile.js';
import { normalizeSplash } from './splash.js';
import { normalizePet } from './pet.js';

export const STORAGE_KEY = 'ai-multi-chat-v1';

/** 支持的界面主题 */
export const THEMES = ['dark', 'light'];
export const DEFAULT_THEME = 'dark';

/** 对比模式最多同时对比的模型数 */
export const MAX_COMPARE_TARGETS = 2;

/** 单个提示词模板正文的字符上限（同时保护 localStorage 容量） */
export const MAX_PROMPT_CHARS = 20000;
const MAX_PROMPT_NAME = 60;

/** 字号缩放区间与默认值（整页 zoom，与 index.html 内联脚本的判断保持一致） */
export const FONT_SCALE_MIN = 0.8;
export const FONT_SCALE_MAX = 1.6;
export const DEFAULT_FONT_SCALE = 1;

/** 字号归一化：非法回退默认，超出范围收敛到边界，按 5% 步进取整 */
export function normalizeFontScale(value, fallback = DEFAULT_FONT_SCALE) {
  if (value === '' || value == null) return fallback;
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  const clamped = Math.min(FONT_SCALE_MAX, Math.max(FONT_SCALE_MIN, n));
  return Math.round(clamped * 20) / 20;
}

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
    settings: {
      theme: DEFAULT_THEME,
      background: null,
      profile: defaultProfile(),
      splash: null,
      fontScale: DEFAULT_FONT_SCALE,
      pet: normalizePet(null),
    },
    compare: { enabled: false, targets: [] }, // targets: [{ providerId, model }]
    promptTemplates: [], // [{ id, name, content, createdAt, updatedAt }]
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

/**
 * 本地图片 data URL：外链会被写进存储、且渲染时无法保证可达；
 * 载荷限定为 base64 字符集，这样拼进 CSS 的 url() 或元素属性都不存在注入面。
 */
const IMAGE_DATA_URL = /^data:image\/(?:png|jpe?g|gif|webp|avif|bmp|svg\+xml);base64,[A-Za-z0-9+/]+={0,2}$/i;

/** 校验并返回可存储的图片 data URL；非法或缺失返回 null */
export function normalizeImageDataUrl(value) {
  const url = typeof value === 'string' ? value.trim() : '';
  return IMAGE_DATA_URL.test(url) ? url : null;
}

/** 归一化背景配置；非法或缺失一律视为未设置背景 */
export function normalizeBackground(value) {
  if (!value || typeof value !== 'object') return null;
  const dataUrl = normalizeImageDataUrl(value.dataUrl);
  if (!dataUrl) return null;
  return { dataUrl, opacity: normalizeBgOpacity(value.opacity) };
}

/** 设置开屏动画元数据，meta 传 null 表示关闭；返回生效后的值 */
export function setSplash(state, meta) {
  const splash = normalizeSplash(meta);
  state.settings = { ...(state.settings || {}), splash };
  return splash;
}

/** 设置字号缩放（0.8~1.6）；返回生效后的值 */
export function setFontScale(state, value) {
  const fontScale = normalizeFontScale(value);
  state.settings = { ...(state.settings || {}), fontScale };
  return fontScale;
}

/** 合并桌宠配置 patch（visible/topmost/scale/position）；返回归一化后的完整配置 */
export function setPet(state, patch = {}) {
  const pet = normalizePet({ ...(state.settings && state.settings.pet), ...patch });
  state.settings = { ...(state.settings || {}), pet };
  return pet;
}

/** 归一化单个身份（用户 / AI）的名称与头像 */
function normalizeProfileSide(value, fallbackName) {
  const side = value && typeof value === 'object' ? value : {};
  return {
    name: normalizeProfileName(side.name, fallbackName),
    avatar: normalizeImageDataUrl(side.avatar),
  };
}

/** 归一化个人资料；缺失或非法字段回退默认值 */
export function normalizeProfile(value) {
  const v = value && typeof value === 'object' ? value : {};
  return {
    user: normalizeProfileSide(v.user, DEFAULT_USER_NAME),
    ai: normalizeProfileSide(v.ai, DEFAULT_AI_NAME),
  };
}

/** 更新个人资料，patch 形如 { user: { name?, avatar? }, ai: {...} }；返回生效后的值 */
export function updateProfile(state, patch = {}) {
  const current = normalizeProfile(state.settings && state.settings.profile);
  const next = normalizeProfile({
    user: { ...current.user, ...(patch.user || {}) },
    ai: { ...current.ai, ...(patch.ai || {}) },
  });
  state.settings = { ...(state.settings || {}), profile: next };
  return next;
}

/** 设置或清除背景图（background 传 null 表示清除），返回生效后的取值 */
export function setBackground(state, background) {
  const bg = normalizeBackground(background);
  state.settings = { ...(state.settings || {}), background: bg };
  return bg;
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

// ---------- 提示词模板 ----------

/** 新建或更新模板；名称为空时返回 null */
export function savePromptTemplate(state, { id, name, content } = {}) {
  const now = Date.now();
  const existing = id ? state.promptTemplates.find((t) => t.id === id) : null;
  const clean = {
    id: existing ? existing.id : uid(),
    name: String(name || '').trim().slice(0, MAX_PROMPT_NAME),
    content: String(content || '').slice(0, MAX_PROMPT_CHARS),
    createdAt: existing ? existing.createdAt : now,
    updatedAt: now,
  };
  if (!clean.name) return null;
  if (existing) Object.assign(existing, clean);
  else state.promptTemplates.push(clean);
  return clean;
}

export function deletePromptTemplate(state, id) {
  const idx = state.promptTemplates.findIndex((t) => t.id === id);
  if (idx === -1) return false;
  state.promptTemplates.splice(idx, 1);
  return true;
}

export function findPromptTemplate(state, id) {
  return state.promptTemplates.find((t) => t.id === id) || null;
}

/**
 * 把模板正文快照到会话（模板后续被改动或删除都不影响已有会话）。
 * template 传 null 表示该会话不使用系统提示。
 */
export function setSessionSystemPrompt(state, sessionId, template) {
  const s = state.sessions.find((x) => x.id === sessionId);
  if (!s) return null;
  s.systemPrompt = template
    ? normalizeSystemPrompt({ templateId: template.id, name: template.name, text: template.content })
    : null;
  return s.systemPrompt;
}

/** 会话当前生效的系统提示文本（没有则返回空串） */
export function systemPromptText(session) {
  return (session && session.systemPrompt && session.systemPrompt.text) || '';
}

/**
 * 关联/解绑会话的学习主题；topicId 为 null 表示解绑。
 * 关联会把会话带入 Learn 模式；解绑保持当前模式（留在学习欢迎页可重新关联）。
 */
export function setSessionLearnTopic(state, sessionId, topicId) {
  const s = state.sessions.find((x) => x.id === sessionId);
  if (!s) return null;
  const id = typeof topicId === 'string' && topicId ? topicId : null;
  if (id) {
    s.learnTopicId = id;
    s.uiMode = 'learn';
  } else {
    delete s.learnTopicId;
  }
  s.updatedAt = Date.now();
  return s.learnTopicId;
}

/**
 * 切换会话的顶栏模式（chat / learn）。
 * learn 不再要求已关联主题（无主题 = 显示学习欢迎页）；返回生效后的模式。
 */
export function setSessionUiMode(state, sessionId, mode) {
  const s = state.sessions.find((x) => x.id === sessionId);
  if (!s) return null;
  if (mode !== 'chat' && mode !== 'learn') return s.uiMode || 'chat';
  s.uiMode = mode;
  s.updatedAt = Date.now();
  return s.uiMode;
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
      background: normalizeBackground(s.settings && s.settings.background),
      profile: normalizeProfile(s.settings && s.settings.profile),
      splash: normalizeSplash(s.settings && s.settings.splash),
      fontScale: normalizeFontScale(s.settings && s.settings.fontScale),
      pet: normalizePet(s.settings && s.settings.pet),
    },
    compare: normalizeCompare(s.compare),
    promptTemplates: Array.isArray(s.promptTemplates)
      ? s.promptTemplates.map(normalizeTemplate).filter(Boolean)
      : [],
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

function normalizeTemplate(t) {
  if (!t || typeof t !== 'object' || typeof t.id !== 'string' || !t.id) return null;
  const name = String(t.name || '').trim().slice(0, MAX_PROMPT_NAME);
  if (!name) return null;
  const createdAt = typeof t.createdAt === 'number' ? t.createdAt : Date.now();
  return {
    id: t.id,
    name,
    content: String(t.content || '').slice(0, MAX_PROMPT_CHARS),
    createdAt,
    updatedAt: typeof t.updatedAt === 'number' ? t.updatedAt : createdAt,
  };
}

/** 会话上保存的系统提示快照：{ templateId, name, text } */
function normalizeSystemPrompt(sp) {
  if (!sp || typeof sp !== 'object') return null;
  const text = String(sp.text || '').trim().slice(0, MAX_PROMPT_CHARS);
  if (!text) return null;
  return {
    templateId: typeof sp.templateId === 'string' && sp.templateId ? sp.templateId : null,
    name: String(sp.name || '').trim().slice(0, MAX_PROMPT_NAME),
    text,
  };
}

/** 回复上记录的当轮系统提示：{ name, text } */
function normalizePromptSnapshot(sp) {
  if (typeof sp === 'string') {
    const text = sp.trim();
    return text ? { name: '', text } : null;
  }
  if (!sp || typeof sp !== 'object') return null;
  const text = String(sp.text || '').trim();
  if (!text) return null;
  return { name: String(sp.name || '').trim().slice(0, MAX_PROMPT_NAME), text };
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
  const prompt = normalizePromptSnapshot(m.systemPrompt);
  if (prompt) msg.systemPrompt = prompt;
  if (typeof m.ms === 'number' && Number.isFinite(m.ms) && m.ms >= 0) msg.ms = m.ms;
  return msg;
}

function normalizeSession(s) {
  if (!s || typeof s !== 'object' || typeof s.id !== 'string') return null;
  const learnTopicId =
    typeof s.learnTopicId === 'string' && s.learnTopicId ? s.learnTopicId : null;
  // uiMode 是与主题解耦的顶栏模式开关：显式值优先（learn 可以没有主题 = 学习欢迎页）；
  // 历史数据无此字段时，有关联主题推导为 learn。
  const uiMode =
    s.uiMode === 'chat' || s.uiMode === 'learn'
      ? s.uiMode
      : learnTopicId
        ? 'learn'
        : 'chat';
  return {
    id: s.id,
    title: typeof s.title === 'string' && s.title ? s.title : '新会话',
    model: s.model && typeof s.model === 'object' ? s.model : null,
    systemPrompt: normalizeSystemPrompt(s.systemPrompt),
    learnTopicId,
    uiMode,
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
    uiMode: 'chat',
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
  delete m.systemPrompt;
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
  const contextLength = numOrNull(provider.contextLength);
  const clean = {
    id: provider.id || uid(),
    name: String(provider.name || '').trim() || '未命名服务',
    baseUrl: String(provider.baseUrl || '').trim().replace(/\/+$/, ''),
    apiKey: String(provider.apiKey || '').trim(),
    proxyUrl: String(provider.proxyUrl || '').trim(),
    price: isPrice(provider.price)
      ? { input: Number(provider.price.input), output: Number(provider.price.output) }
      : null,
    // 上下文窗口上限：留空则回退内置参考表（见 usage.js 的 resolveContextWindow）
    contextLength: contextLength !== null && contextLength > 0 ? Math.round(contextLength) : null,
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
