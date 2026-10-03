/**
 * markdown.js — 轻量 Markdown 渲染（纯函数，无 DOM 依赖）
 * 安全策略：所有原始 HTML 一律转义输出，从源头杜绝 XSS；
 * 链接/图片地址仅允许 http(s)、mailto、相对路径与 data:image。
 * 代码高亮：可选注入 hljs（highlight.js）实例。
 */

export function escapeHtml(str) {
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function safeUrl(url, { image = false } = {}) {
  const u = String(url || '').trim();
  if (!u) return null;
  if (/^(https?:|mailto:)/i.test(u)) return u;
  if (image && /^data:image\/(png|jpe?g|gif|webp|avif|svg\+xml);/i.test(u)) return u;
  if (u.startsWith('/') || u.startsWith('#') || u.startsWith('./') || u.startsWith('../')) return u;
  return null; // javascript: 等危险协议
}

/** 行内语法：输入原始文本，输出 HTML（内部会做转义） */
export function renderInline(raw) {
  let text = String(raw ?? '');

  // 1. 抽出行内代码，防止后续语法干扰
  const codeSpans = [];
  text = text.replace(/`([^`\n]+)`/g, (_, code) => {
    codeSpans.push(code);
    return `\u0000C${codeSpans.length - 1}\u0000`;
  });

  // 2. 转义 HTML（原始标签在此被消灭）
  text = escapeHtml(text);

  // 3. 图片 ![alt](url)（url 来自已转义文本，先还原 & 再重新转义，避免 &amp;amp;）
  // URL 支持一层嵌套括号，如 javascript:alert(1) 也能被完整捕获并拦截
  const urlPat = '((?:[^()\\s]|\\([^()\\s]*\\))+)';
  text = text.replace(new RegExp(`!\\[([^\\]]*)\\]\\(${urlPat}\\)`, 'g'), (m, alt, url) => {
    const safe = safeUrl(url.replace(/&amp;/g, '&'), { image: true });
    if (!safe) return m;
    return `<img src="${escapeHtml(safe)}" alt="${escapeHtml(alt)}" loading="lazy">`;
  });

  // 4. 链接 [text](url)
  text = text.replace(new RegExp(`\\[([^\\]]+)\\]\\(${urlPat}\\)`, 'g'), (m, label, url) => {
    const safe = safeUrl(url.replace(/&amp;/g, '&'));
    if (!safe) return label; // 危险协议降级为纯文本
    return `<a href="${escapeHtml(safe)}" target="_blank" rel="noopener noreferrer">${label}</a>`;
  });

  // 5. 粗体 / 删除线 / 斜体（顺序敏感）
  text = text.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');
  text = text.replace(/__([^_]+)__/g, '<strong>$1</strong>');
  text = text.replace(/~~([^~]+)~~/g, '<del>$1</del>');
  text = text.replace(/(^|[^*\w])\*([^*\n]+)\*(?=[^*\w]|$)/g, '$1<em>$2</em>');
  text = text.replace(/(^|[^_\w])_([^_\n]+)_(?=[^_\w]|$)/g, '$1<em>$2</em>');

  // 6. 还原行内代码
  text = text.replace(/\u0000C(\d+)\u0000/g, (_, i) => `<code>${escapeHtml(codeSpans[Number(i)])}</code>`);

  return text;
}

function highlightCode(code, lang, hljs) {
  if (hljs) {
    try {
      if (lang && hljs.getLanguage && hljs.getLanguage(lang)) {
        return hljs.highlight(code, { language: lang, ignoreIllegals: true }).value;
      }
      if (hljs.highlightAuto) return hljs.highlightAuto(code).value;
    } catch {
      /* 回退到纯转义 */
    }
  }
  return escapeHtml(code);
}

function renderCodeBlock(code, lang, hljs) {
  const cls = lang ? ` class="language-${escapeHtml(lang)}"` : '';
  const inner = highlightCode(code, lang, hljs);
  return `<pre class="code-block"><code${cls}>${inner}</code></pre>`;
}

/** 解析表格块：首行表头，次行分隔线，其余为数据行 */
function tryParseTable(lines, i) {
  if (i + 1 >= lines.length) return null;
  const header = lines[i];
  const sep = lines[i + 1];
  if (!header.includes('|')) return null;
  if (!/^\s*\|?\s*:?-{2,}[-:\s|]*$/.test(sep)) return null;
  const splitRow = (row) =>
    row
      .trim()
      .replace(/^\|/, '')
      .replace(/\|$/, '')
      .split('|')
      .map((c) => c.trim());
  const head = splitRow(header);
  const rows = [];
  let j = i + 2;
  while (j < lines.length && lines[j].includes('|') && lines[j].trim()) {
    rows.push(splitRow(lines[j]));
    j++;
  }
  let html = '<div class="table-wrap"><table><thead><tr>';
  html += head.map((c) => `<th>${renderInline(c)}</th>`).join('');
  html += '</tr></thead><tbody>';
  for (const row of rows) {
    html += '<tr>' + row.map((c) => `<td>${renderInline(c)}</td>`).join('') + '</tr>';
  }
  html += '</tbody></table></div>';
  return { html, next: j };
}

/** 解析连续列表行（支持缩进嵌套），返回 HTML 与消费到的行号 */
function tryParseList(lines, start) {
  const items = []; // {depth, ordered, text}
  let i = start;
  const itemRe = /^(\s*)([-*+]|\d+\.)\s+(.*)$/;
  while (i < lines.length) {
    const m = lines[i].match(itemRe);
    if (!m) break;
    const indent = m[1].replace(/\t/g, '  ').length;
    items.push({ depth: Math.floor(indent / 2), ordered: /\d/.test(m[2]), text: m[3] });
    i++;
    // 列表项的续行（缩进的非列表行）并入当前项
    while (i < lines.length && lines[i].trim() && !itemRe.test(lines[i]) && /^\s+/.test(lines[i])) {
      items[items.length - 1].text += ' ' + lines[i].trim();
      i++;
    }
  }
  if (items.length === 0) return null;

  let html = '';
  const stack = []; // 每层：{ tag, liOpen }
  const closeTop = () => {
    const top = stack.pop();
    if (top.liOpen) html += '</li>';
    html += `</${top.tag}>`;
  };
  for (const item of items) {
    const tag = item.ordered ? 'ol' : 'ul';
    const d = Math.min(item.depth, stack.length);
    while (stack.length > d + 1) closeTop();
    if (stack.length === d + 1 && stack[d].tag !== tag) closeTop();
    while (stack.length <= d) {
      stack.push({ tag, liOpen: false });
      html += `<${tag}>`;
    }
    const top = stack[stack.length - 1];
    if (top.liOpen) html += '</li>';
    top.liOpen = true;
    html += `<li>${renderInline(item.text)}`;
  }
  while (stack.length) closeTop();
  return { html, next: i };
}

function renderBlocks(lines, hljs, depth = 0) {
  const out = [];
  let i = 0;
  while (i < lines.length) {
    const line = lines[i];

    // 空行
    if (!line.trim()) {
      i++;
      continue;
    }

    // 围栏代码块
    const fence = line.match(/^```(\S*)\s*$/);
    if (fence) {
      const lang = fence[1] || '';
      const buf = [];
      i++;
      while (i < lines.length && !/^```\s*$/.test(lines[i])) {
        buf.push(lines[i]);
        i++;
      }
      i++; // 跳过闭合 ```
      out.push(renderCodeBlock(buf.join('\n'), lang, hljs));
      continue;
    }

    // 标题
    const h = line.match(/^(#{1,6})\s+(.*)$/);
    if (h) {
      const level = h[1].length;
      out.push(`<h${level}>${renderInline(h[2])}</h${level}>`);
      i++;
      continue;
    }

    // 分隔线
    if (/^\s*(-{3,}|\*{3,}|_{3,})\s*$/.test(line)) {
      out.push('<hr>');
      i++;
      continue;
    }

    // 引用块
    if (/^>\s?/.test(line)) {
      const buf = [];
      while (i < lines.length && /^>\s?/.test(lines[i])) {
        buf.push(lines[i].replace(/^>\s?/, ''));
        i++;
      }
      if (depth < 3) {
        out.push(`<blockquote>${renderBlocks(buf, hljs, depth + 1)}</blockquote>`);
      }
      continue;
    }

    // 表格
    const table = tryParseTable(lines, i);
    if (table) {
      out.push(table.html);
      i = table.next;
      continue;
    }

    // 列表
    const list = tryParseList(lines, i);
    if (list) {
      out.push(list.html);
      i = list.next;
      continue;
    }

    // 段落：连续非空、非特殊起始行
    const buf = [line];
    i++;
    while (
      i < lines.length &&
      lines[i].trim() &&
      !/^(#{1,6}\s|```|>\s?|\s*[-*+]\s|\s*\d+\.\s|\s*(-{3,}|\*{3,}|_{3,})\s*$)/.test(lines[i]) &&
      !(i + 1 < lines.length && /^\s*\|?\s*:?-{2,}[-:\s|]*$/.test(lines[i + 1]) && lines[i].includes('|'))
    ) {
      buf.push(lines[i]);
      i++;
    }
    out.push(`<p>${buf.map(renderInline).join('<br>')}</p>`);
  }
  return out.join('');
}

/**
 * 渲染 Markdown 为安全 HTML。
 * @param {string} src
 * @param {object|null} hljs highlight.js 实例（可选）
 */
export function renderMarkdown(src, hljs = null) {
  if (src == null || src === '') return '';
  const normalized = String(src).replace(/\r\n?/g, '\n');
  return renderBlocks(normalized.split('\n'), hljs);
}
