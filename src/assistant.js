(() => {
  const invoke = window.__TAURI__.core.invoke;
  const listen = window.__TAURI__.event.listen;
  const STORE = "wint.assistant.v1";
  const data = load();
  if (data.pinned !== true) { data.pinned = true; save(); }
  data.toolCallCap = clampToolCallCap(data.toolCallCap);
  let host, button, open = false, status = null, cloud = null, loading = false, running = "", pull = null, forceScroll = false, chatScrollTop = 0, chatFollowBottom = true;

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
  function save() { localStorage.setItem(STORE, JSON.stringify(data)); }
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
    open = value; data.open = open; save(); host.hidden = !open; button.classList.toggle("on", open); button.setAttribute("aria-pressed", String(open));
    document.documentElement.classList.toggle("assistant-open", open);
    document.documentElement.classList.toggle("assistant-pinned", open);
    setTimeout(() => window.wintTerminalSettings?.fitVisible?.(), 180);
    if (open && !chat()) newChat();
    if (open && refreshModels) refresh();
  }
  async function refresh() {
    loading = true; render();
    try { [status, cloud] = await Promise.all([invoke("assistant_status"), invoke("assistant_cloud_status")]); }
    catch (error) { status = { available: false, models: [], error: String(error) }; }
    loading = false;
    if (!data.model && status.models?.length) data.model = status.models[0].name;
    if (!data.model && cloud?.openaiConfigured) data.model = "gpt:gpt-5.6-luna";
    save(); render();
  }
  function installed(name) { return status?.models?.some((model) => model.name === name); }
  function cloudModels() {
    const models = [];
    if (cloud?.claudeConfigured) models.push({ name: "claude:claude-sonnet-4-6", displayName: "Claude Sonnet 4.6", size: "Cloud" });
    if (cloud?.openaiConfigured) models.push(
      { name: "codex:gpt-5.3-codex", displayName: "Codex · GPT-5.3-Codex", size: "Cloud" },
      { name: "gpt:gpt-5.6-luna", displayName: "GPT · 5.6 Luna", size: "Cloud · default" },
      { name: "gpt:gpt-5.6-terra", displayName: "GPT · 5.6 Terra", size: "Cloud" },
      { name: "gpt:gpt-5.6-sol", displayName: "GPT · 5.6 Sol", size: "Cloud" }
    );
    if (cloud?.cursorConfigured) models.push({ name: "cursor:agent", displayName: "Cursor Agent", size: "CLI" });
    return models;
  }
  function humanSize(bytes) { return bytes >= 1e9 ? `${(bytes / 1e9).toFixed(1)} GB` : `${Math.round(bytes / 1e6)} MB`; }
  async function send(text) {
    const current = chat();
    text = text.trim();
    if (!current || !text || running) return;
    const model = current.model || data.model;
    if (!model) { render("Choose or download a model before chatting."); return; }
    const isCloud = model.includes(":");
    current.title = current.messages.length ? current.title : text.slice(0, 54);
    current.model = model;
    current.messages.push({ role: "user", text }, { role: "activity", text: "", steps: [] }, { role: "assistant", text: "" });
    running = crypto.randomUUID(); forceScroll = true; save(); render();
    const history = current.messages.filter((m) => ["user", "assistant", "question"].includes(m.role)).slice(0, -1).map((m) => `${m.role === "user" ? "User" : "Assistant"}: ${m.text}${m.role === "question" ? ` Choices: ${(m.choices || []).join(" | ")}` : ""}`).join("\n\n");
    const projectContext = window.wintAssistantContext?.() || "No WinT project context is currently available.";
    const prompt = `You are WinT's ${isCloud ? "cloud-connected" : "private local"} assistant. Be concise and useful.${isCloud ? " The user supplied the API key used for this request." : " This conversation stays on this PC."}\n\nConversation:\n${history}\n\nAssistant:`;
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
    try { await invoke("assistant_chat", { requestId: running, model, question: text, prompt, projectContext, roots: window.wintAssistantRoots?.() || [], areas, think: data.think, toolCallCap: data.toolCallCap }); }
    catch (error) { current.messages[current.messages.length - 1].error = String(error); running = ""; save(); render(); }
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
    const models = [...(status?.models || []), ...cloudModels()];
    const isCloud = (current?.model || data.model || "").includes(":");
    host.innerHTML = `<header><span class="ms">auto_awesome</span><div><strong>${esc(current?.title || "Assistant")}</strong><small>${running ? (isCloud ? "waiting for cloud API…" : "thinking locally…") : (isCloud ? "using your API key" : "private · on device")}</small></div>
      <button data-ai="new" title="New chat"><span class="ms">add</span></button><button data-ai="history" title="Chat history"><span class="ms">history</span></button><button data-ai="close" title="Close"><span class="ms">close</span></button></header>
      <div class="assistant-modelbar"><select data-ai-model aria-label="Model"><option value="">Choose a model…</option>${models.map(m => `<option value="${esc(m.name)}" ${m.name === (current?.model || data.model) ? "selected" : ""}>${esc(m.displayName || m.name)} · ${esc(m.size)}</option>`).join("")}</select><button data-ai="models"><span class="ms">tune</span>Models</button></div>
      <div class="assistant-messages">${notice ? `<div class="assistant-notice">${esc(notice)}</div>` : ""}${!current?.messages.length ? emptyView() : current.messages.map(messageView).join("")}</div>
      <form class="assistant-compose"><textarea rows="2" placeholder="Ask the selected model…" ${running ? "disabled" : ""}></textarea><div><span><span class="ms">${isCloud ? "cloud" : "shield"}</span> ${isCloud ? "Cloud API" : "Local only"}</span><label class="assistant-think" title="Plan and complete visible steps before answering"><input type="checkbox" data-ai-think ${data.think ? "checked" : ""} ${running || isCloud ? "disabled" : ""}/><span class="ms">psychology</span>Think</label><button type="submit" class="assistant-send" title="${running ? "Stop" : "Send"}"><span class="ms">${running ? "stop" : "arrow_upward"}</span></button></div></form>
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
  /** Point at the workspace the way the user actually reaches it - through
   * the command palette, on whatever key they have bound to it. */
  function paletteHint() {
    const binding = window.wintPaletteHotkey?.() || "";
    return binding
      ? `Press <kbd>${esc(binding)}</kbd> and type <b>workspace</b> to open one.`
      : "Open a project workspace instead.";
  }
  function emptyView() {
    return `<section class="assistant-empty"><span class="ms">auto_awesome</span><h2>Ask WinT.</h2><p>Run a private model on this PC, or connect Claude, Codex, or GPT with your own API key.</p>
      <div class="assistant-scope"><span class="ms">desktop_windows</span><div><strong>This assistant drives WinT and Windows.</strong><p>Ask it about your projects, ports, DNS, hosts, network, processes and disks, and let it work the WinT tools for you.</p><p>Looking for a coding agent that reads and changes code? ${paletteHint()}</p></div></div>
      ${loading ? `<div class="assistant-loading">Checking AI providers…</div>` : !status?.models?.length && !cloudModels().length ? `<button class="assistant-setup" data-ai="models"><span class="ms">tune</span>Choose a model</button>` : `<div class="assistant-starters"><button data-prompt="Explain this project setup">Explain this project setup</button><button data-prompt="Help me debug a slow development machine">Debug a slow machine</button><button data-prompt="Suggest my next troubleshooting step">Suggest a next step</button></div>`}</section>`;
  }
  function messageView(message) {
    if (message.role === "activity") return `<article class="assistant-activity"><header><span class="ms">${message.complete ? "checklist" : "progress_activity"}</span><strong>${message.steps?.length || 0} assistant steps</strong><span>${message.complete ? "complete" : "working"}</span></header><div>${(message.steps || []).map(step => `<section class="${esc(step.status)}"><span class="ms">${step.status === "running" ? "progress_activity" : step.status === "error" ? "error" : step.status === "queued" ? "schedule" : "check_circle"}</span><div><strong>${esc(step.name)}</strong><div class="assistant-step-detail">${markdown(step.detail || "")}</div></div></section>`).join("")}</div></article>`;
    if (message.role === "question") return `<article class="assistant-question"><header><span class="ms">help</span>Need your input</header><div>${markdown(message.text)}</div><footer>${(message.choices || []).map(choice => `<button data-question-choice="${esc(choice)}">${esc(choice)}</button>`).join("")}</footer></article>`;
    const error = message.error ? `<small>${esc(message.error)}</small>` : "";
    return `<article class="assistant-message ${message.role} ${message.error ? "failed" : ""}"><div>${message.text ? markdown(message.text) : message.error ? `<span class="assistant-empty-error"><span class="ms">error</span>Assistant stopped</span>` : `<i></i><i></i><i></i>`}</div>${error}</article>`;
  }
  function modelLayer() {
    const layer = host.querySelector(".assistant-layer"); layer.hidden = false;
    layer.innerHTML = `<section class="assistant-models"><header><div><strong>Local AI models</strong><small>Downloads require your explicit action</small></div><button data-layer-close><span class="ms">close</span></button></header>
      <h3>Agent limits</h3><label class="assistant-tool-limit"><span><strong>Tool-call limit</strong><small>Maximum calls per answer (1-100)</small></span><input type="number" min="1" max="100" step="1" value="${data.toolCallCap}" data-ai-tool-cap aria-label="Tool-call limit"></label>
      ${!status?.available ? `<div class="assistant-runtime"><span class="ms">download</span><div><strong>Runtime downloads with your first model</strong><p>The 18 MB verified runtime is fetched on demand. It is not packaged in WinT, and nothing downloads until you choose a model.</p></div></div>` : ""}
      <h3>Installed models</h3>${status?.models?.length ? status.models.map(m => `<div class="assistant-model-row"><span class="ms">check_circle</span><div><strong>${esc(m.name)}</strong><small>${esc(m.size)} · ${esc(m.modified)}</small></div><button data-use-model="${esc(m.name)}">Use</button><button data-delete-model="${esc(m.name)}" title="Delete model"><span class="ms">delete</span></button></div>`).join("") : `<p class="assistant-none">No local models installed.</p>`}
      <h3>Available models</h3>${(status?.catalog || []).map(m => `<div class="assistant-model-row"><span class="ms">neurology</span><div><strong>${esc(m.displayName)}</strong><small>${humanSize(m.size)} · ${esc(m.recommendedMemory)} RAM · ${esc(m.license)}${m.toolCallingSupport ? " · tools" : ""}</small></div>${installed(m.id) ? `<button data-use-model="${m.id}">Use</button>` : `<button data-pull-model="${m.id}" ${pull ? "disabled" : ""}>Download</button>`}</div>`).join("")}
      ${pull ? `<div class="assistant-pull"><span>${esc(pull.phase === "runtime" ? "Runtime" : pull.model)}</span><small>${esc(pull.detail || "Starting download…")}</small><i><em style="width:${pull.total ? Math.min(100, pull.downloaded / pull.total * 100) : 0}%"></em></i><button data-cancel-pull>Cancel</button></div>` : ""}
      <h3>Cloud providers</h3>${providerConfig("claude", "Claude", cloud?.claudeConfigured, "Anthropic API key", "sk-ant-…")}${providerConfig("openai", "Codex & GPT", cloud?.openaiConfigured, "OpenAI API key", "sk-…")}${providerConfig("cursor", "Cursor Agent", cloud?.cursorConfigured, "Cursor API key · requires cursor-agent", "key_…")}<p class="assistant-key-note"><span class="ms">shield_lock</span><span>Keys are stored in ${esc(cloud?.credentialStorage || "Windows Credential Manager")}, not IndexedDB. This protects them at rest, but it is not absolute security: malware, an administrator, or a compromised WinT process running as you may still access them.</span></p></section>`;
  }
  function providerConfig(id, name, configured, label, placeholder) {
    return `<form class="assistant-cloud-config" data-cloud-provider="${id}"><span class="ms">${configured ? "cloud_done" : "cloud_off"}</span><div><strong>${name}</strong><small>${configured ? "Saved in Windows Credential Manager" : label}</small>${configured ? "" : `<input type="password" name="key" required autocomplete="off" spellcheck="false" placeholder="${placeholder}" aria-label="${label}">`}</div>${configured ? `<button type="button" data-remove-cloud="${id}">Remove</button>` : `<button type="submit">Save</button>`}</form>`;
  }
  async function pullModel(model) {
    pull = { model, detail: "Starting download…" }; modelLayer();
    try { await invoke("assistant_pull", { model }); }
    catch (error) { pull.detail = String(error); modelLayer(); }
  }
  function mount(target, toggleButton) {
    host = target; button = toggleButton; render(); button.onclick = () => toggle();
    host.onclick = (event) => {
      const action = event.target.closest("[data-ai]")?.dataset.ai;
      const prompt = event.target.closest("[data-prompt]")?.dataset.prompt;
      if (action === "close") toggle(false); else if (action === "new") newChat(); else if (action === "models") modelLayer();
      else if (action === "history") historyLayer(); else if (prompt) send(prompt);
      const choice = event.target.closest("[data-question-choice]")?.dataset.questionChoice; if (choice) send(choice);
      const copyCode = event.target.closest("[data-copy-code]"); if (copyCode) window.wintCopy.copy(copyCode.closest("pre")?.querySelector("code")?.textContent || "", copyCode).catch(() => {});
      const close = event.target.closest("[data-layer-close]"); if (close) host.querySelector(".assistant-layer").hidden = true;
      const use = event.target.closest("[data-use-model]")?.dataset.useModel; if (use) { data.model = use; if (chat()) chat().model = use; save(); render(); }
      const pullId = event.target.closest("[data-pull-model]")?.dataset.pullModel; if (pullId) pullModel(pullId);
      const remove = event.target.closest("[data-delete-model]")?.dataset.deleteModel; if (remove) deleteModel(remove);
      const removeCloud = event.target.closest("[data-remove-cloud]")?.dataset.removeCloud; if (removeCloud) configureCloud(removeCloud, "");
      if (event.target.closest("[data-cancel-pull]")) invoke("assistant_pull_cancel");
      const pick = event.target.closest("[data-chat-id]")?.dataset.chatId; if (pick) { data.active = pick; save(); render(); }
    };
    host.onchange = (event) => { if (event.target.matches("[data-ai-model]")) { data.model = event.target.value; if (chat()) chat().model = data.model; save(); } else if (event.target.matches("[data-ai-think]")) { data.think = event.target.checked; save(); } else if (event.target.matches("[data-ai-tool-cap]")) event.target.value = setToolCallCap(event.target.value); };
    host.onsubmit = (event) => { event.preventDefault(); const provider = event.target.dataset.cloudProvider; if (provider) { configureCloud(provider, String(new FormData(event.target).get("key") || "")); return; } if (running) invoke("assistant_chat_cancel"); else { const input = host.querySelector("textarea"); send(input.value); input.value = ""; } };
    host.onkeydown = (event) => { if (event.target.matches("textarea") && event.key === "Enter" && !event.shiftKey) { event.preventDefault(); host.querySelector("form").requestSubmit(); } };
    listen("assistant:chunk", ({ payload }) => { if (payload.requestId !== running) return; const current = chat(); const message = current?.messages.at(-1); if (!message) return; if (payload.kind === "question") { message.role = "question"; message.text = payload.question; message.choices = payload.choices || []; } else if (payload.kind === "replace") message.text = payload.text || ""; else message.text += payload.text || ""; if (payload.done) { message.error = payload.error || (!message.text && message.role !== "question" ? "The model completed without returning visible text." : ""); const activity = [...current.messages].reverse().find(item => item.role === "activity" && !item.complete); if (activity) activity.complete = true; running = ""; } save(); render(); });
    listen("assistant:step", ({ payload }) => { if (payload.requestId !== running) return; const activity = [...(chat()?.messages || [])].reverse().find(message => message.role === "activity"); if (!activity) return; const existing = activity.steps.find(step => step.id === payload.id); if (existing) { const streamed = existing.detail; Object.assign(existing, payload); if (!payload.detail && streamed) existing.detail = streamed; } else activity.steps.push(payload); save(); render(); });
    listen("assistant:step-chunk", ({ payload }) => { if (payload.requestId !== running) return; const activity = [...(chat()?.messages || [])].reverse().find(message => message.role === "activity"); const step = activity?.steps.find(item => item.id === payload.id); if (!step) return; step.detail = (step.detail || "") + (payload.text || ""); save(); render(); });
    listen("assistant:open-tool", ({ payload }) => { if (payload?.id) window.dispatchEvent(new CustomEvent("wint:open-tool", { detail: payload })); });
    listen("assistant:model-progress", ({ payload }) => { if (!pull || payload.model !== pull.model) return; pull.detail = payload.detail || pull.detail; pull.phase = payload.phase; pull.downloaded = payload.downloaded; pull.total = payload.total; if (payload.done) { const error = payload.error; pull = null; refresh().then(() => { modelLayer(); if (error) { pull = { model: payload.model, detail: error, phase: "error" }; modelLayer(); } }); } else modelLayer(); });
    if (data.open) requestAnimationFrame(() => toggle(true));
  }
  async function deleteModel(model) {
    const allowed = await (window.wintConfirm?.({ title: "Delete local model?", message: `${model} will be removed from this PC. Conversation history stays.`, confirmLabel: "Delete model", tone: "danger", icon: "delete" }) ?? Promise.resolve(false));
    if (!allowed) return;
    try { await invoke("assistant_model_delete", { model }); if (data.model === model) data.model = ""; if (chat()?.model === model) chat().model = ""; save(); await refresh(); modelLayer(); }
    catch (error) { pull = { model, detail: String(error) }; modelLayer(); }
  }
  async function configureCloud(provider, key) {
    try {
      cloud = key ? await invoke("assistant_cloud_configure", { provider, key }) : await invoke("assistant_cloud_remove", { provider });
      if (key && provider === "openai" && !data.model) data.model = "gpt:gpt-5.6-luna";
      const removed = (model) => !key && (model?.startsWith(`${provider}:`) || (provider === "openai" && (model?.startsWith("codex:") || model?.startsWith("gpt:"))));
      if (removed(data.model)) data.model = "";
      for (const item of data.chats) if (removed(item.model)) item.model = "";
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
  window.wintAssistant = { mount, toggle, openModels, getToolCallCap: () => data.toolCallCap, setToolCallCap };
})();
