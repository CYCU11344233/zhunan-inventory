/*
 * src/db.js — 資料庫連線
 *
 * 提供兩樣東西給其他檔案用：
 *   pool             MySQL 連線池。只讀資料時直接 pool.query(...)
 *   withTransaction  會改資料的動作都包在這裡：中間任何一句 SQL 失敗，整個退回（rollback），
 *                    不會出現「庫存扣了、紀錄沒寫」這種半套的狀況
 *
 * 用法：
 *   const { pool, withTransaction } = require('./db');
 *   const [rows] = await pool.query('SELECT * FROM product WHERE id = ?', [1]);
 *   await withTransaction(async (conn) => {
 *     await conn.query('UPDATE stock SET qty = qty - ? WHERE ...', [3]);
 *     await conn.query('INSERT INTO movement ...');
 *   });
 */
require('dotenv').config();              // 讀 .env（帳密、TZ），一定要最先執行
const mysql = require('mysql2/promise');

// 目前時區和 UTC 差多少，轉成 MySQL 看得懂的 '+08:00'
function tzOffset() {
  const min = -new Date().getTimezoneOffset();
  const sign = min >= 0 ? '+' : '-';
  const abs = Math.abs(min);
  return `${sign}${String(Math.floor(abs / 60)).padStart(2, '0')}:${String(abs % 60).padStart(2, '0')}`;
}

// 所有連線共用的設定（db/init.js 也會用到，所以抽出來）
function connectionConfig(extra = {}) {
  return {
    host: process.env.DB_HOST || 'localhost',
    port: Number(process.env.DB_PORT) || 3306,
    user: process.env.DB_USER || 'root',
    password: process.env.DB_PASSWORD || '',
    charset: 'utf8mb4',
    // 日期一律當字串 'YYYY-MM-DD' 回來，不要讓驅動轉成 Date 物件（會差 8 小時變成前一天）
    dateStrings: true,
    timezone: 'local',
    ...extra,
  };
}

const pool = mysql.createPool(connectionConfig({
  database: process.env.DB_NAME || 'zhunan',
  connectionLimit: 10,
}));

// 每條新連線都把 MySQL 的時區設成和 Node 一樣，這樣 CURRENT_TIMESTAMP 記的是台灣時間
pool.pool.on('connection', (conn) => {
  conn.query(`SET time_zone = '${tzOffset()}'`);
});

// 開一條單獨的連線（db/init.js、db/seed.js 用），時區一樣設好
async function connect(extra = {}) {
  const conn = await mysql.createConnection(connectionConfig(extra));
  await conn.query(`SET time_zone = '${tzOffset()}'`);
  return conn;
}

// 開交易 → 執行 fn(conn) → 成功就 commit，失敗就 rollback 並把錯誤往外丟
async function withTransaction(fn) {
  const conn = await pool.getConnection();
  try {
    await conn.beginTransaction();
    const result = await fn(conn);
    await conn.commit();
    return result;
  } catch (err) {
    await conn.rollback();
    throw err;
  } finally {
    conn.release();
  }
}

module.exports = { pool, withTransaction, connect, connectionConfig, tzOffset };
