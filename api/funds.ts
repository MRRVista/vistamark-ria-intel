/**
 * GET /api/funds — fund and ETF lookup: search, then profile with the
 * diligence fields (expense ratio, category, AUM, yield, allocation).
 *
 *   ?q=dividend growth[&type=etf|fund|stock][&limit=25]   -> search
 *   ?symbol=SCHD                                          -> full profile
 *
 * DEFENSIVE FIELD READS, DELIBERATELY. EODHD's fundamentals payload differs
 * by instrument type (ETF_Data vs MutualFund_Data) and individual fields are
 * missing, null, "NA" or string-typed depending on the fund. Every read goes
 * through pick()/num() rather than a direct path, because a thrown TypeError
 * on one absent field would take out the whole profile.
 *
 * An expense ratio is the one number here that is always worth showing and
 * never worth guessing: if it is absent upstream it stays null and renders
 * as an em dash, never as 0.00%.
 */
import type { VercelRequest, VercelResponse } from "@vercel/node";
import { requireAccessOrSession } from "../lib/auth";
import { eodhdFetch, eodhdNum, normalizeSymbol, type EodhdSearchHit } from "../lib/eodhd/client";

const SYMBOL_OK = /^[A-Za-z0-9.\-^]{1,20}$/;

function one(v: string | string[] | undefined): string {
  return (Array.isArray(v) ? v[0] : v) ?? "";
}

type Any = Record<string, unknown>;
const obj = (v: unknown): Any => (v && typeof v === "object" ? (v as Any) : {});

/** First non-empty value across candidate paths, e.g. "ETF_Data.Yield". */
function pick(root: Any, paths: string[]): unknown {
  for (const path of paths) {
    let cur: unknown = root;
    for (const seg of path.split(".")) {
      if (!cur || typeof cur !== "object") { cur = undefined; break; }
      cur = (cur as Any)[seg];
    }
    if (cur !== undefined && cur !== null && cur !== "" && cur !== "NA") return cur;
  }
  return null;
}
const str = (v: unknown): string | null => (typeof v === "string" && v.trim() ? v.trim() : null);

/** Percent fields arrive as either 0.0006 or "0.06" depending on the fund. */
function pct(v: unknown): number | null {
  const n = eodhdNum(v);
  if (n === null) return null;
  return n > 1 ? n / 100 : n;
}

function weightsFrom(v: unknown): Array<{ name: string; weight: number }> {
  const src = obj(v);
  const out: Array<{ name: string; weight: number }> = [];
  for (const [name, val] of Object.entries(src)) {
    const w = pct(obj(val)["Equity_%"] ?? obj(val)["Relative_to_Category"] ?? val);
    if (w !== null && w > 0) out.push({ name, weight: w });
  }
  return out.sort((a, b) => b.weight - a.weight).slice(0, 12);
}

export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (req.method !== "GET") { res.status(405).json({ error: "GET only" }); return; }

  const auth = await requireAccessOrSession(req);
  if (!auth.ok) { res.status(401).json({ error: auth.reason }); return; }

  const symbol = one(req.query.symbol).trim();
  const q = one(req.query.q).trim();

  try {
    if (symbol) {
      if (!SYMBOL_OK.test(symbol)) throw new Error(`"${symbol}" is not a valid symbol.`);
      const f = obj(await eodhdFetch<Any>(`fundamentals/${encodeURIComponent(normalizeSymbol(symbol))}`));
      const general = obj(f.General);
      const etf = obj(f.ETF_Data);
      const mf = obj(f.MutualFund_Data);
      const tech = obj(f.Technicals);
      const kind = str(general.Type) ?? "Unknown";

      res.setHeader("Cache-Control", "private, max-age=3600");
      res.status(200).json({
        symbol: normalizeSymbol(symbol),
        name: str(general.Name),
        type: kind,
        exchange: str(general.Exchange),
        currency: str(general.CurrencyCode),
        country: str(general.CountryName),
        isin: str(general.ISIN),
        description: str(general.Description),
        // Category: ETFs carry a Morningstar-style category, funds their own.
        category: str(pick(f, [
          "ETF_Data.MorningStar.Category_Benchmark", "MutualFund_Data.Category",
          "ETF_Data.Index_Name", "General.Category",
        ])),
        fundFamily: str(pick(f, ["MutualFund_Data.Fund_Family", "ETF_Data.Company_Name"])),
        inception: str(pick(f, ["ETF_Data.Inception_Date", "MutualFund_Data.Inception_Date"])),
        expenseRatio: pct(pick(f, [
          "ETF_Data.NetExpenseRatio", "ETF_Data.Ongoing_Charge",
          "ETF_Data.Max_Annual_Mgmt_Charge", "MutualFund_Data.Expense_Ratio_Net",
          "MutualFund_Data.Expense_Ratio_Gross",
        ])),
        yield: pct(pick(f, ["ETF_Data.Yield", "MutualFund_Data.Yield"])),
        totalAssets: eodhdNum(pick(f, ["ETF_Data.TotalAssets", "MutualFund_Data.Total_Assets"])),
        turnover: pct(pick(f, [
          "ETF_Data.AnnualHoldingsTurnover", "MutualFund_Data.Annual_Holdings_Turnover",
        ])),
        holdingsCount: eodhdNum(pick(f, ["ETF_Data.Holdings_Count"])),
        beta: eodhdNum(pick(f, ["Technicals.Beta"])),
        fiftyTwoWeekHigh: eodhdNum(tech["52WeekHigh"]),
        fiftyTwoWeekLow: eodhdNum(tech["52WeekLow"]),
        assetAllocation: weightsFrom(etf.Asset_Allocation ?? mf.Asset_Allocation),
        sectorWeights: weightsFrom(etf.Sector_Weights ?? mf.Sector_Weights),
        regions: weightsFrom(etf.World_Regions ?? mf.World_Regions),
        topHoldings: Object.entries(obj(etf.Top_10_Holdings ?? mf.Top_Holdings))
          .map(([code, v]) => ({
            code,
            name: str(obj(v).Name),
            weight: pct(obj(v)["Assets_%"]),
          }))
          .filter((h) => h.weight !== null)
          .sort((a, b) => (b.weight ?? 0) - (a.weight ?? 0))
          .slice(0, 10),
        dataSource: "EODHD fundamentals",
      });
      return;
    }

    if (!q) {
      res.status(400).json({ error: "Pass q= to search, or symbol= for a profile." });
      return;
    }
    const limitRaw = Number(one(req.query.limit));
    const limit = Number.isFinite(limitRaw) ? Math.min(50, Math.max(1, limitRaw)) : 25;
    const wantType = one(req.query.type).trim().toLowerCase();

    const hits = await eodhdFetch<EodhdSearchHit[]>(
      `search/${encodeURIComponent(q)}`, { limit: 50 }
    );
    const rows = (Array.isArray(hits) ? hits : [])
      .filter((h) => {
        if (!wantType) return true;
        const t = (h.Type ?? "").toLowerCase();
        if (wantType === "etf") return t.includes("etf");
        if (wantType === "fund") return t.includes("fund");
        if (wantType === "stock") return t.includes("common stock");
        return true;
      })
      .slice(0, limit)
      .map((h) => ({
        symbol: h.Code && h.Exchange ? `${h.Code}.${h.Exchange}` : (h.Code ?? ""),
        code: h.Code ?? null,
        exchange: h.Exchange ?? null,
        name: h.Name ?? null,
        type: h.Type ?? null,
        country: h.Country ?? null,
        currency: h.Currency ?? null,
        isin: h.ISIN ?? null,
        previousClose: h.previousClose ?? null,
        previousCloseDate: h.previousCloseDate ?? null,
      }));

    res.setHeader("Cache-Control", "private, max-age=1800");
    res.status(200).json({
      query: q, type: wantType || "any", count: rows.length, results: rows,
      note: "Search returns identity only. Call ?symbol= for expense ratio, category and allocation.",
      dataSource: "EODHD search",
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    const isInput = /not a valid|Pass q=/.test(message);
    res.status(isInput ? 400 : 502).json({ error: message });
  }
}
