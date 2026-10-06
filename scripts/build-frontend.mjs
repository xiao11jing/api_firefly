/**
 * build-frontend.mjs —— 组装 Tauri 使用的静态前端目录 dist/
 * 用法： node scripts/build-frontend.mjs（npm run dist / tauri:build 都会调用）
 *
 * 只拷贝运行期需要的文件（index.html、js/、css/、assets/），
 * 避免把 node_modules、.git、tests 等整棵树打进安装包。
 */
import { cpSync, existsSync, mkdirSync, rmSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const dist = join(root, 'dist');
const ITEMS = ['index.html', 'js', 'css', 'assets'];

rmSync(dist, { recursive: true, force: true });
mkdirSync(dist, { recursive: true });

for (const item of ITEMS) {
  const src = join(root, item);
  if (!existsSync(src)) throw new Error(`缺少 ${item}，无法组装 dist`);
  cpSync(src, join(dist, item), { recursive: true });
}

console.log(`dist 已组装：${dist}`);
