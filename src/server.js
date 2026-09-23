/*
 * src/server.js — 網頁伺服器（npm start）
 *
 * 做三件事：
 *   1. 提供 public/ 裡的網頁（index.html、app.js、api.js）
 *   2. 掛上 /api/… 的各個功能（每個功能一個檔案，放在 src/routes/）
 *   3. 在 PORT（預設 3000）開始聽，手機連同一個 Wi-Fi 開 http://<電腦IP>:3000 也能用
 */
require('dotenv').config();
const path = require('path');
const os = require('os');
const express = require('express');

const app = express();
app.use(express.json());                                         // 讀 JSON 格式的請求內容
app.use(express.static(path.join(__dirname, '..', 'public')));   // 網頁本體

// ---------- API ----------
app.use('/api', require('./routes/state'));       // GET /api/state
app.use('/api', require('./routes/movements'));   // GET /api/movements
app.use('/api', require('./routes/inbound'));     // POST /api/inbound
app.use('/api', require('./routes/outbound'));    // POST /api/outbound/plan、/api/outbound/confirm
app.use('/api', require('./routes/slots'));       // POST /api/transfer、/api/adjust、/api/discard
app.use('/api', require('./routes/products'));    // POST / PUT / DELETE /api/products
app.use('/api', require('./routes/undo'));        // POST /api/undo、/api/redo

// 找不到的 API
app.use('/api', (req, res) => res.status(404).json({ error: `沒有這個功能：${req.method} ${req.originalUrl}` }));

// 任何沒被接住的錯誤：印在終端機，回 500 給前端顯示
// （使用者操作錯誤會在各 route 自己回 400，不會走到這裡）
app.use((err, req, res, next) => {   // eslint-disable-line no-unused-vars
  console.error(err);
  res.status(500).json({ error: '伺服器出錯了：' + err.message });
});

module.exports = app;

// 直接執行（npm start）時才開始聽；被測試 require 時不自動開
if (require.main === module) {
  const port = Number(process.env.PORT) || 3000;
  app.listen(port, () => {
    console.log(`✔ 竹南冷凍倉儲 庫存系統已啟動：http://localhost:${port}`);
    // 列出這台電腦在區網的 IP，方便手機 / 平板連線
    for (const list of Object.values(os.networkInterfaces())) {
      for (const n of list || []) {
        if (n.family === 'IPv4' && !n.internal) console.log(`  手機 / 平板（同一個 Wi-Fi）：http://${n.address}:${port}`);
      }
    }
  });
}
