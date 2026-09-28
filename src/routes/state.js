/*
 * src/routes/state.js — GET /api/state：一次拿全部資料，前端自己畫
 *
 * 回傳的欄位名稱和 Demo（docs/demo/index.html）裡的陣列一模一樣，前端畫圖的程式碼可以直接用：
 *   today       伺服器的「今天」'YYYY-MM-DD'（算超期、快到期都以這個為準，不看手機的時鐘）
 *   warehouses  [{ code, name, rows, levels }]
 *   slots       [{ id, wh, row, level }]
 *   products    [{ id, name, shelfDays, color }]            還在用的品項
 *   allProducts [{ id, name, shelfDays, color, deleted }]   含已刪除的（舊批次、舊紀錄查名稱用）
 *   batches     [{ id, productId, inDate, expireDate }]      還有貨的批次
 *   stocks      [{ batchId, slotId, qty }]                   還有貨的庫存堆（qty > 0）
 *   undo        { canUndo, undoLabel, canRedo, redoLabel }
 *   openPicks   [{ id, label, createdAt, minutes, lines: [...] }]   還沒回報的揀貨單（系統維護 NO1，舊的在前）
 *   openPuts    [{ id, label, createdAt, minutes, lines: [...] }]   還沒回報的放貨單（預定的空格在 lines[].slotId）
 *   pendingWarnMinutes  發單後超過幾分鐘沒回報，畫面要標紅提醒
 *   lastStocktakes { A: { id, time, diffCount, spoiledQty } | null, B: … }   每座庫最後一次盤點（NO2）
 * 資料只有 36 格，全部一次給最簡單；前端每做完一個動作就重抓一次。
 */
const express = require('express');
const { pool } = require('../db');
const { undoStatus } = require('../undo');
const { localToday } = require('../stock');
const { listPicks } = require('../picks');
const { listPuts } = require('../puts');
const { PENDING_WARN_MINUTES } = require('../stats');

const router = express.Router();

router.get('/state', async (req, res, next) => {
  try {
    const [warehouses] = await pool.query(
      'SELECT code, name, rows_count AS `rows`, levels_count AS levels FROM warehouse ORDER BY sort_no, code');
    const [slots] = await pool.query(
      `SELECT s.id, s.warehouse_code AS wh, s.row_no AS \`row\`, s.level_no AS level
       FROM slot s JOIN warehouse w ON w.code = s.warehouse_code
       ORDER BY w.sort_no, s.row_no, s.level_no`);
    const [allRows] = await pool.query(
      'SELECT id, name, shelf_days AS shelfDays, color, deleted_at FROM product ORDER BY id');
    const allProducts = allRows.map((p) => ({
      id: p.id, name: p.name, shelfDays: p.shelfDays, color: p.color, deleted: p.deleted_at !== null,
    }));
    const [stocks] = await pool.query(
      'SELECT batch_id AS batchId, slot_id AS slotId, qty FROM stock WHERE qty > 0 ORDER BY slot_id');
    // 只給「還有貨」的批次；FIFO 順序：入庫日 → 批次編號
    const [batches] = await pool.query(
      `SELECT id, product_id AS productId, in_date AS inDate, expire_date AS expireDate
       FROM batch WHERE id IN (SELECT batch_id FROM stock WHERE qty > 0)
       ORDER BY in_date, id`);
    const u = await undoStatus(pool);
    const openPicks = (await listPicks(pool, { status: 'open', limit: 500 })).reverse();
    const openPuts = (await listPuts(pool, { status: 'open', limit: 500 })).reverse();
    const [takes] = await pool.query(
      `SELECT st.id, st.warehouse_code AS wh, st.created_at AS time, st.diff_count AS diffCount, st.spoiled_qty AS spoiledQty
       FROM stocktake st JOIN (SELECT warehouse_code, MAX(id) AS id FROM stocktake GROUP BY warehouse_code) last
         ON last.id = st.id`);
    const lastStocktakes = Object.fromEntries(warehouses.map((w) => {
      const t = takes.find((x) => x.wh === w.code);
      return [w.code, t ? { id: t.id, time: t.time.slice(0, 16), diffCount: t.diffCount, spoiledQty: t.spoiledQty } : null];
    }));

    res.json({
      today: localToday(),
      warehouses,
      slots,
      products: allProducts.filter((p) => !p.deleted).map(({ deleted, ...p }) => p),   // eslint-disable-line no-unused-vars
      allProducts,
      batches,
      stocks,
      undo: u,
      openPicks,
      openPuts,
      pendingWarnMinutes: PENDING_WARN_MINUTES,
      lastStocktakes,
    });
  } catch (err) {
    next(err);
  }
});

module.exports = router;
