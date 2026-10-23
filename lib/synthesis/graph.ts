/**
 * relationship_graph — the warmest path to a person or an institution, built
 * from public board service (IRS 990 Part VII) and intersected with the
 * prospect DB.
 *
 * Seed: a person (→ their seats) or an org (→ its board). Depth 1 adds every
 * co-board member on those boards; depth 2 adds each co-member's other seats
 * (capped). Then every person node is checked against the prospect DB so the
 * graph says who we already know. Output: nodes, edges, connector ranking,
 * warm paths. "Serves alongside" is the strongest claim this makes.
 */
import { fanOut, callTool, type SourceResult, rowsOf, num, usd, normName, samePerson, coverage } from "./core";

export interface GraphArgs {
  person?: string;
  org?: string;
  ein?: string | number;
  state?: string;
  depth?: 1 | 2;
  maxOrgs?: number;
  maxPeoplePerOrg?: number;
  includeDbMatch?: boolean;
}

interface Node { id: string; type: "person" | "org"; label: string; meta: Record<string, unknown>; }
interface Edge { from: string; to: string; title?: string; hop: number; }

export async function relationshipGraph(args: GraphArgs) {
  const state = args.state?.toUpperCase();
  const depth = args.depth === 2 ? 2 : 1;
  const maxOrgs = Math.max(1, Math.min(args.maxOrgs ?? 8, 15));
  const maxPeople = Math.max(3, Math.min(args.maxPeoplePerOrg ?? 25, 60));
  const sources: SourceResult[] = [];
  const nodes = new Map<string, Node>();
  const edges: Edge[] = [];
  const orgQueue: Array<{ ein: string; name: string; hop: number }> = [];
  const pid = (n: string) => `p:${normName(n)}`;
  const oid = (e: string) => `o:${String(e).replace(/\D/g, "")}`;

  function addPerson(name: string, meta: Record<string, unknown> = {}) {
    const id = pid(name);
    if (!nodes.has(id)) nodes.set(id, { id, type: "person", label: name, meta });
    return id;
  }
  function addOrg(ein: string, name: string, meta: Record<string, unknown> = {}) {
    const id = oid(ein);
    if (!nodes.has(id)) nodes.set(id, { id, type: "org", label: name, meta });
    return id;
  }

  let seedId: string;
  if (args.person) {
    seedId = addPerson(args.person, { seed: true });
    const r = await callTool("irs990_boards_of_person", { name: args.person, ...(state ? { state } : {}), limit: 50 });
    sources.push(r.src);
    const seats = rowsOf(r.data).filter((s: any) => typeof s.score !== "number" || s.score >= 0.7).slice(0, maxOrgs);
    r.src.rows = seats.length;
    for (const s of seats) {
      const o = addOrg(s.ein, s.orgName, { assets: num(s.orgTotalAssets), city: s.orgCity, state: s.orgState });
      edges.push({ from: seedId, to: o, title: s.title, hop: 0 });
      orgQueue.push({ ein: String(s.ein), name: s.orgName, hop: 1 });
    }
  } else if (args.org || args.ein) {
    let ein = args.ein ? String(args.ein).replace(/\D/g, "") : "";
    let name = args.org ?? "";
    if (!ein) {
      const r = await callTool("irs990_filing_search", { orgName: name, ...(state ? { state } : {}), limit: 3 });
      sources.push(r.src);
      const f = rowsOf(r.data)[0];
      if (!f) return { dataSource: "synthesis:relationship_graph", error: `No 990 filing found for "${name}"`, sources };
      ein = String(f.ein);
      name = f.orgName ?? name;
    }
    seedId = addOrg(ein, name, { seed: true });
    orgQueue.push({ ein, name, hop: 1 });
  } else {
    throw new Error("relationship_graph: `person` or `org`/`ein` is required");
  }

  /* -------------------------- hop 1: boards of seed orgs -------------------- */
  const hop1 = await fanOut(orgQueue.map((o) => ({ tool: "irs990_board", args: { ein: o.ein } })));
  sources.push(...hop1.map((r) => r.src));
  const coMembers: Array<{ name: string; title?: string; orgId: string; orgName: string }> = [];
  hop1.forEach((r, i) => {
    const o = orgQueue[i];
    const orgId = addOrg(o.ein, r.data?.filing?.orgName ?? o.name, { assets: num(r.data?.filing?.totalAssetsEoy), city: r.data?.filing?.city, state: r.data?.filing?.state });
    const people = rowsOf(r.data).filter((p: any) => !p.isBusiness).slice(0, maxPeople);
    r.src.rows = people.length;
    for (const p of people) {
      if (args.person && samePerson(p.name, args.person)) continue;
      const id = addPerson(p.name, { title: p.title });
      edges.push({ from: id, to: orgId, title: p.title, hop: 1 });
      coMembers.push({ name: p.name, title: p.title, orgId, orgName: o.name });
    }
  });

  /* ---------------------- hop 2: co-members' other seats -------------------- */
  if (depth === 2 && coMembers.length) {
    const officersFirst = coMembers
      .slice()
      .sort((a, b) => Number(/chair|president|treasur|trustee|director/i.test(String(b.title))) - Number(/chair|president|treasur|trustee|director/i.test(String(a.title))))
      .slice(0, 10);
    const hop2 = await fanOut(officersFirst.map((m) => ({ tool: "irs990_boards_of_person", args: { name: m.name, ...(state ? { state } : {}), limit: 10 }, timeoutMs: 10000 })));
    sources.push(...hop2.map((r) => r.src));
    hop2.forEach((r, i) => {
      const m = officersFirst[i];
      const seats = rowsOf(r.data).filter((s: any) => typeof s.score !== "number" || s.score >= 0.85);
      r.src.rows = seats.length;
      for (const s of seats) {
        const oId = oid(s.ein);
        if (oId === m.orgId) continue;
        addOrg(s.ein, s.orgName, { assets: num(s.orgTotalAssets), city: s.orgCity, state: s.orgState });
        edges.push({ from: pid(m.name), to: oId, title: s.title, hop: 2 });
      }
    });
  }

  /* --------------------------- DB intersection ----------------------------- */
  let known: Array<{ person: string; id: number; leadStatus?: string; doNotContact?: boolean }> = [];
  if (args.includeDbMatch !== false) {
    const persons = Array.from(nodes.values()).filter((n) => n.type === "person" && !n.meta.seed);
    const surnames = Array.from(new Set(persons.map((p) => normName(p.label).split(" ").pop() ?? "").filter((s) => s.length >= 3))).slice(0, 20);
    const xr = await fanOut(surnames.map((s) => ({ tool: "prospects_search", args: { lastName: s, limit: 25 }, timeoutMs: 8000 })));
    sources.push(...xr.map((r) => r.src));
    const dbRows = xr.flatMap((r) => rowsOf(r.data));
    for (const p of persons) {
      const hits = dbRows.filter((r) => samePerson(r?.name?.full ?? "", p.label));
      if (hits.length) {
        p.meta.inDb = true;
        p.meta.leadStatus = hits[0]?.lead?.status;
        p.meta.doNotContact = hits.some((h) => h?.consent?.doNotContact);
        known.push({ person: p.label, id: hits[0].id, leadStatus: hits[0]?.lead?.status, doNotContact: p.meta.doNotContact as boolean });
      }
    }
  }

  /* ------------------------------ connectors ------------------------------- */
  const degree = new Map<string, number>();
  for (const e of edges) degree.set(e.from, (degree.get(e.from) ?? 0) + 1);
  const connectors = Array.from(nodes.values())
    .filter((n) => n.type === "person" && !n.meta.seed)
    .map((n) => ({ person: n.label, title: n.meta.title, seats: degree.get(n.id) ?? 0, inDb: Boolean(n.meta.inDb), leadStatus: n.meta.leadStatus, doNotContact: Boolean(n.meta.doNotContact), via: edges.filter((e) => e.from === n.id).map((e) => nodes.get(e.to)?.label).filter(Boolean).slice(0, 4) }))
    .sort((a, b) => Number(b.inDb) - Number(a.inDb) || b.seats - a.seats)
    .slice(0, 25);

  const warmPaths = connectors
    .filter((c) => c.inDb && !c.doNotContact)
    .slice(0, 8)
    .map((c) => ({ path: `${args.person ?? args.org ?? "seed"} ← ${c.via[0] ?? "board"} ← ${c.person} (${c.leadStatus ?? "in DB"})`, ask: `Ask ${c.person} for an introduction framed around ${c.via[0] ?? "the shared board"} — the one fact both sides already know is true.` }));

  return {
    dataSource: "synthesis:relationship_graph (IRS 990 Part VII board index · prospects DB)",
    seed: args.person ? { person: args.person } : { org: nodes.get(seedId!)?.label, ein: seedId!.slice(2) },
    depth,
    counts: { nodes: nodes.size, people: Array.from(nodes.values()).filter((n) => n.type === "person").length, orgs: Array.from(nodes.values()).filter((n) => n.type === "org").length, edges: edges.length, knownInDb: known.length },
    connectors,
    warmPaths,
    orgs: Array.from(nodes.values()).filter((n) => n.type === "org").map((n) => ({ ein: n.id.slice(2), name: n.label, assets: n.meta.assets, city: n.meta.city, state: n.meta.state, members: edges.filter((e) => e.to === n.id).length })).slice(0, 30),
    edges: edges.slice(0, 300).map((e) => ({ person: nodes.get(e.from)?.label, org: nodes.get(e.to)?.label, title: e.title, hop: e.hop })),
    guardrails: ["Board service is public; relationships are not. Say 'serves alongside', never 'knows'.", "Ask the connector for the intro — never approach the target cold on the strength of the graph."],
    coverage: coverage(sources),
    sources,
    note: "Edges are current seats (each org's newest e-filed return). Name joins are normalized-name matches; verify common names before acting. Depth 2 expands at most 10 co-members (officers first).",
  };
}
