/*
 * src/errors.js — 錯誤處理小工具
 *
 *   throw new UserError('第 1 項：A-01-2 已經有貨，請換一格')
 *     → 使用者操作錯了，回 400，訊息直接顯示在畫面上
 *   router.post('/xxx', route(async (req) => { …; return 結果 }))
 *     → 包一層：回傳值自動變成 JSON；UserError 回 400；其他錯誤交給 server.js 回 500
 */
class UserError extends Error {}

function route(fn) {
  return async (req, res, next) => {
    try {
      res.json(await fn(req, res));
    } catch (err) {
      if (err instanceof UserError) return res.status(400).json({ error: err.message });
      // MySQL 的 CHECK 擋下負庫存（errno 3819）：代表有人剛好同時動了同一格
      if (err.errno === 3819) return res.status(400).json({ error: '庫存數量不夠，可能剛被別人動過，請重新整理再試一次' });
      next(err);
    }
  };
}

module.exports = { UserError, route };
