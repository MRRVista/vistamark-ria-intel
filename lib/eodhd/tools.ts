/**
 * MCP tool handlers for EODHD market data (eodhd.com).
 *
 * Tools:
 *   eodhd_search            — resolve a ticker/company to SYMBOL.EXCHANGE
 *   eodhd_eod_prices        — historical OHLCV + adjusted close (d/w/m)
 *   eodhd_quote             — delayed real-time quotes, up to 15 symbols
 *   eodhd_dividends_splits  — dividend + split histories for one symbol
 *   eodhd_fundamentals      — company/ETF/fund fundamentals (section filter)
 *   eodhd_news              — financial news with sentiment scores
 *   eodhd_screener          — cross-market screener (market cap, sector, yield)
 *
 * All tools require EODHD_API_TOKEN. Payload discipline: fundamentals default
 * to General,Highlights,Valuation and news content is trimmed — full EODHD
 * fundamentals run to hundreds of KB, which blows the /api/ask tool-result cap.
 */

import {
  eodhdFetch,
  eodhdNum,
  normalizeSymbol,
  type EodhdBar,
  type EodhdDividend,
  type EodhdNewsItem,
  type EodhdQuote,
  type EodhdScreenerRow,
  type EodhdSearchHit,
  type EodhdSplit,
} from "./client";

const DATA_SOURCE = "EODHD (eodhd.com)";

// ---------------------------------------------------------------- search

export interface EodhdSearchArgs {
  query: string;
  limit?: number;
}

export async function eodhdSearch(args: EodhdSearchArgs) {
  const limit = Math.min(args.limit ?? 10, 50);
  const hits = await eodhdFetch<EodhdSearchHit[]>(
    `search/${encodeURIComponent(args.query)}`,
    { limit }
  );
  return {
    dataSource: DATA_SOURCE,
    note: "Use `code` + '.' + `exchange` (e.g. AAPL.US) as the symbol for the other eodhd_* tools.",
    matches: (hits ?? []).map((h) => ({
      code: h.Code ?? null,
      exchange: h.Exchange ?? null,
      symbol: h.Code && h.Exchange ? `${h.Code}.${h.Exchange}` : null,
      name: h.Name ?? null,
      type: h.Type ?? null,
      country: h.Country ?? null,
      currency: h.Currency ?? null,
      isin: h.ISIN ?? null,
      previousClose: eodhdNum(h.previousClose),
      previousCloseDate: h.previousCloseDate ?? null,
    })),
  };
}

// ------------------------------------------------------------ eod prices

export interface EodhdEodPricesArgs {
  symbol: string;
  from?: string;
  to?: string;
  period?: "d" | "w" | "m";
  limit?: number;
}

export async function eodhdEodPrices(args: EodhdEodPricesArgs) {
  const symbol = normalizeSymbol(args.symbol);
  const limit = Math.min(args.limit ?? 60, 1000);
  const bars = await eodhdFetch<EodhdBar[]>(`eod/${encodeURIComponent(symbol)}`, {
    from: args.from,
    to: args.to,
    period: args.period ?? "d",
    order: "d", // newest first, so the limit keeps the recent end
  });
  const rows = (bars ?? []).slice(0, limit);
  return {
    dataSource: DATA_SOURCE,
    symbol,
    period: args.period ?? "d",
    totalReturned: rows.length,
    note: "Newest first. adjustedClose is split/dividend-adjusted; close is as-traded.",
    bars: rows.map((b) => ({
      date: b.date ?? null,
      open: eodhdNum(b.open),
      high: eodhdNum(b.high),
      low: eodhdNum(b.low),
      close: eodhdNum(b.close),
      adjustedClose: eodhdNum(b.adjusted_close),
      volume: eodhdNum(b.volume),
    })),
  };
}

// ----------------------------------------------------------------- quote

export interface EodhdQuoteArgs {
  symbols: string[];
}

export async function eodhdQuote(args: EodhdQuoteArgs) {
  const symbols = (args.symbols ?? []).map(normalizeSymbol).slice(0, 15);
  if (!symbols.length) {
    return { dataSource: DATA_SOURCE, error: "Provide at least one symbol.", quotes: [] };
  }
  const [first, ...rest] = symbols;
  const raw = await eodhdFetch<EodhdQuote | EodhdQuote[]>(
    `real-time/${encodeURIComponent(first!)}`,
    rest.length ? { s: rest.join(",") } : {}
  );
  const list = Array.isArray(raw) ? raw : [raw];
  return {
    dataSource: DATA_SOURCE,
    note: "Delayed real-time (typically ~15 min). timestamp is Unix UTC seconds; changePct is percent.",
    quotes: list.map((q) => ({
      symbol: q.code ?? null,
      timestamp: eodhdNum(q.timestamp),
      asOf: eodhdNum(q.timestamp) ? new Date((eodhdNum(q.timestamp) as number) * 1000).toISOString() : null,
      open: eodhdNum(q.open),
      high: eodhdNum(q.high),
      low: eodhdNum(q.low),
      last: eodhdNum(q.close),
      previousClose: eodhdNum(q.previousClose),
      change: eodhdNum(q.change),
      changePct: eodhdNum(q.change_p),
      volume: eodhdNum(q.volume),
    })),
  };
}

// ------------------------------------------------------ dividends/splits

export interface EodhdDividendsSplitsArgs {
  symbol: string;
  from?: string;
  to?: string;
  limit?: number;
}

export async function eodhdDividendsSplits(args: EodhdDividendsSplitsArgs) {
  const symbol = normalizeSymbol(args.symbol);
  const limit = Math.min(args.limit ?? 40, 200);
  const [divsRaw, splitsRaw] = await Promise.all([
    eodhdFetch<EodhdDividend[]>(`div/${encodeURIComponent(symbol)}`, {
      from: args.from,
      to: args.to,
    }).catch((e: unknown) => ({ error: e instanceof Error ? e.message : String(e) })),
    eodhdFetch<EodhdSplit[]>(`splits/${encodeURIComponent(symbol)}`, {
      from: args.from,
      to: args.to,
    }).catch((e: unknown) => ({ error: e instanceof Error ? e.message : String(e) })),
  ]);
  const divs = Array.isArray(divsRaw) ? divsRaw : [];
  const splits = Array.isArray(splitsRaw) ? splitsRaw : [];
  return {
    dataSource: DATA_SOURCE,
    symbol,
    note: "Dividend `value` is the adjusted per-share amount in the listing currency; ex-date is `date`. Newest first.",
    dividendsError: Array.isArray(divsRaw) ? undefined : divsRaw.error,
    splitsError: Array.isArray(splitsRaw) ? undefined : splitsRaw.error,
    dividends: divs
      .slice()
      .reverse()
      .slice(0, limit)
      .map((d) => ({
        exDate: d.date ?? null,
        declarationDate: d.declarationDate ?? null,
        recordDate: d.recordDate ?? null,
        paymentDate: d.paymentDate ?? null,
        period: d.period ?? null,
        value: eodhdNum(d.value),
        unadjustedValue: eodhdNum(d.unadjustedValue),
        currency: d.currency ?? null,
      })),
    splits: splits
      .slice()
      .reverse()
      .slice(0, limit)
      .map((s) => ({ date: s.date ?? null, split: s.split ?? null })),
  };
}

// ---------------------------------------------------------- fundamentals

/** Top-level fundamentals sections EODHD serves (equities; ETFs/funds get ETF_Data/MutualFund_Data). */
const FUNDAMENTALS_SECTIONS = new Set([
  "General",
  "Highlights",
  "Valuation",
  "SharesStats",
  "Technicals",
  "SplitsDividends",
  "AnalystRatings",
  "Holders",
  "InsiderTransactions",
  "ESGScores",
  "outstandingShares",
  "Earnings",
  "Financials",
  "ETF_Data",
  "MutualFund_Data",
]);

export interface EodhdFundamentalsArgs {
  symbol: string;
  sections?: string;
}

export async function eodhdFundamentals(args: EodhdFundamentalsArgs) {
  const symbol = normalizeSymbol(args.symbol);
  const requested = (args.sections ?? "General,Highlights,Valuation")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  // Allow sub-paths like Financials::Balance_Sheet::yearly — validate the root only.
  const invalid = requested.filter((s) => !FUNDAMENTALS_SECTIONS.has(s.split("::")[0]!));
  if (invalid.length) {
    return {
      dataSource: DATA_SOURCE,
      symbol,
      error: `Unknown section(s): ${invalid.join(", ")}. Valid roots: ${[...FUNDAMENTALS_SECTIONS].join(", ")}. Sub-paths use '::', e.g. Financials::Income_Statement::yearly.`,
    };
  }
  const data = await eodhdFetch<Record<string, unknown>>(
    `fundamentals/${encodeURIComponent(symbol)}`,
    { filter: requested.join(",") }
  );
  return {
    dataSource: DATA_SOURCE,
    symbol,
    sections: requested,
    note: "Filtered fundamentals as reported by EODHD. Full statements via sections like Financials::Balance_Sheet::yearly — request narrowly; full payloads are hundreds of KB. For ETFs/funds use ETF_Data / MutualFund_Data.",
    fundamentals: data ?? null,
  };
}

// ------------------------------------------------------------------ news

export interface EodhdNewsArgs {
  symbol?: string;
  topic?: string;
  from?: string;
  to?: string;
  limit?: number;
  offset?: number;
}

export async function eodhdNews(args: EodhdNewsArgs) {
  if (!args.symbol && !args.topic) {
    return { dataSource: DATA_SOURCE, error: "Provide symbol and/or topic (EODHD tag, e.g. 'mergers and acquisitions', 'dividend payments').", articles: [] };
  }
  const limit = Math.min(args.limit ?? 10, 50);
  const items = await eodhdFetch<EodhdNewsItem[]>("news", {
    s: args.symbol ? normalizeSymbol(args.symbol) : undefined,
    t: args.topic,
    from: args.from,
    to: args.to,
    limit,
    offset: args.offset ?? 0,
  });
  return {
    dataSource: DATA_SOURCE,
    note: "sentiment.polarity ranges -1 (negative) to +1 (positive). content is trimmed to ~400 chars — follow the link for the full article.",
    articles: (items ?? []).map((a) => ({
      date: a.date ?? null,
      title: a.title ?? null,
      snippet: a.content ? `${a.content.slice(0, 400)}${a.content.length > 400 ? "…" : ""}` : null,
      link: a.link ?? null,
      symbols: a.symbols ?? [],
      tags: a.tags ?? [],
      sentiment: a.sentiment
        ? {
            polarity: eodhdNum(a.sentiment.polarity),
            positive: eodhdNum(a.sentiment.pos),
            neutral: eodhdNum(a.sentiment.neu),
            negative: eodhdNum(a.sentiment.neg),
          }
        : null,
    })),
  };
}

// -------------------------------------------------------------- screener

export interface EodhdScreenerArgs {
  exchange?: string;
  sector?: string;
  industry?: string;
  minMarketCap?: number;
  maxMarketCap?: number;
  minDividendYield?: number;
  minEarningsShare?: number;
  signals?: string;
  sortBy?: "market_capitalization" | "dividend_yield" | "earnings_share" | "refund_1d_p";
  sortDir?: "asc" | "desc";
  limit?: number;
  offset?: number;
}

export async function eodhdScreener(args: EodhdScreenerArgs) {
  const filters: Array<[string, string, string | number]> = [];
  if (args.exchange) filters.push(["exchange", "=", args.exchange.toLowerCase()]);
  if (args.sector) filters.push(["sector", "=", args.sector]);
  if (args.industry) filters.push(["industry", "=", args.industry]);
  if (args.minMarketCap != null) filters.push(["market_capitalization", ">", args.minMarketCap]);
  if (args.maxMarketCap != null) filters.push(["market_capitalization", "<", args.maxMarketCap]);
  if (args.minDividendYield != null) filters.push(["dividend_yield", ">", args.minDividendYield]);
  if (args.minEarningsShare != null) filters.push(["earnings_share", ">", args.minEarningsShare]);
  const sort = `${args.sortBy ?? "market_capitalization"}.${(args.sortDir ?? "desc") === "asc" ? "asc" : "desc"}`;
  const raw = await eodhdFetch<{ data?: EodhdScreenerRow[] } | EodhdScreenerRow[]>("screener", {
    filters: filters.length ? JSON.stringify(filters) : undefined,
    signals: args.signals,
    sort,
    limit: Math.min(args.limit ?? 25, 100),
    offset: args.offset ?? 0,
  });
  const rows = Array.isArray(raw) ? raw : raw?.data ?? [];
  return {
    dataSource: DATA_SOURCE,
    sort,
    filtersApplied: filters,
    note: "market_capitalization in the listing currency; dividend_yield is a fraction (0.03 = 3%). exchange filter uses EODHD exchange codes (e.g. 'us', 'lse').",
    companies: rows.map((r) => ({
      symbol: r.code ?? null,
      name: r.name ?? null,
      exchange: r.exchange ?? null,
      sector: r.sector ?? null,
      industry: r.industry ?? null,
      marketCap: eodhdNum(r.market_capitalization),
      earningsPerShare: eodhdNum(r.earnings_share),
      dividendYield: eodhdNum(r.dividend_yield),
      lastClose: eodhdNum(r.adjusted_close),
      dayChangePct: eodhdNum(r.refund_1d_p),
    })),
  };
}
