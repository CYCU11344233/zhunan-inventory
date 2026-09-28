/*
 * src/routes/inbound.js — POST /api/inbound：入庫（一步完成）
 *
 * 正式流程（系統維護 NO1）：用 src/routes/puts.js 的「發單 → 放好回報」，放貨單存在資料庫裡。
 * 這個網址保留給舊畫面和測試用，等於「發單後馬上回報」，一樣會留下一張已完成的放貨單。
 *
 * Body：{ items: [{ productId, qty, slotId, expireDate }] }   expireDate 可省略（= 今天 + 保存天數）
 * 檢查：籠數 ≥ 1、品項存在、櫃位存在且是空的、沒被別張放貨單預定、同一張單不重複用同一格、日期格式正確
 * 回傳：{ steps: [{ slotId, productId, productName, qty, expireDate }], putId }  已依走路順序排好
 */
const express = require('express');
const { withTransaction } = require('../db');
const { route } = require('../errors');
const { createPut, confirmPut } = require('../puts');

const router = express.Router();

router.post('/inbound', route((req) => withTransaction(async (conn) => {
  const put = await createPut(conn, req.body.items);
  await confirmPut(conn, put.id);
  const steps = put.lines.map((l) => ({
    slotId: l.slotId, productId: l.productId, productName: l.productName, qty: l.qty, expireDate: l.expireDate,
  }));
  return { steps, putId: put.id };
})));

module.exports = router;
