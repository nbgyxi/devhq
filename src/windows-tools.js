(() => {
  "use strict";
  const invoke = window.__TAURI__.core.invoke;
  const esc = (value) => String(value ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
  const icon = (name) => window.devhqShell?.icon?.(name) || `<span class="ms" aria-hidden="true">${name}</span>`;
  const catalog = [
    { id: "help", name: "Help", icon: "help", hint: "project commands, application commands, and available tools", keywords: "help guide docs manual ? commands run terminal pull code explorer tools" },
    { id: "events", name: "Event Log Streamer", icon: "receipt_long", hint: "filter Windows events as they arrive", keywords: "event viewer logs application system security errors warnings regex" },
    { id: "registry", name: "Registry", icon: "database", hint: "browse and carefully edit registry values", keywords: "regedit hkey hkcu hklm keys values environment run startup" },
    { id: "system", name: "System", icon: "tune", hint: "audit PATH and environment variables", keywords: "path environment variables missing duplicate folders diagnostics" },
    { id: "log-tail", name: "Log Tail", icon: "subject", hint: "follow the newest lines in any local log file", keywords: "tail follow log file live stream grep filter" },
    { id: "lock-inspector", name: "Lock Inspector", icon: "lock_open", hint: "find processes holding a file or folder", keywords: "locked file folder handle process delete rename restart manager" },
  ];
  const repairTools = [
    ["audio", "Audio Subsystem Bouncer", "graphic_eq", "Restarts Windows Audio and its endpoint builder.", "Restart audio"],
    ["swap", "Sound Device Switcher", "swap_calls", "Pick the default playback or recording device for Console, Multimedia, and Communications.", "Set default"],
    ["gpu", "GPU & Display Driver Reset", "monitor", "Signals the display driver reset shortcut. The screen may blank.", "Reset display"],
    ["bounds", "Window Bounds Recalibrator", "picture_in_picture", "Finds windows outside every monitor and moves the selected one into the primary viewport.", "Inspect windows"],
    ["net", "Full Network Stack Purge", "cleaning_services", "Flushes DNS, resets Winsock and ARP, then renews DHCP.", "Purge network"],
    ["radio", "Adapter & Bluetooth Power-Cycler", "wifi_tethering", "Lists network adapters and Bluetooth devices, then restarts only the selected one.", "Choose device"],
    ["usb", "USB Hub Re-enumerator", "usb", "Lists present USB devices and asks Plug and Play to restart the selected device.", "Choose USB device"],
    ["shell", "Clean Shell & Cache Purger", "desktop_windows", "Restarts Explorer and removes icon and thumbnail caches.", "Restart shell"],
    ["spooler", "Print Spooler Jam Clearer", "print", "Stops the spooler, removes queued jobs, and starts it again.", "Clear print queue"],
  ];
  for (const [id, name, glyph, detail] of repairTools) catalog.push({
    id: `repair-${id}`, name, icon: glyph, hint: detail,
    keywords: `repair reset tool tools windows ${id} audio sound display network device explorer print`, repairId: id,
  });
  let host = null;
  let active = "events";
  let timer = 0;
  let armed = "";
  let regPath = "HKCU\\Environment";
  let regRows = [];
  let regSelected = "";
  let regMode = "browse";
  let regWatch = new Map();
  let regFeed = [];
  let eventRows = [];
  let eventSelected = 0;
  let eventDetailTab = "message";
  let systemMode = "environment";
  let systemScope = "user";
  let systemReport = { paths: [], variables: [] };
  let systemSelected = "Path";

  function header(tool, body, related = "") {
    const pinned = window.devhqShell?.isToolPinned?.(tool.id) || false;
    const popped = window.devhqShell?.isToolPopped?.(tool.id) || false;
    return `<header class="tool-head"><button class="btn back tool-back" type="button" data-close-win title="Back to the overview">${icon("arrow_back")}Back</button><span class="tool-plate">${icon(tool.icon)}</span><span class="tool-title"><strong>${esc(tool.name)}</strong><small>${esc(tool.hint)}</small></span>${window.devhqMaturity?.badge(tool.id) ?? ""}${related}<button class="btn win-refresh" data-win-refresh>${icon("refresh")}Refresh</button><button class="tool-popout${popped ? " on" : ""}" data-popout-tool="${esc(tool.id)}">${icon("open_in_new")}${popped ? "Show window" : "Pop out"}</button><button class="tool-pin${pinned ? " on" : ""}" data-win-pin="${esc(tool.id)}">${icon("push_pin")}${pinned ? "Pinned" : "Pin"}</button><button class="tool-close" data-close-win title="Back to overview">${icon("close")}</button></header><div class="win-tool-body">${body}</div>`;
  }
  function status(message, tone = "") {
    const node = host?.querySelector("[data-win-status]");
    if (node) { node.textContent = message; node.dataset.tone = tone; }
  }
  function work(key, label, promise) {
    window.devhqWork?.beginWork(key, label);
    return promise.finally(() => window.devhqWork?.endWork(key));
  }
  function render() {
    if (!host) return;
    clearInterval(timer); timer = 0;
    const tool = catalog.find((x) => x.id === active) || catalog[0];
    if (active === "events") renderEvents(tool);
    if (active === "help") renderHelp(tool);
    if (active === "registry") renderRegistry(tool);
    if (active === "system") renderSystem(tool);
    if (active === "log-tail") renderLogTail(tool);
    if (active === "lock-inspector") renderLockInspector(tool);
    if (active === "repair-swap") renderAudioChooser(tool);
    else if (["repair-radio","repair-usb","repair-bounds"].includes(active)) renderTargetRepair(tool);
    else if (active.startsWith("repair-")) renderRepair(tool);
  }
  /*
  function renderHelp(tool){
    const utility=(window.devhqUtilTools?.catalog?.()||[]).map((item)=>({id:item.id,name:item.name,icon:item.icon,hint:item.hint}));
    const native=catalog.filter((item)=>item.id!=='help').map((item)=>({id:item.id,name:item.name,icon:item.icon,hint:item.hint}));
    const core=[{id:'ports',name:'Process Explorer',icon:'lan',hint:'ports, processes, resource use, and termination'},{id:'dns',name:'DNS',icon:'dns',hint:'lookups, resolver comparison, and hosts-file editing'}];
    const cards=(items)=>items.map((item)=>`<button type="button" class="help-tool" data-help-tool="${esc(item.id)}" title="Open ${esc(item.name)}">${icon(item.icon)}<span><strong>${esc(item.name)}</strong><small>${esc(item.hint)}</small></span>${icon('arrow_forward')}</button>`).join('');
    host.innerHTML=header(tool,`<div class="help-page"><section class="help-lead"><span>${icon('search')}</span><div><h2>Search is how you get anywhere</h2><p>Press <kbd>Ctrl</kbd> + <kbd>K</kbd> from any screen, or type <kbd>&gt;</kbd> while you are not editing a field. Start typing a tool, project, action, technology, port, or process.</p></div></section><div class="help-columns"><section class="help-panel"><header>${icon('manage_search')}<strong>How results work</strong></header><ul><li>An empty search only shows destinations you opened recently.</li><li>Typing searches names first, then descriptions and keywords.</li><li>Use <kbd>↑</kbd>/<kbd>↓</kbd> and <kbd>Enter</kbd>, or click a row.</li><li>The pin beside a tool keeps it in the bottom status bar.</li><li><kbd>Ctrl</kbd> + <kbd>1</kbd>…<kbd>9</kbd> opens the matching pinned tool.</li><li>Type <kbd>kill</kbd> plus a process, PID, or port to find termination commands.</li></ul></section><section class="help-panel"><header>${icon('bolt')}<strong>Commands and destinations</strong></header><div class="help-command"><code>Rescan projects</code><span>Run the project scan again · F5</span></div><div class="help-command"><code>Toggle terminal panel</code><span>Show or hide docked terminals · Ctrl+`</span></div><div class="help-command"><code>Show / Remove …</code><span>Turn project filters on and off</span></div><div class="help-command"><code>Run / Terminal / Pull …</code><span>Project actions generated from scanned repositories</span></div><div class="help-command"><code>Kill …</code><span>Terminate a matching process from search</span></div><div class="help-command"><code>Overview / Settings</code><span>Navigate without permanent tabs</span></div></section></div><section class="help-tools"><header><div>${icon('handyman')}<strong>Available tools</strong></div><small>${core.length+native.length+utility.length} tools · type any name in search</small></header><h3>Core</h3><div class="help-tool-grid">${cards(core)}</div><h3>Windows and diagnostics</h3><div class="help-tool-grid">${cards(native)}</div><h3>Encode, hash, time, and formats</h3><div class="help-tool-grid">${cards(utility)}</div></section></div>`);
  }
  */
  function renderEvents(tool) {
    host.innerHTML = header(tool, `<div class="event-toolbar"><div class="event-checks"><strong>Channels</strong>${['Application','System','Security'].map((x)=>`<label><input type="checkbox" data-event-channel value="${x}"${x!=='Security'?' checked':''}>${x}</label>`).join('')}</div><div class="event-checks"><strong>Levels</strong>${['Critical','Error','Warning','Information'].map((x)=>`<label><input type="checkbox" data-event-level value="${x}"${x!=='Information'?' checked':''}>${x==='Information'?'Info':x}</label>`).join('')}</div><label class="event-filter">${icon('filter_alt')}<input data-event-text placeholder="Regex filter provider, ID, or message"></label><button class="btn primary" data-event-stream>${icon('play_arrow')}Start</button></div><div class="event-presets"><span>Presets</span>${[['Unhandled exceptions','Unhandled exception|System\\.\\w+Exception'],['Win32 errors','0x[0-9A-Fa-f]{8}'],['Timeouts','timed out|ECONNREFUSED|Retrying'],['Access denied','Access is denied|0x80070005'],['Port collisions',':\\d{4,5}.*(?:bind|socket)']].map(([name,value])=>`<button data-event-preset="${esc(value)}">${esc(name)}</button>`).join('')}<button data-event-clear>${icon('delete_sweep')}Clear</button></div><div class="win-status event-status" data-win-status>Subscribed to Application and System · paused</div><div class="event-workspace"><section class="event-list"><header><span>Time</span><span>Level</span><span>Provider</span><span>ID</span><span>Channel</span></header><div data-event-results><div class="win-empty">Press Start to read the newest matching events.</div></div></section><aside class="event-detail" data-event-detail>${renderEventDetail()}</aside></div>`);
  }
  function renderEventDetail(){const row=eventRows[eventSelected];if(!row)return '<div class="win-empty">Select an event to inspect its message and XML.</div>';return `<header><span class="event-level ${esc((row.level||'').toLowerCase())}">${esc(row.level||'Log')}</span><div><strong>${esc(row.provider)}</strong><small>${esc(row.channel)} · Event ${esc(row.id)} · ${esc(new Date(row.time).toLocaleString())}</small></div></header><div class="event-detail-tabs"><button class="${eventDetailTab==='message'?'on':''}" data-event-detail-tab="message">Message</button><button class="${eventDetailTab==='xml'?'on':''}" data-event-detail-tab="xml">XML</button></div><pre>${esc(eventDetailTab==='xml'?(row.xml||'XML unavailable'):(row.message||'No message'))}</pre>`;}
  async function loadEvents() {
    const channels = [...host.querySelectorAll("[data-event-channel]:checked")].map((x) => x.value);
    const levels = [...host.querySelectorAll("[data-event-level]:checked")].map((x) => x.value);
    const text = host.querySelector("[data-event-text]").value.trim();
    status("Reading newest events…");
    try {
      const rows = await work("event-log", "Reading Windows Event Log", invoke("event_log_query", { query: { channels, levels, text, limit: 200 } }));
      eventRows=rows;eventSelected=Math.min(eventSelected,Math.max(0,rows.length-1));const out = host.querySelector("[data-event-results]");
      out.innerHTML = rows.length ? rows.map((row,index) => `<button class="event-row${index===eventSelected?' on':''}" data-event-row="${index}" type="button"><time>${esc(new Date(row.time).toLocaleTimeString())}</time><span class="event-level ${esc((row.level || "").toLowerCase())}">${esc(row.level || "Log")}</span><strong>${esc(row.provider)}</strong><code>${esc(row.id)}</code><small>${esc(row.channel)}</small><p>${esc((row.message||'No message').split(/\r?\n/)[0])}</p></button>`).join("") : `<div class="win-empty">No events match.</div>`;
      const detail=host.querySelector('[data-event-detail]');if(detail)detail.innerHTML=renderEventDetail();
      status(`${rows.length} matching event${rows.length === 1 ? "" : "s"}`, "ok");
    } catch (error) { status(String(error), "bad"); }
  }
  function renderHelp(tool){
    const utility=(window.devhqUtilTools?.catalog?.()||[]).map((item)=>({id:item.id,name:item.name,icon:item.icon,hint:item.hint}));
    const native=catalog.filter((item)=>item.id!=='help').map((item)=>({id:item.id,name:item.name,icon:item.icon,hint:item.hint}));
    const core=[{id:'ports',name:'Process Explorer',icon:'lan',hint:'ports, processes, resource use, and termination'},{id:'dns',name:'DNS',icon:'dns',hint:'lookups, resolver comparison, and hosts-file editing'}];
    const cards=(items)=>items.map((item)=>`<button type="button" class="help-tool" data-help-tool="${esc(item.id)}" title="Open ${esc(item.name)}">${icon(item.icon)}<span><strong>${esc(item.name)}</strong><small>${esc(item.hint)}</small></span>${icon('arrow_forward')}</button>`).join('');
    const rows=(items)=>items.map(([name,detail])=>`<div class="help-command"><code>${esc(name)}</code><span>${esc(detail)}</span></div>`).join('');
    const searchableCommands=rows([['<project>','Open that project'],['Run <project>','Run its detected start command; only offered when one is known'],['Terminal — <project>','Open a terminal in its folder'],['Pull <project>','Run git pull; only offered for Git projects'],['Rescan projects','Scan configured project folders again (F5)'],['Toggle terminal panel','Show or hide docked terminals (Ctrl+`)'],['Show / Remove <filter>','Turn a project filter on or off'],['Kill <process | PID | port>','Terminate a matching process']]);
    const projectActions=rows([['Run','Run the detected project command'],['Code / VS Code','Open the project folder in VS Code'],['Terminal','Open a terminal in the project folder'],['Pull','Run git pull for a Git project'],['Explorer','Open the folder in Windows Explorer'],['External shell','Open the configured shell outside DevHQ'],['Copy path','Copy the project folder path']]);
    host.innerHTML=header(tool,`<div class="help-page"><div class="help-columns"><section class="help-panel"><header>${icon('bolt')}<strong>Available commands</strong></header>${searchableCommands}</section><section class="help-panel"><header>${icon('folder_open')}<strong>Actions on an open project</strong></header>${projectActions}</section></div><section class="help-tools"><header><div>${icon('handyman')}<strong>Available tools</strong></div><small>${core.length+native.length+utility.length} tools</small></header><h3>Core</h3><div class="help-tool-grid">${cards(core)}</div><h3>Windows and diagnostics</h3><div class="help-tool-grid">${cards(native)}</div><h3>Encode, hash, time, and formats</h3><div class="help-tool-grid">${cards(utility)}</div></section></div>`);
  }
  function renderRegistry(tool) {
    host.innerHTML = header(tool, `<div class="registry-tabs"><button class="${regMode==='browse'?'on':''}" data-reg-mode="browse">${icon('account_tree')}Browse</button><button class="${regMode==='watch'?'on':''}" data-reg-mode="watch">${icon('visibility')}Change Watch</button></div><div class="registry-workspace"><aside class="registry-nav"><h3>Hives</h3>${[['HKCR','HKEY_CLASSES_ROOT'],['HKCU','HKEY_CURRENT_USER'],['HKLM','HKEY_LOCAL_MACHINE'],['HKU','HKEY_USERS']].map(([short,long])=>`<button data-reg-jump="${short}">${icon('database')}<span><strong>${short}</strong><small>${long}</small></span></button>`).join('')}<h3>Bookmarks</h3>${[['HKCU\\Environment','User environment'],['HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Run','Startup apps'],['HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Explorer\\Advanced','Explorer advanced'],['HKLM\\SYSTEM\\CurrentControlSet\\Control\\Session Manager\\Environment','Machine environment'],['HKLM\\SYSTEM\\CurrentControlSet\\Services','Services']].map(([path,name])=>`<button data-reg-jump="${esc(path)}">${icon('bookmark')}<span><strong>${esc(name)}</strong><small>${esc(path)}</small></span></button>`).join('')}</aside><section class="registry-main">${regMode==='browse'?`<div class="registry-path"><button data-reg-up title="Parent key">${icon('arrow_upward')}</button><input data-reg-path value="${esc(regPath)}" spellcheck="false"><button class="btn primary" data-reg-go>${icon('arrow_forward')}Go</button></div><div class="win-status" data-win-status>Read-only until you explicitly save or delete a value.</div><div class="registry-results" data-reg-results><div class="win-empty">Reading key…</div></div>`:`<div class="registry-watch-head"><div><strong>Watching ${esc(regPath)}</strong><small>Polling the selected key for creates, edits and deletes</small></div><button class="btn primary" data-reg-watch>${icon(timer?'pause':'play_arrow')}${timer?'Pause':'Start watch'}</button></div><div class="win-status" data-win-status>${timer?'Watching for registry changes…':'Watch is paused.'}</div><div class="registry-feed" data-reg-feed>${renderRegistryFeed()}</div>`}</section><aside class="registry-detail" data-reg-detail><div class="win-empty">Select a value to inspect and edit it.</div></aside></div>`);
    if(regMode==='browse') loadRegistry();
  }
  function renderRegistryFeed(){return regFeed.length?regFeed.map((x)=>`<div class="registry-feed-row"><time>${esc(x.time)}</time>${icon(x.op==='deleted'?'delete':x.op==='created'?'add_circle':'edit')}<strong>${esc(x.op)}</strong><span class="mono">${esc(x.name)}</span><small>${esc(x.value)}</small></div>`).join(''):'<div class="win-empty">No changes observed yet.</div>';}
  async function loadRegistry() {
    const input=host.querySelector("[data-reg-path]");const path=(input?.value||regPath).trim();regPath=path; status(`Reading ${path}…`);
    try {
      const rows = await work("registry", `Reading ${path}`, invoke("registry_list", { path }));
      regRows=rows;const keys=rows.filter((r)=>r.isKey),values=rows.filter((r)=>!r.isKey);host.querySelector("[data-reg-results]").innerHTML = rows.length ? `${keys.length?`<div class="registry-key-grid">${keys.map((r)=>`<button data-reg-key="${esc(r.name)}">${icon('folder')}<span>${esc(r.name)}</span>${icon('chevron_right')}</button>`).join('')}</div>`:''}<table class="win-table registry-values"><thead><tr><th>Name</th><th>Type</th><th>Data</th></tr></thead><tbody>${values.map((r)=>`<tr class="${regSelected===r.name?'on':''}" data-reg-value="${esc(r.name)}"><td>${icon('draft')} ${esc(r.name)}</td><td>${esc(r.kind)}</td><td class="mono">${esc(r.value)}</td></tr>`).join('')}</tbody></table>` : `<div class="win-empty">This key has no children or values.</div>`;
      renderRegistryDetail();
      status(`${rows.length} item${rows.length === 1 ? "" : "s"}`, "ok");
    } catch (error) { status(String(error), "bad"); }
  }
  function renderRegistryDetail(){const pane=host.querySelector('[data-reg-detail]');if(!pane)return;const row=regRows.find((r)=>!r.isKey&&r.name===regSelected);pane.innerHTML=row?`<header>${icon('draft')}<div><strong>${esc(row.name)}</strong><small>${esc(regPath)}</small></div></header><label>Type<select data-reg-kind>${['String','ExpandString','DWord','QWord','MultiString','Binary'].map((k)=>`<option${row.kind===k?' selected':''}>${k}</option>`).join('')}</select></label><label>Value data<textarea data-reg-data class="mono" spellcheck="false">${esc(row.value)}</textarea></label><div class="registry-detail-actions"><button class="btn primary" data-reg-save>${icon('save')}Save value</button><button class="btn${armed===`reg:${row.name}`?' danger':''}" data-reg-delete="${esc(row.name)}">${icon('delete')}${armed===`reg:${row.name}`?'Confirm delete':'Delete'}</button></div><p>Changes are written directly to Windows. Machine keys may require administrator rights.</p>`:'<div class="win-empty">Select a value to inspect and edit it.</div>';}
  async function pollRegistry(){try{const rows=await invoke('registry_list',{path:regPath});const next=new Map(rows.filter((r)=>!r.isKey).map((r)=>[r.name,`${r.kind}\0${r.value}`]));if(regWatch.size){for(const [name,value] of next){if(!regWatch.has(name))regFeed.unshift({time:new Date().toLocaleTimeString(),op:'created',name,value:value.split('\0')[1]});else if(regWatch.get(name)!==value)regFeed.unshift({time:new Date().toLocaleTimeString(),op:'changed',name,value:value.split('\0')[1]});}for(const name of regWatch.keys())if(!next.has(name))regFeed.unshift({time:new Date().toLocaleTimeString(),op:'deleted',name,value:''});regFeed=regFeed.slice(0,200);}regWatch=next;const feed=host.querySelector('[data-reg-feed]');if(feed)feed.innerHTML=renderRegistryFeed();}catch(error){status(String(error),'bad');}}
  async function changeRegistry(change) {
    const result = await work("registry-write", change.delete ? "Deleting registry value" : "Saving registry value", invoke("registry_change", { change }));
    if (!result.ok) return status(result.error || "Registry change failed.", "bad");
    armed = ""; await loadRegistry();
  }
  function renderSystem(tool) {
    const tabs=`<div class="system-tabs">${[['environment','route','Environment'],['locks','lock_person','Lock Inspector'],['logs','description','Log Tail']].map(([id,glyph,name])=>`<button class="${systemMode===id?'on':''}" data-system-mode="${id}">${icon(glyph)}${name}</button>`).join('')}</div>`;
    if(systemMode==='locks'){host.innerHTML=header(tool,`${tabs}<div class="system-subtool"><div class="win-controls"><label class="grow">File or folder<input data-lock-path spellcheck="false" placeholder="Drop or paste a path"></label><button class="btn primary" data-lock-go>${icon('search')}Inspect locks</button></div><div class="win-status" data-win-status>Restart Manager will ask Windows which processes hold this path.</div><div data-lock-results></div></div>`);return;}
    if(systemMode==='logs'){host.innerHTML=header(tool,`${tabs}<div class="system-subtool"><div class="win-controls"><label class="grow">Log file<input data-log-path spellcheck="false" placeholder="C:\\logs\\app.log"></label><label>Lines<input data-log-lines type="number" min="10" max="2000" value="300"></label><label class="grow">Filter<input data-log-filter placeholder="text or regular expression"></label><button class="btn primary" data-log-start>${icon('play_arrow')}Follow</button></div><div class="win-status" data-win-status>Choose a local text log to follow.</div><pre class="log-tail-output" data-log-output></pre></div>`);return;}
    host.innerHTML = header(tool, `${tabs}<div class="system-env" data-system-results><div class="win-empty">Reading user and machine environment…</div></div>`);
    loadSystem();
  }
  async function loadSystem() {
    status("Scanning user and machine environment…");
    try {
      const report = await work("system-report", "Auditing PATH and environment", invoke("system_report"));
      systemReport=report;renderSystemEnvironment();const bad = report.paths.filter((x) => x.status !== "ok").length;
      status(`${report.paths.length} PATH entries scanned`, bad ? "warn" : "ok");
    } catch (error) { status(String(error), "bad"); }
  }
  /* Legacy draft kept out of execution while the structured renderer below is used.
  function renderSystemEnvironment(){const root=host.querySelector('[data-system-results]');if(!root)return;const paths=systemReport.paths.filter((p)=>p.scope===systemScope),vars=systemReport.variables.filter((v)=>v.scope===systemScope),issues=paths.filter((p)=>p.status!=='ok');const selected=systemSelected==='Path'?{name:'Path',value:paths.map((p)=>p.value).join(';')}:(vars.find((v)=>v.name===systemSelected)||vars[0]);root.innerHTML=`<aside class="system-vars"><div class="system-scopes"><button class="${systemScope==='user'?'on':''}" data-system-scope="user">${icon('person')}User</button><button class="${systemScope==='machine'?'on':''}" data-system-scope="machine">${icon('computer')}Machine</button></div><button class="system-var ${systemSelected==='Path'?'on':''}" data-system-var="Path">${icon('route')}<span><strong>Path</strong><small>${paths.length} entries · ${issues.length} findings</small></span></button>${vars.map((v)=>`<button class="system-var ${systemSelected===v.name?'on':''}" data-system-var="${esc(v.name)}">${icon('data_object')}<span><strong>${esc(v.name)}</strong><small>${esc(v.value)}</small></span></button>`).join('')}<footer>${vars.length+1} variables in ${systemScope} scope</footer></aside><section class="system-path-panel"><header>${icon('route')}<strong>${systemScope==='user'?'User':'Machine'} PATH</strong><span>${paths.length} entries</span><i></i>${['missing','duplicate','unresolved'].map((kind)=>`<em class="path-${kind}">${paths.filter((p)=>p.status===kind).length} ${kind}</em>`).join('')}</header><div class="system-path-rows">${paths.map((p,index)=>`<div class="system-path-row path-${esc(p.status)}"><code>${index+1}</code>${icon(p.status==='ok'?'check_circle':p.status==='missing'?'folder_off':p.status==='duplicate'?'filter_none':'help')}<span><strong class="mono">${esc(p.value)}</strong>${p.detail?`<small>${icon('subdirectory_arrow_right')}${esc(p.detail)}</small>`:''}</span><em>${esc(p.status)}</em></div>`).join('')}</div></section><aside class="system-findings"><section><header>${icon('data_object')}<strong>${esc(selected?.name||'Variable')}</strong><small>${esc(systemScope)}</small></header><p class="mono">${esc(selected?.value||'')}</p></section><section class="findings"><header>${icon('rule')}<strong>Findings</strong><small>${issues.length}</small></header>${issues.length?issues.map((p)=>`<div>${icon(p.status==='missing'?'folder_off':p.status==='duplicate'?'filter_none':'help')}<span><strong>${esc(p.status)}</strong><small class="mono">${esc(p.value)} · ${esc(p.detail)}</small></span></div>`).join(''):'<div class="system-clean">${icon('check_circle')}No PATH findings in this scope.</div>'}</section></aside>`;}
  */
  function renderSystemEnvironment(){
    const root=host.querySelector('[data-system-results]');if(!root)return;
    const paths=systemReport.paths.filter((p)=>p.scope===systemScope);
    const vars=systemReport.variables.filter((v)=>v.scope===systemScope);
    const issues=paths.filter((p)=>p.status!=='ok');
    const selected=systemSelected==='Path'?{name:'Path',value:paths.map((p)=>p.value).join(';')}:(vars.find((v)=>v.name===systemSelected)||vars[0]||{name:'Variable',value:''});
    const varRows=vars.map((v)=>`<button class="system-var ${systemSelected===v.name?'on':''}" data-system-var="${esc(v.name)}">${icon('data_object')}<span><strong>${esc(v.name)}</strong><small>${esc(v.value)}</small></span></button>`).join('');
    const pathRows=paths.map((p,index)=>{const glyph=p.status==='ok'?'check_circle':p.status==='missing'?'folder_off':p.status==='duplicate'?'filter_none':'help';const note=p.detail?`<small>${icon('subdirectory_arrow_right')}${esc(p.detail)}</small>`:'';return `<div class="system-path-row path-${esc(p.status)}"><code>${index+1}</code>${icon(glyph)}<span><strong class="mono">${esc(p.value)}</strong>${note}</span><em>${esc(p.status)}</em></div>`;}).join('');
    const findingRows=issues.length?issues.map((p)=>{const glyph=p.status==='missing'?'folder_off':p.status==='duplicate'?'filter_none':'help';return `<div>${icon(glyph)}<span><strong>${esc(p.status)}</strong><small class="mono">${esc(p.value)} · ${esc(p.detail)}</small></span></div>`;}).join(''):`<div class="system-clean">${icon('check_circle')}No PATH findings in this scope.</div>`;
    root.innerHTML=`<aside class="system-vars"><div class="system-scopes"><button class="${systemScope==='user'?'on':''}" data-system-scope="user">${icon('person')}User</button><button class="${systemScope==='machine'?'on':''}" data-system-scope="machine">${icon('computer')}Machine</button></div><button class="system-var ${systemSelected==='Path'?'on':''}" data-system-var="Path">${icon('route')}<span><strong>Path</strong><small>${paths.length} entries · ${issues.length} findings</small></span></button>${varRows}<footer>${vars.length+1} variables in ${systemScope} scope</footer></aside><section class="system-path-panel"><header>${icon('route')}<strong>${systemScope==='user'?'User':'Machine'} PATH</strong><span>${paths.length} entries</span><i></i></header><div class="system-path-rows">${pathRows}</div></section><aside class="system-findings"><section><header>${icon('data_object')}<strong>${esc(selected.name)}</strong><small>${esc(systemScope)}</small></header><p class="mono">${esc(selected.value)}</p></section><section class="findings"><header>${icon('rule')}<strong>Findings</strong><small>${issues.length}</small></header>${findingRows}</section></aside>`;
  }
  function renderRepair(tool) {
    const row = repairTools.find((item) => `repair-${item[0]}` === active);
    if (!row) return;
    const [id, , glyph, detail, action] = row;
    const related=id==='audio'?`<button class="btn" data-related-tool="repair-swap">${icon('swap_calls')}Sound Device Switcher</button>`:'';
    host.innerHTML = header(tool, `<div class="repair-intro"><span>${icon(glyph)}</span><div><p>${esc(detail)}</p></div><code>${esc(id==='audio'?'Restart-Service':id==='gpu'?'D3DKMT / keybd_event':id==='net'?'4 ordered steps':id==='shell'?'Explorer + caches':'Spooler + queue')}</code></div><div class="win-status" data-win-status>Inspecting current state…</div><div class="repair-designed" data-repair-state><div class="win-empty">Reading services and devices…</div></div><footer class="repair-action-bar"><span>${id==='gpu'?'The screen may blank for about a second.':id==='net'?'Winsock reset may require a reboot.':id==='shell'?'The taskbar and Explorer windows briefly close.':id==='spooler'?'Every queued print job will be removed.':'Dependent audio services briefly stop.'}</span><button class="btn${armed === id ? " danger" : " primary"}" data-repair="${id}">${icon(armed === id ? "warning" : "play_arrow")}${esc(armed === id ? "Click again to confirm" : action)}</button></footer>`,related);
    loadRepairOverview(id);
  }
  async function loadRepairOverview(id){try{const rows=await invoke('repair_targets',{id});const target=host.querySelector('[data-repair-state]');if(!target)return;target.innerHTML=rows.length?rows.map((row,index)=>`<div class="repair-state-row"><code>${id==='net'?index+1:''}</code>${icon(id==='net'?'check_circle':id==='shell'&&row.id!=='explorer'?'database':id==='spooler'&&row.id!=='service'?'description':id==='gpu'?'monitor':'settings_applications')}<span><strong>${esc(row.name)}</strong><small class="mono">${esc(row.detail)}</small></span><em class="state-pill">${esc(row.status)}</em></div>`).join(''):'<div class="win-empty">No matching services or devices were found.</div>';status(`${rows.length} item${rows.length===1?'':'s'} inspected`,'ok');}catch(error){status(String(error),'bad');}}
  function renderAudioChooser(tool) {
    const related=`<button class="btn" data-related-tool="repair-audio">${icon('graphic_eq')}Audio Subsystem Bouncer</button>`;
    host.innerHTML=header(tool,`<div class="win-status" data-win-status>Reading active playback and recording endpoints…</div><div class="audio-groups" data-audio-groups><div class="win-empty">Reading Windows Core Audio…</div></div>`,related);
    loadAudioDevices();
  }
  async function loadAudioDevices(){
    try{const rows=await work("audio-devices","Reading audio devices",invoke("audio_devices"));const groups=[['playback','Playback','volume_up'],['recording','Recording','mic']];
      host.querySelector("[data-audio-groups]").innerHTML=groups.map(([flow,label,glyph])=>`<section class="audio-group"><header>${icon(glyph)}<strong>${label}</strong><small>Console · Multimedia · Communications</small></header>${rows.filter((r)=>r.flow===flow).map((r)=>`<button class="audio-device${r.isDefault?' on':''}" data-audio-device="${esc(r.id)}"><span>${icon(r.isDefault?'check_circle':'radio_button_unchecked')}<strong>${esc(r.name)}</strong></span><small>${r.isDefault?'Default for multimedia':'Set as default for all roles'}</small></button>`).join('')||'<div class="win-empty">No active devices.</div>'}</section>`).join('');status(`${rows.length} active audio device${rows.length===1?'':'s'}`,"ok");
    }catch(error){status(String(error),"bad");}}
  async function setAudioDevice(id){status("Setting Console, Multimedia, and Communications roles…");const result=await work("audio-default","Changing the default audio device",invoke("audio_set_default",{id}));if(!result.ok)return status(result.error||"Could not change the endpoint.","bad");await loadAudioDevices();status(result.output||"Default endpoint changed.","ok");}
  function renderTargetRepair(tool){host.innerHTML=header(tool,`<div class="win-status" data-win-status>Inspecting this machine…</div><div class="target-list" data-target-list><div class="win-empty">Reading available targets…</div></div>`);loadRepairTargets();}
  async function loadRepairTargets(){const id=active.replace("repair-","");try{const rows=await work(`repair-targets-${id}`,"Reading repair targets",invoke("repair_targets",{id}));host.querySelector("[data-target-list]").innerHTML=rows.length?rows.map((r)=>`<button class="target-row${armed===r.id?' armed':''}" data-target-id="${esc(r.id)}"><span>${icon(armed===r.id?'warning':'radio_button_unchecked')}<strong>${esc(r.name)}</strong><small>${esc(r.detail)}</small></span><em>${esc(armed===r.id?'Click again to confirm':r.status)}</em></button>`).join(''):`<div class="win-empty">${id==='bounds'?'Every visible window is already on-screen.':'No matching active devices were found.'}</div>`;status(`${rows.length} target${rows.length===1?'':'s'} found`,rows.length?'ok':'');}catch(error){status(String(error),'bad');}}
  async function runTargetRepair(target){const id=active.replace('repair-','');if(armed!==target){armed=target;await loadRepairTargets();return status('Review the selected item, then click it again to confirm.','warn');}const result=await work(`repair-target-${id}`,`Running ${id} repair`,invoke('repair_target_run',{id,target}));armed='';if(!result.ok)return status(result.error||'Repair failed.','bad');await loadRepairTargets();status(result.output||'Completed.','ok');}
  async function runRepair(id) {
    if (armed !== id) { armed = id; renderRepair(catalog.find((x) => x.id === active)); status("Review the impact, then click the same action again.", "warn"); return; }
    status("Running repair…");
    const result = await work(`repair-${id}`, `Running ${repairTools.find((x) => x[0] === id)?.[1] || "repair"}`, invoke("repair_run", { id }));
    armed = ""; renderRepair(catalog.find((x) => x.id === active));
    status(result.ok ? (result.output || "Repair completed.") : (result.error || "Repair failed."), result.ok ? "ok" : "bad");
  }
  function renderLogTail(tool) {
    host.innerHTML = header(tool, `<div class="win-controls"><label class="grow">Log file<input data-log-path spellcheck="false" placeholder="C:\\logs\\app.log"></label><label>Lines<input data-log-lines type="number" min="10" max="2000" value="300"></label><label class="grow">Filter<input data-log-filter placeholder="text or regular expression"></label><button class="btn primary" data-log-start>${icon("play_arrow")} Start</button></div><div class="win-status" data-win-status>Choose a local text log to follow.</div><pre class="log-tail-output" data-log-output></pre>`);
  }
  async function loadLogTail() {
    const path=host.querySelector("[data-log-path]").value.trim(); if(!path)return status("Enter a log file path.","warn");
    const lines=Number(host.querySelector("[data-log-lines]").value)||300; const filter=host.querySelector("[data-log-filter]").value;
    try { const result=await work("log-tail",`Reading ${path}`,invoke("log_tail",{path,lines})); let rows=result.lines;
      if(filter){try{const re=new RegExp(filter,"i");rows=rows.filter((line)=>re.test(line));}catch{rows=rows.filter((line)=>line.toLowerCase().includes(filter.toLowerCase()));}}
      host.querySelector("[data-log-output]").textContent=rows.join("\n"); host.querySelector("[data-log-output]").scrollTop=host.querySelector("[data-log-output]").scrollHeight;
      status(`${rows.length} lines shown · ${(result.size/1024).toFixed(1)} KB`,"ok");
    } catch(error){status(String(error),"bad");}
  }
  function renderLockInspector(tool) {
    host.innerHTML=header(tool,`<div class="win-controls"><label class="grow">File or folder<input data-lock-path spellcheck="false" placeholder="C:\\code\\project\\target"></label><button class="btn primary" data-lock-go>${icon("search")} Inspect</button></div><div class="win-status" data-win-status>Restart Manager will ask Windows which processes hold this path.</div><div data-lock-results></div>`);
  }
  async function inspectLocks(){const path=host.querySelector("[data-lock-path]").value.trim();if(!path)return status("Enter a file or folder path.","warn");status("Asking Restart Manager…");
    try{const rows=await work("lock-inspect",`Inspecting locks on ${path}`,invoke("lock_inspect",{path}));host.querySelector("[data-lock-results]").innerHTML=rows.length?`<table class="win-table"><thead><tr><th>Process</th><th>PID</th><th>Service</th><th>Restartable</th></tr></thead><tbody>${rows.map((r)=>`<tr><td>${esc(r.name||"Unknown")}</td><td class="mono">${esc(r.pid)}</td><td>${esc(r.service||"—")}</td><td>${r.restartable?"yes":"no"}</td></tr>`).join("")}</tbody></table>`:`<div class="win-empty">Windows reports no process holding this path.</div>`;status(`${rows.length} locking process${rows.length===1?"":"es"}`,rows.length?"warn":"ok");}catch(error){status(String(error),"bad");}}
  function click(event) {
    const helpTool=event.target.closest('[data-help-tool]');if(helpTool){window.dispatchEvent(new CustomEvent('devhq:open-tool',{detail:{id:helpTool.dataset.helpTool}}));return;}
    if (event.target.closest("[data-close-win]")) return window.devhqShell?.openTool("overview");
    const pop = event.target.closest("[data-popout-tool]");
    if (pop) return window.devhqShell?.popOutTool?.(pop.dataset.popoutTool);
    const pin = event.target.closest("[data-win-pin]");
    if (pin) { window.devhqShell?.toggleToolPin(pin.dataset.winPin); return render(); }
    const related=event.target.closest("[data-related-tool]");if(related){active=related.dataset.relatedTool;armed="";return render();}
    if (event.target.closest("[data-win-refresh]")) return active === "events" ? loadEvents() : active === "registry" ? (regMode === "watch" ? pollRegistry() : loadRegistry()) : active === "system" ? (systemMode === "environment" ? loadSystem() : systemMode === "locks" ? inspectLocks() : loadLogTail()) : active === "log-tail" ? loadLogTail() : active === "lock-inspector" ? inspectLocks() : render();
    if (event.target.closest("[data-event-stream]")) { const button=event.target.closest("[data-event-stream]"); if(timer){clearInterval(timer);timer=0;button.innerHTML=`${icon("play_arrow")} Start`;status("Stream paused.");}else{loadEvents();timer=setInterval(loadEvents,3000);button.innerHTML=`${icon("pause")} Pause`;} return; }
    const preset=event.target.closest('[data-event-preset]');if(preset){host.querySelector('[data-event-text]').value=preset.dataset.eventPreset;return loadEvents();}
    if(event.target.closest('[data-event-clear]')){eventRows=[];eventSelected=0;host.querySelector('[data-event-results]').innerHTML='<div class="win-empty">The captured events were cleared.</div>';host.querySelector('[data-event-detail]').innerHTML=renderEventDetail();return status('Captured events cleared.');}
    const eventRow=event.target.closest('[data-event-row]');if(eventRow){eventSelected=Number(eventRow.dataset.eventRow);for(const row of host.querySelectorAll('[data-event-row]'))row.classList.toggle('on',row===eventRow);host.querySelector('[data-event-detail]').innerHTML=renderEventDetail();return;}
    const detailTab=event.target.closest('[data-event-detail-tab]');if(detailTab){eventDetailTab=detailTab.dataset.eventDetailTab;host.querySelector('[data-event-detail]').innerHTML=renderEventDetail();return;}
    if (event.target.closest("[data-reg-go]")) return loadRegistry();
    const mode=event.target.closest('[data-reg-mode]');if(mode){clearInterval(timer);timer=0;regMode=mode.dataset.regMode;return renderRegistry(catalog.find((x)=>x.id==='registry'));}
    const jump=event.target.closest('[data-reg-jump]');if(jump){regPath=jump.dataset.regJump;regMode='browse';return renderRegistry(catalog.find((x)=>x.id==='registry'));}
    if(event.target.closest('[data-reg-up]')){const cut=regPath.lastIndexOf('\\');if(cut>0)regPath=regPath.slice(0,cut);return renderRegistry(catalog.find((x)=>x.id==='registry'));}
    const valueRow=event.target.closest('[data-reg-value]');if(valueRow){regSelected=valueRow.dataset.regValue;for(const row of host.querySelectorAll('[data-reg-value]'))row.classList.toggle('on',row===valueRow);return renderRegistryDetail();}
    if(event.target.closest('[data-reg-save]')){const row=regRows.find((r)=>r.name===regSelected);if(!row)return;return changeRegistry({path:regPath,name:row.name,kind:host.querySelector('[data-reg-kind]').value,value:host.querySelector('[data-reg-data]').value,delete:false});}
    if(event.target.closest('[data-reg-watch]')){const button=event.target.closest('[data-reg-watch]');if(timer){clearInterval(timer);timer=0;button.innerHTML=`${icon('play_arrow')}Start watch`;return status('Watch paused.');}regWatch.clear();pollRegistry();timer=setInterval(pollRegistry,2000);button.innerHTML=`${icon('pause')}Pause`;return status(`Watching ${regPath}…`,'ok');}
    if(event.target.closest("[data-log-start]")){const button=event.target.closest("[data-log-start]");if(timer){clearInterval(timer);timer=0;button.innerHTML=`${icon("play_arrow")} Start`;return status("Tail paused.");}loadLogTail();timer=setInterval(loadLogTail,1500);button.innerHTML=`${icon("pause")} Pause`;return;}
    if(event.target.closest("[data-lock-go]"))return inspectLocks();
    const systemTab=event.target.closest('[data-system-mode]');if(systemTab){clearInterval(timer);timer=0;systemMode=systemTab.dataset.systemMode;return renderSystem(catalog.find((x)=>x.id==='system'));}
    const scopeButton=event.target.closest('[data-system-scope]');if(scopeButton){systemScope=scopeButton.dataset.systemScope;systemSelected='Path';return renderSystemEnvironment();}
    const variable=event.target.closest('[data-system-var]');if(variable){systemSelected=variable.dataset.systemVar;return renderSystemEnvironment();}
    const key=event.target.closest("[data-reg-key]"); if(key){regPath += `\\${key.dataset.regKey}`;regSelected='';return renderRegistry(catalog.find((x)=>x.id==='registry')); }
    const del=event.target.closest("[data-reg-delete]"); if(del){const key=`reg:${del.dataset.regDelete}`;if(armed!==key){armed=key;renderRegistryDetail();status(`Click delete again to confirm ${del.dataset.regDelete}.`,"warn");return;}return changeRegistry({path:regPath,name:del.dataset.regDelete,kind:"REG_SZ",value:"",delete:true});}
    const repair=event.target.closest("[data-repair]"); if(repair)return runRepair(repair.dataset.repair);
    const audio=event.target.closest("[data-audio-device]");if(audio)return setAudioDevice(audio.dataset.audioDevice);
    const target=event.target.closest("[data-target-id]");if(target)return runTargetRepair(target.dataset.targetId);
  }
  window.devhqWindowsTools = {
    catalog: () => catalog.map((x) => ({ ...x })),
    mount(node) { host = node; host.onclick = click; host.onkeydown = (e) => { if (e.key !== "Enter") return; if(e.target.matches("[data-event-text]"))loadEvents();else if(e.target.matches("[data-reg-path]"))loadRegistry();else if(e.target.matches("[data-log-path],[data-log-filter]"))loadLogTail();else if(e.target.matches("[data-lock-path]"))inspectLocks(); }; render(); },
    open(id) { if (!catalog.some((x) => x.id === id)) return; active = id; render(); },
    opened() { if (active === "events" && timer) loadEvents(); },
    active: () => active,
  };
})();
