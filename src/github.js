(() => {
  const ghInvoke = window.__TAURI__.core.invoke;
  const state = { host: null, status: null, loading: false, error: "", accessError: null, tab: "inbox", items: [], selected: null, detail: null, repos: [], orgs: [], rate: null, query: "", repo: "", org: "", notice: "", timer: null };
  const esc = (s = "") => String(s).replace(/[&<>"']/g, c => ({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"})[c]);
  const icon = (name) => `<span class="ms">${name}</span>`;
  const api = (endpoint, method = "GET", body = null) => ghInvoke("github_api", { method, endpoint, body });
  const endpoint = (url) => String(url || "").replace(/^https:\/\/api\.github\.com\//, "");
  const rel = (date) => {
    const seconds = Math.max(0, (Date.now() - new Date(date).getTime()) / 1000);
    if (seconds < 60) return "now"; if (seconds < 3600) return `${Math.floor(seconds/60)}m`;
    if (seconds < 86400) return `${Math.floor(seconds/3600)}h`; return `${Math.floor(seconds/86400)}d`;
  };
  const repoName = (url = "") => { const m = url.match(/repos\/([^/]+\/[^/]+)/); return m ? m[1] : ""; };
  const githubSlug = (remote = "") => {
    const value = String(remote).trim().replace(/\\/g, "/").replace(/\/?\.git\/?$/i, "");
    const match = value.match(/github\.com(?::|\/)([^/]+\/[^/]+)$/i);
    return (match?.[1] || "").toLowerCase();
  };
  const localProject = (repo = "") => {
    const wanted = String(repo).replace(/\/?\.git\/?$/i, "").toLowerCase();
    return window.wintShell?.projects?.().find(project => githubSlug(project.remote) === wanted) || null;
  };

  function mount(host) {
    if (!host || state.host === host) return;
    state.host = host;
    host.innerHTML = `<header class="tool-head">
      <button class="btn back tool-back" type="button" data-open-tool="overview" title="Back to the overview">${icon("arrow_back")}Back</button>
      <span class="tool-plate">${icon("merge")}</span>
      <span class="tool-title"><strong>GitHub</strong><small>inbox, pull requests, issues, Actions and repositories</small></span>
      ${window.wintMaturity?.badge("github") ?? ""}
      <button class="tool-popout" type="button" data-popout-tool="github"></button>
      <button class="tool-pin" type="button" data-pin-tool="github"></button>
      <button class="tool-close" type="button" data-open-tool="overview" title="Back to the overview">${icon("close")}</button>
    </header><div class="gh-shell">
      <aside class="gh-side"><nav>
          <p>TRIAGE</p>
          <button class="on" data-gh-tab="inbox">${icon("inbox")}Inbox <b id="gh-inbox-count">–</b></button>
          <button data-gh-tab="reviews">${icon("rate_review")}Review requests</button>
          <button data-gh-tab="assigned">${icon("assignment_ind")}Assigned to me</button>
          <button data-gh-tab="mentions">${icon("alternate_email")}Mentions</button>
          <button data-gh-tab="subscribed">${icon("notifications")}Subscribed</button>
          <p>AUTOMATION</p>
          <button data-gh-tab="actions">${icon("play_circle")}Workflow runs</button>
          <button data-gh-tab="queue">${icon("hourglass_top")}Runners &amp; queue</button>
          <button data-gh-tab="secrets">${icon("lock")}Secrets &amp; environments</button>
          <p>SUPPLY CHAIN</p>
          <button data-gh-tab="dependabot">${icon("security")}Dependabot</button>
          <button data-gh-tab="code-scanning">${icon("policy")}Code scanning</button>
          <button data-gh-tab="secret-scanning">${icon("key")}Secret scanning</button>
          <p>ADMINISTRATION</p>
          <button data-gh-tab="repos">${icon("book_2")}Repositories</button>
          <button data-gh-tab="unprotected">${icon("shield")}Unprotected repos</button>
          <button data-gh-tab="members">${icon("groups")}Members &amp; teams</button>
          <button data-gh-tab="audit">${icon("receipt_long")}Audit log</button>
        </nav>
        <footer><span id="gh-sync-dot"></span><span id="gh-sync">Not synced</span><b id="gh-rate"></b></footer>
      </aside>
      <section class="gh-main"><header class="gh-toolbar">
        <div><h1 id="gh-title">Inbox</h1><small id="gh-subtitle">Everything GitHub wants from you, in one queue.</small></div>
        <label>${icon("search")}<input id="gh-search" placeholder="Filter GitHub…" spellcheck="false"></label>
        <button data-gh-refresh title="Refresh GitHub now">${icon("refresh")}Poll now</button>
        <button class="primary" data-gh-new>${icon("edit_square")}New issue</button>
      </header><div id="gh-content" class="gh-content"></div></section>
      <aside id="gh-detail" class="gh-detail"></aside>
    </div><div id="gh-modal"></div>`;
    host.addEventListener("click", onClick);
    host.querySelector("#gh-search").addEventListener("input", e => { state.query = e.target.value; renderList(); });
    startPolling();
  }

  // Reads state.host rather than closing over one, so suspend can stop the
  // poll and resume can start a fresh one without remounting the page.
  function startPolling() {
    state.timer ||= setInterval(async () => {
      if (state.host?.hidden || !state.status?.authenticated || state.loading || state.tab !== "inbox") return;
      try { state.items = await api("notifications?all=false&participating=false&per_page=100"); state.notice = "Polled just now"; render(); } catch (_) {}
    }, 60_000);
  }

  async function opened() {
    if (!state.host) mount(document.getElementById("github-host"));
    if (!state.host) return;
    if (!state.status) await connect(); else if (!state.items.length) await load();
  }

  async function connect() {
    state.loading = true; render();
    try {
      state.status = await ghInvoke("github_status");
      if (state.status.authenticated) {
        const repos = await api("user/repos?per_page=100&sort=pushed&affiliation=owner,collaborator,organization_member");
        state.repos = Array.isArray(repos) ? repos : [];
        state.orgs = await api("user/orgs?per_page=100").catch(() => []);
        state.org ||= state.orgs[0]?.login || "";
        await load();
      }
    } catch (e) { state.error = String(e); }
    finally { state.loading = false; render(); }
  }

  async function load() {
    if (!state.status?.authenticated) return;
    state.loading = true; state.error = ""; state.accessError = null; state.selected = null; state.detail = null; render();
    try {
      const login = state.status.login;
      if (state.tab === "inbox") state.items = await api("notifications?all=false&participating=false&per_page=100");
      if (state.tab === "reviews") state.items = (await api(`search/issues?q=is:pr+is:open+review-requested:${encodeURIComponent(login)}&per_page=100`)).items || [];
      if (state.tab === "assigned") state.items = (await api(`search/issues?q=is:issue+is:open+assignee:${encodeURIComponent(login)}&per_page=100`)).items || [];
      if (state.tab === "mentions" || state.tab === "subscribed") {
        const all = await api("notifications?all=true&participating=false&per_page=100");
        state.items = all.filter(n => state.tab === "mentions" ? ["mention","team_mention","review_requested"].includes(n.reason) : n.reason === "subscribed");
      }
      if (state.tab === "repos") state.items = state.repos;
      if (state.tab === "actions" || state.tab === "queue") {
        const repos = state.repo ? state.repos.filter(r => r.full_name === state.repo) : state.repos.slice(0, 12);
        const batches = await Promise.all(repos.map(r => api(`repos/${r.full_name}/actions/runs?per_page=10`).catch(() => ({workflow_runs:[]}))));
        state.items = batches.flatMap((b, i) => (b.workflow_runs || []).map(run => ({...run, _repo: repos[i].full_name}))).sort((a,b) => new Date(b.created_at)-new Date(a.created_at));
        if (state.tab === "queue") {
          const runs = state.items.filter(run => run.status !== "completed");
          const runners = await Promise.all(repos.map(r => api(`repos/${r.full_name}/actions/runners?per_page=100`).catch(()=>({runners:[]}))));
          state.items = [...runners.flatMap((result,i)=>(result.runners||[]).map(runner=>({...runner,_repo:repos[i].full_name,_runner:true}))), ...runs];
        }
      }
      if (["dependabot","code-scanning","secret-scanning"].includes(state.tab)) {
        const route = {dependabot:"dependabot/alerts", "code-scanning":"code-scanning/alerts", "secret-scanning":"secret-scanning/alerts"}[state.tab];
        state.items = await acrossRepos(route, 25);
      }
      if (state.tab === "secrets") {
        const repos = chosenRepos(20);
        const batches = await Promise.all(repos.map(async r => {
          const [actions, environments] = await Promise.all([
            api(`repos/${r.full_name}/actions/secrets?per_page=100`).catch(() => ({secrets:[]})),
            api(`repos/${r.full_name}/environments?per_page=100`).catch(() => ({environments:[]})),
          ]);
          return [...(actions.secrets||[]).map(s=>({...s,_repo:r.full_name,_kind:"Actions secret"})), ...(environments.environments||[]).map(v=>({...v,_repo:r.full_name,_kind:"Environment"}))];
        })); state.items = batches.flat();
      }
      if (state.tab === "unprotected") {
        const repos = chosenRepos(30).filter(r => !r.archived && !r.fork);
        const checks = await Promise.all(repos.map(r => api(`repos/${r.full_name}/branches/${encodeURIComponent(r.default_branch)}/protection`).then(()=>null).catch(()=>r)));
        state.items = checks.filter(Boolean);
      }
      if (state.tab === "members") {
        if (!state.org) state.items = [];
        else {
          const [members, teams] = await Promise.all([api(`orgs/${state.org}/members?per_page=100`), api(`orgs/${state.org}/teams?per_page=100`)]);
          state.items = [...members.map(m=>({...m,_kind:"Member"})), ...teams.map(t=>({...t,_kind:"Team"}))];
        }
      }
      if (state.tab === "audit") {
        if (!state.org) state.items = [];
        else try { state.items = await api(`orgs/${state.org}/audit-log?per_page=100&include=all`); }
        catch (error) {
          const message = String(error);
          if (/404|not found/i.test(message)) {
            state.items = [];
            state.accessError = {
              title: "Audit-log access is hidden",
              message: `GitHub returns 404 when the token cannot read ${state.org}'s organization audit log. Organization owners need the admin:org scope.`,
              command: "gh auth refresh -h github.com -s admin:org",
              detail: message,
            };
          } else throw error;
        }
      }
      state.notice = `Synced ${new Date().toLocaleTimeString([], {hour:"2-digit",minute:"2-digit"})}`;
      const rate = await api("rate_limit").catch(() => null); state.rate = rate?.resources?.core || null;
    } catch (e) { state.error = String(e); state.items = []; }
    finally { state.loading = false; render(); }
  }

  function chosenRepos(limit = 20) { return state.repo ? state.repos.filter(r => r.full_name === state.repo) : state.repos.slice(0, limit); }
  async function acrossRepos(route, limit) {
    const repos = chosenRepos(limit);
    const batches = await Promise.all(repos.map(r => api(`repos/${r.full_name}/${route}?per_page=100&state=open`).catch(() => [])));
    return batches.flatMap((rows,i)=>(rows||[]).map(row=>({...row,_repo:repos[i].full_name,_kind:route})));
  }

  function render() {
    if (!state.host) return;
    state.host.querySelector("#gh-sync").textContent = state.notice || (state.loading ? "Syncing…" : "Not synced");
    state.host.querySelector("#gh-sync-dot").className = state.status?.authenticated ? "ok" : "";
    state.host.querySelector("#gh-rate").textContent = state.rate ? `${state.rate.remaining.toLocaleString()} / ${state.rate.limit.toLocaleString()}` : "";
    for (const b of state.host.querySelectorAll("[data-gh-tab]")) b.classList.toggle("on", b.dataset.ghTab === state.tab);
    const labels = {
      inbox:["Inbox","Everything GitHub wants from you, in one queue."], reviews:["Review requests","Pull requests waiting for your review."], assigned:["Assigned to me","Open issues assigned to you."],
      mentions:["Mentions","Threads where you or your team were mentioned."], subscribed:["Subscribed","Updates from threads you follow."], actions:["Workflow runs","Recent Actions runs across your repositories."],
      queue:["Runners & queue","Queued and currently running workflow jobs."], secrets:["Secrets & environments","Actions secrets and deployment environments."], dependabot:["Dependabot","Open vulnerable dependency alerts."],
      "code-scanning":["Code scanning","Open CodeQL and third-party analysis alerts."], "secret-scanning":["Secret scanning","Detected credentials and tokens requiring attention."], repos:["Repositories","Repositories you own or can collaborate on."],
      unprotected:["Unprotected repos","Active repositories whose default branch has no protection rule."], members:["Members & teams","Organization membership and team inventory."], audit:["Audit log","Recent organization administration and security events."]
    };
    state.host.querySelector("#gh-title").textContent = labels[state.tab][0];
    state.host.querySelector("#gh-subtitle").textContent = labels[state.tab][1];
    state.host.querySelector("#gh-inbox-count").textContent = state.tab === "inbox" ? state.items.length : "";
    renderList(); renderDetail();
  }

  function renderList() {
    const box = state.host?.querySelector("#gh-content"); if (!box) return;
    if (!state.status) return void (box.innerHTML = `<div class="gh-state">${icon("progress_activity")}<h2>Checking GitHub CLI</h2></div>`);
    if (!state.status.installed) return void (box.innerHTML = setup("GitHub CLI is required", "Install GitHub CLI, then reopen this tool.", "winget install --id GitHub.cli"));
    if (!state.status.authenticated) return void (box.innerHTML = setup("Connect GitHub", "Authenticate the GitHub CLI in a terminal, then come back and retry.", "gh auth login"));
    if (state.loading) return void (box.innerHTML = `<div class="gh-state">${icon("progress_activity")}<h2>Loading ${esc(state.tab)}…</h2><p>Reading from GitHub through gh.</p></div>`);
    if (state.accessError) return void (box.innerHTML = `<div class="gh-state gh-setup">${icon("admin_panel_settings")}<h2>${esc(state.accessError.title)}</h2><p>${esc(state.accessError.message)}</p><code>${esc(state.accessError.command)}</code><div><button data-gh-copy="${esc(state.accessError.command)}">${icon("content_copy")}Copy command</button><button class="primary" data-gh-refresh>${icon("refresh")}Retry</button></div><small>${esc(state.accessError.detail)}</small></div>`);
    if (state.error) return void (box.innerHTML = `<div class="gh-state error">${icon("error")}<h2>GitHub could not be loaded</h2><p>${esc(state.error)}</p><button data-gh-refresh>Try again</button></div>`);
    let items = state.items.map((item, index) => ({ item, index })).filter(({item}) => JSON.stringify(item).toLowerCase().includes(state.query.toLowerCase()));
    const repoTabs = ["actions","queue","secrets","dependabot","code-scanning","secret-scanning","unprotected"];
    const orgTabs = ["members","audit"];
    const actionFilter = repoTabs.includes(state.tab) ? `<div class="gh-listbar"><select data-gh-repo><option value="">All recent repositories</option>${state.repos.map(r => `<option ${r.full_name===state.repo?"selected":""}>${esc(r.full_name)}</option>`).join("")}</select><span>${items.length} results</span></div>` : orgTabs.includes(state.tab) ? `<div class="gh-listbar"><select data-gh-org>${state.orgs.map(o => `<option ${o.login===state.org?"selected":""}>${esc(o.login)}</option>`).join("")}</select><span>${items.length} results</span></div>` : state.tab === "inbox" ? `<div class="gh-listbar"><button data-gh-read-all>${icon("done_all")}Mark all read</button><span>${items.length} threads</span></div>` : "";
    if (!items.length) return void (box.innerHTML = actionFilter + `<div class="gh-state">${icon("task_alt")}<h2>All clear</h2><p>Nothing matches this view, or your token does not have access to this resource.</p></div>`);
    box.innerHTML = actionFilter + `<div class="gh-list">${items.map(({item,index}) => row(item,index)).join("")}</div>`;
    box.querySelector("[data-gh-repo]")?.addEventListener("change", e => { state.repo=e.target.value; load(); });
    box.querySelector("[data-gh-org]")?.addEventListener("change", e => { state.org=e.target.value; load(); });
  }

  function setup(title, text, command) {
    return `<div class="gh-state gh-setup">${icon("account_tree")}<h2>${title}</h2><p>${text}</p><code>${command}</code><div><button data-gh-copy="${esc(command)}">${icon("content_copy")}Copy command</button><button class="primary" data-gh-connect>${icon("refresh")}I've authenticated</button></div>${state.status?.error ? `<small>${esc(state.status.error)}</small>`:""}</div>`;
  }

  function row(item, i) {
    if (state.tab === "repos" || state.tab === "unprotected") return `<button class="gh-row ${state.selected===i?"on":""}" data-gh-item="${i}">${icon(state.tab==="unprotected"?"gpp_bad":item.private?"lock":"book_2")}<div><strong>${esc(item.full_name)}</strong><small>${esc(item.description || (state.tab==="unprotected"?`Default branch: ${item.default_branch}`:"No description"))}</small><span>${item.language?esc(item.language)+" · ":""}★ ${item.stargazers_count || 0} · ${item.open_issues_count || 0} open</span></div><time>${rel(item.pushed_at)}</time></button>`;
    if (state.tab === "actions" || state.tab === "queue") { if(item._runner) return `<button class="gh-row ${state.selected===i?"on":""}" data-gh-item="${i}">${icon(item.busy?"memory":"dns")}<div><small>${esc(item._repo)} · self-hosted runner</small><strong>${esc(item.name)}</strong><span>${esc(item.os)} · ${esc(item.status)}${item.busy?" · busy":" · idle"}</span></div><time></time></button>`; const bad=item.conclusion==="failure"||item.conclusion==="cancelled"; return `<button class="gh-row ${state.selected===i?"on":""}" data-gh-item="${i}">${icon(bad?"cancel":item.status==="completed"?"check_circle":"progress_activity")}<div><small>${esc(item._repo)}</small><strong>${esc(item.name || item.display_title)}</strong><span>${esc(item.head_branch || "")} · ${esc(item.event)} · ${esc(item.conclusion || item.status)}</span></div><time>${rel(item.created_at)}</time></button>`; }
    if (["dependabot","code-scanning","secret-scanning"].includes(state.tab)) {
      const title = item.dependency?.package?.name || item.rule?.description || item.secret_type_display_name || item.secret_type || "Security alert";
      const severity = item.security_advisory?.severity || item.rule?.security_severity_level || item.resolution || "open";
      return `<button class="gh-row danger ${state.selected===i?"on":""}" data-gh-item="${i}">${icon("shield_with_heart")}<div><small>${esc(item._repo)}</small><strong>${esc(title)}</strong><span><i>${esc(severity)}</i> · ${esc(item.state||"open")} ${item.number?`· #${item.number}`:""}</span></div><time>${rel(item.updated_at||item.created_at)}</time></button>`;
    }
    if (state.tab === "secrets") return `<button class="gh-row ${state.selected===i?"on":""}" data-gh-item="${i}">${icon(item._kind==="Environment"?"deployed_code":"key")}<div><small>${esc(item._repo)}</small><strong>${esc(item.name)}</strong><span>${esc(item._kind)}${item.updated_at?` · updated ${rel(item.updated_at)}`:""}</span></div><time></time></button>`;
    if (state.tab === "members") return `<button class="gh-row ${state.selected===i?"on":""}" data-gh-item="${i}">${icon(item._kind==="Team"?"group_work":"account_circle")}<div><small>${esc(item._kind)}</small><strong>${esc(item.login||item.name)}</strong><span>${esc(item.description||item.slug||item.type||"")}</span></div><time></time></button>`;
    if (state.tab === "audit") return `<button class="gh-row ${state.selected===i?"on":""}" data-gh-item="${i}">${icon("history")}<div><small>${esc(item.repo||item.org||state.org)}</small><strong>${esc(item.action||"Audit event")}</strong><span>${esc(item.actor||"")} ${item.user?`· ${esc(item.user)}`:""}</span></div><time>${item.created_at?rel(item.created_at):""}</time></button>`;
    const notification = !!item.subject;
    const repo = notification ? item.repository?.full_name : repoName(item.repository_url);
    const title = notification ? item.subject.title : item.title;
    const reason = notification ? item.reason.replaceAll("_"," ") : (item.pull_request ? "review requested" : "assigned");
    return `<button class="gh-row ${notification&&!item.unread?"read":""} ${state.selected===i?"on":""}" data-gh-item="${i}">${icon(notification?subjectIcon(item.subject.type):(item.pull_request?"merge":"adjust"))}<div><small>${esc(repo)}</small><strong>${esc(title)}</strong><span><i>${esc(reason)}</i> · ${notification?rel(item.updated_at):`#${item.number} · ${rel(item.updated_at)}`}</span></div><time>${rel(item.updated_at)}</time></button>`;
  }
  const subjectIcon = type => ({PullRequest:"merge",Issue:"adjust",Release:"sell",CheckSuite:"fact_check",Discussion:"forum"}[type] || "notifications");

  async function select(i) {
    state.selected = i; const item = state.items[i]; state.detail = null; render();
    try {
      if (item.subject) {
        state.detail = await api(endpoint(item.subject.url));
        if (item.unread) { await api(`notifications/threads/${item.id}`, "PATCH"); item.unread = false; }
      } else if (["actions","queue","repos","unprotected","secrets","dependabot","code-scanning","secret-scanning","members","audit"].includes(state.tab)) state.detail = item;
      else state.detail = await api(endpoint(item.pull_request?.url || item.url));
      if (state.detail?.head && state.detail?.statuses_url) {
        const repo = repoName(state.detail.url), n = state.detail.number;
        const [checks,reviews] = await Promise.all([api(`repos/${repo}/commits/${state.detail.head.sha}/check-runs?per_page=100`).catch(()=>({check_runs:[]})), api(`repos/${repo}/pulls/${n}/reviews?per_page=100`).catch(()=>[])]);
        state.detail._checks = checks.check_runs || []; state.detail._reviews = reviews || [];
      }
    } catch (e) { state.detail = {_error:String(e)}; }
    renderDetail(); renderList();
  }

  function renderDetail() {
    const box = state.host?.querySelector("#gh-detail"); if (!box) return;
    if (state.selected == null) return void (box.innerHTML = `<div class="gh-detail-empty">${icon("touch_app")}<span>Select an item to inspect it</span></div>`);
    const item = state.items[state.selected], d = state.detail;
    if (!d) return void (box.innerHTML = `<div class="gh-detail-empty">${icon("progress_activity")}<span>Loading details…</span></div>`);
    if (d._error) return void (box.innerHTML = `<div class="gh-detail-empty error">${icon("error")}<span>${esc(d._error)}</span></div>`);
    if (d._runner) return void(box.innerHTML=detailHeader("Self-hosted runner",d._repo,d.name)+`<dl>${kv("Status",d.status)}${kv("Busy",d.busy?"yes":"no")}${kv("Operating system",d.os)}${kv("Labels",(d.labels||[]).map(l=>l.name).join(", "))}</dl>`);
    if (state.tab === "actions" || state.tab === "queue") return void (box.innerHTML = detailHeader("Workflow run", item._repo, d.display_title || d.name, d.html_url) + `<dl>${kv("Status",d.status)}${kv("Conclusion",d.conclusion||"running")}${kv("Branch",d.head_branch)}${kv("Event",d.event)}${kv("Actor",d.actor?.login)}${kv("Attempt",d.run_attempt)}</dl><footer><button data-gh-rerun>${icon("replay")}Rerun</button><button data-gh-cancel-run>${icon("stop_circle")}Cancel</button><button data-gh-browser="${esc(d.html_url)}">${icon("open_in_new")}Open</button></footer>`);
    if (state.tab === "repos" || state.tab === "unprotected") {
      const local = localProject(d.full_name);
      const localActions = local ? `<button data-gh-project="${esc(d.full_name)}">${icon("folder_open")}Project details</button><button data-gh-git="${esc(d.full_name)}">${icon("commit")}Open in Git</button>` : "";
      return void (box.innerHTML = detailHeader(state.tab==="unprotected"?"Unprotected default branch":d.private?"Private repository":"Repository", d.owner?.login, d.name, d.html_url) + `<p class="gh-body">${esc(d.description||"No description")}</p><dl>${kv("Default branch",d.default_branch)}${kv("Language",d.language||"—")}${kv("Visibility",d.visibility)}${kv("Stars",d.stargazers_count)}${kv("Forks",d.forks_count)}${kv("Issues",d.open_issues_count)}${local?kv("Local project",local.path):""}</dl><footer>${state.tab==="unprotected"?`<button class="primary" data-gh-protect>${icon("verified_user")}Add basic protection</button>`:""}${localActions}<button data-gh-browser="${esc(d.html_url)}">${icon("open_in_new")}Open repository</button></footer>`);
    }
    if (["dependabot","code-scanning","secret-scanning"].includes(state.tab)) { const title=d.dependency?.package?.name||d.rule?.description||d.secret_type_display_name||d.secret_type||"Security alert"; return void(box.innerHTML=detailHeader("Security alert",d._repo,title,d.html_url)+`<p class="gh-body">${esc(d.security_advisory?.description||d.rule?.description||d.resolution_comment||"Investigate this alert in GitHub.")}</p><dl>${kv("State",d.state)}${kv("Severity",d.security_advisory?.severity||d.rule?.security_severity_level)}${kv("Location",d.most_recent_instance?.location?.path||d.locations_url)}${kv("Created",d.created_at?new Date(d.created_at).toLocaleString():"—")}</dl><footer><button data-gh-browser="${esc(d.html_url)}">${icon("open_in_new")}Investigate</button></footer>`); }
    if (state.tab === "secrets") return void(box.innerHTML=detailHeader(d._kind,d._repo,d.name,d.html_url)+`<dl>${kv("Repository",d._repo)}${kv("Kind",d._kind)}${kv("Created",d.created_at?new Date(d.created_at).toLocaleString():"—")}${kv("Updated",d.updated_at?new Date(d.updated_at).toLocaleString():"—")}</dl>`);
    if (state.tab === "members") return void(box.innerHTML=detailHeader(d._kind,state.org,d.login||d.name,d.html_url)+`<p class="gh-body">${esc(d.description||"")}</p><dl>${kv("Type",d.type||d._kind)}${kv("Slug",d.slug)}${kv("Privacy",d.privacy)}${kv("Members",d.members_count)}${kv("Repositories",d.repos_count)}</dl><footer>${d.html_url?`<button data-gh-browser="${esc(d.html_url)}">${icon("open_in_new")}Open</button>`:""}</footer>`);
    if (state.tab === "audit") return void(box.innerHTML=detailHeader("Audit event",d.org||state.org,d.action)+`<dl>${Object.entries(d).slice(0,18).map(([k,v])=>kv(k,typeof v==="object"?JSON.stringify(v):v)).join("")}</dl>`);
    const repo = item.repository?.full_name || repoName(d.url), isPr = !!d.head;
    const threadActions = item.subject ? `<button data-gh-thread-done>${icon("done")}Done</button><button data-gh-unsubscribe>${icon("notifications_off")}Unsubscribe</button>` : "";
    const checks = isPr ? `<section class="gh-detail-section"><h3>Checks</h3>${(d._checks||[]).length?(d._checks||[]).map(c=>`<div>${icon(c.conclusion==="success"?"check_circle":c.conclusion==="failure"?"cancel":"progress_activity")}<span>${esc(c.name)}</span><b>${esc(c.conclusion||c.status)}</b></div>`).join(""):"<small>No checks reported</small>"}</section><section class="gh-detail-section"><h3>Reviewers</h3>${(d._reviews||[]).length?(d._reviews||[]).map(r=>`<div>${icon(r.state==="APPROVED"?"check_circle":r.state==="CHANGES_REQUESTED"?"error":"comment")}<span>${esc(r.user?.login)}</span><b>${esc(r.state)}</b></div>`).join(""):"<small>No submitted reviews</small>"}</section>` : "";
    box.innerHTML = detailHeader(isPr?"Pull request":"Issue", repo, d.title, d.html_url) + `<div class="gh-badges"><i>${esc(d.state)}</i>${d.draft?"<i>draft</i>":""}${(d.labels||[]).map(l=>`<i>${esc(l.name)}</i>`).join("")}</div><p class="gh-body">${esc(d.body||"No description provided.")}</p><dl>${kv("Author",d.user?.login)}${isPr?kv("Branches",`${d.head?.ref} → ${d.base?.ref}`):""}${isPr?kv("Changes",`+${d.additions||0} −${d.deletions||0} · ${d.changed_files||0} files`):""}${kv("Comments",d.comments||0)}${kv("Updated",new Date(d.updated_at).toLocaleString())}</dl>${checks}<footer>${isPr?`<button class="primary" data-gh-review="APPROVE">${icon("thumb_up")}Approve</button><button data-gh-review="REQUEST_CHANGES">${icon("rate_review")}Request changes</button><button data-gh-merge>${icon("merge")}Merge</button>`:""}${threadActions}<button data-gh-git="${esc(repo)}">${icon("commit")}Local Git</button><button data-gh-browser="${esc(d.html_url)}">${icon("open_in_new")}Open</button></footer>`;
  }
  const detailHeader = (kind, repo, title, url) => `<header><span>${esc(kind)}</span><small>${esc(repo||"")}</small><h2>${esc(title||"")}</h2></header>`;
  const kv = (k,v) => `<div><dt>${esc(k)}</dt><dd>${esc(v ?? "—")}</dd></div>`;

  async function mutate(endpointValue, method, body, success) {
    try { await api(endpointValue, method, body); state.notice=success; await load(); }
    catch(e) { state.error=String(e); render(); }
  }

  function newIssue() {
    const options = state.repos.map(r=>`<option>${esc(r.full_name)}</option>`).join("");
    state.host.querySelector("#gh-modal").innerHTML = `<div class="gh-overlay"><form class="gh-dialog"><header><h2>New issue</h2><button type="button" data-gh-modal-close>${icon("close")}</button></header><label>Repository<select name="repo" required><option value="">Choose repository…</option>${options}</select></label><label>Title<input name="title" required autofocus></label><label>Description<textarea name="body" rows="8"></textarea></label><footer><button type="button" data-gh-modal-close>Cancel</button><button class="primary">Create issue</button></footer></form></div>`;
    state.host.querySelector(".gh-dialog").addEventListener("submit", async e => { e.preventDefault(); const f=new FormData(e.target); await mutate(`repos/${f.get("repo")}/issues`,"POST",{title:f.get("title"),body:f.get("body")},"Issue created"); state.host.querySelector("#gh-modal").innerHTML=""; });
  }

  function onClick(e) {
    const pop=e.target.closest("[data-popout-tool]"); if(pop){window.wintShell?.popOutTool?.(pop.dataset.popoutTool);return;}
    const pin=e.target.closest("[data-pin-tool]"); if(pin){window.wintShell?.toggleToolPin?.(pin.dataset.pinTool);return;}
    const go=e.target.closest("[data-open-tool]"); if(go){window.wintShell?.openTool?.(go.dataset.openTool);return;}
    const tab=e.target.closest("[data-gh-tab]"); if(tab){state.tab=tab.dataset.ghTab;load();return;}
    const item=e.target.closest("[data-gh-item]"); if(item){select(Number(item.dataset.ghItem));return;}
    if(e.target.closest("[data-gh-refresh]")){state.status?.authenticated?load():connect();return;}
    if(e.target.closest("[data-gh-connect]")){connect();return;}
    const copy=e.target.closest("[data-gh-copy]"); if(copy){window.wintCopy.copy(copy.dataset.ghCopy,copy).catch(()=>{});return;}
    if(e.target.closest("[data-gh-new]")){newIssue();return;}
    if(e.target.closest("[data-gh-read-all]")){mutate("notifications","PUT",null,"All notifications marked read");return;}
    if(e.target.closest("[data-gh-modal-close]")){state.host.querySelector("#gh-modal").innerHTML="";return;}
    const browser=e.target.closest("[data-gh-browser]"); if(browser){ghInvoke("plugin:opener|open_url",{url:browser.dataset.ghBrowser});return;}
    const project=e.target.closest("[data-gh-project]"); if(project){window.dispatchEvent(new CustomEvent("wint:open-github-project",{detail:{repo:project.dataset.ghProject}}));return;}
    const git=e.target.closest("[data-gh-git]"); if(git){window.dispatchEvent(new CustomEvent("wint:open-git-repo",{detail:{repo:git.dataset.ghGit}}));return;}
    const d=state.detail, repo=repoName(d?.url);
    const review=e.target.closest("[data-gh-review]"); if(review&&d) mutate(`repos/${repo}/pulls/${d.number}/reviews`,"POST",{event:review.dataset.ghReview,body:"Reviewed from WinT"},"Review submitted");
    if(e.target.closest("[data-gh-merge]")&&d&&confirm(`Squash and merge #${d.number}?`)) mutate(`repos/${repo}/pulls/${d.number}/merge`,"PUT",{merge_method:"squash"},"Pull request merged");
    if(e.target.closest("[data-gh-rerun]")&&d) mutate(`repos/${state.items[state.selected]._repo}/actions/runs/${d.id}/rerun`,"POST",null,"Workflow rerun requested");
    if(e.target.closest("[data-gh-cancel-run]")&&d&&confirm(`Cancel workflow run ${d.id}?`)) mutate(`repos/${state.items[state.selected]._repo}/actions/runs/${d.id}/cancel`,"POST",null,"Workflow cancellation requested");
    if(e.target.closest("[data-gh-protect]")&&d&&confirm(`Require one approving review on ${d.default_branch}?`)) mutate(`repos/${d.full_name}/branches/${encodeURIComponent(d.default_branch)}/protection`,"PUT",{required_status_checks:null,enforce_admins:false,required_pull_request_reviews:{required_approving_review_count:1},restrictions:null},"Branch protection enabled");
    const thread=state.items[state.selected];
    if(e.target.closest("[data-gh-thread-done]")&&thread?.id) mutate(`notifications/threads/${thread.id}`,"DELETE",null,"Thread marked done");
    if(e.target.closest("[data-gh-unsubscribe]")&&thread?.id&&confirm("Unsubscribe from this GitHub thread?")) mutate(`notifications/threads/${thread.id}/subscription`,"DELETE",null,"Unsubscribed from thread");
  }

  function exportState(){const {host,timer,...rest}=state;return rest;}
  function importState(saved){if(!saved)return;Object.assign(state,saved,{host:state.host,timer:state.timer});if(state.host){const q=state.host.querySelector("#gh-search");if(q)q.value=state.query||"";render();}}
  // Kept alive but off screen: stop polling GitHub for notifications. The
  // timer is recreated by mount(), so resume goes back through opened().
  function suspend() { clearInterval(state.timer); state.timer = 0; }
  async function resume() { await opened(); startPolling(); }

  window.wintGithub = { mount, opened, suspend, resume, exportState, importState };
})();
