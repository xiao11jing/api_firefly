import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const doc = await readFile(path.join(root, 'project.md'), 'utf8');

test('计划书包含核心章节', () => {
  const sections = [
    '# AI 多模型对话客户端 — 产品计划书',
    '## 1. 产品方向',
    '## 2. 目标用户与场景',
    '## 3. 功能规划',
    '## 4. 技术架构（MVP）',
    '## 5. 非目标（明确不做）',
    '## 6. 里程碑',
    '## 7. 验收标准（MVP）',
    '## 8. 桌面版验收（v2.0）',
  ];
  for (const s of sections) assert.ok(doc.includes(s), `缺少章节：${s}`);
});

test('交付目标为 Ubuntu ARM64 的 .deb 桌面版', () => {
  assert.ok(doc.includes('.deb'), '目标产物应为 .deb');
  assert.ok(doc.includes('Ubuntu ARM64'), '应注明 ARM64 目标平台');
  assert.ok(doc.includes('Tauri'), '打包框架应为 Tauri');
  assert.ok(doc.includes('以桌面版（.deb）为最终交付形态'));
  // 里程碑 M4 与验收标准均须指向 .deb
  assert.ok(/M4[^\n]*\.deb/.test(doc), 'M4 里程碑应包含 .deb');
});

test('出厂默认资源：Firefly/头像/背景/开屏', () => {
  for (const s of ['Firefly', 'ai头像.png', '背景.png', '开屏视频.mp4']) {
    assert.ok(doc.includes(s), `缺少出厂默认：${s}`);
  }
  assert.ok(doc.includes('出厂默认资源'));
  assert.ok(doc.includes('用户未设置时生效') || doc.includes('未设置时生效'));
});

test('数据落盘与本地代理', () => {
  assert.ok(doc.includes('本地文件夹'), '数据应落本地文件夹');
  assert.ok(doc.includes('localStorage'), '应说明从 localStorage 迁移');
  assert.ok(doc.includes('FileStore'), '存储适配层应命名为 FileStore');
  assert.ok(doc.includes('内置本地代理') || doc.includes('本地代理'), '应有本地代理');
  assert.ok(doc.includes('scripts/check-env.sh'), '应引用环境自检脚本');
});

test('桌面版验收覆盖默认值、落盘、代理与逐次确认', () => {
  assert.ok(doc.includes('Firefly'));
  assert.ok(doc.includes('逐次确认'), '验收须包含 AI 写文件逐次确认');
  assert.ok(doc.includes('越权路径'));
});
