import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { renderMarkdown, renderInline, escapeHtml } from '../js/markdown.js';

const require = createRequire(import.meta.url);
const hljs = require('../js/vendor/highlight.min.js');

test('escapeHtml 转义五个关键字符', () => {
  assert.equal(escapeHtml('<a href="x">&\'</a>'), '&lt;a href=&quot;x&quot;&gt;&amp;&#39;&lt;/a&gt;');
});

test('标题与段落渲染', () => {
  const html = renderMarkdown('# 标题一\n\n第一段\n第二行');
  assert.match(html, /<h1>标题一<\/h1>/);
  assert.match(html, /<p>第一段<br>第二行<\/p>/);
});

test('行内语法：粗体/斜体/行内代码/删除线', () => {
  const html = renderInline('这是 **粗** 与 *斜* 和 `code` 以及 ~~删~~');
  assert.match(html, /<strong>粗<\/strong>/);
  assert.match(html, /<em>斜<\/em>/);
  assert.match(html, /<code>code<\/code>/);
  assert.match(html, /<del>删<\/del>/);
});

test('围栏代码块与语言标注', () => {
  const html = renderMarkdown('```js\nconst a = 1;\n```');
  assert.match(html, /<pre class="code-block"><code class="language-js">/);
});

test('注入 hljs 后代码被高亮', () => {
  const html = renderMarkdown('```js\nconst a = 1;\n```', hljs);
  assert.match(html, /hljs-/); // hljs 会加上类名
});

test('原始 HTML 被转义（XSS 防护）', () => {
  const html = renderMarkdown('<script>alert(1)</script>');
  assert.ok(!html.includes('<script>'));
  assert.match(html, /&lt;script&gt;/);
});

test('javascript: 链接被拦截，安全链接保留', () => {
  const bad = renderInline('[点我](javascript:alert(1))');
  assert.ok(!bad.includes('javascript:'));
  assert.equal(bad, '点我');
  const good = renderInline('[官网](https://example.com)');
  assert.match(good, /<a href="https:\/\/example\.com" target="_blank" rel="noopener noreferrer">官网<\/a>/);
});

test('img src 协议过滤', () => {
  const ok = renderInline('![图](https://x.com/a.png)');
  assert.match(ok, /<img src="https:\/\/x\.com\/a\.png"/);
  const bad = renderInline('![图](javascript:alert(1))');
  assert.ok(!bad.includes('<img'));
  const dataOk = renderInline('![图](data:image/png;base64,AAAA)');
  assert.match(dataOk, /<img src="data:image\/png;base64,AAAA"/);
});

test('无序与有序列表', () => {
  const html = renderMarkdown('- a\n- b\n\n1. x\n2. y');
  assert.match(html, /<ul><li>a<\/li><li>b<\/li><\/ul>/);
  assert.match(html, /<ol><li>x<\/li><li>y<\/li><\/ol>/);
});

test('嵌套列表', () => {
  const html = renderMarkdown('- a\n  - a1\n  - a2\n- b');
  assert.match(html, /<ul><li>a<ul><li>a1<\/li><li>a2<\/li><\/ul><\/li><li>b<\/li><\/ul>/);
});

test('引用块', () => {
  const html = renderMarkdown('> 引用内容\n> 第二行');
  assert.match(html, /<blockquote>.*引用内容.*<\/blockquote>/s);
});

test('表格', () => {
  const html = renderMarkdown('| A | B |\n|---|---|\n| 1 | 2 |');
  assert.match(html, /<table><thead><tr><th>A<\/th><th>B<\/th><\/tr>/);
  assert.match(html, /<td>1<\/td><td>2<\/td>/);
});

test('分隔线', () => {
  assert.match(renderMarkdown('---'), /<hr>/);
});

test('代码块内 HTML 被转义', () => {
  const html = renderMarkdown('```\n<img src=x onerror=alert(1)>\n```');
  assert.ok(!html.includes('<img src=x'));
  assert.match(html, /&lt;img/);
});

test('空输入返回空串', () => {
  assert.equal(renderMarkdown(''), '');
  assert.equal(renderMarkdown(null), '');
});

test('CRLF 换行归一化', () => {
  const html = renderMarkdown('# t\r\n\r\nbody');
  assert.match(html, /<h1>t<\/h1>/);
  assert.match(html, /<p>body<\/p>/);
});

test('链接之后的斜体不会改写链接标签', () => {
  // 回归：生成 <a> 时带 target="_blank"，行内斜体规则曾把其中的下划线当成开标记，
  // 于是 <em> 被插进属性值，标签被破坏且斜体失效
  const html = renderInline('[链接](https://ex.com/a) 然后 _斜体_');
  assert.equal(
    html,
    '<a href="https://ex.com/a" target="_blank" rel="noopener noreferrer">链接</a> 然后 <em>斜体</em>'
  );
  assert.ok(!/target="[^"]*<em>/.test(html), 'target 属性被行内规则改写');
});

test('链接前后的多处斜体都各自生效', () => {
  const html = renderInline('前 _一_ 后 [链接](https://ex.com/a) 再 _二_');
  assert.equal((html.match(/<em>/g) || []).length, 2);
  assert.match(html, /<em>一<\/em>/);
  assert.match(html, /<em>二<\/em>/);
  assert.ok(!html.includes('target="<em>'));
});

test('链接文字里的强调仍然生效', () => {
  const html = renderInline('[**粗体**](https://ex.com/a)');
  assert.match(html, /<a href="https:\/\/ex\.com\/a"[^>]*><strong>粗体<\/strong><\/a>/);
});

test('链接文字里的行内代码仍然生效', () => {
  const html = renderInline('[`code`](https://ex.com/a) 与 _斜体_');
  assert.match(html, /<a [^>]*><code>code<\/code><\/a>/);
  assert.match(html, /<em>斜体<\/em>/);
});

test('图片 alt 只转义一次', () => {
  const html = renderInline('![图 A & B](https://x/a.png)');
  assert.match(html, /alt="图 A &amp; B"/);
  assert.ok(!html.includes('&amp;amp;'));
});

test('图片 alt 中的下划线不被当成斜体', () => {
  const html = renderInline('![图_1_](https://x/a.png)');
  assert.match(html, /alt="图_1_"/);
  assert.ok(!html.includes('<em>'));
});

test('生成的标签占位不影响危险协议拦截', () => {
  assert.equal(renderInline('_斜体_ [点我](javascript:alert(1))'), '<em>斜体</em> 点我');
  assert.ok(!renderInline('![x](javascript:alert(1)) _斜体_').includes('<img'));
});
