import type {
  AssetType,
  Currency,
  InstrumentRef,
  Quote,
  SearchHit
} from "./types.js";

const EAST_MONEY_ENDPOINT = "https://push2.eastmoney.com/api/qt/stock/get";
const EAST_MONEY_SEARCH = "https://searchapi.eastmoney.com/api/suggest/get";
const EAST_MONEY_SEARCH_TOKEN = "D43BF722C8E33BDC906FB84D85E326E8";
const TENCENT_ENDPOINT = "https://qt.gtimg.cn/q=";
const COINGECKO_SEARCH = "https://api.coingecko.com/api/v3/search";
const COINGECKO_PRICE = "https://api.coingecko.com/api/v3/simple/price";
const OKX_TICKER = "https://www.okx.com/api/v5/market/ticker";
const OKX_INSTRUMENTS = "https://www.okx.com/api/v5/public/instruments";
const USD_CNH_SECID = "133.USDCNH";

const PROVIDER_TIMEOUT_MS = 2200;
const SEARCH_TIMEOUT_MS = 2800;
const QUOTE_FIELDS = [
  "f43",
  "f44",
  "f45",
  "f46",
  "f57",
  "f58",
  "f60",
  "f86",
  "f169",
  "f170"
].join(",");

const CN_MARKET_NAMES = new Set([
  "沪A",
  "深A",
  "创业板",
  "科创板",
  "京A",
  "北证A",
  "北交所",
  "沪B",
  "深B"
]);
const US_MARKET_IDS = new Set(["105", "106", "107"]);
const US_MARKET_LABEL: Record<string, string> = {
  "105": "NASDAQ",
  "106": "NYSE",
  "107": "AMEX"
};

const headers = {
  eastmoney: {
    Referer: "https://quote.eastmoney.com/",
    "User-Agent": "Mozilla/5.0 InvestmentLedger/1.0"
  },
  tencent: {
    Referer: "https://gu.qq.com/",
    "User-Agent": "Mozilla/5.0 InvestmentLedger/1.0"
  }
};

let fxCache: { rate: number; at: number } | null = null;
const FX_TTL_MS = 5 * 60 * 1000;

export function instrumentIdOf(ref: InstrumentRef): string {
  if (ref.assetType === "crypto") {
    const key = (ref.secid || ref.symbol).trim().toLowerCase();
    return `crypto:${key}`;
  }
  return `${ref.assetType}:${ref.symbol.trim().toUpperCase()}`;
}

export function assetLabel(assetType: AssetType, name = ""): string {
  if (assetType === "us") return "美股";
  if (assetType === "crypto") return "加密货币";
  if (/ETF/i.test(name)) return "ETF";
  if (/LOF/i.test(name)) return "LOF";
  return "A股";
}

export function quantityUnit(assetType: AssetType): string {
  return assetType === "crypto" ? "枚" : "股";
}

export function normalizeCnSymbol(input: string): {
  symbol: string;
  secid: string;
  market: "sh" | "sz" | "bj";
} {
  const cleaned = input.trim().toLowerCase();
  const match = cleaned.match(/^(?:(sh|sz|bj))?(\d{6})$/);
  if (!match) {
    throw new Error("A 股/ETF 代码应为 6 位数字，例如 600519 或 159530");
  }

  const symbol = match[2]!;
  let market = match[1];
  if (!market) {
    if (/^(4|8|92)/.test(symbol)) market = "bj";
    else if (/^(5|6|9)/.test(symbol)) market = "sh";
    else market = "sz";
  }

  return {
    symbol,
    secid: `${market === "sh" ? 1 : 0}.${symbol}`,
    market: market as "sh" | "sz" | "bj"
  };
}

export async function searchInstruments(
  query: string,
  assetType: AssetType
): Promise<SearchHit[]> {
  const keyword = query.trim();
  if (!keyword) throw new Error("请输入要搜索的名称或代码");
  if (assetType === "crypto") return searchCrypto(keyword);
  return searchEastMoney(keyword, assetType);
}

export async function fetchQuote(ref: InstrumentRef): Promise<Quote> {
  if (ref.assetType === "crypto") return fetchCryptoQuote(ref);
  if (ref.assetType === "us") return fetchUsQuote(ref);
  return fetchCnQuote(ref);
}

export async function fetchUsdCnyRate(): Promise<number> {
  if (fxCache && Date.now() - fxCache.at < FX_TTL_MS) return fxCache.rate;
  const errors: string[] = [];

  try {
    const payload = await requestEastMoney(USD_CNH_SECID);
    const rate = finiteNumber(payload.data?.f43);
    if (rate > 0) {
      fxCache = { rate, at: Date.now() };
      return rate;
    }
    errors.push("东方财富汇率无效");
  } catch (error) {
    errors.push(errorMessage(error));
  }

  if (fxCache) return fxCache.rate;
  throw new Error(`美元汇率不可用：${errors.join("；")}`);
}

async function searchEastMoney(
  keyword: string,
  assetType: "cn" | "us"
): Promise<SearchHit[]> {
  const url = new URL(EAST_MONEY_SEARCH);
  url.searchParams.set("input", keyword);
  url.searchParams.set("type", "14");
  url.searchParams.set("token", EAST_MONEY_SEARCH_TOKEN);
  url.searchParams.set("count", "20");

  const response = await fetch(url, {
    headers: headers.eastmoney,
    signal: AbortSignal.timeout(SEARCH_TIMEOUT_MS)
  });
  if (!response.ok) throw new Error(`搜索服务返回 ${response.status}`);
  const payload = (await response.json()) as {
    QuotationCodeTable?: {
      Data?: Array<Record<string, string | number | null>>;
    };
  };
  const rows = payload.QuotationCodeTable?.Data ?? [];
  const hits: SearchHit[] = [];
  const seen = new Set<string>();

  for (const row of rows) {
    const symbol = String(row.Code || "").trim();
    const name = String(row.Name || "").trim();
    const secid = String(row.QuoteID || "").trim();
    const marketName = String(row.SecurityTypeName || "").trim();
    const mktNum = String(row.MktNum || "");
    if (!symbol || !name || !secid) continue;

    if (assetType === "cn") {
      if (!isCnListedHit(symbol, secid, mktNum, marketName)) continue;
    } else {
      if (marketName !== "美股" || !US_MARKET_IDS.has(mktNum)) continue;
      if (/notes|债券|债/i.test(name)) continue;
    }

    const ref: InstrumentRef = {
      assetType,
      symbol: assetType === "us" ? symbol.toUpperCase() : symbol,
      secid
    };
    const id = instrumentIdOf(ref);
    if (seen.has(id)) continue;
    seen.add(id);
    hits.push({
      ...ref,
      instrumentId: id,
      name,
      market:
        assetType === "us"
          ? US_MARKET_LABEL[mktNum] || "美股"
          : cnMarketLabel(name, marketName),
      currency: assetType === "us" ? "USD" : "CNY"
    });
  }

  return hits;
}

async function searchCrypto(keyword: string): Promise<SearchHit[]> {
  try {
    return await searchCoinGecko(keyword);
  } catch (error) {
    try {
      return await searchOkx(keyword);
    } catch {
      throw new Error(`加密货币搜索失败：${errorMessage(error)}`);
    }
  }
}

async function searchCoinGecko(keyword: string): Promise<SearchHit[]> {
  const url = new URL(COINGECKO_SEARCH);
  url.searchParams.set("query", keyword);
  const response = await fetch(url, {
    headers: { "User-Agent": "InvestmentLedger/1.0" },
    signal: AbortSignal.timeout(SEARCH_TIMEOUT_MS)
  });
  if (!response.ok) throw new Error(`CoinGecko 搜索返回 ${response.status}`);
  const payload = (await response.json()) as {
    coins?: Array<{
      id?: string;
      name?: string;
      symbol?: string;
      market_cap_rank?: number | null;
    }>;
  };
  const coins = [...(payload.coins ?? [])]
    .sort((a, b) => (a.market_cap_rank || 99999) - (b.market_cap_rank || 99999))
    .slice(0, 10);

  return coins
    .filter((coin) => coin.id && coin.symbol && coin.name)
    .map((coin) => {
      const ref: InstrumentRef = {
        assetType: "crypto",
        symbol: String(coin.symbol).toUpperCase(),
        secid: String(coin.id)
      };
      return {
        ...ref,
        instrumentId: instrumentIdOf(ref),
        name: String(coin.name),
        market: "Crypto",
        currency: "USD" as const
      };
    });
}

async function searchOkx(keyword: string): Promise<SearchHit[]> {
  const response = await fetch(`${OKX_INSTRUMENTS}?instType=SPOT`, {
    headers: { "User-Agent": "InvestmentLedger/1.0" },
    signal: AbortSignal.timeout(SEARCH_TIMEOUT_MS)
  });
  if (!response.ok) throw new Error(`OKX 搜索返回 ${response.status}`);
  const payload = (await response.json()) as {
    code?: string;
    data?: Array<{ instId?: string; baseCcy?: string; quoteCcy?: string }>;
  };
  if (payload.code !== "0") throw new Error("OKX 搜索失败");
  const needle = keyword.trim().toUpperCase();
  return (payload.data ?? [])
    .filter(
      (row) =>
        row.quoteCcy === "USDT" &&
        row.baseCcy &&
        (row.baseCcy === needle ||
          row.instId?.toUpperCase().includes(needle) ||
          row.baseCcy.includes(needle))
    )
    .slice(0, 10)
    .map((row) => {
      const symbol = String(row.baseCcy).toUpperCase();
      const ref: InstrumentRef = {
        assetType: "crypto",
        symbol,
        secid: symbol.toLowerCase()
      };
      return {
        ...ref,
        instrumentId: instrumentIdOf(ref),
        name: symbol,
        market: "OKX",
        currency: "USD" as const
      };
    });
}

async function fetchCnQuote(ref: InstrumentRef): Promise<Quote> {
  const normalized = ref.secid
    ? {
        symbol: ref.symbol.replace(/^(sh|sz|bj)/i, ""),
        secid: ref.secid,
        market: ref.secid.startsWith("1.")
          ? ("sh" as const)
          : /^(4|8|92)/.test(ref.symbol)
            ? ("bj" as const)
            : ("sz" as const)
      }
    : normalizeCnSymbol(ref.symbol);
  const errors: string[] = [];

  try {
    return await fetchEastMoneyQuote({
      assetType: "cn",
      symbol: normalized.symbol,
      secid: normalized.secid,
      currency: "CNY",
      market: normalized.market === "sh" ? "沪市" : normalized.market === "sz" ? "深市" : "北交所"
    });
  } catch (error) {
    errors.push(errorMessage(error));
  }

  try {
    return await fetchTencentQuote({
      assetType: "cn",
      symbol: normalized.symbol,
      secid: normalized.secid,
      query: `${normalized.market}${normalized.symbol}`,
      currency: "CNY",
      market: normalized.market.toUpperCase()
    });
  } catch (error) {
    errors.push(errorMessage(error));
  }

  throw new Error(`所有行情服务均不可用：${errors.join("；")}`);
}

async function fetchUsQuote(ref: InstrumentRef): Promise<Quote> {
  const symbol = ref.symbol.trim().toUpperCase();
  const secids = unique([
    ref.secid,
    `105.${symbol}`,
    `106.${symbol}`,
    `107.${symbol}`
  ].filter(Boolean));
  const errors: string[] = [];

  for (const secid of secids) {
    try {
      return await fetchEastMoneyQuote({
        assetType: "us",
        symbol,
        secid,
        currency: "USD",
        market: US_MARKET_LABEL[secid.split(".")[0] || ""] || "美股"
      });
    } catch (error) {
      errors.push(errorMessage(error));
    }
  }

  try {
    return await fetchTencentQuote({
      assetType: "us",
      symbol,
      secid: ref.secid || `105.${symbol}`,
      query: `us${symbol}`,
      currency: "USD",
      market: "US"
    });
  } catch (error) {
    errors.push(errorMessage(error));
  }

  throw new Error(`所有行情服务均不可用：${errors.join("；")}`);
}

async function fetchCryptoQuote(ref: InstrumentRef): Promise<Quote> {
  const errors: string[] = [];
  try {
    return await fetchCoinGeckoQuote(ref);
  } catch (error) {
    errors.push(errorMessage(error));
  }
  try {
    return await fetchOkxQuote(ref);
  } catch (error) {
    errors.push(errorMessage(error));
  }
  throw new Error(`所有行情服务均不可用：${errors.join("；")}`);
}

async function fetchEastMoneyQuote(input: {
  assetType: "cn" | "us";
  symbol: string;
  secid: string;
  currency: Currency;
  market: string;
}): Promise<Quote> {
  const payload = await requestEastMoney(input.secid);
  const data = payload.data;
  if (!data || payload.rc !== 0) throw new Error("东方财富未找到该标的行情");

  const price = finiteNumber(data.f43);
  const previousClose = finiteNumber(data.f60);
  const name = typeof data.f58 === "string" ? data.f58 : "";
  const code = typeof data.f57 === "string" && data.f57 ? data.f57 : input.symbol;
  if (!name || price <= 0) throw new Error("东方财富返回的行情无效");

  const ref: InstrumentRef = {
    assetType: input.assetType,
    symbol: input.assetType === "us" ? code.toUpperCase() : code,
    secid: input.secid
  };
  return {
    ...ref,
    instrumentId: instrumentIdOf(ref),
    name,
    market: input.market,
    currency: input.currency,
    price,
    previousClose,
    open: finiteNumber(data.f46),
    high: finiteNumber(data.f44),
    low: finiteNumber(data.f45),
    change: finiteNumber(data.f169) || price - previousClose,
    changePercent:
      finiteNumber(data.f170) ||
      (previousClose ? ((price - previousClose) / previousClose) * 100 : 0),
    quoteTime: quoteTime(data.f86)
  };
}

async function fetchTencentQuote(input: {
  assetType: "cn" | "us";
  symbol: string;
  secid: string;
  query: string;
  currency: Currency;
  market: string;
}): Promise<Quote> {
  const response = await fetch(`${TENCENT_ENDPOINT}${input.query}`, {
    headers: headers.tencent,
    signal: AbortSignal.timeout(PROVIDER_TIMEOUT_MS)
  });
  if (!response.ok) throw new Error(`腾讯行情服务返回 ${response.status}`);

  const body = new TextDecoder("gbk").decode(await response.arrayBuffer());
  const match = body.match(/="([^"]*)"/);
  if (!match) throw new Error("腾讯行情返回格式异常");
  const fields = match[1]!.split("~");
  const name = fields[1] || "";
  const price = finiteNumber(fields[3]);
  const previousClose = finiteNumber(fields[4]);
  if (!name || price <= 0) throw new Error("腾讯行情返回的行情无效");

  const ref: InstrumentRef = {
    assetType: input.assetType,
    symbol: input.symbol,
    secid: input.secid
  };
  return {
    ...ref,
    instrumentId: instrumentIdOf(ref),
    name,
    market: input.market,
    currency: input.currency,
    price,
    previousClose,
    open: finiteNumber(fields[5]),
    high: finiteNumber(fields[33]),
    low: finiteNumber(fields[34]),
    change: finiteNumber(fields[31]) || price - previousClose,
    changePercent:
      finiteNumber(fields[32]) ||
      (previousClose ? ((price - previousClose) / previousClose) * 100 : 0),
    quoteTime: tencentQuoteTime(fields[30])
  };
}

async function fetchCoinGeckoQuote(ref: InstrumentRef): Promise<Quote> {
  const id = (ref.secid || ref.symbol).trim().toLowerCase();
  const url = new URL(COINGECKO_PRICE);
  url.searchParams.set("ids", id);
  url.searchParams.set("vs_currencies", "usd");
  url.searchParams.set("include_24hr_change", "true");
  const response = await fetch(url, {
    headers: { "User-Agent": "InvestmentLedger/1.0" },
    signal: AbortSignal.timeout(PROVIDER_TIMEOUT_MS)
  });
  if (!response.ok) throw new Error(`CoinGecko 行情返回 ${response.status}`);
  const payload = (await response.json()) as Record<
    string,
    { usd?: number; usd_24h_change?: number }
  >;
  const row = payload[id];
  const price = finiteNumber(row?.usd);
  if (!row || price <= 0) throw new Error("CoinGecko 未找到该代币行情");
  const changePercent = finiteNumber(row.usd_24h_change);
  const previousClose =
    changePercent !== 0 ? price / (1 + changePercent / 100) : price;
  const instrument: InstrumentRef = {
    assetType: "crypto",
    symbol: ref.symbol.toUpperCase(),
    secid: id
  };
  return {
    ...instrument,
    instrumentId: instrumentIdOf(instrument),
    name: ref.symbol.toUpperCase(),
    market: "Crypto",
    currency: "USD",
    price,
    previousClose,
    open: previousClose,
    high: Math.max(price, previousClose),
    low: Math.min(price, previousClose),
    change: price - previousClose,
    changePercent,
    quoteTime: new Date().toISOString()
  };
}

async function fetchOkxQuote(ref: InstrumentRef): Promise<Quote> {
  const instId = `${ref.symbol.trim().toUpperCase()}-USDT`;
  const url = new URL(OKX_TICKER);
  url.searchParams.set("instId", instId);
  const response = await fetch(url, {
    headers: { "User-Agent": "InvestmentLedger/1.0" },
    signal: AbortSignal.timeout(PROVIDER_TIMEOUT_MS)
  });
  if (!response.ok) throw new Error(`OKX 行情返回 ${response.status}`);
  const payload = (await response.json()) as {
    code?: string;
    data?: Array<{
      last?: string;
      open24h?: string;
      high24h?: string;
      low24h?: string;
      sodUtc8?: string;
      ts?: string;
    }>;
  };
  const row = payload.data?.[0];
  const price = finiteNumber(row?.last);
  if (payload.code !== "0" || !row || price <= 0) {
    throw new Error("OKX 未找到该代币行情");
  }
  const previousClose = finiteNumber(row.sodUtc8) || finiteNumber(row.open24h) || price;
  const instrument: InstrumentRef = {
    assetType: "crypto",
    symbol: ref.symbol.toUpperCase(),
    secid: ref.secid || ref.symbol.toLowerCase()
  };
  return {
    ...instrument,
    instrumentId: instrumentIdOf(instrument),
    name: ref.symbol.toUpperCase(),
    market: "OKX",
    currency: "USD",
    price,
    previousClose,
    open: finiteNumber(row.open24h) || previousClose,
    high: finiteNumber(row.high24h),
    low: finiteNumber(row.low24h),
    change: price - previousClose,
    changePercent: previousClose
      ? ((price - previousClose) / previousClose) * 100
      : 0,
    quoteTime: quoteTime(Number(row.ts) / 1000)
  };
}

interface EastMoneyResponse {
  rc?: number;
  data?: Partial<Record<EastMoneyField, string | number | null>>;
}

async function requestEastMoney(secid: string): Promise<EastMoneyResponse> {
  const url = new URL(EAST_MONEY_ENDPOINT);
  url.searchParams.set("secid", secid);
  url.searchParams.set("fields", QUOTE_FIELDS);
  url.searchParams.set("invt", "2");
  url.searchParams.set("fltt", "2");
  url.searchParams.set("_", String(Date.now()));

  try {
    const response = await fetch(url, {
      headers: headers.eastmoney,
      signal: AbortSignal.timeout(PROVIDER_TIMEOUT_MS)
    });
    if (!response.ok) throw new Error(`行情服务返回 ${response.status}`);
    return (await response.json()) as EastMoneyResponse;
  } catch (error) {
    const detail = error instanceof Error ? `：${error.message}` : "";
    throw new Error(`东方财富行情查询失败${detail}`);
  }
}

function isCnListedHit(
  symbol: string,
  secid: string,
  mktNum: string,
  marketName: string
): boolean {
  if (CN_MARKET_NAMES.has(marketName)) return true;
  // 沪深交易所场内 ETF / LOF。场外开放式基金是 MktNum 150，不纳入记账。
  return (
    marketName === "基金" &&
    (mktNum === "0" || mktNum === "1") &&
    /^\d{6}$/.test(symbol) &&
    /^(0|1)\./.test(secid)
  );
}

function cnMarketLabel(name: string, marketName: string): string {
  if (/ETF/i.test(name)) return "ETF";
  if (/LOF/i.test(name)) return "LOF";
  if (marketName === "基金") return "场内基金";
  return marketName;
}

function unique(values: string[]): string[] {
  return [...new Set(values)];
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : "未知行情错误";
}

type EastMoneyField =
  | "f43"
  | "f44"
  | "f45"
  | "f46"
  | "f57"
  | "f58"
  | "f60"
  | "f86"
  | "f169"
  | "f170";

function finiteNumber(value: string | number | null | undefined): number {
  const number = Number(value);
  return Number.isFinite(number) ? number : 0;
}

function quoteTime(value: string | number | null | undefined): string {
  const timestamp = Number(value);
  return Number.isFinite(timestamp) && timestamp > 0
    ? new Date(timestamp * 1000).toISOString()
    : new Date().toISOString();
}

function tencentQuoteTime(value: string | undefined): string {
  if (!value) return new Date().toISOString();
  const compact = value.match(/^(\d{4})-?(\d{2})-?(\d{2})[ T]?(\d{2}):?(\d{2}):?(\d{2})/);
  if (!compact) return new Date().toISOString();
  const year = Number(compact[1]);
  const month = Number(compact[2]);
  const day = Number(compact[3]);
  const hour = Number(compact[4]);
  const minute = Number(compact[5]);
  const second = Number(compact[6]);
  return new Date(
    Date.UTC(year, month - 1, day, hour - 8, minute, second)
  ).toISOString();
}
