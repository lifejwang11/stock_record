type AssetType = "cn" | "fund" | "us" | "crypto" | "gold";
type Currency = "CNY" | "USD";

interface CategorySummary {
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

interface Summary {
  totalPnl: number;
  dailyPnl: number;
  realizedPnl: number;
  holdingPnl: number;
  marketValue: number;
  usdCny: number | null;
  fxAvailable: boolean;
  breakdown: CategorySummary[];
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
  marketValueCny: number | null;
  holdingPnl: number;
  holdingPnlCny: number | null;
  holdingPnlPercent: number;
  changePercent: number;
  dailyMoveLive: boolean;
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
  breakdown: Array<{
    category: string;
    instrumentId: string;
    symbol: string;
    name: string;
    currency: Currency;
    dailyPnl: number;
    dailyPnlCny: number;
  }>;
}

interface Dashboard {
  summary: Summary;
  positions: Position[];
  daily: DailyPnl[];
  usedCachedQuotes: boolean;
  hasMissingQuotes: boolean;
  hasCrypto: boolean;
  hasGold: boolean;
  market: { cnOpen: boolean; cnSessionStarted: boolean; usOpen: boolean; goldOpen: boolean };
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
  cn: "名称或代码，例如 茅台、159530、016665",
  fund: "场外基金名称或代码，例如 016665",
  us: "名称或代码，例如 苹果、AAPL",
  crypto: "名称或代码，例如 Bitcoin、BTC",
  gold: "银行名称，例如 浙商、民生；留空列出全部"
};

const HINT: Record<AssetType, string> = {
  cn: "支持 A 股、场内 ETF/LOF 和全部场外基金",
  fund: "场外基金按最新单位净值和份额记账",
  us: "必须先搜索到美股，金额按美元计算，支持碎股",
  crypto: "必须先搜索到代币，金额按美元计算",
  gold: "选择银行积存金后按克记账，金额为人民币"
};

const AMOUNT_PLACEHOLDER: Record<AssetType, string> = {
  cn: "人民币金额，按整手计算股数",
  fund: "人民币金额，按净值计算份额",
  us: "美元金额，支持碎股",
  crypto: "美元金额，按代币数量计算",
  gold: "人民币金额，按克计算，最少 0.01 克"
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

function priceText(value: number, currency: Currency = "CNY"): string {
  return `${currencySymbol(currency)} ${formatPrice(value)}`;
}

function pnlMoney(value: number, currency: Currency = "CNY"): string {
  return `${currencySymbol(currency)} ${pnl(value)}`;
}

function withCnyEquiv(
  native: string,
  cny: number | null,
  isPnl: boolean
): string {
  if (cny == null) return native;
  const converted = isPnl ? `¥ ${pnl(cny)}` : `¥ ${money.format(cny)}`;
  return `${native}<span class="cny-equiv">（${converted}）</span>`;
}

function holdingPnlText(item: Position): string {
  return withCnyEquiv(
    pnlMoney(item.holdingPnl, item.currency),
    item.holdingPnlCny,
    true
  );
}

function marketValueText(item: Position): string {
  return withCnyEquiv(
    moneyText(item.marketValue, item.currency),
    item.marketValueCny,
    false
  );
}

function formatQty(value: number): string {
  return String(Number(value.toPrecision(12)));
}

function formatPrice(value: number): string {
  const abs = Math.abs(value);
  let digits = 2;
  if (abs > 0 && abs < 1) {
    const leadingZeros = Math.max(0, Math.floor(-Math.log10(abs)));
    digits = Math.min(12, Math.max(8, leadingZeros + 4));
  } else if (abs < 100) {
    digits = 4;
  }
  return new Intl.NumberFormat("zh-CN", {
    minimumFractionDigits: 2,
    maximumFractionDigits: digits
  }).format(value);
}

function quantityUnit(assetType: AssetType): string {
  if (assetType === "fund") return "份";
  if (assetType === "crypto") return "枚";
  if (assetType === "gold") return "克";
  return "股";
}

function assetLabel(assetType: AssetType, name = ""): string {
  if (assetType === "fund") return "场外基金";
  if (assetType === "us") return "美股";
  if (assetType === "crypto") return "加密货币";
  if (assetType === "gold") return "积存金";
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

function isGoldTradingTime(date = new Date()): boolean {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: "Asia/Shanghai",
    weekday: "short",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false
  }).formatToParts(date);
  const part = (type: string) => parts.find((item) => item.type === type)?.value;
  const weekday = part("weekday");
  const seconds =
    Number(part("hour")) * 3600 +
    Number(part("minute")) * 60 +
    Number(part("second"));
  if (weekday === "Sun") return false;
  if (weekday === "Sat") return seconds < 4 * 3600;
  if (weekday === "Mon") return seconds >= 9 * 3600;
  return true;
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

type BreakdownKey = "totalPnl" | "dailyPnl" | "holdingPnl" | "realizedPnl" | "marketValue";

const BREAKDOWN_CNY: Record<BreakdownKey, keyof CategorySummary> = {
  totalPnl: "totalPnlCny",
  dailyPnl: "dailyPnlCny",
  holdingPnl: "holdingPnlCny",
  realizedPnl: "realizedPnlCny",
  marketValue: "marketValueCny"
};

const CN_DAILY_LABELS = new Set(["A股", "ETF", "LOF", "场外基金"]);
let cnSessionStarted = false;

function isCnDailyPending(item: CategorySummary, key: BreakdownKey): boolean {
  return (
    key === "dailyPnl" &&
    !cnSessionStarted &&
    CN_DAILY_LABELS.has(item.label) &&
    item.dailyPnl === 0
  );
}

function formatCategoryValue(
  item: CategorySummary,
  key: BreakdownKey,
  isPnl: boolean
): string {
  if (isCnDailyPending(item, key)) return "未开盘";
  const value = item[key];
  const native = isPnl
    ? pnlMoney(value, item.currency || "CNY")
    : moneyText(value, item.currency || "CNY");
  const cny = item[BREAKDOWN_CNY[key]];
  return withCnyEquiv(native, typeof cny === "number" ? cny : null, isPnl);
}

function renderBreakdown(
  selector: string,
  breakdown: CategorySummary[],
  key: BreakdownKey,
  isPnl: boolean
): void {
  const element = $(selector);
  element.innerHTML = breakdown
    .map((item) => {
      const value = item[key];
      const pending = isCnDailyPending(item, key);
      return `<div class="breakdown-row">
        <span>${escapeHtml(item.label)}</span>
        <strong class="${pending ? "pending" : isPnl ? pnlClass(value) : ""}">${formatCategoryValue(item, key, isPnl)}</strong>
      </div>`;
    })
    .join("");
}

function setSummary(summary: Summary): void {
  const cards: Array<[string, number, BreakdownKey, boolean]> = [
    ["total-pnl", summary.totalPnl, "totalPnl", true],
    ["daily-pnl", summary.dailyPnl, "dailyPnl", true],
    ["holding-pnl", summary.holdingPnl, "holdingPnl", true],
    ["realized-pnl", summary.realizedPnl, "realizedPnl", true],
    ["market-value", summary.marketValue, "marketValue", false]
  ];
  const breakdown = summary.breakdown ?? [];
  for (const [id, value, key, isPnl] of cards) {
    const element = $(`#${id}`);
    element.textContent = isPnl ? `¥ ${pnl(value)}` : `¥ ${money.format(value)}`;
    element.className = `metric-value ${isPnl ? pnlClass(value) : ""}`;
    renderBreakdown(`#${id}-breakdown`, breakdown, key, isPnl);
  }
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
        <td>${priceText(item.avgCost, item.currency)}</td>
        <td>${priceText(item.currentPrice, item.currency)}${item.quoteCached ? '<small class="warning">沿用上次行情</small>' : item.quoteAvailable ? "" : '<small class="warning">暂无可用行情</small>'}</td>
        <td class="${item.dailyMoveLive ? pnlClass(item.changePercent) : "pending"}">${
          item.dailyMoveLive ? `${pnl(item.changePercent)}%` : "—"
        }</td>
        <td>${marketValueText(item)}</td>
        <td class="${pnlClass(item.holdingPnl)}">${holdingPnlText(item)}</td>
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

let openDailyPnlCell: HTMLElement | null = null;
let openDailyTooltipDay: string | null = null;

function closeDailyTooltip(): void {
  openDailyPnlCell
    ?.querySelector<HTMLElement>(".daily-tooltip")
    ?.classList.remove("visible");
  openDailyPnlCell
    ?.querySelector<HTMLElement>(".daily-pnl-trigger")
    ?.setAttribute("aria-expanded", "false");
  openDailyPnlCell = null;
  openDailyTooltipDay = null;
}

function openDailyTooltip(cell: HTMLElement): void {
  const tooltip = cell.querySelector<HTMLElement>(".daily-tooltip");
  if (!tooltip) return;
  if (openDailyPnlCell === cell) return;
  closeDailyTooltip();

  openDailyPnlCell = cell;
  openDailyTooltipDay = cell.dataset.day ?? null;
  tooltip.classList.add("visible");
  cell
    .querySelector<HTMLElement>(".daily-pnl-trigger")
    ?.setAttribute("aria-expanded", "true");
  const anchor = cell.getBoundingClientRect();
  const box = tooltip.getBoundingClientRect();
  const margin = 12;
  const gap = 7;
  const left = Math.max(
    margin,
    Math.min(anchor.right - box.width, window.innerWidth - box.width - margin)
  );
  const below = anchor.bottom + gap;
  const top =
    below + box.height <= window.innerHeight - margin
      ? below
      : Math.max(margin, anchor.top - box.height - gap);
  tooltip.style.left = `${left}px`;
  tooltip.style.top = `${top}px`;
}

document.addEventListener("click", closeDailyTooltip);
document.addEventListener("keydown", (event) => {
  if (event.key === "Escape") closeDailyTooltip();
});

function renderDaily(items: DailyPnl[]): void {
  const body = $("#daily-body");
  const preservedOpenDay = openDailyTooltipDay;
  openDailyPnlCell = null;
  if (!items.length) {
    openDailyTooltipDay = null;
    body.innerHTML = '<tr><td colspan="5" class="empty">暂无每日收益记录</td></tr>';
    return;
  }
  body.innerHTML = items
    .slice(0, 30)
    .map((item) => {
      const categories = new Map<string, DailyPnl["breakdown"]>();
      for (const detail of item.breakdown ?? []) {
        const category = categories.get(detail.category) ?? [];
        category.push(detail);
        categories.set(detail.category, category);
      }
      const sortedCategories = [...categories.entries()].sort(
        ([, left], [, right]) =>
          right.reduce((sum, detail) => sum + detail.dailyPnlCny, 0) -
          left.reduce((sum, detail) => sum + detail.dailyPnlCny, 0)
      );
      const detailHtml = sortedCategories.length
        ? `<div class="daily-tooltip" role="tooltip">
            <div class="daily-tooltip-title">${item.day} 收益明细</div>
            ${sortedCategories
              .map(([category, details]) => {
                const sorted = [...details].sort(
                  (a, b) => b.dailyPnlCny - a.dailyPnlCny
                );
                const categoryPnl = sorted.reduce(
                  (sum, detail) => sum + detail.dailyPnlCny,
                  0
                );
                return `<div class="daily-category">
                  <div class="daily-category-row">
                    <strong>${escapeHtml(category)}</strong>
                    <strong class="${pnlClass(categoryPnl)}">¥ ${pnl(categoryPnl)}</strong>
                  </div>
                  ${sorted
                    .map(
                      (detail) => `<div class="daily-detail-row">
                        <span>${escapeHtml(detail.name)} <small>${escapeHtml(detail.symbol)}</small></span>
                        <strong class="${pnlClass(detail.dailyPnlCny)}">¥ ${pnl(detail.dailyPnlCny)}</strong>
                      </div>`
                    )
                    .join("")}
                </div>`;
              })
              .join("")}
          </div>`
        : `<div class="daily-tooltip daily-tooltip-empty" role="tooltip">该日期暂无分类明细（升级前记录）</div>`;
      return `
      <tr>
        <td>${item.day}</td>
        <td class="daily-pnl-cell ${pnlClass(item.dailyPnl)}" data-day="${item.day}">
          <span class="daily-pnl-trigger" role="button" tabindex="0" aria-expanded="false" aria-label="${item.day} 当日收益 ${pnl(item.dailyPnl)}，查看收益明细">${pnl(item.dailyPnl)}</span>
          ${detailHtml}
        </td>
        <td class="${pnlClass(item.totalPnl)}">${pnl(item.totalPnl)}</td>
        <td class="${pnlClass(item.realizedPnl)}">${pnl(item.realizedPnl)}</td>
        <td class="${pnlClass(item.holdingPnl)}">${pnl(item.holdingPnl)}</td>
      </tr>`;
    })
    .join("");

  body.querySelectorAll<HTMLElement>(".daily-pnl-cell").forEach((cell) => {
    cell.addEventListener("click", (event) => {
      event.stopPropagation();
      if ((event.target as HTMLElement).closest(".daily-tooltip")) return;
      openDailyTooltip(cell);
    });
    cell.querySelector<HTMLElement>(".daily-pnl-trigger")?.addEventListener(
      "keydown",
      (event) => {
        if (event.key !== "Enter" && event.key !== " ") return;
        event.preventDefault();
        event.stopPropagation();
        openDailyTooltip(cell);
      }
    );
  });
  if (preservedOpenDay) {
    const preservedCell = body.querySelector<HTMLElement>(
      `.daily-pnl-cell[data-day="${CSS.escape(preservedOpenDay)}"]`
    );
    if (preservedCell) openDailyTooltip(preservedCell);
    else openDailyTooltipDay = null;
  }
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
        <td>${priceText(item.price, item.currency)}</td>
        <td>${moneyText(item.amount, item.currency)}</td>
        <td class="${pnlClass(item.realized_pnl)}">${item.side === "SELL" ? pnl(item.realized_pnl) : "—"}</td>
      </tr>`
    )
    .join("");
}

let loading = false;
let usingCachedQuotes = false;
let hasCryptoPositions = false;
let hasGoldPositions = false;
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
    usingCachedQuotes = dashboard.usedCachedQuotes;
    hasCryptoPositions = dashboard.hasCrypto;
    hasGoldPositions = dashboard.hasGold;
    cnSessionStarted = dashboard.market.cnSessionStarted;
    fxWarning = dashboard.positions.some((item) => item.currency === "USD") &&
      !dashboard.summary.fxAvailable;
    setSummary(dashboard.summary);
    renderPositions(dashboard.positions);
    renderDaily(dashboard.daily);
    renderTrades(trades);
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
  return (
    hasCryptoPositions ||
    isCnTradingTime() ||
    isUsTradingTime() ||
    (hasGoldPositions && isGoldTradingTime())
  );
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
  if (hasGoldPositions && isGoldTradingTime()) parts.push("积存金交易中");
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

let activeSearchAssetType: AssetType = "cn";

function currentAssetType(): AssetType {
  return activeSearchAssetType;
}

function clearSelectedInstrument(): void {
  ($("#buy-asset-type") as HTMLInputElement).value = activeSearchAssetType;
  ($("#buy-amount") as HTMLInputElement).placeholder =
    AMOUNT_PLACEHOLDER[activeSearchAssetType];
  $("#buy-hint").textContent = HINT[activeSearchAssetType];
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
  activeSearchAssetType = assetType;
  ($("#buy-asset-type") as HTMLInputElement).value = assetType;
  ($("#buy-query") as HTMLInputElement).placeholder = PLACEHOLDER[assetType];
  ($("#buy-amount") as HTMLInputElement).placeholder = AMOUNT_PLACEHOLDER[assetType];
  $("#buy-hint").textContent = HINT[assetType];
  document.querySelectorAll<HTMLButtonElement>("#buy-asset-tabs .tab").forEach((tab) => {
    tab.classList.toggle("active", tab.dataset.type === assetType);
  });
  $("#buy-search-results").hidden = true;
  $("#buy-search-results").innerHTML = "";
  ($("#buy-query") as HTMLInputElement).value = "";
  clearSelectedInstrument();
  if (assetType === "gold") void runSearch(true);
}

async function runSearch(allowEmpty = false): Promise<void> {
  const query = ($("#buy-query") as HTMLInputElement).value.trim();
  const match = ($("#buy-search-mode") as HTMLSelectElement).value;
  const results = $("#buy-search-results");
  if (!query && !allowEmpty && currentAssetType() !== "gold") {
    showMessage("请输入要搜索的名称或代码", true);
    return;
  }
  results.hidden = false;
  results.innerHTML = '<div class="search-loading">正在搜索…</div>';
  clearSelectedInstrument();
  try {
    const hits = await request<SearchHit[]>(
      `/api/search?type=${currentAssetType()}&match=${encodeURIComponent(match)}&q=${encodeURIComponent(query)}`
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
          data-asset-type="${hit.assetType}"
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
    assetType: (button.dataset.assetType || currentAssetType()) as AssetType,
    symbol: button.dataset.symbol || "",
    secid: button.dataset.secid || "",
    name: button.dataset.name || "",
    market: button.dataset.market || "",
    currency: (button.dataset.currency || "CNY") as Currency
  };
  ($("#buy-asset-type") as HTMLInputElement).value = hit.assetType;
  ($("#buy-amount") as HTMLInputElement).placeholder =
    AMOUNT_PLACEHOLDER[hit.assetType];
  $("#buy-hint").textContent = HINT[hit.assetType];
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
        <small>${escapeHtml(hit.symbol)} · ${escapeHtml(hit.market)} · 现价 ${priceText(quote.price, quote.currency)}</small>
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
    const keptType = activeSearchAssetType;
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
