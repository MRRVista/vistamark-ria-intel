/**
 * Curated universe of U.S.-listed Business Development Companies (BDCs).
 *
 * Seeded from the constituents of the VanEck BDC Income ETF (BIZD) / the
 * MVIS US Business Development Companies Index -- i.e. the large- and mid-cap
 * publicly traded BDCs that dominate the listed-BDC market.
 *
 * IMPORTANT -- this is a CURATED, POINT-IN-TIME SNAPSHOT compiled from prior
 * knowledge, NOT a live pull of the BIZD holdings file. Tickers can change
 * (mergers, rebrands) and the index reconstitutes periodically. CIKs are
 * deliberately NOT stored here: they resolve at query time against the live
 * SEC ticker->CIK map (edgar/client companyTickers), so a stale or changed
 * ticker fails *visibly* (it simply won't resolve) rather than silently
 * mapping to the wrong company. Reconcile this list against the live BIZD
 * holdings file when web access is available.
 */
export interface BdcEntry {
  ticker: string;
  name: string;
}

export const BDC_UNIVERSE_SOURCE =
  "Curated snapshot of the U.S.-listed BDC universe (VanEck BIZD / MVIS US BDC Index style). Not a live holdings pull; reconcile against the live BIZD file when possible.";

export const BDC_UNIVERSE: BdcEntry[] = [
  { ticker: "ARCC", name: "Ares Capital Corporation" },
  { ticker: "OBDC", name: "Blue Owl Capital Corporation" },
  { ticker: "FSK", name: "FS KKR Capital Corp." },
  { ticker: "BXSL", name: "Blackstone Secured Lending Fund" },
  { ticker: "HTGC", name: "Hercules Capital, Inc." },
  { ticker: "MAIN", name: "Main Street Capital Corporation" },
  { ticker: "PSEC", name: "Prospect Capital Corporation" },
  { ticker: "GBDC", name: "Golub Capital BDC, Inc." },
  { ticker: "TSLX", name: "Sixth Street Specialty Lending, Inc." },
  { ticker: "BBDC", name: "Barings BDC, Inc." },
  { ticker: "TCPC", name: "BlackRock TCP Capital Corp." },
  { ticker: "NMFC", name: "New Mountain Finance Corporation" },
  { ticker: "CSWC", name: "Capital Southwest Corporation" },
  { ticker: "CGBD", name: "Carlyle Secured Lending, Inc." },
  { ticker: "BCSF", name: "Bain Capital Specialty Finance, Inc." },
  { ticker: "PFLT", name: "PennantPark Floating Rate Capital Ltd." },
  { ticker: "PNNT", name: "PennantPark Investment Corporation" },
  { ticker: "TRIN", name: "Trinity Capital Inc." },
  { ticker: "GSBD", name: "Goldman Sachs BDC, Inc." },
  { ticker: "FDUS", name: "Fidus Investment Corporation" },
  { ticker: "WHF", name: "WhiteHorse Finance, Inc." },
  { ticker: "CCAP", name: "Crescent Capital BDC, Inc." },
  { ticker: "OCSL", name: "Oaktree Specialty Lending Corporation" },
  { ticker: "MFIC", name: "MidCap Financial Investment Corporation" },
  { ticker: "KBDC", name: "Kayne Anderson BDC, Inc." },
  { ticker: "SCM", name: "Stellus Capital Investment Corporation" },
  { ticker: "RWAY", name: "Runway Growth Finance Corp." },
  { ticker: "HRZN", name: "Horizon Technology Finance Corporation" },
  { ticker: "GAIN", name: "Gladstone Investment Corporation" },
  { ticker: "GLAD", name: "Gladstone Capital Corporation" },
  { ticker: "PTMN", name: "Portman Ridge Finance Corporation" },
  { ticker: "SAR", name: "Saratoga Investment Corp." },
  { ticker: "OBDE", name: "Blue Owl Capital Corporation III" },
  { ticker: "SLRC", name: "SLR Investment Corp." },
  { ticker: "PSBD", name: "Palmer Square Capital BDC Inc." },
];
