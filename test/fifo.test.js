/*
 * test/fifo.test.js — FIFO 分配的純函式測試（不用資料庫）
 */
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { allocate, walkSort } = require('../src/fifo');

// 三批甘藍菜，已依入庫日排好（最舊在前）
const cabbage = [
  { batchId: 'B20260901-01', slotId: 'B-03-2', qty: 3, inDate: '2026-09-01' },
  { batchId: 'B20260910-01', slotId: 'A-01-3', qty: 8, inDate: '2026-09-10' },
  { batchId: 'B20260918-01', slotId: 'A-01-2', qty: 5, inDate: '2026-09-18' },
];

test('要 6 籠：先拿最舊那批 3 籠，再拿第二舊的 3 籠', () => {
  const r = allocate(cabbage, 6);
  assert.deepEqual(r.plan.map((p) => [p.slotId, p.qty]), [['B-03-2', 3], ['A-01-3', 3]]);
  assert.equal(r.shortage, 0);
});

test('要 20 籠：全部拿光，還差 4 籠', () => {
  const r = allocate(cabbage, 20);
  assert.equal(r.plan.reduce((a, p) => a + p.qty, 0), 16);
  assert.equal(r.shortage, 4);
});

test('同一張單兩項都是甘藍菜：第二項接著前一項剩下的拿', () => {
  const reserved = {};
  const a = allocate(cabbage, 4, reserved);
  const b = allocate(cabbage, 4, reserved);
  assert.deepEqual(a.plan.map((p) => [p.slotId, p.qty]), [['B-03-2', 3], ['A-01-3', 1]]);
  assert.deepEqual(b.plan.map((p) => [p.slotId, p.qty]), [['A-01-3', 4]]);
});

test('沒有庫存：什麼都不拿，全部算缺貨', () => {
  assert.deepEqual(allocate([], 5), { plan: [], shortage: 5 });
});

test('走路順序：A 庫 → B 庫，排由近到遠，層由下到上', () => {
  const info = {
    'A-01-2': { sortNo: 1, row: 1, level: 2 }, 'A-01-3': { sortNo: 1, row: 1, level: 3 },
    'A-05-1': { sortNo: 1, row: 5, level: 1 }, 'B-03-2': { sortNo: 2, row: 3, level: 2 },
  };
  const items = ['B-03-2', 'A-05-1', 'A-01-3', 'A-01-2'].map((slotId) => ({ slotId }));
  assert.deepEqual(walkSort(items, info).map((x) => x.slotId), ['A-01-2', 'A-01-3', 'A-05-1', 'B-03-2']);
});
