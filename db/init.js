/*
 * db/init.js — 建資料庫（跑 db/schema.sql）
 *
 *   npm run db:init     建資料庫、建表、塞主檔。已經建過就跳過，不會動到現有資料
 *   npm run db:reset    先整個刪掉資料庫再重建（開發用，會清空所有庫存與紀錄！）
 *
 * 和「mysql -u root -p < db/schema.sql」效果一樣，好處是不用另外裝 mysql 指令列工具。
 * 測試（test/）也用這支來建一個獨立的 zhunan_test 資料庫，不會碰到正式資料。
 */
const fs = require('fs');
const path = require('path');
const { connect } = require('../src/db');

const SCHEMA_FILE = path.join(__dirname, 'schema.sql');

// 讀 schema.sql，把裡面的資料庫名稱 zhunan 換成指定的名稱（測試時用 zhunan_test）
function schemaFor(dbName) {
  if (!/^[A-Za-z0-9_]+$/.test(dbName)) throw new Error(`資料庫名稱只能用英文、數字、底線：${dbName}`);
  return fs.readFileSync(SCHEMA_FILE, 'utf8')
    .replace(/CREATE DATABASE IF NOT EXISTS zhunan\b/, `CREATE DATABASE IF NOT EXISTS ${dbName}`)
    .replace(/USE zhunan;/, `USE ${dbName};`);
}

// name：資料庫名稱；reset：true 就先 DROP 再建
async function initDatabase({ name = process.env.DB_NAME || 'zhunan', reset = false } = {}) {
  // 還沒有資料庫，所以連線時不指定 database；multipleStatements 讓整份 SQL 一次送出
  const conn = await connect({ multipleStatements: true });
  try {
    if (reset) await conn.query(`DROP DATABASE IF EXISTS ${name}`);
    await conn.query(schemaFor(name));
  } finally {
    await conn.end();
  }
}

module.exports = { initDatabase };

// 直接執行（npm run db:init / db:reset）時才跑這段；被 require 時不跑
if (require.main === module) {
  const reset = process.argv.includes('--reset');
  const name = process.env.DB_NAME || 'zhunan';
  initDatabase({ name, reset })
    .then(() => {
      console.log(reset ? `✔ 已清空並重建資料庫 ${name}` : `✔ 資料庫 ${name} 已就緒（已存在的資料沒有動）`);
      console.log('  主檔：2 座冷凍庫、36 個櫃位、20 種品項。要灌 Demo 假庫存請跑 npm run seed');
      process.exit(0);
    })
    .catch((err) => {
      console.error('✘ 建資料庫失敗：', err.message);
      if (err.code === 'ER_ACCESS_DENIED_ERROR') console.error('  → 檢查 .env 的 DB_USER / DB_PASSWORD');
      if (err.code === 'ECONNREFUSED') console.error('  → MySQL 沒有啟動，或 .env 的 DB_HOST / DB_PORT 不對');
      process.exit(1);
    });
}
