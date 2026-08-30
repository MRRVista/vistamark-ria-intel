
/* ============================ VistaCharts panel ============================
   Rebased total-return chart, ticker vs benchmark, drawn as inline SVG.

   No chart library on purpose. The console ships zero third-party JS today
   and the whole panel is one path element per series plus axes — pulling in
   a charting dependency to draw two lines would cost more than it buys and
   would be the only remote script on a page that is otherwise self-contained.
--------------------------------------------------------------------------- */
var CH = { period:"1Y", data:null, loaded:false, req:0 };

var CH_PERIODS = ["3M","YTD","1Y","3Y","5Y","10Y"];
var CH_TICKERS = ["AAPL","MSFT","NVDA","AMZN","GOOGL","META","BRK-B","JPM","XOM","UNH",
                  "VTI","VOO","QQQ","SCHD","VIG","VYM","ARKK","BND"];
var CH_BENCHES = [
  ["SPY","S&P 500"],["VTI","US total market"],["QQQ","Nasdaq 100"],["IWM","US small cap"],
  ["ACWI","MSCI ACWI — global"],["VEA","Developed ex-US"],["VWO","Emerging markets"],
  ["AGG","US aggregate bond"],["TLT","Long Treasury"],["VNQ","US REITs"],
  ["GLD","Gold"],["DBC","Broad commodities"]
];
var CH_MONTHS = ["Jan","Feb","Mar","Apr","May","Jun","Jul","Aug","Sep","Oct","Nov","Dec"];

function chPct(x,dp){ if(x===null||x===undefined||!isFinite(x)) return "\u2014";
  var v=x*100; return (v>=0?"+":"\u2212")+Math.abs(v).toFixed(dp===undefined?2:dp)+"%"; }
function chNum(x,dp){ if(x===null||x===undefined||!isFinite(x)) return "\u2014";
  return x.toFixed(dp===undefined?2:dp); }
function chCls(x){ return (x===null||x===undefined||!isFinite(x))?"":(x>=0?"up":"down"); }
function chDate(iso,longform){
  var p=String(iso).split("-"); if(p.length<3) return String(iso);
  var m=CH_MONTHS[parseInt(p[1],10)-1]||"";
  return longform ? m+" "+parseInt(p[2],10)+", "+p[0] : m+" "+parseInt(p[2],10);
}
function chDateShort(iso,wide){
  var p=String(iso).split("-"); var m=CH_MONTHS[parseInt(p[1],10)-1]||"";
  return wide ? m+" \u2019"+p[0].slice(2) : m+" "+parseInt(p[2],10);
}

/* Axis ticks on human numbers (…1%, 2%, 5%, 10%…) rather than range/N. */
function chTicks(lo,hi,target){
  var span=hi-lo; if(!(span>0)) return [lo];
  var raw=span/(target||5), mag=Math.pow(10,Math.floor(Math.log(raw)/Math.LN10)), norm=raw/mag;
  var step=(norm<1.5?1:norm<3?2:norm<7?5:10)*mag;
  var out=[], t=Math.ceil(lo/step)*step;
  for(; t<=hi+step*1e-9; t+=step) out.push(Math.abs(t)<step*1e-9?0:t);
  return out;
}

/* ---------------------------------------------------------------- controls */
(function chInit(){
  var tl=document.getElementById("chTickerList");
  CH_TICKERS.forEach(function(t){ var o=el("option"); o.value=t; tl.appendChild(o); });
  var bl=document.getElementById("chBenchList");
  CH_BENCHES.forEach(function(b){ var o=el("option"); o.value=b[0]; o.label=b[0]+" \u2014 "+b[1];
    o.textContent=b[1]; bl.appendChild(o); });

  var box=document.getElementById("chPeriods");
  CH_PERIODS.forEach(function(p){
    var b=el("button",p===CH.period?"on":null,p);
    b.onclick=function(){
      CH.period=p;
      Array.prototype.forEach.call(box.children,function(x){x.classList.remove("on");});
      b.classList.add("on");
      chLoad();
    };
    box.appendChild(b);
  });

  document.getElementById("chGo").onclick=chLoad;
  ["chTicker","chBench"].forEach(function(id){
    document.getElementById(id).addEventListener("keydown",function(e){
      if(e.key==="Enter"){ e.preventDefault(); chLoad(); }
    });
  });

  var tab=document.querySelector('.tab[data-tab="charts"]');
  if(tab) tab.addEventListener("click",function(){ if(!CH.loaded) chLoad(); });
})();

/* -------------------------------------------------------------------- load */
function chLoad(){
  var ticker=(document.getElementById("chTicker").value||"").trim();
  var bench=(document.getElementById("chBench").value||"").trim();
  if(!ticker){ chFail("Enter a ticker symbol."); return; }

  CH.loaded=true;
  var myReq=++CH.req;
  document.getElementById("chBanner").innerHTML="";
  document.getElementById("chLegend").innerHTML="";
  document.getElementById("chReadout").innerHTML="";
  document.getElementById("chStatsCard").style.display="none";
  document.getElementById("chBox").innerHTML=
    '<div class="empty-state" style="padding:60px 0"><span class="spin"></span> '+
    'Loading '+esc(ticker.toUpperCase())+(bench?" vs "+esc(bench.toUpperCase()):"")+
    " \u00b7 "+esc(CH.period)+"\u2026</div>";
  document.getElementById("chMeta").textContent="";

  var url="/api/vistacharts?ticker="+encodeURIComponent(ticker)+
          "&benchmark="+encodeURIComponent(bench)+
          "&period="+encodeURIComponent(CH.period);

  jfetch(url).then(function(res){
    if(myReq!==CH.req) return;              /* a newer request already won */
    if(!res.ok||!res.data) throw new Error(failMsg(res));
    CH.data=res.data;
    chDraw(res.data); chStats(res.data);
  }).catch(function(e){ if(myReq===CH.req) chFail(e.message); });
}

function chFail(msg){
  document.getElementById("chBox").innerHTML="";
  document.getElementById("chBanner").innerHTML=
    '<div class="note bad">'+esc(msg)+"</div>";
  document.getElementById("chStatsCard").style.display="none";
  document.getElementById("chMeta").textContent="";
}

/* -------------------------------------------------------------------- draw */
function chDraw(d){
  var W=920,H=330,padL=58,padR=16,padT=16,padB=28;
  var plotW=W-padL-padR, plotH=H-padT-padB;
  var n=d.dates.length;
  var COLORS=["#C8A55C","#6E8BA8"];

  var lo=0, hi=0;                            /* always keep 0 in frame */
  d.series.forEach(function(s){ s.points.forEach(function(v){
    if(v<lo)lo=v; if(v>hi)hi=v; }); });
  var pad=(hi-lo)*0.08 || 0.02; lo-=pad; hi+=pad;

  function X(i){ return padL + (n<2?0:(i/(n-1))*plotW); }
  function Y(v){ return padT + (1-(v-lo)/(hi-lo))*plotH; }

  var svg='<svg viewBox="0 0 '+W+' '+H+'" preserveAspectRatio="xMidYMid meet" '+
          'xmlns="http://www.w3.org/2000/svg" role="img" aria-label="'+
          esc(d.series.map(function(s){return s.symbol;}).join(" versus "))+
          " "+esc(d.periodLabel)+' return chart">';
  svg+='<defs><linearGradient id="chFill" x1="0" y1="0" x2="0" y2="1">'+
       '<stop offset="0" stop-color="#C8A55C" stop-opacity=".22"/>'+
       '<stop offset="1" stop-color="#C8A55C" stop-opacity="0"/></linearGradient></defs>';

  /* y grid + labels */
  chTicks(lo,hi,6).forEach(function(t){
    var y=Y(t), zero=Math.abs(t)<1e-9;
    svg+='<line x1="'+padL+'" y1="'+y.toFixed(1)+'" x2="'+(W-padR)+'" y2="'+y.toFixed(1)+
         '" stroke="'+(zero?"rgba(200,165,92,.30)":"rgba(255,255,255,.055)")+
         '" stroke-width="1"/>';
    svg+='<text x="'+(padL-9)+'" y="'+(y+3.5).toFixed(1)+'" text-anchor="end" '+
         'font-family="ui-monospace,Menlo,monospace" font-size="10.5" fill="'+
         (zero?"#8794A1":"#5A6672")+'">'+(t*100).toFixed(Math.abs(hi-lo)<0.12?1:0)+'%</text>';
  });

  /* x labels */
  var wide=(Date.parse(d.to)-Date.parse(d.from))/86400000 > 400;
  var xn=Math.min(6,n), seen={};
  for(var k=0;k<xn;k++){
    var i=Math.round(k*(n-1)/(xn-1||1)), lab=chDateShort(d.dates[i],wide);
    if(seen[lab]) continue; seen[lab]=1;
    var anch=k===0?"start":(k===xn-1?"end":"middle");
    svg+='<text x="'+X(i).toFixed(1)+'" y="'+(H-9)+'" text-anchor="'+anch+'" '+
         'font-family="ui-monospace,Menlo,monospace" font-size="10.5" fill="#5A6672">'+
         esc(lab)+'</text>';
  }

  /* series — benchmark first so the ticker line sits on top */
  var order=d.series.map(function(s,i){return i;}).sort(function(a,b){return b-a;});
  order.forEach(function(si){
    var s=d.series[si], pts=s.points, path="";
    for(var i=0;i<pts.length;i++){
      var xi=(pts.length===n)?i:Math.round(i*(n-1)/(pts.length-1||1));
      path+=(i?"L":"M")+X(xi).toFixed(1)+" "+Y(pts[i]).toFixed(1)+" ";
    }
    if(si===0){
      svg+='<path d="'+path+"L"+X(n-1).toFixed(1)+" "+Y(lo).toFixed(1)+
           " L"+X(0).toFixed(1)+" "+Y(lo).toFixed(1)+' Z" fill="url(#chFill)" stroke="none"/>';
    }
    svg+='<path d="'+path+'" fill="none" stroke="'+COLORS[si]+'" stroke-width="'+
         (si===0?2:1.5)+'" stroke-linejoin="round" stroke-linecap="round"'+
         (si===0?'':' stroke-opacity=".85"')+'/>';
  });

  /* crosshair (hidden until scrub) */
  svg+='<g id="chCross" style="display:none">'+
       '<line id="chCrossL" y1="'+padT+'" y2="'+(padT+plotH)+'" stroke="rgba(237,228,207,.35)" stroke-width="1"/>';
  d.series.forEach(function(s,i){
    svg+='<circle id="chDot'+i+'" r="3.5" fill="'+COLORS[i]+'" stroke="#080B0F" stroke-width="1.5"/>';
  });
  svg+='</g>';
  svg+='<rect id="chHit" x="'+padL+'" y="'+padT+'" width="'+plotW+'" height="'+plotH+
       '" fill="transparent" style="cursor:crosshair"/>';
  svg+='</svg>';

  document.getElementById("chBox").innerHTML=svg;

  /* legend */
  var lg=document.getElementById("chLegend"); lg.innerHTML="";
  d.series.forEach(function(s,i){
    var w=el("div","lg");
    var sw=el("span","sw"); sw.style.background=COLORS[i]; w.appendChild(sw);
    w.appendChild(el("b",null,s.symbol));
    var v=el("span","v "+chCls(s.totalReturn),chPct(s.totalReturn));
    w.appendChild(v);
    if(i===1) w.appendChild(el("span",null,"benchmark"));
    lg.appendChild(w);
  });
  if(d.relative && d.relative.excessReturn!==null){
    var ex=el("div","lg");
    ex.appendChild(el("b",null,"Excess"));
    ex.appendChild(el("span","v "+chCls(d.relative.excessReturn),chPct(d.relative.excessReturn)));
    lg.appendChild(ex);
  }

  document.getElementById("chMeta").textContent=
    d.periodLabel+" \u00b7 "+chDate(d.from,true)+" \u2192 "+chDate(d.to,true)+" \u00b7 "+
    fmt(d.tradingDays)+" common trading days \u00b7 total return, dividend + split adjusted \u00b7 EODHD";

  chScrub(d,{W:W,padL:padL,plotW:plotW,n:n,X:X,Y:Y,colors:COLORS});
  chReadoutAt(d,n-1);
}

/* ----------------------------------------------------------------- scrub */
function chScrub(d,g){
  var box=document.getElementById("chBox");
  var svg=box.querySelector("svg"), hit=box.querySelector("#chHit");
  var cross=box.querySelector("#chCross"), line=box.querySelector("#chCrossL");
  if(!svg||!hit) return;

  function at(clientX){
    var r=svg.getBoundingClientRect(); if(!r.width) return;
    var vx=((clientX-r.left)/r.width)*g.W;
    var i=Math.round(((vx-g.padL)/g.plotW)*(g.n-1));
    i=Math.max(0,Math.min(g.n-1,i));
    cross.style.display="";
    line.setAttribute("x1",g.X(i).toFixed(1));
    line.setAttribute("x2",g.X(i).toFixed(1));
    d.series.forEach(function(s,si){
      var dot=box.querySelector("#chDot"+si); if(!dot) return;
      var pi=(s.points.length===g.n)?i:Math.round(i*(s.points.length-1)/(g.n-1||1));
      dot.setAttribute("cx",g.X(i).toFixed(1));
      dot.setAttribute("cy",g.Y(s.points[pi]).toFixed(1));
    });
    chReadoutAt(d,i);
  }

  hit.addEventListener("mousemove",function(e){ at(e.clientX); });
  hit.addEventListener("mouseleave",function(){
    cross.style.display="none"; chReadoutAt(d,g.n-1);
  });
  hit.addEventListener("touchstart",function(e){
    if(e.touches[0]) at(e.touches[0].clientX);
  },{passive:true});
  hit.addEventListener("touchmove",function(e){
    if(e.touches[0]) at(e.touches[0].clientX);
  },{passive:true});
}

function chReadoutAt(d,i){
  var r=document.getElementById("chReadout"); r.innerHTML="";
  var n=d.dates.length;
  var head=el("span","rk",chDate(d.dates[Math.max(0,Math.min(n-1,i))],true));
  r.appendChild(head);
  d.series.forEach(function(s){
    var pi=(s.points.length===n)?i:Math.round(i*(s.points.length-1)/(n-1||1));
    pi=Math.max(0,Math.min(s.points.length-1,pi));
    var v=s.points[pi];
    var w=el("span");
    w.appendChild(el("span","rk",s.symbol+" "));
    w.appendChild(el("span",chCls(v),chPct(v)));
    r.appendChild(w);
  });
}

/* ----------------------------------------------------------------- stats */
function chStats(d){
  var card=document.getElementById("chStatsCard");
  var t=document.getElementById("chStats"); t.innerHTML="";

  var head=el("thead"), hr=el("tr");
  hr.appendChild(el("th",null,"Measure"));
  d.series.forEach(function(s){
    var th=el("th",null,s.symbol+(s.role==="benchmark"?" (benchmark)":""));
    th.style.textAlign="right"; hr.appendChild(th);
  });
  head.appendChild(hr); t.appendChild(head);

  var tb=el("tbody");
  function row(label,vals,cls){
    var tr=el("tr"); tr.appendChild(el("td",null,label));
    vals.forEach(function(v){
      var td=el("td","num "+(cls?cls(v.raw):""),v.txt);
      tr.appendChild(td);
    });
    tb.appendChild(tr);
  }
  function pcts(key,dp){ return d.series.map(function(s){
    return {raw:s[key],txt:chPct(s[key],dp)}; }); }

  row("Total return",pcts("totalReturn"),chCls);
  if(d.series.some(function(s){return s.annualized!==null;}))
    row("Annualised (CAGR)",pcts("annualized"),chCls);
  row("Volatility (ann.)",d.series.map(function(s){
    return {raw:null,txt:s.volatility===null?"\u2014":(s.volatility*100).toFixed(2)+"%"};}));
  row("Max drawdown",pcts("maxDrawdown"),chCls);
  row("Best day",d.series.map(function(s){
    return {raw:s.best?s.best.value:null,
            txt:s.best?chPct(s.best.value)+"  "+chDate(s.best.date):"\u2014"};}),chCls);
  row("Worst day",d.series.map(function(s){
    return {raw:s.worst?s.worst.value:null,
            txt:s.worst?chPct(s.worst.value)+"  "+chDate(s.worst.date):"\u2014"};}),chCls);

  var rel=d.relative;
  if(rel){
    var span2=function(txt,cls){
      var tr=el("tr"); tr.appendChild(el("td",null,txt[0]));
      var td=el("td","num "+(cls||""),txt[1]); td.colSpan=d.series.length;
      tr.appendChild(td); tb.appendChild(tr);
    };
    span2(["Excess return vs "+d.series[1].symbol,chPct(rel.excessReturn)],chCls(rel.excessReturn));
    span2(["Beta to "+d.series[1].symbol,chNum(rel.beta)]);
    span2(["Correlation",chNum(rel.correlation)]);
    span2(["Tracking error (ann.)",rel.trackingError===null?"\u2014":
           (rel.trackingError*100).toFixed(2)+"%"]);
  }
  t.appendChild(tb);
  card.style.display="";
}
