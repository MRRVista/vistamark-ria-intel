/* Applies the VistaCharts fragments into public/console.html.
   Idempotent: exits 0 with a notice if the panel is already present.
   Run from the repo root: node _vc/apply.js

   LINE ENDINGS: git on Windows checks out with core.autocrlf, so the file
   on disk may be CRLF while every anchor below is written LF. Everything is
   normalized to LF on read and written back as LF; git re-normalizes on
   commit, so the committed diff stays scoped to the inserts. */
const fs = require("fs");

const P = "public/console.html";
const lf = (t) => t.replace(/\r\n/g, "\n");
let s = lf(fs.readFileSync(P, "utf8"));

if (s.indexOf("p-charts") > -1) {
  console.log("ALREADY APPLIED - no change");
  process.exit(0);
}

const css   = lf(fs.readFileSync("_vc/css.txt", "utf8"));
const panel = lf(fs.readFileSync("_vc/panel.html", "utf8"));
const js    = lf(fs.readFileSync("_vc/charts.js", "utf8"));

function once(hay, needle) {
  const n = hay.split(needle).length - 1;
  if (n !== 1) throw new Error("anchor matched " + n + " times: " + JSON.stringify(needle.slice(0, 60)));
}

/* 1. CSS block, ahead of the mobile media query */
const A1 = "@media(max-width:900px){";
once(s, A1);
s = s.replace(A1, css.replace(/\s+$/, "") + "\n\n" + A1);

/* 2. mobile: let five tabs wrap, and size the chart controls down */
const A2 = "  .tab{font-size:9px;letter-spacing:.5px;padding:9px 2px}";
once(s, A2);
s = s.replace(
  A2,
  "  .tabs{flex-wrap:wrap}\n" +
    "  .tab{font-size:9px;letter-spacing:.5px;padding:9px 2px;flex:1 1 30%}\n" +
    "  .chartctrl .field{min-width:100%}\n" +
    "  .periods{width:100%}\n" +
    "  .periods button{flex:1;padding:8px 4px;letter-spacing:.6px}"
);

/* 3. tab button, immediately after Explore */
const A3 = '      <button class="tab on" data-tab="explore">Explore</button>\n';
once(s, A3);
s = s.replace(A3, A3 + '      <button class="tab" data-tab="charts">VistaCharts</button>\n');

/* 4. panel markup, between Explore and Ask */
const A4 = "    <!-- ASK -->";
once(s, A4);
s = s.replace(A4, panel.replace(/\n+$/, "") + "\n\n" + A4);

/* 5. renderer, at the tail of the existing inline script */
const A5 = "\n</script>\n</body>";
once(s, A5);
s = s.replace(A5, "\n" + js.replace(/\s+$/, "") + "\n</script>\n</body>");

fs.writeFileSync(P, s);

/* verify: the inline script must still parse */
const i = s.indexOf("<script>") + 8;
const j = s.lastIndexOf("</script>");
new (require("vm").Script)(s.slice(i, j), { filename: "console-inline.js" });

console.log("APPLIED ok");
console.log("  bytes                : " + s.length);
console.log("  inline script        : " + (j - i) + " bytes, parses clean");
console.log("  <section> open/close : " + (s.split("<section").length - 1) + "/" + (s.split("</section>").length - 1));
console.log("  panels               : " + (s.split('class="panel').length - 1));
console.log("  charts tab           : " + (s.indexOf('data-tab="charts"') > -1));
