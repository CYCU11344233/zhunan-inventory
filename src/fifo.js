/*
 * src/fifo.js — 先進先出（FIFO）分配，純函式，不碰資料庫，方便單獨測試
 *
 * allocate(candidates, need, reserved)
 *   candidates：某品項所有還有貨的庫存堆，「已經」依入庫日 → 批次編號排好（最舊的在前）
 *               [{ batchId, slotId, qty, inDate }]
 *   need：要幾籠
 *   reserved：同一張出貨單前面幾項已經預定的 { slotId: 籠數 }（會被更新）
 * 回傳 { plan: [{ slotId, batchId, inDate, qty }], shortage: 還差幾籠 }
 *
 * 「拿哪批」（FIFO）和「怎麼走」（依櫃位排路線）是兩件事：這裡只管拿哪批，路線由 walkSort 排。
 */
function allocate(candidates, need, reserved = {}) {
  const plan = [];
  let remain = need;
  for (const c of candidates) {
    if (remain <= 0) break;
    const avail = c.qty - (reserved[c.slotId] || 0);
    if (avail <= 0) continue;
    const take = Math.min(avail, remain);
    plan.push({ slotId: c.slotId, batchId: c.batchId, inDate: c.inDate, qty: take });
    reserved[c.slotId] = (reserved[c.slotId] || 0) + take;
    remain -= take;
  }
  return { plan, shortage: remain };
}

// 走路順序：依冷凍庫順序 → 排 → 層（從入口往裡走）
// slotInfo：{ 'A-03-2': { sortNo, row, level } }
function walkSort(items, slotInfo) {
  return [...items].sort((a, b) => {
    const sa = slotInfo[a.slotId], sb = slotInfo[b.slotId];
    return sa.sortNo - sb.sortNo || sa.row - sb.row || sa.level - sb.level;
  });
}

module.exports = { allocate, walkSort };
