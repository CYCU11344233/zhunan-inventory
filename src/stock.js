/*
 * src/stock.js — 所有「改庫存」都走這裡（技術方案 §3.2 的規則）
 *
 *   newAction(conn, label)            建一個 action（使用者按一次確認 = 一個 action）
 *   record(conn, actionId, m)         寫一筆 movement，並「正向」套用到庫存
 *   applyMovement(conn, m, direction) 唯一會動 stock / batch.expire_date / product 的函式
 *                                     direction = +1 正向（做）、-1 反向（復原）
 * 因為做和復原用的是同一個函式，復原永遠不會漏改。
 *
 * 另外放幾個各 route 都會用到的查詢小工具。
 */
const { UserError } = require('./errors');

async function newAction(conn, label) {
  const [r] = await conn.query("INSERT INTO action (label, kind) VALUES (?, 'normal')", [label.slice(0, 120)]);
  return r.insertId;
}

// m：{ type, productId, productName, batchId, fromSlotId, toSlotId, qty, oldValue, newValue, note }
async function record(conn, actionId, m) {
  const row = {
    action_id: actionId,
    type: m.type,
    product_id: m.productId ?? null,
    product_name: m.productName ?? null,
    batch_id: m.batchId ?? null,
    from_slot_id: m.fromSlotId ?? null,
    to_slot_id: m.toSlotId ?? null,
    qty: m.qty ?? null,
    old_value: m.oldValue ?? null,
    new_value: m.newValue ?? null,
    note: m.note ?? null,
  };
  const [r] = await conn.query('INSERT INTO movement SET ?', [row]);
  await applyMovement(conn, { ...row, id: r.insertId }, +1);
  return r.insertId;
}

// m 是 movement 表的一列（欄位用資料庫的名字）
async function applyMovement(conn, m, direction) {
  // 1. 籠數搬動：from 格 −qty、to 格 +qty；復原時反過來
  if (m.qty && m.batch_id && (m.from_slot_id || m.to_slot_id)) {
    const minus = direction > 0 ? m.from_slot_id : m.to_slot_id;
    const plus = direction > 0 ? m.to_slot_id : m.from_slot_id;
    if (minus) {
      const [r] = await conn.query('UPDATE stock SET qty = qty - ? WHERE batch_id = ? AND slot_id = ?', [m.qty, m.batch_id, minus]);
      if (r.affectedRows !== 1) throw new Error(`找不到 ${m.batch_id} 在 ${minus} 的庫存`);
    }
    if (plus) {
      await conn.query(
        'INSERT INTO stock (batch_id, slot_id, qty) VALUES (?, ?, ?) ON DUPLICATE KEY UPDATE qty = qty + VALUES(qty)',
        [m.batch_id, plus, m.qty]);
    }
  }
  // 2. 改到期日
  if (m.type === '改到期日') {
    await conn.query('UPDATE batch SET expire_date = ? WHERE id = ?', [direction > 0 ? m.new_value : m.old_value, m.batch_id]);
  }
  // 3. 品項主檔：old_value / new_value 存 { name, shelfDays, color, deleted } 的 JSON
  if (m.type === '主檔') {
    const v = JSON.parse(direction > 0 ? m.new_value : m.old_value);
    await conn.query(
      'UPDATE product SET name = ?, shelf_days = ?, color = ?, deleted_at = IF(?, COALESCE(deleted_at, NOW()), NULL) WHERE id = ?',
      [v.name, v.shelfDays, v.color, v.deleted ? 1 : 0, m.product_id]);
  }
}

/* ---------- 查詢小工具 ---------- */

// 本地日期 'YYYY-MM-DD'（不用 toISOString，那是 UTC，早上 8 點前會變成昨天）
function localToday() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}
function addDays(dateStr, n) {
  const [y, mo, d] = dateStr.split('-').map(Number);
  const x = new Date(y, mo - 1, d + n);
  return `${x.getFullYear()}-${String(x.getMonth() + 1).padStart(2, '0')}-${String(x.getDate()).padStart(2, '0')}`;
}
const isDate = (s) => typeof s === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(s) && !Number.isNaN(Date.parse(s));
const isPosInt = (n) => Number.isInteger(n) && n >= 1;

// 某格現在放的東西（有貨才回），順便鎖住這一列，避免同時兩個人搬同一格
async function occupantOf(conn, slotId) {
  const [[row]] = await conn.query(
    `SELECT s.batch_id AS batchId, s.qty, b.product_id AS productId, p.name AS productName,
            b.in_date AS inDate, b.expire_date AS expireDate
     FROM stock s JOIN batch b ON b.id = s.batch_id JOIN product p ON p.id = b.product_id
     WHERE s.slot_id = ? AND s.qty > 0 LIMIT 1 FOR UPDATE`, [slotId]);
  return row || null;
}

async function assertSlot(conn, slotId, label = '') {
  const [[s]] = await conn.query('SELECT id FROM slot WHERE id = ?', [slotId]);
  if (!s) throw new UserError(`${label}沒有 ${slotId} 這個櫃位`);
}

async function activeProduct(conn, productId, label = '') {
  const [[p]] = await conn.query(
    'SELECT id, name, shelf_days AS shelfDays, color FROM product WHERE id = ? AND deleted_at IS NULL', [productId]);
  if (!p) throw new UserError(`${label}找不到這個品項（可能已被刪除）`);
  return p;
}

// 列出目前「單子保留」被破壞的地方（復原／重做前後各查一次，比較有沒有「新」的問題）：
//   1. 還沒回報的揀貨單要拿的，比那格現有的多
//   2. 還沒回報的放貨單預定的空格，已經有貨
//   3. 同一個空格被兩張還沒回報的放貨單預定
// 回 [{ key, msg }]；盤點、改籠數可以合法地造成第 1 種（會提醒），所以只擋「這次動作新造成的」
async function holdProblems(conn) {
  const out = [];
  const [over] = await conn.query(
    `SELECT MIN(pl.pick_id) AS pickId, pl.slot_id AS slotId
     FROM pick_line pl JOIN pick_order po ON po.id = pl.pick_id AND po.status = 'open'
     LEFT JOIN stock s ON s.batch_id = pl.batch_id AND s.slot_id = pl.slot_id
     GROUP BY pl.batch_id, pl.slot_id HAVING SUM(pl.qty) > COALESCE(MAX(s.qty), 0)`);
  for (const r of over) out.push({ key: `pick:${r.slotId}:${r.pickId}`, msg: `${r.slotId} 的貨已經開在揀貨單 #${r.pickId}，請先回報或取消那張單` });
  const [full] = await conn.query(
    `SELECT DISTINCT pl.put_id AS putId, pl.slot_id AS slotId
     FROM put_line pl JOIN put_order po ON po.id = pl.put_id AND po.status = 'open'
     JOIN stock s ON s.slot_id = pl.slot_id AND s.qty > 0`);
  for (const r of full) out.push({ key: `full:${r.slotId}:${r.putId}`, msg: `${r.slotId} 已經被放貨單 #${r.putId} 預定，請先回報或取消那張單` });
  const [twice] = await conn.query(
    `SELECT pl.slot_id AS slotId, MIN(pl.put_id) AS a, MAX(pl.put_id) AS b
     FROM put_line pl JOIN put_order po ON po.id = pl.put_id AND po.status = 'open'
     GROUP BY pl.slot_id HAVING COUNT(DISTINCT pl.put_id) > 1`);
  for (const r of twice) out.push({ key: `twice:${r.slotId}:${r.a}:${r.b}`, msg: `${r.slotId} 會被放貨單 #${r.a} 和 #${r.b} 同時預定，請先回報或取消其中一張` });
  return out;
}

// 所有櫃位的走路順序資訊，給 fifo.walkSort 用
async function slotInfo(conn) {
  const [rows] = await conn.query(
    'SELECT s.id, w.sort_no AS sortNo, s.row_no AS `row`, s.level_no AS level FROM slot s JOIN warehouse w ON w.code = s.warehouse_code');
  return Object.fromEntries(rows.map((r) => [r.id, r]));
}

module.exports = {
  newAction, record, applyMovement,
  localToday, addDays, isDate, isPosInt, occupantOf, assertSlot, activeProduct, slotInfo, holdProblems,
};
