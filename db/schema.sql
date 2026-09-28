-- =====================================================================
-- db/schema.sql — 竹南冷凍倉儲 庫存管理系統 資料庫結構 + 基本主檔
--
-- 用法（二選一）：
--   1. mysql -u root -p < db/schema.sql
--   2. npm run db:init        （不用裝 mysql 指令列工具，Windows 也能跑）
--
-- 重跑是安全的：資料庫、表已經存在就跳過，主檔已經存在就不重複塞，既有庫存與紀錄都不會動。
-- 開發時想「整個清空重來」請用 npm run db:reset（會先 DROP 資料庫，正式機不要用）。
--
-- 對應文件：docs/02-技術方案.md §3
--   warehouse ─< slot ─< stock >─ batch >─ product
--                          ▲
--   action ─< movement ────┘（每筆異動記「哪一格 −幾籠、哪一格 +幾籠」）
--   pick_order ─< pick_line（揀貨單）、put_order ─< put_line（放貨單）：NO1
--   stocktake ─< stocktake_line（盤點）：NO2
-- =====================================================================

-- 用 UTF-8 送出本檔，否則在某些電腦上中文（A 庫、甘藍菜）會變成問號
SET NAMES utf8mb4;

CREATE DATABASE IF NOT EXISTS zhunan CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;
USE zhunan;

-- 冷凍庫：不寫死 A/B，之後多一座就多一列
CREATE TABLE IF NOT EXISTS warehouse (
  code         CHAR(1)     PRIMARY KEY,          -- 'A'
  name         VARCHAR(20) NOT NULL,             -- 'A 庫'
  rows_count   TINYINT     NOT NULL,             -- 幾排
  levels_count TINYINT     NOT NULL,             -- 幾層
  sort_no      TINYINT     NOT NULL DEFAULT 0    -- 畫面上的順序
);

-- 櫃位：標準化編號「庫-排-層」，貼在實體櫃位上的號碼牌就是這個 id
CREATE TABLE IF NOT EXISTS slot (
  id             VARCHAR(10) PRIMARY KEY,        -- 'A-03-2'
  warehouse_code CHAR(1)     NOT NULL,
  row_no         TINYINT     NOT NULL,
  level_no       TINYINT     NOT NULL,
  UNIQUE KEY uq_slot_position (warehouse_code, row_no, level_no),   -- 同一庫同一排同一層只會有一格
  FOREIGN KEY (warehouse_code) REFERENCES warehouse(code)
);

-- 品項：刪除是軟刪除（deleted_at 有值 = 已刪），舊批次、舊紀錄還查得到
CREATE TABLE IF NOT EXISTS product (
  id         INT          AUTO_INCREMENT PRIMARY KEY,
  name       VARCHAR(20)  NOT NULL,
  shelf_days SMALLINT     NOT NULL,              -- 保存天數
  color      CHAR(7)      NOT NULL,              -- '#2e86c1'，地圖上的顏色
  deleted_at DATETIME     NULL,
  CHECK (shelf_days > 0)
);

-- 批次：FIFO 的單位。到期日預設 = 入庫日 + 保存天數，但可自訂、可事後改
CREATE TABLE IF NOT EXISTS batch (
  id          VARCHAR(20) PRIMARY KEY,           -- 'B20260921-01'（入庫日 + 當日流水號）
  product_id  INT         NOT NULL,
  in_date     DATE        NOT NULL,
  expire_date DATE        NOT NULL,
  -- FIFO 查詢「某品項依入庫日、批次編號排序」會用到這個索引
  KEY idx_batch_fifo (product_id, in_date, id),
  -- 產生新批次編號時要查「某天已經有幾批」
  KEY idx_batch_in_date (in_date),
  FOREIGN KEY (product_id) REFERENCES product(id)
);

-- 庫存堆：某批次放在某格幾籠。一批可拆放多格；一格同時只放一批（程式保證，不用 DB 約束，見技術方案 §3.3）
CREATE TABLE IF NOT EXISTS stock (
  batch_id VARCHAR(20) NOT NULL,
  slot_id  VARCHAR(10) NOT NULL,
  qty      INT         NOT NULL DEFAULT 0,       -- 出完變 0，列保留
  PRIMARY KEY (batch_id, slot_id),
  KEY idx_stock_slot (slot_id),                  -- 查「這格現在放什麼」
  CHECK (qty >= 0),                              -- 最後一道防線：程式寫錯也不會出現負庫存
  FOREIGN KEY (batch_id) REFERENCES batch(id),
  FOREIGN KEY (slot_id)  REFERENCES slot(id)
);

-- 動作：使用者按一次「確認」= 一個 action，底下可能有好幾筆 movement。復原 / 重做以 action 為單位
--   kind = normal：一般操作（可復原）
--          undo / redo：復原、重做本身（不能再被復原）
--          init：期初資料（seed 灌的假庫存，或正式上線時把大黑板搬進系統的那一次），不能被復原
CREATE TABLE IF NOT EXISTS action (
  id               INT          AUTO_INCREMENT PRIMARY KEY,
  label            VARCHAR(120) NOT NULL,        -- '入庫 甘藍菜 5 籠、毛豆 3 籠'（給復原按鈕顯示）
  kind             ENUM('normal','undo','redo','init') NOT NULL DEFAULT 'normal',
  target_action_id INT          NULL,            -- kind = undo / redo 時，指向被復原 / 重做的那個 action
  undone           TINYINT(1)   NOT NULL DEFAULT 0,
  created_at       DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP,
  KEY idx_action_undo (kind, undone, id),        -- 找「最後一個可復原 / 可重做的動作」
  FOREIGN KEY (target_action_id) REFERENCES action(id)
);

-- 異動紀錄：只增不刪。庫存變化一律表示成「from_slot −qty、to_slot +qty」，復原時反過來套就好
CREATE TABLE IF NOT EXISTS movement (
  id           INT  AUTO_INCREMENT PRIMARY KEY,
  action_id    INT  NOT NULL,
  type         ENUM('入庫','出庫','移位','盤點','改到期日','丟棄','主檔','復原','重做') NOT NULL,
  product_id   INT          NULL,
  product_name VARCHAR(20)  NULL,                -- 當時的名稱（品項改名後，舊紀錄仍顯示舊名）
  batch_id     VARCHAR(20)  NULL,
  from_slot_id VARCHAR(10)  NULL,                -- 這格 −qty
  to_slot_id   VARCHAR(10)  NULL,                -- 這格 +qty
  qty          INT          NULL,
  old_value    VARCHAR(200) NULL,                -- 改到期日 / 主檔：改之前的值（主檔存 JSON）
  new_value    VARCHAR(200) NULL,
  note         VARCHAR(200) NULL,                -- 畫面「備註」欄
  created_at   DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CHECK (qty IS NULL OR qty > 0),                -- 異動的籠數一定是正數，方向由 from / to 表示
  FOREIGN KEY (action_id)    REFERENCES action(id),
  FOREIGN KEY (product_id)   REFERENCES product(id),
  FOREIGN KEY (batch_id)     REFERENCES batch(id),
  FOREIGN KEY (from_slot_id) REFERENCES slot(id),
  FOREIGN KEY (to_slot_id)   REFERENCES slot(id)
);

-- =====================================================================
-- 系統維護（驗收與維護.pdf，docs/04-系統維護.md）
-- =====================================================================

-- 揀貨單（維護 NO1「搬走了卻忘了告訴系統」）
--   出庫分兩步：先「發單」→ 單子存進資料庫、那幾格的貨被保留（別張單拿不到）；
--   搬完再「回報」→ 才真的扣庫存。沒回報的單會一直掛著（status = open），
--   任何一台裝置打開系統都看得到，不會因為關掉頁面就消失。
--   復原「出庫」時，單子回到 open（貨沒出去 = 單子還沒完成）。
CREATE TABLE IF NOT EXISTS pick_order (
  id          INT          AUTO_INCREMENT PRIMARY KEY,
  label       VARCHAR(120) NOT NULL,             -- '出庫 甘藍菜 6 籠、毛豆 3 籠'
  status      ENUM('open','done','cancelled') NOT NULL DEFAULT 'open',
  created_at  DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP,   -- 發單時間
  finished_at DATETIME     NULL,                 -- 回報或取消的時間
  action_id   INT          NULL,                 -- 回報時產生的「出庫」action
  KEY idx_pick_status (status, id),
  FOREIGN KEY (action_id) REFERENCES action(id)
);

-- 揀貨單的每一站：去哪一格、拿哪一批、幾籠（seq = 走路順序）
CREATE TABLE IF NOT EXISTS pick_line (
  id       INT         AUTO_INCREMENT PRIMARY KEY,
  pick_id  INT         NOT NULL,
  seq      TINYINT     NOT NULL,
  batch_id VARCHAR(20) NOT NULL,
  slot_id  VARCHAR(10) NOT NULL,
  qty      INT         NOT NULL,
  CHECK (qty > 0),
  KEY idx_pick_line_stock (batch_id, slot_id),   -- 算「這格被保留了幾籠」
  FOREIGN KEY (pick_id)  REFERENCES pick_order(id),
  FOREIGN KEY (batch_id) REFERENCES batch(id),
  FOREIGN KEY (slot_id)  REFERENCES slot(id)
);

-- 放貨單（維護 NO1 的「進貨」那一半）
--   入庫也分兩步：先「發單」→ 存進資料庫、那幾個空格被保留（別張單、移位都不能佔）；
--   員工放好再「回報」→ 才建批次、寫「入庫」異動。回報時可以改成實際放的那一格。
--   批次的入庫日 = 回報那天（貨真的進庫的日子）。
CREATE TABLE IF NOT EXISTS put_order (
  id          INT          AUTO_INCREMENT PRIMARY KEY,
  label       VARCHAR(120) NOT NULL,             -- '入庫 甘藍菜 5 籠、毛豆 3 籠'
  status      ENUM('open','done','cancelled') NOT NULL DEFAULT 'open',
  created_at  DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP,
  finished_at DATETIME     NULL,
  action_id   INT          NULL,                 -- 回報時產生的「入庫」action
  KEY idx_put_status (status, id),
  FOREIGN KEY (action_id) REFERENCES action(id)
);

-- 放貨單的每一站：哪個品項幾籠、預定放哪一格、到期日；回報後記下實際放的格子與建出的批次
CREATE TABLE IF NOT EXISTS put_line (
  id             INT         AUTO_INCREMENT PRIMARY KEY,
  put_id         INT         NOT NULL,
  seq            TINYINT     NOT NULL,           -- 走路順序
  product_id     INT         NOT NULL,
  qty            INT         NOT NULL,
  slot_id        VARCHAR(10) NOT NULL,           -- 預定放的格子（open 時被保留）
  expire_date    DATE        NOT NULL,
  custom_expire  TINYINT(1)  NOT NULL DEFAULT 0, -- 到期日是自訂的（不是入庫日 + 保存天數）
  placed_slot_id VARCHAR(10) NULL,               -- 實際放的格子（回報時填）
  batch_id       VARCHAR(20) NULL,               -- 回報時建出的批次
  CHECK (qty > 0),
  KEY idx_put_line_slot (slot_id),
  FOREIGN KEY (put_id)         REFERENCES put_order(id),
  FOREIGN KEY (product_id)     REFERENCES product(id),
  FOREIGN KEY (slot_id)        REFERENCES slot(id),
  FOREIGN KEY (placed_slot_id) REFERENCES slot(id),
  FOREIGN KEY (batch_id)       REFERENCES batch(id)
);

-- 盤點（維護 NO2「每天對一座倉庫盤點一次」）
--   一次盤點 = 一座倉庫所有有貨的格子；全部正確也會留下一筆，證明今天盤過了。
--   數量不符 → 寫「盤點」異動；發現壞掉的 → 寫「丟棄」異動並記原因。兩者合成一個 action，可以復原。
CREATE TABLE IF NOT EXISTS stocktake (
  id             INT          AUTO_INCREMENT PRIMARY KEY,
  warehouse_code CHAR(1)      NOT NULL,
  created_at     DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP,
  slot_count     SMALLINT     NOT NULL,          -- 盤了幾格
  diff_count     SMALLINT     NOT NULL,          -- 其中數量和系統不符的格數
  spoiled_qty    INT          NOT NULL DEFAULT 0,  -- 報廢幾籠
  action_id      INT          NULL,              -- 有改到庫存才有；全部正確就是 NULL
  KEY idx_stocktake_wh (warehouse_code, id),
  FOREIGN KEY (warehouse_code) REFERENCES warehouse(code),
  FOREIGN KEY (action_id)      REFERENCES action(id)
);

-- 盤點明細：每一格系統說幾籠、實際點到幾籠、其中壞掉幾籠、原因
CREATE TABLE IF NOT EXISTS stocktake_line (
  id           INT          AUTO_INCREMENT PRIMARY KEY,
  stocktake_id INT          NOT NULL,
  slot_id      VARCHAR(10)  NOT NULL,
  batch_id     VARCHAR(20)  NOT NULL,
  system_qty   INT          NOT NULL,
  counted_qty  INT          NOT NULL,
  spoiled_qty  INT          NOT NULL DEFAULT 0,
  reason       VARCHAR(100) NULL,
  CHECK (counted_qty >= 0),
  CHECK (spoiled_qty >= 0 AND spoiled_qty <= counted_qty),
  FOREIGN KEY (stocktake_id) REFERENCES stocktake(id),
  FOREIGN KEY (slot_id)      REFERENCES slot(id),
  FOREIGN KEY (batch_id)     REFERENCES batch(id)
);

-- =====================================================================
-- 基本主檔
-- =====================================================================

-- 兩座冷凍庫，各 6 排 × 3 層
INSERT IGNORE INTO warehouse (code, name, rows_count, levels_count, sort_no) VALUES
  ('A', 'A 庫', 6, 3, 1),
  ('B', 'B 庫', 6, 3, 2);

-- 36 個櫃位：id = 庫-排(兩位數)-層，例如 A-03-2 = A 庫第 3 排第 2 層
INSERT IGNORE INTO slot (id, warehouse_code, row_no, level_no) VALUES
  ('A-01-1','A',1,1), ('A-01-2','A',1,2), ('A-01-3','A',1,3),
  ('A-02-1','A',2,1), ('A-02-2','A',2,2), ('A-02-3','A',2,3),
  ('A-03-1','A',3,1), ('A-03-2','A',3,2), ('A-03-3','A',3,3),
  ('A-04-1','A',4,1), ('A-04-2','A',4,2), ('A-04-3','A',4,3),
  ('A-05-1','A',5,1), ('A-05-2','A',5,2), ('A-05-3','A',5,3),
  ('A-06-1','A',6,1), ('A-06-2','A',6,2), ('A-06-3','A',6,3),
  ('B-01-1','B',1,1), ('B-01-2','B',1,2), ('B-01-3','B',1,3),
  ('B-02-1','B',2,1), ('B-02-2','B',2,2), ('B-02-3','B',2,3),
  ('B-03-1','B',3,1), ('B-03-2','B',3,2), ('B-03-3','B',3,3),
  ('B-04-1','B',4,1), ('B-04-2','B',4,2), ('B-04-3','B',4,3),
  ('B-05-1','B',5,1), ('B-05-2','B',5,2), ('B-05-3','B',5,3),
  ('B-06-1','B',6,1), ('B-06-2','B',6,2), ('B-06-3','B',6,3);

-- 20 種蔬果：名稱、保存天數、顏色照抄 Demo（保存天數是假設值，正式上線前由李太太提供）
INSERT IGNORE INTO product (id, name, shelf_days, color) VALUES
  ( 1, '甘藍菜',  60, '#2e86c1'),
  ( 2, '高麗菜',  60, '#28b463'),
  ( 3, '青花菜',  45, '#8e44ad'),
  ( 4, '花椰菜',  45, '#7f8c8d'),
  ( 5, '毛豆',   120, '#d35400'),
  ( 6, '玉米',   120, '#b7950b'),
  ( 7, '芒果',    90, '#e67e22'),
  ( 8, '荔枝',    90, '#e74c3c'),
  ( 9, '鳳梨',    90, '#c9a227'),
  (10, '芭樂',    60, '#16a085'),
  (11, '蓮霧',    45, '#ad1457'),
  (12, '木瓜',    60, '#ef6c00'),
  (13, '竹筍',    90, '#6d4c41'),
  (14, '洋蔥',   150, '#a1887f'),
  (15, '紅蘿蔔', 150, '#f4511e'),
  (16, '馬鈴薯', 150, '#5c6bc0'),
  (17, '四季豆',  60, '#558b2f'),
  (18, '菠菜',    30, '#1b5e20'),
  (19, '小黃瓜',  30, '#00897b'),
  (20, '番茄',    45, '#d32f2f');
