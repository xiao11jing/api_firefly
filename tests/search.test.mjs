import { test } from 'node:test';
import assert from 'node:assert/strict';
import { countOccurrences, normalizeQuery, searchSession, searchableText } from '../js/search.js';

test('normalizeQuery 去空白并转小写', () => {
  assert.equal(normalizeQuery('  Hello '), 'hello');
  assert.equal(normalizeQuery(''), '');
  assert.equal(normalizeQuery(null), '');
  assert.equal(normalizeQuery(undefined), '');
});

test('countOccurrences 不区分大小写且不重叠', () => {
  assert.equal(countOccurrences('abcABCabc', 'abc'), 3);
  assert.equal(countOccurrences('aaaa', 'aa'), 2);
  assert.equal(countOccurrences('你好你好', '你好'), 2);
  assert.equal(countOccurrences('abc', ''), 0);
  assert.equal(countOccurrences('', 'a'), 0);
  assert.equal(countOccurrences(null, 'a'), 0);
});

test('countOccurrences 按字面匹配，不做正则解析', () => {
  assert.equal(countOccurrences('a.c abc', 'a.c'), 1);
  assert.equal(countOccurrences('file(name)', '(name)'), 1);
});

test('searchableText 汇总正文、附件名与文档正文', () => {
  const text = searchableText({
    content: [
      { type: 'text', text: '看这个' },
      { type: 'image', name: 'a.png' },
      { type: 'file', name: 'notes.md', text: '纪要正文' },
    ],
  });
  assert.match(text, /看这个/);
  assert.match(text, /a\.png/);
  assert.match(text, /notes\.md/);
  assert.match(text, /纪要正文/);
  assert.equal(searchableText(null), '');
});

test('searchSession 统计命中总数与消息 id', () => {
  const session = {
    messages: [
      { id: 'm1', role: 'user', content: [{ type: 'text', text: 'Hello world' }] },
      { id: 'm2', role: 'assistant', content: [{ type: 'text', text: 'hello 再见' }] },
      { id: 'm3', role: 'assistant', content: [{ type: 'text', text: '无关内容' }] },
    ],
  };
  const r = searchSession(session, 'HELLO');
  assert.equal(r.query, 'hello');
  assert.equal(r.total, 2);
  assert.deepEqual(r.messageIds, ['m1', 'm2']);
});

test('searchSession 能搜到附件名与文档正文', () => {
  const session = {
    messages: [
      {
        id: 'm1',
        role: 'user',
        content: [
          { type: 'text', text: '先看附件' },
          { type: 'file', name: '设计稿.pdf', text: '关键结论：先做附件' },
        ],
      },
    ],
  };
  assert.equal(searchSession(session, '设计稿').total, 1);
  assert.equal(searchSession(session, '关键结论').total, 1);
});

test('searchSession 空查询与空会话返回空结果', () => {
  assert.deepEqual(searchSession({ messages: [] }, '   '), { query: '', total: 0, messageIds: [] });
  assert.deepEqual(searchSession(null, 'a'), { query: 'a', total: 0, messageIds: [] });
  assert.deepEqual(searchSession({}, 'a'), { query: 'a', total: 0, messageIds: [] });
});
