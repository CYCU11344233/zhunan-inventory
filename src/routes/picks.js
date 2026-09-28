/*
 * src/routes/picks.js — 揀貨單（系統維護 NO1），邏輯在 src/picks.js
 *
 * POST /api/picks               { items: [{ productId, qty }] }  發單：FIFO 算好、存起來、保留那幾格的貨
 *                               或 { lines: [{ slotId, batchId, qty }] }  照畫面上預覽過的那張存（會再檢查還拿得到）
 *                                 回 { pick, shortages }
 * GET  /api/picks?status=open   列出揀貨單（status 可省略 = 全部，最新的在前；limit 預設 50）
 * GET  /api/picks/:id           一張揀貨單
 * POST /api/picks/:id/confirm   回報：貨已經搬出來了 → 扣庫存、寫出庫紀錄
 * POST /api/picks/:id/cancel    取消：保留的貨放回來
 *
 * pick = { id, label, status: 'open' | 'done' | 'cancelled', createdAt, finishedAt,
 *          lines: [{ seq, slotId, batchId, productId, productName, inDate, qty }] }
 */
const express = require('express');
const { pool, withTransaction } = require('../db');
const { UserError, route } = require('../errors');
const P = require('../picks');

const router = express.Router();
const idOf = (req) => {
  const id = Number(req.params.id);
  if (!Number.isInteger(id) || id < 1) throw new UserError('揀貨單編號不正確');
  return id;
};

router.post('/picks', route((req) => withTransaction((conn) => P.createPick(conn, req.body))));

router.get('/picks', route((req) => {
  const status = req.query.status;
  if (status && !['open', 'done', 'cancelled'].includes(status)) throw new UserError('status 只能是 open、done、cancelled');
  const limit = Math.min(Math.max(parseInt(req.query.limit, 10) || 50, 1), 500);
  return P.listPicks(pool, { status, limit });
}));

router.get('/picks/:id', route(async (req) => {
  const pick = await P.getPick(pool, idOf(req));
  if (!pick) throw new UserError('沒有這張揀貨單');
  return pick;
}));

router.post('/picks/:id/confirm', route((req) => withTransaction((conn) => P.confirmPick(conn, idOf(req)))));
router.post('/picks/:id/cancel', route((req) => withTransaction((conn) => P.cancelPick(conn, idOf(req)))));

module.exports = router;
