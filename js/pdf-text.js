/**
 * pdf-text.js — PDF 文本提取（纯逻辑，pdfjsLib 由调用方注入以便测试与按需加载）
 */

/**
 * 提取 PDF 全文。
 * @param {object} opts
 * @param {ArrayBuffer|Uint8Array} opts.data PDF 字节
 * @param {object} opts.pdfjsLib pdf.js 模块命名空间
 * @param {string} [opts.cMapUrl] cmaps 目录地址（CJK 等 CID 编码需要）
 * @param {boolean} [opts.cMapPacked]
 * @returns {Promise<{text:string, pages:number}>}
 */
export async function extractPdfText({ data, pdfjsLib, cMapUrl, cMapPacked = true }) {
  if (!pdfjsLib || typeof pdfjsLib.getDocument !== 'function') {
    throw new Error('PDF 解析库不可用');
  }
  const options = { data };
  if (cMapUrl) {
    options.cMapUrl = cMapUrl;
    options.cMapPacked = cMapPacked;
  }
  const doc = await pdfjsLib.getDocument(options).promise;
  try {
    const pages = [];
    for (let i = 1; i <= doc.numPages; i++) {
      const page = await doc.getPage(i);
      const content = await page.getTextContent();
      pages.push(textFromItems(content && content.items));
    }
    return { text: pages.join('\n\n').trim(), pages: doc.numPages };
  } finally {
    if (doc && typeof doc.destroy === 'function') await doc.destroy();
  }
}

/**
 * pdf.js textContent.items → 纯文本。
 * 同一行内按横向空隙补空格，纵坐标变化或 hasEOL 时断行。
 */
export function textFromItems(items) {
  const list = Array.isArray(items) ? items : [];
  const lines = [];
  let current = '';
  let lastY = null;
  let lastXEnd = null;

  const flush = () => {
    if (current.trim()) lines.push(current.trim());
    current = '';
  };

  for (const it of list) {
    if (!it || typeof it.str !== 'string' || it.str === '') continue;
    const transform = Array.isArray(it.transform) ? it.transform : null;
    const x = transform ? Number(transform[4]) : null;
    const y = transform ? Number(transform[5]) : null;

    const lineChanged = it.hasEOL || (lastY !== null && y !== null && Math.abs(y - lastY) > 1);
    if (lineChanged) flush();
    else if (current && lastXEnd !== null && x !== null && x - lastXEnd > 1) current += ' ';

    current += it.str;
    if (y !== null) lastY = y;
    if (x !== null) lastXEnd = x + (Number(it.width) || 0);
  }
  flush();
  return lines.join('\n');
}
