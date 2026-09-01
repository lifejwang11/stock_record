import { mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import type { AssetType, Currency, PositionRow, Quote, TradeRow } from "./types.js";

const dbPath = resolve(process.cwd(), process.env.DB_PATH || "data/stocks.db");
mkdirSync(dirname(dbPath), { recursive: true });

export const db = new DatabaseSync(dbPath);
db.exec("PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON;");
migrateSchema();

function tableColumns(table: string): string[] {
  return (
    db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>
  ).map((row) => row.name);
}

function migrateSchema(): void {
  const positionColumns = tableColumns("positions");
  if (positionColumns.length === 0) {
    createCurrentSchema();
    return;
  }

  if (!positionColumns.includes("instrument_id")) {
    db.exec("BEGIN IMMEDIATE");
    try {
      db.exec(`ALTER TABLE positions RENAME TO positions_legacy;`);
      db.exec(`ALTER TABLE trades RENAME TO trades_legacy;`);
      createPositionAndTradeTables();
      db.exec(`
        INSERT INTO positions(
          instrument_id, asset_type, symbol, secid, name, currency,
          shares, avg_cost, realized_pnl, updated_at
        )
        SELECT
          'cn:' || symbol, 'cn', symbol, '', name, 'CNY',
          shares, avg_cost, realized_pnl, updated_at
        FROM positions_legacy;

        INSERT INTO trades(
          instrument_id, asset_type, symbol, name, currency, side, shares,
          price, amount, cost_basis, realized_pnl, traded_at, created_at
        )
        SELECT
          'cn:' || symbol, 'cn', symbol, name, 'CNY', side, shares,
          price, amount, cost_basis, realized_pnl, traded_at, created_at
        FROM trades_legacy;

        DROP TABLE positions_legacy;
        DROP TABLE trades_legacy;
      `);
      db.exec("COMMIT");
    } catch (error) {
      db.exec("ROLLBACK");
      throw error;
    }
  }

  createSnapshotTable();
  recreateQuoteCacheIfNeeded();
}

function createCurrentSchema(): void {
  createPositionAndTradeTables();
  createSnapshotTable();
  createQuoteCacheTable();
}

function createPositionAndTradeTables(): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS positions (
      instrument_id TEXT PRIMARY KEY,
      asset_type TEXT NOT NULL CHECK (asset_type IN ('cn', 'us', 'crypto')),
      symbol TEXT NOT NULL,
      secid TEXT NOT NULL,
      name TEXT NOT NULL,
      currency TEXT NOT NULL CHECK (currency IN ('CNY', 'USD')),
      shares REAL NOT NULL CHECK (shares >= 0),
      avg_cost REAL NOT NULL CHECK (avg_cost >= 0),
      realized_pnl REAL NOT NULL DEFAULT 0,
      updated_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS trades (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      instrument_id TEXT NOT NULL,
      asset_type TEXT NOT NULL CHECK (asset_type IN ('cn', 'us', 'crypto')),
      symbol TEXT NOT NULL,
      name TEXT NOT NULL,
      currency TEXT NOT NULL CHECK (currency IN ('CNY', 'USD')),
      side TEXT NOT NULL CHECK (side IN ('BUY', 'SELL')),
      shares REAL NOT NULL CHECK (shares > 0),
      price REAL NOT NULL CHECK (price > 0),
      amount REAL NOT NULL,
      cost_basis REAL NOT NULL DEFAULT 0,
      realized_pnl REAL NOT NULL DEFAULT 0,
      traded_at TEXT NOT NULL,
      created_at TEXT NOT NULL
    );
  `);
}

function createSnapshotTable(): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS daily_snapshots (
      day TEXT PRIMARY KEY,
      total_pnl REAL NOT NULL,
      realized_pnl REAL NOT NULL,
      holding_pnl REAL NOT NULL,
      updated_at TEXT NOT NULL
    );
  `);
}

function createQuoteCacheTable(): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS quote_cache (
      instrument_id TEXT PRIMARY KEY,
      asset_type TEXT NOT NULL,
      symbol TEXT NOT NULL,
      secid TEXT NOT NULL,
      name TEXT NOT NULL,
      currency TEXT NOT NULL,
      market TEXT NOT NULL,
      price REAL NOT NULL,
      previous_close REAL NOT NULL,
      open REAL NOT NULL,
      high REAL NOT NULL,
      low REAL NOT NULL,
      change_amount REAL NOT NULL,
      change_percent REAL NOT NULL,
      quote_time TEXT NOT NULL,
      fetched_at TEXT NOT NULL
    );
  `);
}

function recreateQuoteCacheIfNeeded(): void {
  const columns = tableColumns("quote_cache");
  if (columns.length === 0 || !columns.includes("instrument_id")) {
    db.exec("DROP TABLE IF EXISTS quote_cache;");
    createQuoteCacheTable();
  }
}

const selectPosition = db.prepare(
  "SELECT * FROM positions WHERE instrument_id = ?"
);
const listPositionsStatement = db.prepare(
  "SELECT * FROM positions ORDER BY shares DESC, instrument_id"
);
const listTradesStatement = db.prepare(
  "SELECT * FROM trades ORDER BY traded_at DESC, id DESC LIMIT ?"
);

export function getPosition(instrumentId: string): PositionRow | undefined {
  return selectPosition.get(instrumentId) as unknown as PositionRow | undefined;
}

export function listPositions(): PositionRow[] {
  return listPositionsStatement.all() as unknown as PositionRow[];
}

export function listTrades(limit = 100): TradeRow[] {
  return listTradesStatement.all(limit) as unknown as TradeRow[];
}

export function saveQuoteCache(quote: Quote): void {
  db.prepare(`
    INSERT INTO quote_cache(
      instrument_id, asset_type, symbol, secid, name, currency, market,
      price, previous_close, open, high, low, change_amount, change_percent,
      quote_time, fetched_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(instrument_id) DO UPDATE SET
      asset_type = excluded.asset_type,
      symbol = excluded.symbol,
      secid = excluded.secid,
      name = excluded.name,
      currency = excluded.currency,
      market = excluded.market,
      price = excluded.price,
      previous_close = excluded.previous_close,
      open = excluded.open,
      high = excluded.high,
      low = excluded.low,
      change_amount = excluded.change_amount,
      change_percent = excluded.change_percent,
      quote_time = excluded.quote_time,
      fetched_at = excluded.fetched_at
  `).run(
    quote.instrumentId,
    quote.assetType,
    quote.symbol,
    quote.secid,
    quote.name,
    quote.currency,
    quote.market,
    quote.price,
    quote.previousClose,
    quote.open,
    quote.high,
    quote.low,
    quote.change,
    quote.changePercent,
    quote.quoteTime,
    new Date().toISOString()
  );
}

export function getQuoteCache(instrumentId: string): Quote | undefined {
  const row = db
    .prepare("SELECT * FROM quote_cache WHERE instrument_id = ?")
    .get(instrumentId) as Record<string, string | number> | undefined;
  if (!row) return undefined;
  return {
    instrumentId: String(row.instrument_id),
    assetType: String(row.asset_type) as AssetType,
    symbol: String(row.symbol),
    secid: String(row.secid),
    name: String(row.name),
    market: String(row.market),
    currency: String(row.currency) as Currency,
    price: Number(row.price),
    previousClose: Number(row.previous_close),
    open: Number(row.open),
    high: Number(row.high),
    low: Number(row.low),
    change: Number(row.change_amount),
    changePercent: Number(row.change_percent),
    quoteTime: String(row.quote_time)
  };
}

export function addBuy(input: {
  instrumentId: string;
  assetType: AssetType;
  symbol: string;
  secid: string;
  name: string;
  currency: Currency;
  shares: number;
  price: number;
  tradedAt: string;
}): void {
  const now = new Date().toISOString();
  db.exec("BEGIN IMMEDIATE");
  try {
    const current = getPosition(input.instrumentId);
    const oldShares = current?.shares ?? 0;
    const oldCost = current?.avg_cost ?? 0;
    const newShares = oldShares + input.shares;
    const avgCost =
      (oldShares * oldCost + input.shares * input.price) / newShares;

    db.prepare(`
      INSERT INTO positions(
        instrument_id, asset_type, symbol, secid, name, currency,
        shares, avg_cost, realized_pnl, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(instrument_id) DO UPDATE SET
        symbol = excluded.symbol,
        secid = excluded.secid,
        name = excluded.name,
        currency = excluded.currency,
        shares = excluded.shares,
        avg_cost = excluded.avg_cost,
        updated_at = excluded.updated_at
    `).run(
      input.instrumentId,
      input.assetType,
      input.symbol,
      input.secid,
      input.name,
      input.currency,
      newShares,
      avgCost,
      current?.realized_pnl ?? 0,
      now
    );

    db.prepare(`
      INSERT INTO trades(
        instrument_id, asset_type, symbol, name, currency, side, shares,
        price, amount, cost_basis, realized_pnl, traded_at, created_at
      ) VALUES (?, ?, ?, ?, ?, 'BUY', ?, ?, ?, ?, 0, ?, ?)
    `).run(
      input.instrumentId,
      input.assetType,
      input.symbol,
      input.name,
      input.currency,
      input.shares,
      input.price,
      input.shares * input.price,
      input.shares * input.price,
      input.tradedAt,
      now
    );
    db.exec("COMMIT");
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
}

export function addSell(input: {
  instrumentId: string;
  shares: number;
  price: number;
  tradedAt: string;
}): { realizedPnl: number; remainingShares: number } {
  const now = new Date().toISOString();
  db.exec("BEGIN IMMEDIATE");
  try {
    const current = getPosition(input.instrumentId);
    if (!current || current.shares <= 0) throw new Error("该标的当前没有持仓");
    if (input.shares > current.shares + 1e-12) {
      throw new Error(`卖出数量不能超过当前持仓 ${formatQty(current.shares)}`);
    }

    const realizedPnl = (input.price - current.avg_cost) * input.shares;
    const remainingShares =
      Math.abs(current.shares - input.shares) < 1e-12
        ? 0
        : current.shares - input.shares;
    db.prepare(`
      UPDATE positions
      SET shares = ?, avg_cost = ?, realized_pnl = ?, updated_at = ?
      WHERE instrument_id = ?
    `).run(
      remainingShares,
      remainingShares === 0 ? 0 : current.avg_cost,
      current.realized_pnl + realizedPnl,
      now,
      input.instrumentId
    );

    db.prepare(`
      INSERT INTO trades(
        instrument_id, asset_type, symbol, name, currency, side, shares,
        price, amount, cost_basis, realized_pnl, traded_at, created_at
      ) VALUES (?, ?, ?, ?, ?, 'SELL', ?, ?, ?, ?, ?, ?, ?)
    `).run(
      input.instrumentId,
      current.asset_type,
      current.symbol,
      current.name,
      current.currency,
      input.shares,
      input.price,
      input.shares * input.price,
      input.shares * current.avg_cost,
      realizedPnl,
      input.tradedAt,
      now
    );
    db.exec("COMMIT");
    return { realizedPnl, remainingShares };
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
}

export function saveDailySnapshot(input: {
  day: string;
  totalPnl: number;
  realizedPnl: number;
  holdingPnl: number;
}): void {
  db.prepare(`
    INSERT INTO daily_snapshots(
      day, total_pnl, realized_pnl, holding_pnl, updated_at
    ) VALUES (?, ?, ?, ?, ?)
    ON CONFLICT(day) DO UPDATE SET
      total_pnl = excluded.total_pnl,
      realized_pnl = excluded.realized_pnl,
      holding_pnl = excluded.holding_pnl,
      updated_at = excluded.updated_at
  `).run(
    input.day,
    input.totalPnl,
    input.realizedPnl,
    input.holdingPnl,
    new Date().toISOString()
  );
}

export function listDailySnapshots(): Array<{
  day: string;
  total_pnl: number;
  realized_pnl: number;
  holding_pnl: number;
  updated_at: string;
}> {
  return db
    .prepare("SELECT * FROM daily_snapshots ORDER BY day")
    .all() as unknown as ReturnType<typeof listDailySnapshots>;
}

function formatQty(value: number): string {
  return String(Number(value.toPrecision(12)));
}
