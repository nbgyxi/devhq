// The release history behind the version button in the status bar.
//
// Newest first. `devhqChangelog.current` is the version the status bar shows,
// and it is the version at the top of this list - the two can never drift
// apart because there is only one place to write it down.
//
// `kind` is one of "new", "better" or "fix"; it only picks the colour and the
// word in front of the line.
window.devhqChangelog = (() => {
  const releases = [
    {
      version: "0.6.1",
      date: "2026-08-27",
      title: "A tidier list",
      changes: [
        ["better", "Every cell in the table view is one line now. A value too long for its column is cut off on the right and the whole of it is on the tooltip, instead of wrapping and leaving rows different heights."],
        ["better", "The tech dropdown lights up while it is filtering, with a small clear button beside it - no hunting for \"All tech\" in a list of a hundred."],
      ],
    },
    {
      version: "0.6.0",
      date: "2026-08-27",
      title: "Record and replay a session",
      changes: [
        ["new", "A terminal session can be captured raw and replayed later, byte for byte, so a build that only fails once can still be looked at afterwards."],
        ["new", "`cargo run --example term_replay` feeds a capture back through the VT parser without opening the window."],
        ["new", "This version button, and the list you are reading."],
        ["new", "Clicking a TODO or FIXME in the detail view opens the code around it, the note's own line picked out."],
        ["better", "The VT parser handles more of what real shells emit: scroll regions, wider colour forms and cursor save/restore."],
        ["better", "Anonymous page counts only - which of the app's screens get used. No project names, no paths, and it can never slow the window down."],
      ],
    },
    {
      version: "0.5.1",
      date: "2026-08-12",
      title: "Eleven languages",
      changes: [
        ["new", "DevHQ speaks Chinese, Hindi, Spanish, French, Arabic, Bengali, Portuguese, Russian and Indonesian besides English, and follows Windows by default."],
        ["new", "Arabic lays the whole window out right to left, status bar and terminal dock included."],
        ["new", "MSIX packaging for the Microsoft Store."],
        ["better", "Icons come from a bundled Material Symbols font instead of the network, so the window draws the same offline."],
        ["fix", "The language picker on first run no longer let the scan start behind it."],
      ],
    },
    {
      version: "0.5.0",
      date: "2026-08-04",
      title: "Settings, themes and TODOs",
      changes: [
        ["new", "A settings page: default shell, terminal colour scheme, theme, and how much detail the cards carry."],
        ["new", "Light and dark for the window itself, with every terminal recolouring through the same variables."],
        ["new", "The detail view sweeps a project for TODO and FIXME markers and lists them with their file and line."],
        ["better", "Colour changes apply while the picker is still being dragged rather than on close."],
        ["better", "Preferences survive a restart; they live in localStorage."],
      ],
    },
    {
      version: "0.4.1",
      date: "2026-07-23",
      title: "Terminals that leave the window",
      changes: [
        ["new", "A session pops out into its own window and docks back without restarting: the pseudoconsole, the child process and the screen all live in Rust, and a webview is only ever a view onto one."],
        ["new", "Tabs in the dock, one per session, labelled with the project they belong to, draggable to reorder."],
        ["better", "A build still running when you pop the terminal out is still running when it lands."],
        ["fix", "Closing the app kills every session, so no shell outlives the window that owned it."],
      ],
    },
    {
      version: "0.4.0",
      date: "2026-07-16",
      title: "A terminal in the window",
      changes: [
        ["new", "Every project opens a shell in its own folder, in a dock along the bottom. Ctrl+` toggles it."],
        ["new", "Run starts the project in one - `npm run dev`, `cargo run`, `npx expo start`, whatever the folder itself says."],
        ["new", "No terminal dependency: ConPTY through Microsoft's own bindings, plus DevHQ's own VT parser and screen grid."],
        ["better", "The front end never sees an escape sequence - it receives rows already resolved into coloured runs."],
      ],
    },
    {
      version: "0.3.1",
      date: "2026-07-07",
      title: "Finding things",
      changes: [
        ["new", "Search matches name, group, description, path, branch, remote, tech and port; space-separated terms are ANDed."],
        ["new", "The search box also offers commands - open, run, or start a terminal for a project - so `Ctrl+K` reaches anything."],
        ["new", "A table view beside the cards, with the columns you pick."],
        ["better", "Filter chips carry live counts, and sort buttons for recent, name, changes, running and tech."],
      ],
    },
    {
      version: "0.3.0",
      date: "2026-06-30",
      title: "What it is built with",
      changes: [
        ["new", "Runtime, language, framework, UI, build, data, test and infra tags, each with the version the manifest declares."],
        ["new", "Reads `package.json`, `Cargo.toml`, `tauri.conf.json`, `pyproject.toml`, `requirements.txt`, `go.mod`, `*.csproj`, `pom.xml` and `app.json`."],
        ["new", "Package manager from the lockfile, dependency counts, npm scripts and the project's own version."],
        ["better", "Clicking any tech tag filters the list by it; the dropdown does the same from the toolbar."],
      ],
    },
    {
      version: "0.2.1",
      date: "2026-06-16",
      title: "Never a frozen window",
      changes: [
        ["better", "Projects are inspected across a 12-thread pool, so a few hundred folders scan in a few seconds."],
        ["better", "Results stream in as they arrive instead of landing all at once at the end."],
        ["better", "Rows that are still loading draw as named, shimmering skeletons, so it is obvious which ones are still coming."],
        ["fix", "No command touches disk, `git` or the process table on the thread that draws the window any more."],
      ],
    },
    {
      version: "0.2.0",
      date: "2026-06-09",
      title: "What is actually running",
      changes: [
        ["new", "Which processes belong to a project, and which TCP ports they listen on."],
        ["new", "Each process's real working directory is read out of its PEB, the same route Process Explorer takes, because Windows exposes no API for it."],
        ["better", "A process counts when its cwd, command line or image path is inside the project, or when it descends from one that matched - which catches the worker actually holding the port."],
        ["better", "Shells, editors and coding agents are dropped unless they hold a listening port, so an open terminal does not read as \"running\"."],
      ],
    },
    {
      version: "0.1.0",
      date: "2026-05-28",
      title: "First build",
      changes: [
        ["new", "Point DevHQ at a folder of projects and see all of them at once."],
        ["new", "Per project: branch and upstream, staged, modified and untracked counts, ahead and behind, conflicts, stashes, the last commit and the 30-day commit count."],
        ["new", "A detail view with the changed-file list and the patch beside it."],
        ["new", "Open a project in VS Code, Explorer or an external shell."],
      ],
    },
  ];

  return { current: releases[0].version, releases };
})();
