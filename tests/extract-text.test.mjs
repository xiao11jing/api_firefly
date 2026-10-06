import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import mammoth from 'mammoth';
import {
  extractDocxText,
  extractHtmlText,
  extractHtmlTextByRegex,
  extractText,
} from '../js/extract-text.js';

const fixtures = path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures');

/* ---------------- 统一入口与原样保留 ---------------- */

test('extractText：非 HTML 文本类原样保留', () => {
  for (const name of ['a.txt', 'b.md', 'c.json', 'style.css', 'app.js', 'run.py', 'x.ts']) {
    const raw = `const  x  = 1;\n// 注释 <b>不处理</b>\n`;
    const { text, format } = extractText(name, raw);
    assert.equal(text, raw, name);
    assert.equal(format, 'raw');
  }
});

test('extractText：按扩展名路由 html/htm', () => {
  const html = '<p>你好</p><script>bad()</script>';
  assert.equal(extractText('page.html', html).format, 'html');
  assert.equal(extractText('page.HTM', html).format, 'html');
  assert.ok(!extractText('page.html', html).text.includes('bad'));
  // 名字带 html 字样但扩展名不是 → 不处理
  assert.equal(extractText('我的笔记.html.md', html).format, 'raw');
});

/* ---------------- HTML 提取（正则路径） ---------------- */

test('extractHtmlTextByRegex：去 script/style/head/注释，保留可见正文', () => {
  const html = [
    '<html><head><title>页面标题</title><style>body{color:red}</style></head>',
    '<body><!-- 注释 --><h1>章节一</h1>',
    '<p>第一段&nbsp;与 &amp; 符号</p>',
    "<script>alert('xss')</script>",
    '<div>块内容</div><br>换行内容',
    '<a href="#">链接文字</a></body></html>',
  ].join('');
  const text = extractHtmlTextByRegex(html);
  assert.ok(text.includes('章节一'));
  assert.ok(text.includes('第一段 与 & 符号')); // 实体解码
  assert.ok(text.includes('块内容'));
  assert.ok(text.includes('换行内容'));
  assert.ok(text.includes('链接文字'));
  assert.ok(!text.includes('alert'));
  assert.ok(!text.includes('color:red'));
  assert.ok(!text.includes('页面标题')); // head 整体剥离
  assert.ok(!text.includes('<'));
});

test('extractHtmlTextByRegex：块级标签分隔成行，空白收敛', () => {
  const text = extractHtmlTextByRegex('<p>甲</p><p>乙</p><li>丙</li><h2>丁</h2>');
  const lines = text.split('\n').filter(Boolean);
  assert.deepEqual(lines, ['甲', '乙', '丙', '丁']);
  assert.equal(extractHtmlTextByRegex('a   b\n\n\n\nc'), 'a b\n\nc');
});

/* ---------------- HTML 提取（DOMParser 路径） ---------------- */

test('extractHtmlText：走 parser 时先按块补换行、移除 script/style 后取正文', () => {
  const seen = { source: null, selector: null };
  class FakeParser {
    parseFromString(source) {
      seen.source = source;
      return {
        body: { textContent: '第一段\n第二段  尾随空格   ' },
        querySelectorAll(selector) {
          seen.selector = selector;
          return [{ remove() {} }];
        },
      };
    }
  }
  const out = extractHtmlText('<p>第一段</p><p>第二段</p><script>x()</script>', {
    parser: FakeParser,
  });
  assert.equal(out, '第一段\n第二段 尾随空格'); // tidyLines 收敛
  assert.equal(seen.selector, 'script, style, noscript, template');
  assert.ok(seen.source.includes('\n')); // </p> 已被替换为换行
  assert.ok(!seen.source.includes('</p>'));
});

test('extractHtmlText：parser 抛错时回退正则', () => {
  class Boom {
    parseFromString() {
      throw new Error('boom');
    }
  }
  const out = extractHtmlText('<p>可见</p><script>bad()</script>', { parser: Boom });
  assert.ok(out.includes('可见'));
  assert.ok(!out.includes('bad'));
});

test('extractHtmlText：无 parser 时直接走正则', () => {
  const out = extractHtmlText('<div>仅正文</div><style>.a{}</style>');
  assert.equal(out, '仅正文');
});

/* ---------------- Word（.docx） ---------------- */

test('extractDocxText：从夹具提取中英文正文', async () => {
  const buf = await readFile(path.join(fixtures, 'sample.docx'));
  const { text, format } = await extractDocxText(
    buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength),
    mammoth
  );
  assert.equal(format, 'docx');
  assert.ok(text.includes('MiMo Attachment Fixture'));
  assert.ok(text.includes('中文文档测试'));
  assert.ok(text.includes('Second paragraph with English text.'));
});

test('extractDocxText：缺实现时给出明确错误', async () => {
  await assert.rejects(extractDocxText(new ArrayBuffer(0), null), /Word 解析库不可用/);
  await assert.rejects(extractDocxText(new ArrayBuffer(0), {}), /Word 解析库不可用/);
});
