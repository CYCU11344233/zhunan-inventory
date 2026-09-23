/*
 * src/routes/movements.js — GET /api/movements?limit=200：異動紀錄（「紀錄」頁用）
 *
 * 新的在前。每筆：
 *   { id, time 'YYYY-MM-DD HH:MM', type, productName, batchId, fromSlotId, toSlotId, qty, note, undone }
 * undone = 這筆所屬的動作已經被「復原」了（畫面上會劃掉，但紀錄永遠不刪）
 */
const express = require('express');
const { pool } = require('../db');

const router = express.Router();

router.get('/movements', async (req, res, next) => {
  try {
    const limit = Math.min(Math.max(parseInt(req.query.limit, 10) || 200, 1), 2000);
    const [rows] = await pool.query(
      `SELECT m.id, m.created_at, m.type, m.product_name, m.batch_id, m.from_slot_id, m.to_slot_id,
              m.qty, m.note, a.undone
       FROM movement m JOIN action a ON a.id = m.action_id
       ORDER BY m.created_at DESC, m.id DESC
       LIMIT ?`, [limit]);
    res.json(rows.map((m) => ({
      id: m.id,
      time: m.created_at.slice(0, 16),   // 'YYYY-MM-DD HH:MM'
      type: m.type,
      productName: m.product_name,
      batchId: m.batch_id,
      fromSlotId: m.from_slot_id,
      toSlotId: m.to_slot_id,
      qty: m.qty,
      note: m.note,
      undone: !!m.undone,
    })));
  } catch (err) {
    next(err);
  }
});

module.exports = router;
