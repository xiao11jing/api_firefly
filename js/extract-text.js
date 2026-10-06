/**
 * extract-text.js — 附件正文提取统一接口（learn_project.md §5.4）
 *
 * 新格式只在这里加实现，调用方（main.loadAttachment）保持不变：
 *   extractText(name, raw, deps) → { text, format }
 * - html/htm：DOMParser 提取可见正文（去 script/style/注释）；解析器缺失或抛错时回退正则
 * - 其余文本类（txt/md/json/css/js/py…）：原样保留
 *   extractDocxText(arrayBuffer, mammoth) → { text, format }（mammoth 懒加载，见 main.loadMammoth）
 */
import { fileExtension } from './attachments.js';

/** HTML 块级标签后补换行，避免 textContent 把段落粘在一起 */
const BLOCK_CLOSE_RE =
  /<\/(p|div|li|h[1-6]|tr|section|article|header|footer|blockquote|pre|table|ul|ol|dl|address|figure)>/gi;

function decodeEntities(text) {
  return String(text)
    .replace(/&nbsp;/gi, ' ')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/gi, "'")
    .replace(/&amp;/gi, '&');
}

function tidyLines(text) {
  return String(text)
    .split('\n')
    .map((line) => line.replace(/[ \t\f\v]+/g, ' ').trim())
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

/** 正则回退路径（node 单测 / DOMParser 不可用时） */
export function extractHtmlTextByRegex(html) {
  const cleaned = String(html == null ? '' : html)
    .replace(/<!--[\s\S]*?-->/g, '')
    .replace(/<head[\s\S]*?<\/head>/gi, '')
    .replace(/<script[\s\S]*?<\/script>/gi, '')
    .replace(/<style[\s\S]*?<\/style>/gi, '')
    .replace(/<noscript[\s\S]*?<\/noscript>/gi, '')
    .replace(/<template[\s\S]*?<\/template>/gi, '')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(BLOCK_CLOSE_RE, '\n')
    .replace(/<[^>]+>/g, ' ');
  return tidyLines(decodeEntities(cleaned));
}

/**
 * 提取 HTML 可见正文。
 * @param {string} html
 * @param {{parser?: Function}} deps parser 为 DOMParser 构造器（浏览器传 window.DOMParser）
 */
export function extractHtmlText(html, { parser } = {}) {
  if (parser) {
    try {
      const source = String(html == null ? '' : html)
        .replace(/<br\s*\/?>/gi, '\n')
        .replace(BLOCK_CLOSE_RE, '\n');
      const doc = new parser().parseFromString(source, 'text/html');
      for (const el of doc.querySelectorAll('script, style, noscript, template')) el.remove();
      const body = doc.body || doc.documentElement;
      const text = body ? body.textContent || '' : '';
      return tidyLines(text);
    } catch {
      // 解析器不可用或出错 → 回退正则
    }
  }
  return extractHtmlTextByRegex(html);
}

/**
 * 统一提取入口。
 * @param {string} name 文件名（按扩展名路由）
 * @param {string} raw 已读出的原始文本
 * @param {{parser?: Function}} [deps]
 * @returns {{text: string, format: 'html'|'raw'}}
 */
export function extractText(name, raw, { parser } = {}) {
  const source = String(raw == null ? '' : raw);
  const ext = fileExtension(name);
  if (ext === 'html' || ext === 'htm') {
    return { text: extractHtmlText(source, { parser }), format: 'html' };
  }
  return { text: source, format: 'raw' };
}

/**
 * Word（.docx）正文提取；mammoth 为注入的实现（浏览器 window.mammoth / node mammoth 包）。
 * 两种实现入参字段不同：浏览器版读 arrayBuffer、node 版读 buffer，这里同时提供以通用。
 * @param {ArrayBuffer|Uint8Array} source
 * @param {{extractRawText: (opts: object) => Promise<{value: string}>}} mammoth
 */
export async function extractDocxText(source, mammoth) {
  if (!mammoth || typeof mammoth.extractRawText !== 'function') {
    throw new Error('Word 解析库不可用');
  }
  const result = await mammoth.extractRawText({
    arrayBuffer: source,
    buffer: source,
  });
  return { text: String((result && result.value) || ''), format: 'docx' };
}
