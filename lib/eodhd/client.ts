/**
 * EODHD (EOD Historical Data) API client.
 *
 * Docs: https://eodhd.com/financial-apis/
 * Base: https://eodhd.com/api
 * Auth: api_token query param (paid key, set as EODHD_API_TOKEN).
 *
 * Endpoints used:
 *   /search/{query}                — ticker/entity search across exchanges
 *   /eod/{SYMBOL.EXCHANGE}        — historical OHLCV + adjusted close
 *   /real-time/{SYMBOL}           — live (delayed ~15m) quote, batchable via ?s=
 *   /div/{SYMBOL} /splits/{SYMBOL} — dividend + split histories
 *   /fundamentals/{SYMBOL}        — company/ETF/fund fundamentals (filterable)
 *   /news                          — financial news with sentiment scores
 *   /screener                      — cross-market stock screener
 *
 * SYMBOL FORMAT: EODHD requires TICKER.EXCHANGE (AAPL.US, VOD.LSE, SAP.XETRA).
 * normalizeSymbol() appends .US when no exchange suffix is given, so plain US
 * tickers Just Work while non-US symbols pass through untouched.
 *
 * CREDENTIAL SAFETY: api_token rides as a query param, so every error path
 * must flow through lib/data/http.ts (politeFetch/jsonFetch), whose
 * redactUrl() already scrubs `token=`-suffixed params — the same lesson as
 * the FRED key leak (2026-07-05). Do not fetch() EODHD directly.
 */

import { jsonFetch } from "../data/http";

const BASE = "https://eodhd.com/api";

export function eodhdToken(): string {
  const token = process.env.EODHD_API_TOKEN;
  if (!token) {
    throw new Error(
      "EODHD_API_TOKEN not configured. Set the EODHD API token as EODHD_API_TOKEN in Vercel environment variables (redeploy required)."
    );
  }
  return token;
}

/** AAPL -> AAPL.US; VOD.LSE stays VOD.LSE. Uppercased either way. */
export function normalizeSymbol(symbol: string): string {
  const s = symbol.trim().toUpperCase();
  return s.includes(".") ? s : `${s}.US`;
}

/**
 * Build an EODHD URL with auth + JSON format and fetch it.
 * `pathSegment` is appended raw (already-encoded callers beware) — symbols
 * and search queries are encodeURIComponent'ed here.
 */
export async function eodhdFetch<T = unknown>(
  path: string,
  params: Record<string, string | number | boolean | undefined> = {}
): Promise<T> {
  const url = new URL(`${BASE}/${path}`);
  for (const [k, v] of Object.entries(params)) {
    if (v !== undefined && v !== null && v !== "") url.searchParams.set(k, String(v));
  }
  url.searchParams.set("api_token", eodhdToken());
  url.searchParams.set("fmt", "json");
  return jsonFetch<T>(url.toString());
}

// ---------- response shapes (fields we actually surface) ----------

export interface EodhdSearchHit {
  Code?: string;
  Exchange?: string;
  Name?: string;
  Type?: string;
  Country?: string;
  Currency?: string;
  ISIN?: string | null;
  previousClose?: number;
  previousCloseDate?: string;
}

export interface EodhdBar {
  date?: string;
  open?: number;
  high?: number;
  low?: number;
  close?: number;
  adjusted_close?: number;
  volume?: number;
}

export interface EodhdQuote {
  code?: string;
  timestamp?: number;
  open?: number | string;
  high?: number | string;
  low?: number | string;
  close?: number | string;
  volume?: number | string;
  previousClose?: number | string;
  change?: number | string;
  change_p?: number | string;
}

export interface EodhdDividend {
  date?: string;
  declarationDate?: string | null;
  recordDate?: string | null;
  paymentDate?: string | null;
  period?: string | null;
  value?: number | string;
  unadjustedValue?: number | string;
  currency?: string;
}

export interface EodhdSplit {
  date?: string;
  split?: string; // e.g. "4.000000/1.000000"
}

export interface EodhdNewsItem {
  date?: string;
  title?: string;
  content?: string;
  link?: string;
  symbols?: string[];
  tags?: string[];
  sentiment?: { polarity?: number; neg?: number; neu?: number; pos?: number } | null;
}

export interface EodhdScreenerRow {
  code?: string;
  name?: string;
  exchange?: string;
  currency_symbol?: string;
  market_capitalization?: number;
  earnings_share?: number;
  dividend_yield?: number;
  sector?: string;
  industry?: string;
  refund_1d_p?: number;
  adjusted_close?: number;
}

export function eodhdNum(v: unknown): number | null {
  if (v == null || v === "" || v === "NA") return null;
  const n = typeof v === "number" ? v : Number(String(v).replace(/,/g, ""));
  return Number.isFinite(n) ? n : null;
}
