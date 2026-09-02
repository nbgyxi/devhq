(() => {
  "use strict";
  const invoke = window.__TAURI__.core.invoke;
  const icon = (name) => window.devhqShell?.icon?.(name) || `<span class="ms">${name}</span>`;
  const esc = (value) => window.devhqShell?.esc?.(value) || String(value ?? "");
  const s = { host:null, rows:[], search:"", tab:"listen", selected:"", samples:new Map(), loading:false, error:"", timer:0, sampleTimer:0 };
  const processName = (row) => row.process || row.executablePath?.split(/[\\/]/).pop() || "Unknown process";
  const entries = () => s.rows.flatMap((row) => (row.ports?.length ? row.ports.map((binding) => ({
    key:`${row.pid}:${binding.port}`, row, pid:row.pid, port:binding.port, protocol:binding.protocol,
    address:binding.address, browserUrl:binding.browserUrl || "", httpStatus:binding.httpStatus || 0,
  })) : s.tab === "all" ? [{ key:`${row.pid}:none`, row, pid:row.pid, port:0, protocol:"" }] : []));
  const visible = () => {
    const words=s.search.toLowerCase().trim().split(/\s+/).filter(Boolean);
    return entries().filter((entry)=>words.every((word)=>`${entry.port} ${entry.pid} ${processName(entry.row)} ${entry.row.cwd||""} ${entry.row.commandLine||""}`.toLowerCase().includes(word)));
  };
  function body() {
    return `<div class="ports-body"><section class="ports-list-pane"><div class="ports-list-head">
        <label class="field ports-filter">${icon("filter_alt")}<input data-port-filter spellcheck="false" placeholder="Port, process, PID or project..." value="${esc(s.search)}"></label>
        <div class="ports-list-tools"><div class="seg"><button data-port-tab="listen" class="${s.tab==="listen"?"on":""}">Ports</button><button data-port-tab="all" class="${s.tab==="all"?"on":""}">All</button></div><button class="btn" data-ports-refresh>${icon("refresh")}Refresh</button></div>
      </div><div class="ports-list" data-ports-list></div></section><section class="ports-detail" data-ports-detail></section></div>`;
  }
  function renderList() {
    const host=s.host?.querySelector("[data-ports-list]"); if(!host)return;
    const rows=visible();
    if(!rows.length){host.innerHTML=`<div class="ports-empty">${s.loading?"Reading processes and ports…":s.error?esc(s.error):"Nothing matches this filter."}</div>`;return;}
    host.innerHTML=`<section class="port-group"><header class="port-group-head"><i class="dot green"></i>${s.tab==="listen"?"Listening ports":"Processes"}<span>${rows.length}</span></header>${rows.map((entry)=>{
      const sample=s.samples.get(entry.pid); const cpu=sample?.cpu==null?"—":`${sample.cpu.toFixed(1)}%`;
      return `<div class="port-row ${entry.key===s.selected?"on":""}" data-port-select="${esc(entry.key)}" role="button" tabindex="0"><i class="port-rail ${entry.port?"green":"grey"}"></i><span class="port-num dev">${entry.port?`<b>${entry.port}</b><small>${esc(entry.protocol)}</small>`:`<b class="none">—</b>`}</span><span class="port-what"><span class="port-what-top"><strong>${esc(processName(entry.row))}</strong>${entry.httpStatus?`<span class="port-badge">HTTP ${entry.httpStatus}</span>`:""}</span><small>PID ${entry.pid}${entry.row.cwd?` · ${esc(entry.row.cwd)}`:""}</small></span><span class="port-spark"></span><span class="port-cpu">${cpu}</span><span class="port-pin"></span></div>`;
    }).join("")}</section>`;
    if(!s.selected&&rows[0])s.selected=rows[0].key;
  }
  function selected(){return entries().find((entry)=>entry.key===s.selected)||visible()[0]||null}
  function renderDetail(){const host=s.host?.querySelector("[data-ports-detail]");if(!host)return;const entry=selected();if(!entry){host.innerHTML='<div class="ports-empty">Select a process.</div>';return;}s.selected=entry.key;const row=entry.row;const sample=s.samples.get(entry.pid);host.innerHTML=`<header class="port-detail-head"><span class="port-plate green"><b>${entry.port||"—"}</b><small>${esc(entry.protocol)}</small></span><span class="port-detail-title"><span class="port-detail-name"><h2>${esc(processName(row))}</h2><span class="port-badge">PID ${entry.pid}</span></span><span class="port-detail-meta">${esc(row.executablePath||"Executable unavailable")}</span></span></header><div class="port-detail-actions">${entry.browserUrl?`<button class="btn go" data-port-open="${esc(entry.browserUrl)}">${icon("open_in_new")}Open</button><button class="btn" data-port-copy="${esc(entry.browserUrl)}">${icon("content_copy")}Copy URL</button>`:""}<span class="spacer"></span><button class="btn danger" data-port-kill="${entry.pid}">${icon("stop_circle")}Kill</button></div><div class="port-detail-body"><div class="port-charts"><div class="port-chart cpu"><div class="port-chart-head"><span>CPU</span><b>${sample?.cpu==null?"—":`${sample.cpu.toFixed(1)}%`}</b></div></div><div class="port-chart mem"><div class="port-chart-head"><span>Memory</span><b>${sample?.memoryBytes?`${Math.round(sample.memoryBytes/1048576)} MB`:"—"}</b></div></div></div><dl class="port-facts"><div class="port-fact"><dt>Working folder</dt><dd>${esc(row.cwd||"Unavailable")}</dd></div><div class="port-fact"><dt>Command line</dt><dd>${esc(row.commandLine||"Unavailable")}</dd></div><div class="port-fact"><dt>Listening</dt><dd>${esc((row.ports||[]).map((p)=>`${p.address||"*"}:${p.port}/${p.protocol}`).join(", ")||"None")}</dd></div></dl></div>`}
  function render(){if(!s.host)return;const input=s.host.querySelector("[data-port-filter]");const focused=input===document.activeElement;const caret=focused?input.selectionStart:null;if(!s.host.querySelector("[data-ports-list]"))s.host.innerHTML=body();renderList();renderDetail();const next=s.host.querySelector("[data-port-filter]");if(next&&next.value!==s.search)next.value=s.search;if(focused){next.focus();next.setSelectionRange(caret,caret)}}
  async function load(){if(s.loading)return;s.loading=true;render();try{s.rows=await invoke("port_list");s.error=""}catch(error){s.error=String(error)}finally{s.loading=false;render();sample()}}
  async function sample(){const pids=[...new Set(visible().map((entry)=>entry.pid))].slice(0,600);if(!pids.length)return;try{const rows=await invoke("port_sample",{pids});for(const row of rows||[]){const prior=s.samples.get(row.pid);const now=Date.now();const seconds=prior?(now-prior.at)/1000:0;const cpu=prior&&seconds>.2?Math.max(0,(row.cpuSeconds-prior.cpuSeconds)/seconds/(navigator.hardwareConcurrency||4)*100):null;s.samples.set(row.pid,{...row,cpu,at:now});}renderList();renderDetail()}catch{}}
  async function kill(pid){const row=s.rows.find((item)=>item.pid===pid);if(!row)return;const yes=await window.devhqConfirm?.({title:`Kill ${processName(row)}?`,message:`PID ${pid} will be terminated immediately.`,confirmLabel:"Kill process",tone:"danger",icon:"stop_circle"});if(!yes)return;await invoke("port_kill",{pid,expectedExecutable:row.executablePath||"",expectedProcess:row.process||"",tree:true});await load()}
  function mount(host){s.host=host;host.onclick=(event)=>{const tab=event.target.closest("[data-port-tab]");if(tab){s.tab=tab.dataset.portTab;s.selected="";host.innerHTML=body();return render()}if(event.target.closest("[data-ports-refresh]"))return load();const pick=event.target.closest("[data-port-select]");if(pick){s.selected=pick.dataset.portSelect;return render()}const open=event.target.closest("[data-port-open]");if(open)return invoke("plugin:opener|open_url",{url:open.dataset.portOpen});const copy=event.target.closest("[data-port-copy]");if(copy)return navigator.clipboard.writeText(copy.dataset.portCopy);const stop=event.target.closest("[data-port-kill]");if(stop)return kill(Number(stop.dataset.portKill))};host.oninput=(event)=>{if(event.target.matches("[data-port-filter]")){s.search=event.target.value;renderList();renderDetail()}};host.innerHTML=body();render()}
  async function opened(){await load();clearInterval(s.timer);clearInterval(s.sampleTimer);s.timer=setInterval(load,30000);s.sampleTimer=setInterval(sample,2000)}
  // Kept alive but off screen: stop sampling the process table every 2s.
  function suspend(){clearInterval(s.timer);clearInterval(s.sampleTimer);s.timer=0;s.sampleTimer=0}
  async function resume(){await opened()}
  function exportState(){return {search:s.search,tab:s.tab,selected:s.selected}}
  function importState(saved){if(!saved)return;s.search=saved.search||"";s.tab=saved.tab==="all"?"all":"listen";s.selected=saved.selected||""}
  window.devhqPortsTool={mount,opened,render,suspend,resume,exportState,importState};
})();
