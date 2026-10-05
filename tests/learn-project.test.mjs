import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const doc = await readFile(path.join(root, 'learn_project.md'), 'utf8');

test('计划书包含全部章节', () => {
  const sections = [
    '# Learn 模式计划书',
    '## 1. 目标与定位',
    '## 2. 设计原则（已确认的决策）',
    '## 3. 功能需求',
    '## 4. 数据模型与存储',
    '## 5. 技术架构',
    '## 6. 分期实施计划',
    '## 7. 测试与验收总览',
    '## 8. 风险与对策',
    '## 9. 里程碑映射',
  ];
  for (const s of sections) assert.ok(doc.includes(s), `缺少章节：${s}`);
});

test('进度面板三要素均有定义', () => {
  assert.ok(doc.includes('计划条目状态'));
  assert.ok(doc.includes('练习正确率'));
  assert.ok(doc.includes('待解决问题'));
  // 正确率必须是逐条记录 + 窗口口径，且不能出现掌握度百分比
  assert.ok(doc.includes('逐条作答记录') || doc.includes('逐条记录'));
  assert.ok(doc.includes('近 10 题') || doc.includes('窗口'));
  assert.ok(doc.includes('不显示模型估算的掌握度百分比'));
});

test('只读/可写分区与改原文需明确要求', () => {
  assert.ok(doc.includes('只读 / 可写分区') || doc.includes('只读/可写分区'));
  assert.ok(doc.includes('改原文必须用户明确要求'));
});

test('访谈上限 3 问且提供跳过出口', () => {
  assert.ok(doc.includes('最多问 3 个') || doc.includes('最多 3 问'));
  assert.ok(doc.includes('先按默认走，边聊边校准'));
});

test('计划持久化与更新触发条件', () => {
  assert.ok(doc.includes('learn/plan.md'));
  assert.ok(doc.includes('计划更新触发条件'));
  assert.ok(doc.includes('完成条目'));
  assert.ok(doc.includes('下一步'));
});

test('两模式共享能力层、仅提示词分层', () => {
  assert.ok(doc.includes('共享同一套文件约定、读写能力、出题与总结能力'));
  assert.ok(doc.includes('learn_system.md'));
  assert.ok(doc.includes('learn_identity.md'));
  assert.ok(doc.includes('mode_plan.md'));
  assert.ok(doc.includes('mode_companion.md'));
  assert.ok(doc.includes('模式二'));
  assert.ok(doc.includes('不生成计划'));
});

test('总结落盘且导出 Markdown 兜底', () => {
  assert.ok(doc.includes('结束本次学习'));
  assert.ok(doc.includes('复盘'));
  assert.ok(doc.includes('会话导出 Markdown'));
});

test('存储策略：本地优先并预留文件夹接口', () => {
  assert.ok(doc.includes('FolderStore'));
  assert.ok(doc.includes('LocalStore'));
  assert.ok(doc.includes('createLearnStore'));
  assert.ok(doc.includes('IndexedDB'));
  assert.ok(doc.includes('schemaVersion'));
});

test('文件格式：本期范围与远期扩展均已列出', () => {
  for (const ext of ['图片', '.txt', '.md', '.json', '.pdf']) {
    assert.ok(doc.includes(ext), `缺少本期格式：${ext}`);
  }
  for (const ext of ['.html', '.docx', '.css', '.js', '.py']) {
    assert.ok(doc.includes(ext), `缺少远期格式：${ext}`);
  }
  assert.ok(doc.includes('extractText'));
});

test('六期实施计划与每期测试要求', () => {
  for (let i = 1; i <= 6; i++) assert.ok(doc.includes(`Phase ${i}`), `缺少 Phase ${i}`);
  assert.ok(doc.includes('npm test'));
  assert.ok(doc.includes('tests/learn-store.test.mjs'));
  assert.ok(doc.includes('tests/learn-quiz.test.mjs'));
  assert.ok(doc.includes('e2e.mjs'));
});

test('验收清单覆盖跨会话连续性', () => {
  assert.ok(doc.includes('新开会话'));
  assert.ok(doc.includes('刷新后主题、计划、记录不丢失'));
  assert.ok(doc.includes('contentHash'));
});
