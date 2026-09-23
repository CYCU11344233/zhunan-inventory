/*
 * db/seed.js — 灌 Demo 那套假庫存（npm run seed）
 *
 * 產生的資料和 docs/demo/index.html 開起來看到的「一模一樣」：同樣的亂數種子、同樣的抽籤順序，
 * 所以哪種菜、幾籠、放哪一格、幾天前入庫、哪批超期，全部對得上，報告時好對照。
 * 唯一不同：批次編號照技術方案 §4.3 改成「入庫日-當日流水號」（Demo 是全域流水號）。
 *
 * 安全機制：資料庫裡只要已經有任何批次，就拒絕執行，避免把真資料和假資料混在一起。
 * 想重來：npm run db:reset && npm run seed
 *
 * 寫進資料庫的方式和正式操作一樣：batch → stock → movement，
 * 全部掛在一個 kind = 'init'（期初資料）的 action 底下，所以「復原」按鈕不會把期初庫存退掉。
 */
const { connect } = require('../src/db');

/* ---------- 日期小工具（一律用本地日期，避免時區差一天） ---------- */
const pad = (n) => String(n).padStart(2, '0');
const fmt = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
const parse = (s) => { const [y, m, d] = s.split('-').map(Number); return new Date(y, m - 1, d); };
const addDays = (s, n) => { const d = parse(s); d.setDate(d.getDate() + n); return fmt(d); };

// 36 格的順序要和 Demo 一樣（A 庫 → B 庫、第 1 排 → 第 6 排、第 1 層 → 第 3 層），洗牌結果才會一樣
function slotIds() {
  const ids = [];
  for (const wh of ['A', 'B']) for (let r = 1; r <= 6; r++) for (let l = 1; l <= 3; l++) ids.push(`${wh}-${pad(r)}-${l}`);
  return ids;
}

/*
 * 產生假資料（純函式，不碰資料庫，方便測試）
 *   products：[{ id, name, shelfDays }]，要和 Demo 的 20 種菜同順序
 *   today：'YYYY-MM-DD'
 * 回傳 { batches: [{ id, productId, inDate, expireDate }],
 *        stocks:  [{ batchId, slotId, qty }],
 *        movements: [{ time, productId, productName, batchId, slotId, qty, note }] }
 */
function buildDemoData(products, today) {
  const product = (id) => products.find((p) => p.id === id);

  // 和 Demo 同一個亂數產生器（mulberry32）、同一個種子
  let rs = 20260921;
  const rand = () => { rs = (rs + 0x6D2B79F5) | 0; let t = Math.imul(rs ^ (rs >>> 15), 1 | rs); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
  const randInt = (a, b) => a + Math.floor(rand() * (b - a + 1));

  // 洗牌，讓貨隨機散在兩庫
  const pool = slotIds();
  for (let i = pool.length - 1; i > 0; i--) { const j = randInt(0, i); [pool[i], pool[j]] = [pool[j], pool[i]]; }

  const batches = [], stocks = [], movements = [];
  const seqOfDay = {};   // 每天的批次流水號

  function seedBatch(pid, daysAgo, qty, expireOverride) {
    const inDate = addDays(today, -daysAgo);
    seqOfDay[inDate] = (seqOfDay[inDate] || 0) + 1;
    const b = {
      id: `B${inDate.replace(/-/g, '')}-${pad(seqOfDay[inDate])}`,
      productId: pid,
      inDate,
      expireDate: expireOverride || addDays(inDate, product(pid).shelfDays),
    };
    batches.push(b);
    // 8 籠以上的批次有一半機率拆成兩格（一格放不下）
    const parts = (qty >= 8 && pool.length > 1 && rand() < 0.5) ? [Math.ceil(qty / 2), Math.floor(qty / 2)] : [qty];
    for (const q of parts) {
      const slotId = pool.pop();
      stocks.push({ batchId: b.id, slotId, qty: q });
      movements.push({
        time: `${inDate} 09:00:00`, productId: pid, productName: product(pid).name, batchId: b.id, slotId, qty: q,
        note: '批次 ' + b.id + (expireOverride ? '（自訂到期 ' + expireOverride + '）' : ''),
      });
    }
  }

  // 第一輪：每種菜一批（約 1～2 種剛好賣完，示範缺貨）；入庫日最多到保存期限的 1.15 倍，所以會有超期的
  for (const p of products) {
    if (p.id !== 1 && rand() < 0.15) continue;   // 甘藍菜是個案主角，一定要有貨
    seedBatch(p.id, randInt(0, Math.round(p.shelfDays * 1.15)), randInt(3, 20));
  }
  // 甘藍菜多補兩批不同日期，出庫時可以看到 FIFO 跨批次拿貨
  seedBatch(1, 20, 3); seedBatch(1, 11, 8);
  // 第二輪：把剩下的格子填到剩 6 格左右，做出「同一種菜好幾批、日期不同」的 FIFO 情境
  const stocked = products.filter((p) => batches.some((b) => b.productId === p.id));
  while (pool.length > 6) {
    const p = stocked[randInt(0, stocked.length - 1)];
    seedBatch(p.id, randInt(0, Math.round(p.shelfDays * 0.9)), randInt(3, 15));
  }
  // 外地轉來的一批高麗菜：5 天前才搬進來，但原本的到期日已過 —— 示範「狀態看到期日，不看入庫日」
  seedBatch(2, 5, 6, addDays(today, -2));

  // 紀錄依時間排（同一天的保持產生順序）
  movements.sort((a, b) => (a.time < b.time ? -1 : a.time > b.time ? 1 : 0));
  return { batches, stocks, movements };
}

/*
 * 把假資料寫進資料庫（一個交易，失敗就全部退回）
 *   dbName：要寫進哪個資料庫；today：'YYYY-MM-DD'，不給就用今天
 * 回傳 { batches, stocks, movements } 筆數
 */
async function seed({ dbName = process.env.DB_NAME || 'zhunan', today = fmt(new Date()) } = {}) {
  const conn = await connect({ database: dbName });
  try {
    const [[{ n }]] = await conn.query('SELECT COUNT(*) AS n FROM batch');
    if (n > 0) {
      const err = new Error(`資料庫 ${dbName} 已經有 ${n} 個批次，為了不蓋掉真資料，seed 停止。要重來請先 npm run db:reset`);
      err.code = 'ALREADY_SEEDED';
      throw err;
    }

    // 品項照 id 排序讀出來，順序要和 Demo 一樣（1 甘藍菜 … 20 番茄）
    const [rows] = await conn.query('SELECT id, name, shelf_days FROM product WHERE id BETWEEN 1 AND 20 ORDER BY id');
    if (rows.length !== 20) throw new Error('找不到 20 種基本品項，請先跑 npm run db:init');
    const products = rows.map((r) => ({ id: r.id, name: r.name, shelfDays: r.shelf_days }));

    const data = buildDemoData(products, today);

    await conn.beginTransaction();
    const [a] = await conn.query(
      "INSERT INTO action (label, kind) VALUES (?, 'init')",
      [`期初庫存（Demo 種子資料，${data.batches.length} 批）`],
    );
    for (const b of data.batches) {
      await conn.query('INSERT INTO batch (id, product_id, in_date, expire_date) VALUES (?, ?, ?, ?)',
        [b.id, b.productId, b.inDate, b.expireDate]);
    }
    for (const s of data.stocks) {
      await conn.query('INSERT INTO stock (batch_id, slot_id, qty) VALUES (?, ?, ?)', [s.batchId, s.slotId, s.qty]);
    }
    for (const m of data.movements) {
      await conn.query(
        `INSERT INTO movement (action_id, type, product_id, product_name, batch_id, to_slot_id, qty, note, created_at)
         VALUES (?, '入庫', ?, ?, ?, ?, ?, ?, ?)`,
        [a.insertId, m.productId, m.productName, m.batchId, m.slotId, m.qty, m.note, m.time],
      );
    }
    await conn.commit();
    return { batches: data.batches.length, stocks: data.stocks.length, movements: data.movements.length };
  } catch (err) {
    await conn.rollback().catch(() => {});
    throw err;
  } finally {
    await conn.end();
  }
}

module.exports = { buildDemoData, seed };

// 直接執行（npm run seed）時才跑這段
if (require.main === module) {
  seed()
    .then((r) => {
      console.log(`✔ 已灌入 Demo 假庫存：${r.batches} 個批次、佔 ${r.stocks} 格、${r.movements} 筆入庫紀錄`);
      process.exit(0);
    })
    .catch((err) => {
      console.error('✘ seed 失敗：', err.message);
      process.exit(1);
    });
}
