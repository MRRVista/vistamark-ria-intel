/**
 * Hardcoded NACUBO benchmark seed data extracted from publicly released
 * NACUBO-Commonfund Study of Endowments (NCSE) and predecessor press releases.
 *
 * This is the FREE public aggregate data — institution-specific data costs $500/yr
 * and is paywalled. Updated annually each February when NACUBO publishes new results.
 *
 * Sources cited:
 *   FY25: https://www.nacubo.org/Press-Releases/2026/US-Higher-Education-Endowments-Report-Stable-Returns-Increase-Spending-to-33-4-Billion-in-FY25
 *   FY24: https://www.nacubo.org/Press-Releases/2025/US-Higher-Education-Endowments-Report-10-Year-Average-Annual-Return
 *   FY23: NACUBO public NCSE 2023 tables
 */

import type { NacuboBenchmarkInsert } from "../db/schema";

export const NACUBO_SEED: NacuboBenchmarkInsert[] = [
  // FY2025 (released February 2026) — NCSE 2025
  {
    fyear: 2025,
    cohort: "all",
    cohortCount: 657,
    totalAssets: 944_300_000_000,
    medianValue: 253_600_000,
    return1y: "10.900",
    return10y: "7.700",
    spendingAmount: 33_400_000_000,
    spendingRate: "4.800",
    source: "NCSE",
    assetAllocJson: null,
  },
  // FY2024 — NCSE 2024
  {
    fyear: 2024,
    cohort: "all",
    cohortCount: 658,
    totalAssets: 873_700_000_000,
    medianValue: 243_000_000,
    return1y: "11.200",
    return10y: "6.800",
    spendingAmount: 30_000_000_000,
    spendingRate: "4.800",
    source: "NCSE",
    assetAllocJson: null,
  },
  // FY2023 — NCSE 2023 (699 institutions per NC State summary)
  {
    fyear: 2023,
    cohort: "all",
    cohortCount: 688,
    totalAssets: 839_100_000_000,
    medianValue: 209_100_000,
    return1y: "7.700",
    return10y: "7.200",
    spendingAmount: 28_400_000_000,
    spendingRate: "4.700",
    source: "NCSE",
    assetAllocJson: null,
  },
  // FY2022 — NTSE 2022 (last NACUBO-TIAA year)
  {
    fyear: 2022,
    cohort: "all",
    cohortCount: 678,
    totalAssets: 807_100_000_000,
    medianValue: 200_900_000,
    return1y: "-8.000",
    return10y: "7.800",
    spendingAmount: 25_900_000_000,
    spendingRate: "4.200",
    source: "NTSE",
    assetAllocJson: null,
  },
  // FY2021 — NTSE 2021
  {
    fyear: 2021,
    cohort: "all",
    cohortCount: 720,
    totalAssets: 821_000_000_000,
    medianValue: 200_400_000,
    return1y: "30.600",
    return10y: "8.500",
    spendingAmount: 23_900_000_000,
    spendingRate: "4.500",
    source: "NTSE",
    assetAllocJson: null,
  },
  // FY2020 — NTSE 2020
  {
    fyear: 2020,
    cohort: "all",
    cohortCount: 705,
    totalAssets: 637_700_000_000,
    medianValue: 159_100_000,
    return1y: "1.800",
    return10y: "7.500",
    spendingAmount: 23_300_000_000,
    spendingRate: "4.590",
    source: "NTSE",
    assetAllocJson: null,
  },
];

export const NACUBO_COHORT_LABELS: Record<string, string> = {
  all: "All study participants (aggregate)",
  over_5b: "Endowments over $5 billion",
  "1b_5b": "Endowments $1 billion to $5 billion",
  "500m_1b": "Endowments $500 million to $1 billion",
  "250m_500m": "Endowments $250 million to $500 million",
  "100m_250m": "Endowments $100 million to $250 million",
  "50m_100m": "Endowments $50 million to $100 million",
  under_50m: "Endowments under $50 million",
  public: "Public institutions / state systems",
  private_indep: "Private independent institutions",
};
