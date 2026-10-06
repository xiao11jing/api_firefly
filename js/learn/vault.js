/**
 * vault.js —— 学习工作区（Vault）纯逻辑：路径安全、结构化块解析、确认队列（无 DOM / 无 FS）
 *
 * 权限模型（learn_project.md §2 决策 8、Phase 6）：
 *  - 读：授权目录内任意相对路径（禁 .. 穿越）；
 *  - 写：仅 notes/、exercises/、learn/ 三个 AI 产出子目录，且必须经 UI 逐次确认；
 *  - 保留目录（.obsidian/.git 等）永不写入。
 */

/** AI 可写子目录（相对工作区根） */
export const WRITABLE_DIRS = ['learn', 'notes', 'exercises'];

/** 保留目录：永不写入（点开头的配置/版本目录） */
export const RESERVED_PREFIXES = ['.'];

/** 单个写入请求的内容上限（字符），与资料库提取上限同一量级 */
export const FILE_CONTENT_LIMIT = 200000;

const CONTROL_RE = /[\u0000-\u001f\u007f]/;

/**
 * 归一化工作区内的相对路径。
 * @returns {{ok: true, path: string} | {ok: false, reason: string}}
 */
export function normalizeRelPath(raw) {
  if (typeof raw !== 'string') return { ok: false, reason: '路径必须是字符串' };
  let p = raw.trim().replace(/\\/g, '/').replace(/\/{2,}/g, '/');
  while (p.startsWith('./')) p = p.slice(2);
  if (!p) return { ok: false, reason: '路径为空' };
  if (CONTROL_RE.test(p)) return { ok: false, reason: '路径含控制字符' };
  if (p.startsWith('/')) return { ok: false, reason: '不接受绝对路径' };
  if (/^[A-Za-z]:/.test(p)) return { ok: false, reason: '不接受盘符路径' };
  const segments = p.split('/');
  if (segments.length > 12) return { ok: false, reason: '路径层级过深' };
  for (const seg of segments) {
    if (!seg) return { ok: false, reason: '路径含空段' };
    if (seg === '.' || seg === '..') return { ok: false, reason: '路径含 . 或 .. 段' };
    if (seg.length > 100) return { ok: false, reason: '路径段过长' };
  }
  if (p.length > 500) return { ok: false, reason: '路径过长' };
  return { ok: true, path: p };
}

/** 是否落在保留目录（.obsidian/.git/... 之下的任意路径） */
export function isReservedPath(relPath) {
  const first = String(relPath || '').split('/')[0] || '';
  return first.startsWith('.') && first !== '.' && first !== '..';
}

/** 是否允许写入：结构合法 + 位于可写子目录 + 非保留目录 */
export function isWritablePath(raw) {
  const norm = normalizeRelPath(raw);
  if (!norm.ok) return false;
  const first = norm.path.split('/')[0];
  return WRITABLE_DIRS.includes(first) && !isReservedPath(norm.path);
}

/** SHA-256 十六进制摘要，统一加 sha256- 前缀（contentHash 乐观锁用） */
export async function sha256Hex(text) {
  const data = new TextEncoder().encode(String(text == null ? '' : text));
  const digest = await globalThis.crypto.subtle.digest('SHA-256', data);
  const hex = [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
  return `sha256-${hex}`;
}

function matchFence(text, lang) {
  const re = new RegExp('```' + lang + '\\s*\\n?([\\s\\S]*?)```', 'i');
  return String(text || '').match(re);
}

/**
 * 解析 ```file 写入提议块：
 * {"path": "notes/x.md", "content": "……", "baseHash"?: "sha256-…"}
 * 结构非法 / 路径不可写 / 内容超限 → null（静默忽略，与其它结构化约定一致）。
 */
export function parseFileBlock(text) {
  const fence = matchFence(text, 'file');
  if (!fence) return null;
  let parsed;
  try {
    parsed = JSON.parse(fence[1].trim());
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null;
  const norm = normalizeRelPath(parsed.path);
  if (!norm.ok || !isWritablePath(norm.path)) return null;
  const content = typeof parsed.content === 'string' ? parsed.content : null;
  if (content === null) return null;
  if (content.length > FILE_CONTENT_LIMIT) return null;
  const baseHash =
    typeof parsed.baseHash === 'string' && parsed.baseHash.length <= 100 ? parsed.baseHash : null;
  return { path: norm.path, content, baseHash };
}

/**
 * 解析 ```vault-read 读取请求块：{"path": "materials/x.md"}
 * 只校验结构（读可达授权目录内任意位置），不可写目录也允许读。
 */
export function parseVaultReadBlock(text) {
  const fence = matchFence(text, 'vault-read');
  if (!fence) return null;
  let parsed;
  try {
    parsed = JSON.parse(fence[1].trim());
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== 'object') return null;
  const norm = normalizeRelPath(parsed.path);
  return norm.ok ? norm.path : null;
}

/**
 * 写入确认队列：AI 的每个 file 提议都要经过用户逐次确认。
 * UI 循环 take() → 展示弹窗 → settle(approved) → 再 take()。
 */
export function createConfirmQueue() {
  const pending = [];
  let current = null;
  let waiter = null;

  return {
    push(item) {
      if (waiter) {
        const w = waiter;
        waiter = null;
        current = item;
        w(item);
      } else {
        pending.push(item);
      }
    },
    /** 取下一个待确认项；当前项未处理完会 reject；无排队项则挂起等待 push */
    take() {
      if (current) return Promise.reject(new Error('当前项尚未处理'));
      if (pending.length) {
        current = pending.shift();
        return Promise.resolve(current);
      }
      return new Promise((resolve) => {
        waiter = resolve;
      });
    },
    /** 处理当前项，返回处理结果与剩余数量 */
    settle(approved) {
      const item = current;
      current = null;
      return { item, approved: !!approved, remaining: pending.length };
    },
    size() {
      return pending.length + (current ? 1 : 0);
    },
    current() {
      return current;
    },
  };
}

/**
 * 目录清单 → 提示词里的目录树文本。
 * @param {Array<{path: string, isDir: boolean}>} entries 相对路径清单
 * @param {{max?: number}} [opts]
 */
export function formatVaultTree(entries, opts = {}) {
  const max = Number.isInteger(opts.max) && opts.max > 0 ? opts.max : 80;
  const list = Array.isArray(entries) ? [...entries] : [];
  list.sort((a, b) => {
    if (!!b.isDir !== !!a.isDir) return b.isDir - a.isDir;
    return String(a.path).localeCompare(String(b.path));
  });
  const lines = list.slice(0, max).map((e) => (e.isDir ? `${e.path}/` : e.path));
  if (list.length > max) lines.push(`…另有 ${list.length - max} 项`);
  return lines.join('\n');
}
