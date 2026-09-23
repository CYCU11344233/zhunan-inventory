/*
 * src/routes/products.js — 品項主檔（李太太今年多一種菜、少一種菜）
 *
 * POST   /api/products       { name, shelfDays, color }   新增；名稱不能和現有品項重複
 * PUT    /api/products/:id   { name, shelfDays, color }   編輯；舊紀錄仍顯示當時的名稱
 * DELETE /api/products/:id   { confirmName }              刪除：要打一次名稱確認、還有庫存不能刪；
 *                                                         是「軟刪除」，舊批次和紀錄都還查得到
 * 主檔的變更也是 movement（type='主檔'），old_value / new_value 存 JSON，所以一樣可以復原。
 */
const express = require('express');
const { withTransaction } = require('../db');
const { UserError, route } = require('../errors');
const S = require('../stock');

const router = express.Router();

// 檢查並整理表單內容
function readForm(body) {
  const name = String(body.name || '').trim();
  const shelfDays = Number(body.shelfDays);
  const color = String(body.color || '');
  if (!name) throw new UserError('請輸入名稱');
  if (name.length > 20) throw new UserError('名稱最多 20 個字');
  if (!S.isPosInt(shelfDays) || shelfDays > 3650) throw new UserError('保存天數要是 1～3650 的整數');
  if (!/^#[0-9a-fA-F]{6}$/.test(color)) throw new UserError('顏色格式不對');
  return { name, shelfDays, color };
}

async function assertNameFree(conn, name, exceptId = 0) {
  const [[dup]] = await conn.query(
    'SELECT id FROM product WHERE name = ? AND deleted_at IS NULL AND id <> ?', [name, exceptId]);
  if (dup) throw new UserError(`已經有「${name}」了`);
}

const snap = (p, deleted) => JSON.stringify({ name: p.name, shelfDays: p.shelfDays, color: p.color, deleted });

router.post('/products', route(async (req) => {
  const f = readForm(req.body);
  return withTransaction(async (conn) => {
    await assertNameFree(conn, f.name);
    // 先建一列「已刪除」的品項，再用 movement 把它變成「啟用」—— 這樣復原新增 = 回到已刪除
    const [r] = await conn.query('INSERT INTO product (name, shelf_days, color, deleted_at) VALUES (?, ?, ?, NOW())',
      [f.name, f.shelfDays, f.color]);
    const actionId = await S.newAction(conn, `新增品項 ${f.name}`);
    await S.record(conn, actionId, {
      type: '主檔', productId: r.insertId, productName: f.name,
      oldValue: snap(f, true), newValue: snap(f, false), note: `新增品項，保存 ${f.shelfDays} 天`,
    });
    return { id: r.insertId };
  });
}));

router.put('/products/:id', route(async (req) => {
  const f = readForm(req.body);
  return withTransaction(async (conn) => {
    const p = await S.activeProduct(conn, Number(req.params.id));
    await assertNameFree(conn, f.name, p.id);
    const changes = [];
    if (p.name !== f.name) changes.push(`名稱 ${p.name} → ${f.name}`);
    if (p.shelfDays !== f.shelfDays) changes.push(`保存天數 ${p.shelfDays} → ${f.shelfDays} 天`);
    if (p.color.toLowerCase() !== f.color.toLowerCase()) changes.push('顏色');
    if (!changes.length) return { changed: false };
    const actionId = await S.newAction(conn, `編輯品項 ${f.name}`);
    await S.record(conn, actionId, {
      type: '主檔', productId: p.id, productName: f.name,
      oldValue: snap(p, false), newValue: snap(f, false), note: '編輯品項：' + changes.join('、'),
    });
    return { changed: true };
  });
}));

router.delete('/products/:id', route(async (req) => {
  return withTransaction(async (conn) => {
    const p = await S.activeProduct(conn, Number(req.params.id));
    if (String(req.body.confirmName || '').trim() !== p.name) throw new UserError('名稱不符，沒有刪除');
    const [[{ qty }]] = await conn.query(
      'SELECT COALESCE(SUM(s.qty), 0) AS qty FROM stock s JOIN batch b ON b.id = s.batch_id WHERE b.product_id = ?', [p.id]);
    if (Number(qty) > 0) throw new UserError(`還有 ${qty} 籠庫存，出清後才能刪除`);
    const actionId = await S.newAction(conn, `刪除品項 ${p.name}`);
    await S.record(conn, actionId, {
      type: '主檔', productId: p.id, productName: p.name,
      oldValue: snap(p, false), newValue: snap(p, true), note: '刪除品項（歷史紀錄保留）',
    });
    return { ok: true };
  });
}));

module.exports = router;
