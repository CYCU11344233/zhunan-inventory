/*
 * src/stats.js — 作業效率統計（簡報「使用者的抗拒」：新系統和大黑板比，效率差在哪裡）
 *
 * 用系統自己留下的時間戳算，不用另外請人拿碼表：
 *   揀貨單、放貨單：發單 → 回報花了幾分鐘（= 員工在倉庫裡實際跑一趟的時間 + 忘了回報的時間）
 *   盤點：這段期間每座庫盤了幾天（李太太要求一天一次）、盤出多少差異、報廢多少
 *   異動：各類動作做了幾次（被復原的不算）
 * docs/05-效率評估.md 說明怎麼用這些數字。
 */
const PENDING_WARN_MINUTES = 30;   // 發單超過 30 分鐘還沒回報 → 畫面標紅（大部分單子 10 分鐘內搬得完）

function summarize(rows) {
  const done = rows.filter((r) => r.status === 'done').map((r) => Number(r.minutes)).sort((a, b) => a - b);
  const avg = done.length ? Math.round((done.reduce((a, x) => a + x, 0) / done.length) * 10) / 10 : null;
  const median = done.length ? (done.length % 2 ? done[(done.length - 1) / 2]
    : (done[done.length / 2 - 1] + done[done.length / 2]) / 2) : null;
  const open = rows.filter((r) => r.status === 'open');
  return {
    issued: rows.length,
    done: done.length,
    cancelled: rows.filter((r) => r.status === 'cancelled').length,
    open: open.length,
    overdue: open.filter((r) => Number(r.minutes) >= PENDING_WARN_MINUTES).length,
    avgMinutes: avg,
    medianMinutes: median,
    maxMinutes: done.length ? done[done.length - 1] : null,
  };
}

async function stats(db, days = 7) {
  const since = `DATE_SUB(CURDATE(), INTERVAL ${Number(days) - 1} DAY)`;
  const orderRows = async (table) => (await db.query(
    `SELECT status, TIMESTAMPDIFF(MINUTE, created_at, COALESCE(finished_at, NOW())) AS minutes
     FROM ${table} WHERE created_at >= ${since}`))[0];
  const [whs] = await db.query('SELECT code FROM warehouse ORDER BY sort_no, code');
  const [takes] = await db.query(
    `SELECT warehouse_code AS wh, COUNT(*) AS n, COUNT(DISTINCT DATE(created_at)) AS days, MAX(created_at) AS last
     FROM stocktake WHERE created_at >= ${since} GROUP BY warehouse_code`);
  const [moves] = await db.query(
    `SELECT m.type, COUNT(*) AS n, COALESCE(SUM(m.qty), 0) AS qty
     FROM movement m JOIN action a ON a.id = m.action_id
     WHERE a.undone = 0 AND a.kind = 'normal' AND m.created_at >= ${since} GROUP BY m.type`);
  const byType = Object.fromEntries(moves.map((m) => [m.type, { count: Number(m.n), qty: Number(m.qty) }]));
  const [[sinceRow]] = await db.query(`SELECT ${since} AS d`);
  return {
    days: Number(days),
    since: sinceRow.d,
    picks: summarize(await orderRows('pick_order')),
    puts: summarize(await orderRows('put_order')),
    stocktakes: Object.fromEntries(whs.map((w) => {
      const t = takes.find((x) => x.wh === w.code);
      return [w.code, { count: t ? Number(t.n) : 0, daysCovered: t ? Number(t.days) : 0, last: t ? t.last.slice(0, 16) : null }];
    })),
    movements: byType,
    discrepancy: byType['盤點'] || { count: 0, qty: 0 },
    spoiled: byType['丟棄'] || { count: 0, qty: 0 },
  };
}

module.exports = { stats, PENDING_WARN_MINUTES };
