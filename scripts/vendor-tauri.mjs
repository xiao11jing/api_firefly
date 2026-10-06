/**
 * vendor-tauri.mjs —— 把 @tauri-apps 官方 ESM 拷贝到 js/vendor/tauri/
 * index.html 的 import map 指向该目录；Tauri 运行时按裸说明符动态 import 时解析到这里。
 * 依赖升级后重新执行： node scripts/vendor-tauri.mjs（结果提交进仓库）
 */
import { cpSync, existsSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const nm = join(root, 'node_modules', '@tauri-apps');
const out = join(root, 'js', 'vendor', 'tauri');

/** [源（相对 node_modules/@tauri-apps）, 目标（相对 js/vendor/tauri）] */
const FILES = [
  ['api/core.js', 'api/core.js'],
  ['api/path.js', 'api/path.js'],
  ['api/external/tslib/tslib.es6.js', 'api/external/tslib/tslib.es6.js'],
  ['plugin-fs/dist-js/index.js', 'plugin-fs/index.js'],
  ['plugin-http/dist-js/index.js', 'plugin-http/index.js'],
];

for (const [src, dst] of FILES) {
  const from = join(nm, src);
  if (!existsSync(from)) throw new Error(`缺少 ${from}，请先执行 npm install`);
  const to = join(out, dst);
  mkdirSync(dirname(to), { recursive: true });
  cpSync(from, to);
}
console.log(`vendor 已更新：${out}`);
