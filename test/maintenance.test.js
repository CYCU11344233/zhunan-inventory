/*
 * test/maintenance.test.js — 系統維護（驗收與維護.pdf）的測試
 *
 * 用獨立的資料庫 zhunan_test_maint，灌 Demo 那套假庫存，照簡報的順序測：
 *   NO1  揀貨單：發單 → 保留 → 回報才扣庫存；沒回報的一直看得到；取消、復原
 *        放貨單：發單 → 預定空格 → 放好回報才入庫（可改實際格子）；取消、復原
 *   NO2  盤點：一次盤一整座庫，全部正確也留紀錄；數量不符、壞掉要寫原因；可以復原
 *   劇本 維護驗收測試劇本 1～5 步，從頭到尾跑一次，最後帳要對得上
 */
process.env.TZ = 'Asia/Taipei';
process.env.DB_NAME = 'zhunan_test_maint';

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
const get = async (p) => (await call('GET', p)).body;
const ok = async (p, b) => {
  const r = await post(p, b);
  assert.equal(r.status, 200, `${p} 應該成功，但回了 ${r.status}：${JSON.stringify(r.body)}`);
  return r.body;
};
const fail = async (p, b, re) => {
  const r = await post(p, b);
  assert.equal(r.status, 400, `${p} 應該被擋下，但回了 ${r.status}：${JSON.stringify(r.body)}`);
  assert.match(r.body.error, re);
};
const state = () => get('/api/state');
const qtyAt = async (slotId) => ((await state()).stocks.find((s) => s.slotId === slotId) || { qty: 0 }).qty;
// 某品項的總籠數
async function totalOf(productId) {
  const s = await state();
  const ids = new Set(s.batches.filter((b) => b.productId === productId).map((b) => b.id));
  return s.stocks.filter((x) => ids.has(x.batchId)).reduce((a, x) => a + x.qty, 0);
}
// 某品項「最舊那批」在哪一格（直接問資料庫，不經過我們的程式）
async function oldestSlot(productId) {
  const [[r]] = await pool.query(
    `SELECT s.slot_id FROM stock s JOIN batch b ON b.id = s.batch_id
     WHERE b.product_id = ? AND s.qty > 0 ORDER BY b.in_date, b.id LIMIT 1`, [productId]);
  return r.slot_id;
}
// 某庫的一個空格（有貨的、被放貨單預定的都不算）
const emptySlot = async (wh) => {
  const s = await state();
  const taken = new Set([...s.stocks.map((x) => x.slotId), ...s.openPuts.flatMap((p) => p.lines.map((l) => l.slotId))]);
  return s.slots.find((x) => x.wh === wh && !taken.has(x.id)).id;
};
const movementCount = async () => (await get('/api/movements?limit=2000')).length;

/* ===================== NO1 揀貨單 ===================== */

let pick1;
test('NO1-1 發單：存進資料庫、庫存還沒扣、從最舊的那批拿', async () => {
  const oldest = await oldestSlot(1);
  const before = await totalOf(1);
  const r = await ok('/api/picks', { items: [{ productId: 1, qty: 2 }] });
  pick1 = r.pick;
  assert.equal(pick1.status, 'open');
  assert.equal(pick1.label, '出庫 甘藍菜 2 籠');
  assert.equal(pick1.lines[0].slotId, oldest, 'FIFO：第一站要是最舊的那批');
  assert.equal(await totalOf(1), before, '發單不能扣庫存，要回報才扣');
});

test('NO1-2 忘了回報：重新打開系統（重抓 state）還看得到這張單', async () => {
  const s = await state();
  assert.equal(s.openPicks.length, 1);
  assert.equal(s.openPicks[0].id, pick1.id);
  assert.deepEqual(s.openPicks[0].lines.map((l) => l.slotId), pick1.lines.map((l) => l.slotId));
  assert.equal((await get('/api/picks?status=open')).length, 1);
});

test('NO1-3 保留：別張單拿不到同一批貨，保留的格子不能移位、不能丟', async () => {
  const total = await totalOf(1);
  const plan = await ok('/api/outbound/plan', { items: [{ productId: 1, qty: total }] });
  assert.deepEqual(plan.shortages, ['甘藍菜 差 2 籠'], '已經開在揀貨單的 2 籠不能再分配');
  const slot = pick1.lines[0].slotId;
  await fail('/api/transfer', { from: slot, to: await emptySlot('B') }, /揀貨單 #\d+/);
  await fail('/api/discard', { slotId: slot }, /揀貨單 #\d+/);
});

test('NO1-4 回報：這時才扣庫存、寫出庫紀錄；同一張不能回報兩次', async () => {
  const slot = pick1.lines[0].slotId;
  const before = await qtyAt(slot);
  const r = await ok(`/api/picks/${pick1.id}/confirm`);
  assert.equal(r.status, 'done');
  assert.ok(r.finishedAt);
  assert.equal(await qtyAt(slot), before - pick1.lines[0].qty);
  assert.equal((await state()).openPicks.length, 0);
  const log = await get('/api/movements?limit=5');
  assert.equal(log[0].type, '出庫');
  assert.match(log[0].note, new RegExp(`揀貨單 #${pick1.id}`));
  await fail(`/api/picks/${pick1.id}/confirm`, undefined, /已經回報過/);
});

test('NO1-5 復原出庫 → 貨回來、單子回到「還沒回報」；重做 → 又完成', async () => {
  const slot = pick1.lines[0].slotId;
  const after = await qtyAt(slot);
  await ok('/api/undo');
  assert.equal(await qtyAt(slot), after + pick1.lines[0].qty);
  assert.equal((await get(`/api/picks/${pick1.id}`)).status, 'open');
  await ok('/api/redo');
  assert.equal(await qtyAt(slot), after);
  assert.equal((await get(`/api/picks/${pick1.id}`)).status, 'done');
});

test('NO1-6 取消：保留的貨放回來，庫存完全沒動', async () => {
  const before = await totalOf(2);
  const { pick } = await ok('/api/picks', { items: [{ productId: 2, qty: 1 }] });
  const total = await totalOf(2);
  assert.equal((await ok('/api/outbound/plan', { items: [{ productId: 2, qty: total }] })).shortages.length, 1);
  assert.equal((await ok(`/api/picks/${pick.id}/cancel`)).status, 'cancelled');
  assert.equal((await ok('/api/outbound/plan', { items: [{ productId: 2, qty: total }] })).shortages.length, 0);
  assert.equal(await totalOf(2), before);
  await fail(`/api/picks/${pick.id}/confirm`, undefined, /已經取消/);
});

test('NO1-7 舊的「確認出庫」網址也會留下一張已完成的揀貨單', async () => {
  const plan = await ok('/api/outbound/plan', { items: [{ productId: 3, qty: 1 }] });
  const r = await ok('/api/outbound/confirm', { plan: plan.plan });
  assert.equal((await get(`/api/picks/${r.pickId}`)).status, 'done');
});

test('NO1-8 發單的錯誤：沒填、籠數不對、沒庫存', async () => {
  await fail('/api/picks', { items: [] }, /請至少填一項/);
  await fail('/api/picks', { items: [{ productId: 1, qty: 0 }] }, /1 以上的整數/);
  const [[p]] = await pool.query(
    `SELECT p.id FROM product p WHERE p.deleted_at IS NULL AND NOT EXISTS (
       SELECT 1 FROM stock s JOIN batch b ON b.id = s.batch_id WHERE b.product_id = p.id AND s.qty > 0) LIMIT 1`);
  if (p) await fail('/api/picks', { items: [{ productId: p.id, qty: 1 }] }, /沒有可以拿的庫存/);
});

/* ===================== NO1 放貨單（進貨） ===================== */

let put1;
test('NO1-9 放貨單發單：庫存還沒動、預定的空格別人不能用', async () => {
  const [s1, s2] = [await emptySlot('A'), await emptySlot('B')];
  const before = await totalOf(1);
  put1 = await ok('/api/puts', { items: [{ productId: 1, qty: 2, slotId: s2 }, { productId: 5, qty: 3, slotId: s1 }] });
  assert.equal(put1.status, 'open');
  assert.equal(put1.label, '入庫 甘藍菜 2 籠、毛豆 3 籠');
  assert.deepEqual(put1.lines.map((l) => l.slotId), [s1, s2], '依走路順序：A 庫先');
  assert.equal(await totalOf(1), before, '發單不能加庫存，要放好回報才加');
  const s = await state();
  assert.equal(s.openPuts.length, 1);
  assert.equal(s.pendingWarnMinutes, 30);
  // 預定的空格：別張放貨單、舊的一步入庫、移位都不能用
  await fail('/api/puts', { items: [{ productId: 2, qty: 1, slotId: s1 }] }, new RegExp(`被放貨單 #${put1.id} 預定`));
  await fail('/api/inbound', { items: [{ productId: 2, qty: 1, slotId: s1 }] }, /預定/);
  const freeFrom = s.stocks.find((x) => !s.openPicks.some((p) => p.lines.some((l) => l.slotId === x.slotId))).slotId;
  await fail('/api/transfer', { from: freeFrom, to: s1 }, /預定/);
});

test('NO1-10 放貨單回報：這時才建批次入庫；放到別格要告訴系統實際哪一格', async () => {
  const s = await state();
  const alt = await emptySlot('B');   // 現場放到另一個空格
  // 實際放的格子已經有貨 → 擋下
  await fail(`/api/puts/${put1.id}/confirm`, { placements: [{ seq: 2, slotId: s.stocks[0].slotId }] }, /已經有貨/);
  const r = await ok(`/api/puts/${put1.id}/confirm`, { placements: [{ seq: 2, slotId: alt }] });
  assert.equal(r.status, 'done');
  assert.equal(r.lines[1].placedSlotId, alt);
  assert.match(r.lines[1].batchId, /^B\d{8}-\d{2}$/);
  assert.equal(await qtyAt(alt), put1.lines[1].qty);
  assert.equal(await qtyAt(put1.lines[1].slotId), 0, '原定的格子沒放貨');
  assert.equal(await qtyAt(put1.lines[0].slotId), put1.lines[0].qty);
  const log = await get('/api/movements?limit=2');
  assert.ok(log.some((m) => m.note.includes(`原定 ${put1.lines[1].slotId}，實際放 ${alt}`)));
  assert.ok(log.every((m) => m.note.includes(`放貨單 #${put1.id}`)));
  assert.equal((await state()).openPuts.length, 0);
  await fail(`/api/puts/${put1.id}/confirm`, undefined, /已經回報過/);
});

test('NO1-11 復原入庫 → 貨退掉、放貨單回到還沒回報；重做 → 又完成', async () => {
  const slot = put1.lines[0].slotId;
  await ok('/api/undo');
  assert.equal(await qtyAt(slot), 0);
  assert.equal((await get(`/api/puts/${put1.id}`)).status, 'open');
  await ok('/api/redo');
  assert.equal(await qtyAt(slot), put1.lines[0].qty);
  assert.equal((await get(`/api/puts/${put1.id}`)).status, 'done');
});

test('NO1-12 取消放貨單：預定的空格放回來；錯誤檢查', async () => {
  const slot = await emptySlot('A');
  const p = await ok('/api/puts', { items: [{ productId: 3, qty: 1, slotId: slot }] });
  await fail('/api/puts', { items: [{ productId: 3, qty: 1, slotId: slot }] }, /預定/);
  assert.equal((await ok(`/api/puts/${p.id}/cancel`)).status, 'cancelled');
  const again = await ok('/api/puts', { items: [{ productId: 3, qty: 1, slotId: slot }] });
  await ok(`/api/puts/${again.id}/cancel`);
  await fail(`/api/puts/${p.id}/confirm`, undefined, /已經取消/);
  await fail('/api/puts', { items: [] }, /請至少填一項/);
  await fail('/api/puts', { items: [{ productId: 3, qty: 1, slotId: 'Z-99-9' }] }, /沒有 Z-99-9/);
  await fail(`/api/puts/${again.id}/confirm`, { placements: [{ seq: 9, slotId: slot }] }, /已經取消/);
});

/* ===================== NO2 盤點 ===================== */

test('NO2-1 錯誤檢查：沒選庫、不是這座庫的格子、壞掉沒寫原因、壞的比點到的多', async () => {
  const s = await state();
  const aSlot = s.stocks.find((x) => x.slotId.startsWith('A')).slotId;
  const bSlot = s.stocks.find((x) => x.slotId.startsWith('B')).slotId;
  const n = await movementCount();
  await fail('/api/stocktakes', { warehouse: 'Z' }, /請選要盤點哪一座倉庫/);
  await fail('/api/stocktakes', { warehouse: 'A', counts: [{ slotId: bSlot, counted: 1 }] }, /不是 A 庫有貨的格子/);
  await fail('/api/stocktakes', { warehouse: 'A', counts: [{ slotId: aSlot, counted: 3, spoiled: 1 }] }, /請寫原因/);
  await fail('/api/stocktakes', { warehouse: 'A', counts: [{ slotId: aSlot, counted: 1, spoiled: 2, reason: '腐爛' }] }, /不能比點到的多/);
  await fail('/api/stocktakes', { warehouse: 'A', counts: [{ slotId: aSlot, counted: -1 }] }, /0 以上的整數/);
  assert.equal(await movementCount(), n, '被擋下的盤點不能寫進任何東西');
});

test('NO2-2 數量不符 → 寫盤點異動；按錯了可以復原', async () => {
  const slot = (await state()).stocks.find((x) => x.slotId.startsWith('B') && x.qty >= 3).slotId;
  const q = await qtyAt(slot);
  const r = await ok('/api/stocktakes', { warehouse: 'B', counts: [{ slotId: slot, counted: q - 1 }] });
  assert.equal(r.diffCount, 1);
  assert.equal(r.changed, true);
  assert.equal(await qtyAt(slot), q - 1);
  assert.match((await get('/api/movements?limit=1'))[0].note, new RegExp(`系統 ${q} → 實際 ${q - 1}`));
  await ok('/api/undo');
  assert.equal(await qtyAt(slot), q);
  assert.equal((await get('/api/stocktakes?warehouse=B'))[0].undone, true, '盤點紀錄還在，但標示已復原');
});

test('NO2-3 盤點後比揀貨單要拿的還少 → 提醒；那張單回報時會被擋', async () => {
  const slot = await oldestSlot(4);
  const wh = slot[0];
  const { pick } = await ok('/api/picks', { items: [{ productId: 4, qty: 1 }] });
  assert.equal(pick.lines[0].slotId, slot);
  const r = await ok('/api/stocktakes', { warehouse: wh, counts: [{ slotId: slot, counted: 0 }] });
  assert.equal(r.warnings.length, 1);
  assert.match(r.warnings[0], new RegExp(`揀貨單 #${pick.id}`));
  await fail(`/api/picks/${pick.id}/confirm`, undefined, /請取消這張單重新發單/);
  await ok(`/api/picks/${pick.id}/cancel`);
  await ok('/api/undo');   // 把盤點退回，不影響後面的測試
});

test('NO2-4 地圖上只丟一箱：可以只丟幾籠，並記下原因', async () => {
  const slot = (await state()).stocks.find((x) => x.qty >= 3).slotId;
  const q = await qtyAt(slot);
  const r = await ok('/api/discard', { slotId: slot, qty: 1, reason: '腐爛' });
  assert.equal(r.left, q - 1);
  assert.equal(await qtyAt(slot), q - 1);
  assert.match((await get('/api/movements?limit=1'))[0].note, /腐爛.*剩 \d+ 籠/);
  await fail('/api/discard', { slotId: slot, qty: q }, new RegExp(`只有 ${q - 1} 籠`));
  await ok('/api/undo');
  assert.equal(await qtyAt(slot), q);
});

/* ===================== 維護驗收測試劇本（簡報第 10 頁） ===================== */

test('劇本 1～5：列庫存 → 進貨 → 盤點倉庫 1（全對＋一箱腐爛）→ FIFO 出貨 → 列庫存', async () => {
  // 1. 列出兩座倉庫的庫存（記下來當「之前」）
  const beforeCabbage = await totalOf(1), beforeSpinach = await totalOf(18);

  // 2. 進貨兩箱甘藍菜，輸入儲位（發放貨單 → 放好回報），並記錄進貨時間
  const slot = await emptySlot('A');
  const put = await ok('/api/puts', { items: [{ productId: 1, qty: 2, slotId: slot }] });
  await ok(`/api/puts/${put.id}/confirm`);
  const inLog = (await get('/api/movements?limit=1'))[0];
  assert.equal(inLog.type, '入庫');
  assert.match(inLog.time, /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}$/, '進貨時間要記到幾點幾分');

  // 3a. 盤點倉庫 1（A 庫），庫存完全正確 → 也要留下「今天盤過了」的紀錄，不改任何庫存
  const n = await movementCount();
  const ok1 = await ok('/api/stocktakes', { warehouse: 'A', counts: [] });
  assert.equal(ok1.diffCount, 0);
  assert.equal(ok1.changed, false);
  assert.ok(ok1.slotCount > 0);
  assert.equal(await movementCount(), n, '全部正確不寫異動');
  assert.equal((await state()).lastStocktakes.A.id, ok1.id);

  // 3b. 但有一箱甘藍菜已經腐爛 → 盤點結果更新庫存，並記下原因
  const r = await ok('/api/stocktakes', { warehouse: 'A', counts: [{ slotId: slot, counted: 2, spoiled: 1, reason: '腐爛' }] });
  assert.equal(r.spoiledQty, 1);
  assert.equal(await qtyAt(slot), 1);
  const detail = await get(`/api/stocktakes/${r.id}`);
  assert.equal(detail.lines.find((l) => l.slotId === slot).reason, '腐爛');
  assert.match((await get('/api/movements?limit=1'))[0].note, /腐爛/);

  // 4. 賣一箱菠菜（簡報是青江菜，系統沒有，用菠菜代替）：系統指出最早進貨的那格，搬完回報
  const oldest = await oldestSlot(18);
  const { pick } = await ok('/api/picks', { items: [{ productId: 18, qty: 1 }] });
  assert.equal(pick.lines[0].slotId, oldest);
  await ok(`/api/picks/${pick.id}/confirm`);

  // 5. 再列一次：甘藍菜 +2 −1、菠菜 −1
  assert.equal(await totalOf(1), beforeCabbage + 1);
  assert.equal(await totalOf(18), beforeSpinach - 1);
});

/* ===================== 邊界情況（程式審查找到的） ===================== */

test('邊界 1：兩台平板同時發單搶同一批貨 → 只有一張拿得到，保留不會超過庫存', async () => {
  const total = await totalOf(6);
  const [a, b] = await Promise.all([
    post('/api/picks', { items: [{ productId: 6, qty: total }] }),
    post('/api/picks', { items: [{ productId: 6, qty: total }] }),
  ]);
  const okOnes = [a, b].filter((r) => r.status === 200);
  assert.equal(okOnes.length, 1, `只能有一張成功：${JSON.stringify([a.body, b.body])}`);
  assert.match([a, b].find((r) => r.status !== 200).body.error, /沒有可以拿的庫存/);
  await ok(`/api/picks/${okOnes[0].body.pick.id}/cancel`);
});

test('邊界 2：貨已經開在揀貨單上，不能復原「把貨搬過去」的動作', async () => {
  const s = await state();
  const held = new Set(s.openPicks.flatMap((p) => p.lines.map((l) => l.slotId)));
  const src = s.stocks.find((x) => x.slotId[0] === 'B' && !held.has(x.slotId));
  const to = await emptySlot('B');
  await ok('/api/transfer', { from: src.slotId, to });
  // 照「預覽過的那張」發單：直接給 lines
  const { pick } = await ok('/api/picks', { lines: [{ slotId: to, batchId: src.batchId, qty: 1 }] });
  assert.equal(pick.lines[0].slotId, to);
  await fail('/api/undo', undefined, new RegExp(`不能復原.*揀貨單 #${pick.id}`));
  assert.ok(await qtyAt(to) > 0, '被擋下時什麼都不能動');
  await ok(`/api/picks/${pick.id}/cancel`);
  await ok('/api/undo');   // 取消之後就可以復原了
  assert.equal(await qtyAt(to), 0);
});

test('邊界 3：出庫復原後又取消那張單 → 不能再重做', async () => {
  const { pick } = await ok('/api/picks', { items: [{ productId: 7, qty: 1 }] });
  await ok(`/api/picks/${pick.id}/confirm`);
  await ok('/api/undo');
  assert.equal((await get(`/api/picks/${pick.id}`)).status, 'open');
  await ok(`/api/picks/${pick.id}/cancel`);
  const s = await state();
  assert.notEqual(s.undo.redoLabel, pick.label, '取消的單不會出現在重做按鈕上');
  if (s.undo.canRedo) await ok('/api/redo');
  assert.equal((await get(`/api/picks/${pick.id}`)).status, 'cancelled', '取消的單不能被重做救回來');
});

test('邊界 4：放貨單復原後，原本的格子已經被別張放貨單預定 → 不能復原', async () => {
  const slot = await emptySlot('A');
  const p1 = await ok('/api/puts', { items: [{ productId: 8, qty: 1, slotId: slot }] });
  const alt = await emptySlot('B');
  await ok(`/api/puts/${p1.id}/confirm`, { placements: [{ seq: 1, slotId: alt }] });   // 實際放到別格
  const p2 = await ok('/api/puts', { items: [{ productId: 9, qty: 1, slotId: slot }] });   // 原定的格子被別人預定
  await fail('/api/undo', undefined, /不能復原.*預定/);
  await ok(`/api/puts/${p2.id}/cancel`);
  await ok('/api/undo');
  assert.equal((await get(`/api/puts/${p1.id}`)).status, 'open');
  await ok(`/api/puts/${p1.id}/cancel`);
});

test('邊界 5：地圖上改籠數改到比揀貨單要拿的還少 → 回傳提醒；有放貨單沒回報的品項不能刪', async () => {
  const { pick } = await ok('/api/picks', { items: [{ productId: 10, qty: 1 }] });
  const slot = pick.lines[0].slotId;
  const r = await ok('/api/adjust', { slotId: slot, qty: 0 });
  assert.match(r.warnings[0], new RegExp(`揀貨單 #${pick.id}`));
  await ok(`/api/picks/${pick.id}/cancel`);
  await ok('/api/undo');

  const add = await ok('/api/products', { name: '青江菜', shelfDays: 14, color: '#43a047' });
  const put = await ok('/api/puts', { items: [{ productId: add.id, qty: 2, slotId: await emptySlot('A') }] });
  const del = await call('DELETE', `/api/products/${add.id}`, { confirmName: '青江菜' });
  assert.equal(del.status, 400);
  assert.match(del.body.error, new RegExp(`放貨單 #${put.id}`));
  await ok(`/api/puts/${put.id}/cancel`);
});

test('邊界 6：盤點改少造成的保留不足，不會擋住無關的復原；重做停在取消的單，不跳過', async () => {
  // 先造成「揀貨單要拿的比現有的多」（改籠數是合法的，只會提醒）
  const { pick } = await ok('/api/picks', { items: [{ productId: 11, qty: 1 }] });
  await ok('/api/adjust', { slotId: pick.lines[0].slotId, qty: 0 });
  // 再做一個無關的移位，然後復原它 → 應該可以
  const s = await state();
  const held = new Set(s.openPicks.flatMap((p) => p.lines.map((l) => l.slotId)));
  const src = s.stocks.find((x) => !held.has(x.slotId) && x.slotId[0] === 'A').slotId;
  const to = await emptySlot('A');
  await ok('/api/transfer', { from: src, to });
  await ok('/api/undo');
  assert.ok(await qtyAt(src) > 0);
  await ok(`/api/picks/${pick.id}/cancel`);
  await ok('/api/undo');   // 退回改籠數

  // 出庫 A、之後移位 B；復原 B、復原 A、取消 A 的單 → 重做不能跳過 A 去做 B
  const { pick: pa } = await ok('/api/picks', { items: [{ productId: 12, qty: 1 }] });
  await ok(`/api/picks/${pa.id}/confirm`);
  const s2 = await state();
  const held2 = new Set(s2.openPicks.flatMap((p) => p.lines.map((l) => l.slotId)));
  const src2 = s2.stocks.find((x) => !held2.has(x.slotId)).slotId;
  await ok('/api/transfer', { from: src2, to: await emptySlot('B') });
  await ok('/api/undo');
  await ok('/api/undo');
  await ok(`/api/picks/${pa.id}/cancel`);
  assert.equal((await state()).undo.canRedo, false);
  await fail('/api/redo', undefined, /沒有可以重做的動作/);
});

test('帳永遠對得上：每格庫存 = 該格所有有效異動的加減；揀貨單保留的不會超過庫存', async () => {
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
  assert.deepEqual(Object.fromEntries(stock.map((r) => [r.slot_id, Number(r.qty)])), fromLog);

  const [over] = await pool.query(`
    SELECT pl.slot_id FROM pick_line pl JOIN pick_order po ON po.id = pl.pick_id AND po.status = 'open'
    JOIN stock s ON s.batch_id = pl.batch_id AND s.slot_id = pl.slot_id
    GROUP BY pl.batch_id, pl.slot_id, s.qty HAVING SUM(pl.qty) > s.qty`);
  assert.deepEqual(over, []);
});

test('效率統計：發單到回報的時間、盤點天數、差異與報廢都算得出來；超過 30 分鐘沒回報會被算成逾時', async () => {
  const { pick } = await ok('/api/picks', { items: [{ productId: 1, qty: 1 }] });
  await pool.query('UPDATE pick_order SET created_at = NOW() - INTERVAL 45 MINUTE WHERE id = ?', [pick.id]);
  const st = await get('/api/stats?days=7');
  assert.equal(st.days, 7);
  assert.ok(st.picks.done >= 3);
  assert.ok(st.puts.done >= 2);
  assert.equal(st.picks.overdue, 1);
  assert.equal(typeof st.picks.avgMinutes, 'number');
  assert.ok(st.stocktakes.A.count >= 2);
  assert.equal(st.stocktakes.A.daysCovered, 1);
  assert.ok(st.spoiled.qty >= 1, '劇本裡報廢了一箱');
  assert.ok(st.movements['入庫'].count >= 1);
  const s = await state();
  assert.ok(s.openPicks.find((p) => p.id === pick.id).minutes >= 45);
  await ok(`/api/picks/${pick.id}/cancel`);
});
