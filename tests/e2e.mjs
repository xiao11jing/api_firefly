/**
 * e2e.mjs — 浏览器端到端验证（需先启动 static-server 与 mock-server）
 * 运行：node tests/e2e.mjs
 */
import { chromium } from 'playwright-core';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { MOCK_VERSION } from './mock-server.mjs';

const APP = process.env.APP_URL || 'http://127.0.0.1:8800';
const MOCK = process.env.MOCK_URL || 'http://127.0.0.1:8717';
const OUT = join(import.meta.dirname, '..', 'output', 'playwright');
mkdirSync(OUT, { recursive: true });

const results = [];
let failed = 0;

function check(name, cond, extra = '') {
  results.push({ name, pass: !!cond, extra });
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}${extra ? '  — ' + extra : ''}`);
  if (!cond) failed++;
}

// 图片附件夹具（可见的图案，便于截图核对渲染效果）
const IMG_PATH = join(import.meta.dirname, 'fixtures', 'image-a.png');
const IMG_PATH_2 = join(import.meta.dirname, 'fixtures', 'image-b.png');

// 文本 / JSON / PDF 附件夹具
const MD_PATH = join(OUT, 'notes.md');
writeFileSync(MD_PATH, '# 会议纪要\n\n第一条结论：先做多模型对话。\n', 'utf8');
const JSON_PATH = join(OUT, 'payload.json');
writeFileSync(JSON_PATH, JSON.stringify({ ok: true, items: [1, 2, 3] }, null, 2), 'utf8');
const EXE_PATH = join(OUT, 'binary.exe');
writeFileSync(EXE_PATH, 'not really an exe');
const PDF_PATH = join(import.meta.dirname, 'fixtures', 'sample.pdf');

const consoleErrors = [];
const pageErrors = [];

// 常驻的 mock 进程可能是改动前的旧代码，先核对版本，避免出现难以定位的断言失败
const health = await fetch(`${MOCK}/health`)
  .then((r) => (r.ok ? r.json() : null))
  .catch(() => null);
if (!health || health.version !== MOCK_VERSION) {
  console.error(
    `mock server 版本不匹配（期望 ${MOCK_VERSION}，实际 ${health ? health.version : '不可达'}）。` +
      '请重启：npm run mock'
  );
  process.exit(1);
}

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
  check('侧边栏左下角有设置按钮', await page.locator('#btn-sidebar-settings').isVisible());
  await page.screenshot({ path: join(OUT, '01-empty.png') });

  // ---------- 2. 配置 provider ----------
  await page.getByRole('button', { name: '去配置 API' }).click();
  await page.locator('#settings-mask:not(.hidden)').waitFor();
  check('配置入口直达 API 服务面板', await page.locator('#panel-api').isVisible());
  await page.fill('#pf-name', 'Mock 服务');
  await page.fill('#pf-baseUrl', `${MOCK}/v1`);
  await page.fill('#pf-apiKey', 'test-key');
  await page.fill('#pf-models', 'mock-model\nmock-alt\nmock-nousage');
  // 单价覆盖：验证费用估算走用户配置而不是内置参考价
  await page.fill('#pf-priceInput', '2');
  await page.fill('#pf-priceOutput', '8');
  await page.getByRole('button', { name: '保存' }).click();
  check('保存后服务出现在列表', (await page.locator('.provider-item').count()) === 1);
  await page.locator('#settings-mask .provider-item').waitFor();
  await page.screenshot({ path: join(OUT, '02-settings.png') });
  await page.click('#btn-close-settings');
  await page.waitForFunction(() => document.querySelector('#settings-mask').classList.contains('hidden'));

  // ---------- 3. 模型自动选中 + 下拉面板 ----------
  const label = await page.locator('#model-label').textContent();
  check('模型自动选中', label.includes('mock-model'), `label=${label}`);
  check('模型指示灯点亮', (await page.locator('#model-dot.on').count()) === 1);

  await page.click('#model-select');
  await page.locator('#model-menu:not(.hidden)').waitFor({ timeout: 3000 });
  await page.waitForTimeout(300); // 等入场动画结束再断言/截图
  check('菜单按服务分组', (await page.locator('#model-menu .menu-group').first().textContent()) === 'Mock 服务');
  check('菜单列出模型项', (await page.locator('#model-menu .menu-item').count()) === 3);
  check('当前模型高亮', (await page.locator('#model-menu .menu-item.active').count()) === 1);
  check('选中项带勾选图标', (await page.locator('#model-menu .menu-check').count()) === 1);
  check('菜单底部有配置入口', await page.locator('.model-menu-foot').isVisible());
  await page.screenshot({ path: join(OUT, '02b-model-menu.png') });
  await page.click('#model-menu .menu-item');
  await page.waitForFunction(() => document.querySelector('#model-menu').classList.contains('hidden'));
  check('点击模型后菜单关闭', true);

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
  const singleFoot = await page.locator('.msg.assistant .usage-foot').textContent();
  check('单模型回复显示实测用量', singleFoot.includes('提示 42') && singleFoot.includes('输出 108') && singleFoot.includes('合计 150'), singleFoot);
  check('按服务配置单价估算费用', singleFoot.includes('$0.0009'), singleFoot);
  check('页脚显示耗时', /用时 \d+\.\ds/.test(singleFoot), singleFoot);
  await page.screenshot({ path: join(OUT, '03-chat.png') });

  // ---------- 5. 刷新后持久化 ----------
  await page.reload({ waitUntil: 'networkidle' });
  check('刷新后消息仍在', (await page.locator('.msg.user').count()) >= 1);
  check('刷新后 provider 仍在', (await page.locator('#model-label').textContent()).includes('mock-model'));

  // ---------- 6. 新会话 + 多图附件 ----------
  await page.click('#btn-new-chat');
  check('新会话进入空状态', (await page.locator('.empty-state h3').textContent()) === '开始新对话');
  await page.setInputFiles('#file-input', [IMG_PATH, IMG_PATH_2]);
  await page.locator('#attach-bar:not(.hidden)').waitFor({ timeout: 5000 });
  await page.waitForFunction(() => document.querySelectorAll('.attach-chip').length === 2, null, { timeout: 10000 });
  check('两张图片各生成一个待发送项', (await page.locator('.attach-chip').count()) === 2);
  check('附件摘要统计图片数量', (await page.locator('#attach-summary').textContent()).includes('2 张图片'));
  check('图片项显示缩略图', (await page.locator('.attach-chip .chip-thumb').count()) === 2);

  await page.click('#btn-attach-clear');
  check('全部移除按钮清空附件栏', await page.locator('#attach-bar').isHidden());

  await page.setInputFiles('#file-input', [IMG_PATH, IMG_PATH_2]);
  await page.locator('.attach-chip').nth(1).waitFor();
  await page.fill('#input', '看看这两张图');
  await page.press('#input', 'Enter');
  await page.waitForSelector('.msg.user .bubble-img', { timeout: 5000 });
  check('用户消息展示两张图', (await page.locator('.msg.user .bubble-img').count()) === 2);
  await page.waitForSelector('#btn-send:not(.hidden)', { timeout: 30000 });
  check('图片会话正常回复', (await page.locator('.msg.assistant .prose').count()) >= 1);
  check('发送后附件栏自动收起', await page.locator('#attach-bar').isHidden());
  await page.screenshot({ path: join(OUT, '04-multi-image.png') });

  // 报文层面确认走的是 vision 数组且带两张图
  const imgReq = await fetch(`${MOCK}/last-request`).then((r) => r.json());
  const imgContent = imgReq.messages[imgReq.messages.length - 1].content;
  check(
    '请求体含两条 image_url',
    Array.isArray(imgContent) && imgContent.filter((c) => c.type === 'image_url').length === 2,
    JSON.stringify(imgContent).slice(0, 120)
  );

  // ---------- 6b. 文档附件（Markdown / JSON / PDF） ----------
  await page.click('#btn-new-chat');
  await page.setInputFiles('#file-input', [MD_PATH, JSON_PATH]);
  await page.locator('.attach-chip').nth(1).waitFor({ timeout: 10000 });
  const docSubs = await page.locator('.attach-chip .chip-sub').allTextContents();
  check('文本文档解析出字数', docSubs.every((s) => /字/.test(s)), docSubs.join(' | '));
  check('附件摘要统计文档数量', (await page.locator('#attach-summary').textContent()).includes('2 个文档'));

  await page.setInputFiles('#file-input', PDF_PATH);
  await page.waitForFunction(
    () => {
      const subs = [...document.querySelectorAll('.attach-chip .chip-sub')].map((el) => el.textContent);
      return subs.length === 3 && subs.some((s) => /页/.test(s));
    },
    null,
    { timeout: 30000 }
  );
  const pdfSub = (await page.locator('.attach-chip .chip-sub').allTextContents())[2];
  check('PDF 解析出页数与字数', /2 页/.test(pdfSub), pdfSub);

  await page.fill('#input', '读一下这些文档');
  await page.press('#input', 'Enter');
  await page.waitForSelector('.msg.user .doc-part', { timeout: 10000 });
  const docNames = await page.locator('.msg.user .doc-part .doc-name').allTextContents();
  check('气泡内列出全部文档名', docNames.join(',') === 'notes.md,payload.json,sample.pdf', docNames.join(','));
  check('会话标题取正文而非附件名', (await page.locator('.session-item.active .s-title').textContent()) === '读一下这些文档');

  await page.locator('.msg.user .doc-part').nth(0).locator('summary').click();
  const mdText = await page.locator('.msg.user .doc-part .doc-text').nth(0).textContent();
  check('展开可见 Markdown 提取文本', mdText.includes('会议纪要') && mdText.includes('第一条结论'), mdText.slice(0, 40));

  await page.waitForSelector('#btn-send:not(.hidden)', { timeout: 30000 });
  const docReq = await fetch(`${MOCK}/last-request`).then((r) => r.json());
  const docContent = docReq.messages[docReq.messages.length - 1].content;
  check('文档文本已内嵌进 prompt', typeof docContent === 'string' && docContent.includes('【附件文档：notes.md】'), String(docContent).slice(0, 90));
  check('PDF 文本也内嵌（含中文）', docContent.includes('MiMo Attachment Fixture') && docContent.includes('中文文档测试'));
  check('图片未混入纯文本文档请求', !docContent.includes('image_url'));
  await page.screenshot({ path: join(OUT, '05-documents.png') });

  // ---------- 6c. 不支持的文件类型 + 附件数量上限 ----------
  await page.click('#btn-new-chat');
  await page.setInputFiles('#file-input', EXE_PATH);
  await page.waitForSelector('#toast.error', { timeout: 4000 });
  check('不支持的类型给出提示', (await page.locator('#toast').textContent()).includes('不支持的文件类型'));
  check('被拒绝的文件不进入附件栏', await page.locator('#attach-bar').isHidden());

  await page.setInputFiles('#file-input', [IMG_PATH, IMG_PATH_2, MD_PATH, JSON_PATH, PDF_PATH, EXE_PATH]);
  await page.waitForSelector('#toast.error', { timeout: 10000 });
  await page.waitForFunction(() => document.querySelectorAll('.attach-chip').length === 5, null, { timeout: 30000 });
  check('附件数量上限为 5', (await page.locator('.attach-chip').count()) === 5);
  check('达上限后提示并禁用添加按钮', await page.locator('#btn-attach').isDisabled());
  await page.click('#btn-attach-clear');
  check('清空后恢复可添加', !(await page.locator('#btn-attach').isDisabled()));

  // ---------- 7. 对比模式：同一条消息并行发给两个模型，左右分栏 ----------
  await page.click('#btn-compare-toggle');
  check('对比开关进入激活态', (await page.locator('#btn-compare-toggle').getAttribute('aria-pressed')) === 'true');
  check('开启后自动带入当前模型', (await page.locator('#model-label').textContent()).includes('mock-model vs ？'));

  await page.click('#model-select');
  await page.locator('#model-menu:not(.hidden)').waitFor();
  check('已选模型标注 A', (await page.locator('#model-menu .menu-badge').first().textContent()) === 'A');
  await page.locator('#model-menu .menu-item', { hasText: 'mock-alt' }).click();
  check('两个模型时标注 A/B', (await page.locator('#model-menu .menu-badge').count()) === 2);
  check('胶囊显示两个模型', (await page.locator('#model-label').textContent()).includes('mock-model vs mock-alt'));

  await page.locator('#model-menu .menu-item', { hasText: 'mock-nousage' }).click();
  await page.waitForSelector('#toast.error', { timeout: 3000 });
  check('最多只能选两个模型', (await page.locator('#toast').textContent()).includes('最多 2 个模型'));
  await page.keyboard.press('Escape');
  await page.waitForFunction(() => document.querySelector('#model-menu').classList.contains('hidden'));

  await page.fill('#input', '对比一下这两个模型');
  await page.press('#input', 'Enter');
  await page.waitForSelector('.compare-row', { timeout: 10000 });
  check('回复以左右分栏呈现', (await page.locator('.compare-row').count()) === 1);
  check('分栏内为两条回复', (await page.locator('.compare-row > .msg.assistant').count()) === 2);
  await page.waitForSelector('#btn-send:not(.hidden)', { timeout: 30000 });

  const branchModels = await page.locator('.compare-row .branch-model').allTextContents();
  check('两栏分别标注模型名', branchModels.join(',') === 'mock-model,mock-alt', branchModels.join(','));
  const cols = await page.locator('.compare-row .prose').allInnerTexts();
  check(
    '两栏内容各自独立',
    cols[0].includes('(mock-model)') && cols[1].includes('(mock-alt)'),
    cols.map((c) => c.slice(0, 18)).join(' | ')
  );
  const branchFoots = await page.locator('.compare-row .usage-foot').allTextContents();
  check('两栏各自显示用量与费用', branchFoots.every((f) => f.includes('提示 42') && f.includes('合计 150') && f.includes('$0.0009')), branchFoots.join(' | '));

  // 报文层面确认两个模型分支拿到的是同一轮用户消息
  const cmpReq = await fetch(`${MOCK}/last-request`).then((r) => r.json());
  check('对比分支的模型名已透传', ['mock-model', 'mock-alt'].includes(cmpReq.model), String(cmpReq.model));
  check('对比分支请求仍带 stream_options', JSON.stringify(cmpReq.stream_options) === '{"include_usage":true}');
  await page.screenshot({ path: join(OUT, '08-compare.png') });

  // ---------- 7b. 接口不回传 usage 时回退为估算 ----------
  await page.click('#btn-compare-toggle');
  check('可关闭对比模式', (await page.locator('#btn-compare-toggle').getAttribute('aria-pressed')) === 'false');
  await page.click('#model-select');
  await page.locator('#model-menu:not(.hidden)').waitFor();
  await page.locator('#model-menu .menu-item', { hasText: 'mock-nousage' }).click();
  await page.waitForFunction(() => document.querySelector('#model-menu').classList.contains('hidden'));

  await page.click('#btn-new-chat');
  await page.fill('#input', '这次接口不回传用量');
  await page.press('#input', 'Enter');
  await page.waitForSelector('#btn-send:not(.hidden)', { timeout: 30000 });
  const estFoot = await page.locator('.msg.assistant .usage-foot').textContent();
  check('无 usage 时回退为估算值', estFoot.includes('≈'), estFoot);
  check('估算值不再等于接口固定值', !estFoot.includes('提示 42'), estFoot);
  check('估算值随内容量变化', /输出 ≈\d{2,}/.test(estFoot), estFoot);
  await page.screenshot({ path: join(OUT, '09-usage-estimate.png') });

  // ---------- 8. 错误处理（bad key → 401） ----------
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

  // ---------- 9. 左下角设置：外观与主题切换 ----------
  await page.click('#btn-sidebar-settings');
  await page.locator('#settings-mask:not(.hidden)').waitFor();
  check('侧边栏设置按钮打开外观面板', await page.locator('#panel-appearance').isVisible());
  check('API 面板此时隐藏', await page.locator('#panel-api').isHidden());
  check(
    '默认选中暗黑主题',
    (await page.locator('.theme-option[data-theme-value="dark"]').getAttribute('aria-pressed')) === 'true'
  );
  check('主题缩略预览已渲染', (await page.locator('.theme-thumb').count()) === 2);
  await page.screenshot({ path: join(OUT, '06a-settings-appearance.png') });

  await page.click('.theme-option[data-theme-value="light"]');
  check('切换到明亮后根元素带 data-theme', (await page.getAttribute('html', 'data-theme')) === 'light');
  check(
    '明亮卡片被标记为选中',
    (await page.locator('.theme-option[data-theme-value="light"]').getAttribute('aria-pressed')) === 'true'
  );
  const lightBg = await page.evaluate(() => getComputedStyle(document.body).backgroundColor);
  const lightInk = await page.evaluate(() => getComputedStyle(document.body).color);
  check('明亮配色实际生效', lightBg === 'rgb(255, 255, 255)' && lightInk === 'rgb(26, 31, 39)', `${lightBg} / ${lightInk}`);
  await page.click('#btn-close-settings');
  await page.screenshot({ path: join(OUT, '06-theme-light.png') });

  await page.reload({ waitUntil: 'networkidle' });
  check('刷新后主题仍是明亮', (await page.getAttribute('html', 'data-theme')) === 'light');
  // 切回带附件的会话，确认附件文本与图片确实随本地存储还原
  await page.locator('.session-item', { hasText: '读一下这些文档' }).first().click();
  await page.waitForSelector('.msg.user .doc-part', { timeout: 5000 });
  check('刷新后文档消息仍在', (await page.locator('.msg.user .doc-part').count()) === 3);
  await page.screenshot({ path: join(OUT, '07-theme-light-chat.png') });

  await page.click('#btn-sidebar-settings');
  await page.click('#tab-api');
  check('标签可切到 API 服务面板', await page.locator('#panel-api').isVisible());
  check('切面板后外观面板隐藏', await page.locator('#panel-appearance').isHidden());
  await page.click('#tab-appearance');
  check('标签可切回外观面板', await page.locator('#panel-appearance').isVisible());

  await page.click('.theme-option[data-theme-value="dark"]');
  check('可切回暗黑主题', (await page.getAttribute('html', 'data-theme')) === 'dark');
  await page.click('#btn-close-settings');

  // ---------- 10. 控制台无异常 ----------
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
