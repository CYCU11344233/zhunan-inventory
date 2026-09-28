/*
 * src/picks.js — 揀貨單（系統維護 NO1：搬走了一定要被記錄）
 *
 * 問題：以前出庫是「看揀貨單 → 去搬 → 按確認」，揀貨單只存在畫面上。
 *       員工搬完忘了按確認，系統就不知道貨已經不在了；頁面一關，連「有單子沒回報」都查不到。
 * 做法：出庫改成兩個會寫進資料庫的步驟
 *   1. 發單 createPick()：用 FIFO 算好要去哪幾格拿，存成一張 open 的揀貨單。
 *      這幾格的貨被「保留」—— 下一張單不會再分配到同一批貨，移位、丟棄也不能動它。
 *   2. 回報 confirmPick()：員工搬完回報，這時才寫「出庫」異動、扣庫存，單子變成 done。
 *   沒回報的單一直是 open，GET /api/state 的 openPicks 會列出來，任何一台裝置都看得到。
 *   也可以 cancelPick() 取消（客人不要了），保留的貨就放回來。
 * 復原「出庫」時，單子回到 open（貨沒出去 = 單子還沒完成）；重做就再變回 done（見 src/undo.js）。
 */
const { UserError } = require('./errors');
const { allocate, walkSort } = require('./fifo');
const S = require('./stock');

// 還沒回報的揀貨單保留了哪些貨（批次 + 格子 → 籠數）
const RESERVED_SUBQUERY = `
  SELECT pl.batch_id, pl.slot_id, SUM(pl.qty) AS qty
  FROM pick_line pl JOIN pick_order po ON po.id = pl.pick_id
  WHERE po.status = 'open' AND po.id <> ?
  GROUP BY pl.batch_id, pl.slot_id`;

// FIFO 候選：某品項「扣掉已保留之後」還拿得到的庫存，最舊的批次排最前面（技術方案 §5.1）
const FIFO_SQL = `
  SELECT s.batch_id AS batchId, s.slot_id AS slotId, b.in_date AS inDate,
         CAST(s.qty - COALESCE(r.qty, 0) AS SIGNED) AS qty
  FROM stock s
  JOIN batch b ON b.id = s.batch_id
  LEFT JOIN (${RESERVED_SUBQUERY}) r ON r.batch_id = s.batch_id AND r.slot_id = s.slot_id
  WHERE b.product_id = ? AND s.qty - COALESCE(r.qty, 0) > 0
  ORDER BY b.in_date ASC, b.id ASC`;

// 某一格被「別張」還沒回報的單保留了幾籠（exceptPickId：回報自己這張時不算自己）
async function reservedAt(db, slotId, exceptPickId = 0) {
  const [[r]] = await db.query(
    `SELECT CAST(COALESCE(SUM(pl.qty), 0) AS SIGNED) AS qty, MIN(po.id) AS pickId
     FROM pick_line pl JOIN pick_order po ON po.id = pl.pick_id
     WHERE po.status = 'open' AND po.id <> ? AND pl.slot_id = ?`, [exceptPickId, slotId]);
  return { qty: Number(r.qty), pickId: r.pickId };
}

// 算揀貨計畫（不寫資料）：每個品項用 FIFO 分配，最後依走路順序排好
// items：[{ productId, qty }] → { plan: [{ slotId, batchId, inDate, productId, productName, qty }], shortages }
async function planPick(db, items) {
  if (!Array.isArray(items) || !items.length) throw new UserError('請至少填一項');
  const taken = {};   // 同一張單裡，前面幾項已經分配掉的籠數
  const plan = [], shortages = [];
  for (const [i, it] of items.entries()) {
    const qty = Number(it.qty);
    if (!S.isPosInt(qty)) throw new UserError(`第 ${i + 1} 項：籠數要是 1 以上的整數`);
    const p = await S.activeProduct(db, it.productId, `第 ${i + 1} 項：`);
    const [candidates] = await db.query(FIFO_SQL, [0, p.id]);
    const r = allocate(candidates.map((c) => ({ ...c, qty: Number(c.qty) })), qty, taken);
    plan.push(...r.plan.map((x) => ({ ...x, productId: p.id, productName: p.name })));
    if (r.shortage) shortages.push(`${p.name} 差 ${r.shortage} 籠`);
  }
  return { plan: walkSort(plan, await S.slotInfo(db)), shortages };
}

// 標籤：「出庫 甘藍菜 6 籠、毛豆 3 籠」
function labelOf(lines) {
  const byProd = {};
  for (const l of lines) byProd[l.productName] = (byProd[l.productName] || 0) + l.qty;
  return ('出庫 ' + Object.entries(byProd).map(([n, q]) => `${n} ${q} 籠`).join('、')).slice(0, 120);
}

// 把 lines 存成一張 open 的揀貨單。lines：[{ slotId, batchId, qty }]（已依走路順序）
// 會再檢查一次：每一格扣掉別張單保留的之後，還夠不夠
async function saveOrder(conn, lines) {
  if (!lines.length) throw new UserError('揀貨單是空的');
  // 鎖住揀貨單表，避免兩個人同時發單拿到同一批貨
  await conn.query('SELECT id FROM pick_order ORDER BY id DESC LIMIT 1 FOR UPDATE');
  const need = {};
  for (const l of lines) {
    if (!S.isPosInt(Number(l.qty))) throw new UserError('揀貨單的籠數不正確');
    const k = `${l.batchId}|${l.slotId}`;
    need[k] = (need[k] || 0) + Number(l.qty);
  }
  const info = {};
  for (const k of Object.keys(need)) {
    const [batchId, slotId] = k.split('|');
    const [[row]] = await conn.query(
      `SELECT s.qty, b.product_id AS productId, p.name AS productName
       FROM stock s JOIN batch b ON b.id = s.batch_id JOIN product p ON p.id = b.product_id
       WHERE s.batch_id = ? AND s.slot_id = ? FOR UPDATE`, [batchId, slotId]);
    const held = row ? (await reservedAt(conn, slotId)).qty : 0;
    if (!row || row.qty - held < need[k]) throw new UserError(`${slotId} 的庫存已經變了，請重新產生揀貨單`);
    info[k] = row;
  }
  const full = lines.map((l) => {
    const { productId, productName } = info[`${l.batchId}|${l.slotId}`];
    return { slotId: l.slotId, batchId: l.batchId, qty: Number(l.qty), productId, productName };
  });
  const [r] = await conn.query('INSERT INTO pick_order (label) VALUES (?)', [labelOf(full)]);
  for (const [i, l] of full.entries()) {
    await conn.query('INSERT INTO pick_line (pick_id, seq, batch_id, slot_id, qty) VALUES (?, ?, ?, ?, ?)',
      [r.insertId, i + 1, l.batchId, l.slotId, l.qty]);
  }
  return r.insertId;
}

// 發單：存成 open 的揀貨單
//   body.lines：畫面上預覽過的揀貨單 [{ slotId, batchId, qty }] → 照這張存（員工看到的就是存下來的）
//   body.items：[{ productId, qty }] → 現在用 FIFO 算一張
async function createPick(conn, body = {}) {
  if (Array.isArray(body.lines) && body.lines.length) {
    const info = await S.slotInfo(conn);
    for (const l of body.lines) if (!info[l.slotId]) throw new UserError(`沒有 ${l.slotId} 這個櫃位`);
    const id = await saveOrder(conn, walkSort(body.lines, info));
    return { pick: await getPick(conn, id), shortages: [] };
  }
  const { plan, shortages } = await planPick(conn, body.items);
  if (!plan.length) throw new UserError('這些品項都沒有可以拿的庫存' + (shortages.length ? `（${shortages.join('、')}）` : ''));
  const id = await saveOrder(conn, plan);
  return { pick: await getPick(conn, id), shortages };
}

// 回報：這張單的貨已經搬出來了 → 寫「出庫」異動、扣庫存、單子變 done
async function confirmPick(conn, id) {
  const [[po]] = await conn.query('SELECT id, label, status FROM pick_order WHERE id = ? FOR UPDATE', [id]);
  if (!po) throw new UserError(`沒有 #${id} 這張揀貨單`);
  if (po.status !== 'open') throw new UserError(`揀貨單 #${id} 已經${po.status === 'done' ? '回報過' : '取消'}了`);
  const [lines] = await conn.query(
    `SELECT pl.batch_id AS batchId, pl.slot_id AS slotId, pl.qty, s.qty AS stockQty,
            b.product_id AS productId, p.name AS productName
     FROM pick_line pl
     JOIN batch b ON b.id = pl.batch_id JOIN product p ON p.id = b.product_id
     LEFT JOIN stock s ON s.batch_id = pl.batch_id AND s.slot_id = pl.slot_id
     WHERE pl.pick_id = ? ORDER BY pl.seq FOR UPDATE`, [id]);
  for (const l of lines) {
    if ((l.stockQty || 0) < l.qty) {
      throw new UserError(`${l.slotId} 現在只剩 ${l.stockQty || 0} 籠，不夠這張單要的 ${l.qty} 籠（可能盤點時改過），請取消這張單重新發單`);
    }
  }
  const actionId = await S.newAction(conn, po.label);
  for (const l of lines) {
    await S.record(conn, actionId, {
      type: '出庫', productId: l.productId, productName: l.productName, batchId: l.batchId,
      fromSlotId: l.slotId, qty: l.qty, note: `揀貨單 #${id}，批次 ${l.batchId}（FIFO）`,
    });
  }
  await conn.query("UPDATE pick_order SET status = 'done', finished_at = NOW(), action_id = ? WHERE id = ?", [actionId, id]);
  return getPick(conn, id);
}

// 取消：客人不要了、或單子發錯 → 保留的貨放回來，庫存沒有動過
async function cancelPick(conn, id) {
  const [[po]] = await conn.query('SELECT status FROM pick_order WHERE id = ? FOR UPDATE', [id]);
  if (!po) throw new UserError(`沒有 #${id} 這張揀貨單`);
  if (po.status !== 'open') throw new UserError(`揀貨單 #${id} 已經${po.status === 'done' ? '回報過，要退回請用「復原」' : '取消'}了`);
  await conn.query("UPDATE pick_order SET status = 'cancelled', finished_at = NOW() WHERE id = ?", [id]);
  return getPick(conn, id);
}

// 讀一張或多張揀貨單（含每一站）
async function listPicks(db, { status, id, limit = 50 } = {}) {
  const where = [], args = [];
  if (id) { where.push('po.id = ?'); args.push(id); }
  if (status) { where.push('po.status = ?'); args.push(status); }
  const [orders] = await db.query(
    `SELECT po.id, po.label, po.status, po.created_at AS createdAt, po.finished_at AS finishedAt,
            TIMESTAMPDIFF(MINUTE, po.created_at, COALESCE(po.finished_at, NOW())) AS minutes
     FROM pick_order po ${where.length ? 'WHERE ' + where.join(' AND ') : ''}
     ORDER BY po.id DESC LIMIT ?`, [...args, limit]);
  if (!orders.length) return [];
  const [lines] = await db.query(
    `SELECT pl.pick_id AS pickId, pl.seq, pl.slot_id AS slotId, pl.batch_id AS batchId, pl.qty,
            b.product_id AS productId, p.name AS productName, b.in_date AS inDate
     FROM pick_line pl JOIN batch b ON b.id = pl.batch_id JOIN product p ON p.id = b.product_id
     WHERE pl.pick_id IN (?) ORDER BY pl.pick_id, pl.seq`, [orders.map((o) => o.id)]);
  return orders.map((o) => ({
    ...o,
    createdAt: o.createdAt.slice(0, 16),
    finishedAt: o.finishedAt ? o.finishedAt.slice(0, 16) : null,
    lines: lines.filter((l) => l.pickId === o.id).map(({ pickId, ...l }) => l),   // eslint-disable-line no-unused-vars
  }));
}
async function getPick(db, id) { return (await listPicks(db, { id }))[0]; }

module.exports = { planPick, saveOrder, createPick, confirmPick, cancelPick, listPicks, getPick, reservedAt };
