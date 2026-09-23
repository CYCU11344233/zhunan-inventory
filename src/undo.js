/*
 * src/undo.js — 復原 / 重做（技術方案 §5.3）
 *
 * 規則：
 *   可復原的：kind='normal' 且還沒被復原的 action 裡，id 最大的那個（只能一步一步往回）
 *   可重做的：「最後一個有效動作」之後、已被復原的 action 裡，id 最小的那個
 *             （連按兩次復原 X、Y 之後，重做要先重做 X 再重做 Y；中間做了新動作就不能重做）
 *   'init'（期初資料）、'undo' / 'redo' 本身都不能被復原
 * 做法：
 *   復原 = 把該 action 的 movement 由新到舊，逐筆用 applyMovement(…, -1) 反向套用
 *   重做 = 由舊到新，applyMovement(…, +1)
 *   紀錄永遠不刪：原本的 movement 留著（畫面上劃掉），另外補一筆「復原」或「重做」
 */
const { withTransaction } = require('./db');
const { UserError } = require('./errors');
const { applyMovement } = require('./stock');

const UNDO_SQL = "SELECT id, label FROM action WHERE kind = 'normal' AND undone = 0 ORDER BY id DESC LIMIT 1";
const REDO_SQL = `
  SELECT id, label FROM action
  WHERE kind = 'normal' AND undone = 1
    AND id > (SELECT COALESCE(MAX(id), 0) FROM action WHERE kind = 'normal' AND undone = 0)
  ORDER BY id ASC LIMIT 1`;

// 告訴前端現在能不能復原 / 重做、按鈕上要寫什麼（GET /api/state 用）
async function undoStatus(db) {
  const [[u]] = await db.query(UNDO_SQL);
  const [[r]] = await db.query(REDO_SQL);
  return {
    canUndo: !!u, undoLabel: u ? u.label : null,
    canRedo: !!r, redoLabel: r ? r.label : null,
  };
}

async function replay(kind) {
  return withTransaction(async (conn) => {
    // 鎖住 action 表的最後幾列，避免兩個人同時按復原
    await conn.query('SELECT id FROM action ORDER BY id DESC LIMIT 1 FOR UPDATE');
    const [[target]] = await conn.query(kind === 'undo' ? UNDO_SQL : REDO_SQL);
    if (!target) throw new UserError(kind === 'undo' ? '沒有可以復原的動作' : '沒有可以重做的動作');

    const [moves] = await conn.query(
      `SELECT * FROM movement WHERE action_id = ? ORDER BY id ${kind === 'undo' ? 'DESC' : 'ASC'}`, [target.id]);
    for (const m of moves) await applyMovement(conn, m, kind === 'undo' ? -1 : +1);
    await conn.query('UPDATE action SET undone = ? WHERE id = ?', [kind === 'undo' ? 1 : 0, target.id]);

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
