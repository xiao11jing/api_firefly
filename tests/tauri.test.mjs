import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, statSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (rel) => readFileSync(path.join(root, rel), 'utf8');
const pkg = JSON.parse(read('package.json'));

test('tauri.conf.json：产物、版本、窗口与前端目录', () => {
  const conf = JSON.parse(read('src-tauri/tauri.conf.json'));
  assert.equal(conf.productName, 'ai-multi-chat');
  assert.equal(conf.identifier, 'com.firefly.aimultichat');
  assert.equal(conf.version, pkg.version, 'tauri 版本必须与 package.json 一致');
  assert.deepEqual(conf.bundle.targets, ['deb'], '只产出 .deb');
  assert.equal(conf.bundle.active, true);
  assert.equal(conf.build.frontendDist, '../dist');
  assert.equal(conf.build.devUrl, 'http://127.0.0.1:8800');
  const win = conf.app.windows[0];
  assert.equal(win.label, 'main');
  assert.equal(win.title, 'AI Chat · 多模型对话');
  assert.ok(win.width >= 1000 && win.height >= 700);
});

test('bundle.icon 引用的图标都存在且格式正确', () => {
  const conf = JSON.parse(read('src-tauri/tauri.conf.json'));
  assert.ok(conf.bundle.icon.length >= 4);
  for (const rel of conf.bundle.icon) {
    const buf = readFileSync(path.join(root, 'src-tauri', rel));
    assert.ok(buf.length > 100, `${rel} 不应是空文件`);
    if (rel.endsWith('.png')) {
      // PNG 魔数 + IHDR 宽高
      assert.deepEqual([...buf.slice(0, 8)], [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a], `${rel} 应为 PNG`);
      const w = buf.readUInt32BE(16);
      const h = buf.readUInt32BE(20);
      assert.equal(w, h, `${rel} 应为正方形`);
      assert.ok([32, 128, 256, 512].includes(w), `${rel} 尺寸应为 32/128/256/512，实际 ${w}`);
    } else if (rel.endsWith('.ico')) {
      assert.equal(buf.readUInt16LE(0), 0, 'ico 保留字段应为 0');
      assert.equal(buf.readUInt16LE(2), 1, 'ico 类型应为 1（图标）');
    }
  }
});

test('Cargo.toml：包名、版本、Tauri 2 依赖', () => {
  const cargo = read('src-tauri/Cargo.toml');
  assert.match(cargo, /name = "ai-multi-chat"/);
  assert.ok(cargo.includes(`version = "${pkg.version}"`), 'Cargo 版本必须与 package.json 一致');
  assert.match(cargo, /tauri = \{ version = "2"/);
  assert.match(cargo, /tauri-build = \{ version = "2"/);
  assert.match(cargo, /edition = "2021"/);
});

test('main.rs：Linux 下默认关闭 WebKit 沙箱并启动 Builder', () => {
  const main = read('src-tauri/main.rs');
  assert.ok(main.includes('WEBKIT_FORCE_SANDBOX'), 'proot 环境需要默认关闭沙箱');
  assert.ok(main.includes('std::env::set_var'), '应在运行前注入环境变量');
  assert.ok(main.includes('tauri::Builder'));
  assert.ok(main.includes('tauri::generate_context!'));
  assert.ok(read('src-tauri/build.rs').includes('tauri_build::build()'));
});

test('capability：core:default + 应用数据目录范围内的 fs 权限', () => {
  const cap = JSON.parse(read('src-tauri/capabilities/default.json'));
  assert.equal(cap.identifier, 'default');
  assert.deepEqual(cap.windows, ['main']);
  assert.ok(cap.permissions.includes('core:default'));
  const fsPerms = cap.permissions.filter((p) => typeof p === 'object' && p.identifier.startsWith('fs:'));
  assert.ok(fsPerms.length >= 9, '文件存储所需的 fs 权限都要在列');
  const ids = fsPerms.map((p) => p.identifier);
  for (const need of [
    'fs:allow-mkdir',
    'fs:allow-exists',
    'fs:allow-read-dir',
    'fs:allow-read-text-file',
    'fs:allow-write-text-file',
    'fs:allow-read-file',
    'fs:allow-write-file',
    'fs:allow-remove',
    'fs:allow-rename',
  ]) {
    assert.ok(ids.includes(need), `缺少 ${need}`);
  }
  for (const p of fsPerms) {
    assert.deepEqual(p.allow, [{ path: '$APPDATA/**' }], `${p.identifier} 必须限定在 $APPDATA 内`);
  }
  const cargo = read('src-tauri/Cargo.toml');
  assert.match(cargo, /tauri-plugin-fs = "2"/);
  assert.ok(read('src-tauri/main.rs').includes('tauri_plugin_fs::init()'));
});

test('本地请求通道：plugin-http 注册、URL scope 与 vendor', () => {
  const cargo = read('src-tauri/Cargo.toml');
  assert.match(cargo, /tauri-plugin-http = "2"/);
  assert.ok(read('src-tauri/main.rs').includes('tauri_plugin_http::init()'));
  const cap = JSON.parse(read('src-tauri/capabilities/default.json'));
  const http = cap.permissions.find((p) => typeof p === 'object' && p.identifier === 'http:default');
  assert.ok(http, '缺少 http:default 权限（plugin-http 强制 scope）');
  assert.deepEqual(http.allow, [{ url: 'http://*' }, { url: 'https://*' }], '放行任意 http/https 主机');
  const vendorPath = path.join(root, 'js/vendor/tauri/plugin-http/index.js');
  assert.ok(existsSync(vendorPath) && statSync(vendorPath).size > 1000, '缺少 plugin-http vendor');
  const vendor = readFileSync(vendorPath, 'utf8');
  assert.ok(vendor.includes('plugin:http|fetch'), 'vendor 应包含 fetch 命令');
  const html = read('index.html');
  assert.ok(html.includes('"@tauri-apps/plugin-http": "./js/vendor/tauri/plugin-http/index.js"'));
  assert.ok(pkg.devDependencies['@tauri-apps/plugin-http']);
  // 前端注入点：provider 可换通道，main 在桌面环境装配
  const provider = read('js/provider.js');
  assert.ok(provider.includes('export function setFetch'));
  assert.ok(provider.includes('fetchImpl('));
  const main = read('js/main.js');
  assert.ok(main.includes("@tauri-apps/plugin-http"), 'main 应动态加载本地请求通道');
  assert.ok(main.includes('setFetch('));
});

test('工作区授权：dialog 插件 + allow_vault_dir 运行时 scope', () => {
  const cargo = read('src-tauri/Cargo.toml');
  assert.match(cargo, /tauri-plugin-dialog = "2"/);
  const main = read('src-tauri/main.rs');
  assert.ok(main.includes('tauri_plugin_dialog::init()'), '注册 dialog 插件');
  assert.ok(main.includes('fn allow_vault_dir'), '自定义运行时授权命令');
  assert.ok(main.includes('allow_directory'), '调用 fs scope 动态授权');
  assert.ok(main.includes('generate_handler![allow_vault_dir]'), '注册进 invoke_handler');
  assert.ok(main.includes('is_absolute'), '拒绝非绝对路径');
  const cap = JSON.parse(read('src-tauri/capabilities/default.json'));
  assert.ok(
    cap.permissions.some((p) => typeof p === 'object' && p.identifier === 'dialog:default'),
    '缺少 dialog 权限'
  );
  const vendorPath = path.join(root, 'js/vendor/tauri/plugin-dialog/index.js');
  assert.ok(existsSync(vendorPath) && statSync(vendorPath).size > 1000, '缺少 dialog vendor');
  assert.ok(readFileSync(vendorPath, 'utf8').includes('plugin:dialog|open'));
  assert.ok(read('index.html').includes('"@tauri-apps/plugin-dialog"'));
  assert.ok(pkg.devDependencies['@tauri-apps/plugin-dialog']);
  // 前端入口存在
  assert.ok(existsSync(path.join(root, 'js/learn/vault.js')), '缺少 vault 纯逻辑模块');
});

test('vendor：官方 ESM 已拷贝且 import map 指向它们', () => {
  const files = [
    'js/vendor/tauri/api/core.js',
    'js/vendor/tauri/api/path.js',
    'js/vendor/tauri/api/external/tslib/tslib.es6.js',
    'js/vendor/tauri/plugin-fs/index.js',
  ];
  for (const rel of files) {
    const p = path.join(root, rel);
    assert.ok(existsSync(p) && statSync(p).size > 1000, `缺少 vendor 文件 ${rel}`);
  }
  const fsJs = readFileSync(path.join(root, 'js/vendor/tauri/plugin-fs/index.js'), 'utf8');
  assert.ok(fsJs.includes('plugin:fs|write_text_file'), 'vendor 的 plugin-fs 应包含二进制写入命令');
  const html = read('index.html');
  assert.ok(html.includes('"@tauri-apps/plugin-fs": "./js/vendor/tauri/plugin-fs/index.js"'));
  assert.ok(html.includes('"@tauri-apps/api/core": "./js/vendor/tauri/api/core.js"'));
  assert.ok(html.includes('<script type="importmap">'));
  assert.ok(pkg.devDependencies['@tauri-apps/api'] && pkg.devDependencies['@tauri-apps/plugin-fs']);
});

test('npm scripts 提供 dist / tauri:dev / tauri:build', () => {
  assert.equal(pkg.scripts.dist, 'node scripts/build-frontend.mjs');
  assert.ok(pkg.scripts['tauri:build'].includes('scripts/build-frontend.mjs'), '打包前必须先组装 dist');
  assert.ok(pkg.scripts['tauri:build'].endsWith('tauri build'));
  assert.ok(pkg.devDependencies['@tauri-apps/cli'], '需要 Tauri CLI');
});

test('build-frontend 组装出干净的 dist/', () => {
  execFileSync(process.execPath, [path.join(root, 'scripts', 'build-frontend.mjs')], { stdio: 'pipe' });
  const must = [
    'index.html',
    'js/defaults.js',
    'js/main.js',
    'css/style.css',
    'assets/defaults/avatar.png',
    'assets/defaults/background.png',
    'assets/defaults/splash.mp4',
    'js/vendor/highlight.min.js',
  ];
  for (const rel of must) {
    const p = path.join(root, 'dist', rel);
    assert.ok(existsSync(p) && statSync(p).size > 0, `dist 缺少 ${rel}`);
  }
  const distIndex = readFileSync(path.join(root, 'dist', 'index.html'), 'utf8');
  assert.ok(distIndex.includes('btn-splash-toggle'), 'dist 应为最新前端');
  for (const bad of ['node_modules', 'src-tauri', 'tests', '.git']) {
    assert.ok(!existsSync(path.join(root, 'dist', bad)), `dist 不应包含 ${bad}`);
  }
});

test('.gitignore 忽略 dist 与 Rust 构建产物', () => {
  const ig = read('.gitignore');
  assert.ok(ig.includes('dist/'));
  assert.ok(ig.includes('src-tauri/target/'));
  assert.ok(ig.includes('src-tauri/gen/'));
});
