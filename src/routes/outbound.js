/*
 * src/routes/outbound.js — 出庫
 *
 * 正式流程（系統維護 NO1）：用 src/routes/picks.js 的「發單 → 回報」，揀貨單存在資料庫裡，
 * 搬走了沒回報會一直掛著。這個檔保留舊的兩個網址，讓現在的畫面照常能用：
 *
 * POST /api/outbound/plan     { items: [{ productId, qty }] }
 *   不改任何資料，只預覽：每個品項用 FIFO 算要去哪幾格拿（已被別張揀貨單保留的貨不算）。
 *   回 { plan: [{ slotId, batchId, inDate, productId, productName, qty }]（依走路順序）,
 *        shortages: ['甘藍菜 差 3 籠'] }
 *
 * POST /api/outbound/confirm  { plan: [{ slotId, batchId, qty }] }（上一步回的）
 *   等於「發單後馬上回報」：一樣會留下一張揀貨單（已完成），出庫紀錄都查得到是哪張單。
 *   ⚠ 畫面改成「發單 → 回報」之後，這個網址就不該再用（它不能防「忘了回報」）。
 */
const express = require('express');
const { pool, withTransaction } = require('../db');
const { route } = require('../errors');
const P = require('../picks');

const router = express.Router();

router.post('/outbound/plan', route((req) => P.planPick(pool, req.body.items)));

router.post('/outbound/confirm', route(async (req) => {
  const plan = Array.isArray(req.body.plan) ? req.body.plan : [];
  return withTransaction(async (conn) => {
    const id = await P.saveOrder(conn, plan.map((x) => ({ slotId: x.slotId, batchId: x.batchId, qty: x.qty })));
    await P.confirmPick(conn, id);
    return { ok: true, pickId: id };
  });
}));

module.exports = router;
