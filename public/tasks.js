/* =====================================================================
   public/tasks.js — 系統維護 2.0 的畫面（docs/04-系統維護.md）

   1. 提醒列（每一頁最上面）：還沒回報的單、今天還沒盤點的庫
   2. 待回報的單（入／出庫頁最上面）：揀貨單、放貨單逐站打勾（指差確認）→ 全部打勾才能回報
      放貨單可以改「實際放哪一格」；單子也可以取消
   3. 盤點頁：一次盤一整座庫，逐格點數；只填不一樣的和壞掉的（壞掉一定要選原因）
   4. 作業統計（紀錄頁下面）：最近 7 天發單到回報平均幾分鐘、盤點了幾天、差異與報廢
   資料都在 app.js 的 reload() 抓好（openPicks、openPuts、lastStocktakes、stocktakes、statsInfo）。
   ===================================================================== */

/* ===================== 1. 提醒列 ===================== */
function renderAlerts() {
  const orders = [...openPicks, ...openPuts];
  const html = [];
  if (orders.length) {
    const late = orders.filter(o => o.minutes >= pendingWarn);
    const oldest = Math.max(...orders.map(o => o.minutes));
    html.push(`<div class="alert ${late.length ? 'danger' : ''}">
      <span>⚠ 還有 <b>${orders.length}</b> 張單沒回報（最久 ${oldest} 分鐘${late.length ? `，${late.length} 張超過 ${pendingWarn} 分鐘` : ''}）。
      搬完、放好沒回報，系統的庫存就會和倉庫不一樣。</span>
      <button onclick="showPending()">去回報</button></div>`);
  }
  const todayStr = fmt(today);
  const notYet = WH.filter(w => !lastStocktakes[w] || lastStocktakes[w].time.slice(0, 10) !== todayStr);
  if (notYet.length) {
    html.push(`<div class="alert info"><span>📋 今天還沒盤點：${notYet.map(w => `${w} 庫`).join('、')}（李太太要求每天一次）</span>
      <button onclick="countWh='${notYet[0]}';renderCount();goto('count')">去盤點</button></div>`);
  }
  document.getElementById('alerts').innerHTML = html.join('');
}

/* ===================== 2. 待回報的單 ===================== */
let openOrder = null;   // 展開哪一張：'pick-3' / 'put-2'（一次只展開一張）
const checks = {};      // 已打勾的站：{ 'pick-3': Set([1, 2]) }
const placeAlt = {};    // 放貨單改放別格：{ 'put-2': { 2: 'B-04-1' } }
let cancelArmed = null; // 取消要按兩次，避免手套誤觸

function showPending() {
  goto('io');
  const card = document.getElementById('pendingCard');
  if (card.style.display !== 'none') card.scrollIntoView({ behavior: 'smooth', block: 'start' });
}
const orderList = () => [...openPuts.map(o => ({ ...o, kind: 'put' })), ...openPicks.map(o => ({ ...o, kind: 'pick' }))]
  .sort((a, b) => (a.createdAt < b.createdAt ? -1 : a.createdAt > b.createdAt ? 1 : a.id - b.id));   // 舊的單排前面
const keyOf = (o) => `${o.kind}-${o.id}`;
const placedOf = (o, l) => (placeAlt[keyOf(o)] || {})[l.seq] || l.slotId;

function renderPending() {
  renderAlerts();
  const list = orderList();
  const card = document.getElementById('pendingCard');
  card.style.display = list.length ? '' : 'none';
  if (!list.length) { openOrder = null; return; }
  if (!list.some(o => keyOf(o) === openOrder)) openOrder = list.length === 1 ? keyOf(list[0]) : openOrder;
  document.getElementById('pendingList').innerHTML = list.map(orderHTML).join('');
}

function orderHTML(o) {
  const key = keyOf(o), open = openOrder === key, done = checks[key] || new Set();
  const late = o.minutes >= pendingWarn;
  const head = `<div class="ohead" onclick="openOrder=openOrder==='${key}'?null:'${key}';renderPending()">
      <span class="kind ${o.kind}">${o.kind === 'pick' ? '揀貨單' : '放貨單'} #${o.id}</span>
      <b>${esc(o.label)}</b>
      <span class="hint age">${o.createdAt.slice(11)} 發單・${o.minutes} 分鐘前</span>
      <span class="prog">${done.size} / ${o.lines.length} 站 ${open ? '▴' : '▾'}</span></div>`;
  if (!open) return `<div class="order ${late ? 'late' : ''}">${head}</div>`;

  const stops = o.lines.map(l => {
    const ok = done.has(l.seq);
    let what;
    if (o.kind === 'pick') {
      what = `去 <b>${l.slotId}</b> 拿 <b>${esc(l.productName)} ${l.qty} 籠</b><br>
        <span class="hint">批次 ${l.batchId}（${l.inDate} 入庫，最舊的先出）</span>`;
    } else {
      const at = placedOf(o, l);
      // 可以改放的格子：原定的 + 現在空著、沒被別張單預定的
      const choices = [l.slotId, ...freeSlots().map(x => x.id).filter(id => id !== l.slotId)];
      what = `把 <b>${esc(l.productName)} ${l.qty} 籠</b> 放到 <b>${at}</b>${at !== l.slotId ? `（原定 ${l.slotId}）` : ''}<br>
        <span class="hint">到期 ${l.expireDate}</span>
        ${ok ? '' : `<br><select onchange="setPlace('${key}', ${l.seq}, this.value)">
          ${choices.map(id => `<option value="${id}" ${id === at ? 'selected' : ''}>${id === l.slotId ? `照原定放 ${id}` : `實際放到 ${id}`}</option>`).join('')}
        </select>`}`;
    }
    return `<div class="stop ${ok ? 'done' : ''}">
      <button class="chk" onclick="toggleStop('${key}', ${l.seq})" title="${o.kind === 'pick' ? '拿好了' : '放好了'}">${ok ? '✔' : l.seq}</button>
      <div class="what">${what}</div></div>`;
  }).join('');
  const hl = {}; o.lines.forEach(l => hl[o.kind === 'put' ? placedOf(o, l) : l.slotId] = l.seq);
  const all = done.size === o.lines.length;
  return `<div class="order open ${late ? 'late' : ''}">${head}<div class="obody">
    ${stops}
    <div class="route">${mapHTML({ highlight: hl })}</div>
    <div class="obtns">
      <button class="btn" ${all ? '' : 'disabled'} onclick="confirmOrder('${key}')">✔ ${o.kind === 'pick' ? '全部拿好了，回報出庫' : '全部放好了，回報入庫'}</button>
      <button class="btn secondary" onclick="cancelOrder('${key}')">${cancelArmed === key ? '再按一次確定取消' : '取消這張單'}</button>
      ${all ? '' : `<span class="hint">每一站${o.kind === 'pick' ? '拿好' : '放好'}就按左邊的圓圈打勾</span>`}
    </div></div></div>`;
}

function toggleStop(key, seq) {
  const s = checks[key] = checks[key] || new Set();
  s.has(seq) ? s.delete(seq) : s.add(seq);
  cancelArmed = null;
  renderPending();
}
function setPlace(key, seq, slot) {
  (placeAlt[key] = placeAlt[key] || {})[seq] = slot;
  renderPending();
}
function confirmOrder(key) {
  const [kind, id] = key.split('-');
  const o = orderList().find(x => keyOf(x) === key);
  if (!o) return;
  const body = kind === 'put'
    ? { placements: o.lines.filter(l => placedOf(o, l) !== l.slotId).map(l => ({ seq: l.seq, slotId: placedOf(o, l) })) }
    : undefined;
  return send(async () => {
    await api.post(`/api/${kind === 'pick' ? 'picks' : 'puts'}/${id}/confirm`, body);
    delete checks[key]; delete placeAlt[key]; openOrder = null;
    await reload();
    toast(kind === 'pick' ? `揀貨單 #${id} 已回報，庫存已扣除` : `放貨單 #${id} 已回報，貨已入庫`);
  });
}
function cancelOrder(key) {
  if (cancelArmed !== key) { cancelArmed = key; return renderPending(); }
  const [kind, id] = key.split('-');
  cancelArmed = null;
  return send(async () => {
    await api.post(`/api/${kind === 'pick' ? 'picks' : 'puts'}/${id}/cancel`);
    delete checks[key]; delete placeAlt[key]; openOrder = null;
    await reload();
    toast(`${kind === 'pick' ? '揀貨單' : '放貨單'} #${id} 已取消，保留的${kind === 'pick' ? '貨' : '格子'}已放回`);
  });
}

/* ===================== 3. 盤點 ===================== */
let countWh = null;
const countInput = {};   // { A: { 'A-01-2': { counted, spoiled, reason, other } } }
const REASONS = ['腐爛', '凍傷', '包裝破損', '超期', '其他'];

function countRowsOf(wh) {
  return stocks.filter(s => s.qty > 0 && s.slotId[0] === wh).sort(walkOrder).map(s => {
    const inp = (countInput[wh] || {})[s.slotId] || {};
    return { s, b: batchOf(s), p: productOfStock(s), counted: inp.counted ?? s.qty, spoiled: inp.spoiled ?? 0, reason: inp.reason || '腐爛', other: inp.other || '' };
  });
}
function setCount(sid, field, val) {
  document.getElementById('countResult').innerHTML = '';   // 開始改下一次盤點，上一次的結果收起來
  const wh = sid[0];
  const cur = (countInput[wh] = countInput[wh] || {})[sid] = countInput[wh][sid] || {};
  const st = stockAt(sid);
  if (field === 'counted' || field === 'spoiled') {
    let v = Math.max(0, parseInt(val, 10) || 0);
    cur[field] = v;
    const counted = cur.counted ?? st.qty;
    if ((cur.spoiled || 0) > counted) cur.spoiled = counted;
  } else cur[field] = val;
}
function bumpCount(sid, field, n) {
  const st = stockAt(sid);
  const cur = ((countInput[sid[0]] || {})[sid]) || {};
  const base = field === 'counted' ? (cur.counted ?? st.qty) : (cur.spoiled || 0);
  setCount(sid, field, base + n);
  renderCount();
}

function renderCount() {
  if (!WH.length) return;
  if (!countWh || !WH.includes(countWh)) countWh = WH[0];
  const todayStr = fmt(today);
  document.getElementById('countTabs').innerHTML = WH.map(w => {
    const t = lastStocktakes[w];
    const when = !t ? '還沒盤過' : t.time.slice(0, 10) === todayStr ? `今天 ${t.time.slice(11)} 盤過 ✓` : `上次 ${t.time.slice(5, 10)}`;
    return `<button class="${w === countWh ? 'active' : ''}" onclick="countWh='${w}';renderCount()">${w} 庫（${when}）</button>`;
  }).join('');
  const rows = countRowsOf(countWh);
  document.getElementById('countRows').innerHTML = rows.length ? rows.map(r => {
    const sid = r.s.slotId, diff = r.counted !== r.s.qty;
    return `<div class="crow ${r.spoiled ? 'spoil' : diff ? 'chg' : ''}" id="crow-${sid}">
      <div class="cslot"><b>${sid}</b><span class="dot" style="background:${r.p.color}"></span>${esc(r.p.name)}<br>
        <span class="hint">批次 ${r.b.id}・系統 <b>${r.s.qty}</b> 籠${pickHold[sid] ? `・揀#${pickHold[sid].join(',')} 保留中` : ''}</span></div>
      <div><label>實際點到</label><div class="qty-ctl">
        <button onclick="bumpCount('${sid}','counted',-1)">－</button>
        <input type="number" min="0" value="${r.counted}" onchange="setCount('${sid}','counted',this.value);renderCount()">
        <button onclick="bumpCount('${sid}','counted',1)">＋</button></div></div>
      <div><label>其中壞掉</label><div class="qty-ctl">
        <button onclick="bumpCount('${sid}','spoiled',-1)">－</button>
        <input type="number" min="0" value="${r.spoiled}" onchange="setCount('${sid}','spoiled',this.value);renderCount()">
        <button onclick="bumpCount('${sid}','spoiled',1)">＋</button></div></div>
      <div class="creason">${r.spoiled ? `<label>壞掉原因</label>
        <select onchange="setCount('${sid}','reason',this.value);renderCount()">${REASONS.map(x => `<option ${x === r.reason ? 'selected' : ''}>${x}</option>`).join('')}</select>
        ${r.reason === '其他' ? `<input type="text" maxlength="40" placeholder="寫原因" value="${esc(r.other)}" oninput="setCount('${sid}','other',this.value)" style="margin-top:6px">` : ''}`
        : (diff ? `<span class="hint">差 ${r.counted - r.s.qty > 0 ? '+' : ''}${r.counted - r.s.qty} 籠</span>` : '<span class="hint">✓ 一致</span>')}</div>
    </div>`;
  }).join('') : `<div class="empty">${countWh} 庫目前沒有貨，按下面的按鈕記一筆「已盤點」即可。</div>`;

  const diffs = rows.filter(r => r.counted !== r.s.qty).length, spoiled = rows.reduce((a, r) => a + r.spoiled, 0);
  document.getElementById('countSummary').innerHTML =
    `共 <b>${rows.length}</b> 格：一致 <b>${rows.length - diffs}</b> 格、數量不符 <b style="color:${diffs ? 'var(--warn)' : 'inherit'}">${diffs}</b> 格、報廢 <b style="color:${spoiled ? 'var(--danger)' : 'inherit'}">${spoiled}</b> 籠`;
  document.getElementById('countBtn').textContent = diffs || spoiled
    ? `✔ 完成 ${countWh} 庫盤點，更新庫存` : `✔ 全部一致，完成 ${countWh} 庫盤點`;
  renderCountHistory();
}

function submitCount() {
  const wh = countWh, rows = countRowsOf(wh);
  const counts = [];
  for (const r of rows) {
    if (r.counted === r.s.qty && !r.spoiled) continue;
    const reason = r.reason === '其他' ? r.other.trim() : r.reason;
    if (r.spoiled && !reason) return toast(`${r.s.slotId}：請寫壞掉的原因`);
    counts.push({ slotId: r.s.slotId, counted: r.counted, spoiled: r.spoiled, reason: r.spoiled ? reason : undefined });
  }
  return send(async () => {
    const res = await api.post('/api/stocktakes', { warehouse: wh, counts });
    delete countInput[wh];
    await reload();
    document.getElementById('countResult').innerHTML = `<div class="alert ${res.warnings.length ? 'danger' : 'info'}" style="margin-top:12px"><span>
      ✔ ${wh} 庫盤點完成（#${res.id}）：盤了 ${res.slotCount} 格，數量不符 ${res.diffCount} 格，報廢 ${res.spoiledQty} 籠。
      ${res.changed ? '庫存已更新，按錯了可以到「紀錄」復原。' : '庫存完全正確，沒有改任何東西。'}
      ${res.warnings.map(w => `<br>⚠ ${esc(w)}`).join('')}</span></div>`;
    toast(`${wh} 庫盤點完成`);
  });
}

const openTake = {};   // 展開了哪幾筆盤點紀錄的明細 { id: lines }
function renderCountHistory() {
  document.getElementById('countHistory').innerHTML = stocktakes.length ? `<div style="overflow-x:auto"><table>
    <thead><tr><th>時間</th><th>倉庫</th><th>盤了</th><th>不符</th><th>報廢</th><th></th></tr></thead><tbody>
    ${stocktakes.map(t => `<tr class="${t.undone ? 'undone' : ''}" style="cursor:pointer" onclick="toggleTake(${t.id})">
      <td>${t.time}</td><td>${t.warehouse} 庫</td><td>${t.slotCount} 格</td>
      <td>${t.diffCount ? `<b style="color:var(--warn)">${t.diffCount} 格</b>` : '0'}</td>
      <td>${t.spoiledQty ? `<b style="color:var(--danger)">${t.spoiledQty} 籠</b>` : '0'}</td>
      <td>${t.undone ? '<span class="tag none">已復原</span>' : ''} ${openTake[t.id] ? '▴' : '▾'}</td></tr>
      ${openTake[t.id] ? `<tr><td colspan="6" class="hint">${takeDetail(openTake[t.id])}</td></tr>` : ''}`).join('')}
    </tbody></table></div>` : '<div class="empty">還沒有盤點紀錄</div>';
}
function takeDetail(d) {
  const odd = d.lines.filter(l => l.countedQty !== l.systemQty || l.spoiledQty);
  return (odd.length ? odd.map(l => `${l.slotId} ${esc(l.productName)}：系統 ${l.systemQty} → 實際 ${l.countedQty}` +
    (l.spoiledQty ? `，壞掉 ${l.spoiledQty}（${esc(l.reason)}）` : '')).join('<br>') + '<br>' : '') +
    `其餘 ${d.lines.length - odd.length} 格一致`;
}
function toggleTake(id) {
  if (openTake[id]) { delete openTake[id]; return renderCountHistory(); }
  return send(async () => { openTake[id] = await api.get(`/api/stocktakes/${id}`); renderCountHistory(); });
}

/* ===================== 4. 作業統計 ===================== */
function renderStats() {
  const s = statsInfo;
  if (!s) return;
  const t = (x) => x == null ? '—' : `${x}<small> 分鐘</small>`;
  const kpi = (v, k, bad) => `<div class="kpi ${bad ? 'bad' : ''}"><div class="v">${v}</div><div class="k">${k}</div></div>`;
  document.getElementById('statsBox').innerHTML = [
    kpi(`${s.picks.done}<small> 張</small>`, `揀貨單完成（取消 ${s.picks.cancelled}、未回報 ${s.picks.open}）`),
    kpi(t(s.picks.medianMinutes), `揀貨：發單到回報（中位數；平均 ${s.picks.avgMinutes ?? '—'}、最久 ${s.picks.maxMinutes ?? '—'}）`),
    kpi(`${s.puts.done}<small> 張</small>`, `放貨單完成（取消 ${s.puts.cancelled}、未回報 ${s.puts.open}）`),
    kpi(t(s.puts.medianMinutes), `放貨：發單到回報（中位數；平均 ${s.puts.avgMinutes ?? '—'}、最久 ${s.puts.maxMinutes ?? '—'}）`),
    kpi(`${s.picks.overdue + s.puts.overdue}<small> 張</small>`, `超過 ${pendingWarn} 分鐘還沒回報`, s.picks.overdue + s.puts.overdue > 0),
    ...WH.map(w => kpi(`${s.stocktakes[w].daysCovered}<small> / ${s.days} 天</small>`, `${w} 庫有盤點的天數`, s.stocktakes[w].daysCovered < s.days)),
    kpi(`${s.discrepancy.count}<small> 格</small>`, `盤點發現數量不符（共差 ${s.discrepancy.qty} 籠）`, s.discrepancy.count > 0),
    kpi(`${s.spoiled.qty}<small> 籠</small>`, `丟棄／報廢（${s.spoiled.count} 次）`),
  ].join('');
}

/* ===================== 開頁面 ===================== */
// 先從資料庫抓資料再畫；連不上就把原因顯示在畫面上
reload().catch((e) => {
  document.querySelector('main').innerHTML =
    `<div class="card" style="color:var(--danger)"><b>讀不到資料：</b>${esc(e.message)}<br><span class="hint">確認伺服器（npm start）和 MySQL 都有開著，再重新整理頁面。</span></div>`;
});
// 每分鐘自動重抓一次：「幾分鐘前」會更新，別台平板發的單、盤點也會出現
// 正在打字、開著對話框時不打擾
setInterval(() => {
  if (document.hidden) return;
  const a = document.activeElement;
  if (a && ['INPUT', 'SELECT', 'TEXTAREA'].includes(a.tagName)) return;
  if (document.querySelector('.modal-bg.show') || sheetSid || dragFrom) return;
  reload().catch(() => {});
}, 60000);
