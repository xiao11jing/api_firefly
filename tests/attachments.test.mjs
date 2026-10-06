import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  MAX_ATTACHMENTS,
  MAX_DOC_CHARS,
  MAX_DOC_BYTES,
  MAX_IMAGE_BYTES,
  attachmentSummary,
  checkFile,
  classifyFile,
  fileExtension,
  formatBytes,
  isFull,
  makeDocAttachment,
  toMessageParts,
  truncateDoc,
} from '../js/attachments.js';

test('classifyFile：按 MIME 判定图片 / PDF / 文本', () => {
  assert.equal(classifyFile({ name: 'a.png', type: 'image/png' }), 'image');
  assert.equal(classifyFile({ name: 'a.jpg', type: 'image/jpeg' }), 'image');
  assert.equal(classifyFile({ name: 'a.pdf', type: 'application/pdf' }), 'pdf');
  assert.equal(classifyFile({ name: 'a.txt', type: 'text/plain' }), 'text');
  assert.equal(classifyFile({ name: 'a.md', type: 'text/markdown; charset=utf-8' }), 'text');
});

test('classifyFile：MIME 缺失时按扩展名兜底', () => {
  assert.equal(classifyFile({ name: 'readme.md', type: '' }), 'text');
  assert.equal(classifyFile({ name: 'data.json', type: '' }), 'text');
  assert.equal(classifyFile({ name: 'sheet.CSV', type: '' }), 'text');
  assert.equal(classifyFile({ name: '脚本.py', type: '' }), 'text');
  assert.equal(classifyFile({ name: 'report.PDF', type: '' }), 'pdf');
  assert.equal(classifyFile({ name: 'app.exe', type: '' }), null);
  assert.equal(classifyFile({ name: 'doc.docx', type: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document' }), 'docx');
  assert.equal(classifyFile({ name: '文档.DOCX', type: '' }), 'docx');
  assert.equal(classifyFile({}), null);
});

test('classifyFile：application/json 与 xml 视作文本', () => {
  assert.equal(classifyFile({ name: 'payload', type: 'application/json' }), 'text');
  assert.equal(classifyFile({ name: 'feed', type: 'application/xml' }), 'text');
  assert.equal(classifyFile({ name: 'blob', type: 'application/octet-stream' }), null);
});

test('fileExtension 与 formatBytes', () => {
  assert.equal(fileExtension('a.b.c.PDF'), 'pdf');
  assert.equal(fileExtension('noext'), '');
  assert.equal(formatBytes(0), '0 B');
  assert.equal(formatBytes(512), '512 B');
  assert.equal(formatBytes(2048), '2 KB');
  assert.equal(formatBytes(3 * 1024 * 1024), '3.0 MB');
});

test('checkFile：通过返回 null，超限/不支持返回文案', () => {
  assert.equal(checkFile({ name: 'a.png', type: 'image/png', size: 1024 }), null);
  assert.equal(checkFile({ name: 'a.md', type: 'text/markdown', size: MAX_DOC_BYTES }), null);

  const bigImage = checkFile({ name: 'big.png', type: 'image/png', size: MAX_IMAGE_BYTES + 1 });
  assert.match(bigImage, /big\.png/);
  assert.match(bigImage, /5\.0 MB/);

  const bigDoc = checkFile({ name: 'big.pdf', type: 'application/pdf', size: MAX_DOC_BYTES + 1 });
  assert.match(bigDoc, /超过/);

  assert.match(checkFile({ name: 'x.exe', type: '', size: 10 }), /不支持的文件类型/);
});

test('truncateDoc：超长截断并标记', () => {
  const short = truncateDoc('hello');
  assert.deepEqual(short, { text: 'hello', truncated: false });
  const { text, truncated } = truncateDoc('x'.repeat(MAX_DOC_CHARS + 10));
  assert.equal(text.length, MAX_DOC_CHARS);
  assert.equal(truncated, true);
  assert.deepEqual(truncateDoc(null), { text: '', truncated: false });
});

test('truncateDoc 支持自定义上限', () => {
  assert.deepEqual(truncateDoc('abcdef', 3), { text: 'abc', truncated: true });
});

test('makeDocAttachment：补全元信息与截断标记', () => {
  const a = makeDocAttachment({ name: 'README.md', text: 'hello', size: 12 });
  assert.equal(a.kind, 'file');
  assert.equal(a.name, 'README.md');
  assert.equal(a.text, 'hello');
  assert.equal(a.truncated, false);
  const long = makeDocAttachment({ name: 'big.txt', text: 'y'.repeat(20), size: 20 }, 5);
  assert.equal(long.text, 'yyyyy');
  assert.equal(long.truncated, true);
  assert.equal(makeDocAttachment({ text: 'x' }).name, '未命名文档');
});

test('toMessageParts：图片在前文档在后按顺序产出片段', () => {
  const parts = toMessageParts([
    { kind: 'image', dataUrl: 'data:image/png;base64,AAA', name: 'a.png' },
    { kind: 'file', name: 'b.md', text: 'body', pages: 0 },
    { kind: 'file', name: 'c.pdf', text: 'pdf body', pages: 2, truncated: true },
  ]);
  assert.equal(parts.length, 3);
  assert.deepEqual(parts[0], { type: 'image', dataUrl: 'data:image/png;base64,AAA', name: 'a.png' });
  assert.deepEqual(parts[1], { type: 'file', name: 'b.md', text: 'body' });
  assert.deepEqual(parts[2], { type: 'file', name: 'c.pdf', text: 'pdf body', pages: 2, truncated: true });
});

test('toMessageParts：跳过残缺项（无 dataUrl 的图片、无 text 的文档）', () => {
  const parts = toMessageParts([
    { kind: 'image', name: 'broken.png' },
    { kind: 'file', name: 'broken.md' },
    null,
    { kind: 'image', dataUrl: 'data:image/png;base64,BBB', name: 'ok.png' },
  ]);
  assert.equal(parts.length, 1);
  assert.equal(parts[0].name, 'ok.png');
  assert.deepEqual(toMessageParts(null), []);
});

test('attachmentSummary 与 isFull', () => {
  const atts = [
    { kind: 'image', dataUrl: 'x' },
    { kind: 'image', dataUrl: 'y' },
    { kind: 'file', name: 'a.md', text: 't' },
  ];
  assert.equal(attachmentSummary(atts), '2 张图片 · 1 个文档');
  assert.equal(attachmentSummary([{ kind: 'image', dataUrl: 'x' }]), '1 张图片');
  assert.equal(attachmentSummary([{ kind: 'file', text: 't' }]), '1 个文档');
  assert.equal(attachmentSummary([]), '');
  assert.equal(isFull([]), false);
  assert.equal(isFull(new Array(MAX_ATTACHMENTS).fill({ kind: 'image' })), true);
});
