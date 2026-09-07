# 投资收益簿

个人持仓记录工具：在本地记账，用公共行情刷新市值和收益。支持 A 股、场内 ETF / LOF、全部场外公募基金、美股、加密货币和银行积存金。

无前端框架，无外部数据库。Node.js 内置 `node:sqlite` + 原生 HTTP，数据只存在本机。

> 仅供个人记账，不构成投资建议。佣金、印花税、过户费和链上手续费当前版本未计入。

## 功能

- **先搜索再记账**：买入前必须搜索并选中标的，确认有行情后才能下账
- **可选匹配方式**：模糊匹配支持名称片段，完全匹配只接受完整代码或完整名称
- **按市场规则算数量**
  - A 股 / 场内 ETF：按 100 股一手计算最大可买股数
  - 场外基金：按最新单位净值计算份额，精确到 0.01 份
  - 美股：支持碎股
  - 加密货币：按代币数量记录
  - 积存金：按克记录，最小 0.01 克
- **价格可手动覆盖**：买入 / 卖出价格留空时使用公共行情当前价
- **卖出可部分或清仓**：数量留空默认全部卖出
- **自动刷新**
  - A 股交易时段（北京时间工作日 09:30–11:30、13:00–15:00）或美股交易时段：每 5 秒刷新
  - 有加密货币持仓时：全天刷新
  - 有积存金持仓且处于交易时段（北京时间周一 09:00 至周六 04:00）：每 5 秒刷新
- **收益看板**：累计总收益、今日收益、已实现收益、持仓收益、当前市值（美元资产按离岸人民币汇率折算）
- **本地持久化**：SQLite 保存持仓、交易流水、每日收益快照（含分类和标的明细）及最近一次成功行情
- **每日收益明细**：鼠标移到每日收益数值，可按盈利从高到低查看当日分类及分类下标的

## 技术栈

| 层 | 实现 |
| --- | --- |
| 运行时 | Node.js ≥ 22.5（使用内置 `node:sqlite`、`node:http`） |
| 语言 | TypeScript（服务端 `NodeNext`，前端编译到 `public/app.js`） |
| 存储 | SQLite，默认路径 `data/stocks.db` |
| 前端 | 无框架，原生 HTML / CSS / TypeScript |

## 快速开始

```bash
git clone git@github.com:lifejwang11/stock_record.git
cd stock_record
npm install
npm start
```

浏览器打开 <http://localhost:3000>。

开发时可用 `npm run dev`（编译后 `--watch` 重启服务端）。类型检查：`npm run typecheck`。

### 环境变量

| 变量 | 默认值 | 说明 |
| --- | --- | --- |
| `PORT` | `3000` | HTTP 端口 |
| `DB_PATH` | `data/stocks.db` | SQLite 文件路径 |

```bash
DB_PATH=/path/to/stocks.db PORT=8080 npm start
```

本仓库**不包含**任何持仓或交易数据。`data/`、`node_modules/`、编译产物 `dist/` 和 `public/app.js` 均已加入 `.gitignore`。首次启动会自动创建空数据库。

## 项目结构

```
.
├── src/
│   ├── server/
│   │   ├── server.ts   # HTTP 服务与买卖接口
│   │   ├── db.ts       # SQLite schema、持仓与流水
│   │   ├── quote.ts    # 搜索 / 行情 / 汇率
│   │   └── types.ts
│   └── client/
│       └── app.ts      # 页面交互，编译到 public/app.js
├── public/
│   ├── index.html
│   └── styles.css
├── data/               # 本地数据库（不入库）
├── package.json
└── tsconfig.*.json
```

## 收益口径

持仓成本采用**移动加权平均成本**。

| 指标 | 计算 |
| --- | --- |
| 已实现收益 | `(卖出价 - 平均成本价) × 卖出数量` |
| 持仓收益 | `(当前价 - 平均成本价) × 当前数量` |
| 累计总收益 | 已实现收益 + 持仓收益 |
| 每日收益 | 持仓标的当日价格变动收益 + 当日卖出实现收益（均折算为人民币） |

汇总时，美元资产按离岸人民币（USDCNH）折算。汇率不可用时，当日快照不会覆盖，避免用残缺数据改写历史。

行情全部失败时，沿用 SQLite 中最后一次成功行情；不覆盖收益快照，下个刷新周期继续重试。

## 行情源

均走公共接口，无需密钥。A 股 / 美股优先东方财富，失败后切腾讯；场外基金使用东方财富最新公布的单位净值；加密货币优先 Binance，失败后切 OKX；积存金走京东金融银行积存金报价，失败后切对应产品 SKU 接口。

- `https://searchapi.eastmoney.com/api/suggest/get`
- `https://push2.eastmoney.com/api/qt/stock/get`
- `https://api.fund.eastmoney.com/f10/lsjz`
- `https://qt.gtimg.cn/q=`
- `https://api.binance.com/api/v3/ticker/24hr`
- `https://api.binance.com/api/v3/exchangeInfo`
- `https://www.okx.com/api/v5/market/ticker`
- `https://api.jdjygold.com/gw2/generic/produTools/h5/m/getGoldPrice`
- `https://api.jdjygold.com/gw2/generic/jrm/h5/m/stdLatestPrice`

接口可用性和数据准确性由数据提供方决定。积存金目前可记账浙商、民生、工商、广发、兴业、中信，价格单位为元/克。

## HTTP 接口

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| `GET` | `/api/search?type=cn\|fund\|us\|crypto\|gold&match=fuzzy\|exact&q=` | 搜索标的；`cn` 同时返回场内证券和场外基金 |
| `GET` | `/api/quote` | 拉取单标的行情 |
| `GET` | `/api/dashboard` | 看板：汇总、持仓、每日收益 |
| `GET` | `/api/trades` | 最近交易流水 |
| `POST` | `/api/trades/buy` | 记录买入 |
| `POST` | `/api/trades/sell` | 记录卖出 / 清仓 |

静态页面由同一进程提供：`/`、`/styles.css`、`/app.js`。
