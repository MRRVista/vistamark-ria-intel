// Dev-only: validate the nonprofit-engine universe SQL against the live DB.
import { PROGRAMS } from "../lib/nonprofit/programs";
import { selectOrgs, has990Tables } from "../lib/nonprofit/engine";

async function main() {
  const has990 = await has990Tables();
  console.log("has990:", has990);
  for (const k of ["matt", "ryan"] as const) {
    const orgs = await selectOrgs(PROGRAMS[k], has990, 5);
    console.log(`\n== ${k} top 5 ==`);
    for (const o of orgs) console.log(`${o.geoScore} | ${o.name} | ${o.city}, ${o.state} ${o.zip} | pool $${Math.round(o.poolValue/1e6)}M (${o.poolSource}) | fees ${o.investMgmtFees ?? "-"}`);
  }
}
main().then(() => process.exit(0)).catch((e) => { console.error(e); process.exit(1); });
