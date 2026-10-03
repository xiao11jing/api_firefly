/**
 * main.js — 界面交互与状态装配
 */
import * as store from './storage.js';
import { streamChat } from './provider.js';
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

const $ = (sel) => document.querySelector(sel);
const hljs = window.hljs || null;

/** @type {ReturnType<typeof store.defaultState>} */
let state = store.loadState(window.localStorage);
let attachments = []; // 待发送附件：{ id, kind, name, size, dataUrl? | text? }
let attachSeq = 0;
let readingAttachments = 0; // 正在解析（PDF/文本读取）中的附件数
let abortCtrl = null;
let streaming = false;
let lastRenderAt = 0;

// ---------- 基础工具 ----------

let toastTimer = null;
function toast(msg, type = '') {
  const el = $('#toast');
  el.textContent = msg;
  el.className = 'toast' + (type ? ' ' + type : '');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.add('hidden'), 3200);
}

function persist() {
  store.saveState(window.localStorage, state);
}

function providerById(id) {
  return state.providers.find((p) => p.id === id) || null;
}

function selectedProvider() {
  if (!state.selectedModel) return null;
  return providerById(state.selectedModel.providerId);
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
    item.addEventListener('click', () => {
      if (streaming) {
        toast('生成中，请先停止或等待完成');
        return;
      }
      state.activeSessionId = s.id;
      persist();
      renderAll();
      closeSidebarOnMobile();
    });
    item.addEventListener('dblclick', () => startRename(item, s, title));
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

  let hasMatch = false;
  for (const p of state.providers) {
    const head = document.createElement('div');
    head.className = 'menu-group';
    head.textContent = p.name;
    list.appendChild(head);

    const models = p.models.length ? p.models : ['（未填模型名）'];
    for (const m of models) {
      const active = !!(
        state.selectedModel &&
        state.selectedModel.providerId === p.id &&
        state.selectedModel.model === m
      );
      if (active) hasMatch = true;

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
        const check = document.createElement('span');
        check.className = 'menu-check';
        check.innerHTML = CHECK_SVG;
        item.appendChild(check);
      }
      item.addEventListener('click', (e) => {
        e.stopPropagation();
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
      <p>输入消息开始聊天，可附带图片与文档；顶部可随时切换模型。</p>`;
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
  const label = document.createElement('div');
  label.className = 'role-label';
  label.textContent = 'AI';

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
  return el;
}

function renderMessages({ keepScroll = false } = {}) {
  const box = $('#messages');
  const session = store.getActiveSession(state);
  if (!session || !session.messages.length) {
    renderEmptyState();
    $('#topbar-title').textContent = session ? session.title : '新会话';
    return;
  }
  const nearBottom = box.scrollHeight - box.scrollTop - box.clientHeight < 120;
  box.innerHTML = '';
  const col = document.createElement('div');
  col.className = 'msg-col';
  for (const msg of session.messages) col.appendChild(renderMessageEl(msg));
  box.appendChild(col);
  $('#topbar-title').textContent = session.title;
  if (!keepScroll || nearBottom) box.scrollTop = box.scrollHeight;
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

async function generate() {
  const session = store.getActiveSession(state);
  const provider = selectedProvider();
  if (!session || !provider || !state.selectedModel) return;

  const assistant = store.addMessage(state, session.id, {
    role: 'assistant',
    content: [{ type: 'text', text: '' }],
  });
  persist();
  renderMessages({ keepScroll: true });

  setStreamingUI(true);
  abortCtrl = new AbortController();

  const apiMessages = session.messages
    .filter((m) => !m.error && m.id !== assistant.id)
    .map((m) => ({ role: m.role, content: m.content }));

  const col = $('#messages').querySelector('.msg-col');
  const msgEl = col ? col.querySelector(`[data-id="${assistant.id}"]`) : null;
  const prose = msgEl ? msgEl.querySelector('.prose') : null;

  const paint = (full) => {
    if (!prose) return;
    const now = Date.now();
    if (now - lastRenderAt < 40) return;
    lastRenderAt = now;
    prose.innerHTML = renderMarkdown(full, hljs);
    addCodeCopyButtons(prose);
    const box = $('#messages');
    if (box.scrollHeight - box.scrollTop - box.clientHeight < 160) {
      box.scrollTop = box.scrollHeight;
    }
  };

  try {
    const result = await streamChat({
      provider,
      model: state.selectedModel.model,
      messages: apiMessages,
      signal: abortCtrl.signal,
      onDelta: (_delta, full) => paint(full),
      onDone: (full) => {
        if (full) {
          const m = store.updateMessage(state, session.id, assistant.id, {
            content: [{ type: 'text', text: full }],
          });
          if (m) persist();
        }
      },
    });
    if (result.aborted) {
      toast('已停止生成');
    }
  } catch (e) {
    const msg =
      e && e.name === 'AbortError'
        ? null
        : (e && e.message) || String(e);
    if (msg) {
      store.updateMessage(state, session.id, assistant.id, {
        content: [{ type: 'text', text: msg }],
        error: true,
      });
      persist();
    }
  } finally {
    // 若从未产生任何文本，移除空的占位消息，避免对话里出现空气泡
    const s = store.getActiveSession(state);
    if (s) {
      const idx = s.messages.findIndex((m) => m.id === assistant.id);
      if (idx !== -1) {
        const m = s.messages[idx];
        const t = m.content.map((c) => c.text || '').join('');
        if (!t && !m.error) {
          s.messages.splice(idx, 1);
          persist();
        }
      }
    }
    setStreamingUI(false);
    abortCtrl = null;
    renderMessages({ keepScroll: true });
    renderSessions();
  }
}

async function retryFrom(errorMsgId) {
  if (streaming) return;
  const session = store.getActiveSession(state);
  if (!session) return;
  const idx = session.messages.findIndex((m) => m.id === errorMsgId);
  if (idx === -1) return;
  // 移除错误消息及其之前的最后一条用户消息，重新发送
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
    // 从历史中移除该用户消息，generate 会重新添加 AI 回复；直接重新走完整发送
    session.messages.splice(lastUserIdx, 1);
    store.addMessage(state, session.id, { role: userMsg.role, content: userMsg.content });
  }
  persist();
  renderMessages();
  await generate();
}

function stop() {
  if (abortCtrl) abortCtrl.abort();
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

/** 切换设置面板：'appearance' | 'api' */
function switchSettingsPanel(panel) {
  const target = panel === 'api' ? 'api' : 'appearance';
  for (const tab of document.querySelectorAll('.settings-tab')) {
    const active = tab.dataset.panel === target;
    tab.classList.toggle('active', active);
    tab.setAttribute('aria-selected', String(active));
  }
  $('#panel-appearance').classList.toggle('hidden', target !== 'appearance');
  $('#panel-api').classList.toggle('hidden', target !== 'api');
}

function openSettings(panel = 'appearance') {
  renderThemeOptions();
  renderProviderList();
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
  $('#btn-del-provider').classList.remove('hidden');
  renderProviderList();
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
  $('#model-select').addEventListener('click', (e) => {
    e.stopPropagation();
    if (!state.providers.length) {
      openSettings();
      return;
    }
    toggleModelMenu();
  });
  document.addEventListener('click', (e) => {
    if (!$('#model-pill').contains(e.target)) closeModelMenu();
  });
  $('#btn-close-settings').addEventListener('click', closeSettings);
  $('#settings-mask').addEventListener('click', (e) => {
    if (e.target === $('#settings-mask')) closeSettings();
  });
  document.addEventListener('keydown', (e) => {
    if (e.key !== 'Escape') return;
    if (!$('#model-menu').classList.contains('hidden')) {
      closeModelMenu();
      return;
    }
    if (!$('#settings-mask').classList.contains('hidden')) closeSettings();
  });

  $('#btn-add-provider').addEventListener('click', resetProviderForm);
  $('#provider-form').addEventListener('submit', saveProviderForm);
  $('#btn-del-provider').addEventListener('click', deleteProviderForm);

  for (const tab of document.querySelectorAll('.settings-tab')) {
    tab.addEventListener('click', () => switchSettingsPanel(tab.dataset.panel));
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
  persist();
  applyTheme(state.settings && state.settings.theme);
  bind();
  renderAll();
  renderAttachments();
  renderThemeOptions();
  autoGrow();
}

init();
