/*
 * src/routes/puts.js — 放貨單（系統維護 NO1 的「進貨」那一半），邏輯在 src/puts.js
 *
 * POST /api/puts               { items: [{ productId, qty, slotId, expireDate? }] }  發單：保留那幾個空格
 * GET  /api/puts?status=open   列出放貨單（status 可省略 = 全部，最新的在前）
 * GET  /api/puts/:id           一張放貨單
 * POST /api/puts/:id/confirm   { placements?: [{ seq, slotId }] }  回報放好了；放到別格就告訴系統實際哪一格
 * POST /api/puts/:id/cancel    取消：貨沒進來，保留的空格放回來
 *
 * put = { id, label, status, createdAt, finishedAt, minutes,
 *         lines: [{ seq, productId, productName, qty, slotId, expireDate, placedSlotId, batchId }] }
 */
const express = require('express');
const { pool, withTransaction } = require('../db');
const { UserError, route } = require('../errors');
const P = require('../puts');

const router = express.Router();
const idOf = (req) => {
  const id = Number(req.params.id);
  if (!Number.isInteger(id) || id < 1) throw new UserError('放貨單編號不正確');
  return id;
};

router.post('/puts', route((req) => withTransaction((conn) => P.createPut(conn, req.body.items))));

router.get('/puts', route((req) => {
  const status = req.query.status;
  if (status && !['open', 'done', 'cancelled'].includes(status)) throw new UserError('status 只能是 open、done、cancelled');
  const limit = Math.min(Math.max(parseInt(req.query.limit, 10) || 50, 1), 500);
  return P.listPuts(pool, { status, limit });
}));

router.get('/puts/:id', route(async (req) => {
  const put = await P.getPut(pool, idOf(req));
  if (!put) throw new UserError('沒有這張放貨單');
  return put;
}));

router.post('/puts/:id/confirm', route((req) => withTransaction((conn) => P.confirmPut(conn, idOf(req), req.body.placements))));
router.post('/puts/:id/cancel', route((req) => withTransaction((conn) => P.cancelPut(conn, idOf(req)))));

module.exports = router;
