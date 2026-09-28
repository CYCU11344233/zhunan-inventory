/*
 * src/routes/slots.js — 倉庫地圖上的操作
 *
 * POST /api/transfer  { from, to }                  移位（to 是空格）／互換（to 有貨）
 * POST /api/adjust    { slotId, qty, expireDate }   盤點（籠數不同）／改到期日（日期不同），可以同時
 * POST /api/discard   { slotId, qty?, reason? }     丟棄：不給 qty = 整格；給 qty = 只丟幾籠（例如一箱爛了）
 *                                                     reason 記在紀錄的備註（例如「腐爛」）
 * 每個都是一個 action，丟錯、搬錯都可以「復原」。
 * 被還沒回報的揀貨單保留的貨（src/picks.js）不能移位、不能丟，避免員工照單去拿時貨不在了；
 * 被放貨單預定的空格（src/puts.js）不能移貨進去。
 */
const express = require('express');
const { withTransaction } = require('../db');
const { UserError, route } = require('../errors');
const S = require('../stock');
const { reservedAt } = require('../picks');
const { heldBy } = require('../puts');

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
    for (const sid of b ? [from, to] : [from]) {
      const held = await reservedAt(conn, sid);
      if (held.qty) throw new UserError(`${sid} 的貨已經開在揀貨單 #${held.pickId}，請先回報或取消那張單再搬`);
    }
    if (!b) {
      const h = await heldBy(conn, to);
      if (h) throw new UserError(`${to} 已經被放貨單 #${h.putId} 預定了，請換一格`);
    }
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
    // 盤點改少了、比還沒回報的揀貨單要拿的還少 → 那張單回報時會被擋，先提醒
    const held = await reservedAt(conn, slotId);
    const warnings = held.qty > qty
      ? [`${slotId} 改成 ${qty} 籠，但揀貨單 #${held.pickId} 要拿 ${held.qty} 籠，請取消那張單重新發單`] : [];
    return { changed: true, what, warnings };
  });
}));

router.post('/discard', route(async (req) => {
  const { slotId } = req.body;
  const reason = typeof req.body.reason === 'string' ? req.body.reason.trim().slice(0, 100) : '';
  return withTransaction(async (conn) => {
    const st = await S.occupantOf(conn, slotId);
    if (!st) throw new UserError(`${slotId} 沒有貨`);
    const qty = req.body.qty == null ? st.qty : Number(req.body.qty);   // 沒給 = 整格
    if (!S.isPosInt(qty)) throw new UserError('丟棄的籠數要是 1 以上的整數');
    if (qty > st.qty) throw new UserError(`${slotId} 只有 ${st.qty} 籠`);
    const held = await reservedAt(conn, slotId);
    if (qty > st.qty - held.qty) {
      throw new UserError(`${slotId} 有 ${held.qty} 籠已經開在揀貨單 #${held.pickId}，最多只能丟 ${st.qty - held.qty} 籠`);
    }
    const actionId = await S.newAction(conn, `丟棄 ${slotId} ${st.productName} ${qty} 籠`);
    const expired = st.expireDate < S.localToday();
    const why = reason || (expired ? '超期' : '未超期');
    await S.record(conn, actionId, {
      type: '丟棄', productId: st.productId, productName: st.productName, batchId: st.batchId,
      fromSlotId: slotId, qty,
      note: `批次 ${st.batchId}，${why}（到期 ${st.expireDate}）` + (qty < st.qty ? `，剩 ${st.qty - qty} 籠` : ''),
    });
    return { productName: st.productName, qty, left: st.qty - qty };
  });
}));

module.exports = router;
