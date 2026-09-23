/* =====================================================================
   public/app.js — 畫面與操作（由 docs/demo/index.html 的程式搬過來）

   資料層：從後端讀 MySQL 的資料（reload()），欄位和 Demo 一模一樣，所以下面畫圖的程式都沒改：
     products  品項      { id, name, shelfDays, color, deleted }   含已刪除的（舊紀錄查名稱用）
     slots     櫃位      { id, wh, row, level }     id 格式 "A-03-2" = A庫 第3排 第2層
     batches   批次      { id, productId, inDate, expireDate }   FIFO 的單位；到期日可自訂
     stocks    庫存堆    { batchId, slotId, qty }   一批貨放在某一格（一批可拆放多格）
     movements 異動紀錄  { id, time, type, product, qty, slot, note, undone }

   寫入：每個會改資料的動作都呼叫後端 API（入庫、出庫、移位、盤點、丟棄、品項、復原），
     成功後 reload() 重抓資料重畫，所以畫面永遠等於資料庫。畫面與操作方式和 Demo 一樣。
   ===================================================================== */
let WH = [], ROWS = 6, LEVELS = 3;                 // 庫別、排數、層數：由資料庫的 warehouse 表決定
let today = new Date(); today.setHours(0, 0, 0, 0);   // reload() 會換成伺服器的「今天」
const fmt = (date) => `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;   // 用本地日期，避免時區差一天
const parseDate = (s) => { const [y, m, d] = s.split('-').map(Number); return new Date(y, m - 1, d); };
const addDays = (dateStr, n) => { const x = parseDate(dateStr); x.setDate(x.getDate() + n); return fmt(x); };
const daysBetween = (a, b) => Math.round((parseDate(b) - parseDate(a)) / 86400000);
const pad = (n) => String(n).padStart(2, '0');
const slotId = (wh, row, level) => `${wh}-${pad(row)}-${level}`;

let products = [], slots = [], batches = [], stocks = [], movements = [];
const product = (id) => products.find(p => p.id === id);
const activeProducts = () => products.filter(p => !p.deleted);   // 刪除是軟刪除：舊批次、舊紀錄還查得到
// 新增品項時可選的顏色（先列現有品項的顏色，再補幾個，系統會自動挑沒用過的）
let PALETTE = [];
let undoInfo = { canUndo: false, canRedo: false };   // 復原 / 重做按鈕的狀態（後端算好的）

// 異動紀錄：後端的欄位 → 畫面「紀錄」表格要的欄位
function toLogRow(m) {
  const slot = m.fromSlotId && m.toSlotId ? `${m.fromSlotId} → ${m.toSlotId}` : (m.fromSlotId || m.toSlotId || '—');
  // 盤點：從格子扣掉顯示負數（系統 8 → 實際 6 顯示 -2）
  const qty = m.qty == null ? '—' : (m.type === '盤點' && m.fromSlotId && !m.toSlotId ? -m.qty : m.qty);
  return { id: m.id, time: m.time, type: m.type, product: m.productName || '', qty, slot, note: m.note || '', undone: m.undone };
}

// 從後端重抓全部資料，然後重畫整個畫面
async function reload() {
  const [s, ms] = await Promise.all([api.get('/api/state'), api.get('/api/movements?limit=500')]);
  today = parseDate(s.today);
  WH = s.warehouses.map(w => w.code);
  ROWS = Math.max(...s.warehouses.map(w => w.rows));
  LEVELS = Math.max(...s.warehouses.map(w => w.levels));
  products = s.allProducts;
  slots = s.slots;
  batches = s.batches;
  stocks = s.stocks;
  movements = ms.reverse().map(toLogRow);   // 後端新的在前；畫面要舊的在前（renderLog 會自己倒過來）
  PALETTE = [...new Set([...products.map(p => p.color), '#0097a7', '#c2185b', '#fbc02d', '#455a64', '#7cb342', '#ff7043', '#3949ab', '#795548'])];
  undoInfo = s.undo;
  renderAll();
}

/* ===================== 共用查詢 ===================== */
const stockAt = (sid) => stocks.find(s => s.slotId === sid && s.qty > 0);
const batchOf = (s) => batches.find(b => b.id === s.batchId);
const productOfStock = (s) => product(batchOf(s).productId);
const emptySlots = () => slots.filter(sl => !stockAt(sl.id));
const slotObj = (sid) => slots.find(s => s.id === sid);
const stockQty = (pid) => stocks.filter(s => s.qty > 0 && batchOf(s).productId === pid).reduce((a, s) => a + s.qty, 0);

/* ===================== 復原 / 重做 =====================
   由後端處理（技術方案 §5.3）：復原 = 把上一個動作的每筆異動反向套用；紀錄不刪，只標記並補一筆「復原」。 */
// 送出一個動作：失敗時把後端的中文錯誤訊息顯示出來
async function send(fn) {
  try { return await fn(); } catch (e) { toast(e.message); }
}
function undo() {
  return send(async () => {
    if (!undoInfo.canUndo) return toast('沒有可以復原的動作');
    const r = await api.post('/api/undo');
    hideSheet(); await reload();
    toast(`已復原：${r.label}`);
  });
}
function redo() {
  return send(async () => {
    if (!undoInfo.canRedo) return toast('沒有可以重做的動作');
    const r = await api.post('/api/redo');
    hideSheet(); await reload();
    toast(`已重做：${r.label}`);
  });
}
// Ctrl+Z / Ctrl+Y（在輸入框裡打字時交給瀏覽器，不攔截）
document.addEventListener('keydown', (e) => {
  if (!(e.ctrlKey || e.metaKey)) return;
  if (['input', 'textarea', 'select'].includes((e.target.tagName || '').toLowerCase())) return;
  const k = e.key.toLowerCase();
  if (k === 'z' && !e.shiftKey) { e.preventDefault(); undo(); }
  else if (k === 'y' || (k === 'z' && e.shiftKey)) { e.preventDefault(); redo(); }
});
const byInDate = (a, b) => a.inDate < b.inDate ? -1 : a.inDate > b.inDate ? 1 : a.id < b.id ? -1 : 1;   // FIFO 排序：入庫日 → 批次編號

// 批次狀態：依到期日算，不是依入庫日 —— 這樣自訂到期日的外地菜也能正確判斷
function statusOf(b) {
  const left = daysBetween(fmt(today), b.expireDate);
  const limit = daysBetween(b.inDate, b.expireDate);
  if (left < 0) return { key: 'danger', text: '超期' };
  if (left <= limit * 0.2) return { key: 'warn', text: '快到期' };
  return { key: 'ok', text: '正常' };
}
const ageDays = (b) => daysBetween(b.inDate, fmt(today));
const limitDays = (b) => daysBetween(b.inDate, b.expireDate);
const ageText = (b) => `已放 ${ageDays(b)} 天 / 上限 ${limitDays(b)} 天`;

/* ===================== FIFO =====================
   先進先出由後端用 SQL 排序算（POST /api/outbound/plan），見 src/routes/outbound.js。 */

// 走路順序：同一庫內依「排」再依「層」，從入口（第 1 排）往裡走
const walkOrder = (a, b) => {
  const sa = slotObj(a.slotId), sb = slotObj(b.slotId);
  return sa.wh.localeCompare(sb.wh) || sa.row - sb.row || sa.level - sb.level;
};

/* ===================== 倉庫地圖繪製（共用） =====================
   opts.highlight = { 'A-03-2': 1, 'A-05-1': 2 }  → 只亮這些格並標編號（路線圖用）
   opts.interactive = true → 可點、可右鍵、可拖曳（倉庫地圖頁用）
   opts.wh = 'A' → 只畫這一庫（入庫選格用；之後有 C、D 庫也不會一次全畫）
   opts.pick = { row: 0, chosen: { 'A-02-1': 1 } } → 選格模式：空格可點，已被表單其他項選走的格子標編號
   ================================================================ */
function mapHTML(opts = {}) {
  const hl = opts.highlight || null;
  let html = '';
  for (const wh of WH) {
    if (opts.wh && wh !== opts.wh) continue;
    if (hl && !Object.keys(hl).some(id => id[0] === wh)) continue;   // 路線圖只畫有關的庫
    html += `<div class="wh"><h3>${wh} 庫</h3><div class="wh-map"><div class="entry">入口</div>`;
    for (let r = 1; r <= ROWS; r++) {
      html += '<div class="shelf">';
      for (let l = LEVELS; l >= 1; l--) {          // 第 3 層畫在上面，像真的貨架
        const sid = slotId(wh, r, l);
        const st = stockAt(sid);
        const cls = ['cell'];
        let body = `<b>${pad(r)}-${l}</b><span>空</span>`, style = '';
        if (st) {
          const p = productOfStock(st), stat = statusOf(batchOf(st));
          cls.push('full');
          if (stat.key === 'danger') cls.push('old'); else if (stat.key === 'warn') cls.push('warn');
          style = `style="background:${p.color}"`;
          body = `<b>${pad(r)}-${l}</b><span>${p.name}</span><span>${st.qty} 籠</span>`;
        }
        if (hl && hl[sid]) { cls.push('hl'); body += `<span class="step">${hl[sid]}</span>`; }
        if (opts.interactive && sid === sheetSid) cls.push('sel');
        let ev = '';
        if (opts.interactive) {
          // 每一格都可以當拖曳目標：放到空格 = 移位，放到有貨的格子 = 互換
          ev = `onclick="showCell('${sid}')" oncontextmenu="openModal('${sid}');return false;" ` +
               `ondragover="dragOver(event)" ondragleave="dragLeave(event)" ondrop="drop(event,'${sid}')" ` +
               (st ? `draggable="true" ondragstart="dragStart(event,'${sid}')" ondragend="dragEnd(event)"` : '');
        } else if (opts.pick) {
          const n = opts.pick.chosen[sid];
          if (n) { cls.push('hl'); body += `<span class="step">${n}</span>`; }   // 表單裡選到的格子
          const mine = n === opts.pick.row + 1;
          if (!st && (!n || mine)) { cls.push('pickable'); ev = `onclick="pickSlot(${opts.pick.row}, '${sid}')"`; }   // 空格、且沒被其他項選走
          else if (st) cls.push('taken');
        }
        html += `<div class="${cls.join(' ')}" ${style} ${ev}>${body}</div>`;
      }
      html += `<div class="lbl">第 ${pad(r)} 排</div></div>`;
    }
    html += '</div></div>';
  }
  return html;
}

/* ===================== 畫面：總覽 ===================== */
const ov = { q: '', sort: 'issue', filter: 'all', open: null };   // 品項卡片的搜尋 / 排序 / 篩選 / 展開狀態

function renderOverview() {
  const live = stocks.filter(s => s.qty > 0);
  const total = live.reduce((a, s) => a + s.qty, 0);
  const used = slots.length - emptySlots().length;
  const oldCount = live.filter(s => statusOf(batchOf(s)).key === 'danger').length;
  const inStock = activeProducts().filter(p => live.some(s => batchOf(s).productId === p.id)).length;
  document.getElementById('stats').innerHTML = `
    <div class="card stat"><div class="num">${total}</div><div class="lbl">總籠數</div></div>
    <div class="card stat"><div class="num">${inStock}<small> / ${activeProducts().length}</small></div><div class="lbl">有貨品項</div></div>
    <div class="card stat"><div class="num" style="color:${oldCount ? 'var(--danger)' : 'var(--ok)'}">${oldCount}</div><div class="lbl">超期批次</div></div>`;

  const pct = Math.round(used / slots.length * 100);
  const bar = document.getElementById('barUsed');
  bar.style.width = pct + '%'; bar.textContent = pct + '%';
  document.getElementById('barLegend').innerHTML = `<span>已用 <b>${used}</b> 格</span><span>空 <b>${slots.length - used}</b> 格</span><span>全部 <b>${slots.length}</b> 格</span>`;

  renderStockCards();

}

// 一個品項的彙總：籠數、各狀態籠數、批次清單、最壞狀態
function summarize(p) {
  const ss = stocks.filter(s => s.qty > 0 && batchOf(s).productId === p.id);
  const qty = ss.reduce((a, s) => a + s.qty, 0);
  const byStat = { danger: 0, warn: 0, ok: 0 };
  for (const s of ss) byStat[statusOf(batchOf(s)).key] += s.qty;
  const bl = [...new Set(ss.map(s => s.batchId))].map(id => batches.find(b => b.id === id)).sort(byInDate);
  const worst = byStat.danger ? 'danger' : byStat.warn ? 'warn' : qty ? 'ok' : 'none';
  return { p, ss, qty, byStat, batchList: bl, oldest: bl[0], worst };
}

function setFilter(f) {
  ov.filter = f;
  document.querySelectorAll('#chips .chip').forEach(c => c.classList.toggle('active', c.dataset.f === f));
  renderStockCards();
}
function toggleCard(pid) { ov.open = ov.open === pid ? null : pid; renderStockCards(); }

function renderStockCards() {
  const rank = { danger: 0, warn: 1, ok: 2, none: 3 };
  let list = activeProducts().map(summarize);
  if (ov.q) list = list.filter(x => x.p.name.includes(ov.q));
  if (ov.filter === 'none') list = list.filter(x => x.worst === 'none');
  else if (ov.filter !== 'all') list = list.filter(x => x.byStat[ov.filter] > 0);
  list.sort(
    ov.sort === 'qty'  ? (a, b) => b.qty - a.qty :
    ov.sort === 'name' ? (a, b) => a.p.name.localeCompare(b.p.name, 'zh-Hant') :
                         (a, b) => rank[a.worst] - rank[b.worst] || b.byStat.danger - a.byStat.danger || b.byStat.warn - a.byStat.warn);

  const actions = (p) => `<div class="pactions"><button class="btn secondary small" onclick="openProdModal(${p.id})">✎ 編輯 / 刪除品項</button></div>`;
  const addCard = `<div class="pcard add" onclick="openProdModal(null)"><span>＋</span>新增品項</div>`;
  document.getElementById('stockCards').innerHTML = (list.length ? list.map(x => {
    const p = x.p, open = ov.open === p.id;
    if (!x.qty) return `<div class="pcard none ${open ? 'open' : ''}" onclick="toggleCard(${p.id})">
        <div class="phead"><span class="dot" style="background:${p.color}"></span><span class="pname">${p.name}</span><span class="pqty">0<small> 籠</small></span></div>
        <div class="pmeta"><span class="tag none">缺貨</span></div>
        ${open ? `<div class="pdetail" onclick="event.stopPropagation()"><span class="hint">目前沒有庫存，保存天數 ${p.shelfDays} 天。</span>${actions(p)}</div>` : ''}</div>`;
    const bar = ['danger', 'warn', 'ok'].filter(k => x.byStat[k]).map(k => `<i class="${k}" style="width:${x.byStat[k] / x.qty * 100}%"></i>`).join('');
    const tags = [['danger', '超期'], ['warn', '快到期'], ['ok', '正常']].filter(([k]) => x.byStat[k]).map(([k, t]) => `<span class="tag ${k}">${t} ${x.byStat[k]}</span>`).join('');
    // 展開：列出各格庫存，照 FIFO 順序編號 —— 出庫時就是照這個順序拿
    const detail = !open ? '' : `<div class="pdetail" onclick="event.stopPropagation()">
        <table><thead><tr><th>順序</th><th>批次</th><th>櫃位</th><th>籠數</th><th>入庫日</th><th>已放 / 上限</th><th>到期日</th><th>狀態</th></tr></thead><tbody>
        ${[...x.ss].sort((a, b) => byInDate(batchOf(a), batchOf(b))).map((s, i) => { const b = batchOf(s), st = statusOf(b);
          return `<tr><td>${i + 1}</td><td>${b.id}</td><td><b>${s.slotId}</b></td><td>${s.qty}</td><td>${b.inDate}</td><td>${ageDays(b)} / ${limitDays(b)} 天</td><td>${b.expireDate}</td><td><span class="tag ${st.key}">${st.text}</span></td></tr>`; }).join('')}
        </tbody></table>${actions(p)}</div>`;
    return `<div class="pcard ${x.worst} ${open ? 'open' : ''}" onclick="toggleCard(${p.id})">
        <div class="phead"><span class="dot" style="background:${p.color}"></span><span class="pname">${p.name}</span><span class="pqty">${x.qty}<small> 籠</small></span></div>
        <div class="pbar">${bar}</div>
        <div class="pmeta">${tags}</div>
        <div class="pmeta hint">${x.batchList.length} 批 ・ 佔 ${x.ss.length} 格 ・ 最舊已放 ${ageDays(x.oldest)} / ${limitDays(x.oldest)} 天</div>
        ${detail}</div>`;
  }).join('') : '<div class="empty">沒有符合的品項</div>') + addCard;
}

/* ---------- 品項主檔：新增 / 編輯 / 刪除（李太太今年多一種菜、少一種菜） ---------- */
let pmId = null, pmColor = '';
function openProdModal(id) {
  pmId = id;
  const p = id ? product(id) : null, qty = p ? stockQty(p.id) : 0;
  document.getElementById('pmTitle').textContent = p ? `編輯品項：${p.name}` : '新增品項';
  document.getElementById('pmName').value = p ? p.name : '';
  document.getElementById('pmDays').value = p ? p.shelfDays : 60;
  const used = new Set(activeProducts().map(x => x.color));
  pmColor = p ? p.color : (PALETTE.find(c => !used.has(c)) || PALETTE[0]);   // 新品項自動挑一個沒用過的顏色
  renderSwatches();
  document.getElementById('pmDelete').style.display = p ? '' : 'none';
  document.getElementById('pmConfirm').style.display = 'none';
  document.getElementById('pmConfirmName').value = '';
  const db = document.getElementById('pmDelBtn');
  db.style.display = ''; db.disabled = qty > 0;   // 還有貨不能刪，先出清
  db.textContent = qty > 0 ? `🗑 還有 ${qty} 籠，出清後才能刪除` : '🗑 刪除這個品項…';
  document.getElementById('pmBg').classList.add('show');
  if (!p) document.getElementById('pmName').focus();
}
function renderSwatches() {
  document.getElementById('pmSwatches').innerHTML = PALETTE.map(c => `<button class="swatch ${c === pmColor ? 'active' : ''}" style="background:${c}" onclick="pmColor='${c}';renderSwatches()"></button>`).join('');
}
function closeProdModal() { document.getElementById('pmBg').classList.remove('show'); pmId = null; }
function saveProdModal() {
  const name = document.getElementById('pmName').value.trim(), days = +document.getElementById('pmDays').value;
  if (!name) return toast('請輸入名稱');
  if (!(days >= 1)) return toast('保存天數至少 1 天');
  if (activeProducts().some(p => p.name === name && p.id !== pmId)) return toast(`已經有「${name}」了`);
  const body = { name, shelfDays: days, color: pmColor };
  return send(async () => {
    if (pmId) {
      const r = await api.put(`/api/products/${pmId}`, body);
      if (!r.changed) return closeProdModal();
      toast(`已更新「${name}」`);
    } else {
      await api.post('/api/products', body);
      toast(`已新增「${name}」`);
    }
    closeProdModal(); await reload();
  });
}
function deleteProduct() {
  const p = product(pmId);
  if (document.getElementById('pmConfirmName').value.trim() !== p.name) return toast('名稱不符，沒有刪除');
  if (stockQty(p.id) > 0) return toast('還有庫存，不能刪除');
  return send(async () => {
    await api.del(`/api/products/${p.id}`, { confirmName: p.name });
    inRows = []; outRows = []; ov.open = null;   // 表單裡可能選著這個品項，重置
    toast(`已刪除「${p.name}」（Ctrl+Z 可復原）`);
    closeProdModal(); await reload();
  });
}

/* ===================== 表單共用 ===================== */
const opts = (arr, sel, fmtFn = (x) => x) => arr.map(v => `<option value="${v}" ${v == sel ? 'selected' : ''}>${fmtFn(v)}</option>`).join('');
// 品項選擇：色塊圖庫。prodOpen 記哪一項的圖庫是展開的（一次只開一個，選完自動收起）
const prodOpen = { inRows: 0, outRows: 0 };
function productPicker(prefix, i, r, dimEmpty) {
  const p = product(r.pid), open = prodOpen[prefix] === i;
  const rerender = prefix === 'inRows' ? 'renderInbound()' : 'renderOutbound()';
  let html = `<label>品項</label><button class="pcur" onclick="prodOpen.${prefix}=${open ? 'null' : i};${rerender}">
      <span class="dot" style="background:${p.color}"></span>${p.name}<small>${open ? '收起 ▴' : '換品項 ▾'}</small></button>`;
  if (open) html += `<div class="ptiles">` + activeProducts().map(q => { const n = stockQty(q.id);
      return `<button class="ptile ${q.id === r.pid ? 'active' : ''} ${dimEmpty && !n ? 'none' : ''}" onclick="${prefix}[${i}].pid=${q.id};prodOpen.${prefix}=null;${rerender}">
        <span class="dot" style="background:${q.color}"></span>${q.name}<small>${n ? n + ' 籠' : '缺貨'}</small></button>`; }).join('') + `</div>`;
  return html;
}
function slotSelects(prefix, i, r) {
  return `<div class="row">
    <div><label>庫</label><select onchange="${prefix}[${i}].wh=this.value;renderInbound()">${opts(WH, r.wh)}</select></div>
    <div><label>排</label><select onchange="${prefix}[${i}].row=+this.value;renderInbound()">${opts(Array.from({ length: ROWS }, (_, k) => k + 1), r.row, pad)}</select></div>
    <div><label>層</label><select onchange="${prefix}[${i}].level=+this.value;renderInbound()">${opts(Array.from({ length: LEVELS }, (_, k) => k + 1), r.level)}</select></div>
  </div>`;
}
// 挑一個還沒被表單其他列用掉的空格
function nextEmptySlot(taken) {
  return emptySlots().find(s => !taken.includes(s.id)) || slots[0];
}
// 入 / 出庫切換
function setMode(m) {
  document.getElementById('segIn').classList.toggle('active', m === 'in');
  document.getElementById('segOut').classList.toggle('active', m === 'out');
  document.getElementById('ioIn').style.display = m === 'in' ? '' : 'none';
  document.getElementById('ioOut').style.display = m === 'out' ? '' : 'none';
  document.getElementById('inResult').style.display = 'none';
  if (m === 'in') clearPick();
}

/* ===================== 入庫 ===================== */
let inRows = [], inPickRow = 0;   // inPickRow：哪一項正在用地圖選格（一次只展開一張地圖）
// 表單裡各項已選的格子 → { 'A-02-1': 1, 'B-03-3': 2 }
const chosenSlots = () => Object.fromEntries(inRows.map((r, i) => [slotId(r.wh, r.row, r.level), i + 1]));
// 地圖上點空格：套到該項的 庫 / 排 / 層
function pickSlot(i, sid) {
  const s = slotObj(sid);
  inRows[i].wh = s.wh; inRows[i].row = s.row; inRows[i].level = s.level;
  renderInbound();
}
// 到期日三種算法：auto = 今天 + 品項保存天數；date = 指定日期；days = 今天 + N 天
function expireOf(r) {
  const t = fmt(today);
  if (r.expMode === 'date' && r.expire) return r.expire;
  if (r.expMode === 'days') return addDays(t, +r.expDays || 0);
  return addDays(t, product(r.pid).shelfDays);
}
function addInRow() {
  const taken = inRows.map(r => slotId(r.wh, r.row, r.level));
  const s = nextEmptySlot(taken);
  inRows.push({ pid: activeProducts()[0].id, qty: 5, wh: s.wh, row: s.row, level: s.level, expMode: 'auto', expire: '', expDays: 30 });
  prodOpen.inRows = inRows.length - 1;                     // 新加的那項先選品項
  if (inPickRow !== null) inPickRow = inRows.length - 1;   // 地圖跟著切到新加的那項
  renderInbound();
}
function removeInRow(i) { inRows.splice(i, 1); prodOpen.inRows = null; if (inPickRow >= inRows.length) inPickRow = inRows.length - 1; renderInbound(); }
function renderInbound() {
  if (!inRows.length) { addInRow(); return; }
  document.getElementById('inRows').innerHTML = inRows.map((r, i) => `
    <div class="item">
      <div class="title">第 ${i + 1} 項</div>
      <div class="row">
        <div style="flex:3 1 240px">${productPicker('inRows', i, r, false)}</div>
        <div><label>籠數</label><input type="number" min="1" value="${r.qty}" oninput="inRows[${i}].qty=+this.value"></div>
      </div>
      ${slotSelects('inRows', i, r)}
      ${inPickRow === i ? `<div class="picker">
          <div class="whtabs">${WH.map(w => `<button class="${w === r.wh ? 'active' : ''}" onclick="inRows[${i}].wh='${w}';renderInbound()">${w} 庫（空 ${emptySlots().filter(s => s.wh === w).length} 格）</button>`).join('')}
            <button style="margin-left:auto;border-color:var(--line);color:var(--muted)" onclick="inPickRow=null;renderInbound()">收起地圖</button></div>
          <p class="hint" style="margin:4px 0">點空格就選定；淡的是已有貨；綠框編號 = 這張表單裡各項選的格子。</p>
          ${mapHTML({ wh: r.wh, pick: { row: i, chosen: chosenSlots() } })}
        </div>` : `<button class="btn secondary small" style="margin-top:8px" onclick="inPickRow=${i};renderInbound()">📍 從地圖選格</button>`}
      <div class="row">
        <div><label>到期日</label><select onchange="inRows[${i}].expMode=this.value;renderInbound()">
          <option value="auto" ${r.expMode === 'auto' ? 'selected' : ''}>依保存天數（${product(r.pid).shelfDays} 天）</option>
          <option value="date" ${r.expMode === 'date' ? 'selected' : ''}>指定日期</option>
          <option value="days" ${r.expMode === 'days' ? 'selected' : ''}>幾天後到期</option>
        </select></div>
        ${r.expMode === 'date' ? `<div><label>日期</label><input type="date" value="${r.expire}" onchange="inRows[${i}].expire=this.value;renderInbound()"></div>` :
          r.expMode === 'days' ? `<div><label>天數</label><input type="number" min="0" value="${r.expDays}" oninput="inRows[${i}].expDays=+this.value;document.getElementById('inExp${i}').textContent=expireOf(inRows[${i}])"></div>` : ''}
      </div>
      <p class="hint" style="margin:6px 0 0">預計到期：<b id="inExp${i}">${expireOf(r)}</b></p>
      ${inRows.length > 1 ? `<button class="btn link" onclick="removeInRow(${i})">✕ 移除這項</button>` : ''}
    </div>`).join('');
}
function doInbound() {
  // 先檢查：籠數 > 0、櫃位是空的、表單內沒有重複櫃位（後端也會再檢查一次）
  const seen = new Set();
  for (const [i, r] of inRows.entries()) {
    const sid = slotId(r.wh, r.row, r.level);
    if (!r.qty || r.qty < 1) return toast(`第 ${i + 1} 項籠數不正確`);
    if (stockAt(sid)) return toast(`第 ${i + 1} 項：${sid} 已經有貨，請換一格`);
    if (seen.has(sid)) return toast(`第 ${i + 1} 項：${sid} 跟其他項重複`);
    seen.add(sid);
  }
  const items = inRows.map(r => ({ productId: r.pid, qty: r.qty, slotId: slotId(r.wh, r.row, r.level), expireDate: expireOf(r) }));
  return send(async () => {
    const res = await api.post('/api/inbound', { items });   // 後端回傳已依走路順序排好的放貨步驟
    await reload();
    const steps = res.steps;
    const hl = {}; steps.forEach((s, i) => hl[s.slotId] = i + 1);
    document.getElementById('inSteps').innerHTML = steps.map((s, i) =>
      `<div class="pick">${i + 1}. 把 <b>${s.productName} ${s.qty} 籠</b> 放到 <b>${s.slotId}</b><br><span class="hint">到期 ${s.expireDate}</span></div>`).join('');
    document.getElementById('inRoute').innerHTML = mapHTML({ highlight: hl });
    document.getElementById('ioForm').style.display = 'none';
    document.getElementById('inResult').style.display = '';
    toast(`已入庫 ${steps.length} 項`);
  });
}
function resetInbound() {
  inRows = []; inPickRow = 0;
  document.getElementById('ioForm').style.display = '';
  document.getElementById('inResult').style.display = 'none';
  renderInbound();
}

/* ===================== 出庫 ===================== */
let outRows = [], currentPlan = null;
function addOutRow() { outRows.push({ pid: activeProducts()[0].id, qty: 6 }); prodOpen.outRows = outRows.length - 1; renderOutbound(); }
function removeOutRow(i) { outRows.splice(i, 1); prodOpen.outRows = null; renderOutbound(); }
function renderOutbound() {
  if (!outRows.length) { addOutRow(); return; }
  clearPick();
  document.getElementById('outRows').innerHTML = outRows.map((r, i) => `
    <div class="item">
      <div class="title">第 ${i + 1} 項</div>
      <div class="row">
        <div style="flex:3 1 240px">${productPicker('outRows', i, r, true)}</div>
        <div><label>籠數</label><input type="number" min="1" value="${r.qty}" oninput="outRows[${i}].qty=+this.value;clearPick()"></div>
      </div>
      ${outRows.length > 1 ? `<button class="btn link" onclick="removeOutRow(${i})">✕ 移除這項</button>` : ''}
    </div>`).join('');
}
function clearPick() { currentPlan = null; document.getElementById('pickCard').style.display = 'none'; }
function makePick() {
  for (const r of outRows) if (!r.qty || r.qty < 1) return toast('籠數不正確');
  return send(async () => {
    // 後端用先進先出算好要去哪幾格拿，並依走路順序排好；這一步不會改資料
    const res = await api.post('/api/outbound/plan', { items: outRows.map(r => ({ productId: r.pid, qty: r.qty })) });
    const plan = res.plan.map(p => ({ ...p, pid: p.productId })), shortages = res.shortages;
    if (!plan.length) { clearPick(); return toast('這些品項都沒有庫存！'); }
    currentPlan = plan;
    const hl = {}; plan.forEach((p, i) => hl[p.slotId] = i + 1);
    document.getElementById('pickList').innerHTML =
      plan.map((p, i) => `<div class="pick">${i + 1}. 去 <b>${p.slotId}</b> 拿 <b>${product(p.pid).name} ${p.qty} 籠</b><br><span class="hint">批次 ${p.batchId}（${p.inDate} 入庫，已放 ${daysBetween(p.inDate, fmt(today))} 天）</span></div>`).join('') +
      (shortages.length ? `<p style="color:var(--danger)"><b>庫存不足：${shortages.join('、')}。</b>請李太太決定要不要接單。</p>` : '');
    document.getElementById('outRoute').innerHTML = mapHTML({ highlight: hl });
    document.getElementById('pickCard').style.display = '';
  });
}
function confirmPick() {
  if (!currentPlan) return;
  return send(async () => {
    await api.post('/api/outbound/confirm', { plan: currentPlan.map(p => ({ slotId: p.slotId, batchId: p.batchId, qty: p.qty })) });
    toast('出庫完成，庫存已更新');
    outRows = [];
    await reload();
  });
}

/* ===================== 畫面：倉庫地圖（含移位 / 盤點） ===================== */
let sheetSid = null;   // 目前底部面板顯示的是哪一格
function renderMap() { document.getElementById('maps').innerHTML = mapHTML({ interactive: true }); }

// 左鍵：底部面板只顯示資訊；再點同一格或點別處就關
function showCell(sid) {
  if (sheetSid === sid) return hideSheet();
  sheetSid = sid;
  const st = stockAt(sid);
  document.getElementById('sheet').classList.add('show');
  document.querySelectorAll('#maps .cell.sel').forEach(c => c.classList.remove('sel'));
  event.currentTarget.classList.add('sel');
  if (!st) { document.getElementById('sheetInfo').innerHTML = `<b>${sid}</b>：空格`; return; }
  const b = batchOf(st), stat = statusOf(b);
  document.getElementById('sheetInfo').innerHTML =
    `<b>${sid}</b>：${productOfStock(st).name} <b>${st.qty} 籠</b> <span class="tag ${stat.key}">${stat.text}</span><br>
     <span class="hint">批次 ${b.id}｜${b.inDate} 入庫｜${ageText(b)}｜到期 ${b.expireDate}</span>`;
}
function hideSheet() {
  sheetSid = null;
  document.getElementById('sheet').classList.remove('show');
  document.querySelectorAll('#maps .cell.sel').forEach(c => c.classList.remove('sel'));
}
// 點格子以外的地方（面板本身除外）就關閉面板
document.addEventListener('click', (e) => {
  if (sheetSid && !e.target.closest('#maps .cell') && !e.target.closest('#sheet')) hideSheet();
});

// 移位（拖曳）：目標是空格就搬過去；目標有貨就兩格互換
function transfer(from, to) {
  if (from === to) return;
  if (!stockAt(from)) return toast('來源櫃位沒有貨');
  return send(async () => {
    const r = await api.post('/api/transfer', { from, to });   // to 是空格 = 移位；有貨 = 互換
    toast(r.swapped ? `已互換：${from} ⇄ ${to}` : `已移位：${from} → ${to}`);
    hideSheet(); await reload();
  });
}
let dragFrom = null;
function dragStart(e, sid) { dragFrom = sid; e.currentTarget.classList.add('dragging'); document.body.classList.add('dragging'); e.dataTransfer.effectAllowed = 'move'; }
function dragEnd(e) { e.currentTarget.classList.remove('dragging'); document.body.classList.remove('dragging'); binLeave(); }
function dragOver(e) { e.preventDefault(); e.currentTarget.classList.add('over'); }
function dragLeave(e) { e.currentTarget.classList.remove('over'); }
function drop(e, sid) { e.preventDefault(); e.currentTarget.classList.remove('over'); if (dragFrom) transfer(dragFrom, sid); dragFrom = null; }

// 丟棄：把格子拖到左側「丟棄」區 → 該格清空、記一筆丟棄（丟錯了 Ctrl+Z 可復原）
function binOver(e) { e.preventDefault(); e.dataTransfer.dropEffect = 'move'; document.getElementById('bin').classList.add('over'); }
function binLeave() { document.getElementById('bin').classList.remove('over'); }
function binDrop(e) { e.preventDefault(); binLeave(); if (dragFrom) discard(dragFrom); dragFrom = null; }
function discard(sid) {
  const st = stockAt(sid);
  if (!st) return;
  return send(async () => {
    const r = await api.post('/api/discard', { slotId: sid });
    toast(`已丟棄 ${sid} ${r.productName} ${r.qty} 籠（Ctrl+Z 可復原）`);
    hideSheet(); await reload();
  });
}

// 右鍵：編輯數量 / 到期日（= 盤點）
let modalSlot = null;
function openModal(sid) {
  const st = stockAt(sid);
  if (!st) return toast('空格沒有東西可以編輯，請用「入庫」');
  modalSlot = sid;
  const b = batchOf(st);
  document.getElementById('mTitle').textContent = `${sid}：${productOfStock(st).name}`;
  document.getElementById('mQty').value = st.qty;
  document.getElementById('mExpire').value = b.expireDate;
  document.getElementById('mHint').textContent = `批次 ${b.id}，${b.inDate} 入庫。籠數改成 0 會清空這格。`;
  document.getElementById('modalBg').classList.add('show');
}
function bumpQty(n) { const el = document.getElementById('mQty'); el.value = Math.max(0, (+el.value || 0) + n); }
function closeModal() { document.getElementById('modalBg').classList.remove('show'); modalSlot = null; }
function saveModal() {
  const st = stockAt(modalSlot); if (!st) return closeModal();
  const sid = modalSlot;
  const qty = +document.getElementById('mQty').value, expire = document.getElementById('mExpire').value;
  return send(async () => {
    const r = await api.post('/api/adjust', { slotId: sid, qty, expireDate: expire });   // 籠數不同 = 盤點；日期不同 = 改到期日
    closeModal(); hideSheet();
    if (!r.changed) return;
    toast('已更新');
    await reload();
  });
}

/* ===================== 畫面：紀錄 ===================== */
function renderLog() {
  const color = { '入庫': 'var(--ok)', '出庫': 'var(--primary)', '移位': 'var(--warn)', '盤點': 'var(--danger)', '改到期日': '#6c5ce7', '丟棄': '#4a4a4a', '主檔': '#2c3e50', '復原': '#7f8c8d', '重做': '#7f8c8d' };
  const ub = document.getElementById('undoBtn'), rb = document.getElementById('redoBtn');
  ub.disabled = !undoInfo.canUndo; ub.textContent = undoInfo.canUndo ? `↶ 復原：${undoInfo.undoLabel}` : '↶ 復原（沒有可復原的動作）';
  rb.disabled = !undoInfo.canRedo; rb.textContent = undoInfo.canRedo ? `↷ 重做：${undoInfo.redoLabel}` : '↷ 重做';
  document.getElementById('logTable').innerHTML = [...movements].reverse().map(m => {
    const tag = `<span class="tag" style="background:${color[m.type]}">${m.type}</span>`;
    if (m.type === '復原' || m.type === '重做') return `<tr><td>${m.time}</td><td>${tag}</td><td colspan="4" class="hint">${m.note}</td></tr>`;
    return `<tr class="${m.undone ? 'undone' : ''}"><td>${m.time}</td><td>${tag}</td><td>${m.product}</td><td>${m.qty}</td><td>${m.slot}</td><td class="hint">${m.undone ? `<s>${m.note}</s> <span class="tag none">已復原</span>` : m.note}</td></tr>`;
  }).join('');
}

/* ===================== 共用 ===================== */
function renderAll() { renderOverview(); renderInbound(); renderOutbound(); renderMap(); renderLog(); }
function toast(msg) { const t = document.getElementById('toast'); t.textContent = msg; t.classList.add('show'); setTimeout(() => t.classList.remove('show'), 2500); }
document.querySelectorAll('#nav button').forEach(btn => btn.onclick = () => {
  document.querySelectorAll('#nav button').forEach(b => b.classList.remove('active'));
  document.querySelectorAll('.page').forEach(p => p.classList.remove('active'));
  btn.classList.add('active');
  document.getElementById('page-' + btn.dataset.page).classList.add('active');
  if (btn.dataset.page !== 'map') hideSheet();
});
document.querySelector('#nav button').click();
// 開頁面：先從資料庫抓資料再畫；連不上就把原因顯示在畫面上
reload().catch((e) => {
  document.querySelector('main').innerHTML =
    `<div class="card" style="color:var(--danger)"><b>讀不到資料：</b>${e.message}<br><span class="hint">確認伺服器（npm start）和 MySQL 都有開著，再重新整理頁面。</span></div>`;
});
