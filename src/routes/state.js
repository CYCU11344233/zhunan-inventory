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
 * 資料只有 36 格，全部一次給最簡單；前端每做完一個動作就重抓一次。
 */
const express = require('express');
const { pool } = require('../db');
const { undoStatus } = require('../undo');
const { localToday } = require('../stock');

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

    res.json({
      today: localToday(),
      warehouses,
      slots,
      products: allProducts.filter((p) => !p.deleted).map(({ deleted, ...p }) => p),   // eslint-disable-line no-unused-vars
      allProducts,
      batches,
      stocks,
      undo: u,
    });
  } catch (err) {
    next(err);
  }
});

module.exports = router;
