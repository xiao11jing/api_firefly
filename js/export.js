/**
 * export.js — 会话导出为 Markdown（纯逻辑，无 DOM 依赖）
 */

const EXPORT_NOTE =
  '图片附件仅保留文件名，图片本身未包含在导出内容中；文档附件按发送时提取的文本内嵌。';

/** 各平台文件名非法字符 → 空格，并清理控制字符与首尾点号 */
export function safeFilename(name, fallback = '会话导出') {
  const cleaned = String(name === null || name === undefined ? '' : name)
    .replace(/[\u0000-\u001f\u007f]/g, '')
    .replace(/[\\/:*?"<>|]/g, ' ')
    .replace(/\s+/g, ' ')
    .replace(/^[.\s]+/, '')
    .replace(/[.\s]+$/, '');
  return cleaned.slice(0, 60) || fallback;
}

/** 导出文件名：<会话标题>.md */
export function exportFilename(session) {
  return `${safeFilename(session && session.title)}.md`;
}

/** 本地时间 YYYY-MM-DD HH:mm */
export function formatDateTime(date) {
  const d = date instanceof Date ? date : new Date(date);
  if (Number.isNaN(d.getTime())) return '';
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}

/** 选一个不会与正文冲突的代码围栏（正文里可能出现 ``` ） */
export function fenceFor(text) {
  const runs = String(text || '').match(/`+/g) || [];
  const longest = runs.reduce((max, run) => Math.max(max, run.length), 0);
  return '`'.repeat(Math.max(3, longest + 1));
}

function messageText(msg) {
  return (msg.content || [])
    .filter((p) => p.type === 'text')
    .map((p) => p.text || '')
    .join('');
}

function modelHeading(msg, providerName, aiLabel = 'AI') {
  if (!msg.model) return aiLabel;
  const provider = providerName(msg.model.providerId);
  return provider ? `${aiLabel}（${provider} · ${msg.model.model}）` : `${aiLabel}（${msg.model.model}）`;
}

/** 会话里用过的模型，按出现顺序去重 */
function modelSummary(session, providerName) {
  const seen = new Map();
  for (const msg of session.messages || []) {
    if (!msg || !msg.model) continue;
    const key = `${msg.model.providerId}::${msg.model.model}`;
    if (!seen.has(key)) seen.set(key, msg.model);
  }
  return [...seen.values()].map((m) => {
    const provider = providerName(m.providerId);
    return provider ? `${provider} · ${m.model}` : m.model;
  });
}

/** 回复的用量/耗时备注行 */
function usageNote(msg) {
  const bits = [];
  const u = msg.usage;
  if (u) {
    const approx = u.estimated ? '（估算）' : '';
    bits.push(
      `用量：提示 ${Math.round(u.promptTokens)} · 输出 ${Math.round(u.completionTokens)} · 合计 ${Math.round(u.totalTokens)}${approx}`
    );
  }
  if (typeof msg.ms === 'number') bits.push(`用时 ${(msg.ms / 1000).toFixed(1)}s`);
  return bits.join(' · ');
}

/** 当轮系统提示块（正文可能较长，用代码块包住） */
function promptBlock(snapshot) {
  const label = snapshot.name ? `**系统提示（${snapshot.name}）**` : '**系统提示**';
  const fence = fenceFor(snapshot.text);
  return [label, '', `${fence}text`, snapshot.text, fence, ''];
}

/**
 * 会话 → Markdown 文本。
 * @param {object} session
 * @param {object} [options]
 * @param {Date} [options.now] 导出时间
 * @param {(providerId:string)=>string} [options.providerName] 服务名解析
 * @param {{user?:string, ai?:string}} [options.profile] 自定义的用户/AI 名称
 */
export function sessionToMarkdown(
  session,
  { now = new Date(), providerName = () => '', profile = null } = {}
) {
  if (!session) return '';
  const userLabel = (profile && profile.user) || '你';
  const aiLabel = (profile && profile.ai) || 'AI';
  const messages = session.messages || [];
  const lines = [];
  let lastPrompt = ''; // 上一条回复用过的系统提示正文，用于「同上」去重

  lines.push(`# ${session.title || '新会话'}`, '');
  lines.push(`- 导出时间：${formatDateTime(now)}`);
  lines.push(`- 消息数：${messages.length}`);
  const models = modelSummary(session, providerName);
  if (models.length) lines.push(`- 模型：${models.join('、')}`);
  lines.push('', `> ${EXPORT_NOTE}`, '', '---', '');

  for (const msg of messages) {
    const isUser = msg.role === 'user';
    lines.push(isUser ? `## ${userLabel}` : `## ${modelHeading(msg, providerName, aiLabel)}`, '');

    if (msg.error) {
      lines.push(`> 生成失败：${messageText(msg) || '未知错误'}`, '');
    } else {
      if (!isUser) {
        const snapshot = msg.systemPrompt && msg.systemPrompt.text ? msg.systemPrompt : null;
        const text = snapshot ? snapshot.text : '';
        if (text && text !== lastPrompt) {
          lines.push(...promptBlock(snapshot));
          lastPrompt = text;
        } else if (text) {
          lines.push('> 系统提示：同上', '');
        } else if (lastPrompt) {
          lines.push('> 本轮未使用系统提示', '');
          lastPrompt = '';
        }
      }

      for (const part of msg.content || []) {
        if (part.type === 'text') {
          const text = (part.text || '').trim();
          if (text) lines.push(text, '');
        } else if (part.type === 'image') {
          lines.push(`> 图片附件：${part.name || '未命名图片'}`, '');
        } else if (part.type === 'file') {
          const fence = fenceFor(part.text);
          lines.push(`**文档附件：${part.name || '未命名文档'}**`, '');
          lines.push(`${fence}text`, part.text || '（未能提取到文本内容）', fence, '');
        }
      }
      const note = usageNote(msg);
      if (note) lines.push(`> ${note}`, '');
    }

    lines.push('---', '');
  }

  return `${lines.join('\n').replace(/\n{3,}/g, '\n\n').trimEnd()}\n`;
}
