import { test } from 'node:test';
import assert from 'node:assert/strict';
import { extractPdfText, textFromItems } from '../js/pdf-text.js';

/** 构造 pdf.js textContent.item 的最小形态 */
function item(str, { x = 0, y = 100, width = 0, hasEOL = false } = {}) {
  return { str, width, hasEOL, transform: [10, 0, 0, 10, x, y] };
}

test('textFromItems：同一行内按横向空隙补空格', () => {
  const text = textFromItems([
    item('MiMo', { x: 36, y: 210, width: 30 }),
    item('Attachment', { x: 72, y: 210, width: 55 }),
    item('Fixture', { x: 133, y: 210, width: 40 }),
  ]);
  assert.equal(text, 'MiMo Attachment Fixture');
});

test('textFromItems：紧凑相邻片段不插空格', () => {
  const text = textFromItems([
    item('PLAIN_', { x: 0, y: 100, width: 20 }),
    item('TEXT', { x: 20, y: 100, width: 20 }),
  ]);
  assert.equal(text, 'PLAIN_TEXT');
});

test('textFromItems：纵坐标变化或 hasEOL 断行', () => {
  const text = textFromItems([
    item('line one', { x: 0, y: 200, width: 50 }),
    item('line two', { x: 0, y: 180, width: 50 }),
    item('line three', { x: 0, y: 180, width: 70, hasEOL: true }),
  ]);
  assert.equal(text, 'line one\nline two\nline three');
});

test('textFromItems：忽略空串与非文本项，尾随空行被清理', () => {
  assert.equal(textFromItems([item(''), null, undefined, { str: 'x' }, item('   ')]), 'x');
  assert.equal(textFromItems([]), '');
  assert.equal(textFromItems(null), '');
});

test('extractPdfText：按页拼接文本并传入 cmaps 配置', async () => {
  const calls = [];
  let destroyed = false;
  const pages = [['第一页文本'], ['second page', 'tail']];
  const pdfjsLib = {
    getDocument(options) {
      calls.push(options);
      return {
        promise: Promise.resolve({
          numPages: pages.length,
          getPage: (n) => Promise.resolve({ getTextContent: () => Promise.resolve({ items: [item(pages[n - 1].join(' '), { width: 100 })] }) }),
          destroy: () => {
            destroyed = true;
            return Promise.resolve();
          },
        }),
      };
    },
  };

  const data = new Uint8Array([1, 2, 3]);
  const result = await extractPdfText({
    data,
    pdfjsLib,
    cMapUrl: 'http://127.0.0.1:8800/js/vendor/pdfjs/cmaps/',
  });

  assert.equal(calls.length, 1);
  assert.equal(calls[0].data, data);
  assert.equal(calls[0].cMapUrl, 'http://127.0.0.1:8800/js/vendor/pdfjs/cmaps/');
  assert.equal(calls[0].cMapPacked, true);
  assert.equal(result.pages, 2);
  assert.equal(result.text, '第一页文本\n\nsecond page tail');
  assert.equal(destroyed, true);
});

test('extractPdfText：未提供 cMapUrl 时不写入该字段', async () => {
  let captured = null;
  const pdfjsLib = {
    getDocument(options) {
      captured = options;
      return { promise: Promise.resolve({ numPages: 0, destroy: () => Promise.resolve() }) };
    },
  };
  const result = await extractPdfText({ data: new Uint8Array(), pdfjsLib });
  assert.equal('cMapUrl' in captured, false);
  assert.equal(result.text, '');
  assert.equal(result.pages, 0);
});

test('extractPdfText：解析库缺失时报错', async () => {
  await assert.rejects(() => extractPdfText({ data: new Uint8Array(), pdfjsLib: null }), /PDF 解析库不可用/);
});

test('extractPdfText：解析失败时仍释放文档资源', async () => {
  let destroyed = false;
  const pdfjsLib = {
    getDocument: () => ({
      promise: Promise.resolve({
        numPages: 1,
        getPage: () => Promise.reject(new Error('broken page')),
        destroy: () => {
          destroyed = true;
          return Promise.resolve();
        },
      }),
    }),
  };
  await assert.rejects(() => extractPdfText({ data: new Uint8Array(), pdfjsLib }), /broken page/);
  assert.equal(destroyed, true);
});
