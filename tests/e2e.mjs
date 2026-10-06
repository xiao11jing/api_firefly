/**
 * e2e.mjs — 浏览器端到端验证（需先启动 static-server 与 mock-server）
 * 运行：node tests/e2e.mjs
 */
import { chromium } from 'playwright-core';
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
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
const DOCX_PATH = join(import.meta.dirname, 'fixtures', 'sample.docx');
const HTML_PATH = join(OUT, 'page.html');
writeFileSync(
  HTML_PATH,
  '<html><head><title>不应出现的标题</title></head><body><h1>HTML可见标题</h1><p>这是可见正文段落。</p><script>secretAlert()</script><style>.x{color:red}</style></body></html>',
  'utf8'
);

// 开屏视频夹具：仓库里已有则直接用，否则用浏览器 MediaRecorder 现场录一段 webm
const SPLASH_PATH = join(import.meta.dirname, 'fixtures', 'splash.webm');
async function ensureSplashFixture(p) {
  if (existsSync(SPLASH_PATH) && statSync(SPLASH_PATH).size > 0) return;
  const b64 = await p.evaluate(
    () =>
      new Promise((resolve, reject) => {
        const canvas = document.createElement('canvas');
        canvas.width = 160;
        canvas.height = 90;
        const c2d = canvas.getContext('2d');
        let f = 0;
        const timer = setInterval(() => {
          f += 1;
          c2d.fillStyle = `rgb(${(f * 25) % 255},60,120)`;
          c2d.fillRect(0, 0, 160, 90);
        }, 80);
        const stream = canvas.captureStream(12);
        const rec = new MediaRecorder(stream, { mimeType: 'video/webm' });
        const chunks = [];
        rec.ondataavailable = (e) => chunks.push(e.data);
        rec.onerror = (e) => reject(new Error(String(e.error || 'MediaRecorder error')));
        rec.onstop = () => {
          clearInterval(timer);
          const fr = new FileReader();
          fr.onload = () => resolve(fr.result.split(',')[1]);
          fr.onerror = reject;
          fr.readAsDataURL(new Blob(chunks, { type: 'video/webm' }));
        };
        rec.start();
        setTimeout(() => rec.stop(), 1500);
      })
  );
  writeFileSync(SPLASH_PATH, Buffer.from(b64, 'base64'));
}

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

// 浏览器选择：E2E_CHANNEL 可强制指定；默认依次 msedge → chrome → chromium。
// 不允许兜底到 chromium-headless-shell：旧无头引擎不把 a.download 文件名透传给下载管理器
// （suggestedFilename 会退回字面量 'download'，两项导出文件名断言必挂）。channel 'chromium'
// = 完整版 Chrome for Testing 的新无头模式，与 msedge 行为一致。
// chromiumSandbox 关闭：测试只访问本机，且 proot/容器里沙箱起不来。
async function launchBrowser() {
  const forced = process.env.E2E_CHANNEL;
  const tries = forced ? [forced === 'default' ? null : forced] : ['msedge', 'chrome', 'chromium'];
  let lastErr = null;
  for (const channel of tries) {
    try {
      const browser = await chromium.launch({
        ...(channel ? { channel } : {}),
        headless: true,
        chromiumSandbox: false,
      });
      console.log(
        `E2E 浏览器：channel=${channel || '默认(headless-shell)'}，version=${browser.version()}`
      );
      if (!channel) {
        console.log('警告：正在使用 headless shell 引擎，导出文件名类断言可能不可靠');
      }
      return browser;
    } catch (e) {
      lastErr = e;
    }
  }
  console.error(
    '无法启动 E2E 浏览器。先执行： npx playwright-core install chromium' +
      '（装完整版 chromium，不要只装 headless shell；缺共享库时再执行 npx playwright-core install-deps chromium）'
  );
  throw lastErr;
}
const browser = await launchBrowser();
// 显式创建 context（而非 browser.newPage 的隐式 context），后续才能 context.newPage() 复用同一份存储
const context = await browser.newContext({ viewport: { width: 1440, height: 900 }, acceptDownloads: true });
const page = await context.newPage();

// 出厂开屏默认为「开」：默认压掉开屏标记，避免遮挡绝大多数交互；
// 开屏相关用例用 allowSplash()/blockSplash() 显式放开或恢复（见 9d）
await context.addInitScript(() => {
  try {
    if (!localStorage.getItem('e2e-allow-splash')) sessionStorage.setItem('splashPlayed', '1');
  } catch {
    /* 存储不可用时忽略 */
  }
});
/** 放开开屏：下一次导航真正播放（清会话标记 + 打开白名单） */
const allowSplash = (p) =>
  p.evaluate(() => {
    localStorage.setItem('e2e-allow-splash', '1');
    sessionStorage.removeItem('splashPlayed');
  });
/** 恢复默认屏蔽（开屏用例收尾调用，避免影响后续交互） */
const blockSplash = (p) =>
  p.evaluate(() => {
    localStorage.removeItem('e2e-allow-splash');
    sessionStorage.setItem('splashPlayed', '1');
  });

/** 直接读取本地状态，便于断言持久化结果（例如系统提示快照） */
const readState = () => page.evaluate(() => JSON.parse(localStorage.getItem('ai-multi-chat-v1')));
const activeSessionState = async () => {
  const s = await readState();
  return s.sessions.find((x) => x.id === s.activeSessionId) || null;
};
/** 悬停模型名取到实际文字色，同时解析当前主题的强调色，用于断言 hover 跟随主题 */
const modelHoverColors = async () => {
  await page.hover('#model-select');
  await page.waitForTimeout(150);
  const label = await page.evaluate(() => getComputedStyle(document.querySelector('#model-label')).color);
  const accent = await page.evaluate(() => {
    const el = document.createElement('div');
    el.style.color = getComputedStyle(document.documentElement).getPropertyValue('--accent-strong').trim();
    document.body.appendChild(el);
    const c = getComputedStyle(el).color;
    el.remove();
    return c;
  });
  return { label, accent };
};
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
  check('首屏显示欢迎标题', (await page.locator('.empty-state h3').textContent()) === 'Firefly来陪你聊天和思考');
  check('首屏保留未配置提示', (await page.locator('.welcome-note').textContent()).includes('还没有配置 API 服务'));
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
  check('按服务配置单价估算费用（人民币）', singleFoot.includes('¥0.0009'), singleFoot);
  check('页脚显示耗时', /用时 \d+\.\ds/.test(singleFoot), singleFoot);
  await page.screenshot({ path: join(OUT, '03-chat.png') });

  // ---------- 5. 刷新后持久化（启动即新建对话：刷新回到欢迎页，旧会话从侧栏点开） ----------
  await page.reload({ waitUntil: 'networkidle' });
  check('刷新后回到新建对话欢迎页', await page.locator('.empty-state.welcome').isVisible());
  check('刷新后 provider 仍在', (await page.locator('#model-label').textContent()).includes('mock-model'));
  // 启动即新建对话：旧会话从侧栏点开，消息仍在（数据不丢，只是不再自动定位）
  await page.locator('.session-item', { hasText: '你好，这是端到端测试' }).first().click();
  await page.waitForSelector('.msg.user', { timeout: 5000 });
  check('刷新后消息仍在', (await page.locator('.msg.user').count()) >= 1);

  // ---------- 6. 新会话 + 多图附件 ----------
  await page.click('#btn-new-chat');
  check('新会话进入欢迎页', (await page.locator('.empty-state h3').textContent()) === 'Firefly来陪你聊天和思考');
  check('新会话为欢迎布局', await page.evaluate(() => document.documentElement.classList.contains('is-welcome')));
  check(
    '附件入口为加号图标',
    (await page.locator('#btn-attach circle').count()) === 0 &&
      (await page.locator('#btn-attach path').getAttribute('d')).includes('M8 3.4v9.2')
  );
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
  // 收起，供后面的搜索用例验证「命中折叠内容时自动展开」
  await page.locator('.msg.user .doc-part').nth(0).locator('summary').click();
  check('文档预览可收起', (await page.locator('.msg.user .doc-part[open]').count()) === 0);

  await page.waitForSelector('#btn-send:not(.hidden)', { timeout: 30000 });
  const docReq = await fetch(`${MOCK}/last-request`).then((r) => r.json());
  const docContent = docReq.messages[docReq.messages.length - 1].content;
  check('文档文本已内嵌进 prompt', typeof docContent === 'string' && docContent.includes('【附件文档：notes.md】'), String(docContent).slice(0, 90));
  check('PDF 文本也内嵌（含中文）', docContent.includes('MiMo Attachment Fixture') && docContent.includes('中文文档测试'));
  check('图片未混入纯文本文档请求', !docContent.includes('image_url'));
  await page.screenshot({ path: join(OUT, '05-documents.png') });

  // ---------- 6b-2. 会话导出 Markdown ----------
  const [download] = await Promise.all([page.waitForEvent('download'), page.click('#btn-export')]);
  check('导出文件名取会话标题', download.suggestedFilename() === '读一下这些文档.md', download.suggestedFilename());
  const exportedPath = join(OUT, 'exported.md');
  await download.saveAs(exportedPath);
  const exported = readFileSync(exportedPath, 'utf8');
  check(
    '导出头部含标题、时间与消息数',
    exported.startsWith('# 读一下这些文档\n') && /- 导出时间：\d{4}-\d{2}-\d{2} \d{2}:\d{2}/.test(exported) && /- 消息数：2/.test(exported),
    exported.split('\n').slice(0, 4).join(' / ')
  );
  check('导出含用户正文与文档正文', exported.includes('读一下这些文档') && exported.includes('第一条结论：先做多模型对话。'));
  check(
    '导出含附件名、模型标注与外部说明',
    exported.includes('**文档附件：notes.md**') &&
      exported.includes('文档附件：payload.json') &&
      /## Firefly（Mock 服务 · mock-model）/.test(exported) &&
      exported.includes('图片附件仅保留文件名')
  );
  check(
    '导出含用量与耗时备注',
    /> 用量：提示 42 · 输出 108 · 合计 150 · 用时 \d+\.\ds/.test(exported),
    (exported.match(/> 用量：[^\n]*/) || [''])[0]
  );
  check('导出不写入图片/文档的原始二进制', !exported.includes('data:image/') && !exported.includes('base64'));

  // ---------- 6b-3. 会话内搜索 ----------
  await page.keyboard.press('Control+f');
  check('Ctrl+F 打开搜索栏', await page.locator('#search-bar').isVisible());

  await page.fill('#search-input', '纪要');
  await page.waitForFunction(() => document.querySelectorAll('mark.search-hit').length === 1);
  check('能搜到折叠文档里的文本', (await page.locator('mark.search-hit').count()) === 1);
  check('当前命中标记为激活', (await page.locator('mark.search-hit.active').count()) === 1);
  check('命中折叠内容时自动展开', await page.locator('.msg.user .doc-part').first().evaluate((el) => el.open));
  check('显示命中计数', (await page.locator('#search-count').textContent()) === '1/1');

  await page.fill('#search-input', '点');
  await page.waitForFunction(() => document.querySelectorAll('mark.search-hit').length === 2);
  check('多命中时停在第一个', (await page.locator('#search-count').textContent()) === '1/2');
  check('首个命中即高亮项', (await page.locator('mark.search-hit.active').textContent()) === '点');
  await page.press('#search-input', 'Enter');
  check('回车跳到下一个命中', (await page.locator('#search-count').textContent()) === '2/2');
  await page.press('#search-input', 'Enter');
  check('到末尾后回到第一个', (await page.locator('#search-count').textContent()) === '1/2');
  await page.locator('#btn-search-prev').click();
  check('上一个按钮可反向跳转', (await page.locator('#search-count').textContent()) === '2/2');
  await page.screenshot({ path: join(OUT, '05b-search.png') });

  await page.fill('#search-input', '这个词不存在zzz');
  await page.waitForFunction(() => document.querySelector('#search-count').textContent === '无匹配');
  check('无命中时给出提示', (await page.locator('mark.search-hit').count()) === 0);

  await page.keyboard.press('Escape');
  check('Esc 关闭搜索栏', await page.locator('#search-bar').isHidden());
  check('关闭后清除高亮与计数', (await page.locator('mark.search-hit').count()) === 0 && (await page.locator('#search-count').textContent()) === '');

  // 切到空会话时搜索/导出应被禁用
  await page.click('#btn-new-chat');
  check('空会话禁用搜索与导出', (await page.locator('#btn-search').isDisabled()) && (await page.locator('#btn-export').isDisabled()));

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
  check('两栏各自显示用量与费用', branchFoots.every((f) => f.includes('提示 42') && f.includes('合计 150') && f.includes('¥0.0009')), branchFoots.join(' | '));

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

  // ---------- 7c. 系统提示模板 ----------
  const PROMPT_V1 = '你是一位严谨的中文编辑，回答先给结论再给理由。';
  const PROMPT_V2 = '你是一位代码审查者，只指出问题，不复述代码。';

  await page.click('#btn-sidebar-settings');
  await page.locator('#settings-mask:not(.hidden)').waitFor();
  await page.click('#tab-prompt');
  check('左侧导航切到提示词面板', await page.locator('#panel-prompt').isVisible());
  check('设置导航共六项且垂直排列', (await page.locator('.settings-nav-item').count()) === 6);
  check('模板列表初始为空', (await page.locator('#template-list .provider-item').count()) === 0);
  const navBox = await page.locator('.settings-nav').boundingBox();
  const panelBox = await page.locator('.settings-panels').boundingBox();
  check(
    '设置面板为左右布局',
    navBox.x + navBox.width <= panelBox.x + 1,
    `nav右缘=${Math.round(navBox.x + navBox.width)} panels左缘=${Math.round(panelBox.x)}`
  );

  await page.fill('#tf-name', '写作助手');
  await page.fill('#tf-content', PROMPT_V1);
  await page.getByRole('button', { name: '保存' }).click();
  check('新建模板出现在列表', (await page.locator('#template-list .provider-item').count()) === 1);
  check('模板列表显示正文字数', (await page.locator('#template-list .pi-sub').textContent()).includes('字'));
  await page.screenshot({ path: join(OUT, '10-settings-prompt.png') });
  await page.click('#btn-close-settings');

  // 在会话里选定模板
  await page.click('#btn-pill-prompt');
  await page.locator('#prompt-menu:not(.hidden)').waitFor();
  await page.waitForTimeout(250); // 等入场动画结束再断言/截图
  check('提示菜单含模板与不使用', (await page.locator('#prompt-menu .menu-item').count()) === 2);
  check('提示菜单已展开', await page.locator('#prompt-menu').isVisible());
  await page.screenshot({ path: join(OUT, '10b-prompt-menu.png') });
  await page.locator('#prompt-menu .menu-item', { hasText: '写作助手' }).click();
  check('选定后胶囊出现标记', await page.locator('#prompt-flag').isVisible());
  check('选定后入口进入激活态', (await page.locator('#btn-pill-prompt.has-value').count()) === 1);

  await page.fill('#input', '用一句话说明系统提示是否生效');
  await page.press('#input', 'Enter');
  await page.waitForSelector('#btn-send:not(.hidden)', { timeout: 30000 });
  const sysReq = await fetch(`${MOCK}/last-request`).then((r) => r.json());
  check(
    '报文首条为 system 消息',
    sysReq.messages[0].role === 'system' && sysReq.messages[0].content === PROMPT_V1,
    JSON.stringify(sysReq.messages[0]).slice(0, 80)
  );
  check('system 之后紧跟用户消息', sysReq.messages[1].role === 'user');

  const afterSend = await activeSessionState();
  check('系统提示不落进会话消息列表', afterSend.messages.every((m) => m.role !== 'system'), afterSend.messages.map((m) => m.role).join(','));
  const lastReply = [...afterSend.messages].reverse().find((m) => m.role === 'assistant');
  check(
    '回复记录当轮系统提示',
    lastReply.systemPrompt && lastReply.systemPrompt.name === '写作助手' && lastReply.systemPrompt.text === PROMPT_V1,
    JSON.stringify(lastReply.systemPrompt)
  );

  // 改模板正文：会话仍用旧快照，需显式重新套用
  await page.click('#btn-sidebar-settings');
  await page.click('#tab-prompt');
  await page.locator('#template-list .provider-item').first().click();
  await page.fill('#tf-content', PROMPT_V2);
  await page.getByRole('button', { name: '保存' }).click();
  await page.click('#btn-close-settings');
  check('模板改动后会话仍用旧快照', (await activeSessionState()).systemPrompt.text === PROMPT_V1);

  await page.click('#btn-pill-prompt');
  await page.locator('#prompt-menu:not(.hidden)').waitFor();
  await page.waitForTimeout(250);
  check('菜单提示模板已更新', await page.locator('.prompt-menu-note').isVisible());
  await page.screenshot({ path: join(OUT, '10c-prompt-updated.png') });
  await page.locator('.prompt-menu-note').click();
  check('重新套用后快照换成新正文', (await activeSessionState()).systemPrompt.text === PROMPT_V2);

  // 取消系统提示：报文里不应再出现 system
  await page.click('#btn-pill-prompt');
  await page.locator('#prompt-menu:not(.hidden)').waitFor();
  await page.locator('#prompt-menu .menu-item', { hasText: '不使用' }).click();
  check('取消后标记消失', await page.locator('#prompt-flag').isHidden());
  check('取消后快照被清空', (await activeSessionState()).systemPrompt === null);

  await page.fill('#input', '取消提示后再来一次');
  await page.press('#input', 'Enter');
  await page.waitForSelector('#btn-send:not(.hidden)', { timeout: 30000 });
  const noSysReq = await fetch(`${MOCK}/last-request`).then((r) => r.json());
  check(
    '取消后报文不再带 system',
    noSysReq.messages.every((m) => m.role !== 'system'),
    noSysReq.messages.map((m) => m.role).join(',')
  );

  // 导出应写出当轮系统提示，并对未使用提示的轮次如实标注
  const [promptDownload] = await Promise.all([page.waitForEvent('download'), page.click('#btn-export')]);
  const promptExportPath = join(OUT, 'exported-prompt.md');
  await promptDownload.saveAs(promptExportPath);
  const promptMd = readFileSync(promptExportPath, 'utf8');
  check('导出在回复标题下写出系统提示', /\*\*系统提示（写作助手）\*\*/.test(promptMd) && promptMd.includes(PROMPT_V1));
  check('导出标注未使用提示的轮次', promptMd.includes('> 本轮未使用系统提示'));

  // ---------- 8. 错误处理（bad key → 401） ----------
  await page.click('#btn-sidebar-settings');
  await page.locator('#settings-mask:not(.hidden)').waitFor();
  await page.click('#tab-api');
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
  // 明亮主题的次级文字改为正文同色（原 #8b94a2 在浅色背景上偏淡）
  const faintLight = await page.evaluate(() => {
    const el = document.createElement('div');
    el.style.color = getComputedStyle(document.documentElement).getPropertyValue('--faint').trim();
    document.body.appendChild(el);
    const c = getComputedStyle(el).color;
    el.remove();
    return c;
  });
  check('明亮主题 --faint 已改为深色', faintLight === 'rgb(26, 31, 39)', faintLight);
  await page.click('#btn-close-settings');
  await page.screenshot({ path: join(OUT, '06-theme-light.png') });
  // 模型名 hover 必须跟随主题：此前写死白色，明亮主题下变成白字白底看不见
  const hoverLight = await modelHoverColors();
  check(
    '明亮主题下模型名 hover 不是白字且取强调色',
    hoverLight.label === hoverLight.accent && hoverLight.label !== 'rgb(255, 255, 255)',
    JSON.stringify(hoverLight)
  );

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

  // ---------- 9a. 设置弹窗尺寸一致 + 背景图片 ----------
  await page.click('#btn-sidebar-settings');
  await page.locator('#settings-mask:not(.hidden)').waitFor();
  const modalSizes = [];
  for (const panel of ['appearance', 'api', 'prompt']) {
    await page.click(`#tab-${panel}`);
    await page.waitForTimeout(220);
    const box = await page.locator('#settings-mask .modal').boundingBox();
    modalSizes.push(`${Math.round(box.width)}x${Math.round(box.height)}`);
  }
  check('切换设置面板时弹窗尺寸不变', new Set(modalSizes).size === 1, modalSizes.join(' / '));

  await page.click('#tab-appearance');
  check(
    '未设置时应用出厂默认背景',
    await page.evaluate(() => document.querySelector('#bg-layer').style.backgroundImage.includes('assets/defaults/background.png'))
  );
  await page.setInputFiles('#bg-input', IMG_PATH);
  await page.waitForTimeout(500);
  check('设置背景后根元素带 has-bg', await page.evaluate(() => document.documentElement.classList.contains('has-bg')));
  // 侧边栏与顶栏必须与中间对话区完全一致：不加底衬、不做模糊，否则图片呈现不一致
  const panelStyles = await page.evaluate(() => {
    const read = (sel) => {
      const cs = getComputedStyle(document.querySelector(sel));
      return { bg: cs.backgroundColor, filter: cs.backdropFilter || cs.webkitBackdropFilter || 'none' };
    };
    return { sidebar: read('.sidebar'), topbar: read('.topbar') };
  });
  check(
    '侧边栏与对话区一致（无底衬无模糊）',
    panelStyles.sidebar.bg === 'rgba(0, 0, 0, 0)' && panelStyles.sidebar.filter === 'none',
    JSON.stringify(panelStyles.sidebar)
  );
  check(
    '顶栏与对话区一致（无底衬无模糊）',
    panelStyles.topbar.bg === 'rgba(0, 0, 0, 0)' && panelStyles.topbar.filter === 'none',
    JSON.stringify(panelStyles.topbar)
  );
  check(
    '背景层已应用本地图片',
    await page.evaluate(() => document.querySelector('#bg-layer').style.backgroundImage.startsWith('url("data:image/'))
  );
  check('出现不透明度控件', await page.locator('#bg-opacity-row').isVisible());
  const bgState = await readState();
  check('背景已落盘', !!(bgState.settings.background && bgState.settings.background.dataUrl.startsWith('data:image/')));
  check('背景体积在可存储范围内', bgState.settings.background.dataUrl.length <= 1600000, `${bgState.settings.background.dataUrl.length} 字符`);
  await page.screenshot({ path: join(OUT, '12-background.png') });

  await page.evaluate(() => {
    const s = document.querySelector('#bg-opacity');
    s.value = '70';
    s.dispatchEvent(new Event('input', { bubbles: true }));
    s.dispatchEvent(new Event('change', { bubbles: true }));
  });
  await page.waitForTimeout(300);
  check('不透明度实时生效', (await page.evaluate(() => document.querySelector('#bg-layer').style.opacity)) === '0.7');
  check('不透明度已落盘', (await readState()).settings.background.opacity === 70);
  await page.click('#btn-close-settings');

  await page.reload({ waitUntil: 'networkidle' });
  check('刷新后背景仍在', await page.evaluate(() => document.documentElement.classList.contains('has-bg')));
  // 启动即新建对话：点回刷新前的会话，后续占用环/资料断言需要有消息的上下文
  await page.locator('.session-item', { hasText: '读一下这些文档' }).first().click();
  await page.waitForSelector('.msg.user', { timeout: 5000 });
  await page.click('#btn-sidebar-settings');
  await page.locator('#settings-mask:not(.hidden)').waitFor();
  await page.click('#btn-bg-clear');
  await page.waitForTimeout(300);
  check('移除后回到出厂默认背景', await page.evaluate(() => document.documentElement.classList.contains('has-bg')));
  check(
    '默认背景指向内置图片',
    await page.evaluate(() => document.querySelector('#bg-layer').style.backgroundImage.includes('assets/defaults/background.png'))
  );
  check('移除后背景配置已清空', (await readState()).settings.background === null);
  await page.click('#btn-close-settings');

  // ---------- 9a-2. 输入框布局：文字在上、控件在底部一行 ----------
  check('输入框内不再有设置齿轮', (await page.locator('#btn-pill-settings').count()) === 0);
  const inputBox = await page.locator('#input').boundingBox();
  const barBox = await page.locator('.composer-bar').boundingBox();
  check(
    '文字输入区位于控件行之上',
    inputBox.y + inputBox.height <= barBox.y + 1,
    `文字底 ${Math.round(inputBox.y + inputBox.height)} / 控件顶 ${Math.round(barBox.y)}`
  );
  check(
    '附件、模型、发送都在底部控件行内',
    await page.evaluate(() =>
      ['#btn-attach', '#model-pill', '#btn-send'].every((s) =>
        document.querySelector('.composer-bar').contains(document.querySelector(s))
      )
    )
  );
  const sendBox = await page.locator('#btn-send').boundingBox();
  const pillBox = await page.locator('#model-pill').boundingBox();
  check('模型选择与发送同处一行', Math.abs(sendBox.y - pillBox.y) < 14, `send.y=${Math.round(sendBox.y)} pill.y=${Math.round(pillBox.y)}`);
  check('发送按钮在输入框右侧', sendBox.x > inputBox.x + inputBox.width / 2);

  // ---------- 9a-2b. 上下文占用环 ----------
  const ringInfo = () =>
    page.evaluate(() => {
      const ring = document.querySelector('#context-ring');
      const m = /^([\d.]+) ([\d.]+)$/.exec(ring.querySelector('.ring-progress').getAttribute('stroke-dasharray') || '');
      const rb = ring.getBoundingClientRect();
      const pb = document.querySelector('#model-pill').getBoundingClientRect();
      return {
        visible: !ring.classList.contains('hidden'),
        leftOfPill: rb.x + rb.width <= pb.x + 1,
        filled: m ? Number(m[1]) / Number(m[2]) : null,
        high: ring.classList.contains('high'),
        title: ring.getAttribute('data-tip') || '', // 提示已从原生 title 迁到 data-tip
      };
    });
  const ring0 = await ringInfo();
  check('模型胶囊左侧显示上下文占用环', ring0.visible && ring0.leftOfPill, JSON.stringify({ visible: ring0.visible, leftOfPill: ring0.leftOfPill }));
  check('占用环按本次请求的估算量填充', ring0.filled > 0 && ring0.filled < 0.2, `filled=${ring0.filled}`);
  check('未匹配到模型时提示按默认上限', ring0.title.includes('默认值'), ring0.title.replace(/\n/g, ' | '));

  // 手填一个很小的上下文上限 → 占用比例拉满并告警
  const setContextLength = async (value) => {
    await page.click('#btn-sidebar-settings');
    await page.locator('#settings-mask:not(.hidden)').waitFor();
    await page.click('#tab-api');
    await page.locator('.provider-item').first().click();
    await page.fill('#pf-contextLength', value);
    await page.getByRole('button', { name: '保存' }).click();
    await page.click('#btn-close-settings');
    await page.waitForTimeout(250);
  };
  await setContextLength('10');
  const ringHigh = await ringInfo();
  check('手填上下文长度后占用比例拉满', ringHigh.filled === 1, `filled=${ringHigh.filled}`);
  check('占用超过 90% 时进入告警态', ringHigh.high);
  check('提示写明上限来自服务配置', ringHigh.title.includes('该服务填写的上下文长度'), ringHigh.title.replace(/\n/g, ' | '));
  check('上下文长度已落盘', (await readState()).providers[0].contextLength === 10);
  await page.screenshot({ path: join(OUT, '16-context-ring.png') });

  await setContextLength('');
  const ringBack = await ringInfo();
  check('清空后回到内置参考表', ringBack.filled < 0.2 && !ringBack.high && ringBack.title.includes('默认值'), `filled=${ringBack.filled}`);
  check('清空后上下文长度记为 null', (await readState()).providers[0].contextLength === null);

  const hoverDark = await modelHoverColors();
  check('暗色主题下模型名 hover 取强调色', hoverDark.label === hoverDark.accent, JSON.stringify(hoverDark));
  await page.screenshot({ path: join(OUT, '13-composer-layout.png') });

  // ---------- 9a-3. 个人资料：双方头像与名称 ----------
  // 兜底：确保当前会话里同时有用户与 AI 消息，才能验证两边的消息头
  await page.click('#btn-sidebar-settings');
  await page.locator('#settings-mask:not(.hidden)').waitFor();
  await page.click('#tab-profile');
  check('导航可切到个人资料面板', await page.locator('#panel-profile').isVisible());
  check('默认用户名为「你」', (await page.inputValue('#pf-user-name')) === '你');
  check('默认 AI 名为「Firefly」', (await page.inputValue('#pf-ai-name')) === 'Firefly');
  check('默认不带头像（用首字占位）', (await page.locator('.profile-avatar').first().textContent()) === '你');
  check(
    'AI 头像预览为出厂默认图',
    await page.evaluate(() => (document.querySelector('#avatar-preview-ai').style.backgroundImage || '').includes('assets/defaults/avatar.png'))
  );

  const setProfileName = async (sel, value) => {
    await page.fill(sel, value);
    await page.dispatchEvent(sel, 'change');
    await page.waitForTimeout(200);
  };
  await setProfileName('#pf-user-name', '小明');
  await setProfileName('#pf-ai-name', '小助手');
  await page.click('#btn-close-settings');
  await page.waitForTimeout(300);
  check('消息头显示自定义用户名', (await page.locator('.msg.user .msg-name').first().textContent()) === '小明');
  check('AI 消息头显示自定义名称', (await page.locator('.msg.assistant .msg-name').first().textContent()) === '小助手');
  check(
    '消息头像与左上角头像都是 52px',
    await page.evaluate(
      () =>
        Math.round(document.querySelector('.msg .msg-avatar').getBoundingClientRect().width) === 52 &&
        Math.round(document.querySelector('.brand-avatar').getBoundingClientRect().width) === 52
    )
  );
  check(
    '消息区名称字号 18px',
    await page.evaluate(() => getComputedStyle(document.querySelector('.msg-name')).fontSize === '18px')
  );
  check('左上角改为 AI 名称', (await page.locator('.brand-name').textContent()) === '小助手');

  // 头像：本地图片 → 双方各设置一张
  await page.click('#btn-sidebar-settings');
  await page.locator('#settings-mask:not(.hidden)').waitFor();
  await page.click('#tab-profile');
  await page.click('#btn-avatar-user');
  await page.setInputFiles('#avatar-input', IMG_PATH);
  await page.waitForTimeout(500);
  await page.click('#btn-avatar-ai');
  await page.setInputFiles('#avatar-input', IMG_PATH_2);
  await page.waitForTimeout(500);
  check('用户头像预览已应用图片', await page.evaluate(() => document.querySelector('#avatar-preview-user').style.backgroundImage.startsWith('url("data:image/')));
  check('AI 头像预览已应用图片', await page.evaluate(() => document.querySelector('#avatar-preview-ai').style.backgroundImage.startsWith('url("data:image/')));
  check('出现移除头像按钮', (await page.locator('#btn-avatar-user-clear:not(.hidden), #btn-avatar-ai-clear:not(.hidden)').count()) === 2);
  check('左上角头像与个人资料一致', (await page.locator('.brand-avatar img').count()) === 1);
  await page.screenshot({ path: join(OUT, '14-profile-settings.png') });

  const profileState = (await readState()).settings.profile;
  check('个人资料已落盘', profileState.user.name === '小明' && profileState.ai.name === '小助手');
  check('头像已落盘且为本地图片', profileState.user.avatar.startsWith('data:image/') && profileState.ai.avatar.startsWith('data:image/'));
  check('头像体积在可存储范围内', profileState.user.avatar.length <= 400000, `${profileState.user.avatar.length} 字符`);

  await page.click('#btn-close-settings');
  await page.waitForTimeout(300);
  check('消息区渲染头像图片', (await page.locator('.msg.user .msg-avatar img').count()) >= 1 && (await page.locator('.msg.assistant .msg-avatar img').count()) >= 1);
  const headBoxes = await page.evaluate(() => {
    const pick = (sel) => {
      const head = document.querySelector(sel);
      if (!head) return null;
      return {
        avatarX: Math.round(head.querySelector('.msg-avatar').getBoundingClientRect().x),
        nameX: Math.round(head.querySelector('.msg-name').getBoundingClientRect().x),
      };
    };
    return { user: pick('.msg.user .role-head'), ai: pick('.msg.assistant .role-head') };
  });
  check('用户消息头：名称在左、头像在右', headBoxes.user && headBoxes.user.avatarX > headBoxes.user.nameX, JSON.stringify(headBoxes.user));
  check('AI 消息头：头像在左、名称在右', headBoxes.ai && headBoxes.ai.avatarX < headBoxes.ai.nameX, JSON.stringify(headBoxes.ai));
  await page.screenshot({ path: join(OUT, '15-profile-messages.png') });

  // 刷新后仍生效（启动即新建对话：先点开刷新前的有消息会话）
  await page.reload({ waitUntil: 'networkidle' });
  await page.locator('.session-item', { hasText: '读一下这些文档' }).first().click();
  await page.waitForSelector('.msg.user', { timeout: 5000 });
  check('刷新后消息头仍是自定义名称', (await page.locator('.msg.user .msg-name').first().textContent()) === '小明');
  check('刷新后头像仍在', (await page.locator('.msg.assistant .msg-avatar img').count()) >= 1);

  // 移除头像后回到首字占位
  await page.click('#btn-sidebar-settings');
  await page.locator('#settings-mask:not(.hidden)').waitFor();
  await page.click('#tab-profile');
  await page.click('#btn-avatar-user-clear');
  await page.click('#btn-avatar-ai-clear');
  await page.waitForTimeout(300);
  check('移除后头像配置清空', (await readState()).settings.profile.user.avatar === null);
  check('预览回到首字占位', (await page.locator('#avatar-preview-user').textContent()) === '小');
  check(
    'AI 头像回到出厂默认图',
    await page.evaluate(() => (document.querySelector('#avatar-preview-ai').style.backgroundImage || '').includes('assets/defaults/avatar.png'))
  );
  await page.click('#btn-close-settings');
  await page.waitForTimeout(200);
  check('消息头像回到首字占位', (await page.locator('.msg.user .msg-avatar img').count()) === 0);

  // 名称留空则回退默认
  await page.click('#btn-sidebar-settings');
  await page.locator('#settings-mask:not(.hidden)').waitFor();
  await page.click('#tab-profile');
  await setProfileName('#pf-user-name', '   ');
  check('名称留空回退默认「你」', (await page.inputValue('#pf-user-name')) === '你');
  await page.click('#btn-close-settings');

  // ---------- 9b. 会话重命名（单击选中 / 双击进入编辑） ----------
  await page.click('#btn-new-chat');
  await page.waitForTimeout(200);
  const renameTitle = page.locator('#session-list .session-item').first().locator('.s-title');
  check('新建会话使用默认名', (await renameTitle.textContent()) === '新会话');
  // 单击会重建整个列表，两次点击之间节点被换掉后浏览器不再派发 dblclick，
  // 因此这里必须用真实双击来验证「应用自己识别双击」这条路径
  await renameTitle.dblclick();
  await page.locator('#session-list .rename-input').waitFor({ timeout: 3000 });
  check('双击进入重命名编辑', (await page.locator('#session-list .rename-input').count()) === 1);
  await page.fill('#session-list .rename-input', '改过名的会话');
  await page.press('#session-list .rename-input', 'Enter');
  await page.waitForTimeout(300);
  check('重命名在界面上生效', (await renameTitle.textContent()) === '改过名的会话');
  const renamed = await activeSessionState();
  check('重命名已落盘', !!renamed && renamed.title === '改过名的会话', renamed ? renamed.title : 'null');
  await page.screenshot({ path: join(OUT, '11-rename.png') });
  await page.reload({ waitUntil: 'networkidle' });
  check('刷新后名字仍是改过的', (await page.locator('.session-item', { hasText: '改过名的会话' }).count()) === 1);

  // ---------- 9c. 存储写入失败时的降级（模拟 localStorage 配额溢出） ----------
  // 第 8 步为验证 401 把 key 改成了 bad-key，先恢复一个可用的
  await page.click('#btn-sidebar-settings');
  await page.locator('#settings-mask:not(.hidden)').waitFor();
  await page.click('#tab-api');
  await page.locator('.provider-item').first().click();
  await page.fill('#pf-apiKey', 'test-key');
  await page.getByRole('button', { name: '保存' }).click();
  await page.click('#btn-close-settings');
  await page.waitForFunction(() => document.querySelector('#settings-mask').classList.contains('hidden'));
  // 让第 3 次起 setItem 抛配额异常，对应 发送 / 占位气泡 / 流式收尾 三次持久化
  await page.evaluate(() => {
    const proto = Object.getPrototypeOf(localStorage);
    const orig = proto.setItem;
    let calls = 0;
    window.__restoreSetItem = () => {
      proto.setItem = orig;
    };
    proto.setItem = function (...args) {
      calls += 1;
      if (calls >= 3) throw new DOMException('exceeded the quota', 'QuotaExceededError');
      return orig.apply(this, args);
    };
  });
  await page.fill('#input', '存储写满时的消息');
  await page.press('#input', 'Enter');
  await page.waitForSelector('.msg.assistant .prose', { timeout: 15000 });
  // 等流式收尾：写入失败发生在分支结束的持久化上，界面必须能自行恢复
  let recovered = true;
  try {
    await page.waitForSelector('#btn-send:not(.hidden)', { timeout: 20000 });
  } catch {
    recovered = false;
  }
  check('写入失败后发送按钮已恢复', recovered);
  check('写入失败后未卡在生成中', await page.locator('#btn-stop').isHidden());
  check('写入失败时给出明确提示', (await page.locator('#toast').textContent()).includes('本地保存失败'));
  check('写入失败后回复仍可见', (await page.locator('.msg.assistant .prose').last().textContent()).length > 0);
  await page.evaluate(() => window.__restoreSetItem());

  // ---------- 9d. 开屏动画（校验 / 保存 / 播放 / 不重播 / 跳过 / 移除） ----------
  await ensureSplashFixture(page);
  await page.click('#btn-sidebar-settings');
  await page.locator('#settings-mask:not(.hidden)').waitFor();
  await page.click('#tab-appearance');
  check(
    '外观面板含开屏动画区块',
    (await page.locator('#panel-appearance .panel-title', { hasText: '开屏动画' }).count()) === 1
  );

  await page.setInputFiles('#splash-input', { name: 'not-video.txt', mimeType: 'text/plain', buffer: Buffer.from('hello') });
  await page.waitForTimeout(150);
  check('非视频文件被拒绝', (await page.locator('#toast').textContent()).includes('请选择视频文件'));

  await page.setInputFiles('#splash-input', {
    name: 'splash.webm',
    mimeType: 'video/webm',
    buffer: readFileSync(SPLASH_PATH),
  });
  await page.waitForFunction(() => document.querySelector('#splash-name').textContent === 'splash.webm');
  const splashMeta = (await readState()).settings.splash;
  check('开屏视频元数据落盘', !!splashMeta && splashMeta.name === 'splash.webm', JSON.stringify(splashMeta));
  await page.screenshot({ path: join(OUT, '17-splash-setting.png') });
  await page.click('#btn-close-settings');
  await page.waitForFunction(() => document.querySelector('#settings-mask').classList.contains('hidden'));

  // 进入页面播放一次，播完自动淡出进入界面
  await allowSplash(page);
  await page.reload({ waitUntil: 'domcontentloaded' });
  const splashShown = await page.locator('#splash-overlay').isVisible();
  check('进入页面显示开屏动画', splashShown);
  await page.screenshot({ path: join(OUT, '18-splash-playing.png') });
  let splashFinished = false;
  if (splashShown) {
    try {
      await page.locator('#splash-overlay').waitFor({ state: 'hidden', timeout: 9000 });
      splashFinished = true;
    } catch {
      /* 超时即未淡出 */
    }
  }
  check('播完自动淡出进入界面', splashFinished);

  // 同一标签页刷新不重播
  await page.reload({ waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(200);
  check('刷新不重播开屏动画', await page.locator('#splash-overlay').isHidden());

  // 新的标签页会话（新 sessionStorage）会再播，跳过按钮立即进入
  const splashPage = await page.context().newPage();
  splashPage.on('pageerror', (e) => pageErrors.push(String(e)));
  await splashPage.goto(APP, { waitUntil: 'domcontentloaded' });
  const splashShownAgain = await splashPage.locator('#splash-overlay').isVisible();
  check('再次进入重新播放', splashShownAgain);
  let splashSkipped = false;
  if (splashShownAgain) {
    await splashPage.click('#btn-splash-skip');
    try {
      await splashPage.locator('#splash-overlay').waitFor({ state: 'hidden', timeout: 3000 });
      splashSkipped = true;
    } catch {
      /* 超时即未跳过 */
    }
  }
  check('跳过按钮立即进入界面', splashSkipped);
  await splashPage.close();

  // 移除自定义后回到出厂默认开屏
  await page.click('#btn-sidebar-settings');
  await page.locator('#settings-mask:not(.hidden)').waitFor();
  await page.click('#tab-appearance');
  await page.click('#btn-splash-clear');
  await page.waitForTimeout(200);
  check('移除后回到出厂默认文案', (await page.locator('#splash-name').textContent()) === '出厂默认开屏视频');
  check('移除已落盘', (await readState()).settings.splash === null);
  await page.click('#btn-close-settings');
  // 未配置自定义且开关开启时，重新进入播出厂内置视频
  await allowSplash(page);
  await page.reload({ waitUntil: 'domcontentloaded' });
  const defaultSplashShown = await page.locator('#splash-overlay').isVisible();
  check('未配置时播出厂开屏', defaultSplashShown);
  if (defaultSplashShown) {
    // bootSplash 在异步取完自定义视频（此处为空）后才写入 src，需等待而不是立即读
    await page
      .waitForFunction(
        () => {
          const v = document.querySelector('#splash-video');
          return v && (v.getAttribute('src') || '').includes('assets/defaults/splash.mp4');
        },
        null,
        { timeout: 5000 }
      )
      .catch(() => {});
    const defSrc = await page.locator('#splash-video').getAttribute('src');
    check('出厂开屏使用内置视频', (defSrc || '').includes('assets/defaults/splash.mp4'), defSrc);
    await page.click('#btn-splash-skip');
    await page.locator('#splash-overlay').waitFor({ state: 'hidden', timeout: 3000 });
  }
  // 关闭开关后（含出厂视频）一律不再播放
  await page.click('#btn-sidebar-settings');
  await page.locator('#settings-mask:not(.hidden)').waitFor();
  await page.click('#tab-appearance');
  await page.click('#btn-splash-toggle');
  check('关闭开屏已落盘', (await readState()).settings.splashEnabled === false);
  check('开关显示为关', (await page.locator('#btn-splash-toggle').getAttribute('aria-checked')) === 'false');
  await page.click('#btn-close-settings');
  await allowSplash(page); // 有白名单但开关关闭 → 仍不播放
  await page.reload({ waitUntil: 'domcontentloaded' });
  check('关闭后不再开屏', await page.locator('#splash-overlay').isHidden());
  await blockSplash(page); // 恢复默认屏蔽，避免影响后续用例

  // ---------- 9e. 自定义悬停提示与字号缩放 ----------
  // 悬停出现自定义气泡，原生 title 属性已从元素上移除
  await page.hover('#btn-new-chat');
  await page.locator('#global-tooltip.show').waitFor({ timeout: 2000 });
  check('悬停显示自定义气泡', (await page.locator('#global-tooltip').textContent()) === '新会话');
  check('原生 title 已移除', (await page.locator('#btn-new-chat').getAttribute('title')) === null);
  await page.mouse.move(400, 500);
  await page.waitForTimeout(400);
  check('移开指针后气泡消失', await page.locator('#global-tooltip').isHidden());
  // 键盘聚焦立即显示，失焦后消失
  await page.locator('#btn-new-chat').focus();
  await page.locator('#global-tooltip.show').waitFor({ timeout: 1000 });
  check('聚焦显示气泡', (await page.locator('#global-tooltip').textContent()) === '新会话');
  await page.evaluate(() => document.activeElement && document.activeElement.blur());
  await page.waitForTimeout(300);
  check('失焦后气泡消失', await page.locator('#global-tooltip').isHidden());

  // 字号滑块：实时缩放 → 落盘 → 刷新保持 → 恢复默认
  await page.click('#btn-sidebar-settings');
  await page.locator('#settings-mask:not(.hidden)').waitFor();
  await page.click('#tab-appearance');
  const setFontScale = async (pct) => {
    await page.locator('#font-scale').evaluate((el, v) => {
      el.value = String(v);
      el.dispatchEvent(new Event('input', { bubbles: true }));
      el.dispatchEvent(new Event('change', { bubbles: true }));
    }, pct);
    await page.waitForTimeout(100);
  };
  await setFontScale(130);
  const zoom130 = await page.evaluate(() => document.documentElement.style.zoom);
  check('字号调大后整页缩放', zoom130 === '1.3', `zoom=${zoom130}`);
  check('字号数值显示', (await page.locator('#font-scale-value').textContent()) === '130%');
  check('字号缩放已落盘', (await readState()).settings.fontScale === 1.3);
  await page.screenshot({ path: join(OUT, '19-font-scale.png') });
  await page.click('#btn-close-settings');
  await page.reload({ waitUntil: 'networkidle' });
  const zoomReload = await page.evaluate(() => document.documentElement.style.zoom);
  check('刷新后字号保持', zoomReload === '1.3', `zoom=${zoomReload}`);
  // 恢复 100%，避免影响后续断言
  await page.click('#btn-sidebar-settings');
  await page.locator('#settings-mask:not(.hidden)').waitFor();
  await page.click('#tab-appearance');
  await setFontScale(100);
  check('恢复默认字号', (await page.evaluate(() => document.documentElement.style.zoom)) === '');
  check('恢复默认已落盘', (await readState()).settings.fontScale === 1);
  await page.click('#btn-close-settings');

  // ---------- 9f. 桌宠（面板 / 加载 / 缩放 / 置顶 / 拖动 / 持久化） ----------
  await page.click('#btn-sidebar-settings');
  await page.locator('#settings-mask:not(.hidden)').waitFor();
  check('设置含桌宠分类', (await page.locator('#tab-pet').count()) === 1);
  await page.click('#tab-pet');
  check('桌宠面板显示', await page.locator('#panel-pet').isVisible());
  await page.screenshot({ path: join(OUT, '20-pet-panel.png') });

  // 打开显示 → 首次加载运行时与模型（约 6MB，本地服务较快）
  await page.click('#pet-visible');
  let petLoaded = true;
  try {
    await page.waitForFunction(() => {
      const el = document.querySelector('#pet');
      return el && !el.hidden && el.style.width && parseInt(el.style.width, 10) > 50;
    }, { timeout: 25000 });
  } catch {
    petLoaded = false;
  }
  check('打开开关后桌宠加载完成', petLoaded);
  await page.click('#btn-close-settings');
  await page.waitForTimeout(500);
  const petInfo = await page.evaluate(() => {
    const el = document.querySelector('#pet');
    const r = el.getBoundingClientRect();
    return { hidden: el.hidden, z: el.style.zIndex, w: Math.round(r.width), h: Math.round(r.height), left: Math.round(r.left), top: Math.round(r.top) };
  });
  check('桌宠可见且默认在右下角', !petInfo.hidden && petInfo.left > 500 && petInfo.top > 100, JSON.stringify(petInfo));
  check('默认层级为普通 30', petInfo.z === '30', `z=${petInfo.z}`);
  // 发送按钮不被普通层级桌宠挡住
  const sendClear = await page.evaluate(() => {
    const btn = document.querySelector('#btn-send');
    const r = btn.getBoundingClientRect();
    const top = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2);
    return btn.contains(top) || top === btn;
  });
  check('桌宠不挡发送按钮', sendClear);
  await page.screenshot({ path: join(OUT, '21-pet-visible.png') });

  // 缩放 1.5x
  await page.click('#btn-sidebar-settings');
  await page.locator('#settings-mask:not(.hidden)').waitFor();
  await page.click('#tab-pet');
  await page.locator('#pet-scale').evaluate((el) => {
    el.value = '150';
    el.dispatchEvent(new Event('input', { bubbles: true }));
    el.dispatchEvent(new Event('change', { bubbles: true }));
  });
  await page.waitForTimeout(250);
  const petScaled = await page.evaluate(() => parseInt(document.querySelector('#pet').style.height, 10));
  check('缩放 1.5x 高度约 630', petScaled > 600 && petScaled < 660, `h=${petScaled}`);
  check('缩放数值显示 1.5x', (await page.locator('#pet-scale-value').textContent()) === '1.5x');

  // 置顶
  await page.click('#pet-topmost');
  await page.waitForTimeout(100);
  check('置顶切换 z-index 1500', (await page.evaluate(() => document.querySelector('#pet').style.zIndex)) === '1500');
  await page.screenshot({ path: join(OUT, '22-pet-topmost.png') });
  // 置顶时桌宠正盖在开关上方（真实场景可拖走），用 JS 触发关闭继续测试
  await page.locator('#pet-topmost').evaluate((el) => el.click());
  await page.click('#btn-close-settings');
  await page.waitForTimeout(300);

  // 拖动
  const dragBefore = await page.evaluate(() => {
    const r = document.querySelector('#pet').getBoundingClientRect();
    return { x: r.left, y: r.top, w: r.width, h: r.height };
  });
  const dragSx = dragBefore.x + dragBefore.w / 2;
  const dragSy = dragBefore.y + dragBefore.h / 2;
  await page.mouse.move(dragSx, dragSy);
  await page.mouse.down();
  await page.mouse.move(dragSx - 380, dragSy - 350, { steps: 8 });
  await page.mouse.up();
  await page.waitForTimeout(250);
  const dragAfter = await page.evaluate(() => {
    const r = document.querySelector('#pet').getBoundingClientRect();
    return { x: r.left, y: r.top, pos: JSON.parse(localStorage.getItem('ai-multi-chat-v1')).settings.pet.position };
  });
  check('拖动后位置变化', Math.abs(dragAfter.x - dragBefore.x) > 100 && Math.abs(dragAfter.y - dragBefore.y) > 100, JSON.stringify({ before: dragBefore, after: dragAfter }));
  check('拖动位置已落盘', !!dragAfter.pos && Math.abs(dragAfter.pos.x - dragAfter.x / 1440) < 0.03, JSON.stringify(dragAfter.pos));

  // 刷新保持
  await page.reload({ waitUntil: 'networkidle' });
  let petKept = true;
  try {
    await page.waitForFunction(() => {
      const el = document.querySelector('#pet');
      return el && !el.hidden && el.style.width;
    }, { timeout: 25000 });
  } catch {
    petKept = false;
  }
  const keptInfo = await page.evaluate(() => {
    const el = document.querySelector('#pet');
    return { hidden: el.hidden, h: el.style.height, st: JSON.parse(localStorage.getItem('ai-multi-chat-v1')).settings.pet };
  });
  check('刷新后桌宠保持显示', petKept && !keptInfo.hidden);
  check('刷新后缩放与位置保持', keptInfo.st.scale === 1.5 && !!keptInfo.st.position, JSON.stringify(keptInfo.st));

  // 关闭
  await page.click('#btn-sidebar-settings');
  await page.locator('#settings-mask:not(.hidden)').waitFor();
  await page.click('#tab-pet');
  await page.click('#pet-visible');
  await page.waitForTimeout(250);
  check('关闭后桌宠隐藏', await page.evaluate(() => document.querySelector('#pet').hidden));
  check('关闭已落盘', (await readState()).settings.pet.visible === false);

  // ---------- 9a-w. 欢迎页：Chat/Learn 新建对话样式与 Learn 快捷入口 ----------
  if (await page.locator('#settings-mask:not(.hidden)').count()) {
    await page.click('#btn-close-settings');
    await page.waitForTimeout(150);
  }
  await page.click('#btn-new-chat');
  await page.waitForTimeout(150);
  const aiNameNow = await page.evaluate(
    () => JSON.parse(localStorage.getItem('ai-multi-chat-v1')).settings.profile.ai.name || 'AI'
  );
  check('欢迎布局生效', await page.evaluate(() => document.documentElement.classList.contains('is-welcome')));
  check(
    'Chat 欢迎标题跟设置里的 AI 名称',
    (await page.locator('#welcome-title').textContent()) === `${aiNameNow}来陪你聊天和思考`
  );

  // 切 Learn：显示学习欢迎页，不跳设置
  await page.click('#mode-learn');
  await page.waitForTimeout(200);
  check('Learn 段高亮', (await page.getAttribute('#mode-learn', 'aria-selected')) === 'true');
  check(
    '切 Learn 不打开设置',
    await page.evaluate(() => document.querySelector('#settings-mask').classList.contains('hidden'))
  );
  check('Learn 欢迎标题', (await page.locator('#welcome-title').textContent()) === `${aiNameNow}来当你的学习搭子`);
  check('+ 旁出现选择学习主题按钮', await page.locator('#btn-learn-topic').isVisible());
  check('进度抽屉未自动弹出', await page.locator('#learn-drawer').isHidden());
  await page.screenshot({ path: join(OUT, '26-welcome-learn.png') });

  // 点按钮 → 打开设置的学习面板
  await page.click('#btn-learn-topic');
  await page.locator('#settings-mask:not(.hidden)').waitFor();
  check('按钮直达设置学习面板', await page.locator('#panel-learn').isVisible());
  await page.click('#btn-close-settings');
  await page.waitForTimeout(150);

  // 切回 Chat：标题与入口按钮复原
  await page.click('#mode-chat');
  await page.waitForTimeout(150);
  check('切回 Chat 标题复原', (await page.locator('#welcome-title').textContent()) === `${aiNameNow}来陪你聊天和思考`);
  check('Chat 下主题入口隐藏', await page.locator('#btn-learn-topic').isHidden());

  // Learn 下没关联主题直接发消息 → 自动创建全新学习主题
  await page.click('#mode-learn');
  await page.waitForTimeout(150);
  await page.fill('#input', '帮我整理一下注意力机制');
  await page.click('#btn-send');
  await page.waitForFunction(
    () => [...document.querySelectorAll('.msg.assistant .prose')].some((el) => el.textContent.includes('模拟回复')),
    { timeout: 15000 }
  );
  const autoState = await page.evaluate(() => {
    const ls = JSON.parse(localStorage.getItem('ai-multi-chat-learn-v1'));
    const s = JSON.parse(localStorage.getItem('ai-multi-chat-v1'));
    const ses = s.sessions.find((x) => x.id === s.activeSessionId);
    return { topics: ls.topics, activeTopicId: ls.activeTopicId, link: ses.learnTopicId, uiMode: ses.uiMode };
  });
  check(
    '发消息自动创建主题（首句命名·计划驱动）',
    autoState.topics.length === 1 &&
      autoState.topics[0].name === '帮我整理一下注意力机制' &&
      autoState.topics[0].mode === 'plan',
    autoState.topics.map((t) => `${t.name}/${t.mode}`).join(' | ')
  );
  check('自动主题已关联本会话', !!autoState.link && autoState.link === autoState.activeTopicId);
  check('自动关联后仍是 Learn 模式', autoState.uiMode === 'learn');
  check('关联后主题入口消失', await page.locator('#btn-learn-topic').isHidden());
  check('发出消息后离开欢迎布局', await page.evaluate(() => !document.documentElement.classList.contains('is-welcome')));
  const autoReq = await fetch(`${MOCK}/last-request`).then((r) => r.json());
  const autoSys = (autoReq.messages || []).find((m) => m.role === 'system');
  check(
    '自动创建的主题立即参与提示词注入',
    !!autoSys && autoSys.content.includes('Learn 模式常驻规则') && autoSys.content.includes('帮我整理一下注意力机制')
  );

  // ---------- 9b. Learn 模式：建主题 → 关联会话 → 访谈上下文 → 生成计划 → 推进条目 ----------
  // 上一节可能停在设置弹窗内，先确保干净的开合路径
  if (await page.locator('#settings-mask:not(.hidden)').count()) {
    await page.click('#btn-close-settings');
    await page.waitForTimeout(150);
  }
  // 新建计划驱动主题（状态留空 → AI 开场应先访谈）
  await page.click('#btn-sidebar-settings');
  await page.locator('#settings-mask:not(.hidden)').waitFor();
  await page.click('#tab-learn');
  check('设置出现学习面板', await page.locator('#panel-learn').isVisible());
  check('计划区在未选主题时隐藏', await page.locator('#learn-plan-box').isHidden());
  check('工作区绑定区块可见', await page.locator('#vault-box').isVisible());
  check('网页版工作区绑定按钮为禁用态', await page.locator('#btn-vault-pick').isDisabled());
  check(
    '网页版工作区提示引导去桌面版',
    (await page.locator('#vault-hint').textContent()).includes('桌面版')
  );
  await page.fill('#lf-name', 'Transformer 学习');
  await page.selectOption('#lf-mode', 'plan');
  await page.click('#learn-form button[type="submit"]');
  await page.waitForTimeout(200);
  check(
    '主题列表出现新建主题',
    (await page.locator('#learn-topic-list .provider-item').count()) >= 1 &&
      (await page.locator('#learn-topic-list .provider-item.active').textContent()).includes('Transformer 学习')
  );
  check('保存后进入编辑态（删除按钮可见）', await page.locator('#btn-del-topic').isVisible());
  check('计划区显示空计划提示', await page.locator('#learn-plan-box').isVisible());
  check('空计划提示文案', (await page.locator('#learn-plan-sub').textContent()).includes('暂无条目'));
  await page.click('#btn-close-settings');
  await page.waitForTimeout(200);

  // 新会话并关联学习主题
  await page.click('#btn-new-chat');
  await page.waitForTimeout(150);
  await page.click('#btn-pill-learn');
  await page.locator('#learn-menu:not(.hidden)').waitFor();
  const menuTopicTotal = await page.evaluate(
    () => JSON.parse(localStorage.getItem('ai-multi-chat-learn-v1')).topics.length
  );
  check(
    '学习菜单列出全部主题加不关联项',
    (await page.locator('#learn-menu .menu-item').count()) === menuTopicTotal + 1,
    `topics=${menuTopicTotal}`
  );
  // 按名称选中本场景新建的主题（数组里可能还有其他场景留下的主题）
  await page.locator('#learn-menu .menu-item', { hasText: 'Transformer 学习' }).click();
  await page.waitForTimeout(200);
  const learnLink = await page.evaluate(() => {
    const s = JSON.parse(localStorage.getItem('ai-multi-chat-v1'));
    const ses = s.sessions.find((x) => x.id === s.activeSessionId);
    return (ses && ses.learnTopicId) || null;
  });
  check('会话已关联学习主题', !!learnLink, String(learnLink));
  const learnPersisted = await page.evaluate(() =>
    JSON.parse(localStorage.getItem('ai-multi-chat-learn-v1'))
  );
  check('活动主题已落盘', learnPersisted && learnPersisted.activeTopicId === learnLink);
  check(
    '学习按钮出现关联标记',
    !(await page.locator('#learn-flag').evaluate((el) => el.classList.contains('hidden')))
  );

  // 发送首条消息：system 应带上 Learn 分层提示词与访谈指示
  await page.fill('#input', '我们开始吧');
  await page.click('#btn-send');
  await page.waitForFunction(
    () => [...document.querySelectorAll('.msg.assistant .prose')].some((el) => el.textContent.includes('模拟回复')),
    { timeout: 15000 }
  );
  const learnReq = await fetch(`${MOCK}/last-request`).then((r) => r.json());
  const learnSys = (learnReq.messages || []).find((m) => m.role === 'system');
  check('Learn 分层提示词已注入 system', !!learnSys && learnSys.content.includes('Learn 模式常驻规则'), learnSys ? String(learnSys.content.length) : 'no system');
  check('system 含教学人格与计划模式', learnSys.content.includes('教学人格') && learnSys.content.includes('模式一：计划驱动'));
  check('缺状态时给出开场访谈三问', learnSys.content.includes('开场访谈') && learnSys.content.includes('你目前学到哪一步了？'));
  check('访谈带跳过出口', learnSys.content.includes('先按默认走，边聊边校准'));
  check('上下文带主题名且标注未生成计划', learnSys.content.includes('Transformer 学习') && learnSys.content.includes('尚未生成计划'));

  // 请求生成计划 → mock 返回 ```plan 块 → 前端解析入库（AI 计划整体重建条目）
  await page.fill('#input', '请根据我的状态生成计划');
  await page.click('#btn-send');
  await page.waitForFunction(
    () => {
      const ls = JSON.parse(localStorage.getItem('ai-multi-chat-learn-v1'));
      const t = (ls.topics || []).find((x) => x.id === ls.activeTopicId);
      return !!t && t.plan.items.length === 3;
    },
    { timeout: 15000 }
  );
  const planState = await page.evaluate(() => {
    const ls = JSON.parse(localStorage.getItem('ai-multi-chat-learn-v1'));
    return ls.topics.find((x) => x.id === ls.activeTopicId);
  });
  check(
    'AI 计划块解析为 3 条目',
    planState.plan.items.length === 3 && planState.plan.items.every((i) => i.status === 'todo') && planState.plan.items.some((i) => i.title === '手写一遍 QKV 计算'),
    planState.plan.items.map((i) => i.title).join(' | ')
  );

  // 设置页：查看计划 → 手动追加条目 → 推进第一格
  await page.click('#btn-sidebar-settings');
  await page.locator('#settings-mask:not(.hidden)').waitFor();
  await page.click('#tab-learn');
  await page.waitForTimeout(150);
  check('计划区显示 AI 生成的 3 条', (await page.locator('#learn-plan-list .plan-row').count()) === 3);
  await page.fill('#lf-item', '整理本次笔记');
  await page.click('#btn-lf-add-item');
  await page.waitForTimeout(150);
  check(
    '手动添加为追加而非重建（共 4 条且 AI 条目仍在）',
    (await page.locator('#learn-plan-list .plan-row').count()) === 4 &&
      (await page.locator('#learn-plan-list .plan-row-title').first().textContent()).includes('理解 Self-Attention')
  );
  check('新条目状态为未开始', (await page.locator('.plan-badge').last().textContent()) === '未开始');
  await page.screenshot({ path: join(OUT, '23-learn-settings.png') });
  const firstRow = page.locator('#learn-plan-list .plan-row').first();
  check('首条状态为未开始', (await firstRow.locator('.plan-badge').textContent()) === '未开始');
  await firstRow.locator('.plan-act').click();
  await page.waitForTimeout(150);
  check('点击开始后变为进行中', (await firstRow.locator('.plan-badge').textContent()) === '进行中');
  await firstRow.locator('.plan-act').click();
  await page.waitForTimeout(150);
  check('点击完成后变为已完成', (await firstRow.locator('.plan-badge').textContent()) === '已完成');
  const advanced = await page.evaluate(() => {
    const ls = JSON.parse(localStorage.getItem('ai-multi-chat-learn-v1'));
    const t = ls.topics.find((x) => x.id === ls.activeTopicId);
    return t.plan.items[0];
  });
  check('状态流转已落盘', advanced.status === 'done', JSON.stringify(advanced));
  await page.screenshot({ path: join(OUT, '24-learn-plan.png') });
  await page.click('#btn-close-settings');
  await page.waitForTimeout(200);

  // ---------- 9c. 顶栏 Chat/Learn 切换与进度抽屉 ----------
  check('顶栏 Learn 段已高亮', (await page.getAttribute('#mode-learn', 'aria-selected')) === 'true');
  check('顶栏 Chat 段未高亮', (await page.getAttribute('#mode-chat', 'aria-selected')) === 'false');

  await page.click('#mode-learn'); // 已在 Learn → 打开进度抽屉
  await page.locator('#learn-drawer:not(.hidden)').waitFor();
  check('进度抽屉打开', await page.locator('#learn-drawer').isVisible());
  check('抽屉显示主题名与模式', (await page.locator('.ld-meta').textContent()).includes('Transformer 学习'));
  const planSummary = await page.locator('.ld-summary').textContent();
  check('抽屉显示完成度 1/4', planSummary.includes('已完成 1 / 共 4 条'), planSummary);
  check('正确率显示暂无作答', (await page.locator('.ld-acc-value').textContent()).includes('暂无'));
  check(
    '待解决问题计数为 0',
    (await page.locator('.ld-section-title').nth(2).textContent()) === '待解决问题（0）'
  );
  check('抽屉内计划条目 4 行', (await page.locator('#learn-drawer-body .plan-row').count()) === 4);
  // 抽屉打开时输入区不被遮挡（.main 右移让位；等 0.2s 过渡完成再测量）
  await page.waitForTimeout(350);
  const segSendBox = await page.locator('#btn-send').boundingBox();
  const drawerBox = await page.locator('#learn-drawer').boundingBox();
  check('发送按钮不被抽屉遮挡', segSendBox.x + segSendBox.width <= drawerBox.x + 1, `send右=${segSendBox.x + segSendBox.width} 抽屉左=${drawerBox.x}`);
  await page.screenshot({ path: join(OUT, '25-learn-drawer.png') });

  // 抽屉内推进第二条：未开始 → 进行中
  const dRow = page.locator('#learn-drawer-body .plan-row').nth(1);
  await dRow.locator('.plan-act').click();
  await page.waitForTimeout(300);
  check('抽屉内点击开始后变为进行中', (await dRow.locator('.plan-badge').textContent()) === '进行中');

  // 导出学习工作区
  const dlPromise = page.waitForEvent('download');
  await page.click('#btn-learn-export');
  const dl = await dlPromise;
  check('导出文件名', dl.suggestedFilename() === 'Transformer 学习-学习工作区.md', dl.suggestedFilename());
  const dlText = readFileSync(await dl.path(), 'utf8');
  check(
    '导出按虚拟目录分节',
    dlText.includes('## learn/plan.md') && dlText.includes('## learn/progress.md') && dlText.includes('## exercises/quiz-log.md')
  );
  check('导出含计划条目与进度', dlText.includes('理解 Self-Attention 的动机') && dlText.includes('学习进度'));

  await page.keyboard.press('Escape');
  check('Esc 关闭抽屉', await page.locator('#learn-drawer').isHidden());

  // 切到 Chat：暂停 Learn 注入
  await page.click('#mode-chat');
  await page.waitForTimeout(150);
  check('Chat 段高亮', (await page.getAttribute('#mode-chat', 'aria-selected')) === 'true');
  check('Chat 段下学习标记隐藏', await page.locator('#learn-flag').evaluate((el) => el.classList.contains('hidden')));
  await page.fill('#input', '这是普通聊天');
  await page.click('#btn-send');
  await page.waitForFunction(
    () => [...document.querySelectorAll('.msg.assistant .prose')].some((el) => el.textContent.includes('模拟回复')),
    { timeout: 15000 }
  );
  const chatReq = await fetch(`${MOCK}/last-request`).then((r) => r.json());
  const chatSys = (chatReq.messages || []).find((m) => m.role === 'system');
  check('Chat 模式不注入 Learn 提示词', !chatSys || !chatSys.content.includes('Learn 模式常驻规则'));

  // 切回 Learn：恢复注入并重新打开面板
  await page.click('#mode-learn');
  await page.locator('#learn-drawer:not(.hidden)').waitFor();
  check('切回 Learn 后抽屉重开', await page.locator('#learn-drawer').isVisible());
  check('切回 Learn 后标记恢复', !(await page.locator('#learn-flag').evaluate((el) => el.classList.contains('hidden'))));
  await page.fill('#input', '继续学习');
  await page.click('#btn-send');
  await page.waitForFunction(
    () => [...document.querySelectorAll('.msg.assistant .prose')].some((el) => el.textContent.includes('模拟回复')),
    { timeout: 15000 }
  );
  const backReq = await fetch(`${MOCK}/last-request`).then((r) => r.json());
  const backSys = (backReq.messages || []).find((m) => m.role === 'system');
  check('切回 Learn 后恢复注入', !!backSys && backSys.content.includes('Learn 模式常驻规则'));

  // ---------- 9d. Phase4：资料归档/跨会话插入、出题判定、结束学习复盘 ----------
  // 发送文档 → 自动归档进当前主题（Transformer 学习）
  await page.setInputFiles('#file-input', MD_PATH);
  await page.locator('#attach-bar:not(.hidden)').waitFor({ timeout: 5000 });
  await page.fill('#input', '把这份文档归档到资料库');
  await page.click('#btn-send');
  await page.waitForFunction(
    () => {
      const ls = JSON.parse(localStorage.getItem('ai-multi-chat-learn-v1'));
      const t = (ls.topics || []).find((x) => x.id === ls.activeTopicId);
      return !!t && t.materials.length === 1;
    },
    { timeout: 15000 }
  );
  const matMeta = await page.evaluate(() => {
    const ls = JSON.parse(localStorage.getItem('ai-multi-chat-learn-v1'));
    const t = ls.topics.find((x) => x.id === ls.activeTopicId);
    return t.materials[0];
  });
  check(
    '发出的文档自动归档到主题',
    matMeta.name === 'notes.md' && matMeta.kind === 'text',
    JSON.stringify(matMeta)
  );
  check('抽屉资料区出现条目', (await page.locator('#learn-drawer .ld-mat-row').count()) === 1);
  check('归档后附件栏清空', await page.locator('#attach-bar').isHidden());

  // 资料筛选
  await page.fill('#learn-drawer .ld-filter', 'notes');
  check('筛选命中保留条目', (await page.locator('#learn-drawer .ld-mat-row').count()) === 1);
  await page.fill('#learn-drawer .ld-filter', '不存在的文件');
  check('无匹配显示提示', (await page.locator('#learn-drawer .ld-mat-list .ld-none').textContent()).includes('没有匹配'));
  await page.fill('#learn-drawer .ld-filter', '');

  // 出题 → 作答判定
  await page.fill('#input', '请出一道练习题');
  await page.click('#btn-send');
  await page.waitForFunction(
    () => {
      const ls = JSON.parse(localStorage.getItem('ai-multi-chat-learn-v1'));
      const t = (ls.topics || []).find((x) => x.id === ls.activeTopicId);
      return !!t && t.quizzes.length === 1;
    },
    { timeout: 15000 }
  );
  const quiz0 = await page.evaluate(() => {
    const ls = JSON.parse(localStorage.getItem('ai-multi-chat-learn-v1'));
    const t = ls.topics.find((x) => x.id === ls.activeTopicId);
    return t.quizzes[0];
  });
  check(
    '练习批次录入且初始未判定',
    quiz0.entries.length === 1 && quiz0.entries[0].verdict === 'unresolved' && quiz0.entries[0].question.includes('Q、K、V'),
    JSON.stringify(quiz0.entries.map((e) => e.verdict))
  );
  check('未判定不计入正确率', (await page.locator('#learn-drawer .ld-acc-value').textContent()).includes('暂无'));

  await page.fill('#input', '答：查询、键、值');
  await page.click('#btn-send');
  await page.waitForFunction(
    () => {
      const ls = JSON.parse(localStorage.getItem('ai-multi-chat-learn-v1'));
      const t = (ls.topics || []).find((x) => x.id === ls.activeTopicId);
      return !!t && t.quizzes[0] && t.quizzes[0].entries[0].verdict === 'right';
    },
    { timeout: 15000 }
  );
  const verdictEntry = await page.evaluate(() => {
    const ls = JSON.parse(localStorage.getItem('ai-multi-chat-learn-v1'));
    const t = ls.topics.find((x) => x.id === ls.activeTopicId);
    return t.quizzes[0].entries[0];
  });
  check('判定登记为 right 且带作答原文', verdictEntry.userAnswer === '答：查询、键、值', verdictEntry.userAnswer);
  await page.waitForTimeout(200);
  check('抽屉正确率显示 100%', (await page.locator('#learn-drawer .ld-acc-value').textContent()).includes('100'));
  check('正确率口径注明 AI 判定', (await page.locator('#learn-drawer .ld-acc-note').textContent()).includes('AI 判定'));

  // 结束本次学习 → 复盘落盘 + 计划推进
  await page.click('#btn-learn-finish');
  await page.waitForFunction(
    () => {
      const ls = JSON.parse(localStorage.getItem('ai-multi-chat-learn-v1'));
      const t = (ls.topics || []).find((x) => x.id === ls.activeTopicId);
      return !!t && t.reviews.length === 1;
    },
    { timeout: 15000 }
  );
  const reviewState = await page.evaluate(() => {
    const ls = JSON.parse(localStorage.getItem('ai-multi-chat-learn-v1'));
    const t = ls.topics.find((x) => x.id === ls.activeTopicId);
    return { review: t.reviews[0], items: t.plan.items.map((i) => i.status) };
  });
  check('复盘已落盘', reviewState.review.title === '注意力机制学习复盘', JSON.stringify(reviewState.review));
  check('复盘 advance 推进计划一格', reviewState.items[1] === 'done' && reviewState.items[2] === 'doing', reviewState.items.join(','));
  check('对话中发出结束学习请求', (await page.locator('.msg.user .bubble').last().textContent()).includes('结束本次学习'));
  check('抽屉复盘记录出现', (await page.locator('#learn-drawer .ld-rev-row').count()) === 1 &&
    (await page.locator('#learn-drawer .ld-rev-row').first().textContent()).includes('注意力机制学习复盘'));

  // 跨会话：新会话关联同主题 → 资料仍可见 → 插入对话
  await page.click('#btn-new-chat');
  await page.waitForTimeout(200);
  check('新会话抽屉显示未关联空态', (await page.locator('#learn-drawer .ld-empty').textContent()).includes('未关联学习主题'));
  await page.click('#btn-pill-learn');
  await page.locator('#learn-menu:not(.hidden)').waitFor();
  await page.locator('#learn-menu .menu-item', { hasText: 'Transformer 学习' }).click();
  await page.waitForTimeout(250);
  check(
    '新会话关联后资料跨会话可见',
    (await page.locator('#learn-drawer .ld-mat-row').count()) === 1 &&
      (await page.locator('#learn-drawer .ld-mat-name').first().textContent()) === 'notes.md'
  );
  await page.locator('#learn-drawer .ld-mat-row .ld-mini-btn', { hasText: '插入' }).click();
  await page.locator('#attach-bar:not(.hidden)').waitFor({ timeout: 5000 });
  const insertChip = await page.locator('.attach-chip').first().textContent();
  check('资料插入进附件栏（正文随文件恢复）', insertChip.includes('notes.md'), insertChip.slice(0, 60));
  await page.click('#btn-attach-clear');
  check('清空后附件栏收起', await page.locator('#attach-bar').isHidden());

  // ---------- 9e. Phase5 新格式：HTML 正文提取与 Word 解析（未关联主题，不触发归档） ----------
  // 上一步的空会话仍关联着主题（且没发过消息）：先断开，直接复用它
  await page.click('#btn-pill-learn');
  await page.locator('#learn-menu:not(.hidden)').waitFor();
  await page.locator('#learn-menu .menu-item', { hasText: '不关联' }).click();
  await page.waitForTimeout(200);
  const unlinked = await page.evaluate(() => {
    const s = JSON.parse(localStorage.getItem('ai-multi-chat-v1'));
    const ses = s.sessions.find((x) => x.id === s.activeSessionId);
    return { link: ses.learnTopicId || null, msgs: ses.messages.length };
  });
  check('新格式场景使用空且未关联的会话', unlinked.link === null && unlinked.msgs === 0, JSON.stringify(unlinked));
  await page.setInputFiles('#file-input', [HTML_PATH, DOCX_PATH]);
  await page.waitForFunction(
    () => document.querySelectorAll('.attach-chip').length === 2 &&
      document.querySelectorAll('.attach-chip.loading').length === 0,
    null,
    { timeout: 15000 }
  );
  const fmtSubs = await page.locator('.attach-chip .chip-sub').allTextContents();
  check('HTML 与 Word 均解析出字数', fmtSubs.length === 2 && fmtSubs.every((s) => /字/.test(s)), fmtSubs.join(' | '));
  await page.fill('#input', '读一下这两个新格式文件');
  await page.click('#btn-send');
  await page.waitForFunction(
    () => [...document.querySelectorAll('.msg.assistant .prose')].some((el) => el.textContent.includes('模拟回复')),
    { timeout: 15000 }
  );
  await page.waitForSelector('.msg.user .doc-part', { timeout: 5000 });
  const fmtNames = await page.locator('.msg.user .doc-part .doc-name').allTextContents();
  check(
    '文档气泡含 HTML 与 Word 文件名',
    fmtNames.some((n) => n.includes('page.html')) && fmtNames.some((n) => n.includes('sample.docx')),
    fmtNames.join(' | ')
  );
  await page.locator('.msg.user .doc-part').nth(0).locator('summary').click();
  const htmlText = await page.locator('.msg.user .doc-part .doc-text').nth(0).textContent();
  check('HTML 提取可见正文', htmlText.includes('HTML可见标题') && htmlText.includes('这是可见正文段落。'), htmlText.slice(0, 50));
  check('HTML 已去掉脚本与样式', !htmlText.includes('secretAlert') && !htmlText.includes('color:red'));
  await page.locator('.msg.user .doc-part').nth(0).locator('summary').click();
  await page.locator('.msg.user .doc-part').nth(1).locator('summary').click();
  const docxText = await page.locator('.msg.user .doc-part .doc-text').nth(1).textContent();
  check(
    'Word 提取中英文正文',
    docxText.includes('MiMo Attachment Fixture') && docxText.includes('中文文档测试'),
    docxText.slice(0, 50)
  );
  await page.screenshot({ path: join(OUT, '27-new-formats.png') });

  // 新格式会话未关联主题 → 资料库不受影响（Transformer 的归档仍是 1 份）
  const cleanTopics = await page.evaluate(() => JSON.parse(localStorage.getItem('ai-multi-chat-learn-v1')));
  const transformer = cleanTopics.topics.find((t) => t.name === 'Transformer 学习');
  check(
    '未关联会话不产生归档',
    !!transformer && transformer.materials.length === 1 && transformer.materials[0].name === 'notes.md',
    JSON.stringify(transformer && transformer.materials.map((m) => m.name))
  );

  // ---------- 10. 控制台无异常 ----------
  check('无页面 JS 异常', pageErrors.length === 0, pageErrors.join(' | '));
  const realConsoleErrors = consoleErrors.filter(
    (e) => !e.includes('favicon') && !e.includes('本地保存失败') // 上面故意触发的配额失败会打一条 console.error
  );
  check('无控制台错误', realConsoleErrors.length === 0, realConsoleErrors.join(' | '));
} catch (e) {
  check('流程执行未抛异常', false, String(e && e.message ? e.message : e));
  await page.screenshot({ path: join(OUT, '99-failure.png') }).catch(() => {});
} finally {
  await browser.close();
}

console.log(`\n${results.length - failed}/${results.length} checks passed`);
process.exit(failed ? 1 : 0);
