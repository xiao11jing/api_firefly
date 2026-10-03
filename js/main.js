/**
 * main.js — 界面交互与状态装配
 */
import * as store from './storage.js';
import { streamChat } from './provider.js';
import { renderMarkdown } from './markdown.js';

const $ = (sel) => document.querySelector(sel);
const hljs = window.hljs || null;

/** @type {ReturnType<typeof store.defaultState>} */
let state = store.loadState(window.localStorage);
let pendingImage = null; // { dataUrl, name }
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

function renderModelSelect() {
  const sel = $('#model-select');
  const dot = $('#model-dot');
  sel.innerHTML = '';

  if (!state.providers.length) {
    const opt = document.createElement('option');
    opt.value = '';
    opt.textContent = '先在设置中添加 API 服务';
    sel.appendChild(opt);
    sel.disabled = true;
    dot.classList.remove('on');
    return;
  }
  sel.disabled = false;

  const placeholder = document.createElement('option');
  placeholder.value = '';
  placeholder.textContent = '选择模型…';
  sel.appendChild(placeholder);

  let hasMatch = false;
  for (const p of state.providers) {
    const group = document.createElement('optgroup');
    group.label = p.name;
    for (const m of p.models.length ? p.models : ['（未填模型名）']) {
      const opt = document.createElement('option');
      opt.value = `${p.id}::${m}`;
      opt.textContent = m;
      if (state.selectedModel && state.selectedModel.providerId === p.id && state.selectedModel.model === m) {
        opt.selected = true;
        hasMatch = true;
      }
      group.appendChild(opt);
    }
    sel.appendChild(group);
  }
  sel.value = hasMatch ? `${state.selectedModel.providerId}::${state.selectedModel.model}` : '';
  dot.classList.toggle('on', hasMatch);
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
    btn.addEventListener('click', () => openSettings());
    wrap.appendChild(btn);
  } else {
    wrap.innerHTML = `
      <div class="es-mark"><svg viewBox="0 0 24 24" width="22" height="22"><path d="M4 6h16v10H8l-4 4V6Z" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linejoin="round"/></svg></div>
      <h3>开始新对话</h3>
      <p>输入消息开始聊天，可附带图片；顶部可随时切换模型。</p>`;
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
  const hasText = $('#input').value.trim().length > 0;
  if (!hasText && !pendingImage) return '请输入消息或添加图片';
  if (!state.providers.length) return '请先在设置中添加 API 服务';
  if (!state.selectedModel) return '请在顶部选择模型';
  const p = selectedProvider();
  if (!p) return '所选服务不存在，请重新选择';
  return null;
}

async function send() {
  if (streaming) {
    toast('正在生成中，请先停止');
    return;
  }
  const err = validateSend();
  if (err) {
    if (!state.providers.length) openSettings();
    toast(err, 'error');
    return;
  }
  const session = store.getActiveSession(state) || store.createSession(state, state.selectedModel);

  const text = $('#input').value.trim();
  const content = [];
  if (text) content.push({ type: 'text', text });
  if (pendingImage) content.push({ type: 'image', dataUrl: pendingImage.dataUrl, name: pendingImage.name });

  store.addMessage(state, session.id, { role: 'user', content });
  $('#input').value = '';
  autoGrow();
  clearAttachment();
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

function clearAttachment() {
  pendingImage = null;
  $('#attach-preview').classList.add('hidden');
  $('#file-input').value = '';
}

function handleFile(file) {
  if (!file) return;
  if (!/^image\//.test(file.type)) {
    toast('MVP 阶段仅支持图片附件（文档支持在后续版本）', 'error');
    return;
  }
  if (file.size > 5 * 1024 * 1024) {
    toast('图片不能超过 5MB', 'error');
    return;
  }
  const reader = new FileReader();
  reader.onload = () => {
    pendingImage = { dataUrl: reader.result, name: file.name };
    $('#attach-thumb').src = reader.result;
    $('#attach-name').textContent = file.name;
    $('#attach-preview').classList.remove('hidden');
  };
  reader.onerror = () => toast('读取图片失败', 'error');
  reader.readAsDataURL(file);
}

// ---------- 设置 ----------

function openSettings() {
  $('#settings-mask').classList.remove('hidden');
  renderProviderList();
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

  $('#btn-settings').addEventListener('click', openSettings);
  $('#btn-close-settings').addEventListener('click', closeSettings);
  $('#settings-mask').addEventListener('click', (e) => {
    if (e.target === $('#settings-mask')) closeSettings();
  });
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && !$('#settings-mask').classList.contains('hidden')) closeSettings();
  });

  $('#btn-add-provider').addEventListener('click', resetProviderForm);
  $('#provider-form').addEventListener('submit', saveProviderForm);
  $('#btn-del-provider').addEventListener('click', deleteProviderForm);

  $('#model-select').addEventListener('change', (e) => {
    const v = e.target.value;
    if (!v) {
      state.selectedModel = null;
    } else {
      const sep = v.indexOf('::');
      state.selectedModel = { providerId: v.slice(0, sep), model: v.slice(sep + 2) };
    }
    persist();
    renderModelSelect();
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
  $('#file-input').addEventListener('change', (e) => handleFile(e.target.files[0]));
  $('#btn-attach-remove').addEventListener('click', clearAttachment);

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
  bind();
  renderAll();
  autoGrow();
}

init();
