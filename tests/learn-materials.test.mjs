import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  buildMaterialMeta,
  canInsertMaterial,
  findMaterials,
  materialKindOf,
} from '../js/learn/learn-materials.js';
import { normalizeTopic } from '../js/learn/learn-store.js';

test('materialKindOf：按扩展名分类', () => {
  assert.equal(materialKindOf('notes.md'), 'text');
  assert.equal(materialKindOf('data.json'), 'text');
  assert.equal(materialKindOf('paper.pdf'), 'pdf');
  assert.equal(materialKindOf('page.html'), 'html');
  assert.equal(materialKindOf('报告.docx'), 'docx');
  assert.equal(materialKindOf('app.js'), 'code');
  assert.equal(materialKindOf('script.py'), 'code');
  assert.equal(materialKindOf('style.css'), 'code');
  assert.equal(materialKindOf('unknown.bin'), 'text');
});

test('buildMaterialMeta：文档与图片条目', () => {
  const doc = buildMaterialMeta(
    { kind: 'file', name: ' notes.md ', size: 1234.6, truncated: true },
    100
  );
  assert.equal(doc.name, 'notes.md'); // 去空白
  assert.equal(doc.kind, 'text');
  assert.equal(doc.size, 1235);
  assert.equal(doc.addedAt, 100);
  assert.equal(doc.truncated, true);
  assert.ok(doc.id);

  const img = buildMaterialMeta({ kind: 'image', name: 'pic.png', size: 0 }, 200);
  assert.equal(img.kind, 'image');
  assert.equal(img.truncated, false);

  const anon = buildMaterialMeta(null, 300);
  assert.equal(anon.name, '未命名文件');
  assert.equal(anon.size, 0);
});

test('findMaterials：空查询返回全部，名称与摘要匹配（不区分大小写）', () => {
  const topic = normalizeTopic({
    id: 't',
    name: 'x',
    materials: [
      { id: 'm1', name: 'Notes.md', kind: 'text', size: 1, addedAt: 1, summary: '会议 纪要', truncated: false },
      { id: 'm2', name: 'paper.pdf', kind: 'pdf', size: 2, addedAt: 2, summary: '注意力论文', truncated: false },
      { id: 'm3', name: 'app.py', kind: 'code', size: 3, addedAt: 3, summary: '', truncated: false },
    ],
  });
  assert.equal(findMaterials(topic, '').length, 3);
  assert.equal(findMaterials(topic, '  ').length, 3);
  assert.deepEqual(findMaterials(topic, 'notes').map((m) => m.id), ['m1']); // 大小写不敏感
  assert.deepEqual(findMaterials(topic, '论文').map((m) => m.id), ['m2']); // 摘要命中
  assert.deepEqual(findMaterials(topic, '.py').map((m) => m.id), ['m3']);
  assert.equal(findMaterials(topic, '不存在').length, 0);
  assert.deepEqual(findMaterials(null, 'x'), []);
});

test('canInsertMaterial：图片不可插入，文档可以', () => {
  assert.equal(canInsertMaterial({ kind: 'image' }), false);
  assert.equal(canInsertMaterial({ kind: 'text' }), true);
  assert.equal(canInsertMaterial(null), false);
});
