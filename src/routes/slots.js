/*
 * src/routes/slots.js — 倉庫地圖上的操作
 *
 * POST /api/transfer  { from, to }                  移位（to 是空格）／互換（to 有貨）
 * POST /api/adjust    { slotId, qty, expireDate }   盤點（籠數不同）／改到期日（日期不同），可以同時
 * POST /api/discard   { slotId }                    整格丟棄（壞掉、超期）
 * 每個都是一個 action，丟錯、搬錯都可以「復原」。
 */
const express = require('express');
const { withTransaction } = require('../db');
const { UserError, route } = require('../errors');
const S = require('../stock');

const router = express.Router();

router.post('/transfer', route(async (req) => {
  const { from, to } = req.body;
  if (!from || !to || from === to) throw new UserError('請選兩個不同的櫃位');
  return withTransaction(async (conn) => {
    await S.assertSlot(conn, from);
    await S.assertSlot(conn, to);
    const a = await S.occupantOf(conn, from);
    if (!a) throw new UserError(`${from} 沒有貨`);
    const b = await S.occupantOf(conn, to);
    const label = b ? `互換 ${from} ⇄ ${to}` : `移位 ${from} → ${to}`;
    const actionId = await S.newAction(conn, label);
    await S.record(conn, actionId, {
      type: '移位', productId: a.productId, productName: a.productName, batchId: a.batchId,
      fromSlotId: from, toSlotId: to, qty: a.qty, note: `批次 ${a.batchId}` + (b ? `（與 ${to} 互換）` : ''),
    });
    if (b) {
      await S.record(conn, actionId, {
        type: '移位', productId: b.productId, productName: b.productName, batchId: b.batchId,
        fromSlotId: to, toSlotId: from, qty: b.qty, note: `批次 ${b.batchId}（與 ${from} 互換）`,
      });
    }
    return { label, swapped: !!b };
  });
}));

router.post('/adjust', route(async (req) => {
  const { slotId, expireDate } = req.body;
  const qty = Number(req.body.qty);
  if (!Number.isInteger(qty) || qty < 0) throw new UserError('籠數要是 0 以上的整數');
  if (expireDate && !S.isDate(expireDate)) throw new UserError('到期日格式不對');
  return withTransaction(async (conn) => {
    const st = await S.occupantOf(conn, slotId);
    if (!st) throw new UserError(`${slotId} 是空格，請用「入庫」`);
    const what = [];
    if (qty !== st.qty) what.push('盤點');
    if (expireDate && expireDate !== st.expireDate) what.push('改到期日');
    if (!what.length) return { changed: false };

    const actionId = await S.newAction(conn, `${what.join('＋')} ${slotId}`);
    const base = { productId: st.productId, productName: st.productName, batchId: st.batchId };
    if (qty !== st.qty) {
      const diff = qty - st.qty;
      await S.record(conn, actionId, {
        ...base, type: '盤點', qty: Math.abs(diff),
        ...(diff < 0 ? { fromSlotId: slotId } : { toSlotId: slotId }),   // 少了就從這格扣，多了就加進這格
        note: `系統 ${st.qty} → 實際 ${qty}`,
      });
    }
    if (expireDate && expireDate !== st.expireDate) {
      await S.record(conn, actionId, {
        ...base, type: '改到期日', oldValue: st.expireDate, newValue: expireDate,
        note: `${slotId}：${st.expireDate} → ${expireDate}（整批一起改）`,
      });
    }
    return { changed: true, what };
  });
}));

router.post('/discard', route(async (req) => {
  const { slotId } = req.body;
  return withTransaction(async (conn) => {
    const st = await S.occupantOf(conn, slotId);
    if (!st) throw new UserError(`${slotId} 沒有貨`);
    const actionId = await S.newAction(conn, `丟棄 ${slotId} ${st.productName} ${st.qty} 籠`);
    const expired = st.expireDate < S.localToday();
    await S.record(conn, actionId, {
      type: '丟棄', productId: st.productId, productName: st.productName, batchId: st.batchId,
      fromSlotId: slotId, qty: st.qty, note: `批次 ${st.batchId}，${expired ? '超期' : '未超期'}（到期 ${st.expireDate}）`,
    });
    return { productName: st.productName, qty: st.qty };
  });
}));

module.exports = router;
