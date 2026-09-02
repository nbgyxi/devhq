// Route latency and loss, powered by Windows' built-in pathping.
(() => {
const invoke = window.__TAURI__.core.invoke;
const listen = window.__TAURI__.event.listen;
const s = { host:null, built:false, wired:false, target:"", queries:10, maxHops:30, resolve:true,
  running:false, token:0, phase:"idle", lines:[], hops:[], selected:0, error:"", started:0 };

const icon = (n) => window.wintShell?.icon(n) ?? `<span class="ms">${n}</span>`;
const esc = (v) => window.wintShell?.esc(v) ?? String(v ?? "");
const dirty = () => window.wintShell?.markDirty("path-ping");

function mount(host) {
  if (!host || s.built) return;
  s.host = host;
  host.innerHTML = `
    <header class="tool-head path-head">
      <button class="btn back tool-back" type="button" data-open-tool="overview">${icon("arrow_back")}Back</button>
      <span class="tool-plate">${icon("route")}</span>
      <span class="tool-title"><strong>Path Ping</strong><small>latency and loss, hop by hop</small></span>
      <button class="tool-popout" type="button" data-popout-tool="path-ping"></button>
      <button class="tool-pin" id="tool-pin-path-ping" type="button" data-pin-tool="path-ping"></button>
      <button class="tool-close" type="button" data-open-tool="overview">${icon("close")}</button>
    </header>
    <form class="path-runbar" id="path-form">
      <label class="field path-target">${icon("language")}<input id="path-target" spellcheck="false" autocomplete="off" placeholder="Hostname or IP address" /></label>
      <button class="btn primary" id="path-run" type="submit">${icon("play_arrow")}Run probe</button>
    </form>
    <div class="path-layout">
      <aside class="path-left">
        <section class="path-panel"><h3>${icon("tune")}Probe plan</h3>
          <label>Queries per hop <span class="mono" id="path-q-label"></span></label>
          <div class="path-seg" data-path-setting="queries">${[10,50,100,250].map(n=>`<button type="button" data-value="${n}">${n}</button>`).join("")}</div>
          <label>Maximum hops <span class="mono" id="path-h-label"></span></label>
          <div class="path-seg" data-path-setting="maxHops">${[10,20,30].map(n=>`<button type="button" data-value="${n}">${n}</button>`).join("")}</div>
          <label class="path-check"><input id="path-resolve" type="checkbox" checked /><span>${icon("check")}</span>Resolve hop names</label>
          <p>${icon("info")}Pathping first traces the route, then measures each hop. More queries are more reliable and take longer.</p>
        </section>
        <section class="path-panel path-recent"><h3>${icon("history")}Recent runs</h3><div id="path-recent"></div></section>
      </aside>
      <section class="path-center">
        <div class="path-progress" id="path-progress"></div>
        <section class="path-panel path-hops"><div class="path-table-head"><b>Hops</b><span class="mono" id="path-summary"></span></div>
          <div class="path-cols"><span>Hop</span><span>Router</span><span>RTT</span><span>This node</span><span>Loss</span></div>
          <div id="path-rows"></div><footer class="mono" id="path-command"></footer>
        </section>
      </section>
      <aside class="path-right"><section class="path-panel" id="path-verdict"></section><section class="path-panel" id="path-detail"></section>
        <section class="path-panel path-help"><h3>${icon("school")}Node loss vs link loss</h3><b>Node loss</b><p>Loss that continues on every later hop can identify where forwarded traffic starts disappearing.</p><b>Link loss</b><p>A loss figure that vanishes downstream usually means that router deprioritizes probe replies; forwarded traffic is still fine.</p></section>
      </aside>
    </div>`;
  s.built = true; wire(); render();
}

function wire() {
  if (s.wired) return; s.wired = true;
  s.host.querySelector("#path-form").addEventListener("submit", e => { e.preventDefault(); s.running ? stop() : run(); });
  s.host.querySelector("#path-target").addEventListener("input", e => s.target=e.target.value);
  s.host.querySelector("#path-resolve").addEventListener("change", e => s.resolve=e.target.checked);
  s.host.addEventListener("click", e => {
    const pop=e.target.closest("[data-popout-tool]");
    if(pop)return window.wintShell?.popOutTool?.(pop.dataset.popoutTool);
    const pin=e.target.closest("[data-pin-tool]");
    if(pin)return window.wintShell?.toggleToolPin?.(pin.dataset.pinTool);
    const go=e.target.closest("[data-open-tool]");
    if(go)return window.wintShell?.openTool?.(go.dataset.openTool);
    const setting=e.target.closest("[data-path-setting] button");
    if (setting && !s.running) { s[setting.parentElement.dataset.pathSetting]=Number(setting.dataset.value); render(); }
    const row=e.target.closest("[data-hop]"); if(row){s.selected=Number(row.dataset.hop); render();}
  });
  listen("path-ping:line", e => { if(s.running && !s.token)s.token=e.payload.token; if(e.payload.token!==s.token)return; parseLine(e.payload.text); dirty(); });
  listen("path-ping:done", e => { if(e.payload.token!==s.token)return; s.running=false; s.phase="done"; s.error=e.payload.error; window.wintWork?.endWork("path-ping"); saveRecent(); dirty(); });
}

async function run() {
  const target=s.host.querySelector("#path-target").value.trim(); if(!target)return;
  s.target=target; s.running=true; s.token=0; s.phase="trace"; s.lines=[]; s.hops=[]; s.selected=0; s.error=""; s.started=Date.now(); dirty();
  window.wintWork?.beginWork("path-ping", `Probing ${target}`, "Tracing route");
  try { s.token=await invoke("path_ping_start",{options:{target,queries:s.queries,maxHops:s.maxHops,resolveNames:s.resolve}}); }
  catch(err){s.running=false;s.error=String(err);window.wintWork?.endWork("path-ping");dirty();}
}
async function stop(){ await invoke("path_ping_cancel"); s.running=false;s.phase="idle";window.wintWork?.endWork("path-ping");dirty(); }

function parseLine(text) {
  s.lines.push(text);
  if (/computing statistics|gathering statistics/i.test(text)) { s.phase="measure"; window.wintWork?.updateWork("path-ping",`Measuring ${s.hops.length} hops`); return; }
  // Trace rows: hop, then a latency or *, then the router/address.
  let m=text.match(/^\s*(\d+)\s+(?:(<?\d+)\s*ms|\*)\s+(.*\S)\s*$/i);
  if(m && !text.includes("/")) { upsert(Number(m[1]), m[3], Number(m[2])||0, null); return; }
  // Statistics rows contain two lost/sent percentages. The second is this node.
  m=text.match(/^\s*(\d+)\s+(?:(<?\d+)\s*ms|---)\s+\d+\s*\/\s*\d+\s*=\s*(\d+)%\s+\d+\s*\/\s*\d+\s*=\s*(\d+)%\s+(.*\S)\s*$/i);
  if(m) upsert(Number(m[1]),m[5],Number(m[2])||0,Number(m[4]));
}
function upsert(n, raw, rtt, loss) {
  let hop=s.hops.find(h=>h.n===n); if(!hop){hop={n,name:"",address:"",rtt:0,loss:null};s.hops.push(hop);s.hops.sort((a,b)=>a.n-b.n);}
  const address=(raw.match(/\[([^\]]+)\]/)||raw.match(/((?:\d{1,3}\.){3}\d{1,3})/)||[])[1]||"";
  const name=raw.replace(/\s*\[[^\]]+\]\s*$/,"").trim(); hop.name=name||address||"No reply"; hop.address=address||(name.match(/^\d/) ? name : ""); hop.rtt=rtt||hop.rtt; if(loss!==null)hop.loss=loss; if(!s.selected)s.selected=n;
}
function verdict() {
  const losses=s.hops.filter(h=>h.loss>0); if(!losses.length)return {tone:"ok",title:s.phase==="done"?"No route loss detected":"Waiting for loss measurements",body:"Loss is compared across later hops so routers that only ignore probes are not blamed."};
  const bad=losses.find(h=>s.hops.filter(x=>x.n>h.n&&x.loss!==null).some(x=>x.loss>=h.loss));
  return bad?{tone:"bad",title:`Loss starts at hop ${bad.n}`,body:`${bad.loss}% loss appears here and persists farther along the route. Check this network segment first.`}:{tone:"warn",title:"A hop is limiting probe replies",body:"Loss does not persist downstream, so forwarded traffic is probably unaffected."};
}
function saveRecent(){if(!s.hops.length)return;try{let a=JSON.parse(localStorage.getItem("wint.pathPing.runs")||"[]");a.unshift({target:s.target,when:Date.now(),hops:s.hops.length,loss:Math.max(0,...s.hops.map(h=>h.loss||0))});localStorage.setItem("wint.pathPing.runs",JSON.stringify(a.slice(0,6)));}catch(_){}}
function recent(){try{return JSON.parse(localStorage.getItem("wint.pathPing.runs")||"[]");}catch(_){return[];}}

function render() {
  if(!s.host)return; const $=q=>s.host.querySelector(q); const selected=s.hops.find(h=>h.n===s.selected); const v=verdict();
  $("#path-q-label").textContent=s.queries; $("#path-h-label").textContent=s.maxHops;
  s.host.querySelectorAll("[data-path-setting]").forEach(g=>g.querySelectorAll("button").forEach(b=>b.classList.toggle("on",Number(b.dataset.value)===s[g.dataset.pathSetting])));
  const run=$("#path-run");run.innerHTML=s.running?`${icon("stop")}Stop`:`${icon("play_arrow")}Run probe`;run.classList.toggle("danger",s.running);
  $("#path-progress").innerHTML=s.error?`<div class="path-status bad">${icon("error")}<b>${esc(s.error)}</b></div>`:s.phase==="idle"?`<div class="path-status">${icon("route")}<b>Ready to trace a route</b><span>Enter a host to begin</span></div>`:`<div class="path-status ${s.phase==="done"?"ok":""}">${icon(s.phase==="done"?"check_circle":"progress_activity")}<b>${s.phase==="trace"?"Tracing route":s.phase==="measure"?"Measuring packet loss":"Statistics complete"}</b><span>${s.hops.length} hops found</span><i><em style="width:${s.phase==="done"?100:s.phase==="measure"?64:25}%"></em></i></div>`;
  $("#path-summary").textContent=`${s.hops.length} hops · ${s.queries} queries per hop`;
  $("#path-rows").innerHTML=s.hops.length?s.hops.map(h=>`<button class="path-row ${h.n===s.selected?"selected":""}" data-hop="${h.n}"><span>${h.n}</span><span><b>${esc(h.name)}</b><small>${esc(h.address)}</small></span><span><i class="rtt" style="--r:${Math.min(100,h.rtt*2)}%"></i><b>${h.rtt||"—"}</b>${h.rtt?" ms":""}</span><span class="${h.loss>0?"loss":""}">${h.loss==null?"—":h.loss+"%"}</span><span><i class="lossbar" style="--l:${h.loss||0}%"></i>${h.loss>0?icon("warning"):icon("check_circle")}</span></button>`).join(""):`<div class="path-empty">The route will appear here, one hop at a time.</div>`;
  $("#path-command").textContent=s.target?`pathping -q ${s.queries} -h ${s.maxHops} ${s.resolve?"":"-n "}${s.target}`:"";
  $("#path-verdict").innerHTML=`<h3 class="${v.tone}">${icon(v.tone==="bad"?"warning":v.tone==="warn"?"priority_high":"verified")}Verdict</h3><h2>${esc(v.title)}</h2><p>${esc(v.body)}</p>`;
  $("#path-detail").innerHTML=selected?`<h3>${icon("query_stats")}Hop ${selected.n} detail</h3><dl><dt>Address</dt><dd>${esc(selected.address||"—")}</dd><dt>Router</dt><dd>${esc(selected.name)}</dd><dt>Average RTT</dt><dd>${selected.rtt||"—"}${selected.rtt?" ms":""}</dd><dt>This node loss</dt><dd class="${selected.loss>0?"bad":""}">${selected.loss==null?"Measuring…":selected.loss+"%"}</dd></dl>`:`<h3>${icon("query_stats")}Hop detail</h3><p>Select a hop to inspect it.</p>`;
  $("#path-recent").innerHTML=recent().map(r=>`<button type="button" onclick="document.querySelector('#path-target').value='${esc(r.target)}'"><i class="${r.loss?"bad":"ok"}"></i><span><b>${esc(r.target)}</b><small>${r.hops} hops</small></span><em>${r.loss}%</em></button>`).join("")||`<p>No probes yet.</p>`;
}
function opened(){render();}
function exportState(){return {...s,host:null,built:false,wired:false};}
function importState(state){if(!state)return;Object.assign(s,state,{host:s.host,built:s.built,wired:s.wired});if(s.host)render();}
window.wintPathPing={mount,render,opened,exportState,importState};
})();
