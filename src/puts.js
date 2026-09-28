/*
 * src/puts.js — 放貨單（系統維護 NO1 的「進貨」那一半）
 *
 * 和揀貨單（src/picks.js）對稱：
 *   1. 發單 createPut()：檢查品項、籠數、格子是空的，存成一張 open 的放貨單。
 *      預定的空格被「保留」—— 別張放貨單、移位都不能佔用；庫存還沒動。
 *   2. 回報 confirmPut()：員工放好了才回報，這時才建批次（入庫日 = 今天）、寫「入庫」異動。
 *      現場放到別格也沒關係：回報時告訴系統實際放哪一格，紀錄會寫「原定 X，實際放 Y」。
 *   3. 取消 cancelPut()：貨沒進來（退貨、送錯）→ 保留的空格放回來。
 * 復原「入庫」時，單子回到 open；重做就再變回 done（src/undo.js）。
 */
const { UserError } = require('./errors');
const { walkSort } = require('./fifo');
const S = require('./stock');

// 某個空格被「別張」還沒回報的放貨單預定了嗎？回 { putId } 或 null
async function heldBy(db, slotId, exceptPutId = 0) {
  const [[r]] = await db.query(
    `SELECT po.id AS putId FROM put_line pl JOIN put_order po ON po.id = pl.put_id
     WHERE po.status = 'open' AND po.id <> ? AND pl.slot_id = ? LIMIT 1`, [exceptPutId, slotId]);
  return r || null;
}

// 格子能不能放新貨：存在、空的、沒被別張放貨單預定
async function assertFree(conn, slotId, label, exceptPutId = 0) {
  await S.assertSlot(conn, slotId, label);
  if (await S.occupantOf(conn, slotId)) throw new UserError(`${label}${slotId} 已經有貨，請換一格`);
  const h = await heldBy(conn, slotId, exceptPutId);
  if (h) throw new UserError(`${label}${slotId} 已經被放貨單 #${h.putId} 預定了，請換一格`);
}

// 檢查入庫單的每一項，回傳整理好的列（和原本 POST /api/inbound 的檢查一樣，再多一條「沒被預定」）
async function checkItems(conn, items) {
  if (!Array.isArray(items) || !items.length) throw new UserError('請至少填一項');
  const today = S.localToday();
  const seen = new Set();
  const rows = [];
  for (const [i, it] of items.entries()) {
    const label = `第 ${i + 1} 項：`;
    const qty = Number(it.qty);
    if (!S.isPosInt(qty)) throw new UserError(`${label}籠數要是 1 以上的整數`);
    const p = await S.activeProduct(conn, it.productId, label);
    await assertFree(conn, it.slotId, label);
    if (seen.has(it.slotId)) throw new UserError(`${label}${it.slotId} 跟其他項重複`);
    seen.add(it.slotId);
    const defaultExpire = S.addDays(today, p.shelfDays);
    const expireDate = it.expireDate || defaultExpire;
    if (!S.isDate(expireDate)) throw new UserError(`${label}到期日格式不對`);
    rows.push({ p, qty, slotId: it.slotId, expireDate, custom: expireDate !== defaultExpire });
  }
  return rows;
}

// 發單：存成 open 的放貨單（每一站依走路順序）
async function createPut(conn, items) {
  // 鎖住放貨單表，避免兩個人同時預定同一個空格
  await conn.query('SELECT id FROM put_order ORDER BY id DESC LIMIT 1 FOR UPDATE');
  const rows = await checkItems(conn, items);
  const label = ('入庫 ' + rows.map((r) => `${r.p.name} ${r.qty} 籠`).join('、')).slice(0, 120);
  const [r] = await conn.query('INSERT INTO put_order (label) VALUES (?)', [label]);
  const sorted = walkSort(rows, await S.slotInfo(conn));
  for (const [i, x] of sorted.entries()) {
    await conn.query(
      `INSERT INTO put_line (put_id, seq, product_id, qty, slot_id, expire_date, custom_expire)
       VALUES (?, ?, ?, ?, ?, ?, ?)`, [r.insertId, i + 1, x.p.id, x.qty, x.slotId, x.expireDate, x.custom ? 1 : 0]);
  }
  return getPut(conn, r.insertId);
}

// 回報：放好了 → 建批次、寫入庫異動。placements：[{ seq, slotId }] 實際放的格子和原定不同時才要給
async function confirmPut(conn, id, placements = []) {
  const [[po]] = await conn.query('SELECT id, label, status FROM put_order WHERE id = ? FOR UPDATE', [id]);
  if (!po) throw new UserError(`沒有 #${id} 這張放貨單`);
  if (po.status !== 'open') throw new UserError(`放貨單 #${id} 已經${po.status === 'done' ? '回報過' : '取消'}了`);
  const [lines] = await conn.query(
    `SELECT pl.id, pl.seq, pl.product_id AS productId, p.name AS productName, pl.qty, pl.slot_id AS slotId,
            pl.expire_date AS expireDate, pl.custom_expire AS custom
     FROM put_line pl JOIN product p ON p.id = pl.product_id
     WHERE pl.put_id = ? ORDER BY pl.seq FOR UPDATE`, [id]);

  // 實際放的格子：有給就用給的，沒給 = 照原定
  const moved = {};
  for (const x of Array.isArray(placements) ? placements : []) {
    const l = lines.find((y) => y.seq === Number(x.seq));
    if (!l) throw new UserError(`放貨單 #${id} 沒有第 ${x.seq} 站`);
    if (x.slotId && x.slotId !== l.slotId) moved[l.seq] = x.slotId;
  }
  const seen = new Set();
  for (const l of lines) {
    await S.activeProduct(conn, l.productId, `第 ${l.seq} 站：`);   // 發單後品項被刪了 → 請取消這張單
    l.placed = moved[l.seq] || l.slotId;
    const label = `第 ${l.seq} 站：`;
    if (seen.has(l.placed)) throw new UserError(`${label}${l.placed} 跟其他站重複`);
    seen.add(l.placed);
    await assertFree(conn, l.placed, label, id);   // 自己這張單預定的不算
  }

  // 批次編號：B{今天}-{當日流水}，找今天最大的號碼 +1（鎖住，避免兩個人同時拿到同一號）
  const today = S.localToday();
  const prefix = `B${today.replace(/-/g, '')}-`;
  const [[{ n }]] = await conn.query(
    'SELECT COALESCE(MAX(CAST(SUBSTRING(id, ?) AS UNSIGNED)), 0) AS n FROM batch WHERE id LIKE ? FOR UPDATE',
    [prefix.length + 1, prefix + '%']);
  let seq = Number(n);
  const actionId = await S.newAction(conn, po.label);
  for (const l of lines) {
    seq += 1;
    const batchId = `${prefix}${String(seq).padStart(2, '0')}`;
    await conn.query('INSERT INTO batch (id, product_id, in_date, expire_date) VALUES (?, ?, ?, ?)',
      [batchId, l.productId, today, l.expireDate]);
    await S.record(conn, actionId, {
      type: '入庫', productId: l.productId, productName: l.productName, batchId, toSlotId: l.placed, qty: l.qty,
      note: `放貨單 #${id}，批次 ${batchId}` + (l.custom ? `（自訂到期 ${l.expireDate}）` : '')
        + (l.placed !== l.slotId ? `（原定 ${l.slotId}，實際放 ${l.placed}）` : ''),
    });
    await conn.query('UPDATE put_line SET placed_slot_id = ?, batch_id = ? WHERE id = ?', [l.placed, batchId, l.id]);
  }
  await conn.query("UPDATE put_order SET status = 'done', finished_at = NOW(), action_id = ? WHERE id = ?", [actionId, id]);
  return getPut(conn, id);
}

// 取消：貨沒進來 → 保留的空格放回來
async function cancelPut(conn, id) {
  const [[po]] = await conn.query('SELECT status FROM put_order WHERE id = ? FOR UPDATE', [id]);
  if (!po) throw new UserError(`沒有 #${id} 這張放貨單`);
  if (po.status !== 'open') throw new UserError(`放貨單 #${id} 已經${po.status === 'done' ? '回報過，要退回請用「復原」' : '取消'}了`);
  await conn.query("UPDATE put_order SET status = 'cancelled', finished_at = NOW() WHERE id = ?", [id]);
  return getPut(conn, id);
}

async function listPuts(db, { status, id, limit = 50 } = {}) {
  const where = [], args = [];
  if (id) { where.push('po.id = ?'); args.push(id); }
  if (status) { where.push('po.status = ?'); args.push(status); }
  const [orders] = await db.query(
    `SELECT po.id, po.label, po.status, po.created_at AS createdAt, po.finished_at AS finishedAt,
            TIMESTAMPDIFF(MINUTE, po.created_at, COALESCE(po.finished_at, NOW())) AS minutes
     FROM put_order po ${where.length ? 'WHERE ' + where.join(' AND ') : ''}
     ORDER BY po.id DESC LIMIT ?`, [...args, limit]);
  if (!orders.length) return [];
  const [lines] = await db.query(
    `SELECT pl.put_id AS putId, pl.seq, pl.product_id AS productId, p.name AS productName, pl.qty,
            pl.slot_id AS slotId, pl.expire_date AS expireDate, pl.placed_slot_id AS placedSlotId, pl.batch_id AS batchId
     FROM put_line pl JOIN product p ON p.id = pl.product_id
     WHERE pl.put_id IN (?) ORDER BY pl.put_id, pl.seq`, [orders.map((o) => o.id)]);
  return orders.map((o) => ({
    ...o,
    createdAt: o.createdAt.slice(0, 16),
    finishedAt: o.finishedAt ? o.finishedAt.slice(0, 16) : null,
    lines: lines.filter((l) => l.putId === o.id).map(({ putId, ...l }) => l),   // eslint-disable-line no-unused-vars
  }));
}
async function getPut(db, id) { return (await listPuts(db, { id }))[0]; }

module.exports = { createPut, confirmPut, cancelPut, listPuts, getPut, heldBy };
