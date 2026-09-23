/*
 * test/api.test.js — 寫入 API 的流程測試（照使用者真正的操作順序，技術方案 §7）
 *
 * 用獨立的空資料庫 zhunan_test_flow（只有主檔、沒有庫存），每個測試接著上一個的結果做，
 * 就像李太太一天的工作：入庫 → 出庫 → 搬貨 → 盤點 → 丟棄 → 按錯了復原 → 管理品項。
 */
process.env.TZ = 'Asia/Taipei';
process.env.DB_NAME = 'zhunan_test_flow';

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { initDatabase } = require('../db/init');
const { pool } = require('../src/db');
const app = require('../src/server');

let server, base;

before(async () => {
  await initDatabase({ name: process.env.DB_NAME, reset: true });
  server = app.listen(0);
  await new Promise((r) => server.once('listening', r));
  base = `http://localhost:${server.address().port}`;
});
after(async () => { server.close(); await pool.end(); });

// 小工具
async function call(method, path, body) {
  const res = await fetch(base + path, {
    method, headers: { 'Content-Type': 'application/json' }, body: body ? JSON.stringify(body) : undefined,
  });
  return { status: res.status, body: await res.json() };
}
const post = (p, b) => call('POST', p, b);
const ok = async (p, b, method = 'POST') => {
  const r = await call(method, p, b);
  assert.equal(r.status, 200, `${p} 應該成功，但回了 ${r.status}：${JSON.stringify(r.body)}`);
  return r.body;
};
const state = async () => (await call('GET', '/api/state')).body;
const qtyAt = async (slotId) => ((await state()).stocks.find((s) => s.slotId === slotId) || { qty: 0 }).qty;
// 把批次改成指定入庫日（測 FIFO 需要「舊」的批次）
const setInDate = (slotId, date) => pool.query(
  'UPDATE batch b JOIN stock s ON s.batch_id = b.id SET b.in_date = ? WHERE s.slot_id = ?', [date, slotId]);

test('1. 入庫兩項 → 多兩批、兩格有貨、兩筆紀錄，回傳依走路順序', async () => {
  const r = await ok('/api/inbound', { items: [
    { productId: 1, qty: 5, slotId: 'B-02-1' },                              // 到期日沒給 → 依保存天數
    { productId: 5, qty: 3, slotId: 'A-03-2', expireDate: '2026-12-31' },    // 自訂到期日
  ] });
  assert.deepEqual(r.steps.map((s) => s.slotId), ['A-03-2', 'B-02-1']);
  const s = await state();
  assert.equal(s.batches.length, 2);
  assert.equal(await qtyAt('B-02-1'), 5);
  assert.equal(s.batches.find((b) => b.productId === 5).expireDate, '2026-12-31');
  assert.match(s.batches[0].id, /^B\d{8}-0[12]$/);
  const log = (await call('GET', '/api/movements')).body;
  assert.equal(log.length, 2);
  assert.ok(log.some((m) => m.note.includes('自訂到期 2026-12-31')));
  assert.deepEqual(s.undo, { canUndo: true, undoLabel: '入庫 甘藍菜 5 籠、毛豆 3 籠', canRedo: false, redoLabel: null });
});

test('2. 入庫的各種錯誤 → 400，而且什麼都沒寫進去', async () => {
  const cases = [
    [{ productId: 1, qty: 2, slotId: 'B-02-1' }, /B-02-1 已經有貨/],
    [{ productId: 1, qty: 0, slotId: 'A-01-1' }, /籠數/],
    [{ productId: 999, qty: 1, slotId: 'A-01-1' }, /找不到這個品項/],
    [{ productId: 1, qty: 1, slotId: 'Z-99-9' }, /沒有 Z-99-9/],
  ];
  for (const [item, msg] of cases) {
    const r = await post('/api/inbound', { items: [item] });
    assert.equal(r.status, 400);
    assert.match(r.body.error, msg);
  }
  const dup = await post('/api/inbound', { items: [{ productId: 1, qty: 1, slotId: 'A-01-1' }, { productId: 2, qty: 1, slotId: 'A-01-1' }] });
  assert.match(dup.body.error, /第 2 項：A-01-1 跟其他項重複/);
  assert.equal((await state()).batches.length, 2);
});

test('3. 出庫：跨批次 FIFO（最舊的先出），確認後庫存減少', async () => {
  // 再進兩批甘藍菜，然後把日期改成：A-01-1 最舊、B-02-1 中間、A-06-3 最新
  await ok('/api/inbound', { items: [{ productId: 1, qty: 4, slotId: 'A-01-1' }, { productId: 1, qty: 6, slotId: 'A-06-3' }] });
  await setInDate('A-01-1', '2026-08-01');
  await setInDate('B-02-1', '2026-08-15');

  const plan = await ok('/api/outbound/plan', { items: [{ productId: 1, qty: 7 }, { productId: 5, qty: 10 }] });
  // 甘藍菜 7 籠 = 最舊 A-01-1 的 4 籠 + 次舊 B-02-1 的 3 籠；毛豆只有 3 籠 → 缺 7 籠
  const got = Object.fromEntries(plan.plan.map((p) => [p.slotId, p.qty]));
  assert.deepEqual(got, { 'A-01-1': 4, 'B-02-1': 3, 'A-03-2': 3 });
  assert.deepEqual(plan.shortages, ['毛豆 差 7 籠']);
  assert.deepEqual(plan.plan.map((p) => p.slotId), ['A-01-1', 'A-03-2', 'B-02-1']);   // 走路順序
  assert.equal(await qtyAt('A-01-1'), 4, 'plan 不能改資料');

  await ok('/api/outbound/confirm', { plan: plan.plan });
  assert.equal(await qtyAt('A-01-1'), 0);
  assert.equal(await qtyAt('B-02-1'), 2);
  assert.equal(await qtyAt('A-03-2'), 0);
  // 同一張揀貨單再確認一次 → 庫存已經不夠
  const again = await post('/api/outbound/confirm', { plan: plan.plan });
  assert.equal(again.status, 400);
  assert.match(again.body.error, /庫存已經變了/);
});

test('4. 移位到空格、兩格互換', async () => {
  await ok('/api/transfer', { from: 'B-02-1', to: 'B-05-1' });
  assert.equal(await qtyAt('B-02-1'), 0);
  assert.equal(await qtyAt('B-05-1'), 2);
  const r = await ok('/api/transfer', { from: 'B-05-1', to: 'A-06-3' });   // A-06-3 有 6 籠
  assert.equal(r.swapped, true);
  assert.equal(await qtyAt('B-05-1'), 6);
  assert.equal(await qtyAt('A-06-3'), 2);
  assert.equal((await post('/api/transfer', { from: 'A-01-1', to: 'A-02-1' })).status, 400);   // 空格不能搬
});

test('5. 盤點 + 改到期日，復原後都回來', async () => {
  const s0 = await state();
  const stock = s0.stocks.find((x) => x.slotId === 'A-06-3');
  const oldExpire = s0.batches.find((b) => b.id === stock.batchId).expireDate;
  await ok('/api/adjust', { slotId: 'A-06-3', qty: 1, expireDate: '2027-01-01' });
  assert.equal(await qtyAt('A-06-3'), 1);
  assert.equal((await state()).batches.find((b) => b.id === stock.batchId).expireDate, '2027-01-01');
  await ok('/api/adjust', { slotId: 'A-06-3', qty: 3 });   // 盤點多出來
  assert.equal(await qtyAt('A-06-3'), 3);
  await ok('/api/undo');
  await ok('/api/undo');
  assert.equal(await qtyAt('A-06-3'), 2);
  assert.equal((await state()).batches.find((b) => b.id === stock.batchId).expireDate, oldExpire);
  await ok('/api/redo');
  await ok('/api/redo');
  assert.equal(await qtyAt('A-06-3'), 3);
});

test('6. 丟棄 → 空；復原 → 回來；重做 → 又空；復原後做新動作 → 不能重做', async () => {
  await ok('/api/discard', { slotId: 'B-05-1' });
  assert.equal(await qtyAt('B-05-1'), 0);
  await ok('/api/undo');
  assert.equal(await qtyAt('B-05-1'), 6);
  let log = (await call('GET', '/api/movements')).body;
  assert.equal(log[0].type, '復原');
  assert.equal(log.find((m) => m.type === '丟棄').undone, true);   // 原紀錄還在，只是標記已復原
  await ok('/api/redo');
  assert.equal(await qtyAt('B-05-1'), 0);
  await ok('/api/undo');
  await ok('/api/inbound', { items: [{ productId: 2, qty: 1, slotId: 'A-02-2' }] });   // 新動作
  const s = await state();
  assert.equal(s.undo.canRedo, false);
  assert.equal((await post('/api/redo')).status, 400);
  assert.equal(await qtyAt('B-05-1'), 6);
});

test('7. 復原「互換」：兩格都換回來', async () => {
  const a = await qtyAt('A-02-2'), b = await qtyAt('B-05-1');
  await ok('/api/transfer', { from: 'A-02-2', to: 'B-05-1' });
  assert.deepEqual([await qtyAt('A-02-2'), await qtyAt('B-05-1')], [b, a]);
  await ok('/api/undo');
  assert.deepEqual([await qtyAt('A-02-2'), await qtyAt('B-05-1')], [a, b]);
});

test('8. 品項：新增、重名、有庫存不能刪、名稱不符、刪除、復原', async () => {
  const add = await ok('/api/products', { name: '秋葵', shelfDays: 20, color: '#7cb342' });
  assert.ok((await state()).products.some((p) => p.name === '秋葵'));
  assert.match((await post('/api/products', { name: '秋葵', shelfDays: 20, color: '#7cb342' })).body.error, /已經有「秋葵」/);

  await ok(`/api/products/${add.id}`, { name: '黃秋葵', shelfDays: 25, color: '#7cb342' }, 'PUT');
  assert.equal((await state()).products.find((p) => p.id === add.id).name, '黃秋葵');

  const hasStock = await call('DELETE', '/api/products/2', { confirmName: '高麗菜' });
  assert.match(hasStock.body.error, /還有 \d+ 籠庫存/);
  const wrongName = await call('DELETE', '/api/products/20', { confirmName: '蕃茄' });
  assert.match(wrongName.body.error, /名稱不符/);

  await ok('/api/products/20', { confirmName: '番茄' }, 'DELETE');
  let s = await state();
  assert.ok(!s.products.some((p) => p.id === 20));
  assert.equal(s.allProducts.find((p) => p.id === 20).deleted, true);
  await ok('/api/undo');
  s = await state();
  assert.ok(s.products.some((p) => p.id === 20));

  // 復原「編輯」→ 名字回到秋葵；再復原「新增」→ 品項消失（軟刪除）
  await ok('/api/undo');
  assert.equal((await state()).products.find((p) => p.id === add.id).name, '秋葵');
  await ok('/api/undo');
  assert.ok(!(await state()).products.some((p) => p.id === add.id));
});

test('9. 帳永遠對得上：每格庫存 = 該格所有「有效」異動的加減總和', async () => {
  // 被復原的 action 不算；復原 / 重做本身沒有籠數
  const [rows] = await pool.query(`
    SELECT slot, SUM(delta) AS qty FROM (
      SELECT m.to_slot_id AS slot, m.qty AS delta FROM movement m JOIN action a ON a.id = m.action_id
        WHERE a.undone = 0 AND m.to_slot_id IS NOT NULL AND m.qty IS NOT NULL
      UNION ALL
      SELECT m.from_slot_id, -m.qty FROM movement m JOIN action a ON a.id = m.action_id
        WHERE a.undone = 0 AND m.from_slot_id IS NOT NULL AND m.qty IS NOT NULL
    ) t GROUP BY slot HAVING SUM(delta) <> 0`);
  const fromLog = Object.fromEntries(rows.map((r) => [r.slot, Number(r.qty)]));
  const [stock] = await pool.query('SELECT slot_id, SUM(qty) AS qty FROM stock GROUP BY slot_id HAVING SUM(qty) > 0');
  const fromStock = Object.fromEntries(stock.map((r) => [r.slot_id, Number(r.qty)]));
  assert.deepEqual(fromStock, fromLog);
});
