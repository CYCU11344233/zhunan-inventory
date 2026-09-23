/*
 * src/routes/outbound.js — 出庫（兩步：先看揀貨單，確認後才扣庫存）
 *
 * POST /api/outbound/plan     { items: [{ productId, qty }] }
 *   不改任何資料。每個品項用 FIFO（最舊的批次先出）算要去哪幾格拿幾籠。
 *   回 { plan: [{ slotId, batchId, inDate, productId, productName, qty }]（依走路順序）,
 *        shortages: ['甘藍菜 差 3 籠'] }
 *
 * POST /api/outbound/confirm  { plan: [{ slotId, batchId, qty }] }（上一步回的）
 *   再檢查一次每格的庫存還夠（可能有人剛好動過）→ 每一列寫一筆「出庫」movement
 */
const express = require('express');
const { pool, withTransaction } = require('../db');
const { UserError, route } = require('../errors');
const { allocate, walkSort } = require('../fifo');
const S = require('../stock');

const router = express.Router();

// 技術方案 §5.1：FIFO 一定用 SQL 排序 —— 最舊的批次排最前面，同一天入庫的依批次編號
const FIFO_SQL = `
  SELECT s.batch_id AS batchId, s.slot_id AS slotId, s.qty, b.in_date AS inDate
  FROM stock s JOIN batch b ON b.id = s.batch_id
  WHERE b.product_id = ? AND s.qty > 0
  ORDER BY b.in_date ASC, b.id ASC`;

router.post('/outbound/plan', route(async (req) => {
  const items = Array.isArray(req.body.items) ? req.body.items : [];
  if (!items.length) throw new UserError('請至少填一項');
  const reserved = {};   // 同一張單裡，前面幾項已經預定的籠數
  const plan = [], shortages = [];
  for (const [i, it] of items.entries()) {
    const qty = Number(it.qty);
    if (!S.isPosInt(qty)) throw new UserError(`第 ${i + 1} 項：籠數要是 1 以上的整數`);
    const p = await S.activeProduct(pool, it.productId, `第 ${i + 1} 項：`);
    const [candidates] = await pool.query(FIFO_SQL, [p.id]);
    const r = allocate(candidates, qty, reserved);
    plan.push(...r.plan.map((x) => ({ ...x, productId: p.id, productName: p.name })));
    if (r.shortage) shortages.push(`${p.name} 差 ${r.shortage} 籠`);
  }
  return { plan: walkSort(plan, await S.slotInfo(pool)), shortages };
}));

router.post('/outbound/confirm', route(async (req) => {
  const plan = Array.isArray(req.body.plan) ? req.body.plan : [];
  if (!plan.length) throw new UserError('揀貨單是空的');

  return withTransaction(async (conn) => {
    // 同一格可能出現兩次（同一張單兩項都是同一種菜），先加總再檢查
    const need = {};
    for (const x of plan) {
      if (!S.isPosInt(Number(x.qty))) throw new UserError('揀貨單的籠數不正確');
      const k = `${x.batchId}|${x.slotId}`;
      need[k] = (need[k] || 0) + Number(x.qty);
    }
    const info = {};
    for (const k of Object.keys(need)) {
      const [batchId, slotId] = k.split('|');
      const [[row]] = await conn.query(
        `SELECT s.qty, b.product_id AS productId, p.name AS productName
         FROM stock s JOIN batch b ON b.id = s.batch_id JOIN product p ON p.id = b.product_id
         WHERE s.batch_id = ? AND s.slot_id = ? FOR UPDATE`, [batchId, slotId]);
      if (!row || row.qty < need[k]) throw new UserError(`${slotId} 的庫存已經變了，請重新產生揀貨單`);
      info[k] = row;
    }

    // 標籤：出庫 甘藍菜 6 籠、毛豆 3 籠
    const byProd = {};
    for (const x of plan) {
      const p = info[`${x.batchId}|${x.slotId}`];
      byProd[p.productName] = (byProd[p.productName] || 0) + Number(x.qty);
    }
    const actionId = await S.newAction(conn, '出庫 ' + Object.entries(byProd).map(([n, q]) => `${n} ${q} 籠`).join('、'));
    for (const x of plan) {
      const p = info[`${x.batchId}|${x.slotId}`];
      await S.record(conn, actionId, {
        type: '出庫', productId: p.productId, productName: p.productName, batchId: x.batchId,
        fromSlotId: x.slotId, qty: Number(x.qty), note: `批次 ${x.batchId}（FIFO）`,
      });
    }
    return { ok: true };
  });
}));

module.exports = router;
