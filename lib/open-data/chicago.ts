/**
 * City of Chicago data portal (data.cityofchicago.org, Socrata, keyless; daily refresh).
 *
 *   r5kz-chrr  Business Licenses (2002–present, ~1.2M rows). license_status: AAI = issued,
 *              AAC = cancelled, REV = revoked, REA = revoked/appealed, INQ = inquiry.
 *   ezma-pppn  Business Owners (account_number → owner names/titles); joined for owner search.
 *   ydr8-5enu  Building Permits (2006–present, 122 columns; reported_cost, up to 15 contacts).
 *
 * All verified live 2026-10-22.
 */
import { sodaQuery, soqlStr, soqlLike, num, str, isoDay, dateArg, zipArg, clampLimit, strList } from "./common";

const CHI = "data.cityofchicago.org";
const LICENSES = "r5kz-chrr";
const OWNERS = "ezma-pppn";
const PERMITS = "ydr8-5enu";

const today = () => new Date().toISOString().slice(0, 10);

export async function chicagoBusinessLicenses(args: any) {
  const limit = clampLimit(args?.limit, 25, 100);
  const activeOnly = args?.activeOnly !== false;
  const where: string[] = [];

  if (args?.name) {
    const like = soqlLike(String(args.name));
    where.push(`(upper(legal_name) like ${like} OR upper(doing_business_as_name) like ${like})`);
  }
  if (args?.address) where.push(`upper(address) like ${soqlLike(String(args.address))}`);
  const zip = zipArg(args?.zip);
  if (zip) where.push(`zip_code=${soqlStr(zip)}`);
  if (args?.licenseType) where.push(`upper(license_description) like ${soqlLike(String(args.licenseType))}`);
  if (args?.neighborhood) where.push(`upper(community_area_name) like ${soqlLike(String(args.neighborhood))}`);
  if (args?.accountNumber) where.push(`account_number=${Number(args.accountNumber) || 0}`);
  const startedAfter = dateArg(args?.startedAfter, "startedAfter");
  if (startedAfter) where.push(`license_start_date >= '${startedAfter}'`);

  // Owner-name search goes through the Business Owners dataset first.
  let ownerAccounts: number[] | null = null;
  let ownerMatches: Array<Record<string, unknown>> = [];
  if (args?.owner) {
    const like = soqlLike(String(args.owner));
    const owners = await sodaQuery<any>(CHI, OWNERS, {
      select: "account_number,doing_business_as_name,owner_first_name,owner_last_name,owner_name,owner_title",
      where: `(upper(owner_last_name) like ${like} OR upper(owner_first_name) like ${like} OR upper(owner_name) like ${like})`,
      limit: 200,
    });
    ownerMatches = owners;
    ownerAccounts = Array.from(new Set(owners.map((o: any) => num(o.account_number)).filter((n): n is number => n != null))).slice(0, 100);
    if (!ownerAccounts.length) {
      return { source: `Chicago Business Licenses (${CHI} ${LICENSES} + owners ${OWNERS})`, fetchedAt: new Date().toISOString(), filters: args, returned: 0, licenses: [], note: "No business owner matched that name in ezma-pppn" };
    }
    where.push(`account_number in (${ownerAccounts.join(",")})`);
  }

  if (!where.length) throw new Error("Provide at least one filter: name, owner, address, zip, licenseType, neighborhood or accountNumber");
  if (activeOnly) where.push(`license_status='AAI'`, `expiration_date >= '${today()}'`);

  const rows = await sodaQuery<any>(CHI, LICENSES, {
    select: "license_number,account_number,site_number,legal_name,doing_business_as_name,address,city,state,zip_code,community_area_name,license_description,business_activity,application_type,license_start_date,expiration_date,date_issued,license_status,license_status_change_date,ward",
    where: where.join(" AND "),
    order: "license_start_date DESC",
    limit,
  });

  // Optionally enrich every returned license with its account's owners/officers (one extra query).
  if (args?.includeOwners === true && rows.length && !ownerMatches.length) {
    const accts = Array.from(new Set(rows.map((r: any) => num(r.account_number)).filter((n: number | null): n is number => n != null))).slice(0, 50);
    if (accts.length) {
      ownerMatches = await sodaQuery<any>(CHI, OWNERS, {
        select: "account_number,owner_name,owner_first_name,owner_last_name,owner_title",
        where: `account_number in (${accts.join(",")})`,
        limit: 300,
      });
    }
  }

  const ownersByAcct = new Map<number, string[]>();
  for (const o of ownerMatches) {
    const acct = num(o.account_number);
    if (acct == null) continue;
    const nm = str(o.owner_name) ?? [str(o.owner_first_name), str(o.owner_last_name)].filter(Boolean).join(" ");
    const label = o.owner_title ? `${nm} (${o.owner_title})` : nm;
    const arr = ownersByAcct.get(acct) ?? [];
    if (label && !arr.includes(label)) arr.push(label);
    ownersByAcct.set(acct, arr);
  }

  return {
    source: `Chicago Business Licenses (${CHI} ${LICENSES}${args?.owner ? ` + owners ${OWNERS}` : ""})`,
    fetchedAt: new Date().toISOString(),
    filters: { name: args?.name ?? null, owner: args?.owner ?? null, address: args?.address ?? null, zip: zip ?? null, licenseType: args?.licenseType ?? null, neighborhood: args?.neighborhood ?? null, activeOnly },
    returned: rows.length,
    hasMore: rows.length === limit,
    note: "Status AAI = issued/active. includeOwners=true adds owners/officers from the Business Owners dataset (ezma-pppn) per account.",
    licenses: rows.map((r: any) => ({
      licenseNumber: str(r.license_number),
      accountNumber: num(r.account_number),
      site: num(r.site_number),
      legalName: str(r.legal_name),
      dba: str(r.doing_business_as_name),
      address: [str(r.address), str(r.city), str(r.state)].filter(Boolean).join(", "),
      zip: str(r.zip_code),
      communityArea: str(r.community_area_name),
      ward: num(r.ward),
      licenseType: str(r.license_description),
      activity: str(r.business_activity),
      applicationType: str(r.application_type),
      start: isoDay(r.license_start_date),
      expires: isoDay(r.expiration_date),
      issued: isoDay(r.date_issued),
      status: str(r.license_status),
      statusChanged: isoDay(r.license_status_change_date),
      owners: ownersByAcct.get(num(r.account_number) ?? -1),
    })),
  };
}

export async function chicagoLicenseOwners(accountNumber: number) {
  return sodaQuery<any>(CHI, OWNERS, {
    select: "account_number,doing_business_as_name,owner_name,owner_first_name,owner_last_name,owner_title",
    where: `account_number=${accountNumber}`,
    limit: 50,
  });
}

export async function chicagoBuildingPermits(args: any) {
  const limit = clampLimit(args?.limit, 25, 100);
  const where: string[] = [];
  const minCost = Number(args?.minCost);
  if (Number.isFinite(minCost) && minCost > 0) where.push(`reported_cost >= ${Math.floor(minCost)}`);
  if (args?.address) {
    const a = String(args.address).trim().toUpperCase();
    const m = a.match(/^(\d+)\s+([NSEW])?\s*(.+?)$/);
    if (m) {
      where.push(`street_number=${Number(m[1])}`);
      if (m[2]) where.push(`street_direction=${soqlStr(m[2])}`);
      where.push(`upper(street_name) like ${soqlLike(m[3]!)}`);
    } else {
      where.push(`upper(street_name) like ${soqlLike(a)}`);
    }
  }
  if (args?.street && !args?.address) where.push(`upper(street_name) like ${soqlLike(String(args.street))}`);
  if (args?.permitType) where.push(`upper(permit_type) like ${soqlLike(String(args.permitType))}`);
  if (args?.workType) where.push(`upper(work_type) like ${soqlLike(String(args.workType))}`);
  if (args?.contact) {
    const like = soqlLike(String(args.contact));
    where.push(`(upper(contact_1_name) like ${like} OR upper(contact_2_name) like ${like} OR upper(contact_3_name) like ${like})`);
  }
  const zip = zipArg(args?.zip);
  if (zip) where.push(`(contact_1_zipcode=${soqlStr(zip)} OR contact_2_zipcode=${soqlStr(zip)})`);
  if (args?.ward) where.push(`ward=${Number(args.ward) || 0}`);
  if (args?.communityArea) where.push(`community_area=${Number(args.communityArea) || 0}`);
  const issuedAfter = dateArg(args?.issuedAfter, "issuedAfter");
  const issuedBefore = dateArg(args?.issuedBefore, "issuedBefore");
  if (issuedAfter) where.push(`issue_date >= '${issuedAfter}'`);
  if (issuedBefore) where.push(`issue_date <= '${issuedBefore}'`);
  if (args?.q) where.push(`upper(work_description) like ${soqlLike(String(args.q))}`);

  if (!where.length) throw new Error("Provide at least one filter: address, street, zip, permitType, workType, contact, minCost, ward, communityArea, issuedAfter, or q");
  // Default to a 12-month window for cost-only / type-only scans so results stay recent.
  if (!issuedAfter && !args?.address && !args?.contact && !args?.q) {
    const d = new Date(); d.setFullYear(d.getFullYear() - 1);
    where.push(`issue_date >= '${d.toISOString().slice(0, 10)}'`);
  }

  const contactsWanted = clampLimit(args?.contacts, 3, 6);
  const contactCols: string[] = [];
  for (let i = 1; i <= contactsWanted; i++) contactCols.push(`contact_${i}_type`, `contact_${i}_name`, `contact_${i}_city`, `contact_${i}_state`, `contact_${i}_zipcode`);

  const rows = await sodaQuery<any>(CHI, PERMITS, {
    select: ["permit_", "permit_type", "permit_status", "work_type", "issue_date", "application_start_date", "street_number", "street_direction", "street_name", "work_description", "reported_cost", "total_fee", "community_area", "ward", "pin_list", ...contactCols].join(","),
    where: where.join(" AND "),
    order: args?.orderBy === "cost" ? "reported_cost DESC" : "issue_date DESC",
    limit,
  });

  const permits = rows.map((r: any) => {
    const contacts: Array<{ role: string | null; name: string | null; cityState: string | null; zip: string | null }> = [];
    for (let i = 1; i <= contactsWanted; i++) {
      const nm = str(r[`contact_${i}_name`]);
      if (!nm) continue;
      contacts.push({
        role: str(r[`contact_${i}_type`]),
        name: nm,
        cityState: [str(r[`contact_${i}_city`]), str(r[`contact_${i}_state`])].filter(Boolean).join(", ") || null,
        zip: str(r[`contact_${i}_zipcode`]),
      });
    }
    const desc = str(r.work_description);
    return {
      permit: str(r.permit_),
      type: str(r.permit_type)?.replace(/^PERMIT\s*[-–]\s*/i, ""),
      status: str(r.permit_status),
      workType: str(r.work_type),
      issued: isoDay(r.issue_date),
      applied: isoDay(r.application_start_date),
      address: [str(r.street_number), str(r.street_direction), str(r.street_name)].filter(Boolean).join(" "),
      reportedCost: num(r.reported_cost),
      totalFee: num(r.total_fee),
      ward: num(r.ward),
      communityArea: num(r.community_area),
      pins: str(r.pin_list)?.split(/[,;\s]+/).filter(Boolean).slice(0, 3),
      description: desc && desc.length > 220 ? desc.slice(0, 219) + "…" : desc,
      contacts,
    };
  });

  const costs = permits.map((p: any) => p.reportedCost).filter((c: number | null): c is number => c != null);
  return {
    source: `Chicago Building Permits (${CHI} ${PERMITS})`,
    fetchedAt: new Date().toISOString(),
    filters: { address: args?.address ?? null, street: args?.street ?? null, zip: zip ?? null, permitType: args?.permitType ?? null, workType: args?.workType ?? null, contact: args?.contact ?? null, minCost: Number.isFinite(minCost) && minCost > 0 ? minCost : null, issuedAfter: issuedAfter ?? null, issuedBefore: issuedBefore ?? null, orderBy: args?.orderBy ?? "issued" },
    where: where.join(" AND "),
    returned: permits.length,
    hasMore: permits.length === limit,
    totalReportedCost: costs.length ? Math.round(costs.reduce((a: number, b: number) => a + b, 0)) : null,
    note: "reported_cost is self-reported by the applicant (USD); contact roles include OWNER, ARCHITECT, CONTRACTOR-GENERAL CONTRACTOR, EXPEDITOR. Zip filters match contact zips (dataset has no site zip). Types: NEW CONSTRUCTION, RENOVATION/ALTERATION, WRECKING/DEMOLITION, EASY PERMIT PROCESS, EXPRESS PERMIT PROGRAM, SIGNS, ELEVATOR EQUIPMENT.",
    permits,
  };
}

export { strList };
