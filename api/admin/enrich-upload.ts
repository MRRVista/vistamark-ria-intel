import type { VercelRequest, VercelResponse } from "@vercel/node";
import { requireAccessOrSession, requireCron } from "../../lib/auth";
import { enrichContacts } from "../../lib/prospects/enrich";

/**
 * Contact enrichment upload (v0.25.0).
 *
 *   GET  /api/admin/enrich-upload              upload page (signed-in Vistamark session)
 *   POST /api/admin/enrich-upload?source=tracerfy&tag=queue:first&dryRun=1
 *        body = the CSV or XLSX file bytes; header X-Filename optional
 *
 * Joins a file of emails/phones you supply to households already in the
 * prospects database (see lib/prospects/enrich.ts for the matching rules).
 * Auth: signed-in session, ACCESS_TOKEN, or Bearer CRON_SECRET.
 */
export const config = { api: { bodyParser: false } };

const MAX_BODY = 4_500_000;

function readBody(req: VercelRequest): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    req.on("data", (c: Buffer) => {
      size += c.length;
      if (size > MAX_BODY) { reject(new Error("file too large (max ~4.5 MB); split it")); req.destroy(); return; }
      chunks.push(c);
    });
    req.on("end", () => resolve(Buffer.concat(chunks)));
    req.on("error", reject);
  });
}

const PAGE = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Enrich contacts · VistaIntel</title>
<style>
:root{--bg:#0f1115;--card:#171a21;--ink:#e8e6e1;--mute:#9a9790;--gold:#d4a84a;--line:#2a2e37}
body{margin:0;background:var(--bg);color:var(--ink);font:15px/1.5 system-ui,-apple-system,Segoe UI,sans-serif}
main{max-width:760px;margin:40px auto;padding:0 16px}
h1{font-weight:500;color:var(--gold);margin:0 0 4px}p{color:var(--mute);margin:0 0 20px}
.card{background:var(--card);border:1px solid var(--line);border-radius:10px;padding:20px;margin-bottom:16px}
label{display:block;margin:12px 0 4px;color:var(--mute);font-size:13px}
input[type=text],input[type=file]{width:100%;box-sizing:border-box;background:#0f1115;color:var(--ink);border:1px solid var(--line);border-radius:6px;padding:8px}
.row{display:flex;gap:12px}.row>div{flex:1}
button{margin-top:16px;background:var(--gold);color:#111;border:0;border-radius:6px;padding:10px 18px;font-weight:600;cursor:pointer}
button.alt{background:transparent;color:var(--gold);border:1px solid var(--gold);margin-left:8px}
table{width:100%;border-collapse:collapse;font-size:13px;margin-top:12px}td,th{border-bottom:1px solid var(--line);padding:4px 6px;text-align:left}
.k{font-size:22px;color:var(--gold)}.stats{display:flex;gap:24px;flex-wrap:wrap}
</style></head><body><main>
<h1>Enrich contacts</h1>
<p>Attach emails and phones from a file (Tracerfy results, your own contacts) to Hinsdale households already in VistaIntel. Only the owner on record is matched; skip-trace emails are kept only when they carry the owner's name.</p>
<div class="card">
<label>File (CSV or XLSX)</label><input id="f" type="file" accept=".csv,.xlsx">
<div class="row"><div><label>Source</label><input id="src" type="text" value="tracerfy"></div>
<div><label>Tag (optional)</label><input id="tag" type="text" placeholder="queue:first"></div></div>
<button id="dry">Preview (no changes)</button><button id="go" class="alt">Load into VistaIntel</button>
</div>
<div class="card" id="out" hidden></div>
</main><script>
async function run(dry){
  const f=document.getElementById('f').files[0]; if(!f){alert('Choose a file');return;}
  const qs=new URLSearchParams({source:document.getElementById('src').value||'upload'});
  const tag=document.getElementById('tag').value.trim(); if(tag)qs.set('tag',tag); if(dry)qs.set('dryRun','1');
  const out=document.getElementById('out'); out.hidden=false; out.textContent='Working…';
  try{
    const r=await fetch('/api/admin/enrich-upload?'+qs,{method:'POST',credentials:'include',headers:{'X-Filename':f.name,'Content-Type':'application/octet-stream'},body:await f.arrayBuffer()});
    const j=await r.json(); if(!j.ok){out.textContent='Error: '+(j.error||r.status);return;}
    const c=j.counts||{};
    out.innerHTML='<div class="stats"><div><div class="k">'+j.rows+'</div>rows</div><div><div class="k">'+((c.written||0)+(c.would_write||0))+'</div>'+(dry?'would load':'loaded')+'</div><div><div class="k">'+j.withEmail+'</div>with email</div><div><div class="k">'+j.withPhone+'</div>with phone</div><div><div class="k">'+(c.other_person||0)+'</div>wrong person (skipped)</div></div>'
      +'<table><tr><th>Outcome</th><th>Rows</th></tr>'+Object.entries(c).map(([k,v])=>'<tr><td>'+k+'</td><td>'+v+'</td></tr>').join('')+'</table>';
  }catch(e){out.textContent='Error: '+e;}
}
document.getElementById('dry').onclick=()=>run(true);document.getElementById('go').onclick=()=>run(false);
</script></body></html>`;

export default async function handler(req: VercelRequest, res: VercelResponse) {
  const cron = requireCron(req);
  if (!cron.ok) {
    const auth = await requireAccessOrSession(req);
    if (!auth.ok) {
      if (req.method === "GET") { res.redirect(302, "/"); return; }
      res.status(401).json({ ok: false, error: auth.reason });
      return;
    }
  }
  if (req.method === "GET") {
    res.setHeader("Content-Type", "text/html; charset=utf-8");
    res.status(200).send(PAGE);
    return;
  }
  if (req.method !== "POST") { res.status(405).json({ ok: false, error: "POST a CSV or XLSX file" }); return; }
  const q = (k: string) => (Array.isArray(req.query[k]) ? req.query[k][0] : req.query[k]) as string | undefined;
  const flag = (k: string) => ["1", "true", "yes"].includes((q(k) ?? "").toLowerCase());
  try {
    const data = await readBody(req);
    if (!data.length) { res.status(400).json({ ok: false, error: "empty body" }); return; }
    const result = await enrichContacts({
      data,
      filename: (req.headers["x-filename"] as string | undefined) ?? undefined,
      source: q("source"),
      tag: q("tag"),
      overwrite: flag("overwrite"),
      dryRun: flag("dryRun"),
      actor: cron.ok ? "enrich-upload:cron-secret" : "enrich-upload:console",
    });
    res.status(200).json(result);
  } catch (err) {
    res.status(500).json({ ok: false, error: err instanceof Error ? err.message : String(err) });
  }
}
