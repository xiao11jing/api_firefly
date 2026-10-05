/**
 * splash.js — 开屏动画的纯逻辑与视频存取
 *
 * 视频体积远超 localStorage 约 5MB 的配额，所以二进制存 IndexedDB；
 * 元数据（文件名/大小）写进 settings.splash，供设置面板同步渲染。
 */

/** 视频体积上限 */
export const MAX_SPLASH_BYTES = 50 * 1024 * 1024;

const DB_NAME = 'ai-multi-chat-media';
const STORE_NAME = 'media';
const VIDEO_KEY = 'splash-video';

/**
 * 校验待保存的开屏视频。
 * 通过返回 { ok: true }；否则 code 为 type（非视频）/ size（超限），
 * size 错误附带原始体积供调用方格式化提示。
 */
export function validateSplashFile(file) {
  if (!file || !String(file.type || '').startsWith('video/')) {
    return { ok: false, code: 'type' };
  }
  const size = Number(file.size);
  if (!Number.isFinite(size) || size > MAX_SPLASH_BYTES) {
    return { ok: false, code: 'size', size };
  }
  return { ok: true };
}

/** 归一化开屏动画元数据；缺失或非法字段返回 null */
export function normalizeSplash(value) {
  if (!value || typeof value !== 'object') return null;
  const name = String(value.name || '').trim().slice(0, 200);
  if (!name) return null;
  const size = Number(value.size);
  const savedAt = Number(value.savedAt);
  return {
    name,
    size: Number.isFinite(size) && size > 0 ? Math.round(size) : 0,
    savedAt: Number.isFinite(savedAt) && savedAt > 0 ? savedAt : Date.now(),
  };
}

function openDb(idb) {
  return new Promise((resolve, reject) => {
    const req = idb.open(DB_NAME, 1);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(STORE_NAME)) db.createObjectStore(STORE_NAME);
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error || new Error('开屏视频存储打开失败'));
  });
}

/** 执行一次事务；onStore 返回请求，完成后带回 fallback（get 未命中时的缺省值） */
function runTx(idb, mode, onStore, fallback) {
  return openDb(idb).then(
    (db) =>
      new Promise((resolve, reject) => {
        let result = fallback;
        let settled = false;
        const close = () => {
          try {
            db.close();
          } catch {
            /* 关闭失败不影响结果 */
          }
        };
        const fail = (err) => {
          if (settled) return;
          settled = true;
          close();
          reject(err || new Error('开屏视频存取失败'));
        };
        let tx;
        let req;
        try {
          tx = db.transaction(STORE_NAME, mode);
          req = onStore(tx.objectStore(STORE_NAME));
          req.onsuccess = () => {
            result = req.result;
          };
        } catch (e) {
          fail(e);
          return;
        }
        tx.oncomplete = () => {
          if (settled) return;
          settled = true;
          close();
          resolve(result);
        };
        tx.onerror = () => fail(tx.error);
        tx.onabort = () => fail(tx.error);
      })
  );
}

/**
 * 视频存取。IndexedDB 不可用时（隐私模式等）：
 * save 抛错让调用方提示用户；load 返回 null 让开屏静默跳过；remove 视为已完成。
 */
export function createSplashStore(idb) {
  return {
    async save(file) {
      if (!idb) throw new Error('IndexedDB 不可用');
      await runTx(idb, 'readwrite', (store) => store.put(file, VIDEO_KEY), undefined);
    },
    async load() {
      if (!idb) return null;
      try {
        const blob = await runTx(idb, 'readonly', (store) => store.get(VIDEO_KEY), null);
        return blob || null;
      } catch {
        return null;
      }
    },
    async remove() {
      if (!idb) return;
      try {
        await runTx(idb, 'readwrite', (store) => store.delete(VIDEO_KEY), undefined);
      } catch {
        // 元数据已清除，残留的视频不会再被播放，下次保存会直接覆盖
      }
    },
  };
}
