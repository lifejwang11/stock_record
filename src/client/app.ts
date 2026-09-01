type AssetType = "cn" | "us" | "crypto";
type Currency = "CNY" | "USD";

interface Summary {
  totalPnl: number;
  dailyPnl: number;
  realizedPnl: number;
  holdingPnl: number;
  marketValue: number;
  usdCny: number | null;
  fxAvailable: boolean;
}

interface Position {
  instrumentId: string;
  assetType: AssetType;
  assetLabel: string;
  symbol: string;
  name: string;
  currency: Currency;
  shares: number;
  avgCost: number;
  currentPrice: number;
  marketValue: number;
  holdingPnl: number;
  holdingPnlPercent: number;
  changePercent: number;
  quoteTime: string | null;
  quoteAvailable: boolean;
  quoteCached: boolean;
}

interface DailyPnl {
  day: string;
  dailyPnl: number;
  totalPnl: number;
  realizedPnl: number;
  holdingPnl: number;
}

interface Dashboard {
  summary: Summary;
  positions: Position[];
  daily: DailyPnl[];
  usedCachedQuotes: boolean;
  hasMissingQuotes: boolean;
  hasCrypto: boolean;
  market: { cnOpen: boolean; usOpen: boolean };
  updatedAt: string;
}

interface Trade {
  id: number;
  instrument_id: string;
  asset_type: AssetType;
  symbol: string;
  name: string;
  currency: Currency;
  side: "BUY" | "SELL";
  shares: number;
  price: number;
  amount: number;
  realized_pnl: number;
  traded_at: string;
}

interface SearchHit {
  instrumentId: string;
  assetType: AssetType;
  symbol: string;
  secid: string;
  name: string;
  market: string;
  currency: Currency;
}

interface Quote extends SearchHit {
  price: number;
  changePercent: number;
}

const money = new Intl.NumberFormat("zh-CN", {
  minimumFractionDigits: 2,
  maximumFractionDigits: 2
});

const PLACEHOLDER: Record<AssetType, string> = {
  cn: "名称或代码，例如 茅台、159530",
  us: "名称或代码，例如 苹果、AAPL",
  crypto: "名称或代码，例如 Bitcoin、BTC"
};

const HINT: Record<AssetType, string> = {
  cn: "必须先搜索到股票或 ETF，再按 100 股一手计算买入",
  us: "必须先搜索到美股，金额按美元计算，支持碎股",
  crypto: "必须先搜索到代币，金额按美元计算"
};

const $ = <T extends HTMLElement>(selector: string): T => {
  const element = document.querySelector<T>(selector);
  if (!element) throw new Error(`找不到元素 ${selector}`);
  return element;
};

function pnlClass(value: number): string {
  if (value > 0) return "positive";
  if (value < 0) return "negative";
  return "";
}

function pnl(value: number): string {
  return `${value > 0 ? "+" : ""}${money.format(value)}`;
}

function escapeHtml(value: string): string {
  const div = document.createElement("div");
  div.textContent = value;
  return div.innerHTML;
}

function currencySymbol(currency: Currency): string {
  return currency === "USD" ? "$" : "¥";
}

function moneyText(value: number, currency: Currency = "CNY"): string {
  return `${currencySymbol(currency)} ${money.format(value)}`;
}

function formatQty(value: number): string {
  return String(Number(value.toPrecision(12)));
}

function formatPrice(value: number): string {
  const digits = value >= 100 ? 2 : value >= 1 ? 4 : 8;
  return new Intl.NumberFormat("zh-CN", {
    minimumFractionDigits: 2,
    maximumFractionDigits: digits
  }).format(value);
}

function quantityUnit(assetType: AssetType): string {
  return assetType === "crypto" ? "枚" : "股";
}

function assetLabel(assetType: AssetType, name = ""): string {
  if (assetType === "us") return "美股";
  if (assetType === "crypto") return "加密货币";
  if (/ETF/i.test(name)) return "ETF";
  if (/LOF/i.test(name)) return "LOF";
  return "A股";
}

function isCnTradingTime(date = new Date()): boolean {
  return isSession(date, "Asia/Shanghai", [
    [9.5 * 3600, 11.5 * 3600],
    [13 * 3600, 15 * 3600]
  ]);
}

function isUsTradingTime(date = new Date()): boolean {
  return isSession(date, "America/New_York", [[9.5 * 3600, 16 * 3600]]);
}

function isSession(
  date: Date,
  timeZone: string,
  windows: Array<[number, number]>
): boolean {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone,
    weekday: "short",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false
  }).formatToParts(date);
  const part = (type: string) => parts.find((item) => item.type === type)?.value;
  if (part("weekday") === "Sat" || part("weekday") === "Sun") return false;
  const seconds =
    Number(part("hour")) * 3600 +
    Number(part("minute")) * 60 +
    Number(part("second"));
  return windows.some(([start, end]) => seconds >= start && seconds <= end);
}

async function request<T>(url: string, options?: RequestInit): Promise<T> {
  const response = await fetch(url, {
    ...options,
    headers: {
      "Content-Type": "application/json",
      ...options?.headers
    }
  });
  const data = (await response.json()) as T & { error?: string };
  if (!response.ok) throw new Error(data.error || "请求失败");
  return data;
}

function setSummary(summary: Summary): void {
  const values: Array<[string, number]> = [
    ["#total-pnl", summary.totalPnl],
    ["#daily-pnl", summary.dailyPnl],
    ["#holding-pnl", summary.holdingPnl],
    ["#realized-pnl", summary.realizedPnl]
  ];
  for (const [selector, value] of values) {
    const element = $(selector);
    element.textContent = `¥ ${pnl(value)}`;
    element.className = `metric-value ${pnlClass(value)}`;
  }
  $("#market-value").textContent = `¥ ${money.format(summary.marketValue)}`;
}

function renderPositions(positions: Position[]): void {
  const body = $("#positions-body");
  const sellSelect = $("#sell-instrument") as HTMLSelectElement;
  const previous = sellSelect.value;
  sellSelect.innerHTML = '<option value="">请选择要卖出的持仓</option>';
  for (const item of positions) {
    const option = document.createElement("option");
    option.value = item.instrumentId;
    option.textContent = `${item.assetLabel} · ${item.name} ${item.symbol}（${formatQty(item.shares)}${quantityUnit(item.assetType)}）`;
    sellSelect.append(option);
  }
  if (positions.some((item) => item.instrumentId === previous)) {
    sellSelect.value = previous;
  }

  if (!positions.length) {
    body.innerHTML =
      '<tr><td colspan="9" class="empty">还没有持仓，请先搜索标的并记录买入</td></tr>';
    return;
  }
  body.innerHTML = positions
    .map(
      (item) => `
      <tr>
        <td>
          <span class="market-tag ${item.assetType}">${escapeHtml(item.assetLabel)}</span>
          <strong>${escapeHtml(item.name)}</strong>
          <small>${escapeHtml(item.symbol)}</small>
        </td>
        <td>${formatQty(item.shares)}</td>
        <td>${moneyText(item.avgCost, item.currency)}</td>
        <td>${moneyText(item.currentPrice, item.currency)}${item.quoteCached ? '<small class="warning">沿用上次行情</small>' : item.quoteAvailable ? "" : '<small class="warning">暂无可用行情</small>'}</td>
        <td class="${pnlClass(item.changePercent)}">${pnl(item.changePercent)}%</td>
        <td>${moneyText(item.marketValue, item.currency)}</td>
        <td class="${pnlClass(item.holdingPnl)}">${pnl(item.holdingPnl)}</td>
        <td class="${pnlClass(item.holdingPnlPercent)}">${pnl(item.holdingPnlPercent)}%</td>
        <td><button class="link-button sell-all" data-id="${escapeHtml(item.instrumentId)}">清仓</button></td>
      </tr>`
    )
    .join("");

  document.querySelectorAll<HTMLButtonElement>(".sell-all").forEach((button) => {
    button.addEventListener("click", () => {
      sellSelect.value = button.dataset.id || "";
      ($("#sell-shares") as HTMLInputElement).value = "";
      sellSelect.scrollIntoView({ behavior: "smooth", block: "center" });
    });
  });
}

function renderDaily(items: DailyPnl[]): void {
  const body = $("#daily-body");
  if (!items.length) {
    body.innerHTML = '<tr><td colspan="5" class="empty">暂无每日收益记录</td></tr>';
    return;
  }
  body.innerHTML = items
    .slice(0, 30)
    .map(
      (item) => `
      <tr>
        <td>${item.day}</td>
        <td class="${pnlClass(item.dailyPnl)}">${pnl(item.dailyPnl)}</td>
        <td class="${pnlClass(item.totalPnl)}">${pnl(item.totalPnl)}</td>
        <td class="${pnlClass(item.realizedPnl)}">${pnl(item.realizedPnl)}</td>
        <td class="${pnlClass(item.holdingPnl)}">${pnl(item.holdingPnl)}</td>
      </tr>`
    )
    .join("");
}

function renderTrades(items: Trade[]): void {
  const body = $("#trades-body");
  if (!items.length) {
    body.innerHTML = '<tr><td colspan="7" class="empty">暂无交易记录</td></tr>';
    return;
  }
  body.innerHTML = items
    .map(
      (item) => `
      <tr>
        <td>${new Date(item.traded_at).toLocaleString("zh-CN")}</td>
        <td>
          <span class="market-tag ${item.asset_type}">${assetLabel(item.asset_type, item.name)}</span>
          <strong>${escapeHtml(item.name)}</strong>
          <small>${escapeHtml(item.symbol)}</small>
        </td>
        <td><span class="tag ${item.side === "BUY" ? "buy" : "sell"}">${item.side === "BUY" ? "买入" : "卖出"}</span></td>
        <td>${formatQty(item.shares)}</td>
        <td>${moneyText(item.price, item.currency)}</td>
        <td>${moneyText(item.amount, item.currency)}</td>
        <td class="${pnlClass(item.realized_pnl)}">${item.side === "SELL" ? pnl(item.realized_pnl) : "—"}</td>
      </tr>`
    )
    .join("");
}

let loading = false;
let usingCachedQuotes = false;
let hasCryptoPositions = false;
let fxWarning = false;

async function refresh(): Promise<void> {
  if (loading) return;
  loading = true;
  $("#refresh-button").setAttribute("disabled", "true");
  try {
    const [dashboard, trades] = await Promise.all([
      request<Dashboard>("/api/dashboard"),
      request<Trade[]>("/api/trades")
    ]);
    setSummary(dashboard.summary);
    renderPositions(dashboard.positions);
    renderDaily(dashboard.daily);
    renderTrades(trades);
    usingCachedQuotes = dashboard.usedCachedQuotes;
    hasCryptoPositions = dashboard.hasCrypto;
    fxWarning = dashboard.positions.some((item) => item.currency === "USD") &&
      !dashboard.summary.fxAvailable;
    $("#updated-at").textContent = `最后更新 ${new Date(
      dashboard.updatedAt
    ).toLocaleTimeString("zh-CN")}${dashboard.usedCachedQuotes ? "（收益未重新计算）" : ""}${
      dashboard.summary.usdCny
        ? ` · USD/CNH ${dashboard.summary.usdCny.toFixed(4)}`
        : ""
    }`;
  } catch (error) {
    showMessage(error instanceof Error ? error.message : "刷新失败", true);
  } finally {
    loading = false;
    $("#refresh-button").removeAttribute("disabled");
    updateMarketStatus();
  }
}

function showMessage(message: string, isError = false): void {
  const element = $("#message");
  element.textContent = message;
  element.className = `toast show ${isError ? "error" : "success"}`;
  window.setTimeout(() => (element.className = "toast"), 3500);
}

function shouldAutoRefresh(): boolean {
  return hasCryptoPositions || isCnTradingTime() || isUsTradingTime();
}

function updateMarketStatus(): void {
  const element = $("#market-status");
  if (usingCachedQuotes) {
    element.textContent = "行情失败 · 沿用上次数据 · 下轮重试";
    element.className = "status warning-status";
    return;
  }
  if (fxWarning) {
    element.textContent = "美元汇率暂不可用 · 汇总未折算";
    element.className = "status warning-status";
    return;
  }
  const parts: string[] = [];
  if (isCnTradingTime()) parts.push("A股交易中");
  if (isUsTradingTime()) parts.push("美股交易中");
  if (hasCryptoPositions) parts.push("加密货币 24h");
  if (parts.length) {
    element.textContent = `${parts.join(" · ")} · 每 5 秒刷新`;
    element.className = "status open";
    return;
  }
  element.textContent = "非交易时段 · 自动刷新已暂停";
  element.className = "status";
}

function formData(form: HTMLFormElement): Record<string, string> {
  return Object.fromEntries(
    Array.from(new FormData(form).entries()).map(([key, value]) => [
      key,
      String(value).trim()
    ])
  );
}

function currentAssetType(): AssetType {
  return ($("#buy-asset-type") as HTMLInputElement).value as AssetType;
}

function clearSelectedInstrument(): void {
  ($("#buy-instrument-id") as HTMLInputElement).value = "";
  ($("#buy-symbol") as HTMLInputElement).value = "";
  ($("#buy-secid") as HTMLInputElement).value = "";
  ($("#buy-name") as HTMLInputElement).value = "";
  const selected = $("#buy-selected");
  selected.hidden = true;
  selected.innerHTML = "";
  $("#buy-submit").setAttribute("disabled", "true");
}

function setAssetType(assetType: AssetType): void {
  ($("#buy-asset-type") as HTMLInputElement).value = assetType;
  ($("#buy-query") as HTMLInputElement).placeholder = PLACEHOLDER[assetType];
  $("#buy-hint").textContent = HINT[assetType];
  document.querySelectorAll<HTMLButtonElement>("#buy-asset-tabs .tab").forEach((tab) => {
    tab.classList.toggle("active", tab.dataset.type === assetType);
  });
  $("#buy-search-results").hidden = true;
  $("#buy-search-results").innerHTML = "";
  ($("#buy-query") as HTMLInputElement).value = "";
  clearSelectedInstrument();
}

async function runSearch(): Promise<void> {
  const query = ($("#buy-query") as HTMLInputElement).value.trim();
  const results = $("#buy-search-results");
  if (!query) {
    showMessage("请输入要搜索的名称或代码", true);
    return;
  }
  results.hidden = false;
  results.innerHTML = '<div class="search-loading">正在搜索…</div>';
  clearSelectedInstrument();
  try {
    const hits = await request<SearchHit[]>(
      `/api/search?type=${currentAssetType()}&q=${encodeURIComponent(query)}`
    );
    if (!hits.length) {
      results.innerHTML =
        '<div class="search-empty">没有搜索到标的，请换个关键词后再记录买入</div>';
      return;
    }
    results.innerHTML = hits
      .map(
        (hit) => `
        <button type="button" class="search-hit"
          data-id="${escapeHtml(hit.instrumentId)}"
          data-symbol="${escapeHtml(hit.symbol)}"
          data-secid="${escapeHtml(hit.secid)}"
          data-name="${escapeHtml(hit.name)}"
          data-market="${escapeHtml(hit.market)}"
          data-currency="${hit.currency}">
          <span>
            ${escapeHtml(hit.name)}
            <small>${escapeHtml(hit.symbol)} · ${escapeHtml(hit.market)}</small>
          </span>
          <span>选择</span>
        </button>`
      )
      .join("");
    results.querySelectorAll<HTMLButtonElement>(".search-hit").forEach((button) => {
      button.addEventListener("click", () => void selectHit(button));
    });
  } catch (error) {
    results.innerHTML = `<div class="search-empty">${escapeHtml(
      error instanceof Error ? error.message : "搜索失败"
    )}</div>`;
  }
}

async function selectHit(button: HTMLButtonElement): Promise<void> {
  const hit: SearchHit = {
    instrumentId: button.dataset.id || "",
    assetType: currentAssetType(),
    symbol: button.dataset.symbol || "",
    secid: button.dataset.secid || "",
    name: button.dataset.name || "",
    market: button.dataset.market || "",
    currency: (button.dataset.currency || "CNY") as Currency
  };
  ($("#buy-instrument-id") as HTMLInputElement).value = hit.instrumentId;
  ($("#buy-symbol") as HTMLInputElement).value = hit.symbol;
  ($("#buy-secid") as HTMLInputElement).value = hit.secid;
  ($("#buy-name") as HTMLInputElement).value = hit.name;
  const results = $("#buy-search-results");
  results.hidden = true;
  results.innerHTML = "";
  const selected = $("#buy-selected");
  selected.hidden = false;
  selected.innerHTML = `
    <div>
      <strong>已选择 ${escapeHtml(hit.name)}</strong>
      <small>${escapeHtml(hit.symbol)} · ${escapeHtml(hit.market)} · 正在确认行情…</small>
    </div>
    <button type="button" class="clear-pick" id="clear-pick">重选</button>
  `;
  $("#clear-pick").addEventListener("click", () => {
    clearSelectedInstrument();
    ($("#buy-query") as HTMLInputElement).focus();
  });
  try {
    const quote = await request<Quote>(
      `/api/quote?type=${hit.assetType}&symbol=${encodeURIComponent(hit.symbol)}&secid=${encodeURIComponent(hit.secid)}`
    );
    selected.innerHTML = `
      <div>
        <strong>已选择 ${escapeHtml(hit.name)}</strong>
        <small>${escapeHtml(hit.symbol)} · ${escapeHtml(hit.market)} · 现价 ${moneyText(quote.price, quote.currency)}</small>
      </div>
      <button type="button" class="clear-pick" id="clear-pick">重选</button>
    `;
    $("#clear-pick").addEventListener("click", () => {
      clearSelectedInstrument();
      ($("#buy-query") as HTMLInputElement).focus();
    });
    $("#buy-submit").removeAttribute("disabled");
  } catch (error) {
    clearSelectedInstrument();
    showMessage(
      error instanceof Error
        ? `未确认到行情，不能记录买入：${error.message}`
        : "未确认到行情，不能记录买入",
      true
    );
  }
}

$("#buy-asset-tabs").addEventListener("click", (event) => {
  const button = (event.target as HTMLElement).closest<HTMLButtonElement>("button.tab");
  if (!button?.dataset.type) return;
  setAssetType(button.dataset.type as AssetType);
});

$("#buy-search-button").addEventListener("click", () => void runSearch());
$("#buy-query").addEventListener("keydown", (event) => {
  if (event.key === "Enter") {
    event.preventDefault();
    void runSearch();
  }
});

$("#buy-form").addEventListener("submit", async (event) => {
  event.preventDefault();
  const form = event.currentTarget as HTMLFormElement;
  const data = formData(form);
  if (!data.instrumentId || !data.symbol) {
    showMessage("请先搜索并选择标的，确认行情后再记录买入", true);
    return;
  }
  const button = form.querySelector<HTMLButtonElement>("button[type=submit]")!;
  button.disabled = true;
  try {
    const result = await request<{
      message: string;
      usedAmount: number;
      remainingAmount: number;
      currency: Currency;
    }>("/api/trades/buy", {
      method: "POST",
      body: JSON.stringify(data)
    });
    showMessage(
      `${result.message}，使用 ${moneyText(result.usedAmount, result.currency)}，剩余 ${moneyText(result.remainingAmount, result.currency)}`
    );
    const keptType = (data.assetType as AssetType) || "cn";
    form.reset();
    setAssetType(keptType);
    await refresh();
  } catch (error) {
    showMessage(error instanceof Error ? error.message : "买入记录失败", true);
  } finally {
    button.disabled = !($("#buy-instrument-id") as HTMLInputElement).value;
  }
});

$("#sell-form").addEventListener("submit", async (event) => {
  event.preventDefault();
  const form = event.currentTarget as HTMLFormElement;
  const data = formData(form);
  if (!data.instrumentId) {
    showMessage("请选择要卖出的持仓", true);
    return;
  }
  const action = data.shares ? `卖出 ${data.shares}` : "全部清仓";
  if (!window.confirm(`确认按表单价格${action}吗？价格留空时使用当前行情价。`)) return;
  const button = form.querySelector<HTMLButtonElement>("button[type=submit]")!;
  button.disabled = true;
  try {
    const result = await request<{
      message: string;
      realizedPnl: number;
      currency: Currency;
    }>("/api/trades/sell", {
      method: "POST",
      body: JSON.stringify(data)
    });
    showMessage(
      `${result.message}，实现收益 ${moneyText(result.realizedPnl, result.currency)}`
    );
    form.reset();
    await refresh();
  } catch (error) {
    showMessage(error instanceof Error ? error.message : "卖出记录失败", true);
  } finally {
    button.disabled = false;
  }
});

$("#refresh-button").addEventListener("click", () => void refresh());
window.setInterval(() => {
  updateMarketStatus();
  if (shouldAutoRefresh()) void refresh();
}, 5000);

setAssetType("cn");
updateMarketStatus();
void refresh();
