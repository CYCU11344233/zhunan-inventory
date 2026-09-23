/*
 * test/db.test.js — 資料庫建置的測試（npm test）
 *
 * 會在 MySQL 裡建一個獨立的 zhunan_test 資料庫來測，不會碰到正式的 zhunan。
 * 需要：MySQL 有開、.env 的帳密正確。
 *
 * 測什麼：
 *   1. schema.sql 建出 7 張表、2 座庫、36 格、20 種菜，中文沒有變問號
 *   2. schema.sql 重跑不會壞、不會重複塞主檔、不會動到庫存
 *   3. 資料庫的防呆：負庫存、不存在的櫃位、不存在的 action 都會被擋
 *   4. seed 的資料和 Demo 畫面上的一模一樣（直接跑 docs/demo/index.html 裡的程式來比）
 *   5. seed 第二次會拒絕、FIFO 那句 SQL 排出來的順序正確
 */
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

process.env.TZ = 'Asia/Taipei';   // 系統只在台灣用；固定時區，換到別台電腦跑測試結果也一樣
const { connect } = require('../src/db');
const { initDatabase } = require('../db/init');
const { seed, buildDemoData } = require('../db/seed');

const DB = 'zhunan_test';
const TODAY = '2026-09-23';   // 固定「今天」，測試結果才不會每天不一樣
let conn;

// 小工具：查詢並只回資料列
const q = async (sql, params) => (await conn.query(sql, params))[0];

before(async () => {
  await initDatabase({ name: DB, reset: true });
  conn = await connect({ database: DB });
});

after(async () => {
  if (conn) await conn.end();
});

test('1. 建出 7 張表與基本主檔', async () => {
  const tables = (await q('SHOW TABLES')).map((r) => Object.values(r)[0]).sort();
  assert.deepEqual(tables, ['action', 'batch', 'movement', 'product', 'slot', 'stock', 'warehouse']);

  assert.deepEqual(await q('SELECT code, name, rows_count, levels_count FROM warehouse ORDER BY sort_no'), [
    { code: 'A', name: 'A 庫', rows_count: 6, levels_count: 3 },
    { code: 'B', name: 'B 庫', rows_count: 6, levels_count: 3 },
  ]);

  const slots = await q('SELECT id, warehouse_code, row_no, level_no FROM slot ORDER BY warehouse_code, row_no, level_no');
  assert.equal(slots.length, 36);
  // 每一格的編號都要和它的庫、排、層對得上
  for (const s of slots) {
    assert.equal(s.id, `${s.warehouse_code}-${String(s.row_no).padStart(2, '0')}-${s.level_no}`);
  }

  const products = await q('SELECT id, name, shelf_days FROM product ORDER BY id');
  assert.equal(products.length, 20);
  assert.deepEqual(products[0], { id: 1, name: '甘藍菜', shelf_days: 60 });
  assert.deepEqual(products[19], { id: 20, name: '番茄', shelf_days: 45 });
});

test('2. schema.sql 重跑是安全的', async () => {
  await initDatabase({ name: DB });   // 不 reset，再跑一次
  const [{ n: slotCount }] = await q('SELECT COUNT(*) AS n FROM slot');
  const [{ n: productCount }] = await q('SELECT COUNT(*) AS n FROM product');
  assert.equal(slotCount, 36);
  assert.equal(productCount, 20);
});

test('3. 資料庫本身的防呆', async () => {
  await conn.query("INSERT INTO batch VALUES ('BTEST-01', 1, '2026-09-01', '2026-10-31')");
  await conn.query("INSERT INTO stock VALUES ('BTEST-01', 'A-01-1', 5)");

  // 庫存不能變負數
  await assert.rejects(conn.query("UPDATE stock SET qty = qty - 6 WHERE batch_id = 'BTEST-01'"), /check constraint/i);
  // 不存在的櫃位放不進去
  await assert.rejects(conn.query("INSERT INTO stock VALUES ('BTEST-01', 'Z-99-9', 1)"), /foreign key/i);
  // 異動紀錄一定要屬於某個 action
  await assert.rejects(conn.query("INSERT INTO movement (action_id, type, qty) VALUES (999, '入庫', 1)"), /foreign key/i);
  // 異動的籠數必須是正數
  const [a] = await conn.query("INSERT INTO action (label) VALUES ('測試')");
  await assert.rejects(conn.query("INSERT INTO movement (action_id, type, qty) VALUES (?, '入庫', 0)", [a.insertId]), /check constraint/i);

  // 清掉測試資料，恢復成空庫存給下一個測試用
  await initDatabase({ name: DB, reset: true });
});

test('4. seed 的資料和 Demo 一模一樣', async () => {
  // 把 Demo 裡「假資料層」那段程式直接拿出來跑，「今天」固定成 TODAY
  const html = fs.readFileSync(path.join(__dirname, '..', 'docs', 'demo', 'index.html'), 'utf8');
  const start = html.indexOf("const WH = ['A', 'B']");
  const endMark = 'movements.forEach(m => m.id = ++mSeq);';
  const end = html.indexOf(endMark) + endMark.length;
  assert.ok(start > 0 && end > start, '在 Demo 裡找不到種子資料那段程式');
  const [y, m, d] = TODAY.split('-').map(Number);
  const code = html.slice(start, end)
    .replace('const today = new Date(); today.setHours(0, 0, 0, 0);', `const today = new Date(${y}, ${m - 1}, ${d});`)
    + '\n({ products, batches, stocks });';
  // vm 跑出來的陣列屬於另一個執行環境，轉一次 JSON 才能和我們的結果直接比
  const demo = JSON.parse(JSON.stringify(vm.runInNewContext(code, { Date, Math, String, Set })));

  const ours = buildDemoData(demo.products.map((p) => ({ id: p.id, name: p.name, shelfDays: p.shelfDays })), TODAY);

  // 批次編號規則不同（Demo 全域流水號、我們每天流水號），所以比「內容」：品項、入庫日、到期日、放哪格、幾籠
  const view = (data) => data.stocks.map((s) => {
    const b = data.batches.find((x) => x.id === s.batchId);
    return `${b.productId}|${b.inDate}|${b.expireDate}|${s.slotId}|${s.qty}`;
  });
  assert.deepEqual(view(ours), view(demo));
  assert.equal(ours.batches.length, demo.batches.length);

  // 真的寫進資料庫
  const r = await seed({ dbName: DB, today: TODAY });
  assert.deepEqual(r, { batches: ours.batches.length, stocks: ours.stocks.length, movements: ours.stocks.length });

  const [{ n: used }] = await q('SELECT COUNT(*) AS n FROM stock WHERE qty > 0');
  assert.equal(used, ours.stocks.length);
  // 每一格最多放一批
  const multi = await q('SELECT slot_id FROM stock WHERE qty > 0 GROUP BY slot_id HAVING COUNT(*) > 1');
  assert.equal(multi.length, 0);
  // 異動紀錄加總 = 庫存加總（模型與真實世界同步的最基本檢查）
  const [{ total: stockTotal }] = await q('SELECT SUM(qty) AS total FROM stock');
  const [{ total: moveTotal }] = await q('SELECT SUM(qty) AS total FROM movement');
  assert.equal(Number(stockTotal), Number(moveTotal));
  // 期初資料的 action 是 init，不能被復原
  assert.deepEqual(await q('SELECT kind, undone FROM action'), [{ kind: 'init', undone: 0 }]);
  // 批次編號 = B + 入庫日 + 兩位數流水號
  for (const b of await q('SELECT id, in_date FROM batch')) {
    assert.match(b.id, new RegExp(`^B${b.in_date.replace(/-/g, '')}-\\d{2}$`));
  }
  // 日期是字串，沒有被時區轉成前一天
  const [cab] = await q("SELECT in_date FROM batch WHERE product_id = 2 ORDER BY in_date DESC LIMIT 1");
  assert.equal(cab.in_date, '2026-09-18');   // 外地高麗菜：TODAY 的 5 天前
});

test('5. seed 不會重複灌', async () => {
  await assert.rejects(seed({ dbName: DB, today: TODAY }), (err) => err.code === 'ALREADY_SEEDED');
});

test('6. FIFO 查詢：最舊的批次排最前面', async () => {
  // 技術方案 §5.1 的那句 SQL
  const rows = await q(
    `SELECT s.batch_id, s.slot_id, s.qty, b.in_date
     FROM stock s JOIN batch b ON b.id = s.batch_id
     WHERE b.product_id = ? AND s.qty > 0
     ORDER BY b.in_date ASC, b.id ASC`, [1]);
  assert.ok(rows.length >= 3, '甘藍菜至少要有 3 堆（Demo 特意補了兩批）');
  for (let i = 1; i < rows.length; i++) {
    const prev = rows[i - 1], cur = rows[i];
    assert.ok(prev.in_date < cur.in_date || (prev.in_date === cur.in_date && prev.batch_id <= cur.batch_id),
      `${prev.batch_id} 應該排在 ${cur.batch_id} 前面`);
  }
});
