/**
 * main.js — 界面交互与状态装配
 */
import * as store from './storage.js';
import { streamChat, toApiMessage } from './provider.js';
import { renderMarkdown } from './markdown.js';
import {
  MAX_ATTACHMENTS,
  attachmentSummary,
  checkFile,
  classifyFile,
  formatBytes,
  isFull,
  makeDocAttachment,
  toMessageParts,
} from './attachments.js';
import { extractPdfText } from './pdf-text.js';
import { exportFilename, sessionToMarkdown } from './export.js';
import { normalizeQuery, searchSession } from './search.js';
import {
  computeCost,
  estimateApiTokens,
  estimateTokens,
  formatCost,
  formatTokens,
  numOrNull,
  resolvePrice,
  usageToRecord,
} from './usage.js';

const $ = (sel) => document.querySelector(sel);
const hljs = window.hljs || null;

/** @type {ReturnType<typeof store.defaultState>} */
let state = store.loadState(window.localStorage);
let attachments = []; // 待发送附件：{ id, kind, name, size, dataUrl? | text? }
let attachSeq = 0;
let readingAttachments = 0; // 正在解析（PDF/文本读取）中的附件数
let controllers = []; // 当前生成中的各分支中断器
let streaming = false;

// ---------- 基础工具 ----------

let toastTimer = null;
function toast(msg, type = '') {
  const el = $('#toast');
  el.textContent = msg;
  el.className = 'toast' + (type ? ' ' + type : '');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.add('hidden'), 3200);
}

/** 本地写入失败时只提示一次，避免流式过程中反复弹提示 */
let storageWarned = false;

/**
 * 写入本地存储。失败（配额溢出、隐私模式禁用存储等）不能让调用方崩掉：
 * 发送流程里 persist() 一旦抛出，后面的请求就不会发出，用户会看到消息凭空消失。
 */
function persist() {
  try {
    store.saveState(window.localStorage, state);
    storageWarned = false;
  } catch (e) {
    console.error('本地保存失败', e);
    if (storageWarned) return;
    storageWarned = true;
    toast('本地保存失败，本次改动未写入浏览器存储（可能是存储空间已满）', 'error');
  }
}

function providerById(id) {
  return state.providers.find((p) => p.id === id) || null;
}

function selectedProvider() {
  if (!state.selectedModel) return null;
  return providerById(state.selectedModel.providerId);
}

// ---------- 对比模式 ----------

function compareEnabled() {
  return !!(state.compare && state.compare.enabled);
}

function compareTargets() {
  return (state.compare && state.compare.targets) || [];
}

/** 校验一个 { providerId, model } 是否仍可用 */
function resolveTarget(target) {
  if (!target) return null;
  const provider = providerById(target.providerId);
  if (!provider) return null;
  if (provider.models.length && !provider.models.includes(target.model)) return null;
  return { provider, model: target.model };
}

/** 本次发送实际要跑的分支：对比模式下为两个模型，否则为当前选中的模型 */
function sendTargets() {
  if (compareEnabled()) {
    return { comparing: true, targets: compareTargets().map(resolveTarget).filter(Boolean) };
  }
  const single = resolveTarget(state.selectedModel);
  return { comparing: false, targets: single ? [single] : [] };
}

function renderCompareUI() {
  const btn = $('#btn-compare-toggle');
  const on = compareEnabled();
  btn.classList.toggle('active', on);
  btn.setAttribute('aria-pressed', String(on));
}

function toggleCompare() {
  if (streaming) {
    toast('生成中，请先停止');
    return;
  }
  const on = !compareEnabled();
  store.setCompareEnabled(state, on);
  if (on && !compareTargets().length && state.selectedModel) {
    store.setCompareTargets(state, [state.selectedModel]);
  }
  persist();
  renderCompareUI();
  renderModelSelect();
  const count = compareTargets().length;
  if (on) toast(count < 2 ? '对比模式：还需再选 1 个模型' : '对比模式：将并行发送给 2 个模型');
  else toast('已关闭对比模式');
}

function toggleCompareTarget(target) {
  const list = compareTargets();
  const idx = list.findIndex((t) => t.providerId === target.providerId && t.model === target.model);
  if (idx !== -1) {
    store.setCompareTargets(state, list.filter((_, i) => i !== idx));
  } else if (list.length >= store.MAX_COMPARE_TARGETS) {
    toast(`对比模式最多 ${store.MAX_COMPARE_TARGETS} 个模型，请先取消一个`, 'error');
    return;
  } else {
    store.setCompareTargets(state, [...list, target]);
  }
  persist();
  renderModelSelect();
}

// ---------- 会话列表 ----------

function formatTime(ts) {
  const d = new Date(ts);
  const now = new Date();
  const diff = now - d;
  if (diff < 60 * 1000) return '刚刚';
  if (diff < 60 * 60 * 1000) return `${Math.floor(diff / 60000)} 分钟前`;
  const hm = `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
  if (d.toDateString() === now.toDateString()) return hm;
  return `${d.getMonth() + 1}/${d.getDate()} ${hm}`;
}

/** 双击判定窗口（毫秒） */
const DOUBLE_CLICK_MS = 400;
/** 最近一次点击的会话，用于自行识别双击 */
let lastSessionClick = null;

/**
 * 会话项点击：单击切换会话，双击重命名。
 *
 * 这里不能用 dblclick 事件：单击会 renderAll() 重建整个列表，
 * 两次点击之间节点被换掉后浏览器就不再派发 dblclick，重命名永远不会触发。
 * 因此按时间窗口自行判定，并始终对「当前在列表里的节点」操作，
 * 避免拿着已被重建掉的游离节点去插入输入框。
 */
function onSessionClick(item, session) {
  if (streaming) {
    toast('生成中，请先停止或等待完成');
    return;
  }
  const now = Date.now();
  const doubled =
    lastSessionClick && lastSessionClick.id === session.id && now - lastSessionClick.at < DOUBLE_CLICK_MS;
  if (doubled) {
    lastSessionClick = null;
    const live = [...$('#session-list').children].find((el) => el.dataset.id === session.id) || item;
    startRename(live, session, live.querySelector('.s-title'));
    return;
  }
  lastSessionClick = { id: session.id, at: now };
  state.activeSessionId = session.id;
  persist();
  renderAll();
  closeSidebarOnMobile();
}

function renderSessions() {
  const list = $('#session-list');
  list.innerHTML = '';
  for (const s of state.sessions) {
    const item = document.createElement('div');
    item.className = 'session-item' + (s.id === state.activeSessionId ? ' active' : '');
    item.dataset.id = s.id;

    const title = document.createElement('span');
    title.className = 's-title';
    title.textContent = s.title;

    const time = document.createElement('span');
    time.className = 's-time';
    time.textContent = formatTime(s.updatedAt);

    const del = document.createElement('button');
    del.className = 's-del';
    del.title = '删除会话';
    del.innerHTML =
      '<svg viewBox="0 0 16 16" width="13" height="13"><path d="M3 4.5h10M6.5 4.5V3h3v1.5M5 4.5l.6 8h4.8l.6-8" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linecap="round" stroke-linejoin="round"/></svg>';
    del.addEventListener('click', (e) => {
      e.stopPropagation();
      if (!confirm(`删除会话「${s.title}」？`)) return;
      store.deleteSession(state, s.id);
      if (!state.sessions.length) store.createSession(state, state.selectedModel);
      persist();
      renderAll();
    });

    item.append(title, time, del);
    item.addEventListener('click', () => onSessionClick(item, s));
    list.appendChild(item);
  }
}

function startRename(item, session, titleEl) {
  const input = document.createElement('input');
  input.className = 'rename-input';
  input.value = session.title;
  titleEl.replaceWith(input);
  input.focus();
  input.select();
  let done = false;
  const commit = (save) => {
    if (done) return;
    done = true;
    if (save) store.renameSession(state, session.id, input.value);
    persist();
    renderAll();
  };
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') commit(true);
    else if (e.key === 'Escape') commit(false);
  });
  input.addEventListener('blur', () => commit(true));
  input.addEventListener('click', (e) => e.stopPropagation());
  input.addEventListener('dblclick', (e) => e.stopPropagation());
}

// ---------- 模型选择 ----------

const GEAR_SVG =
  '<svg viewBox="0 0 16 16" width="14" height="14"><path d="M8 10.2A2.2 2.2 0 1 0 8 5.8a2.2 2.2 0 0 0 0 4.4Z" fill="none" stroke="currentColor" stroke-width="1.3"/><path d="M13.3 9.6a1.1 1.1 0 0 0 .22 1.21l.04.04a1.33 1.33 0 1 1-1.88 1.88l-.04-.04a1.1 1.1 0 0 0-1.21-.22 1.1 1.1 0 0 0-.67 1v.11a1.33 1.33 0 1 1-2.66 0v-.06a1.1 1.1 0 0 0-.72-1 1.1 1.1 0 0 0-1.21.22l-.04.04a1.33 1.33 0 1 1-1.88-1.88l.04-.04a1.1 1.1 0 0 0 .22-1.21 1.1 1.1 0 0 0-1-.67h-.11a1.33 1.33 0 1 1 0-2.66h.06a1.1 1.1 0 0 0 1-.72 1.1 1.1 0 0 0-.22-1.21l-.04-.04a1.33 1.33 0 1 1 1.88-1.88l.04.04a1.1 1.1 0 0 0 1.21.22h.05a1.1 1.1 0 0 0 .67-1v-.11a1.33 1.33 0 1 1 2.66 0v.06a1.1 1.1 0 0 0 .67 1 1.1 1.1 0 0 0 1.21-.22l.04-.04a1.33 1.33 0 1 1 1.88 1.88l-.04.04a1.1 1.1 0 0 0-.22 1.21v.05a1.1 1.1 0 0 0 1 .67h.11a1.33 1.33 0 1 1 0 2.66h-.06a1.1 1.1 0 0 0-1 .67Z" fill="none" stroke="currentColor" stroke-width="1.1"/></svg>';

const CHECK_SVG =
  '<svg viewBox="0 0 14 14" width="14" height="14"><path d="M2.5 7.5 5.5 10.5l6-7" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"/></svg>';

const DOC_SVG =
  '<svg viewBox="0 0 16 16" width="13" height="13"><path d="M4 1.8h4.6L12 5.2v9H4z" fill="none" stroke="currentColor" stroke-width="1.2" stroke-linejoin="round"/><path d="M8.6 1.8v3.4H12" fill="none" stroke="currentColor" stroke-width="1.2" stroke-linejoin="round"/><path d="M6 8.6h4M6 10.8h4" fill="none" stroke="currentColor" stroke-width="1.2" stroke-linecap="round"/></svg>';

/** 由服务 id 生成稳定的头像色 */
function providerColor(id) {
  let h = 0;
  for (const ch of String(id)) h = (h * 31 + ch.charCodeAt(0)) % 360;
  return `hsl(${h} 62% 46%)`;
}

function closeModelMenu() {
  $('#model-menu').classList.add('hidden');
  $('#model-pill').classList.remove('open');
  $('#model-select').setAttribute('aria-expanded', 'false');
}

function toggleModelMenu() {
  const menu = $('#model-menu');
  const willOpen = menu.classList.contains('hidden');
  menu.classList.toggle('hidden', !willOpen);
  $('#model-pill').classList.toggle('open', willOpen);
  $('#model-select').setAttribute('aria-expanded', String(willOpen));
}

function renderModelSelect() {
  const dot = $('#model-dot');
  const pill = $('#model-pill');
  const label = $('#model-label');
  const menu = $('#model-menu');
  const list = $('#model-menu-list');
  list.innerHTML = '';
  const oldFoot = menu.querySelector('.model-menu-foot');
  if (oldFoot) oldFoot.remove();

  if (!state.providers.length) {
    label.textContent = '配置 API 服务';
    dot.classList.remove('on');
    pill.classList.add('attention');
    closeModelMenu();
    return;
  }
  pill.classList.remove('attention');

  const comparing = compareEnabled();
  const targets = compareTargets();

  for (const p of state.providers) {
    const head = document.createElement('div');
    head.className = 'menu-group';
    head.textContent = p.name;
    list.appendChild(head);

    const models = p.models.length ? p.models : ['（未填模型名）'];
    for (const m of models) {
      const targetIndex = targets.findIndex((t) => t.providerId === p.id && t.model === m);
      const active = comparing
        ? targetIndex !== -1
        : !!(
            state.selectedModel &&
            state.selectedModel.providerId === p.id &&
            state.selectedModel.model === m
          );

      const item = document.createElement('button');
      item.type = 'button';
      item.className = 'menu-item' + (active ? ' active' : '');
      item.setAttribute('role', 'option');
      item.setAttribute('aria-selected', String(active));

      const icon = document.createElement('span');
      icon.className = 'menu-icon';
      icon.style.background = providerColor(p.id);
      icon.textContent = (p.name.trim()[0] || '?').toUpperCase();

      const name = document.createElement('span');
      name.className = 'menu-name';
      name.textContent = m;

      item.append(icon, name);
      if (active) {
        const mark = document.createElement('span');
        if (comparing) {
          mark.className = 'menu-badge';
          mark.textContent = targetIndex === 0 ? 'A' : 'B';
        } else {
          mark.className = 'menu-check';
          mark.innerHTML = CHECK_SVG;
        }
        item.appendChild(mark);
      }
      item.addEventListener('click', (e) => {
        e.stopPropagation();
        if (comparing) {
          // 对比模式下保持菜单打开，方便连续选两个模型
          toggleCompareTarget({ providerId: p.id, model: m });
          return;
        }
        state.selectedModel = { providerId: p.id, model: m };
        persist();
        closeModelMenu();
        renderModelSelect();
      });
      list.appendChild(item);
    }
  }

  const foot = document.createElement('button');
  foot.type = 'button';
  foot.className = 'model-menu-foot';
  foot.innerHTML = `${GEAR_SVG}<span>配置自定义模型</span>`;
  foot.addEventListener('click', (e) => {
    e.stopPropagation();
    closeModelMenu();
    openSettings('api');
  });
  menu.appendChild(foot);

  if (comparing) {
    if (!targets.length) label.textContent = '对比：选择两个模型…';
    else if (targets.length === 1) label.textContent = `${targets[0].model} vs ？`;
    else label.textContent = `${targets[0].model} vs ${targets[1].model}`;
    dot.classList.toggle('on', targets.length > 0 && targets.every((t) => resolveTarget(t)));
    return;
  }

  if (state.selectedModel) {
    label.textContent = state.selectedModel.model;
    dot.classList.toggle('on', !!providerById(state.selectedModel.providerId));
  } else {
    label.textContent = '选择模型…';
    dot.classList.remove('on');
  }
}

// ---------- 消息渲染 ----------

function ensureMsgCol() {
  const box = $('#messages');
  let col = box.querySelector('.msg-col');
  if (!col) {
    box.innerHTML = '';
    col = document.createElement('div');
    col.className = 'msg-col';
    box.appendChild(col);
  }
  return col;
}

function renderEmptyState() {
  const box = $('#messages');
  box.innerHTML = '';
  const wrap = document.createElement('div');
  wrap.className = 'empty-state';

  if (!state.providers.length) {
    wrap.innerHTML = `
      <div class="es-mark"><svg viewBox="0 0 24 24" width="22" height="22"><path d="M4 6h16v10H8l-4 4V6Z" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linejoin="round"/></svg></div>
      <h3>还没有配置 API 服务</h3>
      <p>添加任意兼容 OpenAI Chat Completions 格式的接口（OpenAI、DeepSeek、通义、本地 Ollama 等），即可开始多模型对话。</p>`;
    const btn = document.createElement('button');
    btn.className = 'primary-btn';
    btn.textContent = '去配置 API';
    btn.addEventListener('click', () => openSettings('api'));
    wrap.appendChild(btn);
  } else {
    wrap.innerHTML = `
      <div class="es-mark"><svg viewBox="0 0 24 24" width="22" height="22"><path d="M4 6h16v10H8l-4 4V6Z" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linejoin="round"/></svg></div>
      <h3>开始新对话</h3>
      <p>输入消息开始聊天，可附带图片与文档；顶部可切换模型或开启对比模式。</p>`;
  }
  box.appendChild(wrap);
}

function addCodeCopyButtons(root) {
  root.querySelectorAll('pre.code-block').forEach((pre) => {
    if (pre.querySelector('.code-copy')) return;
    const btn = document.createElement('button');
    btn.className = 'code-copy';
    btn.type = 'button';
    btn.textContent = '复制';
    btn.addEventListener('click', async () => {
      const code = pre.querySelector('code');
      try {
        await navigator.clipboard.writeText(code ? code.innerText : pre.innerText);
        btn.textContent = '已复制';
        setTimeout(() => (btn.textContent = '复制'), 1500);
      } catch {
        toast('复制失败', 'error');
      }
    });
    pre.appendChild(btn);
  });
}

/** 文档片段的元信息文案，如「3 页 · 1200 字」 */
function docMetaText(part) {
  const chars = (part.text || '').length;
  return [
    part.pages ? `${part.pages} 页` : '',
    chars ? `${chars} 字` : '无文本',
    part.truncated ? '已截断' : '',
  ]
    .filter(Boolean)
    .join(' · ');
}

/** 消息气泡内的文档片段：点击标题行可展开查看已提取的文本 */
function renderDocPart(part) {
  const box = document.createElement('details');
  box.className = 'doc-part';

  const head = document.createElement('summary');
  const icon = document.createElement('span');
  icon.className = 'doc-icon';
  icon.innerHTML = DOC_SVG;
  const name = document.createElement('span');
  name.className = 'doc-name';
  name.textContent = part.name || '未命名文档';
  const meta = document.createElement('span');
  meta.className = 'doc-meta';
  meta.textContent = docMetaText(part);
  head.append(icon, name, meta);

  const pre = document.createElement('pre');
  pre.className = 'doc-text';
  pre.textContent = part.text || '（未能提取到文本内容）';

  box.append(head, pre);
  return box;
}

/** 回复头：AI 标签 +（已知时）产出它的模型 */
function renderRoleHead(msg) {
  const head = document.createElement('div');
  head.className = 'role-head';
  const label = document.createElement('span');
  label.className = 'role-label';
  label.textContent = 'AI';
  head.appendChild(label);
  if (msg.model) {
    const provider = providerById(msg.model.providerId);
    if (provider) {
      const dot = document.createElement('span');
      dot.className = 'branch-dot';
      dot.style.background = providerColor(provider.id);
      head.appendChild(dot);
    }
    const name = document.createElement('span');
    name.className = 'branch-model';
    name.textContent = msg.model.model;
    name.title = provider ? `${provider.name} · ${msg.model.model}` : msg.model.model;
    head.appendChild(name);
  }
  return head;
}

function usageItem(text, className = '') {
  const span = document.createElement('span');
  span.className = 'u-item' + (className ? ' ' + className : '');
  span.textContent = text;
  return span;
}

/** 回复页脚：token 用量、费用估算与耗时 */
function renderUsageFoot(msg) {
  const foot = document.createElement('div');
  foot.className = 'usage-foot';
  const u = msg.usage;

  if (u) {
    const approx = u.estimated ? '≈' : '';
    foot.append(
      usageItem(`提示 ${approx}${formatTokens(u.promptTokens)}`),
      usageItem(`输出 ${approx}${formatTokens(u.completionTokens)}`),
      usageItem(`合计 ${approx}${formatTokens(u.totalTokens)}`)
    );
    const price = resolvePrice(providerById(msg.model && msg.model.providerId), msg.model && msg.model.model);
    if (price) {
      const item = usageItem(formatCost(computeCost(u, price).total), 'u-cost');
      item.title =
        price.source === 'provider'
          ? '按该服务配置的单价估算（人民币）'
          : '按内置参考价估算（人民币，可能已过时），可在 API 服务设置中覆盖';
      foot.appendChild(item);
    }
    foot.title = u.estimated
      ? '接口未返回 usage，此处按字符数粗略估算（图片按固定值计）'
      : '用量来自接口返回的 usage 字段';
  }

  if (typeof msg.ms === 'number') {
    foot.appendChild(usageItem(`用时 ${(msg.ms / 1000).toFixed(1)}s`, 'u-time'));
  }
  return foot;
}

function renderMessageEl(msg) {
  const el = document.createElement('article');
  el.className = `msg ${msg.role}`;
  el.dataset.id = msg.id;

  if (msg.role === 'user') {
    const label = document.createElement('div');
    label.className = 'role-label';
    label.textContent = '你';

    const bubble = document.createElement('div');
    bubble.className = 'bubble';
    for (const part of msg.content) {
      if (part.type === 'image' && part.dataUrl) {
        const img = document.createElement('img');
        img.className = 'bubble-img';
        img.src = part.dataUrl;
        img.alt = part.name || '图片';
        bubble.appendChild(img);
      } else if (part.type === 'file') {
        bubble.appendChild(renderDocPart(part));
      } else if (part.type === 'text' && part.text) {
        bubble.appendChild(document.createTextNode(part.text));
      }
    }
    el.append(label, bubble);
    return el;
  }

  // assistant（可能带错误标记）
  const label = renderRoleHead(msg);

  const text = msg.content.map((p) => (p.type === 'text' ? p.text : '')).join('');

  if (msg.error) {
    const card = document.createElement('div');
    card.className = 'msg-error';
    const textSpan = document.createElement('span');
    textSpan.style.flex = '1';
    textSpan.textContent = text || '生成失败';
    const retry = document.createElement('button');
    retry.className = 'retry-btn';
    retry.textContent = '重试';
    retry.addEventListener('click', () => retryFrom(msg.id));
    card.append(textSpan, retry);
    el.append(label, card);
    return el;
  }

  const prose = document.createElement('div');
  prose.className = 'prose';
  if (text) {
    prose.innerHTML = renderMarkdown(text, hljs);
    addCodeCopyButtons(prose);
  } else if (streaming) {
    prose.classList.add('stream-cursor');
  }
  el.append(label, prose);
  if (msg.usage || typeof msg.ms === 'number') el.appendChild(renderUsageFoot(msg));
  return el;
}

function renderMessages({ keepScroll = false } = {}) {
  const box = $('#messages');
  const session = store.getActiveSession(state);
  renderSessionTools(session);
  if (!session || !session.messages.length) {
    renderEmptyState();
    $('#topbar-title').textContent = session ? session.title : '新会话';
    refreshSearch();
    return;
  }
  const nearBottom = box.scrollHeight - box.scrollTop - box.clientHeight < 120;
  box.innerHTML = '';
  const col = document.createElement('div');
  col.className = 'msg-col';
  const groups = store.groupMessages(session.messages);
  let hasCompareRow = false;
  for (const group of groups) {
    if (group.length > 1) {
      hasCompareRow = true;
      col.appendChild(renderCompareRow(group));
    } else {
      col.appendChild(renderMessageEl(group[0]));
    }
  }
  if (hasCompareRow) col.classList.add('compare');
  box.appendChild(col);
  $('#topbar-title').textContent = session.title;
  if (!keepScroll || nearBottom) box.scrollTop = box.scrollHeight;
  refreshSearch();
}

/** 空会话时搜索与导出没有意义，直接禁用 */
function renderSessionTools(session) {
  const hasMessages = !!(session && session.messages.length);
  $('#btn-search').disabled = !hasMessages;
  $('#btn-export').disabled = !hasMessages;
  renderPromptFlag();
}

/** 同一批对比回复左右分栏展示 */
function renderCompareRow(messages) {
  const row = document.createElement('div');
  row.className = 'compare-row';
  row.style.setProperty('--cols', String(messages.length));
  for (const msg of messages) row.appendChild(renderMessageEl(msg));
  return row;
}

function renderAll() {
  renderSessions();
  renderModelSelect();
  renderMessages();
}

// ---------- 发送与生成 ----------

function autoGrow() {
  const input = $('#input');
  input.style.height = 'auto';
  input.style.height = Math.min(input.scrollHeight, 180) + 'px';
}

function setStreamingUI(on) {
  streaming = on;
  $('#btn-send').classList.toggle('hidden', on);
  $('#btn-stop').classList.toggle('hidden', !on);
}

function validateSend() {
  if (readingAttachments > 0) return '附件正在解析中，请稍候';
  if (!hasSendableContent()) return '请输入消息或添加图片/文档';
  if (!state.providers.length) return '请先添加 API 服务';
  if (compareEnabled()) {
    const targets = compareTargets();
    if (targets.length < store.MAX_COMPARE_TARGETS) {
      return `对比模式需要选择 ${store.MAX_COMPARE_TARGETS} 个模型（当前 ${targets.length} 个）`;
    }
    if (!sendTargets().targets.length) return '对比模式所选服务已不存在，请重新选择';
    return null;
  }
  if (!state.selectedModel) return '请选择模型';
  const p = selectedProvider();
  if (!p) return '所选服务不存在，请重新选择';
  if (p.models.length && !p.models.includes(state.selectedModel.model)) {
    return '所选模型已不在该服务的模型列表中，请重新选择';
  }
  return null;
}

async function send() {
  if (streaming) {
    toast('正在生成中，请先停止');
    return;
  }
  const err = validateSend();
  if (err) {
    if (!state.providers.length) openSettings('api');
    toast(err, 'error');
    return;
  }
  const session = store.getActiveSession(state) || store.createSession(state, state.selectedModel);

  const text = $('#input').value.trim();
  const content = [];
  if (text) content.push({ type: 'text', text });
  content.push(...toMessageParts(attachments));

  store.addMessage(state, session.id, { role: 'user', content });
  $('#input').value = '';
  autoGrow();
  clearAttachments();
  persist();
  renderSessions();
  renderMessages();
  $('#topbar-title').textContent = session.title;

  await generate();
}

/** 消息里是否含有实际内容（用于跳过流式占位与空回复） */
function hasContent(msg) {
  return (msg.content || []).some((p) => p.type !== 'text' || (p.text || '').trim());
}

/**
 * 组装某个分支要发出的历史消息。
 * 对比模式下每个分支只看得到「用户消息 + 自己的历史回复」，
 * 避免互相参考对方答案而失去可比性；非对比模式则使用完整历史。
 * 会话选定的系统提示以 role=system 前置，且不进入 session.messages。
 */
function buildApiMessages(session, target, comparing) {
  const history = session.messages
    .filter((m) => {
      if (m.error || !hasContent(m)) return false;
      if (!comparing) return true;
      if (m.role !== 'assistant') return true;
      if (!m.model) return true; // 非对比模式产生的回复，视为共享上下文
      return m.model.providerId === target.provider.id && m.model.model === target.model;
    })
    .map((m) => ({ role: m.role, content: m.content }));

  const systemPrompt = store.systemPromptText(session);
  return systemPrompt ? [{ role: 'system', content: systemPrompt }, ...history] : history;
}

/** 为每个目标创建占位回复（对比模式下共享同一 batchId，便于分栏渲染） */
function startBranches(session, targets) {
  const comparing = targets.length > 1;
  const batchId = comparing ? store.uid() : null;
  const specs = targets.map((target) => ({
    target,
    message: store.addMessage(state, session.id, {
      role: 'assistant',
      content: [{ type: 'text', text: '' }],
      model: { providerId: target.provider.id, model: target.model },
      ...(batchId ? { batchId } : {}),
    }),
  }));
  persist();
  renderMessages({ keepScroll: true });
  return { specs, comparing };
}

/** 跑一个分支的流式生成，结束时写入正文、用量与耗时 */
async function runBranch({ session, spec, controller, started }) {
  const { provider, model } = spec.target;
  const msgId = spec.message.id;
  const apiMessages = spec.apiMessages;
  const promptEstimate = estimateApiTokens(apiMessages.map(toApiMessage));

  let lastPaint = 0;
  const paint = (full) => {
    const el = $('#messages').querySelector(`[data-id="${msgId}"]`);
    const prose = el ? el.querySelector('.prose') : null;
    if (!prose) return;
    const now = Date.now();
    if (now - lastPaint < 40) return;
    lastPaint = now;
    prose.innerHTML = renderMarkdown(full, hljs);
    addCodeCopyButtons(prose);
    const box = $('#messages');
    if (box.scrollHeight - box.scrollTop - box.clientHeight < 160) {
      box.scrollTop = box.scrollHeight;
    }
  };

  let full = '';
  let failure = null;
  let aborted = false;
  let apiUsage = null;

  try {
    const result = await streamChat({
      provider,
      model,
      messages: apiMessages,
      signal: controller.signal,
      onDelta: (_delta, text) => {
        full = text;
        paint(text);
      },
      onDone: (text) => {
        full = text || full;
      },
    });
    full = result.text || full;
    apiUsage = result.usage || null;
    aborted = result.aborted;
  } catch (e) {
    if (e && e.name === 'AbortError') aborted = true;
    else failure = (e && e.message) || String(e);
  }

  const s = store.getActiveSession(state);
  if (!s) return { aborted };
  const ms = Date.now() - started;

  if (failure) {
    store.updateMessage(state, s.id, msgId, {
      content: [{ type: 'text', text: failure }],
      error: true,
    });
  } else if (!full.trim()) {
    store.removeMessage(state, s.id, msgId); // 无任何产出，避免留下空气泡
  } else {
    const snapshot = s.systemPrompt;
    store.updateMessage(state, s.id, msgId, {
      content: [{ type: 'text', text: full }],
      ms,
      usage: usageToRecord(apiUsage, {
        promptTokens: promptEstimate,
        completionTokens: estimateTokens(full),
      }),
      ...(snapshot ? { systemPrompt: { name: snapshot.name, text: snapshot.text } } : {}),
    });
  }
  persist();
  return { aborted };
}

/** 并行执行若干分支，并统一收尾 */
async function runBranches({ session, specs }) {
  setStreamingUI(true);
  controllers = specs.map(() => new AbortController());
  const started = Date.now();
  let outcomes = [];
  let failed = null;
  try {
    outcomes = await Promise.all(
      specs.map((spec, i) => runBranch({ session, spec, controller: controllers[i], started }))
    );
  } catch (e) {
    // 分支里出现预期外的异常（例如持久化失败）时，先把界面恢复可用，再如实告知用户
    failed = e;
  } finally {
    controllers = [];
    setStreamingUI(false);
  }
  if (failed) {
    console.error('生成分支异常', failed);
    toast(`生成过程出错：${(failed && failed.message) || failed}`, 'error');
  }
  if (outcomes.some((o) => o && o.aborted)) toast('已停止生成');
  renderMessages({ keepScroll: true });
  renderSessions();
}

async function generate() {
  const session = store.getActiveSession(state);
  if (!session) return;
  const { comparing, targets } = sendTargets();
  if (!targets.length) return;

  const { specs } = startBranches(session, targets);
  for (const spec of specs) {
    spec.apiMessages = buildApiMessages(session, spec.target, comparing);
  }
  await runBranches({ session, specs });
}

async function retryFrom(errorMsgId) {
  if (streaming) return;
  const session = store.getActiveSession(state);
  if (!session) return;
  const msg = session.messages.find((m) => m.id === errorMsgId);
  if (!msg) return;

  // 对比模式的分支：只重跑这一条，其他分支与历史保持不变
  if (msg.batchId && msg.model) {
    const provider = providerById(msg.model.providerId);
    if (!provider) {
      toast('原服务已删除，无法重试', 'error');
      return;
    }
    store.resetMessage(state, session.id, msg.id);
    persist();
    renderMessages({ keepScroll: true });
    const target = { provider, model: msg.model.model };
    const spec = { target, message: msg, apiMessages: buildApiMessages(session, target, true) };
    await runBranches({ session, specs: [spec] });
    return;
  }

  // 单模型：移除错误消息与其前的最后一条用户消息后重新发送
  const idx = session.messages.findIndex((m) => m.id === errorMsgId);
  if (idx === -1) return;
  session.messages.splice(idx, 1);
  let lastUserIdx = -1;
  for (let i = session.messages.length - 1; i >= 0; i--) {
    if (session.messages[i].role === 'user') {
      lastUserIdx = i;
      break;
    }
  }
  const userMsg = lastUserIdx !== -1 ? session.messages[lastUserIdx] : null;
  if (userMsg) {
    session.messages.splice(lastUserIdx, 1);
    store.addMessage(state, session.id, { role: userMsg.role, content: userMsg.content });
  }
  persist();
  renderMessages();
  await generate();
}

function stop() {
  for (const c of controllers) c.abort();
}

// ---------- 系统提示（提示词模板） ----------

/** 会话当前生效的系统提示快照 */
function sessionSystemPrompt() {
  const session = store.getActiveSession(state);
  return (session && session.systemPrompt) || null;
}

function renderPromptFlag() {
  const snapshot = sessionSystemPrompt();
  const btn = $('#btn-pill-prompt');
  $('#prompt-flag').classList.toggle('hidden', !snapshot);
  btn.classList.toggle('has-value', !!snapshot);
  btn.title = snapshot
    ? `系统提示：${snapshot.name || '未命名模板'}（${snapshot.text.length} 字）`
    : '系统提示（本会话）';
  btn.setAttribute('aria-label', btn.title);
}

function closePromptMenu() {
  $('#prompt-menu').classList.add('hidden');
  $('#btn-pill-prompt').setAttribute('aria-expanded', 'false');
}

function renderPromptMenu() {
  const list = $('#prompt-menu-list');
  list.innerHTML = '';
  const current = sessionSystemPrompt();

  const head = document.createElement('div');
  head.className = 'menu-group';
  head.textContent = '系统提示模板';
  list.appendChild(head);

  if (!state.promptTemplates.length) {
    const empty = document.createElement('p');
    empty.className = 'prompt-menu-empty';
    empty.textContent = '还没有模板。在设置 → 提示词里新建后即可在这里选定。';
    list.appendChild(empty);
  }

  const options = [
    { id: null, name: '不使用', sub: '该会话不发送 system 消息' },
    ...state.promptTemplates.map((t) => ({
      id: t.id,
      name: t.name,
      sub: t.content ? `${t.content.length} 字` : '正文为空',
    })),
  ];

  for (const opt of options) {
    const active = (current ? current.templateId : null) === opt.id;
    const item = document.createElement('button');
    item.type = 'button';
    item.className = 'menu-item' + (active ? ' active' : '');
    item.setAttribute('role', 'menuitemradio');
    item.setAttribute('aria-checked', String(active));

    const text = document.createElement('span');
    text.className = 'menu-text';
    const name = document.createElement('span');
    name.className = 'menu-name';
    name.textContent = opt.name;
    const sub = document.createElement('span');
    sub.className = 'menu-sub';
    sub.textContent = opt.sub;
    text.append(name, sub);
    item.appendChild(text);

    if (active) {
      const check = document.createElement('span');
      check.className = 'menu-check';
      check.innerHTML = CHECK_SVG;
      item.appendChild(check);
    }
    item.addEventListener('click', (e) => {
      e.stopPropagation();
      applySystemPrompt(opt.id);
    });
    list.appendChild(item);
  }

  // 快照语义下模板正文可能已改动，明确给出「重新套用」入口
  if (current && current.templateId) {
    const t = store.findPromptTemplate(state, current.templateId);
    if (t && t.content.trim() && t.content.trim() !== current.text) {
      const reapply = document.createElement('button');
      reapply.type = 'button';
      reapply.className = 'prompt-menu-note';
      reapply.textContent = '模板已更新，点击重新套用最新正文';
      reapply.addEventListener('click', (e) => {
        e.stopPropagation();
        applySystemPrompt(current.templateId);
      });
      list.appendChild(reapply);
    }
  }

  const foot = document.createElement('button');
  foot.type = 'button';
  foot.className = 'model-menu-foot';
  foot.innerHTML = `${GEAR_SVG}<span>管理提示词模板</span>`;
  foot.addEventListener('click', (e) => {
    e.stopPropagation();
    closePromptMenu();
    openSettings('prompt');
  });
  list.appendChild(foot);
}

function togglePromptMenu() {
  const menu = $('#prompt-menu');
  const willOpen = menu.classList.contains('hidden');
  closeModelMenu();
  if (willOpen) renderPromptMenu();
  menu.classList.toggle('hidden', !willOpen);
  $('#btn-pill-prompt').setAttribute('aria-expanded', String(willOpen));
}

/** 把模板正文快照进当前会话；templateId 为 null 表示不使用 */
function applySystemPrompt(templateId) {
  const session = store.getActiveSession(state);
  if (!session) {
    toast('请先创建会话', 'error');
    return;
  }
  const template = templateId ? store.findPromptTemplate(state, templateId) : null;
  if (templateId && !template) {
    toast('模板不存在', 'error');
    return;
  }
  const applied = store.setSessionSystemPrompt(state, session.id, template);
  persist();
  renderPromptFlag();
  renderPromptMenu();
  closePromptMenu();
  if (!template) {
    toast('已取消系统提示');
  } else if (!applied) {
    toast(`模板「${template.name}」正文为空，等同于不使用`, 'error');
  } else {
    toast(`已应用系统提示：${template.name}`);
  }
}

// ---------- 提示词模板（设置页） ----------

let editingTemplateId = null;

function renderTemplateList() {
  const box = $('#template-list');
  box.innerHTML = '';
  if (!state.promptTemplates.length) {
    const tip = document.createElement('p');
    tip.className = 'form-hint';
    tip.textContent = '暂无模板，点击上方按钮新建。';
    box.appendChild(tip);
    return;
  }
  for (const t of state.promptTemplates) {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'provider-item' + (t.id === editingTemplateId ? ' active' : '');
    const name = document.createElement('span');
    name.textContent = t.name;
    const sub = document.createElement('span');
    sub.className = 'pi-sub';
    sub.textContent = t.content ? `${t.content.length} 字` : '正文为空';
    btn.append(name, sub);
    btn.addEventListener('click', () => fillTemplateForm(t.id));
    box.appendChild(btn);
  }
}

function resetTemplateForm() {
  editingTemplateId = null;
  $('#tf-id').value = '';
  $('#tf-name').value = '';
  $('#tf-content').value = '';
  $('#btn-del-template').classList.add('hidden');
  renderTemplateList();
  $('#tf-name').focus();
}

function fillTemplateForm(id) {
  const t = store.findPromptTemplate(state, id);
  if (!t) return;
  editingTemplateId = id;
  $('#tf-id').value = t.id;
  $('#tf-name').value = t.name;
  $('#tf-content').value = t.content;
  $('#btn-del-template').classList.remove('hidden');
  renderTemplateList();
}

function saveTemplateForm(e) {
  e.preventDefault();
  const id = $('#tf-id').value || '';
  const name = $('#tf-name').value.trim();
  const content = $('#tf-content').value;
  if (!name) {
    toast('模板名称不能为空', 'error');
    return;
  }
  if (content.length > store.MAX_PROMPT_CHARS) {
    toast(`正文最多 ${store.MAX_PROMPT_CHARS} 字符`, 'error');
    return;
  }
  const saved = store.savePromptTemplate(state, { id: id || undefined, name, content });
  if (!saved) {
    toast('保存失败', 'error');
    return;
  }
  persist();
  editingTemplateId = saved.id;
  fillTemplateForm(saved.id);
  renderPromptFlag();
  toast('已保存模板');
}

function deleteTemplateForm() {
  const id = $('#tf-id').value;
  const t = id ? store.findPromptTemplate(state, id) : null;
  if (!t) return;
  if (!confirm(`删除模板「${t.name}」？已选定它的会话仍保留当时的正文快照。`)) return;
  store.deletePromptTemplate(state, id);
  persist();
  resetTemplateForm();
  renderPromptFlag();
  toast('已删除模板');
}

// ---------- 会话导出 ----------

function downloadText(filename, text) {
  const url = URL.createObjectURL(new Blob([text], { type: 'text/markdown;charset=utf-8' }));
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

function exportSession() {
  const session = store.getActiveSession(state);
  if (!session || !session.messages.length) {
    toast('当前会话还没有可导出的消息', 'error');
    return;
  }
  const markdown = sessionToMarkdown(session, {
    now: new Date(),
    providerName: (id) => (providerById(id) || {}).name || '',
  });
  const filename = exportFilename(session);
  downloadText(filename, markdown);
  toast(`已导出 ${filename}`);
}

// ---------- 会话内搜索 ----------

const searchState = { hits: [], index: 0 };
let searchTimer = null;

function searchOpen() {
  return !$('#search-bar').classList.contains('hidden');
}

function setSearchCount(text) {
  $('#search-count').textContent = text;
}

/** 清掉已渲染的高亮，还原成原始文本 */
function clearSearchHighlights() {
  const box = $('#messages');
  for (const mark of box.querySelectorAll('mark.search-hit')) {
    const parent = mark.parentNode;
    if (!parent) continue;
    parent.replaceChild(document.createTextNode(mark.textContent), mark);
    parent.normalize();
  }
  searchState.hits = [];
  searchState.index = 0;
}

/** 在一条消息内把匹配片段包进 <mark>（跳过已包过的节点） */
function highlightIn(root, query) {
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, {
    acceptNode(node) {
      if (!node.nodeValue || !node.nodeValue.trim()) return NodeFilter.FILTER_REJECT;
      if (node.parentElement && node.parentElement.closest('mark.search-hit')) return NodeFilter.FILTER_REJECT;
      return NodeFilter.FILTER_ACCEPT;
    },
  });
  const nodes = [];
  while (walker.nextNode()) nodes.push(walker.currentNode);

  for (const node of nodes) {
    const text = node.nodeValue;
    const lower = text.toLowerCase();
    let idx = lower.indexOf(query);
    if (idx === -1) continue;

    const frag = document.createDocumentFragment();
    let last = 0;
    while (idx !== -1) {
      if (idx > last) frag.appendChild(document.createTextNode(text.slice(last, idx)));
      const mark = document.createElement('mark');
      mark.className = 'search-hit';
      mark.textContent = text.slice(idx, idx + query.length);
      frag.appendChild(mark);
      last = idx + query.length;
      idx = lower.indexOf(query, last);
    }
    if (last < text.length) frag.appendChild(document.createTextNode(text.slice(last)));
    node.parentNode.replaceChild(frag, node);
  }
}

function applySearch() {
  clearSearchHighlights();
  const query = normalizeQuery($('#search-input').value);
  if (!query) {
    setSearchCount('');
    return;
  }

  const session = store.getActiveSession(state);
  const { total, messageIds } = searchSession(session, query);
  if (!total) {
    setSearchCount('无匹配');
    return;
  }

  const box = $('#messages');
  for (const id of messageIds) {
    const el = box.querySelector(`[data-id="${id}"]`);
    if (el) highlightIn(el, query);
  }

  searchState.hits = Array.from(box.querySelectorAll('mark.search-hit'));
  if (!searchState.hits.length) {
    setSearchCount('无匹配');
    return;
  }
  focusHit(0);
}

function focusHit(index) {
  const hits = searchState.hits;
  if (!hits.length) return;
  searchState.index = ((index % hits.length) + hits.length) % hits.length;
  const active = hits[searchState.index];
  for (const hit of hits) hit.classList.toggle('active', hit === active);
  // 命中可能在折叠的文档预览里，先展开再滚动
  const details = active.closest('details');
  if (details && !details.open) details.open = true;
  active.scrollIntoView({ block: 'center' });
  setSearchCount(`${searchState.index + 1}/${hits.length}`);
}

function stepSearch(delta) {
  if (!searchState.hits.length) return;
  focusHit(searchState.index + delta);
}

/** 消息重绘后（切会话、流式结束等）重新套用高亮 */
function refreshSearch() {
  if (!searchOpen()) return;
  applySearch();
}

function openSearch() {
  if ($('#btn-search').disabled) {
    toast('当前会话还没有可搜索的消息', 'error');
    return;
  }
  $('#search-bar').classList.remove('hidden');
  const input = $('#search-input');
  input.focus();
  input.select();
  applySearch();
}

function closeSearch() {
  $('#search-bar').classList.add('hidden');
  $('#search-input').value = '';
  clearSearchHighlights();
  setSearchCount('');
}

// ---------- 附件 ----------

/** 附件是否可发送（文本或附件至少其一，且无解析中的附件） */
function hasSendableContent() {
  return $('#input').value.trim().length > 0 || attachments.length > 0;
}

function nextAttachId() {
  attachSeq += 1;
  return `att-${attachSeq}`;
}

function replaceAttachment(id, next) {
  const idx = attachments.findIndex((a) => a.id === id);
  if (idx !== -1) attachments[idx] = next;
}

function removeAttachment(id) {
  attachments = attachments.filter((a) => a.id !== id);
  renderAttachments();
}

function clearAttachments() {
  attachments = [];
  readingAttachments = 0;
  $('#file-input').value = '';
  renderAttachments();
}

function chipSubText(a) {
  if (a.kind === 'image') return formatBytes(a.size);
  const bits = [formatBytes(a.size)];
  if (a.pages) bits.push(`${a.pages} 页`);
  bits.push(a.text ? `${a.text.length} 字` : '未提取到文本');
  if (a.truncated) bits.push('已截断');
  return bits.join(' · ');
}

function renderAttachChip(a) {
  const chip = document.createElement('div');
  chip.className = 'attach-chip' + (a.loading ? ' loading' : '');
  chip.dataset.id = a.id;
  chip.dataset.kind = a.kind;

  if (a.kind === 'image' && a.dataUrl) {
    const img = document.createElement('img');
    img.className = 'chip-thumb';
    img.src = a.dataUrl;
    img.alt = a.name || '图片';
    chip.appendChild(img);
  } else {
    const icon = document.createElement('span');
    icon.className = 'chip-icon';
    icon.innerHTML = DOC_SVG;
    chip.appendChild(icon);
  }

  const body = document.createElement('div');
  body.className = 'chip-body';
  const name = document.createElement('span');
  name.className = 'chip-name';
  name.textContent = a.name || '未命名文件';
  name.title = a.name || '';
  const sub = document.createElement('span');
  sub.className = 'chip-sub';
  sub.textContent = a.loading ? '解析中…' : chipSubText(a);
  body.append(name, sub);

  const del = document.createElement('button');
  del.className = 'chip-del';
  del.type = 'button';
  del.title = '移除';
  del.setAttribute('aria-label', `移除 ${a.name || '附件'}`);
  del.innerHTML =
    '<svg viewBox="0 0 16 16" width="11" height="11"><path d="M4 4l8 8M12 4l-8 8" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"/></svg>';
  del.addEventListener('click', () => removeAttachment(a.id));

  chip.append(body, del);
  return chip;
}

function renderAttachments() {
  const strip = $('#attach-strip');
  strip.innerHTML = '';
  $('#attach-bar').classList.toggle('hidden', !attachments.length);
  for (const a of attachments) strip.appendChild(renderAttachChip(a));

  const summary = attachmentSummary(attachments);
  $('#attach-summary').textContent = summary
    ? summary + (isFull(attachments) ? ` · 已达 ${MAX_ATTACHMENTS} 个上限` : '')
    : '';
  $('#btn-attach').disabled = isFull(attachments) || readingAttachments > 0;
}

function readAsDataUrl(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result);
    reader.onerror = () => reject(new Error('读取文件失败'));
    reader.readAsDataURL(file);
  });
}

function readAsText(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result || ''));
    reader.onerror = () => reject(new Error('读取文件失败'));
    reader.readAsText(file);
  });
}

let pdfjsPromise = null;

/** 懒加载 pdf.js（体积较大，仅首次添加 PDF 时载入） */
function loadPdfjs() {
  if (!pdfjsPromise) {
    pdfjsPromise = import('./vendor/pdfjs/pdf.min.mjs')
      .then((lib) => {
        lib.GlobalWorkerOptions.workerSrc = new URL('./vendor/pdfjs/pdf.worker.min.mjs', import.meta.url).href;
        return lib;
      })
      .catch((e) => {
        pdfjsPromise = null; // 允许下次重试
        throw new Error(`PDF 解析库加载失败：${(e && e.message) || e}`);
      });
  }
  return pdfjsPromise;
}

async function readPdfText(file) {
  const pdfjsLib = await loadPdfjs();
  const { text, pages } = await extractPdfText({
    data: new Uint8Array(await file.arrayBuffer()),
    pdfjsLib,
    cMapUrl: new URL('./vendor/pdfjs/cmaps/', import.meta.url).href,
  });
  if (!text.trim()) {
    toast(`${file.name} 未提取到文本（可能是扫描件），将只发送文档名`, 'error');
  }
  return { text, pages };
}

/** 解析单个文件；解析期间的占位项在完成后就地替换 */
async function loadAttachment(file) {
  const kind = classifyFile(file);
  const id = nextAttachId();
  attachments.push({ id, kind, name: file.name, size: file.size, loading: true });
  readingAttachments += 1;
  renderAttachments();

  try {
    let loaded;
    if (kind === 'image') {
      loaded = { kind: 'image', name: file.name, size: file.size, dataUrl: await readAsDataUrl(file) };
    } else if (kind === 'pdf') {
      const { text, pages } = await readPdfText(file);
      loaded = makeDocAttachment({ name: file.name, text, pages, size: file.size });
    } else {
      loaded = makeDocAttachment({ name: file.name, text: await readAsText(file), size: file.size });
    }
    replaceAttachment(id, { ...loaded, id });
  } catch (e) {
    removeAttachment(id);
    toast(`${file.name} 解析失败：${(e && e.message) || e}`, 'error');
  } finally {
    readingAttachments = Math.max(0, readingAttachments - 1);
    renderAttachments();
  }
}

async function handleFiles(fileList) {
  const files = Array.from(fileList || []);
  if (!files.length) return;
  for (const file of files) {
    if (isFull(attachments)) {
      toast(`最多添加 ${MAX_ATTACHMENTS} 个附件`, 'error');
      break;
    }
    const err = checkFile(file);
    if (err) {
      toast(err, 'error');
      continue;
    }
    await loadAttachment(file);
  }
  renderAttachments();
}

// ---------- 设置 ----------

const THEME_LABELS = { light: '明亮', dark: '暗黑' };

function applyTheme(theme) {
  const value = store.normalizeTheme(theme);
  document.documentElement.dataset.theme = value;
  const meta = document.querySelector('meta[name="color-scheme"]');
  if (meta) meta.setAttribute('content', value);
  return value;
}

function renderThemeOptions() {
  const current = store.normalizeTheme(state.settings && state.settings.theme);
  for (const btn of document.querySelectorAll('#theme-options .theme-option')) {
    const active = btn.dataset.themeValue === current;
    btn.classList.toggle('active', active);
    btn.setAttribute('aria-pressed', String(active));
  }
}

function chooseTheme(theme) {
  const applied = store.setTheme(state, theme);
  persist();
  applyTheme(applied);
  renderThemeOptions();
  toast(`已切换到${THEME_LABELS[applied] || applied}主题`);
}

/** 切换设置面板：'appearance' | 'api' | 'prompt' */
const SETTINGS_PANELS = ['appearance', 'api', 'prompt'];

function switchSettingsPanel(panel) {
  const target = SETTINGS_PANELS.includes(panel) ? panel : 'appearance';
  for (const item of document.querySelectorAll('.settings-nav-item')) {
    const active = item.dataset.panel === target;
    item.classList.toggle('active', active);
    item.setAttribute('aria-selected', String(active));
  }
  for (const name of SETTINGS_PANELS) {
    $(`#panel-${name}`).classList.toggle('hidden', name !== target);
  }
}

function openSettings(panel = 'appearance') {
  renderThemeOptions();
  renderProviderList();
  renderTemplateList();
  switchSettingsPanel(panel);
  $('#settings-mask').classList.remove('hidden');
}

function closeSettings() {
  $('#settings-mask').classList.add('hidden');
}

let editingProviderId = null;

function renderProviderList() {
  const box = $('#provider-list');
  box.innerHTML = '';
  if (!state.providers.length) {
    const tip = document.createElement('p');
    tip.className = 'form-hint';
    tip.textContent = '暂无服务，点击上方按钮新增。';
    box.appendChild(tip);
    return;
  }
  for (const p of state.providers) {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'provider-item' + (p.id === editingProviderId ? ' active' : '');
    btn.innerHTML = '';
    const name = document.createElement('span');
    name.textContent = p.name;
    const sub = document.createElement('span');
    sub.className = 'pi-sub';
    sub.textContent = `${p.models.length} 个模型`;
    btn.append(name, sub);
    btn.addEventListener('click', () => fillProviderForm(p.id));
    box.appendChild(btn);
  }
}

function resetProviderForm() {
  editingProviderId = null;
  $('#pf-id').value = '';
  $('#pf-name').value = '';
  $('#pf-baseUrl').value = '';
  $('#pf-apiKey').value = '';
  $('#pf-models').value = '';
  $('#pf-proxyUrl').value = '';
  $('#pf-priceInput').value = '';
  $('#pf-priceOutput').value = '';
  $('#btn-del-provider').classList.add('hidden');
  renderProviderList();
  $('#pf-name').focus();
}

function fillProviderForm(id) {
  const p = providerById(id);
  if (!p) return;
  editingProviderId = id;
  $('#pf-id').value = p.id;
  $('#pf-name').value = p.name;
  $('#pf-baseUrl').value = p.baseUrl;
  $('#pf-apiKey').value = p.apiKey;
  $('#pf-models').value = p.models.join('\n');
  $('#pf-proxyUrl').value = p.proxyUrl || '';
  $('#pf-priceInput').value = p.price ? String(p.price.input) : '';
  $('#pf-priceOutput').value = p.price ? String(p.price.output) : '';
  $('#btn-del-provider').classList.remove('hidden');
  renderProviderList();
}

/** 读取单价输入：两者都空视为未配置，只填一半则报错 */
function readPriceInputs() {
  const rawInput = $('#pf-priceInput').value.trim();
  const rawOutput = $('#pf-priceOutput').value.trim();
  if (!rawInput && !rawOutput) return { price: null };
  const input = numOrNull(rawInput);
  const output = numOrNull(rawOutput);
  if (input === null || output === null || input < 0 || output < 0) {
    return { error: '单价需填写两个非负数字，或两者都留空' };
  }
  return { price: { input, output } };
}

function saveProviderForm(e) {
  e.preventDefault();
  const id = $('#pf-id').value || '';
  const name = $('#pf-name').value.trim();
  const baseUrl = $('#pf-baseUrl').value.trim();
  if (!name || !baseUrl) {
    toast('名称和 Base URL 为必填', 'error');
    return;
  }
  if (!/^https?:\/\//i.test(baseUrl)) {
    toast('Base URL 需以 http(s):// 开头', 'error');
    return;
  }
  const priceResult = readPriceInputs();
  if (priceResult.error) {
    toast(priceResult.error, 'error');
    return;
  }
  const models = $('#pf-models').value
    .split(/[\n,]/)
    .map((s) => s.trim())
    .filter(Boolean);

  const saved = store.saveProvider(state, {
    id: id || undefined,
    name,
    baseUrl,
    apiKey: $('#pf-apiKey').value,
    models,
    proxyUrl: $('#pf-proxyUrl').value.trim(),
    price: priceResult.price,
  });
  persist();

  // 默认选中该服务的第一个模型
  if (!state.selectedModel && saved.models.length) {
    state.selectedModel = { providerId: saved.id, model: saved.models[0] };
    persist();
  }

  editingProviderId = saved.id;
  fillProviderForm(saved.id);
  renderModelSelect();
  renderMessages();
  toast('已保存');
}

function deleteProviderForm() {
  const id = $('#pf-id').value;
  if (!id) return;
  const p = providerById(id);
  if (!p) return;
  if (!confirm(`删除服务「${p.name}」？相关模型选择会被清除。`)) return;
  store.deleteProvider(state, id);
  persist();
  resetProviderForm();
  renderModelSelect();
  renderMessages();
  toast('已删除');
}

// ---------- 侧边栏（移动端） ----------

function closeSidebarOnMobile() {
  if (window.innerWidth <= 860) $('#sidebar').classList.remove('open');
}

// ---------- 事件绑定 ----------

function bind() {
  $('#btn-new-chat').addEventListener('click', () => {
    if (streaming) {
      toast('生成中，请先停止');
      return;
    }
    const active = store.getActiveSession(state);
    if (active && !active.messages.length) {
      toast('当前已是空会话');
      closeSidebarOnMobile();
      return;
    }
    store.createSession(state, state.selectedModel);
    persist();
    renderAll();
    closeSidebarOnMobile();
    $('#input').focus();
  });

  $('#btn-pill-settings').addEventListener('click', (e) => {
    e.stopPropagation();
    closeModelMenu();
    openSettings('api');
  });
  $('#btn-compare-toggle').addEventListener('click', toggleCompare);
  $('#btn-pill-prompt').addEventListener('click', (e) => {
    e.stopPropagation();
    togglePromptMenu();
  });
  $('#btn-add-template').addEventListener('click', resetTemplateForm);
  $('#template-form').addEventListener('submit', saveTemplateForm);
  $('#btn-del-template').addEventListener('click', deleteTemplateForm);
  $('#btn-export').addEventListener('click', exportSession);
  $('#btn-search').addEventListener('click', openSearch);
  $('#btn-search-close').addEventListener('click', closeSearch);
  $('#btn-search-prev').addEventListener('click', () => stepSearch(-1));
  $('#btn-search-next').addEventListener('click', () => stepSearch(1));
  const searchInput = $('#search-input');
  searchInput.addEventListener('input', () => {
    clearTimeout(searchTimer);
    searchTimer = setTimeout(applySearch, 120);
  });
  searchInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      stepSearch(e.shiftKey ? -1 : 1);
    } else if (e.key === 'Escape') {
      e.preventDefault();
      closeSearch();
    }
  });
  $('#model-select').addEventListener('click', (e) => {
    e.stopPropagation();
    if (!state.providers.length) {
      openSettings();
      return;
    }
    toggleModelMenu();
  });
  document.addEventListener('click', (e) => {
    if (!$('#model-pill').contains(e.target)) {
      closeModelMenu();
      closePromptMenu();
    }
  });
  $('#btn-close-settings').addEventListener('click', closeSettings);
  $('#settings-mask').addEventListener('click', (e) => {
    if (e.target === $('#settings-mask')) closeSettings();
  });
  document.addEventListener('keydown', (e) => {
    // Ctrl/Cmd+F 走会话内搜索（设置弹窗打开时不拦截）
    if ((e.ctrlKey || e.metaKey) && !e.altKey && e.key.toLowerCase() === 'f') {
      if ($('#settings-mask').classList.contains('hidden')) {
        e.preventDefault();
        openSearch();
      }
      return;
    }
    if (e.key !== 'Escape') return;
    if (!$('#prompt-menu').classList.contains('hidden')) {
      closePromptMenu();
      return;
    }
    if (!$('#model-menu').classList.contains('hidden')) {
      closeModelMenu();
      return;
    }
    if (!$('#settings-mask').classList.contains('hidden')) {
      closeSettings();
      return;
    }
    if (searchOpen()) closeSearch();
  });

  $('#btn-add-provider').addEventListener('click', resetProviderForm);
  $('#provider-form').addEventListener('submit', saveProviderForm);
  $('#btn-del-provider').addEventListener('click', deleteProviderForm);

  for (const item of document.querySelectorAll('.settings-nav-item')) {
    item.addEventListener('click', () => switchSettingsPanel(item.dataset.panel));
  }
  for (const opt of document.querySelectorAll('#theme-options .theme-option')) {
    opt.addEventListener('click', () => chooseTheme(opt.dataset.themeValue));
  }
  $('#btn-sidebar-settings').addEventListener('click', () => {
    closeSidebarOnMobile();
    openSettings('appearance');
  });

  $('#btn-send').addEventListener('click', send);
  $('#btn-stop').addEventListener('click', stop);

  const input = $('#input');
  input.addEventListener('input', autoGrow);
  input.addEventListener('keydown', (e) => {
    if (e.key !== 'Enter' || e.shiftKey || e.isComposing || e.keyCode === 229) return;
    e.preventDefault();
    send();
  });

  $('#btn-attach').addEventListener('click', () => $('#file-input').click());
  $('#file-input').addEventListener('change', (e) => {
    const files = Array.from(e.target.files || []);
    e.target.value = ''; // 允许再次选择同一文件
    handleFiles(files);
  });
  $('#btn-attach-clear').addEventListener('click', clearAttachments);

  $('#btn-toggle-sidebar').addEventListener('click', () => $('#sidebar').classList.toggle('open'));
  document.addEventListener('click', (e) => {
    const sidebar = $('#sidebar');
    if (window.innerWidth > 860 || !sidebar.classList.contains('open')) return;
    if (!sidebar.contains(e.target) && !$('#btn-toggle-sidebar').contains(e.target)) {
      sidebar.classList.remove('open');
    }
  });
}

// ---------- 启动 ----------

function init() {
  if (!state.sessions.length) store.createSession(state, state.selectedModel);
  applyTheme(state.settings && state.settings.theme);
  bind();
  renderAll();
  renderAttachments();
  renderThemeOptions();
  renderCompareUI();
  autoGrow();
  // 放在绑定与渲染之后：写入失败也不能让整个界面失去响应
  persist();
}

init();
