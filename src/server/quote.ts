import type {
  AssetType,
  Currency,
  InstrumentRef,
  Quote,
  SearchHit
} from "./types.js";

const EAST_MONEY_ENDPOINT = "https://push2.eastmoney.com/api/qt/stock/get";
const EAST_MONEY_SEARCH = "https://searchapi.eastmoney.com/api/suggest/get";
const EAST_MONEY_FUND_NAV = "https://api.fund.eastmoney.com/f10/lsjz";
const EAST_MONEY_SEARCH_TOKEN = "D43BF722C8E33BDC906FB84D85E326E8";
const TENCENT_ENDPOINT = "https://qt.gtimg.cn/q=";
const BINANCE_TICKER = "https://api.binance.com/api/v3/ticker/24hr";
const BINANCE_EXCHANGE_INFO = "https://api.binance.com/api/v3/exchangeInfo";
const OKX_TICKER = "https://www.okx.com/api/v5/market/ticker";
const OKX_INSTRUMENTS = "https://www.okx.com/api/v5/public/instruments";
const JD_GOLD_PRICE = "https://api.jdjygold.com/gw2/generic/produTools/h5/m/getGoldPrice";
const JD_GOLD_SKU_PRICE = "https://api.jdjygold.com/gw2/generic/jrm/h5/m/stdLatestPrice";
const JD_MINSHENG_PRICE = "https://api.jdjygold.com/gw/generic/hj/h5/m/latestPrice";
const USD_CNH_SECID = "133.USDCNH";

interface GoldProduct {
  symbol: string;
  sku: string;
  uniqueCode: string;
  name: string;
  bank: string;
  aliases: string[];
}

const GOLD_PRODUCTS: GoldProduct[] = [
  {
    symbol: "CZB",
    sku: "1961543816",
    uniqueCode: "CZB-JCJ",
    name: "浙商积存金",
    bank: "浙商银行",
    aliases: ["浙商", "czb", "zs"]
  },
  {
    symbol: "CMBC",
    sku: "21001001000001",
    uniqueCode: "CMBC-JCJ",
    name: "民生积存金",
    bank: "民生银行",
    aliases: ["民生", "cmbc", "ms"]
  },
  {
    symbol: "ICBC",
    sku: "2005453243",
    uniqueCode: "ICBC-JCJ",
    name: "工商积存金",
    bank: "工商银行",
    aliases: ["工商", "工行", "icbc"]
  },
  {
    symbol: "CGB",
    sku: "2024345112",
    uniqueCode: "CGB-JCJ0",
    name: "广发积存金",
    bank: "广发银行",
    aliases: ["广发", "cgb", "gf"]
  },
  {
    symbol: "CIB",
    sku: "2039007297",
    uniqueCode: "CIB-JCJ0",
    name: "兴业积存金",
    bank: "兴业银行",
    aliases: ["兴业", "cib"]
  },
  {
    symbol: "CNCB",
    sku: "2045976593",
    uniqueCode: "CNCB-JCJ",
    name: "中信积存金",
    bank: "中信银行",
    aliases: ["中信", "cncb", "citic"]
  }
];

const GOLD_CATALOG_KEYWORDS = new Set(["积存金", "黄金", "金", "gold", "jcj"]);

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
  },
  jdgold: {
    Referer: "https://m.jdjygold.com/",
    Origin: "https://m.jdjygold.com",
    Accept: "application/json",
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
  if (ref.assetType === "fund" || (ref.assetType === "cn" && ref.secid.startsWith("150."))) {
    return `fund:${ref.symbol.trim()}`;
  }
  return `${ref.assetType}:${ref.symbol.trim().toUpperCase()}`;
}

export function assetLabel(assetType: AssetType, name = ""): string {
  if (assetType === "fund") return "场外基金";
  if (assetType === "us") return "美股";
  if (assetType === "crypto") return "加密货币";
  if (assetType === "gold") return "积存金";
  if (/ETF/i.test(name)) return "ETF";
  if (/LOF/i.test(name)) return "LOF";
  return "A股";
}

export function quantityUnit(assetType: AssetType): string {
  if (assetType === "fund") return "份";
  if (assetType === "crypto") return "枚";
  if (assetType === "gold") return "克";
  return "股";
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
  if (assetType === "gold") return searchGold(keyword);
  if (!keyword) throw new Error("请输入要搜索的名称或代码");
  if (assetType === "crypto") return searchCrypto(keyword);
  if (assetType === "fund") {
    return (await searchEastMoney(keyword, "cn")).filter(
      (hit) => hit.assetType === "fund"
    );
  }
  return searchEastMoney(keyword, assetType);
}

export async function fetchQuote(ref: InstrumentRef): Promise<Quote> {
  if (ref.assetType === "fund" || (ref.assetType === "cn" && ref.secid.startsWith("150."))) {
    return fetchFundQuote({ ...ref, assetType: "fund" });
  }
  if (ref.assetType === "crypto") return fetchCryptoQuote(ref);
  if (ref.assetType === "gold") return fetchGoldQuote(ref);
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

  try {
    const rate = await fetchUsdCnyFallback();
    fxCache = { rate, at: Date.now() };
    return rate;
  } catch (error) {
    errors.push(errorMessage(error));
  }

  if (fxCache) return fxCache.rate;
  throw new Error(`美元汇率不可用：${errors.join("；")}`);
}

async function fetchUsdCnyFallback(): Promise<number> {
  const response = await fetch("https://open.er-api.com/v6/latest/USD", {
    signal: AbortSignal.timeout(PROVIDER_TIMEOUT_MS)
  });
  if (!response.ok) throw new Error(`备用汇率返回 ${response.status}`);
  const payload = (await response.json()) as {
    result?: string;
    rates?: { CNY?: number };
  };
  const rate = finiteNumber(payload.rates?.CNY);
  if (payload.result !== "success" || rate <= 0) {
    throw new Error("备用汇率无效");
  }
  return rate;
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

    let hitAssetType: AssetType = assetType;
    if (assetType === "cn") {
      if (isCnOtcFundHit(symbol, secid, mktNum, marketName)) {
        hitAssetType = "fund";
      } else if (!isCnListedHit(symbol, secid, mktNum, marketName)) {
        continue;
      }
    } else {
      if (marketName !== "美股" || !US_MARKET_IDS.has(mktNum)) continue;
      if (/notes|债券|债/i.test(name)) continue;
    }

    const ref: InstrumentRef = {
      assetType: hitAssetType,
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
          : hitAssetType === "fund"
            ? "场外基金"
            : cnMarketLabel(name, marketName),
      currency: assetType === "us" ? "USD" : "CNY"
    });
  }

  return hits;
}

async function fetchFundQuote(ref: InstrumentRef): Promise<Quote> {
  const symbol = ref.symbol.trim();
  if (!/^\d{6}$/.test(symbol)) {
    throw new Error("场外基金代码应为 6 位数字，例如 016665");
  }

  const url = new URL(EAST_MONEY_FUND_NAV);
  url.searchParams.set("fundCode", symbol);
  url.searchParams.set("pageIndex", "1");
  url.searchParams.set("pageSize", "2");
  const response = await fetch(url, {
    headers: {
      ...headers.eastmoney,
      Referer: `https://fund.eastmoney.com/${symbol}.html`
    },
    signal: AbortSignal.timeout(SEARCH_TIMEOUT_MS)
  });
  if (!response.ok) throw new Error(`基金净值服务返回 ${response.status}`);
  const payload = (await response.json()) as {
    ErrCode?: number;
    Data?: {
      LSJZList?: Array<{
        FSRQ?: string;
        DWJZ?: string;
        JZZZL?: string;
      }>;
    };
  };
  const rows = payload.Data?.LSJZList ?? [];
  const latest = rows[0];
  const price = finiteNumber(latest?.DWJZ);
  if (payload.ErrCode !== 0 || !latest?.FSRQ || price <= 0) {
    throw new Error("东方财富未找到该场外基金净值");
  }
  const previousClose = finiteNumber(rows[1]?.DWJZ) || price;
  const change = price - previousClose;
  const changePercent =
    finiteNumber(latest.JZZZL) ||
    (previousClose ? (change / previousClose) * 100 : 0);
  const normalizedRef: InstrumentRef = {
    assetType: "fund",
    symbol,
    secid: ref.secid || `150.${symbol}`
  };
  return {
    ...normalizedRef,
    instrumentId: instrumentIdOf(normalizedRef),
    name: `基金 ${symbol}`,
    market: "场外基金",
    currency: "CNY",
    price,
    previousClose,
    open: price,
    high: price,
    low: price,
    change,
    changePercent,
    quoteTime: `${latest.FSRQ}T15:00:00+08:00`
  };
}

async function searchCrypto(keyword: string): Promise<SearchHit[]> {
  const errors: string[] = [];
  try {
    const hits = await searchBinance(keyword);
    if (hits.length) return hits;
    errors.push("Binance 未找到匹配代币");
  } catch (error) {
    errors.push(errorMessage(error));
  }
  try {
    const hits = await searchOkx(keyword);
    if (hits.length) return hits;
    errors.push("OKX 未找到匹配代币");
  } catch (error) {
    errors.push(errorMessage(error));
  }
  throw new Error(`加密货币搜索失败：${errors.join("；")}`);
}

function searchGold(keyword: string): SearchHit[] {
  const needle = keyword.trim().toLowerCase();
  const products =
    !needle || GOLD_CATALOG_KEYWORDS.has(needle)
      ? GOLD_PRODUCTS
      : GOLD_PRODUCTS.filter((item) =>
          [item.symbol, item.name, item.bank, item.sku, ...item.aliases]
            .join(" ")
            .toLowerCase()
            .includes(needle)
        );
  return products.map(goldHit);
}

function goldHit(product: GoldProduct): SearchHit {
  const ref: InstrumentRef = {
    assetType: "gold",
    symbol: product.symbol,
    secid: product.sku
  };
  return {
    ...ref,
    instrumentId: instrumentIdOf(ref),
    name: product.name,
    market: product.bank,
    currency: "CNY"
  };
}

function resolveGoldProduct(ref: InstrumentRef): GoldProduct {
  const symbol = ref.symbol.trim().toUpperCase();
  const sku = ref.secid.trim();
  const found = GOLD_PRODUCTS.find(
    (item) => item.symbol === symbol || item.sku === sku
  );
  if (!found) throw new Error("未找到该积存金产品，请重新搜索");
  return found;
}

function goldQuote(
  product: GoldProduct,
  input: {
    price: number;
    previousClose: number;
    open?: number;
    high?: number;
    low?: number;
    change?: number;
    changePercent?: number;
    quoteTime?: string;
  }
): Quote {
  const hit = goldHit(product);
  const previousClose = input.previousClose || input.price;
  const price = input.price;
  return {
    ...hit,
    price,
    previousClose,
    open: input.open || previousClose,
    high: input.high || Math.max(price, previousClose),
    low: input.low || Math.min(price, previousClose),
    change: input.change || price - previousClose,
    changePercent:
      input.changePercent ||
      (previousClose ? ((price - previousClose) / previousClose) * 100 : 0),
    quoteTime: input.quoteTime || new Date().toISOString()
  };
}

async function searchBinance(keyword: string): Promise<SearchHit[]> {
  const needle = keyword.trim().toUpperCase();
  const exactSymbol = needle.endsWith("USDT") ? needle : `${needle}USDT`;
  try {
    const hit = await fetchBinanceTickerHit(exactSymbol);
    if (hit) return [hit];
  } catch (error) {
    if (!isBinanceUnknownSymbol(error)) throw error;
  }

  const response = await fetch(BINANCE_EXCHANGE_INFO, {
    headers: { "User-Agent": "InvestmentLedger/1.0" },
    signal: AbortSignal.timeout(SEARCH_TIMEOUT_MS)
  });
  if (!response.ok) throw new Error(`Binance 搜索返回 ${response.status}`);
  const payload = (await response.json()) as {
    symbols?: Array<{
      symbol?: string;
      status?: string;
      baseAsset?: string;
      quoteAsset?: string;
    }>;
  };
  return (payload.symbols ?? [])
    .filter(
      (row) =>
        row.status === "TRADING" &&
        row.quoteAsset === "USDT" &&
        row.baseAsset &&
        row.symbol &&
        (row.baseAsset === needle ||
          row.symbol === needle ||
          row.symbol === exactSymbol ||
          row.baseAsset.includes(needle) ||
          row.symbol.includes(needle))
    )
    .slice(0, 10)
    .map((row) => binanceHit(String(row.baseAsset)));
}

function binanceHit(baseAsset: string): SearchHit {
  const symbol = baseAsset.toUpperCase();
  const ref: InstrumentRef = {
    assetType: "crypto",
    symbol,
    secid: symbol.toLowerCase()
  };
  return {
    ...ref,
    instrumentId: instrumentIdOf(ref),
    name: symbol,
    market: "Binance",
    currency: "USD"
  };
}

async function fetchBinanceTickerHit(pairSymbol: string): Promise<SearchHit | null> {
  const row = await requestBinanceTicker(pairSymbol);
  const price = finiteNumber(row.lastPrice);
  if (price <= 0) return null;
  const baseAsset = pairSymbol.toUpperCase().replace(/USDT$/, "");
  return binanceHit(baseAsset);
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
    return await fetchBinanceQuote(ref);
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

async function fetchGoldQuote(ref: InstrumentRef): Promise<Quote> {
  const product = resolveGoldProduct(ref);
  const errors: string[] = [];
  try {
    return await fetchJdUniqueCodeQuote(product);
  } catch (error) {
    errors.push(errorMessage(error));
  }
  try {
    return await fetchJdSkuQuote(product);
  } catch (error) {
    errors.push(errorMessage(error));
  }
  if (product.symbol === "CMBC") {
    try {
      return await fetchMinShengQuote(product);
    } catch (error) {
      errors.push(errorMessage(error));
    }
  }
  throw new Error(`所有行情服务均不可用：${errors.join("；")}`);
}

async function fetchJdUniqueCodeQuote(product: GoldProduct): Promise<Quote> {
  const url = new URL(JD_GOLD_PRICE);
  url.searchParams.set("goldCode", product.uniqueCode);
  const response = await fetch(url, {
    headers: headers.jdgold,
    signal: AbortSignal.timeout(PROVIDER_TIMEOUT_MS)
  });
  if (!response.ok) throw new Error(`京东金价服务返回 ${response.status}`);
  const payload = (await response.json()) as {
    resultData?: {
      data?: {
        lastPrice?: number | string;
        preClose?: number | string;
        openPrice?: number | string;
        highPrice?: number | string;
        lowPrice?: number | string;
        raise?: number | string;
        raisePercent?: number | string;
        tradeDateTime?: JdTradeDateTime;
      };
    };
  };
  const data = payload.resultData?.data;
  const price = finiteNumber(data?.lastPrice);
  if (!data || price <= 0) throw new Error("京东金价未找到该积存金行情");
  return goldQuote(product, {
    price,
    previousClose: finiteNumber(data.preClose) || price,
    open: finiteNumber(data.openPrice),
    high: finiteNumber(data.highPrice),
    low: finiteNumber(data.lowPrice),
    change: finiteNumber(data.raise),
    changePercent: finiteNumber(data.raisePercent) * 100,
    quoteTime: jdTradeDateTime(data.tradeDateTime)
  });
}

async function fetchJdSkuQuote(product: GoldProduct): Promise<Quote> {
  const url = new URL(JD_GOLD_SKU_PRICE);
  url.searchParams.set("productSku", product.sku);
  const response = await fetch(url, {
    method: "POST",
    headers: {
      ...headers.jdgold,
      "Content-Type": "application/json"
    },
    body: JSON.stringify({ reqData: { productSku: product.sku } }),
    signal: AbortSignal.timeout(PROVIDER_TIMEOUT_MS)
  });
  if (!response.ok) throw new Error(`京东积存金行情返回 ${response.status}`);
  return parseJdSkuPayload(product, await response.json());
}

async function fetchMinShengQuote(product: GoldProduct): Promise<Quote> {
  const response = await fetch(JD_MINSHENG_PRICE, {
    method: "POST",
    headers: {
      ...headers.jdgold,
      "Content-Type": "application/json"
    },
    body: "{}",
    signal: AbortSignal.timeout(PROVIDER_TIMEOUT_MS)
  });
  if (!response.ok) throw new Error(`民生积存金行情返回 ${response.status}`);
  return parseJdSkuPayload(product, await response.json());
}

function parseJdSkuPayload(product: GoldProduct, payload: unknown): Quote {
  const body = payload as {
    success?: boolean;
    resultData?: {
      status?: string;
      datas?: {
        price?: string | number;
        yesterdayPrice?: string | number;
        upAndDownAmt?: string | number;
        upAndDownRate?: string;
        time?: string | number;
      };
    };
  };
  const data = body.resultData?.datas;
  const price = finiteNumber(data?.price);
  if (!data || body.resultData?.status === "FAIL" || price <= 0) {
    throw new Error("京东积存金未找到该产品行情");
  }
  const previousClose = finiteNumber(data.yesterdayPrice) || price;
  return goldQuote(product, {
    price,
    previousClose,
    change: finiteNumber(data.upAndDownAmt),
    changePercent: percentNumber(data.upAndDownRate),
    quoteTime: jdMillisTime(data.time)
  });
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

interface BinanceTicker {
  symbol?: string;
  lastPrice?: string;
  prevClosePrice?: string;
  openPrice?: string;
  highPrice?: string;
  lowPrice?: string;
  priceChange?: string;
  priceChangePercent?: string;
  closeTime?: number;
}

async function requestBinanceTicker(pairSymbol: string): Promise<BinanceTicker> {
  const url = new URL(BINANCE_TICKER);
  url.searchParams.set("symbol", pairSymbol);
  const response = await fetch(url, {
    headers: { "User-Agent": "InvestmentLedger/1.0" },
    signal: AbortSignal.timeout(PROVIDER_TIMEOUT_MS)
  });
  let payload: BinanceTicker & { code?: number; msg?: string };
  try {
    payload = (await response.json()) as BinanceTicker & {
      code?: number;
      msg?: string;
    };
  } catch {
    throw new Error(`Binance 行情返回 ${response.status}`);
  }
  if (!response.ok || payload.code) {
    throw new Error(
      payload.msg === "Invalid symbol."
        ? "Binance 未找到该交易对"
        : `Binance 行情返回 ${response.status}`
    );
  }
  return payload;
}

function isBinanceUnknownSymbol(error: unknown): boolean {
  return errorMessage(error).includes("未找到该交易对");
}

function binancePairSymbol(ref: InstrumentRef): string {
  const raw = ref.symbol.trim().toUpperCase().replace(/[-_/]/g, "");
  return raw.endsWith("USDT") ? raw : `${raw}USDT`;
}

async function fetchBinanceQuote(ref: InstrumentRef): Promise<Quote> {
  const pairSymbol = binancePairSymbol(ref);
  const row = await requestBinanceTicker(pairSymbol);
  const price = finiteNumber(row.lastPrice);
  if (price <= 0) throw new Error("Binance 未找到该代币行情");
  const previousClose =
    finiteNumber(row.prevClosePrice) || finiteNumber(row.openPrice) || price;
  const symbol = pairSymbol.replace(/USDT$/, "");
  const instrument: InstrumentRef = {
    assetType: "crypto",
    symbol,
    secid: ref.secid || symbol.toLowerCase()
  };
  return {
    ...instrument,
    instrumentId: instrumentIdOf(instrument),
    name: symbol,
    market: "Binance",
    currency: "USD",
    price,
    previousClose,
    open: finiteNumber(row.openPrice) || previousClose,
    high: finiteNumber(row.highPrice),
    low: finiteNumber(row.lowPrice),
    change: finiteNumber(row.priceChange) || price - previousClose,
    changePercent: finiteNumber(row.priceChangePercent),
    quoteTime: binanceQuoteTime(row.closeTime)
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
  // 沪深交易所场内 ETF / LOF。
  return (
    marketName === "基金" &&
    (mktNum === "0" || mktNum === "1") &&
    /^\d{6}$/.test(symbol) &&
    /^(0|1)\./.test(secid)
  );
}

function isCnOtcFundHit(
  symbol: string,
  secid: string,
  mktNum: string,
  marketName: string
): boolean {
  return (
    marketName === "基金" &&
    mktNum === "150" &&
    /^\d{6}$/.test(symbol) &&
    secid === `150.${symbol}`
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

function percentNumber(value: string | number | null | undefined): number {
  if (typeof value === "number") return Number.isFinite(value) ? value : 0;
  const number = Number(String(value ?? "").replace(/%/g, "").trim());
  return Number.isFinite(number) ? number : 0;
}

interface JdTradeDateTime {
  year?: number;
  monthValue?: number;
  dayOfMonth?: number;
  hour?: number;
  minute?: number;
  second?: number;
}

function jdTradeDateTime(value: JdTradeDateTime | null | undefined): string {
  if (!value?.year || !value.monthValue || !value.dayOfMonth) {
    return new Date().toISOString();
  }
  return new Date(
    Date.UTC(
      value.year,
      value.monthValue - 1,
      value.dayOfMonth,
      (value.hour ?? 0) - 8,
      value.minute ?? 0,
      value.second ?? 0
    )
  ).toISOString();
}

function jdMillisTime(value: string | number | null | undefined): string {
  const timestamp = Number(value);
  if (!Number.isFinite(timestamp) || timestamp <= 0) return new Date().toISOString();
  return new Date(timestamp > 1e12 ? timestamp : timestamp * 1000).toISOString();
}

function binanceQuoteTime(value: number | null | undefined): string {
  if (!Number.isFinite(value) || !value || value <= 0) return new Date().toISOString();
  return new Date(value).toISOString();
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
