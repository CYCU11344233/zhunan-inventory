/*
 * src/undo.js — 復原 / 重做（技術方案 §5.3）
 *
 * 規則：
 *   可復原的：kind='normal' 且還沒被復原的 action 裡，id 最大的那個（只能一步一步往回）
 *   可重做的：最後一個一般動作之後按過的「復原」，由新到舊第一個還沒重做回來的
 *             （連按兩次復原，先重做最後被復原的那個；中間做了新動作就不能重做）
 *   'init'（期初資料）、'undo' / 'redo' 本身都不能被復原
 * 做法：
 *   復原 = 把該 action 的 movement 由新到舊，逐筆用 applyMovement(…, -1) 反向套用
 *   重做 = 由舊到新，applyMovement(…, +1)
 *   紀錄永遠不刪：原本的 movement 留著（畫面上劃掉），另外補一筆「復原」或「重做」
 *   揀貨單、放貨單（src/picks.js、src/puts.js）：復原「出庫／入庫」→ 那張單回到 open
 *   （貨沒動 = 單子還沒完成）；重做 → 回到 done。
 *   單子被取消之後，它的出庫／入庫就不能再重做；重做也就停在那裡（不跳過它去重做後面的，順序才不會亂）。
 *   復原／重做前後各查一次「單子保留」（stock.holdProblems）：如果這次動作「新」造成某張單拿不到貨、
 *   或預定的空格有貨了，整個動作退回，提示先回報或取消那張單。
 */
const { withTransaction } = require('./db');
const { UserError } = require('./errors');
const { applyMovement, holdProblems } = require('./stock');

const UNDO_SQL = "SELECT id, label FROM action WHERE kind = 'normal' AND undone = 0 ORDER BY id DESC LIMIT 1";
// 可重做的：最後一個一般動作之後按過的「復原」，由新到舊，第一個還沒被重做回來的（像一疊盤子，後進先出）
//   做了新的一般動作 → 之前的復原全部不能重做（和 Demo「做了新動作 redo 就清空」一致）
const REDO_SQL = `
  SELECT a.id, a.label FROM action u JOIN action a ON a.id = u.target_action_id
  WHERE u.kind = 'undo' AND a.undone = 1
    AND u.id > (SELECT COALESCE(MAX(id), 0) FROM action WHERE kind = 'normal')
  ORDER BY u.id DESC LIMIT 1`;
// 要重做的那個動作，是不是屬於一張已經取消的單（是 → 不能重做，也不跳過它）
const CANCELLED_SQL = `
  SELECT id FROM pick_order WHERE action_id = ? AND status = 'cancelled'
  UNION ALL SELECT id FROM put_order WHERE action_id = ? AND status = 'cancelled' LIMIT 1`;
async function redoTarget(db) {
  const [[r]] = await db.query(REDO_SQL);
  if (!r) return null;
  const [c] = await db.query(CANCELLED_SQL, [r.id, r.id]);
  return c.length ? null : r;
}

// 告訴前端現在能不能復原 / 重做、按鈕上要寫什麼（GET /api/state 用）
async function undoStatus(db) {
  const [[u]] = await db.query(UNDO_SQL);
  const r = await redoTarget(db);
  return {
    canUndo: !!u, undoLabel: u ? u.label : null,
    canRedo: !!r, redoLabel: r ? r.label : null,
  };
}

async function replay(kind) {
  return withTransaction(async (conn) => {
    // 鎖住 action 表的最後幾列，避免兩個人同時按復原
    await conn.query('SELECT id FROM action ORDER BY id DESC LIMIT 1 FOR UPDATE');
    const target = kind === 'undo' ? (await conn.query(UNDO_SQL))[0][0] : await redoTarget(conn);
    if (!target) throw new UserError(kind === 'undo' ? '沒有可以復原的動作' : '沒有可以重做的動作');

    const before = new Set((await holdProblems(conn)).map((p) => p.key));
    const [moves] = await conn.query(
      `SELECT * FROM movement WHERE action_id = ? ORDER BY id ${kind === 'undo' ? 'DESC' : 'ASC'}`, [target.id]);
    for (const m of moves) await applyMovement(conn, m, kind === 'undo' ? -1 : +1);
    await conn.query('UPDATE action SET undone = ? WHERE id = ?', [kind === 'undo' ? 1 : 0, target.id]);
    for (const table of ['pick_order', 'put_order']) {
      await conn.query(
        kind === 'undo'
          ? `UPDATE ${table} SET status = 'open', finished_at = NULL WHERE action_id = ? AND status = 'done'`
          : `UPDATE ${table} SET status = 'done', finished_at = NOW() WHERE action_id = ? AND status = 'open'`,
        [target.id]);
    }
    const broken = (await holdProblems(conn)).find((p) => !before.has(p.key));
    if (broken) throw new UserError(`不能${kind === 'undo' ? '復原' : '重做'}「${target.label}」：${broken.msg}`);

    const word = kind === 'undo' ? '復原' : '重做';
    const [a] = await conn.query('INSERT INTO action (label, kind, target_action_id) VALUES (?, ?, ?)',
      [`${word}「${target.label}」`.slice(0, 120), kind, target.id]);
    await conn.query('INSERT INTO movement (action_id, type, note) VALUES (?, ?, ?)', [
      a.insertId, word,
      kind === 'undo' ? `復原「${target.label}」，庫存退回該動作之前` : `重做「${target.label}」`,
    ]);
    return { label: target.label };
  });
}

module.exports = { undoStatus, undo: () => replay('undo'), redo: () => replay('redo') };
