import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { readFile } from "node:fs/promises";
import { extname, join, normalize, resolve } from "node:path";
import {
  addBuy,
  addSell,
  getPosition,
  getQuoteCache,
  listDailySnapshots,
  listPositions,
  listTrades,
  saveQuoteCache,
  saveDailySnapshot
} from "./db.js";
import {
  assetLabel,
  fetchQuote,
  fetchUsdCnyRate,
  instrumentIdOf,
  quantityUnit,
  searchInstruments
} from "./quote.js";
import type { AssetType, Currency, InstrumentRef, Quote } from "./types.js";

const PORT = Number(process.env.PORT || 3000);
const publicDir = resolve(process.cwd(), "public");
const ASSET_TYPES = new Set<AssetType>(["cn", "us", "crypto"]);

function json(response: ServerResponse, status: number, data: unknown): void {
  response.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store"
  });
  response.end(JSON.stringify(data));
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : "未知错误";
}

async function readJson(request: IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of request) {
    const buffer = Buffer.from(chunk);
    size += buffer.length;
    if (size > 1_000_000) throw new Error("请求内容过大");
    chunks.push(buffer);
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8")) as Record<
      string,
      unknown
    >;
  } catch {
    throw new Error("请求数据不是有效 JSON");
  }
}

function positiveNumber(value: unknown, name: string): number {
  const number = Number(value);
  if (!Number.isFinite(number) || number <= 0) {
    throw new Error(`${name}必须大于 0`);
  }
  return number;
}

function tradeTime(value: unknown): string {
  if (!value) return new Date().toISOString();
  const date = new Date(String(value));
  if (Number.isNaN(date.getTime())) throw new Error("交易时间无效");
  return date.toISOString();
}

function parseAssetType(value: unknown): AssetType {
  const assetType = String(value || "");
  if (!ASSET_TYPES.has(assetType as AssetType)) {
    throw new Error("请选择 A 股、美股或加密货币");
  }
  return assetType as AssetType;
}

function parseInstrument(body: Record<string, unknown>): InstrumentRef & {
  instrumentId: string;
} {
  const assetType = parseAssetType(body.assetType);
  const symbol = String(body.symbol || "").trim();
  const secid = String(body.secid || "").trim();
  const instrumentId = String(body.instrumentId || "").trim();
  if (!symbol || !instrumentId) {
    throw new Error("请先搜索并选择标的，确认后再记录");
  }
  const ref: InstrumentRef = { assetType, symbol, secid };
  const expected = instrumentIdOf(ref);
  if (instrumentId !== expected) {
    throw new Error("所选标的已失效，请重新搜索后再记录");
  }
  return { ...ref, instrumentId };
}

function buyQuantity(assetType: AssetType, amount: number, price: number): number {
  const unit = quantityUnit(assetType);
  if (assetType === "cn") {
    const shares = Math.floor(amount / price / 100) * 100;
    if (shares < 100) {
      throw new Error(
        `金额不足，按 ${price.toFixed(2)} 元至少需要 ${(price * 100).toFixed(2)} 元`
      );
    }
    return shares;
  }
  const scale = assetType === "us" ? 10000 : 100_000_000;
  const quantity = Math.floor((amount / price) * scale) / scale;
  if (quantity <= 0) {
    throw new Error(`金额不足，无法按当前价格买入至少 1 ${unit === "枚" ? "枚代币" : "股"}`);
  }
  return quantity;
}

function shanghaiDay(date = new Date()): string {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Shanghai",
    year: "numeric",
    month: "2-digit",
    day: "2-digit"
  }).format(date);
}

function isWeekday(timeZone: string, date = new Date()): boolean {
  const weekday = new Intl.DateTimeFormat("en-US", {
    timeZone,
    weekday: "short"
  }).format(date);
  return weekday !== "Sat" && weekday !== "Sun";
}

function secondsOfDay(timeZone: string, date = new Date()): number {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone,
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false
  }).formatToParts(date);
  const part = (type: string) => parts.find((item) => item.type === type)?.value;
  return (
    Number(part("hour")) * 3600 +
    Number(part("minute")) * 60 +
    Number(part("second"))
  );
}

function isCnTradingTime(date = new Date()): boolean {
  if (!isWeekday("Asia/Shanghai", date)) return false;
  const seconds = secondsOfDay("Asia/Shanghai", date);
  const morning = seconds >= 9.5 * 3600 && seconds <= 11.5 * 3600;
  const afternoon = seconds >= 13 * 3600 && seconds <= 15 * 3600;
  return morning || afternoon;
}

function isUsTradingTime(date = new Date()): boolean {
  if (!isWeekday("America/New_York", date)) return false;
  const seconds = secondsOfDay("America/New_York", date);
  return seconds >= 9.5 * 3600 && seconds <= 16 * 3600;
}

function toCny(amount: number, currency: Currency, usdCny: number | null): number {
  if (currency === "CNY") return amount;
  return usdCny ? amount * usdCny : amount;
}

async function liveQuote(ref: InstrumentRef): Promise<Quote> {
  const quote = await fetchQuote(ref);
  saveQuoteCache(quote);
  return quote;
}

async function dashboard() {
  const allPositions = listPositions();
  let usdCny: number | null = null;
  let fxAvailable = true;
  if (allPositions.some((position) => position.currency === "USD")) {
    try {
      usdCny = await fetchUsdCnyRate();
    } catch {
      fxAvailable = false;
    }
  }

  const quoteEntries: Array<
    readonly [string, { quote: Quote | null; isLive: boolean }]
  > = await Promise.all(
    allPositions
      .filter((position) => position.shares > 0)
      .map(async (position) => {
        try {
          const quote = await liveQuote({
            assetType: position.asset_type,
            symbol: position.symbol,
            secid: position.secid
          });
          return [position.instrument_id, { quote, isLive: true }] as const;
        } catch {
          return [
            position.instrument_id,
            {
              quote: getQuoteCache(position.instrument_id) ?? null,
              isLive: false
            }
          ] as const;
        }
      })
  );
  const quotes = new Map(quoteEntries);

  const positions = allPositions
    .filter((position) => position.shares > 0)
    .map((position) => {
      const quoteResult = quotes.get(position.instrument_id);
      const quote = quoteResult?.quote;
      const currentPrice = quote?.price ?? position.avg_cost;
      const holdingPnl = (currentPrice - position.avg_cost) * position.shares;
      return {
        instrumentId: position.instrument_id,
        assetType: position.asset_type,
        assetLabel: assetLabel(position.asset_type, position.name),
        symbol: position.symbol,
        name: position.name,
        currency: position.currency,
        shares: position.shares,
        avgCost: position.avg_cost,
        currentPrice,
        marketValue: currentPrice * position.shares,
        holdingPnl,
        holdingPnlPercent: position.avg_cost
          ? ((currentPrice - position.avg_cost) / position.avg_cost) * 100
          : 0,
        change: quote?.change ?? 0,
        changePercent: quote?.changePercent ?? 0,
        quoteTime: quote?.quoteTime ?? null,
        quoteAvailable: Boolean(quoteResult?.isLive),
        quoteCached: Boolean(quote && !quoteResult?.isLive)
      };
    });

  const realizedPnl = allPositions.reduce(
    (sum, position) =>
      sum + toCny(position.realized_pnl, position.currency, usdCny),
    0
  );
  const holdingPnl = positions.reduce(
    (sum, position) => sum + toCny(position.holdingPnl, position.currency, usdCny),
    0
  );
  const totalPnl = realizedPnl + holdingPnl;
  const day = shanghaiDay();
  const usedCachedQuotes = [...quotes.values()].some((result) => !result.isLive);
  const hasMissingQuotes = [...quotes.values()].some((result) => !result.quote);
  if (!usedCachedQuotes && fxAvailable) {
    saveDailySnapshot({ day, totalPnl, realizedPnl, holdingPnl });
  }

  const snapshots = listDailySnapshots();
  const daily = snapshots
    .map((snapshot, index) => ({
      day: snapshot.day,
      dailyPnl:
        snapshot.total_pnl - (index > 0 ? snapshots[index - 1]!.total_pnl : 0),
      totalPnl: snapshot.total_pnl,
      realizedPnl: snapshot.realized_pnl,
      holdingPnl: snapshot.holding_pnl
    }))
    .reverse();

  return {
    summary: {
      totalPnl,
      dailyPnl: daily[0]?.dailyPnl ?? 0,
      realizedPnl,
      holdingPnl,
      marketValue: positions.reduce(
        (sum, position) =>
          sum + toCny(position.marketValue, position.currency, usdCny),
        0
      ),
      usdCny,
      fxAvailable
    },
    positions,
    daily,
    usedCachedQuotes,
    hasMissingQuotes,
    hasCrypto: positions.some((position) => position.assetType === "crypto"),
    market: {
      cnOpen: isCnTradingTime(),
      usOpen: isUsTradingTime()
    },
    updatedAt: new Date().toISOString()
  };
}

async function api(
  request: IncomingMessage,
  response: ServerResponse,
  url: URL
): Promise<boolean> {
  if (!url.pathname.startsWith("/api/")) return false;

  try {
    if (request.method === "GET" && url.pathname === "/api/search") {
      const query = url.searchParams.get("q") || "";
      const assetType = parseAssetType(url.searchParams.get("type"));
      json(response, 200, await searchInstruments(query, assetType));
      return true;
    }

    if (request.method === "GET" && url.pathname === "/api/quote") {
      const assetType = parseAssetType(url.searchParams.get("type"));
      const symbol = String(url.searchParams.get("symbol") || "").trim();
      const secid = String(url.searchParams.get("secid") || "").trim();
      if (!symbol) throw new Error("请先搜索并选择标的");
      json(response, 200, await liveQuote({ assetType, symbol, secid }));
      return true;
    }

    if (request.method === "GET" && url.pathname === "/api/dashboard") {
      json(response, 200, await dashboard());
      return true;
    }

    if (request.method === "GET" && url.pathname === "/api/trades") {
      json(response, 200, listTrades(200));
      return true;
    }

    if (request.method === "POST" && url.pathname === "/api/trades/buy") {
      const body = await readJson(request);
      const instrument = parseInstrument(body);
      const amount = positiveNumber(body.amount, "投入金额");
      let quote: Quote;
      try {
        quote = await liveQuote(instrument);
      } catch (error) {
        throw new Error(
          `未搜索到可用行情，无法记录买入：${errorMessage(error)}`
        );
      }
      const price =
        body.price === undefined || body.price === ""
          ? quote.price
          : positiveNumber(body.price, "买入价格");
      const shares = buyQuantity(instrument.assetType, amount, price);
      const name =
        instrument.assetType === "crypto"
          ? String(body.name || quote.name)
          : quote.name;
      addBuy({
        instrumentId: instrument.instrumentId,
        assetType: instrument.assetType,
        symbol: quote.symbol,
        secid: quote.secid || instrument.secid,
        name,
        currency: quote.currency,
        shares,
        price,
        tradedAt: tradeTime(body.tradedAt)
      });
      const usedAmount = shares * price;
      json(response, 201, {
        message: `已记录买入 ${name} ${formatQty(shares)} ${quantityUnit(instrument.assetType)}`,
        shares,
        price,
        currency: quote.currency,
        usedAmount,
        remainingAmount: amount - usedAmount
      });
      return true;
    }

    if (request.method === "POST" && url.pathname === "/api/trades/sell") {
      const body = await readJson(request);
      const instrumentId = String(body.instrumentId || "").trim();
      if (!instrumentId) throw new Error("请选择要卖出的持仓");
      const position = getPosition(instrumentId);
      if (!position || position.shares <= 0) throw new Error("该标的当前没有持仓");
      const shares =
        body.shares === undefined || body.shares === ""
          ? position.shares
          : positiveNumber(body.shares, "卖出数量");
      if (position.asset_type === "cn" && !Number.isInteger(shares)) {
        throw new Error("A 股卖出股数必须是整数");
      }
      let price: number;
      try {
        const quote = await liveQuote({
          assetType: position.asset_type,
          symbol: position.symbol,
          secid: position.secid
        });
        price =
          body.price === undefined || body.price === ""
            ? quote.price
            : positiveNumber(body.price, "卖出价格");
      } catch (error) {
        if (body.price === undefined || body.price === "") {
          throw new Error(`没有可用行情，请手动填写卖出价格：${errorMessage(error)}`);
        }
        price = positiveNumber(body.price, "卖出价格");
      }
      const result = addSell({
        instrumentId,
        shares,
        price,
        tradedAt: tradeTime(body.tradedAt)
      });
      json(response, 201, {
        message:
          result.remainingShares === 0
            ? `已记录全部清仓 ${position.name}`
            : `已记录卖出 ${position.name} ${formatQty(shares)} ${quantityUnit(position.asset_type)}`,
        shares,
        price,
        currency: position.currency,
        ...result
      });
      return true;
    }

    json(response, 404, { error: "接口不存在" });
  } catch (error) {
    json(response, 400, { error: errorMessage(error) });
  }
  return true;
}

function formatQty(value: number): string {
  return String(Number(value.toPrecision(12)));
}

async function staticFile(
  response: ServerResponse,
  pathname: string
): Promise<void> {
  const requested = pathname === "/" ? "index.html" : pathname.slice(1);
  const safePath = normalize(requested).replace(/^(\.\.[/\\])+/, "");
  const filePath = join(publicDir, safePath);
  try {
    const content = await readFile(filePath);
    const contentTypes: Record<string, string> = {
      ".html": "text/html; charset=utf-8",
      ".js": "text/javascript; charset=utf-8",
      ".css": "text/css; charset=utf-8",
      ".svg": "image/svg+xml"
    };
    response.writeHead(200, {
      "Content-Type":
        contentTypes[extname(filePath)] || "application/octet-stream"
    });
    response.end(content);
  } catch {
    response.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" });
    response.end("Not found");
  }
}

const server = createServer(async (request, response) => {
  const url = new URL(request.url || "/", `http://${request.headers.host}`);
  if (await api(request, response, url)) return;
  await staticFile(response, url.pathname);
});

server.listen(PORT, () => {
  console.log(`投资收益记录已启动：http://localhost:${PORT}`);
});
