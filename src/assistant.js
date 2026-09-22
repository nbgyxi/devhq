(() => {
  const invoke = window.__TAURI__.core.invoke;
  const listen = window.__TAURI__.event.listen;
  const STORE = "wint.assistant.v1";
  const isPopout = new URLSearchParams(location.search).get("popout") === "1";
  const syncSource = crypto.randomUUID();
  let mounted = false, stateSynced = !isPopout;
  const data = load();
  if (data.pinned !== true) { data.pinned = true; save(); }
  data.toolCallCap = clampToolCallCap(data.toolCallCap);
  let host, button, open = false, status = null, cloud = null, registry = null, loading = false, running = "", runningAgent = null, pull = null, forceScroll = false, chatScrollTop = 0, chatFollowBottom = true;
  const AGENT_COMMANDS = {
    claude: { send: "claude_send", cancel: "claude_cancel" },
    codex: { send: "codex_send", cancel: "codex_cancel" },
    gemini: { send: "gemini_send", cancel: "gemini_cancel" },
    copilot: { send: "copilot_send", cancel: "copilot_cancel" },
    cursor: { send: "cursor_send", cancel: "cursor_cancel" },
  };

  function load() {
    try { return { chats: [], active: "", model: "", pinned: false, open: false, think: false, toolCallCap: 20, ...JSON.parse(localStorage.getItem(STORE) || "{}") }; }
    catch { return { chats: [], active: "", model: "", pinned: false, open: false, think: false, toolCallCap: 20 }; }
  }
  function clampToolCallCap(value) { return Math.min(100, Math.max(1, Number.parseInt(value, 10) || 20)); }
  function setToolCallCap(value) {
    data.toolCallCap = clampToolCallCap(value); save();
    window.dispatchEvent(new CustomEvent("wint:assistant-tool-cap-changed", { detail: { value: data.toolCallCap } }));
    const input = host?.querySelector("[data-ai-tool-cap]"); if (input) input.value = data.toolCallCap;
    return data.toolCallCap;
  }
  function save() {
    localStorage.setItem(STORE, JSON.stringify(data));
    if (mounted && stateSynced) window.__TAURI__.event.emit("assistant:state-sync", { source: syncSource, data }).catch(() => {});
  }
  function esc(value = "") { const d = document.createElement("div"); d.textContent = value; return d.innerHTML; }
  function inlineMarkdown(value) {
    return esc(value).replace(/`([^`]+)`/g, "<code>$1</code>")
      .replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>")
      .replace(/\*([^*]+)\*/g, "<em>$1</em>");
  }
  function markdown(value = "") {
    const parts = value.split(/```/); let language = "";
    return parts.map((part, index) => {
      if (index % 2) { const lines = part.replace(/^\r?\n/, "").split(/\r?\n/); language = (lines.shift() || "").trim(); return `<pre><header>${esc(language || "code")}<button data-copy-code title="Copy code"><span class="ms">content_copy</span></button></header><code>${esc(lines.join("\n"))}</code></pre>`; }
      const lines = part.split(/\r?\n/); let list = "", html = [];
      const closeList = () => { if (list) { html.push(`</${list}>`); list = ""; } };
      const cells = (line) => line.trim().replace(/^\||\|$/g, "").split("|").map(cell => cell.trim());
      for (let lineIndex = 0; lineIndex < lines.length; lineIndex++) {
        const line = lines[lineIndex];
        const next = lines[lineIndex + 1] || "";
        if (line.includes("|") && /^\s*\|?\s*:?-{3,}/.test(next) && cells(next).every(cell => /^:?-{3,}:?$/.test(cell))) {
          closeList(); const headers = cells(line); const rows = []; lineIndex += 2;
          while (lineIndex < lines.length && lines[lineIndex].includes("|") && lines[lineIndex].trim()) { rows.push(cells(lines[lineIndex])); lineIndex++; }
          lineIndex--;
          html.push(`<div class="assistant-table-wrap"><table><thead><tr>${headers.map(cell => `<th>${inlineMarkdown(cell)}</th>`).join("")}</tr></thead><tbody>${rows.map(row => `<tr>${headers.map((_, i) => `<td>${inlineMarkdown(row[i] || "")}</td>`).join("")}</tr>`).join("")}</tbody></table></div>`);
          continue;
        }
        const heading = line.match(/^(#{1,3})\s+(.+)/); const bullet = line.match(/^\s*[-*]\s+(.+)/); const numbered = line.match(/^\s*\d+[.)]\s+(.+)/);
        if (heading) { closeList(); const level = heading[1].length + 2; html.push(`<h${level}>${inlineMarkdown(heading[2])}</h${level}>`); }
        else if (bullet || numbered) { const wanted = bullet ? "ul" : "ol"; if (list !== wanted) { closeList(); list = wanted; html.push(`<${list}>`); } html.push(`<li>${inlineMarkdown((bullet || numbered)[1])}</li>`); }
        else if (!line.trim()) { closeList(); }
        else { closeList(); html.push(`<p>${inlineMarkdown(line)}</p>`); }
      }
      closeList(); return html.join("");
    }).join("");
  }
  function chat() { return data.chats.find((item) => item.id === data.active); }
  function newChat() {
    const item = { id: crypto.randomUUID(), title: "New chat", model: data.model, created: Date.now(), messages: [] };
    data.chats.unshift(item); data.active = item.id; save(); render(); requestAnimationFrame(() => host.querySelector("textarea")?.focus());
  }
  function toggle(value = !open, refreshModels = true) {
    if (isPopout && !value) { window.__TAURI__.window.getCurrentWindow().close(); return; }
    open = value; data.open = open; save(); host.hidden = !open; button.classList.toggle("on", open); button.setAttribute("aria-pressed", String(open));
    document.documentElement.classList.toggle("assistant-open", open);
    document.documentElement.classList.toggle("assistant-pinned", open);
    setTimeout(() => window.wintTerminalSettings?.fitVisible?.(), 180);
    if (open && !chat()) newChat();
    if (open && refreshModels) refresh();
  }
  async function refresh() {
    loading = true; render();
    try { [status, cloud, registry] = await Promise.all([invoke("assistant_status"), invoke("assistant_cloud_status"), invoke("ai_models")]); }
    catch (error) { status = { available: false, models: [], error: String(error) }; }
    loading = false;
    // Settings owns the choice now, and it is kept by the backend so every
    // window agrees on it. This panel only falls back to its own when the
    // shared one names something this panel cannot run.
    if (!selectableModels().some((m) => m.name === data.model)) data.model = "";
    if (!data.model && registry?.selected && selectableModels().some((m) => m.name === registry.selected)) data.model = registry.selected;
    if (!data.model && localModels().length) data.model = localModels()[0].name;
    save(); render();
  }
  function installed(name) { return status?.models?.some((model) => model.name === name); }

  /** The API-key models, from the shared registry rather than a list of its
   *  own - so a key added in Settings shows up here without this file
   *  knowing which models that key unlocks. */
  function cloudModels() {
    return (registry?.models || [])
      .filter((m) => m.kind === "api" && m.ready && m.enabled !== false)
      .map((m) => ({ name: m.id, displayName: m.label, size: m.detail }));
  }
  function agentModels() {
    return (registry?.models || [])
      .filter((m) => m.kind === "agent" && m.ready && m.enabled !== false)
      .map((m) => ({ name: m.id, displayName: m.label, size: m.detail }));
  }
  function localModels() {
    const enabled = new Set((registry?.models || []).filter((m) => m.kind === "local" && m.ready && m.enabled !== false).map((m) => m.id));
    return (status?.models || []).filter((m) => enabled.has(m.name));
  }
  function selectableModels() { return [...agentModels(), ...localModels(), ...cloudModels()]; }
  const agentKind = (model) => model?.startsWith("agent:") ? model.slice(6) : "";
  const modelKind = (model) => agentKind(model) ? "agent" : model?.includes(":") ? "api" : "local";
  function humanSize(bytes) { return bytes >= 1e9 ? `${(bytes / 1e9).toFixed(1)} GB` : `${Math.round(bytes / 1e6)} MB`; }
  // Megabytes, grouped. A paused download is quoted in the same unit the live
  // readout uses, so the two can be compared at a glance.
  function megabytes(bytes) { return `${Math.round(bytes / 1e6).toLocaleString()} MB`; }
  async function send(text) {
    const current = chat();
    text = text.trim();
    if (!current || !text || running) return;
    const model = current.model || data.model;
    if (!model) { render("Choose or download a model before chatting."); return; }
    if (!selectableModels().some((entry) => entry.name === model)) { render("That model is unavailable or switched off. Choose another model."); return; }
    const kind = modelKind(model);
    if (agentKind(model) === "gemini" && !data.antigravityInteractiveStarted) {
      data.antigravityInteractiveStarted = true;
      save();
      await openAntigravitySignin();
      return;
    }
    current.title = current.messages.length ? current.title : text.slice(0, 54);
    current.model = model;
    current.messages.push({ role: "user", text }, { role: "activity", text: "", steps: [] }, { role: "assistant", text: "" });
    running = crypto.randomUUID(); forceScroll = true; save(); render();
    const history = current.messages.filter((m) => ["user", "assistant", "question"].includes(m.role)).slice(0, -1).map((m) => `${m.role === "user" ? "User" : "Assistant"}: ${m.text}${m.role === "question" ? ` Choices: ${(m.choices || []).join(" | ")}` : ""}`).join("\n\n");
    const projectContext = window.wintAssistantContext?.() || data.popoutContext || "No WinT project context is currently available.";
    const prompt = `You are WinT's ${kind === "api" ? "cloud-connected" : "private local"} assistant. Be concise and useful.${kind === "api" ? " The user supplied the API key used for this request." : " This conversation stays on this PC."}\n\nConversation:\n${history}\n\nAssistant:`;
    const areas = [
      { id: "text", name: "Text-only response", description: "Default for questions that do not need any WinT tool or project context" },
      { id: "project", name: "Projects", description: "Project setup, source files, dependencies, scripts, Git, or code" },
      { id: "terminal", name: "Terminal", description: "Shell commands, terminal output, processes, or command failures" },
      { id: "ports", name: "Ports", description: "Listening ports and the processes using them" },
      { id: "dns", name: "DNS", description: "DNS lookup, comparison, and reverse lookup" },
      { id: "hosts", name: "Hosts file", description: "Windows hosts-file inspection and changes" },
      { id: "network", name: "Network", description: "Connections, adapters, routing, and connectivity" },
      { id: "path-ping", name: "Path and ping", description: "Ping, traceroute, and network path diagnostics" },
      { id: "disk-space", name: "Disk space", description: "Drive usage and large-file scanning" },
      { id: "settings", name: "Settings", description: "WinT appearance, behavior, terminal, and hotkeys settings" },
      ...(window.wintUtilTools?.catalog?.() || []).map(item => ({ id: `utility:${item.id}`, name: item.name, description: item.hint || "WinT utility tool" })),
      ...(window.wintWindowsTools?.catalog?.() || []).map(item => ({ id: `windows:${item.id}`, name: item.name, description: item.hint || "WinT Windows tool" })),
    ];
    try {
      if (kind === "agent") await sendToAgent(current, model, text, projectContext);
      else await invoke("assistant_chat", { requestId: running, model, question: text, prompt, projectContext, roots: window.wintAssistantRoots?.() || data.popoutRoots || [], areas, think: data.think, toolCallCap: data.toolCallCap });
    }
    catch (error) { current.messages[current.messages.length - 1].error = String(error); running = ""; runningAgent = null; save(); render(); }
  }

  async function sendToAgent(current, model, text, projectContext) {
    const kind = agentKind(model), spec = AGENT_COMMANDS[kind];
    if (!spec) throw new Error("That coding agent is not supported.");
    if (kind === "claude" && !current.agentSession) current.agentSession = crypto.randomUUID();
    const first = !current.agentStarted;
    const prompt = first
      ? `You are working directly in your own shell for WinT's AI sidebar. The user has deliberately selected a coding agent, so inspect files, run commands, and make changes when their request calls for it. Be concise and report what you changed or found.\n\nWinT project context:\n${projectContext}\n\nUser request:\n${text}`
      : text;
    runningAgent = { kind, tab: running };
    const args = {
      window: window.__TAURI__.window.getCurrentWindow().label,
      tab: running,
      prompt,
      cwd: window.wintAssistantWorkingDirectory?.() || data.popoutCwd || "C:\\",
      session: current.agentSession || null,
      model: null,
    };
    if (kind === "claude") {
      args.resume = !first;
      args.permissionMode = "auto";
    }
    await invoke(spec.send, args);
    current.agentStarted = true;
    save();
  }
  async function openAntigravitySignin() {
    const cwd = window.wintAssistantWorkingDirectory?.() || "C:\\";
    if (!window.openTerminal) return render("Could not open the WinT terminal.");
    try {
      const launch = await invoke("gemini_terminal_command", { session: null, login: true, model: null });
      // Make the terminal unmistakably visible before Antigravity opens the
      // browser. Its OAuth callback gives the person a code that belongs on
      // this process's stdin, not in PowerShell or a hidden headless process.
      toggle(false);
      window.openTerminalPanel?.();
      await window.openTerminal({ path: cwd, name: "Antigravity" }, { command: launch.command, title: "Antigravity · paste the sign-in code here" });
    } catch (error) {
      data.antigravityInteractiveStarted = false;
      save();
      toggle(true, false);
      render(String(error));
    }
  }
  function render(notice = "") {
    if (!host) return;
    const previousScroller = host.querySelector(".assistant-messages");
    if (previousScroller) {
      chatScrollTop = previousScroller.scrollTop;
      chatFollowBottom = previousScroller.scrollHeight - previousScroller.scrollTop - previousScroller.clientHeight < 48;
    }
    const followBottom = forceScroll || !previousScroller || chatFollowBottom;
    forceScroll = false;
    const current = chat();
    const models = selectableModels();
    const kind = modelKind(current?.model || data.model || "");
    const stateLine = kind === "agent" ? "direct shell agent" : kind === "api" ? "using your API key" : "private · on device";
    host.innerHTML = `<div class="assistant-resizer" data-ai-resize></div><header><span class="ms">auto_awesome</span><div><strong>${esc(current?.title || "Assistant")}</strong><small>${running ? (kind === "agent" ? "agent working in its shell…" : kind === "api" ? "waiting for cloud API…" : "thinking locally…") : stateLine}</small></div>
      <button data-ai="new" title="New chat"><span class="ms">add</span></button><button data-ai="history" title="Chat history"><span class="ms">history</span></button>${isPopout ? "" : `<button data-ai="popout" title="Pop out"><span class="ms">open_in_new</span></button>`}<button data-ai="close" title="Close"><span class="ms">close</span></button></header>
      <div class="assistant-modelbar"><select data-ai-model aria-label="Model"><option value="">Choose a model…</option>${models.map(m => `<option value="${esc(m.name)}" ${m.name === (current?.model || data.model) ? "selected" : ""}>${esc(m.displayName || m.name)} · ${esc(m.size)}</option>`).join("")}</select><button data-ai="models"><span class="ms">tune</span>Models</button></div>
      <div class="assistant-messages">${notice ? `<div class="assistant-notice">${esc(notice)}</div>` : ""}${!current?.messages.length ? emptyView() : current.messages.map(messageView).join("")}</div>
      <form class="assistant-compose"><textarea rows="2" placeholder="Ask the selected model…" ${running ? "disabled" : ""}></textarea><div><span><span class="ms">${kind === "agent" ? "terminal" : kind === "api" ? "cloud" : "shield"}</span> ${kind === "agent" ? "Own shell" : kind === "api" ? "Cloud API" : "Local only"}</span><label class="assistant-think" title="Plan and complete visible steps before answering"><input type="checkbox" data-ai-think ${data.think ? "checked" : ""} ${running || kind !== "local" ? "disabled" : ""}/><span class="ms">psychology</span>Think</label><button type="submit" class="assistant-send" title="${running ? "Stop" : "Send"}"><span class="ms">${running ? "stop" : "arrow_upward"}</span></button></div></form>
      <div class="assistant-layer" hidden></div>`;
    const restoreScroll = () => {
      const scroller = host.querySelector(".assistant-messages");
      if (!scroller) return;
      scroller.scrollTop = followBottom ? scroller.scrollHeight : chatScrollTop;
      chatScrollTop = scroller.scrollTop;
      chatFollowBottom = followBottom;
      scroller.onscroll = () => {
        chatScrollTop = scroller.scrollTop;
        chatFollowBottom = scroller.scrollHeight - scroller.scrollTop - scroller.clientHeight < 48;
      };
    };
    restoreScroll();
    requestAnimationFrame(() => { if (!followBottom || chatFollowBottom) restoreScroll(); });
  }
  function emptyView() {
    return `<section class="assistant-empty"><span class="ms">auto_awesome</span><h2>Ask WinT.</h2><p>Use an installed coding agent in its own shell, run a private local model, or connect with your own API key.</p>
      <div class="assistant-scope"><span class="ms">desktop_windows</span><div><strong>This assistant drives WinT and Windows.</strong><p>Ask it about your projects, ports, DNS, hosts, network, processes and disks. Coding agents work directly in their own shell; API and local models use WinT's controlled tools.</p></div></div>
      ${loading ? `<div class="assistant-loading">Checking AI providers…</div>` : !selectableModels().length ? `<button class="assistant-setup" data-ai="models"><span class="ms">tune</span>Choose a model</button>` : `<div class="assistant-starters"><button data-prompt="Explain this project setup">Explain this project setup</button><button data-prompt="Help me debug a slow development machine">Debug a slow machine</button><button data-prompt="Suggest my next troubleshooting step">Suggest a next step</button></div>`}</section>`;
  }
  function messageView(message) {
    if (message.role === "activity") return `<article class="assistant-activity"><header><span class="ms">${message.complete ? "checklist" : "progress_activity"}</span><strong>${message.steps?.length || 0} assistant steps</strong><span>${message.complete ? "complete" : "working"}</span></header><div>${(message.steps || []).map(step => `<section class="${esc(step.status)}"><span class="ms">${step.status === "running" ? "progress_activity" : step.status === "error" ? "error" : step.status === "queued" ? "schedule" : "check_circle"}</span><div><strong>${esc(step.name)}</strong><div class="assistant-step-detail">${markdown(step.detail || "")}</div></div></section>`).join("")}</div></article>`;
    if (message.role === "question") return `<article class="assistant-question"><header><span class="ms">help</span>Need your input</header><div>${markdown(message.text)}</div><footer>${(message.choices || []).map(choice => `<button data-question-choice="${esc(choice)}">${esc(choice)}</button>`).join("")}</footer></article>`;
    const error = message.error ? `<small>${esc(message.error)}</small>${message.setupAgent ? `<button type="button" class="assistant-setup" data-agent-signin="${esc(message.setupAgent)}"><span class="ms">terminal</span>Open ${esc(message.setupLabel || message.setupAgent)} in a WinT terminal</button>` : ""}` : "";
    return `<article class="assistant-message ${message.role} ${message.error ? "failed" : ""}"><div>${message.text ? markdown(message.text) : message.error ? `<span class="assistant-empty-error"><span class="ms">error</span>Assistant stopped</span>` : `<i></i><i></i><i></i>`}</div>${error}</article>`;
  }
  function modelLayer() {
    const layer = host.querySelector(".assistant-layer"); layer.hidden = false;
    layer.innerHTML = `<section class="assistant-models"><header><div><strong>Local AI models</strong><small>Downloads require your explicit action</small></div><button data-layer-close><span class="ms">close</span></button></header>
      <h3>Agent limits</h3><label class="assistant-tool-limit"><span><strong>Tool-call limit</strong><small>Maximum calls per answer (1-100)</small></span><input type="number" min="1" max="100" step="1" value="${data.toolCallCap}" data-ai-tool-cap aria-label="Tool-call limit"></label>
      ${!status?.available ? `<div class="assistant-runtime"><span class="ms">download</span><div><strong>Runtime downloads with your first model</strong><p>The 18 MB verified runtime is fetched on demand. It is not packaged in WinT, and nothing downloads until you choose a model.</p></div></div>` : ""}
      <h3>Installed models</h3>${status?.models?.length ? status.models.map(m => `<div class="assistant-model-row"><span class="ms">check_circle</span><div><strong>${esc(m.displayName || m.name)}</strong><small>${esc(m.size)} · ${esc(m.modified)}</small></div><button data-use-model="${esc(m.name)}">Use</button><button data-delete-model="${esc(m.name)}" title="Delete ${esc(m.displayName || m.name)} from this PC"><span class="ms">delete</span> Delete</button></div>`).join("") : `<p class="assistant-none">No local models installed.</p>`}
      <h3>Available models</h3>${(status?.catalog || []).map(m => `<div class="assistant-model-row"><span class="ms">neurology</span><div><strong>${esc(m.displayName)}</strong><small>${humanSize(m.size)} · ${esc(m.recommendedMemory)} RAM · ${esc(m.license)}${m.toolCallingSupport ? " · tools" : ""}</small>${!installed(m.id) && m.partial ? `<small class="assistant-partial"><span class="ms">pause_circle</span>${megabytes(m.partial)} downloaded and kept · ${Math.round(m.partial / m.size * 100)}% · continues from here</small>` : ""}</div>${installed(m.id) ? `<button data-use-model="${m.id}">Use</button>` : `<button data-pull-model="${m.id}" ${pull ? "disabled" : ""}>${m.partial ? "Resume" : "Download"}</button>`}${!installed(m.id) && m.partial ? `<button data-discard-partial="${m.id}" ${pull ? "disabled" : ""} title="Delete the partial download of ${esc(m.displayName)}"><span class="ms">delete</span></button>` : ""}</div>`).join("")}
      ${pull ? `<div class="assistant-pull"><span>${esc(pull.phase === "runtime" ? "Runtime" : pull.model)}</span><small>${esc(pull.detail || "Starting download…")}</small><i><em style="width:${pull.total ? Math.min(100, pull.downloaded / pull.total * 100) : 0}%"></em></i><button data-cancel-pull>Cancel</button><small class="assistant-rate">${esc(pull.rate || "")}</small></div>` : ""}
      <h3>Cloud providers</h3>${providerConfig("claude", "Claude", cloud?.claudeConfigured, "Anthropic API key", "sk-ant-…")}${providerConfig("openai", "Codex & GPT", cloud?.openaiConfigured, "OpenAI API key", "sk-…")}${providerConfig("cursor", "Cursor Agent", cloud?.cursorConfigured, "Cursor API key · requires cursor-agent", "key_…")}<p class="assistant-key-note"><span class="ms">shield_lock</span><span>Keys are stored in ${esc(cloud?.credentialStorage || "Windows Credential Manager")}, not IndexedDB. This protects them at rest, but it is not absolute security: malware, an administrator, or a compromised WinT process running as you may still access them.</span></p></section>`;
  }
  function providerConfig(id, name, configured, label, placeholder) {
    return `<form class="assistant-cloud-config" data-cloud-provider="${id}"><span class="ms">${configured ? "cloud_done" : "cloud_off"}</span><div><strong>${name}</strong><small>${configured ? "Saved in Windows Credential Manager" : label}</small>${configured ? "" : `<input type="password" name="key" required autocomplete="off" spellcheck="false" placeholder="${placeholder}" aria-label="${label}">`}</div>${configured ? `<button type="button" data-remove-cloud="${id}">Remove</button>` : `<button type="submit">Save</button>`}</form>`;
  }
  async function pullModel(model) {
    const kept = (status?.catalog || []).find(m => m.id === model)?.partial || 0;
    pull = { model, detail: kept ? `Resuming at ${megabytes(kept)}…` : "Starting download…" }; modelLayer();
    try { await invoke("assistant_pull", { model }); }
    catch (error) { pull.detail = String(error); modelLayer(); }
  }
  function activeAgentMessages() {
    const current = chat();
    if (!current || !runningAgent || runningAgent.tab !== running) return {};
    return {
      current,
      answer: current.messages.at(-1),
      activity: [...current.messages].reverse().find((message) => message.role === "activity" && !message.complete),
    };
  }
  function agentStep(activity, id, name, status = "running", detail = "") {
    if (!activity) return;
    const key = String(id || name || activity.steps.length);
    let step = activity.steps.find((item) => item.id === key);
    if (!step) { step = { id: key, name: String(name || "Agent tool"), status, detail: "" }; activity.steps.push(step); }
    step.status = status;
    if (detail !== undefined && detail !== "") {
      const text = typeof detail === "string" ? detail : JSON.stringify(detail, null, 2);
      step.detail = text.length > 6000 ? `${text.slice(0, 6000)}\n… ${text.length - 6000} more characters` : text;
    }
  }
  function agentLine(kind, payload) {
    if (!runningAgent || runningAgent.kind !== kind || payload?.tab !== running) return;
    let obj;
    try { obj = JSON.parse(payload.line); } catch { return; }
    const { current, answer, activity } = activeAgentMessages();
    if (!current || !answer) return;
    const sid = obj.session_id || obj.sessionId || obj.data?.sessionId || (obj.type === "thread.started" && obj.thread_id);
    if (typeof sid === "string" && /^[A-Za-z0-9_-]{1,64}$/.test(sid)) current.agentSession = sid;
    const setAnswer = (value, append = false) => {
      const text = typeof value === "string" ? value : "";
      if (!text) return;
      answer.text = append ? `${answer.text || ""}${text}` : text;
    };
    const toolOutput = (value) => Array.isArray(value) ? value.map((item) => item?.text || String(item || "")).join("\n") : value;

    if (obj.type === "result" && typeof obj.result === "string") setAnswer(obj.result);
    if (obj.type === "assistant" && Array.isArray(obj.message?.content)) {
      const spoken = obj.message.content.filter((block) => block.type === "text").map((block) => block.text || "").join("");
      if (spoken) setAnswer(spoken, kind === "cursor" && obj.timestamp_ms != null && obj.model_call_id == null);
      for (const block of obj.message.content) if (block.type === "tool_use") agentStep(activity, block.id, block.name || block.input?.command || "Agent tool");
    }
    if (obj.type === "user" && Array.isArray(obj.message?.content)) for (const block of obj.message.content) {
      if (block.type === "tool_result") agentStep(activity, block.tool_use_id, "Agent tool", block.is_error ? "error" : "done", toolOutput(block.content));
    }
    if (obj.type === "tool_call") {
      const call = obj.tool_call || {}, inner = Object.values(call)[0] || {}, name = inner.args?.command || inner.args?.path || Object.keys(call)[0] || "Agent tool";
      if (obj.subtype === "started") agentStep(activity, obj.call_id, name);
      if (obj.subtype === "completed") { const result = inner.result || {}; agentStep(activity, obj.call_id, name, result.error ? "error" : "done", result.success?.stdout ?? result.success ?? result.error ?? result); }
    }
    if (obj.item?.type === "command_execution") agentStep(activity, obj.item.id, obj.item.command || "Command", obj.type === "item.completed" ? (obj.item.status === "failed" || Number(obj.item.exit_code) > 0 ? "error" : "done") : "running", obj.item.aggregated_output || obj.item.output || "");
    if (obj.type === "item.completed" && obj.item?.type === "agent_message") setAnswer(obj.item.text);
    if (obj.type === "tool_use") agentStep(activity, obj.tool_id, obj.parameters?.command || obj.tool_name || "Agent tool");
    if (obj.type === "tool_result") agentStep(activity, obj.tool_id, obj.tool_name || "Agent tool", obj.status === "error" ? "error" : "done", obj.output ?? obj.error?.message ?? "");
    if (obj.type === "message" && obj.role === "assistant" && obj.content) setAnswer(obj.content, true);
    if (kind === "gemini" && obj.event === "init" && obj.conversation_id) current.agentSession = obj.conversation_id;
    if (kind === "gemini" && obj.event === "step_update") {
      const step = obj.step_update || {};
      if (step.conversation_id) current.agentSession = step.conversation_id;
      if (step.step_type === "agent_response" && step.text_delta) setAnswer(step.text_delta, true);
      if (step.step_type === "tool") {
        const info = step.tool_info || {};
        const name = info.parameters?.CommandLine || step.tool_name || info.name || "Antigravity tool";
        agentStep(activity, `agy:${step.step_index}`, name, step.state === "DONE" ? (info.error ? "error" : "done") : "running", info.output ?? info.error?.message ?? "");
      }
    }
    if (kind === "gemini" && obj.event === "result") {
      const result = obj.result || {};
      if (result.conversation_id) current.agentSession = result.conversation_id;
      if (result.response) setAnswer(result.response);
      if (result.status && result.status !== "SUCCESS") answer.error = String(result.error || `Antigravity stopped with status ${result.status}.`);
    }
    if (obj.type === "error") answer.error = String(obj.message || obj.error || `${kind} reported an error.`);
    if (obj.type === "tool.execution_start") agentStep(activity, obj.data?.toolCallId, obj.data?.arguments?.command || obj.data?.toolName || "Agent tool");
    if (obj.type === "tool.execution_complete") agentStep(activity, obj.data?.toolCallId, obj.data?.toolName || "Agent tool", obj.data?.success === false ? "error" : "done", obj.data?.result?.content ?? obj.data?.error ?? "");
    if (obj.type === "assistant.message") { const msg = obj.data?.message; setAnswer(msg?.content?.join ? msg.content.join("") : msg?.content || msg?.text); }
    if (obj.type === "assistant.message_delta" && obj.data?.deltaContent) setAnswer(obj.data.deltaContent, true);
    if (obj.type === "turn.failed" && obj.error?.message) answer.error = String(obj.error.message);
    save(); render();
  }
  function agentEnd(kind, payload) {
    if (!runningAgent || runningAgent.kind !== kind || payload?.tab !== running) return;
    const { current, answer, activity } = activeAgentMessages();
    if (activity) { activity.complete = true; for (const step of activity.steps) if (step.status === "running") step.status = "done"; }
    if (answer && payload.code !== 0) {
      const raw = String(payload.error || `${kind} stopped with exit code ${payload.code}.`).trim();
      if (kind === "gemini" && /authentication required|not authenticated|sign.?in/i.test(raw)) {
        answer.error = "Antigravity CLI is installed but is not signed in. Open Antigravity, finish Google sign-in, then ask again.";
        answer.setupAgent = "gemini";
        answer.setupLabel = "Antigravity";
      } else answer.error = raw;
    }
    else if (answer && !answer.text) answer.error = `${kind} completed without returning a visible answer.`;
    if (current) save();
    running = ""; runningAgent = null; render();
  }
  function mount(target, toggleButton) {
    host = target; button = toggleButton; mounted = true;
    document.documentElement.style.setProperty("--assistant-w", `${Math.min(800, Math.max(320, Number(data.width) || 410))}px`);
    if (isPopout) { open = true; data.open = true; host.hidden = false; }
    render(); button.onclick = () => toggle();
    host.onclick = (event) => {
      const action = event.target.closest("[data-ai]")?.dataset.ai;
      const prompt = event.target.closest("[data-prompt]")?.dataset.prompt;
      if (action === "close") toggle(false); else if (action === "new") newChat(); else if (action === "models") modelLayer(); else if (action === "popout") popOut();
      else if (action === "history") historyLayer(); else if (prompt) send(prompt);
      const choice = event.target.closest("[data-question-choice]")?.dataset.questionChoice; if (choice) send(choice);
      const copyCode = event.target.closest("[data-copy-code]"); if (copyCode) window.wintCopy.copy(copyCode.closest("pre")?.querySelector("code")?.textContent || "", copyCode).catch(() => {});
      const close = event.target.closest("[data-layer-close]"); if (close) host.querySelector(".assistant-layer").hidden = true;
      const use = event.target.closest("[data-use-model]")?.dataset.useModel; if (use) { data.model = use; if (chat()) chat().model = use; invoke("ai_model_select", { id: use }).catch(() => {}); save(); render(); }
      const pullId = event.target.closest("[data-pull-model]")?.dataset.pullModel; if (pullId) pullModel(pullId);
      const remove = event.target.closest("[data-delete-model]")?.dataset.deleteModel; if (remove) deleteModel(remove);
      const discard = event.target.closest("[data-discard-partial]")?.dataset.discardPartial; if (discard) discardPartial(discard);
      const removeCloud = event.target.closest("[data-remove-cloud]")?.dataset.removeCloud; if (removeCloud) configureCloud(removeCloud, "");
      const signin = event.target.closest("[data-agent-signin]")?.dataset.agentSignin; if (signin === "gemini") {
        data.antigravityInteractiveStarted = true;
        save();
        openAntigravitySignin();
      }
      if (event.target.closest("[data-cancel-pull]")) invoke("assistant_pull_cancel");
      const pick = event.target.closest("[data-chat-id]")?.dataset.chatId; if (pick) { data.active = pick; save(); render(); }
    };
    host.onchange = (event) => { if (event.target.matches("[data-ai-model]")) { const current = chat(); data.model = event.target.value; if (current) { if (current.model !== data.model) { current.agentSession = ""; current.agentStarted = false; } current.model = data.model; } if (data.model) invoke("ai_model_select", { id: data.model }).catch(() => {}); save(); render(); } else if (event.target.matches("[data-ai-think]")) { data.think = event.target.checked; save(); } else if (event.target.matches("[data-ai-tool-cap]")) event.target.value = setToolCallCap(event.target.value); };
    host.onsubmit = (event) => { event.preventDefault(); const provider = event.target.dataset.cloudProvider; if (provider) { configureCloud(provider, String(new FormData(event.target).get("key") || "")); return; } if (running) { if (runningAgent) invoke(AGENT_COMMANDS[runningAgent.kind].cancel, { tab: runningAgent.tab }); else invoke("assistant_chat_cancel"); } else { const input = host.querySelector("textarea"); send(input.value); input.value = ""; } };
    host.onkeydown = (event) => { if (event.target.matches("textarea") && event.key === "Enter" && !event.shiftKey) { event.preventDefault(); host.querySelector("form").requestSubmit(); } };
    host.onpointerdown = (event) => {
      if (isPopout || !event.target.closest("[data-ai-resize]")) return;
      event.preventDefault();
      const move = (e) => { data.width = Math.min(800, Math.max(320, window.innerWidth - e.clientX)); document.documentElement.style.setProperty("--assistant-w", `${data.width}px`); };
      const up = () => { window.removeEventListener("pointermove", move); window.removeEventListener("pointerup", up); save(); };
      window.addEventListener("pointermove", move); window.addEventListener("pointerup", up);
    };
    listen("assistant:chunk", ({ payload }) => { if (payload.requestId !== running) return; const current = chat(); const message = current?.messages.at(-1); if (!message) return; if (payload.kind === "question") { message.role = "question"; message.text = payload.question; message.choices = payload.choices || []; } else if (payload.kind === "replace") message.text = payload.text || ""; else message.text += payload.text || ""; if (payload.done) { message.error = payload.error || (!message.text && message.role !== "question" ? "The model completed without returning visible text." : ""); const activity = [...current.messages].reverse().find(item => item.role === "activity" && !item.complete); if (activity) activity.complete = true; running = ""; } save(); render(); });
    listen("assistant:step", ({ payload }) => { if (payload.requestId !== running) return; const activity = [...(chat()?.messages || [])].reverse().find(message => message.role === "activity"); if (!activity) return; const existing = activity.steps.find(step => step.id === payload.id); if (existing) { const streamed = existing.detail; Object.assign(existing, payload); if (!payload.detail && streamed) existing.detail = streamed; } else activity.steps.push(payload); save(); render(); });
    listen("assistant:step-chunk", ({ payload }) => { if (payload.requestId !== running) return; const activity = [...(chat()?.messages || [])].reverse().find(message => message.role === "activity"); const step = activity?.steps.find(item => item.id === payload.id); if (!step) return; step.detail = (step.detail || "") + (payload.text || ""); save(); render(); });
    listen("assistant:open-tool", ({ payload }) => { if (payload?.id) window.dispatchEvent(new CustomEvent("wint:open-tool", { detail: payload })); });
    listen("assistant:model-progress", ({ payload }) => { if (!pull || payload.model !== pull.model) return; pull.detail = payload.detail || pull.detail; pull.phase = payload.phase; pull.downloaded = payload.downloaded; pull.total = payload.total; pull.rate = payload.rate; if (payload.done) { const error = payload.error; pull = null; refresh().then(() => { modelLayer(); if (error) { pull = { model: payload.model, detail: error, phase: "error" }; modelLayer(); } }); } else modelLayer(); });
    for (const kind of Object.keys(AGENT_COMMANDS)) {
      listen(`${kind}:line`, ({ payload }) => agentLine(kind, payload));
      listen(`${kind}:end`, ({ payload }) => agentEnd(kind, payload));
    }
    listen("assistant:state-request", () => { if (!isPopout) window.__TAURI__.event.emit("assistant:state-sync", { source: syncSource, data }).catch(() => {}); });
    listen("assistant:state-sync", ({ payload }) => {
      if (!payload?.data || payload.source === syncSource) return;
      Object.keys(data).forEach((key) => delete data[key]); Object.assign(data, payload.data);
      stateSynced = true; localStorage.setItem(STORE, JSON.stringify(data)); render();
    });
    if (isPopout) setTimeout(() => window.__TAURI__.event.emit("assistant:state-request", { source: syncSource }).catch(() => {}), 100);
    if (data.open) requestAnimationFrame(() => toggle(true));
  }
  async function deleteModel(model) {
    const allowed = await (window.wintConfirm?.({ title: "Delete local model?", message: `${model} will be removed from this PC. Conversation history stays.`, confirmLabel: "Delete model", tone: "danger", icon: "delete" }) ?? Promise.resolve(false));
    if (!allowed) return;
    try { await invoke("assistant_model_delete", { model }); if (data.model === model) data.model = ""; for (const item of data.chats) if (item.model === model) item.model = ""; save(); await refresh(); modelLayer(); }
    catch (error) { pull = { model, detail: String(error) }; modelLayer(); }
  }
  // Throwing away a paused download is the one way those bytes leave the disk,
  // so it asks first and says how much is being given up.
  async function discardPartial(model) {
    const kept = (status?.catalog || []).find(m => m.id === model)?.partial || 0;
    const allowed = await (window.wintConfirm?.({ title: "Discard partial download?", message: `${megabytes(kept)} already downloaded for ${model} will be deleted. Downloading again starts from zero.`, confirmLabel: "Discard", tone: "danger", icon: "delete" }) ?? Promise.resolve(false));
    if (!allowed) return;
    try { await invoke("assistant_model_delete", { model }); await refresh(); modelLayer(); }
    catch (error) { pull = { model, detail: String(error) }; modelLayer(); }
  }
  async function configureCloud(provider, key) {
    try {
      cloud = key ? await invoke("assistant_cloud_configure", { provider, key }) : await invoke("assistant_cloud_remove", { provider });
      if (key && provider === "openai" && !data.model) data.model = "gpt:gpt-5.6-luna";
      const removed = (model) => !key && (model?.startsWith(`${provider}:`) || (provider === "openai" && (model?.startsWith("codex:") || model?.startsWith("gpt:"))));
      if (removed(data.model)) data.model = "";
      for (const item of data.chats) if (removed(item.model)) item.model = "";
      // A key is what makes a whole group of models usable, so the shared list
      // this panel and Settings both read has just changed.
      registry = await invoke("ai_models").catch(() => registry);
      window.dispatchEvent(new CustomEvent("wint:ai-models-changed"));
      save(); render(); modelLayer();
    } catch (error) { const layer = host.querySelector(".assistant-layer"); if (layer) layer.insertAdjacentHTML("afterbegin", `<div class="assistant-notice">${esc(String(error))}</div>`); }
  }
  function historyLayer() {
    const layer = host.querySelector(".assistant-layer"); layer.hidden = false;
    layer.innerHTML = `<section class="assistant-history"><header><strong>Recent chats</strong><button data-layer-close><span class="ms">close</span></button></header>${data.chats.map(c => `<button data-chat-id="${c.id}" class="${c.id === data.active ? "on" : ""}"><strong>${esc(c.title)}</strong><small>${esc(c.model || "No model")} · ${new Date(c.created).toLocaleDateString()}</small></button>`).join("")}</section>`;
  }
  async function openModels() {
    toggle(true, false);
    await refresh();
    modelLayer();
  }
  async function popOut() {
    const api = window.__TAURI__.webviewWindow;
    const existing = await api.WebviewWindow.getByLabel("assistant-popout").catch(() => null);
    if (existing) { await existing.show().catch(() => {}); await existing.setFocus().catch(() => {}); return; }
    data.popoutCwd = window.wintAssistantWorkingDirectory?.() || "C:\\";
    data.popoutContext = window.wintAssistantContext?.() || "";
    data.popoutRoots = window.wintAssistantRoots?.() || [];
    save();
    const theme = document.documentElement.dataset.theme === "light" ? "light" : "dark";
    const win = new api.WebviewWindow("assistant-popout", { url: `assistant.html?popout=1&theme=${theme}`, title: "WinT AI", width: Math.max(480, Number(data.width) || 520), height: 760, minWidth: 360, minHeight: 420, center: true });
    win.once("tauri://error", (error) => render(String(error)));
    toggle(false);
  }
  window.wintAssistant = { mount, toggle, openModels, getToolCallCap: () => data.toolCallCap, setToolCallCap };
})();
