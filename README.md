# zhunan-inventory — 竹南冷凍倉儲 庫存管理系統

課程「1151 系統分析與設計」小組專案。個案：李太太的竹南冷凍倉儲公司，兩座冷凍庫、約 20 種蔬果，要把「大黑板」換成會自己算先進先出（FIFO）的庫存系統。

## 現在進度

| 階段 | 狀態 | 產出 |
|---|---|---|
| 1. 環境搭建 | ✅ | `AGENTS.md`、本 repo |
| 2. 產品設計 | ✅ 已確認 | [`docs/01-產品方案.md`](docs/01-產品方案.md)、[`docs/demo/index.html`](docs/demo/index.html) |
| 3. 技術設計 | ✅ 已確認 | [`docs/02-技術方案.md`](docs/02-技術方案.md) |
| 4. 產品實現 | ✅ M1～M6 完成：所有操作都寫進資料庫，前端沿用 Demo 的畫面與操作（技術方案 §6）；已照本 README 從零安裝實測通過（25 項自動測試全過，入庫／FIFO 出庫／移位／復原都確認寫進 MySQL） | `db/`、`src/`、`public/`、`test/`（照技術方案 §9 的順序做） |
| 5. 人工驗證 | 🟡 進行中 | `docs/03-驗證紀錄.md` |

## 先看 Demo

用瀏覽器直接開 `docs/demo/index.html`，不用安裝任何東西。裡面的畫面、FIFO 揀貨、地圖拖曳、復原／重做，都是之後正式版要做成一樣的。

## 資料庫建置與啟動

先裝好 Node.js 20+ 和 MySQL 8，然後在這個資料夾裡：

```bash
cp .env.example .env      # 小組統一 MySQL root 密碼 1234，不用改；密碼不同才改 .env 的 DB_PASSWORD
npm install
npm run db:init           # 建資料庫 zhunan：7 張表、A/B 兩座庫、36 格、20 種菜
npm run seed              # （選用）灌 Demo 那套假庫存，和 docs/demo 畫面上一模一樣
npm test                  # 自動測試，會另外建 zhunan_test / zhunan_test_api，不會動到 zhunan
npm start                 # 開 http://localhost:3000；手機連同一個 Wi-Fi，用終端機印出的網址
```


- 重跑 `npm run db:init` 是安全的，不會清掉資料。想整個清空重來：`npm run db:reset`，再 `npm run seed`。
- 資料表設計見 [`docs/02-技術方案.md`](docs/02-技術方案.md) §3；建置時補的細節在 §3.4。

## 接手開發（給組員）

1. 先讀 `AGENTS.md`（背景、老師的觀點、開發流程、技術約束）。
2. 再讀 `docs/02-技術方案.md`（已確認，不要自己改；要改先討論）。
3. 照上面「資料庫建置與啟動」把環境裝起來，`npm test` 要 25 項全綠。
4. 產品實現（M1～M6）已完成，現在是第 5 階段「人工驗證」。用 Claude Code 開這個資料夾，第一句話：

   > 讀 AGENTS.md 和 docs/01-產品方案.md，我們現在在「人工驗證」階段，程式已完成且自動測試全過，請帶我照產品方案 §4 的功能清單一項一項用網頁實際點過，結果寫進 docs/03-驗證紀錄.md。

5. 每做完一段 commit 一次，訊息格式 `[人工驗證] 做了什麼`。

技術棧已定案：Node.js + Express + mysql2 + MySQL 8，前端純 HTML/CSS/JS，不換。啟動步驟見上方「資料庫建置與啟動」。
