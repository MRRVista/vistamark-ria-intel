import type { VercelRequest, VercelResponse } from "@vercel/node";
import { requireAccessOrSession, requireCron } from "../../lib/auth";
import { buildTracerfyExport } from "../../lib/prospects/export";

/**
 * Tracerfy input-format export (v0.25.2; already-traced mode v0.25.3).
 *
 *   GET  /api/admin/tracerfy-export                 filter page (signed-in Vistamark session)
 *   GET  /api/admin/tracerfy-export?mode=traced     same page, preset to already-traced
 *   GET  /api/admin/tracerfy-export?download=1&zip=60521,60527&minHomeValue=2000000&skipTraced=1&skipEmailed=1
 *   GET  /api/admin/tracerfy-export?download=1&onlyTraced=1   households already traced (suppression list)
 *
 * One row per household, home value highest first. Columns A-F are Tracerfy's
 * intake layout (Address, City, State, Zip, First Name, Last Name); everything
 * else VistaIntel holds follows from G onward — delete G+ before uploading.
 * onlyTraced returns the households already run through Tracerfy, in the same
 * layout, so a new batch can be deduped before it is paid for twice.
 * Read-only: nothing in the database changes. Load Tracerfy's results back
 * through /api/admin/enrich-upload.
 * Auth: signed-in session, ACCESS_TOKEN, or Bearer CRON_SECRET.
 */
const PAGE = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Export for Tracerfy · VistaIntel</title>
<style>
:root{--bg:#0f1115;--card:#171a21;--ink:#e8e6e1;--mute:#9a9790;--gold:#d4a84a;--line:#2a2e37}
body{margin:0;background:var(--bg);color:var(--ink);font:15px/1.5 system-ui,-apple-system,Segoe UI,sans-serif}
main{max-width:760px;margin:40px auto;padding:0 16px}
h1{font-weight:500;color:var(--gold);margin:0 0 4px}p{color:var(--mute);margin:0 0 20px}
.card{background:var(--card);border:1px solid var(--line);border-radius:10px;padding:20px;margin-bottom:16px}
label{display:block;margin:12px 0 4px;color:var(--mute);font-size:13px}
input[type=text],input[type=number]{width:100%;box-sizing:border-box;background:#0f1115;color:var(--ink);border:1px solid var(--line);border-radius:6px;padding:8px}
.row{display:flex;gap:12px}.row>div{flex:1}
.chk{display:flex;align-items:center;gap:8px;margin-top:14px;color:var(--ink)}.chk input{width:auto}
.modes{display:flex;gap:0;border:1px solid var(--line);border-radius:6px;overflow:hidden;margin-bottom:6px}
.modes label{flex:1;margin:0;padding:10px 12px;text-align:center;cursor:pointer;color:var(--mute);font-size:13px;border-right:1px solid var(--line)}
.modes label:last-child{border-right:0}
.modes input{display:none}
.modes label.on{background:rgba(212,168,74,.12);color:var(--gold);box-shadow:inset 0 -2px 0 var(--gold)}
.hint{color:var(--mute);font-size:13px;margin:8px 0 0}
button{margin-top:16px;background:var(--gold);color:#111;border:0;border-radius:6px;padding:10px 18px;font-weight:600;cursor:pointer}
button.alt{background:transparent;color:var(--gold);border:1px solid var(--gold);margin-left:8px}
.k{font-size:22px;color:var(--gold)}.stats{display:flex;gap:24px;flex-wrap:wrap}
code{color:var(--gold)}
</style></head><body><main>
<h1>Export for Tracerfy</h1>
<p>Downloads households in Tracerfy's intake layout — columns A–F are <code>Address, City, State, Zip, First Name, Last Name</code>; every other field VistaIntel holds (home value, IDs, co-owner, existing contacts, tags, the original county record) follows from column G. Delete G onward before uploading. Highest home value first. Nothing here changes the database.</p>
<div class="card">
<div class="modes">
<label id="lNew" class="on"><input type="radio" name="mode" value="new" id="mNew" checked>Not yet traced — Tracerfy input</label>
<label id="lTraced"><input type="radio" name="mode" value="traced" id="mTraced">Already traced — suppression list</label>
</div>
<div class="hint" id="modeHint"></div>
<div class="row"><div><label>ZIP codes (comma list, blank = all)</label><input id="zip" type="text" placeholder="60521,60527"></div>
<div><label>Minimum home value</label><input id="min" type="number" placeholder="0" min="0" step="100000"></div></div>
<div id="skips">
<div class="chk"><input id="traced" type="checkbox" checked><label for="traced" style="margin:0">Skip households already run through Tracerfy</label></div>
<div class="chk"><input id="emailed" type="checkbox" checked><label for="emailed" style="margin:0">Skip households that already have an email on file</label></div>
</div>
<button id="count">Count rows</button><button id="dl" class="alt">Download CSV</button>
<div id="out" style="margin-top:16px;color:var(--mute)"></div>
</div>
</main><script>
function mode(){return document.getElementById('mTraced').checked?'traced':'new';}
function sync(){
  var t=mode()==='traced';
  document.getElementById('lTraced').className=t?'on':'';
  document.getElementById('lNew').className=t?'':'on';
  document.getElementById('skips').style.display=t?'none':'';
  document.getElementById('dl').textContent=t?'Download already-traced CSV':'Download CSV';
  document.getElementById('modeHint').textContent=t
    ?'Every household already run through Tracerfy (tagged traced: or enriched:tracerfy), including ones with an email or marked do-not-contact. Same A–F layout; column "Traced Tags" shows which batch and date. Use it to dedupe a new list before paying again.'
    :'Households not yet traced, ready to upload to Tracerfy.';
  document.getElementById('out').textContent='';
}
document.getElementById('mNew').onchange=sync;
document.getElementById('mTraced').onchange=sync;
if(new URLSearchParams(location.search).get('mode')==='traced') document.getElementById('mTraced').checked=true;
sync();
function qs(extra){
  var p=new URLSearchParams(extra||{});
  var z=document.getElementById('zip').value.trim(); if(z)p.set('zip',z);
  var m=document.getElementById('min').value.trim(); if(m)p.set('minHomeValue',m);
  if(mode()==='traced'){ p.set('onlyTraced','1'); }
  else {
    p.set('skipTraced',document.getElementById('traced').checked?'1':'0');
    p.set('skipEmailed',document.getElementById('emailed').checked?'1':'0');
  }
  return p.toString();
}
document.getElementById('count').onclick=async function(){
  var out=document.getElementById('out'); out.textContent='Counting…';
  try{
    var r=await fetch('/api/admin/tracerfy-export?'+qs({count:'1'}),{credentials:'include'});
    var j=await r.json(); if(!j.ok){out.textContent='Error: '+(j.error||r.status);return;}
    if(j.onlyTraced){
      out.innerHTML='<div class="stats"><div><div class="k">'+j.households+'</div>households already traced</div><div><div class="k">'+j.skippedNotTraced+'</div>not yet traced (excluded)</div></div>';
    } else {
      out.innerHTML='<div class="stats"><div><div class="k">'+j.households+'</div>households would export</div><div><div class="k">'+j.skippedTraced+'</div>skipped: already traced</div><div><div class="k">'+j.skippedEmailed+'</div>skipped: has email</div><div><div class="k">'+j.skippedDnc+'</div>skipped: do not contact</div></div>';
    }
  }catch(e){out.textContent='Error: '+e;}
};
document.getElementById('dl').onclick=function(){ window.location='/api/admin/tracerfy-export?'+qs({download:'1'}); };
</script></body></html>`;

export default async function handler(req: VercelRequest, res: VercelResponse) {
  const cron = requireCron(req);
  if (!cron.ok) {
    const auth = await requireAccessOrSession(req);
    if (!auth.ok) {
      if (req.method === "GET" && !req.headers.authorization) { res.redirect(302, "/"); return; }
      res.status(401).json({ ok: false, error: auth.reason });
      return;
    }
  }
  if (req.method !== "GET") { res.status(405).json({ ok: false, error: "GET only" }); return; }

  const q = (k: string) => (Array.isArray(req.query[k]) ? req.query[k][0] : req.query[k]) as string | undefined;
  const flag = (k: string, dflt: boolean) => {
    const v = (q(k) ?? "").toLowerCase();
    if (!v) return dflt;
    return ["1", "true", "yes", "on"].includes(v);
  };
  const wantsDownload = flag("download", false);
  const wantsCount = flag("count", false);
  if (!wantsDownload && !wantsCount) {
    res.setHeader("Content-Type", "text/html; charset=utf-8");
    res.status(200).send(PAGE);
    return;
  }

  try {
    const onlyTraced = flag("onlyTraced", false) || (q("mode") ?? "").toLowerCase() === "traced";
    const result = await buildTracerfyExport({
      zips: (q("zip") ?? "").split(",").map((z) => z.trim()).filter((z) => /^\d{5}$/.test(z)),
      minHomeValue: Number(q("minHomeValue") ?? "") || 0,
      skipTraced: flag("skipTraced", true),
      skipEmailed: flag("skipEmailed", true),
      onlyTraced,
      limit: Number(q("limit") ?? "") || undefined,
    });
    if (wantsCount) {
      res.status(200).json({ ok: true, onlyTraced: result.onlyTraced, households: result.rows.length, skippedTraced: result.skippedTraced, skippedEmailed: result.skippedEmailed, skippedDnc: result.skippedDnc, skippedNotTraced: result.skippedNotTraced, columns: result.header.length });
      return;
    }
    const stamp = new Date().toISOString().slice(0, 10);
    const zipPart = result.zips.length ? result.zips.join("-") + "-" : "";
    const name = result.onlyTraced ? `tracerfy-already-traced-${zipPart}${stamp}.csv` : `tracerfy-input-${zipPart}${stamp}.csv`;
    res.setHeader("Content-Type", "text/csv; charset=utf-8");
    res.setHeader("Content-Disposition", `attachment; filename="${name}"`);
    res.setHeader("Cache-Control", "no-store");
    res.status(200).send(result.csv);
  } catch (err) {
    res.status(500).json({ ok: false, error: err instanceof Error ? err.message : String(err) });
  }
}
