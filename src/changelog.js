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
      version: "0.19.11",
      date: "2026-08-28",
      title: "Shift+Home leaves the caret at the start",
      changes: [
        ["fix", "After selecting a command with Shift+Home, Shift+Right now unselects the first letter instead of extending the selection at the other end."],
      ],
    },
    {
      version: "0.19.10",
      date: "2026-08-28",
      title: "Official WinUI template",
      changes: [
        ["better", "The native Windows experiment now uses Microsoft's packaged .NET 10 WinUI template so dotnet run can register and launch it reliably."],
      ],
    },
    {
      version: "0.19.9",
      date: "2026-08-28",
      title: "Diagnosable WinUI startup",
      changes: [
        ["fix", "The WinUI experiment explicitly initializes the Windows App SDK bootstrapper and records otherwise silent startup failures."],
      ],
    },
    {
      version: "0.19.8",
      date: "2026-08-28",
      title: "Native Windows UI experiment",
      changes: [
        ["new", "Added an isolated WinUI 3 smoke test for evaluating native controls, themes, lists and text editing before considering a frontend rewrite."],
      ],
    },
    {
      version: "0.19.7",
      date: "2026-08-28",
      title: "Exact terminal command ranges",
      changes: [
        ["fix", "Shift+Home and Shift+End now construct exact terminal-column ranges instead of relying on Chromium's inconsistent selection extension."],
        ["fix", "Selected-command deletion receives stable range boundaries from keyboard selections."],
      ],
    },
    {
      version: "0.19.6",
      date: "2026-08-28",
      title: "Selection follows the terminal cursor",
      changes: [
        ["fix", "Shift+Home now anchors at the real terminal cursor and selects the complete command prefix instead of extending a stale one-word browser selection."],
        ["fix", "Deleting a terminal selection now consistently operates on the selection anchored at the current command cursor."],
      ],
    },
    {
      version: "0.19.5",
      date: "2026-08-28",
      title: "Delete terminal selections",
      changes: [
        ["fix", "Backspace and Delete now reliably remove selected text from the current terminal command by deleting from the selection's beginning."],
      ],
    },
    {
      version: "0.19.4",
      date: "2026-08-28",
      title: "Manage leftover terminal processes",
      changes: [
        ["new", "Terminal process warnings have their own status field beside the version, opening a process list with Kill and Kill all actions."],
      ],
    },
    {
      version: "0.19.3",
      date: "2026-08-28",
      title: "Editor-style Shift+End",
      changes: [
        ["better", "Shift+End in a terminal selects from the cursor to the end of the current command without including blank terminal padding."],
      ],
    },
    {
      version: "0.19.2",
      date: "2026-08-28",
      title: "Editor-style Shift+Home",
      changes: [
        ["better", "Shift+Home in a terminal selects from the cursor back to the beginning of the current command without including the shell prompt."],
      ],
    },
    {
      version: "0.19.1",
      date: "2026-08-28",
      title: "Reproducible orphan warning test",
      changes: [
        ["new", "Added a safe test fixture and cleanup script for verifying that terminal orphan-process warnings appear after closure."],
      ],
    },
    {
      version: "0.19.0",
      date: "2026-08-28",
      title: "Reliable terminal cleanup warnings",
      changes: [
        ["new", "Terminals close immediately, then DevHQ checks their former child processes two seconds later and shows a numbered warning beside Terminal when any remain."],
        ["better", "Terminal tabs now close immediately while cleanup checks happen afterward without blocking the interface."],
      ],
    },
    {
      version: "0.18.16",
      date: "2026-08-28",
      title: "Clean process labels",
      changes: [
        ["fix", "Kill-command details now use correctly encoded separators and loading punctuation."],
      ],
    },
    {
      version: "0.18.15",
      date: "2026-08-28",
      title: "Kill search loads on demand",
      changes: [
        ["fix", "Typing kill directly into universal search now loads process results, with visible loading and error states."],
      ],
    },
    {
      version: "0.18.14",
      date: "2026-08-28",
      title: "Clean terminal command row",
      changes: [
        ["fix", "The terminal command icon no longer inherits the black terminal-pane background in the command palette."],
      ],
    },
    {
      version: "0.18.13",
      date: "2026-08-28",
      title: "Kill from the palette",
      changes: [
        ["new", "Ctrl+K can find Kill process commands by process name, PID or port, with the exact PID shown before confirmation."],
        ["fix", "Terminal commands use a transparent theme-native icon that stays clear in light mode."],
      ],
    },
    {
      version: "0.18.12",
      date: "2026-08-28",
      title: "Visible copy confirmation",
      changes: [
        ["better", "A working folder's Copy button briefly changes to a green checkmark after copying."],
      ],
    },
    {
      version: "0.18.11",
      date: "2026-08-28",
      title: "Folder actions stay close",
      changes: [
        ["fix", "Copy and Reveal now sit immediately after the working-folder path instead of being pushed to the far edge of the column."],
      ],
    },
    {
      version: "0.18.10",
      date: "2026-08-28",
      title: "Universal stays universal",
      changes: [
        ["fix", "The top search remains the universal project and command search while Process Explorer keeps its own independent process filter."],
        ["fix", "Project-linked and ordinary working folders now use the exact same flex box, padding and truncation geometry."],
      ],
    },
    {
      version: "0.18.9",
      date: "2026-08-28",
      title: "Folders line up",
      changes: [
        ["fix", "Linked project folders and ordinary working folders now share the same baseline, spacing and right-aligned shortcut positions."],
      ],
    },
    {
      version: "0.18.8",
      date: "2026-08-28",
      title: "Project folder shortcuts",
      changes: [
        ["fix", "Process rows linked to Overview projects now always show Copy and Reveal actions for the project root folder."],
      ],
    },
    {
      version: "0.18.7",
      date: "2026-08-28",
      title: "Folder shortcuts",
      changes: [
        ["new", "Working folders in Process Explorer have compact actions to copy their path or reveal them in Windows Explorer."],
      ],
    },
    {
      version: "0.18.6",
      date: "2026-08-28",
      title: "Back to the project",
      changes: [
        ["new", "A process working inside an Overview project links directly from its Working folder cell to that project's detail view."],
      ],
    },
    {
      version: "0.18.5",
      date: "2026-08-28",
      title: "See the response",
      changes: [
        ["new", "Browser-readable port badges and Local development labels show the HTTP response code DevHQ received, including errors such as HTTP 500."],
      ],
    },
    {
      version: "0.18.4",
      date: "2026-08-28",
      title: "Development, not Windows",
      changes: [
        ["better", "Local development accepts any valid HTTP response, including failed apps, redirects and error pages, while requiring a matching project, development runtime or known server command."],
        ["fix", "Unrelated Windows services no longer appear in the Local development filter merely because they expose an HTTP endpoint."],
      ],
    },
    {
      version: "0.18.3",
      date: "2026-08-28",
      title: "One definition of local development",
      changes: [
        ["fix", "The Local development filter and highlighted rows now include only localhost services that answered as browser-readable HTTP endpoints."],
      ],
    },
    {
      version: "0.18.2",
      date: "2026-08-28",
      title: "Open what is actually web",
      changes: [
        ["fix", "Open and Copy URL are available only after a localhost port answers with a real HTTP response, so database and other non-web listeners are no longer sent to the browser."],
      ],
    },
    {
      version: "0.18.1",
      date: "2026-08-28",
      title: "Processes in order",
      changes: [
        ["new", "Process Explorer columns can be sorted in either direction by Ports, Process, PID or Working folder."],
      ],
    },
    {
      version: "0.18.0",
      date: "2026-08-28",
      title: "Local development, live",
      changes: [
        ["new", "Processes listening through localhost are highlighted directly in the process table and identified from their command, port and matching Overview project."],
        ["new", "A Local development filter shows only processes with loopback or wildcard TCP listeners."],
      ],
    },
    {
      version: "0.17.0",
      date: "2026-08-28",
      title: "Every process, every port",
      changes: [
        ["new", "The Port Manager is now a combined Process and Port Explorer showing every process, including those without a listening port."],
        ["better", "All TCP listeners and UDP bindings owned by a process are grouped into its single process row."],
      ],
    },
    {
      version: "0.16.1",
      date: "2026-08-28",
      title: "Ports in line",
      changes: [
        ["new", "Port Manager has its own filter field for ports, processes, PIDs, protocols, paths and command lines."],
        ["fix", "The Actions column now stays aligned with every other port-table cell and row divider."],
      ],
    },
    {
      version: "0.16.0",
      date: "2026-08-28",
      title: "Ports under control",
      changes: [
        ["new", "A top-level Port Manager lists system-wide TCP listeners and UDP bindings with their process, PID and working folder."],
        ["new", "Port actions can open localhost, copy its URL, inspect complete process details or terminate the owning process after confirmation."],
        ["better", "Overview and Ports now have persistent navigation beside the contextual search box."],
      ],
    },
    {
      version: "0.15.4",
      date: "2026-08-28",
      title: "Rows in order",
      changes: [
        ["better", "The scan summary now comes before the Stashed and Behind filter row, with the technology filter aligned to that row's right edge."],
      ],
    },
    {
      version: "0.15.3",
      date: "2026-08-28",
      title: "Filters together",
      changes: [
        ["better", "The technology filter now sits at the right of the summary row with the other overview controls."],
      ],
    },
    {
      version: "0.15.2",
      date: "2026-08-28",
      title: "One control row",
      changes: [
        ["better", "The scanned folder and Rescan control now join sorting and view choices in the summary row."],
      ],
    },
    {
      version: "0.15.1",
      date: "2026-08-28",
      title: "Views in their place",
      changes: [
        ["better", "The Cards and Table view switch now sits in the summary row alongside project sorting."],
      ],
    },
    {
      version: "0.15.0",
      date: "2026-08-28",
      title: "A tidier overview",
      changes: [
        ["better", "Project sorting now sits with the scan summary, leaving more room in the main toolbar."],
        ["better", "Scan status shows when the scan happened without reporting how many milliseconds it took."],
      ],
    },
    {
      version: "0.14.0",
      date: "2026-08-28",
      title: "Select with context",
      changes: [
        ["new", "Ctrl+A in an active terminal command selects that command first; press it again to select the terminal's complete history and screen."],
      ],
    },
    {
      version: "0.13.1",
      date: "2026-08-28",
      title: "Word by word",
      changes: [
        ["fix", "Ctrl+Shift+Left now consistently selects the previous word in terminals, including across differently styled text."],
      ],
    },
    {
      version: "0.12.0",
      date: "2026-08-28",
      title: "On top of things",
      changes: [
        ["new", "A popped-out terminal can be pinned above every other window with the pin in its title bar. Handy for watching a build while you work in something else."],
        ["better", "A pinned terminal stays pinned when you dock it and pop it out again."],
      ],
    },
    {
      version: "0.11.6",
      date: "2026-08-28",
      title: "Your call",
      changes: [
        ["new", "DevHQ now asks before counting anything, and links you straight to the handful of lines that do it. Say no and nothing is ever sent."],
        ["new", "Settings has a switch for it, so you can change your mind whenever you like."],
        ["fix", "The counts that were meant to be sent never actually left the app. They do now - just which screen you opened, nothing about your projects."],
      ],
    },
    {
      version: "0.11.5",
      date: "2026-08-28",
      title: "Read from the start",
      changes: [
        ["fix", "A technology line too long for its column in the table now starts with its name and trails off at the right. A long version - an npm alias such as npm:react-native-tvos@^0.76.9-0 - no longer pushes the name out of the row and leaves the middle of the line showing."],
      ],
    },
    {
      version: "0.11.4",
      date: "2026-08-28",
      title: "One line, one start",
      changes: [
        ["fix", "The table's technology lines lay themselves out inside the button rather than letting the button centre them."],
      ],
    },
    {
      version: "0.11.3",
      date: "2026-08-28",
      title: "One line, one start",
      changes: [
        ["fix", "The table's technology lines lay themselves out inside the button rather than letting the button centre them."],
      ],
    },
    {
      version: "0.11.2",
      date: "2026-08-28",
      title: "Pull without leaving",
      changes: [
        ["new", "Every git project has a Pull button - on the card, in the table, in the detail view and in the command palette - that runs git pull in that folder and says what git answered."],
        ["fix", "The terminal and pull icons are drawn as shapes rather than font glyphs, so neither can come out as a black box."],
        ["fix", "The window no longer draws itself with the previous release's stylesheet and scripts after an update."],
      ],
    },
    {
      version: "0.11.1",
      date: "2026-08-28",
      title: "Type > for commands",
      changes: [
        ["new", "Typing > anywhere in the window opens the command palette, the way Ctrl+K does, and the > stays in the box as the command prefix."],
        ["fix", "The terminal icon is drawn again everywhere it appears - the status bar, project cards, the command palette and settings - instead of the black box the icon font was showing."],
        ["better", "Command palette icons sit straight on the row, with no tinted plate behind them."],
      ],
    },
    {
      version: "0.11.0",
      date: "2026-08-28",
      title: "A picker for your stack",
      changes: [
        ["new", "The tech filter is now a real dropdown: search it, walk it with the arrow keys, and see each technology's kind and how many projects use it."],
        ["better", "Ctrl+K rows lead with an icon for what they do - terminal, run, project, filter or command - instead of a four-letter code."],
      ],
    },
    {
      version: "0.10.2",
      date: "2026-08-28",
      title: "Terminal tab identifiers",
      changes: [
        ["new", "Terminal settings can show shell types as no marker, a colored dot or the current short code badge."],
        ["better", "Popped-out terminals use the same shell marker style and color as docked tabs, including live setting changes."],
      ],
    },
    {
      version: "0.10.1",
      date: "2026-08-28",
      title: "One-click theme choice",
      changes: [
        ["better", "Light and dark mode use the same clear two-button switch as the Cards and Table view choice."],
      ],
    },
    {
      version: "0.10.0",
      date: "2026-08-28",
      title: "Your shell colors",
      changes: [
        ["new", "Terminal settings let every shell type have its own tab-badge color, applied live and remembered."],
        ["better", "Theme and compact overview settings now live under General instead of a separate Appearance section."],
      ],
    },
    {
      version: "0.9.4",
      date: "2026-08-28",
      title: "Know your shell",
      changes: [
        ["better", "Terminal tabs identify their shell with a compact PW7, PS, CMD, GIT, WSL or NU badge; exited terminals still dim and starting terminals still spin."],
      ],
    },
    {
      version: "0.9.3",
      date: "2026-08-28",
      title: "Controls on both sides",
      changes: [
        ["new", "Each terminal pane now has its own New, shell chooser, Pop out and Close controls, acting only on that side."],
        ["better", "The terminal-type chooser uses a tuning icon so the down arrow means only Hide panel."],
      ],
    },
    {
      version: "0.9.2",
      date: "2026-08-28",
      title: "Refresh installed shells",
      changes: [
        ["new", "Terminal settings can rescan installed shells without restarting DevHQ."],
        ["fix", "The current shell stays normally styled in the tab menu instead of looking unavailable."],
      ],
    },
    {
      version: "0.9.1",
      date: "2026-08-28",
      title: "Cleaner shell menus",
      changes: [
        ["better", "Shell menus keep their short, readable names while still disabling options that are not installed."],
      ],
    },
    {
      version: "0.9.0",
      date: "2026-08-28",
      title: "Use the shells you have",
      changes: [
        ["new", "DevHQ now discovers installed shells at startup, including PowerShell stable and preview, Windows PowerShell, Command Prompt, Git Bash, WSL and NuShell."],
        ["better", "Unavailable shells are disabled in terminal menus, with a clear dialog if one still fails to launch."],
      ],
    },
    {
      version: "0.8.3",
      date: "2026-08-28",
      title: "Short terminal titles",
      changes: [
        ["better", "A popped-out terminal uses only its folder name in the taskbar and window title, such as devhq instead of the full C:\\code\\devhq path."],
      ],
    },
    {
      version: "0.8.2",
      date: "2026-08-28",
      title: "Dock where the divider is",
      changes: [
        ["fix", "The left and right terminal docking previews now follow the splitter instead of always dividing the panel in half."],
      ],
    },
    {
      version: "0.8.1",
      date: "2026-08-28",
      title: "A different shell, right here",
      changes: [
        ["new", "Right-click a terminal tab to restart it with PowerShell, Command Prompt, Git Bash or WSL while keeping its folder, pane and tab position."],
      ],
    },
    {
      version: "0.8.0",
      date: "2026-08-28",
      title: "Terminals side by side",
      changes: [
        ["new", "Drag a terminal tab over the panel and drop it on the left or right docking preview to work in two terminals side by side."],
        ["new", "Each side has its own tab strip, and tabs can be dragged directly between the two terminal groups."],
        ["new", "Drag the divider between terminal panes to give either side more room; the split and each terminal's side are restored next time."],
      ],
    },
    {
      version: "0.7.2",
      date: "2026-08-28",
      title: "A redrawn face",
      changes: [
        ["better", "The app icon has been redrawn, and it is cropped to the artwork so it fills the tile edge to edge - on the taskbar, in the window corner, in the installer and on the browser tab."],
      ],
    },
    {
      version: "0.7.1",
      date: "2026-08-28",
      title: "Working, or waiting",
      changes: [
        ["better", "A terminal that is producing output now spins a small marker in place of the cursor instead of flinging the cursor along the line on every frame. The moment the output stops, the ordinary cursor is back - that is the terminal telling you it is waiting for you."],
      ],
    },
    {
      version: "0.7.0",
      date: "2026-08-28",
      title: "Ask before you scan",
      changes: [
        ["new", "A fresh install now asks which folder holds your projects instead of guessing one. Name as many folders as you like before the first scan starts."],
        ["new", "Every folder row - in that question and in the toolbar's folder editor - has a Browse button that opens the Windows folder picker, so a path can be picked as well as typed."],
        ["new", "Settings has a Reset button. It forgets the folders, language, appearance and terminals and starts the app over as if it had just been installed; it takes two clicks, because there is no undo."],
      ],
    },
    {
      version: "0.6.3",
      date: "2026-08-28",
      title: "A face of its own",
      changes: [
        ["better", "DevHQ has a new app icon, cropped so the artwork fills the tile edge to edge - it shows up on the taskbar, in the window corner, in the installer and on the browser tab."],
      ],
    },
    {
      version: "0.6.2",
      date: "2026-08-28",
      title: "The number always matches the list",
      changes: [
        ["better", "The version this window shows is now the one the build was made with, and a release cannot be packaged unless it appears in this list - so the number on the status bar always has an entry here to explain it."],
      ],
    },
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
