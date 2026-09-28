/*
 * src/routes/stocktake.js — 盤點（系統維護 NO2：每天對一座倉庫盤點一次）
 *
 * POST /api/stocktakes  { warehouse: 'A', counts: [{ slotId, counted, spoiled?, reason? }] }
 *   一次盤一整座倉庫：這座庫「每一格有貨的」都算盤過了。
 *   counts 只要列「和系統不一樣」或「有壞掉」的格子；沒列到的 = 點過了、數量正確。
 *     counted：實際點到幾籠（含壞掉的）
 *     spoiled：其中壞掉、不能賣的幾籠（會丟掉），有壞掉就一定要寫 reason（例如「腐爛」）
 *   結果：
 *     - 一定會新增一筆盤點紀錄（全部正確也會），證明這座庫今天盤過了
 *     - counted ≠ 系統 → 寫「盤點」異動（系統 8 → 實際 7）
 *     - spoiled > 0   → 寫「丟棄」異動，備註寫原因
 *     - 有改到庫存的話，這些異動是同一個 action，按錯了可以「復原」
 *   回 { id, warehouse, slotCount, diffCount, spoiledQty, changed, warnings }
 *     warnings：盤點後某格的貨比「還沒回報的揀貨單」要拿的還少 → 提醒那張單要取消重發
 *
 * GET /api/stocktakes?warehouse=A&limit=30   盤點紀錄（最新的在前，不含明細）
 * GET /api/stocktakes/:id                    一次盤點的明細（每一格系統幾籠、實際幾籠、壞幾籠、原因）
 */
const express = require('express');
const { pool, withTransaction } = require('../db');
const { UserError, route } = require('../errors');
const S = require('../stock');
const { reservedAt } = require('../picks');

const router = express.Router();

router.post('/stocktakes', route(async (req) => {
  const wh = req.body.warehouse;
  const counts = Array.isArray(req.body.counts) ? req.body.counts : [];
  return withTransaction(async (conn) => {
    const [[w]] = await conn.query('SELECT code, name FROM warehouse WHERE code = ?', [wh]);
    if (!w) throw new UserError('請選要盤點哪一座倉庫');

    // 這座庫所有有貨的格子（鎖住，盤點時別人不能同時改）
    const [rows] = await conn.query(
      `SELECT s.slot_id AS slotId, s.batch_id AS batchId, s.qty, b.product_id AS productId, p.name AS productName
       FROM stock s JOIN slot sl ON sl.id = s.slot_id
       JOIN batch b ON b.id = s.batch_id JOIN product p ON p.id = b.product_id
       WHERE sl.warehouse_code = ? AND s.qty > 0
       ORDER BY sl.row_no, sl.level_no FOR UPDATE`, [w.code]);
    const bySlot = Object.fromEntries(rows.map((r) => [r.slotId, r]));

    // 檢查使用者填的每一格
    const input = {};
    for (const [i, c] of counts.entries()) {
      const label = `第 ${i + 1} 格（${c.slotId}）：`;
      if (!bySlot[c.slotId]) throw new UserError(`${label}不是 ${w.name}有貨的格子`);
      if (input[c.slotId]) throw new UserError(`${label}重複填了`);
      const counted = Number(c.counted);
      const spoiled = c.spoiled == null ? 0 : Number(c.spoiled);
      const reason = typeof c.reason === 'string' ? c.reason.trim().slice(0, 100) : '';
      if (!Number.isInteger(counted) || counted < 0) throw new UserError(`${label}實際籠數要是 0 以上的整數`);
      if (!Number.isInteger(spoiled) || spoiled < 0) throw new UserError(`${label}壞掉的籠數要是 0 以上的整數`);
      if (spoiled > counted) throw new UserError(`${label}壞掉的不能比點到的多`);
      if (spoiled > 0 && !reason) throw new UserError(`${label}有壞掉的，請寫原因（例如：腐爛）`);
      input[c.slotId] = { counted, spoiled, reason };
    }

    // 每一格的結果：沒填 = 數量正確、沒有壞
    const lines = rows.map((r) => ({ ...r, ...(input[r.slotId] || { counted: r.qty, spoiled: 0, reason: '' }) }));
    const diffs = lines.filter((l) => l.counted !== l.qty);
    const spoils = lines.filter((l) => l.spoiled > 0);
    const spoiledQty = spoils.reduce((a, l) => a + l.spoiled, 0);

    // 有改到庫存才建 action（全部正確就只有盤點紀錄，沒有東西可以復原）
    let actionId = null;
    if (diffs.length || spoils.length) {
      const parts = [];
      if (diffs.length) parts.push(`${diffs.length} 格數量不符`);
      if (spoiledQty) parts.push(`報廢 ${spoiledQty} 籠`);
      actionId = await S.newAction(conn, `盤點 ${w.name}（${parts.join('、')}）`);
      for (const l of lines) {
        const base = { productId: l.productId, productName: l.productName, batchId: l.batchId };
        if (l.counted !== l.qty) {
          const diff = l.counted - l.qty;
          await S.record(conn, actionId, {
            ...base, type: '盤點', qty: Math.abs(diff),
            ...(diff < 0 ? { fromSlotId: l.slotId } : { toSlotId: l.slotId }),
            note: `${w.name}盤點：系統 ${l.qty} → 實際 ${l.counted}`,
          });
        }
        if (l.spoiled > 0) {
          await S.record(conn, actionId, {
            ...base, type: '丟棄', qty: l.spoiled, fromSlotId: l.slotId,
            note: `${w.name}盤點報廢：${l.reason}（批次 ${l.batchId}，剩 ${l.counted - l.spoiled} 籠）`,
          });
        }
      }
    }

    const [r] = await conn.query(
      'INSERT INTO stocktake (warehouse_code, slot_count, diff_count, spoiled_qty, action_id) VALUES (?, ?, ?, ?, ?)',
      [w.code, lines.length, diffs.length, spoiledQty, actionId]);
    for (const l of lines) {
      await conn.query(
        `INSERT INTO stocktake_line (stocktake_id, slot_id, batch_id, system_qty, counted_qty, spoiled_qty, reason)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
        [r.insertId, l.slotId, l.batchId, l.qty, l.counted, l.spoiled, l.reason || null]);
    }

    // 盤點後比揀貨單要拿的還少 → 那張單回報時會失敗，先提醒
    const warnings = [];
    for (const l of lines) {
      const left = l.counted - l.spoiled;
      const held = await reservedAt(conn, l.slotId);
      if (held.qty > left) warnings.push(`${l.slotId} 盤點後剩 ${left} 籠，但揀貨單 #${held.pickId} 要拿 ${held.qty} 籠，請取消那張單重新發單`);
    }

    return {
      id: r.insertId, warehouse: w.code, slotCount: lines.length, diffCount: diffs.length,
      spoiledQty, changed: !!actionId, warnings,
    };
  });
}));

router.get('/stocktakes', route(async (req) => {
  const limit = Math.min(Math.max(parseInt(req.query.limit, 10) || 30, 1), 500);
  const args = [];
  let where = '';
  if (req.query.warehouse) { where = 'WHERE st.warehouse_code = ?'; args.push(req.query.warehouse); }
  const [rows] = await pool.query(
    `SELECT st.id, st.warehouse_code AS warehouse, st.created_at AS time, st.slot_count AS slotCount,
            st.diff_count AS diffCount, st.spoiled_qty AS spoiledQty, COALESCE(a.undone, 0) AS undone
     FROM stocktake st LEFT JOIN action a ON a.id = st.action_id
     ${where} ORDER BY st.id DESC LIMIT ?`, [...args, limit]);
  return rows.map((x) => ({ ...x, time: x.time.slice(0, 16), undone: !!x.undone }));
}));

router.get('/stocktakes/:id', route(async (req) => {
  const [[st]] = await pool.query(
    `SELECT st.id, st.warehouse_code AS warehouse, st.created_at AS time, st.slot_count AS slotCount,
            st.diff_count AS diffCount, st.spoiled_qty AS spoiledQty, COALESCE(a.undone, 0) AS undone
     FROM stocktake st LEFT JOIN action a ON a.id = st.action_id WHERE st.id = ?`, [req.params.id]);
  if (!st) throw new UserError('沒有這筆盤點紀錄');
  const [lines] = await pool.query(
    `SELECT l.slot_id AS slotId, l.batch_id AS batchId, p.name AS productName,
            l.system_qty AS systemQty, l.counted_qty AS countedQty, l.spoiled_qty AS spoiledQty, l.reason
     FROM stocktake_line l JOIN batch b ON b.id = l.batch_id JOIN product p ON p.id = b.product_id
     WHERE l.stocktake_id = ? ORDER BY l.id`, [st.id]);
  return { ...st, time: st.time.slice(0, 16), undone: !!st.undone, lines };
}));

module.exports = router;
