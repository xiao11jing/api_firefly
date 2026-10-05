import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  MAX_SPLASH_BYTES,
  createSplashStore,
  normalizeSplash,
  validateSplashFile,
} from '../js/splash.js';
import { defaultState, loadState, setSplash, STORAGE_KEY } from '../js/storage.js';

// ---------- 纯逻辑 ----------

test('validateSplashFile：非视频文件拒绝', () => {
  assert.equal(validateSplashFile(null).ok, false);
  assert.equal(validateSplashFile(null).code, 'type');
  assert.deepEqual(validateSplashFile({ type: 'image/png', size: 100 }), { ok: false, code: 'type' });
  assert.deepEqual(validateSplashFile({ type: '', size: 100 }), { ok: false, code: 'type' });
});

test('validateSplashFile：体积超限拒绝并回带原始大小', () => {
  const r = validateSplashFile({ type: 'video/mp4', size: MAX_SPLASH_BYTES + 1 });
  assert.equal(r.ok, false);
  assert.equal(r.code, 'size');
  assert.equal(r.size, MAX_SPLASH_BYTES + 1);
  // 边界值本身允许
  assert.deepEqual(validateSplashFile({ type: 'video/mp4', size: MAX_SPLASH_BYTES }), { ok: true });
  // 非法体积按超限处理，避免 NaN 溜进存储
  assert.equal(validateSplashFile({ type: 'video/webm', size: 'oops' }).code, 'size');
});

test('validateSplashFile：合法视频通过', () => {
  assert.deepEqual(validateSplashFile({ type: 'video/mp4', size: 1024 }), { ok: true });
  assert.deepEqual(validateSplashFile({ type: 'video/webm', size: 0 }), { ok: true });
});

test('normalizeSplash：合法元数据归一化', () => {
  const m = normalizeSplash({ name: ' intro.mp4 ', size: 1234.6, savedAt: 1700000000000 });
  assert.equal(m.name, 'intro.mp4');
  assert.equal(m.size, 1235);
  assert.equal(m.savedAt, 1700000000000);
});

test('normalizeSplash：缺失或非法字段回退', () => {
  assert.equal(normalizeSplash(null), null);
  assert.equal(normalizeSplash('x'), null);
  assert.equal(normalizeSplash({}), null);
  assert.equal(normalizeSplash({ name: '   ' }), null);
  // 体积非法回退 0，时间非法取当前时间
  const m = normalizeSplash({ name: 'a.mp4', size: -5, savedAt: 'bad' });
  assert.equal(m.size, 0);
  assert.ok(m.savedAt > 0);
});

test('normalizeSplash：文件名截断到 200 字符', () => {
  const m = normalizeSplash({ name: 'x'.repeat(500), size: 1 });
  assert.equal(m.name.length, 200);
});

// ---------- storage 集成 ----------

test('setSplash 写入并可经存取往返', () => {
  const state = defaultState();
  setSplash(state, { name: 'intro.mp4', size: 2048, savedAt: 1700000000000 });
  assert.equal(state.settings.splash.name, 'intro.mp4');
  const st = {
    getItem: () => JSON.stringify(state),
    setItem: () => {},
    removeItem: () => {},
  };
  const loaded = loadState(st);
  assert.deepEqual(loaded.settings.splash, state.settings.splash);
});

test('setSplash(null) 关闭开屏动画', () => {
  const state = defaultState();
  setSplash(state, { name: 'a.mp4', size: 1 });
  setSplash(state, null);
  assert.equal(state.settings.splash, null);
});

test('历史数据里的非法 splash 被归一化清掉', () => {
  const st = {
    getItem: () => JSON.stringify({ settings: { splash: { name: '', size: 'x' } } }),
    setItem: () => {},
  };
  assert.equal(loadState(st).settings.splash, null);
});

// ---------- IndexedDB 存取（最小 fake） ----------

/** 覆盖驱动用到的最小 IndexedDB 面：open/upgrade/transaction/request/complete */
function makeFakeIndexedDB({ failPut = false } = {}) {
  const data = new Map();
  const stores = new Set();
  function makeStore(tx) {
    return {
      put(value, key) {
        const req = { onsuccess: null, onerror: null, result: undefined };
        queueMicrotask(() => {
          if (failPut) {
            tx.error = new Error('put failed');
            if (tx.onabort) tx.onabort();
            return;
          }
          data.set(key, value);
          req.result = key;
          if (req.onsuccess) req.onsuccess({ target: req });
          queueMicrotask(() => tx.oncomplete && tx.oncomplete());
        });
        return req;
      },
      get(key) {
        const req = { onsuccess: null, onerror: null, result: undefined };
        queueMicrotask(() => {
          req.result = data.has(key) ? data.get(key) : undefined;
          if (req.onsuccess) req.onsuccess({ target: req });
          queueMicrotask(() => tx.oncomplete && tx.oncomplete());
        });
        return req;
      },
      delete(key) {
        const req = { onsuccess: null, onerror: null, result: undefined };
        queueMicrotask(() => {
          data.delete(key);
          req.result = undefined;
          if (req.onsuccess) req.onsuccess({ target: req });
          queueMicrotask(() => tx.oncomplete && tx.oncomplete());
        });
        return req;
      },
    };
  }
  return {
    _data: data,
    open() {
      const req = { onupgradeneeded: null, onsuccess: null, onerror: null, result: null, error: null };
      queueMicrotask(() => {
        const fresh = stores.size === 0;
        const db = {
          objectStoreNames: { contains: (n) => stores.has(n) },
          createObjectStore: (n) => stores.add(n),
          close() {},
          transaction(name) {
            if (!stores.has(name)) throw new Error('NotFoundError');
            const tx = {
              oncomplete: null,
              onerror: null,
              onabort: null,
              error: null,
              objectStore: () => makeStore(tx),
            };
            return tx;
          },
        };
        req.result = db;
        if (fresh && req.onupgradeneeded) req.onupgradeneeded({ target: req });
        if (req.onsuccess) req.onsuccess({ target: req });
      });
      return req;
    },
  };
}

test('createSplashStore：保存/读取/删除往返', async () => {
  const store = createSplashStore(makeFakeIndexedDB());
  assert.equal(await store.load(), null); // 未保存过

  const video = { name: 'intro.webm', type: 'video/webm', size: 99, bytes: [1, 2, 3] };
  await store.save(video);
  const loaded = await store.load();
  assert.deepEqual(loaded, video);

  await store.remove();
  assert.equal(await store.load(), null);
});

test('createSplashStore：保存失败向上抛出', async () => {
  const store = createSplashStore(makeFakeIndexedDB({ failPut: true }));
  await assert.rejects(() => store.save({ name: 'a.mp4', type: 'video/mp4', size: 1 }));
});

test('createSplashStore：IndexedDB 不可用时 save 抛错、load 返回 null、remove 静默', async () => {
  const store = createSplashStore(null);
  await assert.rejects(() => store.save({ name: 'a.mp4', type: 'video/mp4', size: 1 }));
  assert.equal(await store.load(), null);
  await store.remove(); // 不抛
});

test('save 后再次 save 覆盖旧视频', async () => {
  const idb = makeFakeIndexedDB();
  const store = createSplashStore(idb);
  await store.save({ name: 'old.mp4', type: 'video/mp4', size: 1 });
  await store.save({ name: 'new.mp4', type: 'video/mp4', size: 2 });
  assert.equal((await store.load()).name, 'new.mp4');
});

// 存储键与 index.html 两个内联脚本（主题预设、开屏判定）读取的字面量保持一致
test('STORAGE_KEY 与内联脚本约定一致', () => {
  assert.equal(STORAGE_KEY, 'ai-multi-chat-v1');
});
