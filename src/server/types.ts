export type AssetType = "cn" | "us" | "crypto";
export type Currency = "CNY" | "USD";

export interface InstrumentRef {
  assetType: AssetType;
  symbol: string;
  secid: string;
}

export interface SearchHit extends InstrumentRef {
  instrumentId: string;
  name: string;
  market: string;
  currency: Currency;
}

export interface Quote extends SearchHit {
  price: number;
  previousClose: number;
  open: number;
  high: number;
  low: number;
  change: number;
  changePercent: number;
  quoteTime: string;
}

export interface PositionRow {
  instrument_id: string;
  asset_type: AssetType;
  symbol: string;
  secid: string;
  name: string;
  currency: Currency;
  shares: number;
  avg_cost: number;
  realized_pnl: number;
  updated_at: string;
}

export interface TradeRow {
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
  cost_basis: number;
  realized_pnl: number;
  traded_at: string;
  created_at: string;
}
