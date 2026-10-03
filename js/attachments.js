/**
 * attachments.js — 附件分类、限额与文本装载（纯逻辑，无 DOM 依赖）
 *
 * 附件在内存中的形态：
 *   { id, kind: 'image'|'file', name, size, dataUrl?, text?, pages?, truncated? }
 * 发送时由 provider.js 转换为 API 消息片段。
 */

export const MAX_ATTACHMENTS = 5;
export const MAX_IMAGE_BYTES = 5 * 1024 * 1024;
export const MAX_DOC_BYTES = 5 * 1024 * 1024;
/** 单个文档注入 prompt 的字符上限，避免超长文档撑爆上下文 */
export const MAX_DOC_CHARS = 200000;

/** 可直读的文本类扩展名（覆盖常见的文本/代码/数据文件） */
const TEXT_EXTENSIONS = new Set([
  'txt', 'md', 'markdown', 'json', 'csv', 'tsv', 'log', 'yml', 'yaml',
  'xml', 'html', 'htm', 'css', 'js', 'mjs', 'cjs', 'ts', 'tsx', 'jsx',
  'py', 'java', 'kt', 'go', 'rs', 'rb', 'php', 'c', 'h', 'cpp', 'hpp',
  'cs', 'swift', 'sh', 'bat', 'ps1', 'sql', 'ini', 'toml', 'conf', 'env',
]);

export function fileExtension(name) {
  const m = /\.([A-Za-z0-9]+)$/.exec(String(name || ''));
  return m ? m[1].toLowerCase() : '';
}

/**
 * 判定附件类型。
 * @returns {'image'|'text'|'pdf'|null} null 表示不支持
 */
export function classifyFile({ name = '', type = '' } = {}) {
  const mime = String(type || '').toLowerCase().split(';')[0].trim();
  if (mime.startsWith('image/')) return 'image';
  if (mime === 'application/pdf') return 'pdf';
  if (fileExtension(name) === 'pdf') return 'pdf';
  if (mime.startsWith('text/')) return 'text';
  if (mime === 'application/json' || mime === 'application/xml') return 'text';
  if (TEXT_EXTENSIONS.has(fileExtension(name))) return 'text';
  return null;
}

export function formatBytes(n) {
  const bytes = Number(n) || 0;
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

/** 校验单个文件；通过返回 null，否则返回给用户看的错误文案 */
export function checkFile(file) {
  const name = (file && file.name) || '';
  const kind = classifyFile(file || {});
  if (!kind) return `不支持的文件类型：${name || '未命名文件'}`;
  const limit = kind === 'image' ? MAX_IMAGE_BYTES : MAX_DOC_BYTES;
  if (Number(file.size) > limit) {
    return `${name} 体积 ${formatBytes(file.size)}，超过 ${formatBytes(limit)} 上限`;
  }
  return null;
}

/** 截断超长文本；返回是否发生截断 */
export function truncateDoc(text, max = MAX_DOC_CHARS) {
  const t = String(text == null ? '' : text);
  if (t.length <= max) return { text: t, truncated: false };
  return { text: t.slice(0, max), truncated: true };
}

/** 构造文档类附件（已提取文本） */
export function makeDocAttachment({ name, text, pages = 0, size = 0 }, max = MAX_DOC_CHARS) {
  const { text: body, truncated } = truncateDoc(text, max);
  return {
    kind: 'file',
    name: String(name || '未命名文档'),
    size,
    pages,
    text: body,
    truncated,
  };
}

/** 附件数量是否已达上限 */
export function isFull(attachments) {
  return (Array.isArray(attachments) ? attachments.length : 0) >= MAX_ATTACHMENTS;
}

/** 附件列表 → 消息 content 片段 */
export function toMessageParts(attachments) {
  const parts = [];
  for (const a of Array.isArray(attachments) ? attachments : []) {
    if (!a) continue;
    if (a.kind === 'image' && a.dataUrl) {
      parts.push({ type: 'image', dataUrl: a.dataUrl, name: a.name });
    } else if (a.kind === 'file' && typeof a.text === 'string') {
      parts.push({
        type: 'file',
        name: a.name,
        text: a.text,
        ...(a.pages ? { pages: a.pages } : {}),
        ...(a.truncated ? { truncated: true } : {}),
      });
    }
  }
  return parts;
}

/** 输入框上方的附件摘要文案，如「2 张图片 · 1 个文档」 */
export function attachmentSummary(attachments) {
  const list = Array.isArray(attachments) ? attachments : [];
  const images = list.filter((a) => a.kind === 'image').length;
  const docs = list.length - images;
  const bits = [];
  if (images) bits.push(`${images} 张图片`);
  if (docs) bits.push(`${docs} 个文档`);
  return bits.join(' · ');
}
