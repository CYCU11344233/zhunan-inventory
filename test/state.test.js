/*
 * test/state.test.js — 讀取 API 的測試（GET /api/state、GET /api/movements）
 *
 * 用獨立的資料庫 zhunan_test_api（和 db.test.js 分開，兩個測試檔同時跑也不會互相干擾），
 * 灌 Demo 的假庫存，把伺服器開在隨機 port，真的打 API 看回來的東西對不對。
 */
process.env.TZ = 'Asia/Taipei';
process.env.DB_NAME = 'zhunan_test_api';   // 一定要在 require('../src/…') 之前設，連線池才會連到測試庫

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { initDatabase } = require('../db/init');
const { seed } = require('../db/seed');
const { pool } = require('../src/db');
const app = require('../src/server');

let server, base;

before(async () => {
  await initDatabase({ name: process.env.DB_NAME, reset: true });
  await seed({ dbName: process.env.DB_NAME, today: '2026-09-23' });
  server = app.listen(0);   // port 0 = 讓系統隨便挑一個沒人用的
  await new Promise((r) => server.once('listening', r));
  base = `http://localhost:${server.address().port}`;
});

after(async () => {
  server.close();
  await pool.end();
});

const get = async (path) => {
  const res = await fetch(base + path);
  return { status: res.status, body: await res.json() };
};

test('GET /api/state 回傳和 Demo 同名同欄位的資料', async () => {
  const { status, body } = await get('/api/state');
  assert.equal(status, 200);
  assert.match(body.today, /^\d{4}-\d{2}-\d{2}$/);
  assert.deepEqual(body.warehouses.map((w) => [w.code, w.rows, w.levels]), [['A', 6, 3], ['B', 6, 3]]);
  assert.equal(body.slots.length, 36);
  assert.deepEqual(body.slots[0], { id: 'A-01-1', wh: 'A', row: 1, level: 1 });
  assert.equal(body.products.length, 20);
  assert.deepEqual(body.products[0], { id: 1, name: '甘藍菜', shelfDays: 60, color: '#2e86c1' });
  assert.equal(body.allProducts.length, 20);
  assert.equal(body.batches.length, 26);
  assert.deepEqual(Object.keys(body.batches[0]).sort(), ['expireDate', 'id', 'inDate', 'productId']);
  assert.equal(body.stocks.length, 31);
  assert.equal(body.stocks.reduce((a, s) => a + s.qty, 0), 269);
  // 期初資料不能復原，所以一開始兩個按鈕都不能按
  assert.deepEqual(body.undo, { canUndo: false, undoLabel: null, canRedo: false, redoLabel: null });
});

test('已刪除的品項不在 products，但還在 allProducts', async () => {
  await pool.query("UPDATE product SET deleted_at = NOW() WHERE id = 20");
  const { body } = await get('/api/state');
  assert.equal(body.products.length, 19);
  assert.ok(!body.products.some((p) => p.id === 20));
  assert.deepEqual(body.allProducts.find((p) => p.id === 20).deleted, true);
  await pool.query("UPDATE product SET deleted_at = NULL WHERE id = 20");
});

test('復原 / 重做按鈕的狀態（§5.3 規則）', async () => {
  const [a1] = await pool.query("INSERT INTO action (label) VALUES ('入庫 甘藍菜 5 籠')");
  let { body } = await get('/api/state');
  assert.deepEqual(body.undo, { canUndo: true, undoLabel: '入庫 甘藍菜 5 籠', canRedo: false, redoLabel: null });

  await pool.query('UPDATE action SET undone = 1 WHERE id = ?', [a1.insertId]);   // 假裝被復原了
  ({ body } = await get('/api/state'));
  assert.deepEqual(body.undo, { canUndo: false, undoLabel: null, canRedo: true, redoLabel: '入庫 甘藍菜 5 籠' });

  await pool.query("INSERT INTO action (label) VALUES ('出庫 毛豆 3 籠')");       // 復原後又做了新動作 → 不能重做
  ({ body } = await get('/api/state'));
  assert.deepEqual(body.undo, { canUndo: true, undoLabel: '出庫 毛豆 3 籠', canRedo: false, redoLabel: null });
});

test('GET /api/movements：新的在前、欄位齊全、limit 有效', async () => {
  const { status, body } = await get('/api/movements?limit=5');
  assert.equal(status, 200);
  assert.equal(body.length, 5);
  assert.deepEqual(body[0], {
    id: 31, time: '2026-09-23 09:00', type: '入庫', productName: '芒果', batchId: 'B20260923-01',
    fromSlotId: null, toSlotId: 'B-02-1', qty: 10, note: '批次 B20260923-01', undone: false,
  });
  for (let i = 1; i < body.length; i++) assert.ok(body[i - 1].time >= body[i].time);
});

test('網頁本體和找不到的 API', async () => {
  const page = await fetch(base + '/');
  assert.equal(page.status, 200);
  assert.match(await page.text(), /<script src="app.js"><\/script>/);
  const { status, body } = await get('/api/nope');
  assert.equal(status, 404);
  assert.match(body.error, /沒有這個功能/);
});
