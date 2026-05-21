import { parseAdvXml } from "../lib/adv/parser";

const sample = `<?xml version="1.0" encoding="UTF-8"?>
<IAPDFirmSECReport>
  <Firms>
    <Firm>
      <Info FirmCrdNb="999999" SECNb="801-99999" BusNm="Vistamark Investments LLC" LegalNm="Vistamark Investments LLC" />
      <MainAddr Strt1="333 Chestnut St, Suite 100" City="Hinsdale" State="IL" Cntry="USA" PostlCd="60521" Phone="630-555-0100" />
      <Rgstn FirmType="SEC" St="APPROVED" FirmDt="09/15/2025" />
      <FormInfo>
        <Part1A>
          <Item1 WebAddr="https://vistamarkllc.com" EmailAddr="info@vistamarkllc.com" />
          <Item5>
            <Item5A TotalEmp="4" />
            <Item5B Q5B1="3" />
            <Item5D Q5D1b="40" Q5D1d="30" Q5D1f="20" Q5D1k="10" />
            <Item5E Q5E1="Y" Q5E3="Y" Q5E5="N" />
            <Item5F Q5F2a="320000000" Q5F2b="0" Q5F2c="320000000" Q5F2d="120" Q5F2e="0" Q5F2f="120" />
            <Item5G Q5G2="Y" Q5G3="Y" Q5G6="Y" Q5G7="Y" />
          </Item5>
          <Item9 Q9A="N" />
          <Item11 Q11="N" />
        </Part1A>
      </FormInfo>
    </Firm>
    <Firm>
      <Info FirmCrdNb="111111" SECNb="801-11111" BusNm="Fiducient Advisors LLC" LegalNm="Fiducient Advisors LLC" />
      <MainAddr Strt1="500 W Madison" City="Chicago" State="IL" Cntry="USA" PostlCd="60661" />
      <Rgstn FirmType="SEC" St="APPROVED" />
      <FormInfo>
        <Part1A>
          <Item5>
            <Item5F Q5F2c="260000000000" Q5F2f="5000" />
          </Item5>
          <Item9 Q9A="N" />
          <Item11 Q11="N" />
        </Part1A>
      </FormInfo>
    </Firm>
  </Firms>
</IAPDFirmSECReport>`;

const result = parseAdvXml(sample);
console.log(`Parsed ${result.length} firms`);
for (const f of result) {
  console.log(`  CRD ${f.crdNumber}: ${f.legalName} — ${f.mainOfficeCity}, ${f.mainOfficeState} — AUM $${f.totalAum?.toLocaleString() ?? "n/a"} — ${f.totalAccounts ?? "?"} accts`);
}

// Validate the Vistamark record
const vm = result.find((r) => r.crdNumber === 999999);
if (!vm) throw new Error("Failed to parse Vistamark firm");
if (vm.totalAum !== 320_000_000) throw new Error(`Expected AUM 320M, got ${vm.totalAum}`);
if (vm.mainOfficeState !== "IL") throw new Error(`Expected IL, got ${vm.mainOfficeState}`);
if (!vm.svcPensionConsulting) throw new Error("Expected pension consulting to be true");
if (vm.isLargeAdviser !== true) throw new Error("Expected large adviser flag to be true");
console.log("\n✓ Parser smoke test passed");
