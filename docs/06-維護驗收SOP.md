# 06 維護驗收 SOP — 照老師的劇本演一遍

狀態：**草稿，待小組確認**
依據：老師的「竹南冷凍倉儲公司 驗收與維護」簡報（第 3 頁驗收測試、第 10 頁維護驗收測試劇本、NO1～NO3）
用法：驗收前完整演練兩次。第一次找問題，第二次計時。每一步都**截圖**，貼進 `docs/03-驗證紀錄.md`。

---

## 0. 演練前準備（每次都做）

**終端機 1：清資料、跑測試、開伺服器**

```
cd ~/SA_workspace/zhunan-inventory-main
npm run db:reset && npm run seed    # 清空後灌回 Demo 假資料，每次起點都一樣（正式資料不要這樣做）
npm test                            # 一定要 # pass 50、# fail 0 才往下
npm start                           # 瀏覽器開 http://localhost:3000；手機用終端機印出的網址
```

**終端機 2：用 SQL 對帳**（用來證明畫面上的數字就是資料庫裡的數字）

```
/usr/local/mysql/bin/mysql --default-character-set=utf8mb4 -u root -p zhunan
```

先把下面四條查詢準備好：

```sql
-- Q1 兩座倉庫各品項庫存（劇本第 1、4／5 步）
SELECT LEFT(s.slot_id,1) 倉庫, p.name 品項, SUM(s.qty) 籠數
FROM stock s JOIN batch b ON b.id=s.batch_id JOIN product p ON p.id=b.product_id
WHERE s.qty>0 GROUP BY 倉庫, p.name ORDER BY 倉庫, p.name;

-- Q2 某品項逐格明細，最舊的在最上面（把甘藍菜換成要查的菜）
SELECT s.slot_id 儲位, s.batch_id 批次, b.in_date 入庫日, s.qty 籠數
FROM stock s JOIN batch b ON b.id=s.batch_id JOIN product p ON p.id=b.product_id
WHERE p.name='甘藍菜' AND s.qty>0 ORDER BY b.in_date, b.id;

-- Q3 最近 5 筆異動（看時間、單號、原因）
SELECT id, type, batch_id, from_slot_id, to_slot_id, qty, note, created_at
FROM movement ORDER BY id DESC LIMIT 5;

-- Q4 對帳：每格庫存 = 所有有效異動加減。結果「必須是空的」
SELECT x.slot, x.log_qty, COALESCE(s.qty,0) AS stock_qty FROM (
  SELECT slot, SUM(delta) AS log_qty FROM (
    SELECT m.to_slot_id AS slot, m.qty AS delta FROM movement m JOIN action a ON a.id=m.action_id
      WHERE a.undone=0 AND m.to_slot_id IS NOT NULL AND m.qty IS NOT NULL
    UNION ALL
    SELECT m.from_slot_id, -m.qty FROM movement m JOIN action a ON a.id=m.action_id
      WHERE a.undone=0 AND m.from_slot_id IS NOT NULL AND m.qty IS NOT NULL
  ) t GROUP BY slot) x
LEFT JOIN (SELECT slot_id, SUM(qty) AS qty FROM stock GROUP BY slot_id) s ON s.slot_id = x.slot
WHERE x.log_qty <> COALESCE(s.qty,0);
```

> 劇本用的「青江菜」系統裡沒有（20 種菜照 Demo），**演示用菠菜代替**，或事先在「總覽」按「＋ 新增品項」加青江菜再入庫。

---

## 1. 驗收測試（簡報第 3 頁，1.0）

| 步 | 畫面上怎麼做 | 應該看到 | 用 SQL 證明 |
|---|---|---|---|
| 1 | 開「總覽」，再開「倉庫地圖」 | 總籠數、各品項卡片；A、B 兩庫逐格顯示品名與籠數 | Q1，存成「之前」 |
| 2 | 「入／出庫」→ 入庫：品項甘藍菜、籠數 2，格子用預填的（或在地圖上點一格）→「發出放貨單」→ 在「待回報的單」按圓圈打勾 →「全部放好了，回報入庫」 | 地圖上那格變甘藍菜 2 籠；提醒列消失 | Q2 多一批今天的、2 籠；Q3 最新一筆「入庫」、備註有「放貨單 #n」 |
| 3 | 出庫：選菠菜、1 籠 →「產生揀貨單」→「發出揀貨單」→ 打勾 →「全部拿好了，回報出庫」 | 揀貨單第一站是最舊那批；回報後那格少 1 | Q2（菠菜）最舊那批少 1；Q3 最新一筆「出庫」 |
| 4 | 回「總覽」 | 甘藍菜 +2、菠菜 −1，其他不變 | Q1 和「之前」逐列比；Q4 是空的 |

## 2. 維護驗收測試劇本（簡報第 10 頁，2.0）

| 步 | 畫面上怎麼做 | 應該看到 | 用 SQL 證明 |
|---|---|---|---|
| 1 | 同 1.0 第 1 步 | 同上 | Q1 存成「之前」 |
| 2 | 同 1.0 第 2 步（進貨甘藍菜 2 籠）。**回報前先停一下**，指給老師看：地圖上那格是藍色虛線「預定 放#n」、提醒列寫「還有 1 張單沒回報」，庫存還沒加 | 回報後才入庫；「紀錄」頁看得到時間到幾點幾分 | Q3 的 `created_at` = 現在；Q2 批次的入庫日 = 今天 |
| 3a | 「盤點」頁 → 選 A 庫 → 逐格核對（全部一致，什麼都不用改）→「全部一致，完成 A 庫盤點」 | 結果寫「數量不符 0 格、報廢 0 籠、庫存完全正確」；A 庫分頁變「今天 HH:MM 盤過 ✓」；提醒列不再提 A 庫 | `SELECT * FROM stocktake ORDER BY id DESC LIMIT 1;` 有一筆 diff_count 0 |
| 3b | 同一頁，找到剛放的甘藍菜那格，「其中壞掉」按 ＋ 一次 → 原因選「腐爛」→「完成 A 庫盤點，更新庫存」 | 那格剩 1 籠；盤點紀錄展開明細看得到「壞掉 1（腐爛）」 | Q2 該格 1 籠；Q3 最新一筆「丟棄」、備註「A 庫盤點報廢：腐爛」 |
| 4 | 出庫菠菜（青江菜）1 箱：同 1.0 第 3 步。**強調**：揀貨單第一站就是最早進貨的那格 | 同上 | 先跑 Q2（菠菜）記下第一列，再和揀貨單第一站比 |
| 5 | 回「總覽」 | 甘藍菜 +2 −1、菠菜 −1 | Q1 逐列比；**Q4 必須是空的** |

## 3. 系統維護 NO1～NO3 的演示

**NO1 忘了回報**（老師一定會問「你怎麼確保」）

1. 出庫任一品項 → 發出揀貨單 →**不要回報**，直接關掉瀏覽器分頁。
2. 用另一台手機（或重新打開）進系統：每一頁最上面都寫「還有 1 張單沒回報」→ 按「去回報」就看到那張單、每一站在哪一格。
3. 指給老師看：地圖上那幾格標「揀#n」，這些貨別張單拿不到、也不能移位或丟，所以員工照單去拿一定拿得到。
4. 說明：超過 30 分鐘沒回報會變紅；紀錄頁下方「超過 30 分鐘還沒回報」會計數。（要現場演示變紅，可以在 SQL 視窗執行 `UPDATE pick_order SET created_at = NOW() - INTERVAL 40 MINUTE WHERE status='open';` 再重新整理。）
5. 打勾、回報 → 庫存才扣。

**NO1 進貨放錯格**：發一張放貨單 → 在那一站的下拉選「實際放到 B-0x-x」→ 打勾回報 → 紀錄寫「原定 A-…，實際放 B-…」，地圖上貨在實際的格子。

**NO2 盤點**：就是劇本第 3 步。再補兩點：①「提醒列」會提醒今天還沒盤的庫；② 盤錯了可以到「紀錄」按復原，盤點紀錄保留並標「已復原」。

**NO3 先進先出**：劇本第 4 步。可以再到「總覽」點該品項卡片，展開的批次表第一列就是揀貨單第一站。

## 4. 使用者的抗拒（效率）

打開「紀錄」頁最下面「最近 7 天作業統計」，配合 [`docs/05-效率評估.md`](05-效率評估.md) 說明：大黑板輸在「找得到、先進先出、對帳」，系統 1.0 輸在「記錄多一步」；2.0 把記錄做成搬貨的一部分（逐站打勾），忘了會被提醒、每天盤點抓回來。

## 5. 演練檢查表

- [ ] `npm test` 50 項全過
- [ ] 1.0 四步、2.0 五步都截圖
- [ ] Q4 對帳在最後是空的
- [ ] NO1「關掉再打開還看得到」演過
- [ ] 手機上操作過一次（點格子 → 面板按鈕 → 報廢；盤點頁用 ＋－）
- [ ] 計時：第二次演練從第 1 步到第 5 步共 ＿＿ 分鐘
