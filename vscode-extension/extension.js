// WinT's terminal in a VS Code panel.
//
// The terminal is the same one WinT draws: `terminal.js` from WinT's front end
// runs unchanged in a webview, and the sessions behind it are WinT's own
// engine, running in `wint-term-host.exe`. That host is started here, one per
// VS Code window, and spoken to in JSON lines over its stdin and stdout. WinT
// itself is never involved - it does not need to be installed or running.
//
// The webview thinks it is inside WinT. `panel.js` gives it a stand-in for
// `window.__TAURI__` that posts every `invoke` here, and this file answers it
// from the host - see `invoke` below for the handful of commands that exist.

const vscode = require("vscode");
const childProcess = require("child_process");
const crypto = require("crypto");
const fs = require("fs");
const os = require("os");
const path = require("path");

const VIEW_ID = "wint.terminal";
const TABS_KEY = "wint.terminal.tabs.v1";

/** The first of several places that exists. A packaged extension carries its
 *  own copies; one run from this repository uses WinT's directly, so editing
 *  `src/terminal.js` shows up on the next reload without a build. */
function firstExisting(candidates) {
  return candidates.find((candidate) => fs.existsSync(candidate)) || null;
}

function hostExe(root) {
  return firstExisting([
    path.join(root, "bin", "wint-term-host.exe"),
    path.join(root, "..", "src-tauri", "target", "release", "wint-term-host.exe"),
    path.join(root, "..", "src-tauri", "target", "debug", "wint-term-host.exe"),
  ]);
}

function wintFrontEnd(root) {
  const packaged = path.join(root, "media", "wint");
  if (fs.existsSync(path.join(packaged, "terminal.js"))) return packaged;
  const repo = path.join(root, "..", "src");
  return fs.existsSync(path.join(repo, "terminal.js")) ? repo : null;
}

/** The host process and the requests waiting on it. */
class Host {
  constructor(exe, historyFolder, onEvent, onExit) {
    this.pending = new Map();
    this.seq = 0;
    this.buffer = "";
    this.onEvent = onEvent;
    this.process = childProcess.spawn(exe, ["--history-folder", historyFolder], {
      windowsHide: true,
      stdio: ["pipe", "pipe", "pipe"],
    });
    this.process.stdout.setEncoding("utf8");
    this.process.stdout.on("data", (chunk) => this.read(chunk));
    this.process.stderr.on("data", () => {});
    this.process.on("exit", (code) => {
      for (const { reject } of this.pending.values()) reject(new Error("The terminal host stopped."));
      this.pending.clear();
      this.process = null;
      onExit(code);
    });
    this.process.on("error", () => {});
  }

  read(chunk) {
    this.buffer += chunk;
    let end;
    while ((end = this.buffer.indexOf("\n")) >= 0) {
      const line = this.buffer.slice(0, end);
      this.buffer = this.buffer.slice(end + 1);
      if (!line) continue;
      // Events are most of the traffic and only the webview reads them, so
      // they are handed on as the text they arrived as and parsed once, there.
      if (line.startsWith('{"event"')) {
        this.onEvent(line);
        continue;
      }
      let reply;
      try { reply = JSON.parse(line); } catch { continue; }
      const waiting = this.pending.get(reply.id);
      if (!waiting) continue;
      this.pending.delete(reply.id);
      if (reply.error !== undefined) waiting.reject(new Error(reply.error));
      else waiting.resolve(reply.ok === undefined ? null : reply.ok);
    }
  }

  request(cmd, args = {}) {
    if (!this.process) return Promise.reject(new Error("The terminal host is not running."));
    const id = ++this.seq;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.process.stdin.write(JSON.stringify({ id, cmd, args }) + "\n");
    });
  }

  stop() {
    if (this.process) this.process.stdin.end();
  }
}

class TerminalPanel {
  constructor(context) {
    this.context = context;
    this.root = context.extensionPath;
    this.view = null;
    this.host = null;
    this.hostFailure = "";
    /** Every terminal the panel shows, in tab order: `{ id, key, cwd, shell }`.
     *  `id` is the live session; `key` names its kept stream across reloads. */
    this.tabs = [];
    this.active = null;
    this.restored = null;
  }

  get settings() {
    const config = vscode.workspace.getConfiguration("wintTerminal");
    return {
      defaultShell: config.get("defaultShell", "auto"),
      enhancedHistorySearch: config.get("enhancedHistorySearch", true),
      keepScrollback: config.get("keepScrollback", true),
      keysForVSCode: config.get("keysForVSCode", []),
    };
  }

  /** One stream folder per workspace, so two VS Code windows never prune each
   *  other's terminals. */
  historyFolder() {
    const identity = vscode.workspace.workspaceFile?.toString()
      || vscode.workspace.workspaceFolders?.[0]?.uri.toString()
      || "no-folder";
    const hash = crypto.createHash("sha256").update(identity).digest("hex").slice(0, 16);
    return `vscode-sessions/${hash}`;
  }

  ensureHost() {
    if (this.host?.process) return this.host;
    const exe = hostExe(this.root);
    if (!exe) {
      this.hostFailure = "wint-term-host.exe is missing from this extension.";
      return null;
    }
    this.hostFailure = "";
    this.host = new Host(
      exe,
      this.historyFolder(),
      (line) => this.post({ type: "event", raw: line }),
      () => {
        // Every session lived in that process, so every tab is now a terminal
        // that has ended. The next boot starts a fresh host and reopens them.
        for (const tab of this.tabs) tab.id = null;
        this.host = null;
        this.post({ type: "host-stopped" });
      },
    );
    return this.host;
  }

  post(message) {
    this.view?.webview.postMessage(message);
  }

  /** The folder a new terminal opens in: the workspace folder of the file
   *  being edited, the first workspace folder, or home. */
  defaultCwd() {
    const active = vscode.window.activeTextEditor?.document.uri;
    const folder = (active && vscode.workspace.getWorkspaceFolder(active))
      || vscode.workspace.workspaceFolders?.[0];
    return folder?.uri.scheme === "file" ? folder.uri.fsPath : os.homedir();
  }

  saveTabs() {
    const keep = this.settings.keepScrollback;
    const saved = keep ? this.tabs.map(({ key, cwd, shell }) => ({ key, cwd, shell })) : [];
    this.context.workspaceState.update(TABS_KEY, saved);
  }

  async openSession(tab, cols, rows) {
    const host = this.ensureHost();
    if (!host) throw new Error(this.hostFailure);
    const info = await host.request("open", {
      projectPath: tab.cwd,
      shell: tab.shell,
      cols,
      rows,
      historyKey: this.settings.keepScrollback ? tab.key : null,
    });
    tab.id = info.id;
    return info;
  }

  /** What the webview is handed when it (re)loads: every tab, each with a
   *  live session behind it. Tabs from the last time VS Code was open are
   *  reopened here with their kept streams, so they come back with what they
   *  printed. */
  async boot({ cols, rows }) {
    if (!this.restored) {
      this.restored = true;
      const saved = this.settings.keepScrollback ? this.context.workspaceState.get(TABS_KEY, []) : [];
      this.tabs = saved
        .filter((tab) => tab && typeof tab.key === "string")
        .map((tab) => ({ id: null, key: tab.key, cwd: tab.cwd, shell: tab.shell || "auto" }));
      const host = this.ensureHost();
      if (host && this.settings.keepScrollback) {
        host.request("prune", { keys: this.tabs.map((tab) => tab.key) }).catch(() => {});
      }
    }
    for (const tab of this.tabs) {
      if (tab.id) continue;
      if (!fs.existsSync(tab.cwd || "")) tab.cwd = this.defaultCwd();
      try { await this.openSession(tab, cols, rows); } catch { /* shown as a failed tab */ }
    }
    this.tabs = this.tabs.filter((tab) => tab.id);
    if (!this.tabs.length) {
      try { await this.newTab({ cols, rows }); } catch (error) {
        return { tabs: [], settings: this.settings, error: error.message || this.hostFailure };
      }
    }
    this.saveTabs();
    return { tabs: this.tabs, active: this.active, settings: this.settings };
  }

  async newTab({ shell, cols, rows } = {}) {
    const tab = {
      id: null,
      key: crypto.randomUUID(),
      cwd: this.defaultCwd(),
      shell: shell || this.settings.defaultShell,
    };
    await this.openSession(tab, cols || 80, rows || 24);
    this.tabs.push(tab);
    this.active = tab.id;
    this.saveTabs();
    return tab;
  }

  async closeTab(id) {
    this.tabs = this.tabs.filter((tab) => tab.id !== id);
    this.saveTabs();
    await this.host?.request("close", { id }).catch(() => {});
  }

  /** Everything the webview can ask for. The `term_*` names are the ones
   *  `terminal.js` already invokes inside WinT; `panel_*` are the panel's own. */
  async invoke(cmd, args = {}) {
    const host = cmd.startsWith("panel_") ? null : this.ensureHost();
    switch (cmd) {
      case "panel_boot": return this.boot(args);
      case "panel_new": return this.newTab(args);
      case "panel_close": return this.closeTab(args.id);
      case "panel_activate": this.active = args.id; return null;
      case "panel_shells": return this.ensureHost()?.request("shells") ?? [];
      case "term_attach": return host.request("attach", { id: args.id });
      case "term_write": return host.request("write", { id: args.id, data: args.data });
      case "term_resize": return host.request("resize", { id: args.id, cols: args.cols, rows: args.rows });
      case "term_command_history": return host.request("history");
      case "plugin:opener|open_url": {
        if (/^https?:\/\//i.test(args.url || "")) await vscode.env.openExternal(vscode.Uri.parse(args.url));
        return null;
      }
      default: throw new Error(`Unknown command: ${cmd}`);
    }
  }

  resolveWebviewView(view) {
    this.view = view;
    const frontEnd = wintFrontEnd(this.root);
    const media = vscode.Uri.file(path.join(this.root, "media"));
    view.webview.options = {
      enableScripts: true,
      localResourceRoots: frontEnd ? [media, vscode.Uri.file(frontEnd)] : [media],
    };
    view.webview.html = this.html(view.webview, frontEnd);
    view.webview.onDidReceiveMessage(async (message) => {
      if (message?.type !== "invoke") return;
      try {
        const ok = await this.invoke(message.cmd, message.args || {});
        this.post({ type: "reply", id: message.id, ok: ok === undefined ? null : ok });
      } catch (error) {
        this.post({ type: "reply", id: message.id, error: String(error?.message || error) });
      }
    });
    view.onDidDispose(() => {
      // The sessions stay in the host; the next time the panel is shown it
      // attaches to them again, exactly as a WinT window does.
      if (this.view === view) this.view = null;
    });
  }

  html(webview, frontEnd) {
    const nonce = crypto.randomBytes(16).toString("base64");
    const uri = (...parts) => webview.asWebviewUri(vscode.Uri.file(path.join(...parts))).toString();
    const csp = [
      "default-src 'none'",
      `style-src ${webview.cspSource} 'unsafe-inline'`,
      `font-src ${webview.cspSource}`,
      `img-src ${webview.cspSource} data:`,
      `script-src 'nonce-${nonce}'`,
    ].join("; ");
    if (!frontEnd) {
      return `<!doctype html><html><head><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="${csp}"></head>
<body style="font-family:var(--vscode-font-family);padding:12px">This copy of WinT Terminal is missing its terminal view (media/wint/terminal.js).</body></html>`;
    }
    return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="${csp}">
<meta name="viewport" content="width=device-width, initial-scale=1">
<link rel="stylesheet" href="${uri(frontEnd, "styles.css")}">
<link rel="stylesheet" href="${uri(this.root, "media", "panel.css")}">
</head>
<body class="wint-vscode">
<div id="tabs" role="tablist"></div>
<div id="views"></div>
<div id="notice" hidden></div>
<script nonce="${nonce}" src="${uri(this.root, "media", "bridge.js")}"></script>
<script nonce="${nonce}" src="${uri(frontEnd, "terminal.js")}"></script>
<script nonce="${nonce}" src="${uri(this.root, "media", "panel.js")}"></script>
</body>
</html>`;
  }

  dispose() {
    this.host?.stop();
  }
}

function activate(context) {
  const panel = new TerminalPanel(context);
  context.subscriptions.push(
    vscode.window.registerWebviewViewProvider(VIEW_ID, panel, {
      // The terminal's DOM is its scrollback and its selection. Rebuilding it
      // every time the panel is hidden would lose both for nothing.
      webviewOptions: { retainContextWhenHidden: true },
    }),
    vscode.commands.registerCommand("wint.terminal.new", async () => {
      await vscode.commands.executeCommand(`${VIEW_ID}.focus`);
      panel.post({ type: "command", name: "new" });
    }),
    vscode.commands.registerCommand("wint.terminal.focus", () =>
      vscode.commands.executeCommand(`${VIEW_ID}.focus`)),
    vscode.workspace.onDidChangeConfiguration((event) => {
      if (event.affectsConfiguration("wintTerminal")) {
        panel.post({ type: "settings", settings: panel.settings });
      }
    }),
    { dispose: () => panel.dispose() },
  );
}

function deactivate() {}

module.exports = { activate, deactivate };
