/**
 * file-store.js —— 桌面版（Tauri）文件存储适配层
 *
 * 形态：
 *  - Storage 兼容接口（getItem/setItem/removeItem：同步读缓存 + 异步原子落盘），
 *    可直接传给 storage.js 的 loadState/saveState 与 createLearnStore 的 localStorage 注入；
 *  - kv：大文本键值（Learn 资料/复盘正文），替代浏览器 IndexedDB；
 *  - media：二进制文件（自定义开屏视频等）。
 *
 * 落盘位置：应用数据目录（Linux 为 ~/.local/share/com.firefly.aimultichat/）：
 *   storage/<key>.json      状态 JSON（主状态 / 学习状态）
 *   learn-kv/<safeKey>.txt  资料文本、复盘正文
 *   media/<name>            二进制媒体
 * 原子写：先写 <path>.tmp 再 rename，写一半断电也不会损坏已有状态文件。
 *
 * 文件操作默认走官方 @tauri-apps/plugin-fs（vendor 到 js/vendor/tauri/，
 * 由 index.html 的 import map 解析）；测试注入假 fs 即可在 node 下验证全部逻辑。
 * 网页版与自动化测试继续用 localStorage —— main.js 按 isDesktop() 选择。
 */

export const STORAGE_DIR = 'storage';
export const KV_DIR = 'learn-kv';
export const MEDIA_DIR = 'media';

/** 状态键必须是文件安全字符（应用内常量，不接受外部输入） */
const KEY_RE = /^[A-Za-z0-9._-]+$/;
/** kv 键允许任意字符，落到文件名时归一化 */
const UNSAFE_RE = /[^A-Za-z0-9._-]/g;

export function isDesktop(globalObj = globalThis) {
  return !!(globalObj && (globalObj.__TAURI_INTERNALS__ || globalObj.__TAURI__));
}

function assertKey(key) {
  if (typeof key !== 'string' || !KEY_RE.test(key)) {
    throw new Error(`非法存储键：${String(key)}`);
  }
}

function safeName(key) {
  return String(key).replace(UNSAFE_RE, '_');
}

function entryName(entry) {
  if (!entry) return '';
  if (entry.name) return String(entry.name);
  if (entry.path) return String(entry.path).split(/[/\\]/).pop() || '';
  return '';
}

/** 默认文件系统适配：官方 plugin-fs（仅在 Tauri 运行时动态加载） */
async function defaultFs() {
  const {
    BaseDirectory,
    exists,
    mkdir,
    readFile,
    readDir,
    readTextFile,
    remove,
    rename,
    writeFile,
    writeTextFile,
  } = await import('@tauri-apps/plugin-fs');
  const APP = { baseDir: BaseDirectory.AppData };
  return {
    exists: (path) => exists(path, APP),
    mkdir: (path) => mkdir(path, { baseDir: BaseDirectory.AppData, recursive: true }),
    readDir: (path) => readDir(path, APP),
    readText: (path) => readTextFile(path, APP),
    writeText: (path, data) => writeTextFile(path, data, APP),
    readBin: (path) => readFile(path, APP),
    writeBin: (path, data) => writeFile(path, data, APP),
    rename: (from, to) =>
      rename(from, to, {
        oldPathBaseDir: BaseDirectory.AppData,
        newPathBaseDir: BaseDirectory.AppData,
      }),
    remove: (path) =>
      remove(path, { baseDir: BaseDirectory.AppData, recursive: true, ignoreNotFound: true }),
  };
}

/**
 * 创建文件存储。
 * @param {{fs?: object, onError?: (err: unknown) => void}} [deps] fs 注入（测试）；onError 也可建好后赋 store.onError
 */
export async function createFileStore(deps = {}) {
  const fs = deps.fs || (await defaultFs());
  /** @type {Map<string, string>} 状态键 → JSON 文本（hydrate 后与磁盘同步） */
  const cache = new Map();
  /** 在途写入，flush() 等待用 */
  const inflight = new Set();

  const store = {
    onError: typeof deps.onError === 'function' ? deps.onError : null,

    getItem(key) {
      assertKey(key);
      return cache.has(key) ? cache.get(key) : null;
    },

    /** 同步更新缓存，立即异步落盘；失败经 onError 上报，不打断调用方 */
    setItem(key, value) {
      assertKey(key);
      const text = String(value);
      cache.set(key, text);
      return track(writeAtomic(`${STORAGE_DIR}/${key}.json`, (tmp) => fs.writeText(tmp, text)));
    },

    removeItem(key) {
      assertKey(key);
      cache.delete(key);
      return track(
        fs.remove(`${STORAGE_DIR}/${key}.json`).catch((err) => {
          report(err);
        })
      );
    },

    /** 读取 storage/ 目录下全部状态文件进缓存；容忍空目录与单文件损坏 */
    async hydrate() {
      await ensureDir(STORAGE_DIR);
      let entries = [];
      try {
        entries = (await fs.readDir(STORAGE_DIR)) || [];
      } catch {
        entries = [];
      }
      for (const entry of entries) {
        const name = entryName(entry);
        if (!name) continue;
        if (name.endsWith('.tmp')) {
          // 上次写入中断留下的残留，尽力清掉
          await fs.remove(`${STORAGE_DIR}/${name}`).catch(() => {});
          continue;
        }
        if (!name.endsWith('.json')) continue;
        const key = name.slice(0, -5);
        if (!KEY_RE.test(key)) continue;
        try {
          cache.set(key, await fs.readText(`${STORAGE_DIR}/${key}.json`));
        } catch {
          /* 单个文件读失败不阻塞启动 */
        }
      }
      return store;
    },

    /** 等待全部在途写入完成（测试收尾 / 退出前调用） */
    async flush() {
      let rounds = 0;
      while (inflight.size && rounds++ < 500) {
        await Promise.allSettled([...inflight]);
      }
    },

    /** Learn 大文本键值（接口对齐 createIdbKv：get/set/del） */
    kv: {
      async get(key) {
        const path = `${KV_DIR}/${safeName(key)}.txt`;
        try {
          if (!(await fs.exists(path))) return undefined;
          return await fs.readText(path);
        } catch {
          return undefined;
        }
      },
      async set(key, value) {
        await ensureDir(KV_DIR);
        const text = String(value == null ? '' : value);
        await writeAtomic(`${KV_DIR}/${safeName(key)}.txt`, (tmp) => fs.writeText(tmp, text));
      },
      async del(key) {
        await fs.remove(`${KV_DIR}/${safeName(key)}.txt`).catch(() => {});
      },
    },

    /** 二进制媒体（自定义开屏视频等） */
    media: {
      async read(name) {
        const path = `${MEDIA_DIR}/${safeName(name)}`;
        try {
          if (!(await fs.exists(path))) return null;
          return await fs.readBin(path);
        } catch {
          return null;
        }
      },
      async write(name, bytes) {
        await ensureDir(MEDIA_DIR);
        await writeAtomic(`${MEDIA_DIR}/${safeName(name)}`, (tmp) => fs.writeBin(tmp, bytes));
      },
      async remove(name) {
        await fs.remove(`${MEDIA_DIR}/${safeName(name)}`).catch(() => {});
      },
    },
  };

  function report(err) {
    if (typeof store.onError === 'function') store.onError(err);
    else console.error('file-store 写入失败', err);
  }

  function track(promise) {
    inflight.add(promise);
    const settled = promise.catch(report); // 吞掉 rejection，失败走 onError
    settled.then(
      () => inflight.delete(promise),
      () => inflight.delete(promise)
    );
    return settled;
  }

  async function ensureDir(dir) {
    if (await fs.exists(dir)) return;
    try {
      await fs.mkdir(dir);
    } catch (err) {
      // 并发创建或已存在都容忍
      if (!(await fs.exists(dir).catch(() => false))) throw err;
    }
  }

  async function writeAtomic(path, write) {
    const tmp = `${path}.tmp`;
    await write(tmp);
    await fs.rename(tmp, path);
  }

  return store;
}

/* ------------------------------------------------------------------ *
 * 开屏视频：文件版（接口对齐 splash.js 的 createSplashStore）
 * ------------------------------------------------------------------ */

const SPLASH_EXTS = ['mp4', 'webm', 'ogg', 'mov', 'm4v', 'bin'];
const EXT_MIME = {
  mp4: 'video/mp4',
  m4v: 'video/x-m4v',
  webm: 'video/webm',
  ogg: 'video/ogg',
  mov: 'video/quicktime',
  bin: 'application/octet-stream',
};

/**
 * @param {Awaited<ReturnType<typeof createFileStore>>} fileStore
 */
export function createFileSplashStore(fileStore) {
  const BASE = 'splash-user';

  async function clearAll() {
    for (const ext of SPLASH_EXTS) {
      await fileStore.media.remove(`${BASE}.${ext}`);
    }
  }

  return {
    async save(file) {
      const bytes = new Uint8Array(await file.arrayBuffer());
      await clearAll(); // 换扩展名不留旧文件
      let ext = Object.keys(EXT_MIME).find((k) => EXT_MIME[k] === file.type) || '';
      if (!ext || !SPLASH_EXTS.includes(ext)) {
        const m = /\.([a-z0-9]+)$/i.exec(String(file.name || ''));
        ext = m && SPLASH_EXTS.includes(m[1].toLowerCase()) ? m[1].toLowerCase() : 'bin';
      }
      await fileStore.media.write(`${BASE}.${ext}`, bytes);
    },

    async load() {
      for (const ext of SPLASH_EXTS) {
        const bytes = await fileStore.media.read(`${BASE}.${ext}`);
        if (bytes && bytes.length) {
          return new Blob([bytes], { type: EXT_MIME[ext] || 'application/octet-stream' });
        }
      }
      return null;
    },

    async remove() {
      await clearAll();
    },
  };
}
