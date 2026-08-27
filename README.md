# DevHQ

A native Windows desktop app that gives a developer-oriented overview of every
project in a folder: what's dirty, what's running, what it's built with.

Same stack as `aivideo-player` — **Tauri 2 + Rust backend + vanilla JS/CSS front
end**, no bundler and no framework.

## Running it

```bash
npm install
npm run dev      # dev window with hot reload of src/
npm run build    # bundled installer in src-tauri/target/release/bundle/
```

Point the folder box at your code root (it defaults to `C:\code`, `C:\dev`,
`C:\src` or `C:\projects`, whichever exists first) and press Enter or *Rescan*.

## What it reports per project

**Git** — branch and upstream, staged / modified / untracked counts with the
full changed-file list, ahead & behind, merge conflicts, stashes, local
branches, the origin remote, last commit (hash, author, subject, age) and the
30-day commit count. Non-repos are flagged as such.

**Running** — which processes belong to the project and which TCP ports they
listen on. See *How "running" is decided* below.

**Tech and versions** — runtime, language, framework, UI, build, data, test and
infra tags with the version declared in the manifest, read from `package.json`,
`Cargo.toml`, `src-tauri/tauri.conf.json`, `pyproject.toml` / `requirements.txt`,
`go.mod`, `*.csproj`, `pom.xml`, `app.json` and friends. Also the package
manager (from the lockfile), dependency counts, npm scripts, and the project
version.

**Housekeeping** — missing README, uninstalled `node_modules`, a `.env` in the
tree, presence of a `CLAUDE.md`.

## Terminals

Every project can open a shell in its own folder, in a dock at the bottom of the
window. The terminal button on a card or in the detail drawer opens one,
``Ctrl+` `` toggles the panel, and the tab strip shows one tab per session
labelled with the project it belongs to. *External shell* still opens a separate
console window instead, as before.

A session can be **popped out** into its own window and docked back again. The
shell does not restart either way: the pseudoconsole, the child process and the
screen all live in Rust, keyed by session id, and a webview is only ever a view
onto one. Popping out creates a second window that calls `term_attach` and is
handed the current screen; docking back closes that window and remounts the same
session in the panel. A build running when you pop the terminal out is still
running when it lands.

Closing DevHQ kills every session, so no shell outlives the window that owned it.

### How it works

There is no terminal dependency — not a pty crate, not xterm.js. The whole stack
is `windows` (Microsoft's own bindings, already used for reading process working
directories) plus DevHQ's own code:

| Path | Purpose |
| --- | --- |
| `src-tauri/src/conpty.rs` | `CreatePseudoConsole` and the `STARTUPINFOEX` dance that attaches a child to it. |
| `src-tauri/src/vt.rs` | VT/ANSI parser and screen grid — escape sequences in, cells out. |
| `src-tauri/src/term.rs` | Session registry, the `term_*` commands, and row updates over Tauri events. |
| `src/terminal.js` | `TermView` — paints cells, encodes keystrokes. Used by both the panel and the pop-out window. |
| `src/terminals.js` | The dock: tabs, sizing, pop out and dock back. |
| `src/terminal.html`, `src/popout.js` | The popped-out window. |

The parser can stay narrow because ConPTY is not a Unix pty: it keeps its own
screen buffer, normalises what the child emits and sends a well-behaved diff, so
the long tail of legacy terminal quirks never arrives. The front end never sees
an escape sequence — it receives rows already resolved into coloured runs, which
is also why attaching a second view is a single snapshot rather than a replay.

## Filtering

Chips filter by uncommitted / running / unpushed / behind / no remote / not a
repo / stashed / stale (90d+), with live counts. The search box matches name,
group, description, path, branch, remote, tech and port — space-separated terms
are ANDed. The dropdowns filter by a single technology and change the sort
(recent activity, name, most changes, running first, tech). Clicking any tech
tag filters by it.

Selections persist in `localStorage`. `Ctrl+F` focuses search, `F5` rescans,
`Esc` closes the detail drawer.

## How "running" is decided

A command line alone can't tell you which project a dev server belongs to —
`npm run dev` and `node server.js` both show up with relative paths. So DevHQ
reads each process's actual working directory out of its PEB
([`src-tauri/src/cwd.rs`](src-tauri/src/cwd.rs)), the same route Process
Explorer takes, since Windows exposes no API for it.

A process is attributed to a project when its cwd is inside the project folder,
when its command line or image path points inside it, or when it descends from
a process that matched — the last case catches the worker that actually holds
the port. Shells, terminals, editors and coding agents are then dropped, unless
they hold a listening port, so an open terminal doesn't read as "running".

Listening ports come from `netstat -ano` matched by PID.

## Discovery

Direct children of the scan root are projects if they contain a `.git` or any
build manifest. A folder that is only a container is descended into one extra
level, and its children are shown grouped under its name. `node_modules`,
`target`, `dist` and similar are never entered.

Projects are inspected across a 12-thread pool; the work is dominated by waiting
on `git`, so a few hundred folders scan in a few seconds.

## Layout

| Path | Purpose |
| --- | --- |
| `src/` | Front end — `index.html`, `app.js`, `styles.css`. Served directly, no build step. |
| `src-tauri/src/lib.rs` | Discovery, per-project assembly, Tauri commands. |
| `src-tauri/src/git.rs` | `git status --porcelain=v2` and friends. |
| `src-tauri/src/tech.rs` | Manifest parsing and tech/version detection. |
| `src-tauri/src/procs.rs` | Process/port snapshot and project attribution. |
| `src-tauri/src/cwd.rs` | Reading another process's working directory. |
| `src-tauri/examples/scan_cli.rs` | Headless scan, prints JSON. |
| `scripts/make-icon.js` | Regenerates the source app icon. |

## Headless scan

Useful for checking the scanner without opening the window:

```bash
cd src-tauri
cargo run --example scan_cli -- "C:\code"
```

## Regenerating the icon

```bash
node scripts/make-icon.js   # writes src/devhq-icon.png
npm run icons               # expands it into src-tauri/icons/
```
