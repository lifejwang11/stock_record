import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { readFile } from "node:fs/promises";
import { extname, join, normalize, resolve } from "node:path";
import {
  addBuy,
  addSell,
  getPosition,
  getQuoteCache,
  listDailySnapshotBreakdowns,
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
const ASSET_TYPES = new Set<AssetType>(["cn", "fund", "us", "crypto", "gold"]);

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
    throw new Error("请选择 A 股、场外基金、美股、加密货币或积存金");
  }
  return assetType as AssetType;
}

function parseSearchMatch(value: string | null): "fuzzy" | "exact" {
  if (!value || value === "fuzzy") return "fuzzy";
  if (value === "exact") return "exact";
  throw new Error("搜索匹配方式无效");
}

function exactSearchHits<T extends { symbol: string; name: string }>(
  hits: T[],
  query: string
): T[] {
  const needle = query.trim().toLocaleLowerCase("zh-CN");
  return hits.filter(
    (hit) =>
      hit.symbol.trim().toLocaleLowerCase("zh-CN") === needle ||
      hit.name.trim().toLocaleLowerCase("zh-CN") === needle
  );
}

function parseInstrument(body: Record<string, unknown>): InstrumentRef & {
  instrumentId: string;
} {
  const requestedAssetType = parseAssetType(body.assetType);
  const symbol = String(body.symbol || "").trim();
  const secid = String(body.secid || "").trim();
  const instrumentId = String(body.instrumentId || "").trim();
  if (!symbol || !instrumentId) {
    throw new Error("请先搜索并选择标的，确认后再记录");
  }
  const assetType =
    requestedAssetType === "cn" && secid.startsWith("150.")
      ? ("fund" as const)
      : requestedAssetType;
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
  if (assetType === "fund") {
    const shares = Math.floor((amount / price) * 100) / 100;
    if (shares <= 0) throw new Error("金额不足，无法按当前净值买入至少 0.01 份");
    return shares;
  }
  const scale =
    assetType === "us" ? 10000 : assetType === "gold" ? 100 : 100_000_000;
  const quantity = Math.floor((amount / price) * scale) / scale;
  if (quantity <= 0) {
    const minLabel =
      assetType === "gold" ? "0.01 克" : unit === "枚" ? "1 枚代币" : "1 股";
    throw new Error(`金额不足，无法按当前价格买入至少 ${minLabel}`);
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

function hasCnSessionStarted(date = new Date()): boolean {
  if (!isWeekday("Asia/Shanghai", date)) return false;
  return secondsOfDay("Asia/Shanghai", date) >= 9.5 * 3600;
}

function isQuoteOnShanghaiDay(quoteTime: string | null, date = new Date()): boolean {
  if (!quoteTime) return false;
  const quoted = new Date(quoteTime);
  if (Number.isNaN(quoted.getTime())) return false;
  return shanghaiDay(quoted) === shanghaiDay(date);
}

function cnDailyMoveLive(quoteTime: string | null, date = new Date()): boolean {
  return hasCnSessionStarted(date) && isQuoteOnShanghaiDay(quoteTime, date);
}

function isUsTradingTime(date = new Date()): boolean {
  if (!isWeekday("America/New_York", date)) return false;
  const seconds = secondsOfDay("America/New_York", date);
  return seconds >= 9.5 * 3600 && seconds <= 16 * 3600;
}

function isGoldTradingTime(date = new Date()): boolean {
  const weekday = new Intl.DateTimeFormat("en-US", {
    timeZone: "Asia/Shanghai",
    weekday: "short"
  }).format(date);
  const seconds = secondsOfDay("Asia/Shanghai", date);
  if (weekday === "Sun") return false;
  if (weekday === "Sat") return seconds < 4 * 3600;
  if (weekday === "Mon") return seconds >= 9 * 3600;
  return true;
}

function toCny(amount: number, currency: Currency, usdCny: number | null): number {
  if (currency === "CNY") return amount;
  return usdCny ? amount * usdCny : amount;
}

const CATEGORY_ORDER = ["美股", "加密货币", "A股", "ETF", "LOF", "场外基金", "积存金"];
const POSITION_ASSET_ORDER: AssetType[] = ["us", "crypto", "cn", "fund", "gold"];

interface CategoryBreakdown {
  label: string;
  currency: Currency;
  totalPnl: number;
  dailyPnl: number;
  holdingPnl: number;
  realizedPnl: number;
  marketValue: number;
  totalPnlCny: number | null;
  dailyPnlCny: number | null;
  holdingPnlCny: number | null;
  realizedPnlCny: number | null;
  marketValueCny: number | null;
}

function categoryCurrency(label: string): Currency {
  return label === "美股" || label === "加密货币" ? "USD" : "CNY";
}

function emptyBreakdown(label: string): CategoryBreakdown {
  return {
    label,
    currency: categoryCurrency(label),
    totalPnl: 0,
    dailyPnl: 0,
    holdingPnl: 0,
    realizedPnl: 0,
    marketValue: 0,
    totalPnlCny: null,
    dailyPnlCny: null,
    holdingPnlCny: null,
    realizedPnlCny: null,
    marketValueCny: null
  };
}

function convertIfForeign(
  amount: number,
  currency: Currency,
  usdCny: number | null
): number | null {
  if (currency === "CNY" || !usdCny) return null;
  return toCny(amount, currency, usdCny);
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
      const dailyMoveLive =
        !["cn", "fund"].includes(position.asset_type) ||
        cnDailyMoveLive(quote?.quoteTime ?? null);
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
        marketValueCny: convertIfForeign(
          currentPrice * position.shares,
          position.currency,
          usdCny
        ),
        holdingPnl,
        holdingPnlCny: convertIfForeign(holdingPnl, position.currency, usdCny),
        holdingPnlPercent: position.avg_cost
          ? ((currentPrice - position.avg_cost) / position.avg_cost) * 100
          : 0,
        change: dailyMoveLive ? (quote?.change ?? 0) : 0,
        changePercent: dailyMoveLive ? (quote?.changePercent ?? 0) : 0,
        dailyMoveLive,
        quoteTime: quote?.quoteTime ?? null,
        quoteAvailable: Boolean(quoteResult?.isLive),
        quoteCached: Boolean(quote && !quoteResult?.isLive)
      };
    })
    .sort((a, b) => {
      const left = POSITION_ASSET_ORDER.indexOf(a.assetType);
      const right = POSITION_ASSET_ORDER.indexOf(b.assetType);
      const typeDiff = (left < 0 ? 99 : left) - (right < 0 ? 99 : right);
      if (typeDiff !== 0) return typeDiff;
      return (
        a.name.localeCompare(b.name, "zh-CN") ||
        a.symbol.localeCompare(b.symbol, "zh-CN")
      );
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
  const groups = new Map<string, CategoryBreakdown>();
  const dailyInstrumentPnl = new Map<
    string,
    {
      category: string;
      instrumentId: string;
      symbol: string;
      name: string;
      currency: Currency;
      dailyPnl: number;
    }
  >();
  const dailyInstrument = (input: {
    category: string;
    instrumentId: string;
    symbol: string;
    name: string;
    currency: Currency;
  }) => {
    const current = dailyInstrumentPnl.get(input.instrumentId);
    if (current) return current;
    const created = { ...input, dailyPnl: 0 };
    dailyInstrumentPnl.set(input.instrumentId, created);
    return created;
  };
  const bucket = (label: string) => {
    const current = groups.get(label);
    if (current) return current;
    const created = emptyBreakdown(label);
    groups.set(label, created);
    return created;
  };
  for (const position of allPositions) {
    bucket(assetLabel(position.asset_type, position.name)).realizedPnl +=
      position.realized_pnl;
  }
  for (const position of positions) {
    const item = bucket(position.assetLabel);
    item.holdingPnl += position.holdingPnl;
    item.marketValue += position.marketValue;
    item.dailyPnl += position.change * position.shares;
    dailyInstrument({
      category: position.assetLabel,
      instrumentId: position.instrumentId,
      symbol: position.symbol,
      name: position.name,
      currency: position.currency
    }).dailyPnl += position.change * position.shares;
  }
  for (const trade of listTrades(500)) {
    if (trade.side !== "SELL") continue;
    if (shanghaiDay(new Date(trade.traded_at)) !== day) continue;
    const category = assetLabel(trade.asset_type, trade.name);
    bucket(category).dailyPnl += trade.realized_pnl;
    dailyInstrument({
      category,
      instrumentId: trade.instrument_id,
      symbol: trade.symbol,
      name: trade.name,
      currency: trade.currency
    }).dailyPnl += trade.realized_pnl;
  }
  for (const item of groups.values()) {
    item.totalPnl = item.holdingPnl + item.realizedPnl;
    item.totalPnlCny = convertIfForeign(item.totalPnl, item.currency, usdCny);
    item.dailyPnlCny = convertIfForeign(item.dailyPnl, item.currency, usdCny);
    item.holdingPnlCny = convertIfForeign(item.holdingPnl, item.currency, usdCny);
    item.realizedPnlCny = convertIfForeign(item.realizedPnl, item.currency, usdCny);
    item.marketValueCny = convertIfForeign(item.marketValue, item.currency, usdCny);
  }
  const breakdown = [...groups.values()]
    .filter(
      (item) =>
        item.marketValue !== 0 ||
        item.holdingPnl !== 0 ||
        item.realizedPnl !== 0 ||
        item.dailyPnl !== 0 ||
        item.totalPnl !== 0
    )
    .sort((a, b) => {
      const left = CATEGORY_ORDER.indexOf(a.label);
      const right = CATEGORY_ORDER.indexOf(b.label);
      return (left === -1 ? 99 : left) - (right === -1 ? 99 : right);
    });
  const usedCachedQuotes = [...quotes.values()].some((result) => !result.isLive);
  const hasMissingQuotes = [...quotes.values()].some((result) => !result.quote);
  const dailyPnl = breakdown.reduce(
    (sum, item) => sum + toCny(item.dailyPnl, item.currency, usdCny),
    0
  );
  if (!usedCachedQuotes && fxAvailable) {
    saveDailySnapshot({
      day,
      dailyPnl,
      totalPnl,
      realizedPnl,
      holdingPnl,
      breakdowns: [...dailyInstrumentPnl.values()].map((item) => ({
        ...item,
        dailyPnlCny: toCny(item.dailyPnl, item.currency, usdCny)
      }))
    });
  }

  const snapshots = listDailySnapshots();
  const storedBreakdowns = listDailySnapshotBreakdowns();
  const breakdownsByDay = new Map<string, typeof storedBreakdowns>();
  for (const item of storedBreakdowns) {
    const items = breakdownsByDay.get(item.day) ?? [];
    items.push(item);
    breakdownsByDay.set(item.day, items);
  }
  const daily = snapshots
    .map((snapshot, index) => ({
      day: snapshot.day,
      dailyPnl:
        snapshot.daily_pnl ??
        snapshot.total_pnl - (index > 0 ? snapshots[index - 1]!.total_pnl : 0),
      totalPnl: snapshot.total_pnl,
      realizedPnl: snapshot.realized_pnl,
      holdingPnl: snapshot.holding_pnl,
      breakdown: (breakdownsByDay.get(snapshot.day) ?? []).map((item) => ({
        category: item.category,
        instrumentId: item.instrument_id,
        symbol: item.symbol,
        name: item.name,
        currency: item.currency,
        dailyPnl: item.daily_pnl,
        dailyPnlCny: item.daily_pnl_cny
      }))
    }))
    .reverse();

  return {
    summary: {
      totalPnl,
      dailyPnl,
      realizedPnl,
      holdingPnl,
      marketValue: positions.reduce(
        (sum, position) =>
          sum + toCny(position.marketValue, position.currency, usdCny),
        0
      ),
      usdCny,
      fxAvailable,
      breakdown
    },
    positions,
    daily,
    usedCachedQuotes,
    hasMissingQuotes,
    hasCrypto: positions.some((position) => position.assetType === "crypto"),
    hasGold: positions.some((position) => position.assetType === "gold"),
    market: {
      cnOpen: isCnTradingTime(),
      cnSessionStarted: hasCnSessionStarted(),
      usOpen: isUsTradingTime(),
      goldOpen: isGoldTradingTime()
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
      const match = parseSearchMatch(url.searchParams.get("match"));
      const hits = await searchInstruments(query, assetType);
      json(response, 200, match === "exact" ? exactSearchHits(hits, query) : hits);
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
        instrument.assetType === "crypto" ||
        instrument.assetType === "gold" ||
        instrument.assetType === "fund"
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
        contentTypes[extname(filePath)] || "application/octet-stream",
      "Cache-Control": "no-store"
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
