/*
 * src/routes/inbound.js — POST /api/inbound：入庫
 *
 * Body：{ items: [{ productId, qty, slotId, expireDate }] }   expireDate 由前端算好（三種算法都在前端）
 * 檢查：籠數 ≥ 1、品項存在、櫃位存在且是空的、同一張單不重複用同一格、日期格式正確
 * 做法：每一項 → 建新批次（B + 今天 + 當日流水號）→ 寫一筆「入庫」movement（庫存由它加上去）
 * 回傳：{ steps: [{ slotId, productName, qty, expireDate }] }  已依走路順序排好，前端照著畫路線圖
 */
const express = require('express');
const { withTransaction } = require('../db');
const { UserError, route } = require('../errors');
const { walkSort } = require('../fifo');
const S = require('../stock');

const router = express.Router();

router.post('/inbound', route(async (req) => {
  const items = Array.isArray(req.body.items) ? req.body.items : [];
  if (!items.length) throw new UserError('請至少填一項');

  return withTransaction(async (conn) => {
    const today = S.localToday();
    const seen = new Set();
    const rows = [];
    for (const [i, it] of items.entries()) {
      const label = `第 ${i + 1} 項：`;
      const qty = Number(it.qty);
      if (!S.isPosInt(qty)) throw new UserError(`${label}籠數要是 1 以上的整數`);
      const p = await S.activeProduct(conn, it.productId, label);
      await S.assertSlot(conn, it.slotId, label);
      if (await S.occupantOf(conn, it.slotId)) throw new UserError(`${label}${it.slotId} 已經有貨，請換一格`);
      if (seen.has(it.slotId)) throw new UserError(`${label}${it.slotId} 跟其他項重複`);
      seen.add(it.slotId);
      const defaultExpire = S.addDays(today, p.shelfDays);
      const expireDate = it.expireDate || defaultExpire;
      if (!S.isDate(expireDate)) throw new UserError(`${label}到期日格式不對`);
      rows.push({ p, qty, slotId: it.slotId, expireDate, custom: expireDate !== defaultExpire });
    }

    // 今天用到第幾號了：找編號 B{今天}-xx 裡最大的 xx（鎖住，避免兩個人同時入庫拿到同一個編號）
    const prefix = `B${today.replace(/-/g, '')}-`;
    const [[{ n }]] = await conn.query(
      'SELECT COALESCE(MAX(CAST(SUBSTRING(id, ?) AS UNSIGNED)), 0) AS n FROM batch WHERE id LIKE ? FOR UPDATE',
      [prefix.length + 1, prefix + '%']);
    let seq = Number(n);
    const actionId = await S.newAction(conn, '入庫 ' + rows.map((r) => `${r.p.name} ${r.qty} 籠`).join('、'));
    for (const r of rows) {
      seq += 1;
      const batchId = `B${today.replace(/-/g, '')}-${String(seq).padStart(2, '0')}`;
      await conn.query('INSERT INTO batch (id, product_id, in_date, expire_date) VALUES (?, ?, ?, ?)',
        [batchId, r.p.id, today, r.expireDate]);
      await S.record(conn, actionId, {
        type: '入庫', productId: r.p.id, productName: r.p.name, batchId, toSlotId: r.slotId, qty: r.qty,
        note: `批次 ${batchId}` + (r.custom ? `（自訂到期 ${r.expireDate}）` : ''),
      });
    }

    const steps = rows.map((r) => ({ slotId: r.slotId, productId: r.p.id, productName: r.p.name, qty: r.qty, expireDate: r.expireDate }));
    return { steps: walkSort(steps, await S.slotInfo(conn)) };
  });
}));

module.exports = router;
