/**
 * search.js — 会话内搜索（纯逻辑，无 DOM 依赖）
 * 匹配规则：不区分大小写的子串匹配，不做正则解析（用户输入按字面处理）。
 */

export function normalizeQuery(query) {
  return String(query === null || query === undefined ? '' : query)
    .trim()
    .toLowerCase();
}

/** 统计 text 中 query 出现的次数（不重叠） */
export function countOccurrences(text, query) {
  const q = normalizeQuery(query);
  if (!q) return 0;
  const hay = String(text === null || text === undefined ? '' : text).toLowerCase();
  let count = 0;
  let idx = hay.indexOf(q);
  while (idx !== -1) {
    count += 1;
    idx = hay.indexOf(q, idx + q.length);
  }
  return count;
}

/** 一条消息中参与搜索的文本：正文 + 附件名 + 文档提取出的正文 */
export function searchableText(msg) {
  const parts = (msg && Array.isArray(msg.content) ? msg.content : []);
  return parts
    .map((p) => {
      if (!p) return '';
      if (p.type === 'text') return p.text || '';
      if (p.type === 'file') return `${p.name || ''}\n${p.text || ''}`;
      if (p.type === 'image') return p.name || '';
      return '';
    })
    .join('\n');
}

/**
 * 在当前会话中搜索。
 * @returns {{query:string, total:number, messageIds:string[]}} messageIds 为命中的消息 id（按顺序）
 */
export function searchSession(session, query) {
  const q = normalizeQuery(query);
  const messages = session && Array.isArray(session.messages) ? session.messages : [];
  if (!q) return { query: '', total: 0, messageIds: [] };

  let total = 0;
  const messageIds = [];
  for (const msg of messages) {
    if (!msg) continue;
    const hits = countOccurrences(searchableText(msg), q);
    if (!hits) continue;
    total += hits;
    messageIds.push(msg.id);
  }
  return { query: q, total, messageIds };
}
