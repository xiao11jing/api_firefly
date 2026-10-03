/**
 * e2e.mjs — 浏览器端到端验证（需先启动 static-server 与 mock-server）
 * 运行：node tests/e2e.mjs
 */
import { chromium } from 'playwright-core';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const APP = process.env.APP_URL || 'http://127.0.0.1:8800';
const OUT = join(import.meta.dirname, '..', 'output', 'playwright');
mkdirSync(OUT, { recursive: true });

const results = [];
let failed = 0;

function check(name, cond, extra = '') {
  results.push({ name, pass: !!cond, extra });
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}${extra ? '  — ' + extra : ''}`);
  if (!cond) failed++;
}

// 1x1 透明 PNG
const PNG_1x1 = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
  'base64'
);
const IMG_PATH = join(OUT, 'sample.png');
writeFileSync(IMG_PATH, PNG_1x1);

const consoleErrors = [];
const pageErrors = [];

const browser = await chromium.launch({ channel: 'msedge', headless: true });
const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
page.on('console', (m) => {
  if (m.type() !== 'error') return;
  const loc = (m.location && m.location().url) || '';
  if (loc.includes('favicon')) return; // 图标请求噪音
  if (m.text().includes('401')) return; // 本测试故意触发的 bad-key 场景
  consoleErrors.push(`${m.text()} @ ${loc}`);
});
page.on('pageerror', (e) => pageErrors.push(String(e)));

try {
  // ---------- 1. 首屏：无 provider 的空状态 ----------
  await page.goto(APP, { waitUntil: 'networkidle' });
  check('首屏显示未配置提示', await page.locator('.empty-state h3').textContent() === '还没有配置 API 服务');
  await page.screenshot({ path: join(OUT, '01-empty.png') });

  // ---------- 2. 配置 provider ----------
  await page.getByRole('button', { name: '去配置 API' }).click();
  await page.locator('#settings-mask:not(.hidden)').waitFor();
  await page.fill('#pf-name', 'Mock 服务');
  await page.fill('#pf-baseUrl', 'http://127.0.0.1:8717/v1');
  await page.fill('#pf-apiKey', 'test-key');
  await page.fill('#pf-models', 'mock-model');
  await page.getByRole('button', { name: '保存' }).click();
  check('保存后服务出现在列表', (await page.locator('.provider-item').count()) === 1);
  await page.locator('#settings-mask .provider-item').waitFor();
  await page.screenshot({ path: join(OUT, '02-settings.png') });
  await page.click('#btn-close-settings');
  await page.waitForFunction(() => document.querySelector('#settings-mask').classList.contains('hidden'));

  // ---------- 3. 模型自动选中 ----------
  const selVal = await page.locator('#model-select').inputValue();
  check('模型自动选中', selVal.includes('::mock-model'), `value=${selVal}`);
  check('模型指示灯点亮', await page.locator('#model-dot.on').count() === 1);

  // ---------- 4. 发送消息并流式接收 ----------
  await page.fill('#input', '你好，这是端到端测试');
  await page.press('#input', 'Enter');
  await page.waitForSelector('.msg.user .bubble', { timeout: 5000 });
  check('用户消息上屏', (await page.locator('.msg.user .bubble').first().textContent()).includes('端到端测试'));

  // 等待流式完成（发送按钮恢复可见）
  await page.waitForSelector('#btn-send:not(.hidden)', { timeout: 30000 });
  const prose = page.locator('.msg.assistant .prose');
  await prose.waitFor({ timeout: 10000 });
  const html = await prose.innerHTML();
  check('回复包含标题（markdown）', html.includes('<h1>'));
  check('回复包含高亮代码块', html.includes('code-block') && html.includes('hljs-'));
  check('代码块带复制按钮', (await page.locator('.prose .code-copy').count()) >= 1);
  check('回复包含列表', html.includes('<ul>'));
  check('会话自动命名', (await page.locator('.session-item .s-title').first().textContent()) === '你好，这是端到端测试');
  await page.screenshot({ path: join(OUT, '03-chat.png') });

  // ---------- 5. 刷新后持久化 ----------
  await page.reload({ waitUntil: 'networkidle' });
  check('刷新后消息仍在', (await page.locator('.msg.user').count()) >= 1);
  check('刷新后 provider 仍在', await page.locator('#model-select').inputValue() !== '');

  // ---------- 6. 新会话 + 图片附件 ----------
  await page.click('#btn-new-chat');
  check('新会话进入空状态', (await page.locator('.empty-state h3').textContent()) === '开始新对话');
  await page.setInputFiles('#file-input', IMG_PATH);
  await page.locator('#attach-preview:not(.hidden)').waitFor({ timeout: 5000 });
  check('图片附件预览显示', true);
  await page.fill('#input', '看看这张图');
  await page.press('#input', 'Enter');
  await page.waitForSelector('.msg.user .bubble-img', { timeout: 5000 });
  check('用户消息带图上屏', true);
  await page.waitForSelector('#btn-send:not(.hidden)', { timeout: 30000 });
  check('图片会话正常回复', (await page.locator('.msg.assistant .prose').count()) >= 1);
  await page.screenshot({ path: join(OUT, '04-image.png') });

  // ---------- 7. 错误处理（bad key → 401） ----------
  await page.click('#btn-pill-settings');
  await page.locator('#settings-mask:not(.hidden)').waitFor();
  await page.locator('.provider-item').first().click();
  await page.fill('#pf-apiKey', 'bad-key');
  await page.getByRole('button', { name: '保存' }).click();
  await page.click('#btn-close-settings');
  await page.click('#btn-new-chat');
  await page.fill('#input', '触发错误');
  await page.press('#input', 'Enter');
  await page.waitForSelector('.msg-error .retry-btn', { timeout: 15000 });
  const errText = await page.locator('.msg-error').textContent();
  check('错误卡片显示 401 提示', errText.includes('401') && errText.includes('API Key'), errText.slice(0, 80));
  await page.screenshot({ path: join(OUT, '05-error.png') });

  // ---------- 8. 重试按钮存在且可点 ----------
  check('重试按钮可用', await page.locator('.msg-error .retry-btn').isVisible());

  // ---------- 9. 控制台无异常 ----------
  check('无页面 JS 异常', pageErrors.length === 0, pageErrors.join(' | '));
  const realConsoleErrors = consoleErrors.filter((e) => !e.includes('favicon'));
  check('无控制台错误', realConsoleErrors.length === 0, realConsoleErrors.join(' | '));
} catch (e) {
  check('流程执行未抛异常', false, String(e && e.message ? e.message : e));
  await page.screenshot({ path: join(OUT, '99-failure.png') }).catch(() => {});
} finally {
  await browser.close();
}

console.log(`\n${results.length - failed}/${results.length} checks passed`);
process.exit(failed ? 1 : 0);
