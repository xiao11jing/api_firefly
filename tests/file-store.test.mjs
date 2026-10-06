import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  KV_DIR,
  MEDIA_DIR,
  STORAGE_DIR,
  createFileSplashStore,
  createFileStore,
  isDesktop,
} from '../js/file-store.js';
import { STORAGE_KEY, defaultState, loadState, saveState } from '../js/storage.js';
import { LEARN_STORAGE_KEY, createLearnStore, createLearnState } from '../js/learn/learn-store.js';

/** 内存假文件系统：与 file-store 依赖的 fs 适配接口一致，并记录调用 */
function fakeFs(initialFiles = {}) {
  const files = new Map(Object.entries(initialFiles));
  const dirs = new Set();
  const calls = [];
  const api = {
    calls,
    files,
    dirs,
    async exists(p) {
      calls.push(['exists', p]);
      return files.has(p) || dirs.has(p);
    },
    async mkdir(p) {
      calls.push(['mkdir', p]);
      dirs.add(p);
    },
    async readDir(p) {
      calls.push(['readDir', p]);
      const out = [];
      for (const k of files.keys()) {
        if (k.startsWith(p + '/')) out.push({ name: k.slice(p.length + 1), isDirectory: false });
      }
      for (const d of dirs) {
        if (d !== p && d.startsWith(p + '/')) out.push({ name: d.slice(p.length + 1), isDirectory: true });
      }
      return out;
    },
    async readText(p) {
      calls.push(['readText', p]);
      if (!files.has(p)) throw new Error('ENOENT ' + p);
      return files.get(p);
    },
    async writeText(p, d) {
      calls.push(['writeText', p, d]);
      files.set(p, d);
    },
    async readBin(p) {
      calls.push(['readBin', p]);
      if (!files.has(p)) throw new Error('ENOENT ' + p);
      return files.get(p);
    },
    async writeBin(p, d) {
      calls.push(['writeBin', p, d]);
      files.set(p, d);
    },
    async rename(from, to) {
      calls.push(['rename', from, to]);
      if (!files.has(from)) throw new Error('ENOENT rename ' + from);
      files.set(to, files.get(from));
      files.delete(from);
    },
    async remove(p) {
      calls.push(['remove', p]);
      files.delete(p);
      dirs.delete(p);
    },
  };
  return api;
}

test('isDesktop：识别 Tauri 注入的 internals', () => {
  assert.equal(isDesktop({ __TAURI_INTERNALS__: { invoke() {} } }), true);
  assert.equal(isDesktop({ __TAURI__: {} }), true);
  assert.equal(isDesktop({}), false);
  assert.equal(isDesktop(null), false);
});

test('hydrate：读入状态文件，忽略非 json，清理残留 tmp', async () => {
  const fs = fakeFs({
    [`${STORAGE_DIR}/ai-multi-chat-v1.json`]: '{"a":1}',
    [`${STORAGE_DIR}/notes.bin`]: 'x',
    [`${STORAGE_DIR}/half.json.tmp`]: 'partial',
  });
  const store = await createFileStore({ fs });
  await store.hydrate();
  assert.equal(store.getItem('ai-multi-chat-v1'), '{"a":1}');
  assert.equal(store.getItem('missing-key'), null);
  assert.ok(!fs.files.has(`${STORAGE_DIR}/half.json.tmp`), '残留 tmp 应被清理');
  assert.ok(fs.files.has(`${STORAGE_DIR}/notes.bin`), '非 json 文件保留原样');
  assert.equal(store.getItem('notes.bin'), null, '但不进缓存');
});

test('hydrate：目录读取失败不阻塞启动', async () => {
  const fs = fakeFs();
  fs.readDir = async () => {
    throw new Error('permission denied');
  };
  const store = await createFileStore({ fs });
  await store.hydrate();
  assert.equal(store.getItem('k'), null);
});

test('setItem：缓存同步可见，落盘为 tmp+rename 原子写', async () => {
  const fs = fakeFs();
  const store = await createFileStore({ fs });
  await store.hydrate();
  store.setItem('k1', '{"x":2}');
  assert.equal(store.getItem('k1'), '{"x":2}', '缓存必须同步更新');
  await store.flush();
  const writes = fs.calls.filter((c) => c[0] === 'writeText').map((c) => c[1]);
  const renames = fs.calls.filter((c) => c[0] === 'rename').map((c) => c.slice(1));
  assert.deepEqual(writes, [`${STORAGE_DIR}/k1.json.tmp`]);
  assert.deepEqual(renames, [[`${STORAGE_DIR}/k1.json.tmp`, `${STORAGE_DIR}/k1.json`]]);
  assert.equal(fs.files.get(`${STORAGE_DIR}/k1.json`), '{"x":2}');
  assert.ok(!fs.files.has(`${STORAGE_DIR}/k1.json.tmp`), 'rename 后不留 tmp');
});

test('setItem：写入失败走 onError 且不抛给调用方', async () => {
  const fs = fakeFs();
  fs.writeText = async () => {
    throw new Error('disk full');
  };
  const errs = [];
  const store = await createFileStore({ fs, onError: (e) => errs.push(e) });
  const p = store.setItem('k', 'v');
  await p; // 调用方 await 不应 reject
  await store.flush();
  assert.equal(errs.length, 1);
  assert.match(String(errs[0] && errs[0].message), /disk full/);
  assert.equal(store.getItem('k'), 'v', '失败时缓存仍保留最新值');
});

test('removeItem：清缓存并删文件', async () => {
  const fs = fakeFs({ [`${STORAGE_DIR}/k1.json`]: 'old' });
  const store = await createFileStore({ fs });
  await store.hydrate();
  assert.equal(store.getItem('k1'), 'old');
  store.removeItem('k1');
  await store.flush();
  assert.equal(store.getItem('k1'), null);
  assert.ok(!fs.files.has(`${STORAGE_DIR}/k1.json`));
});

test('非法存储键被拒绝（路径穿越防护）', async () => {
  const store = await createFileStore({ fs: fakeFs() });
  assert.throws(() => store.getItem('../evil'));
  assert.throws(() => store.setItem('a/b', 'x'));
  assert.throws(() => store.setItem('带中文', 'x'));
  assert.throws(() => store.removeItem('a/../../b'));
});

test('kv：文本读写、键名归一化、缺失返回 undefined', async () => {
  const fs = fakeFs();
  const store = await createFileStore({ fs });
  await store.hydrate();
  await store.kv.set('material:abc-1', '资料正文');
  assert.equal(await store.kv.get('material:abc-1'), '资料正文');
  assert.ok(fs.files.has(`${KV_DIR}/material_abc-1.txt`), '冒号归一为下划线');
  assert.equal(await store.kv.get('material:none'), undefined);
  await store.kv.del('material:abc-1');
  assert.equal(await store.kv.get('material:abc-1'), undefined);
});

test('media：二进制原子写与读取，缺失返回 null', async () => {
  const fs = fakeFs();
  const store = await createFileStore({ fs });
  await store.hydrate();
  await store.media.write('splash-user.mp4', new Uint8Array([1, 2, 3]));
  const back = await store.media.read('splash-user.mp4');
  assert.deepEqual([...back], [1, 2, 3]);
  assert.ok(fs.calls.some((c) => c[0] === 'writeBin' && c[1] === `${MEDIA_DIR}/splash-user.mp4.tmp`));
  assert.equal(await store.media.read('nope.bin'), null);
  await store.media.remove('splash-user.mp4');
  assert.equal(await store.media.read('splash-user.mp4'), null);
});

test('与 storage.js 集成：saveState 落盘后新实例可读回', async () => {
  const fs = fakeFs();
  const a = await createFileStore({ fs });
  await a.hydrate();
  const state = defaultState();
  state.settings.theme = 'light';
  saveState(a, state);
  await a.flush();

  const b = await createFileStore({ fs });
  await b.hydrate();
  const loaded = loadState(b);
  assert.equal(loaded.settings.theme, 'light');
  assert.ok(fs.files.has(`${STORAGE_DIR}/${STORAGE_KEY}.json`));
});

test('与 learn-store 集成：localStorage 注入走文件、大文本走 kv', async () => {
  const fs = fakeFs();
  const fileStore = await createFileStore({ fs });
  await fileStore.hydrate();
  const learn = createLearnStore('local', { localStorage: fileStore, kv: fileStore.kv });

  await learn.saveState({});
  await fileStore.flush();
  assert.ok(fs.files.has(`${STORAGE_DIR}/${LEARN_STORAGE_KEY}.json`));

  const fileStore2 = await createFileStore({ fs });
  await fileStore2.hydrate();
  const learn2 = createLearnStore('local', { localStorage: fileStore2, kv: fileStore2.kv });
  const loaded = await learn2.loadState();
  assert.deepEqual(loaded, createLearnState());

  await fileStore2.kv.set('review:r1', '复盘正文');
  await fileStore2.flush();
  assert.equal(await fileStore.kv.get('review:r1'), '复盘正文');
});

test('createFileSplashStore：保存/读回/换格式清旧/移除', async () => {
  const fs = fakeFs();
  const fileStore = await createFileStore({ fs });
  await fileStore.hydrate();
  const splash = createFileSplashStore(fileStore);

  const mp4 = {
    type: 'video/mp4',
    name: 'a.mp4',
    arrayBuffer: async () => new Uint8Array([9, 8, 7]).buffer,
  };
  await splash.save(mp4);
  const blob = await splash.load();
  assert.ok(blob instanceof Blob);
  assert.equal(blob.type, 'video/mp4');
  assert.deepEqual([...new Uint8Array(await blob.arrayBuffer())], [9, 8, 7]);

  // 换成 webm：旧 mp4 必须清掉，不留双份
  const webm = {
    type: 'video/webm',
    name: 'b.webm',
    arrayBuffer: async () => new Uint8Array([1]).buffer,
  };
  await splash.save(webm);
  const names = [...fs.files.keys()].filter((k) => k.includes('splash-user'));
  assert.deepEqual(names, [`${MEDIA_DIR}/splash-user.webm`]);

  await splash.remove();
  assert.equal(await splash.load(), null);
});
