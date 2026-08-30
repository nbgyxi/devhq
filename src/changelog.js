// The release history behind the version button in the status bar.
//
// Newest first. `devhqChangelog.current` is the version the status bar shows,
// and it is the version at the top of this list - the two can never drift
// apart because there is only one place to write it down.
//
// `kind` is one of "new", "better" or "fix"; it only picks the colour and the
// word in front of the line.
//
// `buildChecksum` is the SHA-256 of that version's Store exe. It is written
// after the package is built, never before: putting the hash into this file
// first would change the binary, so the number would no longer match. What's
// new hashes the running exe for the current version; older versions show the
// recorded number from when they shipped.
window.devhqChangelog = (() => {
  const releases = [
    {
      version: "0.34.3",
      date: "2026-08-30",
      title: "Store builds name their checksum",
      buildChecksum: "8bbb9f9a871eb2b7b3d6461e9e70cf73b6f5a05a90a34f24a35d5798d2fe7c8e",
      changes: [
        ["new", "What's new names the SHA-256 of the exe you are running, on the current version. A Store package records that same number in the source after the build, so the list on GitHub can be checked against the binary in the Store."],
      ],
    },
    {
      version: "0.34.2",
      date: "2026-08-30",
      title: "Terminal history on or off",
      changes: [
        ["new", "Settings › Terminal has a switch for saving scrollback across restarts. Turn it off and every terminal starts fresh; what it showed is cleared when you close it."],
      ],
    },
    {
      version: "0.34.1",
      date: "2026-08-30",
      title: "The app icon, transparent and one mark",
      changes: [
        ["better", "The app icon is the new transparent artwork everywhere — taskbar, installer, browser tab and the brand mark in the window. There is no separate light-mode app icon anymore."],
      ],
    },
    {
      version: "0.34.0",
      date: "2026-08-30",
      title: "Ctrl+click a link in a terminal",
      changes: [
        ["new", "Hold Ctrl over a link in a terminal and it underlines; click it and it opens in your browser. The address a dev server prints when it starts is now one keystroke away from being open, instead of something to select and copy by hand."],
        ["better", "What counts as a link is deliberately narrow: http, https, and a bare www. address. A file path is not a link, and a scheme a program invented is never handed to Windows on the strength of appearing in output."],
        ["better", "The full stop after a link in a sentence is the sentence's, not the link's - but brackets that were opened inside the address are kept, so a Wikipedia URL still works."],
      ],
    },
    {
      version: "0.33.6",
      date: "2026-08-30",
      title: "Tool icons that match where they sit",
      changes: [
        ["better", "Pop-out tool icons are just the tool glyph — large, transparent, no box — in teal for dark surfaces and charcoal for light ones. The title bar follows the window theme; the taskbar always uses the dark-surface variant so a light window still reads clearly on a dark taskbar."],
      ],
    },
    {
      version: "0.33.5",
      date: "2026-08-30",
      title: "Tool icons for the new mark, light and dark",
      changes: [
        ["better", "Tool pop-out icons use the new app artwork as their base, draw the tool glyph as large as the terminal screen allows, and ship separate light and dark versions for the title bar and taskbar. Re-run npm run tool-icons after changing app-icon.png."],
      ],
    },
    {
      version: "0.33.4",
      date: "2026-08-30",
      title: "Tool pop-out icons you can read at a glance",
      changes: [
        ["better", "Composite tool icons draw the tool glyph almost as large as the terminal panel allows, instead of a small badge in the corner. Re-run npm run tool-icons to refresh them."],
      ],
    },
    {
      version: "0.33.3",
      date: "2026-08-30",
      title: "A tool pop-out carries its own icon",
      changes: [
        ["better", "Popped-out tools can show a composite icon — the app mark with the tool's glyph on a mint badge over the terminal. Run npm run tool-icons after adding tools or changing app-icon.png; if a tool has no generated file, the main icon is used instead."],
      ],
    },
    {
      version: "0.33.2",
      date: "2026-08-30",
      title: "A new face for DevHQ",
      changes: [
        ["better", "The app icon is new — a code editor over a terminal prompt, in mint and charcoal. Everywhere the icon appears — the window, the taskbar, the Store tile, the brand mark in the UI — picks it up from the same source."],
      ],
    },
    {
      version: "0.33.1",
      date: "2026-08-30",
      title: "The gap after the prompt, and a selection that answers the first time",
      changes: [
        ["fix", "The gap between a prompt and the command after it is gone. A row's columns are drawn as pixels, and a row that scrolled into the history before the terminal could measure its own character kept that guess forever - about one character of empty space by the middle of a line, which is why the gap sat between two pieces of text rather than inside either. The history is now redrawn when the measurement lands, exactly as the screen already was."],
        ["fix", "Ctrl+Shift+Right shrinks a selection on the first press. It used to take two after a Ctrl+Shift+Left, because the two directions were moved by different machinery - one asked the browser, one moved the selection directly, and the browser's first answer afterwards was spent catching up."],
        ["better", "Every selection chord now moves the selection the same way: work out the row and column it should land on, then go there. The browser reads a terminal row as prose and stops its word steps at a change of colour; a word is now found in the row's own text, so Ctrl+Shift+Left and Right step over words rather than over colours."],
      ],
    },
    {
      version: "0.33.0",
      date: "2026-08-30",
      title: "A restored terminal is the terminal, not a picture of one",
      changes: [
        ["better", "Restored history is no longer a reconstruction. DevHQ used to save what a terminal's cells looked like and paint them back, which is why little things were off - a stray space in front of a command, output that had been coloured by a program coming back plain. Each terminal is now kept as the stream of bytes its shell actually wrote, and opening it feeds those bytes back through the same parser that drew them the first time. The scrollback you get back is not a copy of the old one; it is produced the same way it was produced originally."],
        ["better", "What that fixes, it fixes everywhere at once: wrapping, alignment, colours, cursor addressing, anything a program drew. There is nothing left to reproduce, so there is nothing left to reproduce wrongly."],
        ["better", "Terminal output has left localStorage. A shell's scrollback was never something a browser store should have been holding - it is a file now, one per terminal, capped and trimmed at a point where the stream can safely be cut. Closing a terminal is what ends its history; quitting is not."],
        ["fix", "The panel's own state - which shells, where, in what order - can no longer be lost because one terminal printed too much."],
        ["fix", "Terminals restored once already will start their kept stream from this version. History from before the change is not carried over: it was only ever the picture, and there is nothing in it to replay."],
      ],
    },
    {
      version: "0.32.0",
      date: "2026-08-30",
      title: "Restored terminals come back in colour, and keep coming back",
      changes: [
        ["better", "A restored terminal is the terminal again. Its history was stored as plain text, so everything a command had coloured came back grey - green tests, red errors, a build log's warnings, all flattened. It is now kept as the terminal's own cells and drawn back the way it was printed."],
        ["fix", "A terminal no longer forgets everything but its last session. Each restart saved only what the new shell had printed, so history reached back one run and no further. What a terminal showed before is now carried across every restart, up to the same bounded scrollback."],
        ["new", "Every tool has a Back arrow beside its name, the same one a project's details carry, so the way to the overview is where you already look for it. A tool in its own window does not - that window's title bar is the way out."],
        ["better", "Saving the panel can no longer fail because one terminal printed too much. If the browser refuses the size, the histories are cut back rather than the layout being lost."],
      ],
    },
    {
      version: "0.31.4",
      date: "2026-08-30",
      title: "The terminal answers the moment you press the key",
      changes: [
        ["better", "Arrow up, and every other keystroke, reaches the shell without waiting for the window. Typing used to be handed to the pseudoconsole on the same thread that draws DevHQ, behind a lock that closing or resizing a terminal can hold for a noticeable moment - so a recalled command could arrive late for no visible reason. Keystrokes now go onto the session's own queue, in the order you typed them, and a thread of its own does the waiting."],
        ["better", "Closing a terminal, resizing one and listing them no longer run on the window's thread either. Tearing a pseudoconsole down blocks until Windows lets go of it, and that pause used to be the window's pause too."],
      ],
    },
    {
      version: "0.31.3",
      date: "2026-08-30",
      title: "A restored terminal starts where you left it",
      changes: [
        ["fix", "Restoring terminals no longer leaves a spare prompt above the live one. The prompt the old shell was standing on was saved as if it were output, so every restart added an empty line before the shell that replaced it. What was saved now stops above that line."],
        ["fix", "Making a terminal shorter no longer throws the last line to the top of the window. It used to scroll all the way past the blank rows below the cursor; it now stops at the end of what has actually been printed, and following live output stops there too."],
      ],
    },
    {
      version: "0.31.2",
      date: "2026-08-30",
      title: "A tool window you move stays where you put it",
      changes: [
        ["fix", "Dragging a popped-out tool by its title bar now just moves the window. Dropping it anywhere over DevHQ used to pull the tool back into the main window, so an ordinary move across the screen looked like the window had vanished. The dock button in the title bar is the way back in."],
      ],
    },
    {
      version: "0.31.1",
      date: "2026-08-30",
      title: "The typed command sits right after the prompt again",
      changes: [
        ["fix", "What you type no longer drifts away from the end of the prompt. A terminal opened into a panel that was not on screen yet had to guess how wide a character is, and half a pixel of guess became a whole character of gap by the end of a path. It now measures the moment the panel is real and redraws."],
        ["fix", "Typing no longer shoves the output down. A session that fits in the window stays at the top, and one that does not keeps its last line on the bottom edge — before, the first keystroke jumped it to the end whether or not there was anything below."],
      ],
    },
    {
      version: "0.31.0",
      date: "2026-08-30",
      title: "Tables in the terminal line up",
      changes: [
        ["fix", "A command that draws a table, a box or a progress bar now keeps its columns. Every stretch of a line is drawn at the column the shell put it in instead of being flowed after the one before it, so a character the terminal font has to borrow from another font can no longer push the rest of the line sideways."],
        ["fix", "Chinese, Japanese, Korean and emoji take the two columns they are worth. Output containing them used to drift one column further out of line with every one on the row."],
        ["fix", "An accented letter written as a letter plus its accent no longer loses the letter."],
        ["better", "Columns land on whole pixels, so a coloured header sits exactly above the rows under it and coloured runs meet without a hairline of background between them. Ligatures are off, so an arrow in a table is two characters wide like everywhere else."],
      ],
    },
    {
      version: "0.30.1",
      date: "2026-08-29",
      title: "Popped-out tools stop naming themselves twice",
      changes: [
        ["better", "A tool in its own window no longer repeats its name and description in a header inside the page — the window title bar already says both. The Alpha or Beta mark now sits in that title bar beside the name, and still explains itself when clicked."],
      ],
    },
    {
      version: "0.30.0",
      date: "2026-08-29",
      title: "The hosts file is its own tool",
      changes: [
        ["new", "The hosts file has moved out of DNS onto a page of its own, full width, with one long scrolling list — searchable and pinnable like any other tool. DNS links across to it, and still says above its answers when a hosts line is what this machine will really use."],
        ["new", "Any line can be edited in place: click the address or the names and both become fields. Save stages the change alongside every other edit, so nothing reaches the file until Apply."],
        ["fix", "A short window no longer cuts off the bottom of a panel. DNS keeps its Add domain row on screen and scrolls instead, and the hosts page keeps Apply and the safety line in view however little height there is."],
      ],
    },
    {
      version: "0.29.4",
      date: "2026-08-29",
      title: "Folders to scan browse button visible",
      changes: [
        ["fix", "The Folders to scan popover now stays fully on screen, so the folder-browse and remove buttons on the right of each path are visible again."],
      ],
    },
    {
      version: "0.29.3",
      date: "2026-08-29",
      title: "Folders to scan stays on screen",
      changes: [
        ["fix", "The Folders to scan panel no longer hangs off the right edge of the window — it shifts left so the whole editor stays visible."],
      ],
    },
    {
      version: "0.29.2",
      date: "2026-08-29",
      title: "Popped-out terminals close immediately",
      changes: [
        ["fix", "Closing a popped-out terminal ends it straight away, the same as closing a tab in the dock — no more “waiting to finish safely” dialog or Ctrl+C wait."],
      ],
    },
    {
      version: "0.29.1",
      date: "2026-08-29",
      title: "Popped-out DNS works again",
      changes: [
        ["fix", "DNS in its own window now actually resolves: results, the resolver comparison and the hosts file all appear instead of the page sitting there frozen. The Network watcher and the utility tools were stuck the same way in a pop-out window."],
      ],
    },
    {
      version: "0.29.0",
      date: "2026-08-29",
      title: "Search moves into the title bar",
      changes: [
        ["better", "The search box now sits in the title bar, and the row that used to hold it is gone — about 60px more of your projects on screen, with the scan progress bar riding the title bar's bottom edge."],
        ["new", "Settings › General can give pinned tools a shelf of their own above the status bar. The row wraps, so every pin stays visible however many you keep, instead of four chips and a “more” button."],
      ],
    },
    {
      version: "0.28.5",
      date: "2026-08-29",
      title: "Tool pop-out opens without flashing",
      changes: [
        ["fix", "Popped-out tools no longer flash white, then black, then grey before the UI appears — the window stays hidden until the theme and chrome have painted."],
      ],
    },
    {
      version: "0.28.4",
      date: "2026-08-29",
      title: "Event Log no phantom scrollbar",
      changes: [
        ["fix", "Event Log Streamer no longer leaves a permanent scrollbar strip when the window is tall enough for the list — the pane fills with flex instead of a short height calc, and the list only scrolls when events overflow."],
      ],
    },
    {
      version: "0.28.3",
      date: "2026-08-29",
      title: "Restore icon when maximized",
      changes: [
        ["better", "When the main window or a popped-out tool or terminal is maximized, the caption button shows Restore instead of Maximize."],
      ],
    },
    {
      version: "0.28.2",
      date: "2026-08-29",
      title: "Tool pop-out matches the theme",
      changes: [
        ["fix", "A popped-out tool opens in the current light or dark colour instead of flashing black first."],
        ["better", "If opening the tool takes a moment, a spinner shows what is happening."],
      ],
    },
    {
      version: "0.28.1",
      date: "2026-08-29",
      title: "Main window comes back",
      changes: [
        ["fix", "The Network tool no longer declares a global listen that stopped app.js from loading, which had left the main window blank."],
      ],
    },
    {
      version: "0.28.0",
      date: "2026-08-29",
      title: "Watch the packets crossing the wire",
      changes: [
        ["new", "A Network tool captures live traffic with pktmon, the capture engine already in Windows - there is no Npcap, no WinPcap and nothing to install."],
        ["new", "Frames arrive as they happen, each showing the time, the direction, the protocol, both ends, the process that owns the socket and the bytes."],
        ["new", "Filter by port, address or transport before the capture starts so the driver drops what you do not want; exclusions like !mdns are applied to what arrives instead, and the tool says which is which."],
        ["new", "Pick a frame to take it apart layer by layer, down to the captured bytes in hex."],
        ["new", "Export everything captured as a .pcapng that Wireshark opens as it is."],
        ["new", "Throughput, the busiest hosts on the other end, and which network components are being watched, all beside the frames."],
        ["new", "Every tool now carries a badge saying how finished it is - Alpha or Beta - and clicking it explains what each stage promises."],
        ["better", "Network capture needs administrator rights, and the tool says so up front instead of after you press Start."],
      ],
    },
    {
      version: "0.27.3",
      date: "2026-08-29",
      title: "Tool pop-out window buttons",
      changes: [
        ["fix", "Minimise, maximise, dock, pin-on-top and close work on a popped-out tool again — those windows now have the same permissions as a popped-out terminal."],
      ],
    },
    {
      version: "0.27.2",
      date: "2026-08-29",
      title: "Tool pop-out fills the window",
      changes: [
        ["fix", "A popped-out tool now fills the window edge to edge — the title bar is no longer a centred strip with gaps, and the scrollbar sits on the real right edge."],
        ["fix", "Minimise, maximise, dock and close on a popped-out tool respond again; the drag region no longer swallows those buttons."],
      ],
    },
    {
      version: "0.27.1",
      date: "2026-08-29",
      title: "Tool pop-out title bar",
      changes: [
        ["fix", "A popped-out tool's title bar matches the terminal: left-aligned name beside the DevHQ icon, without a material-icon ligature or the long hint crowding the strip."],
      ],
    },
    {
      version: "0.27.0",
      date: "2026-08-29",
      title: "Pop tools out into their own window",
      changes: [
        ["new", "Any tool can open in its own window from the Pop out button in its header."],
        ["new", "Drag a pinned tool past the edge of DevHQ to tear it into a new window, the same way terminal tabs do."],
        ["better", "Dock a popped-out tool back with the dock button, or by dragging its title bar onto DevHQ; closing the window leaves the tool available from its pin."],
      ],
    },
    {
      version: "0.26.5",
      date: "2026-08-29",
      title: "DNS answers say which name they belong to",
      changes: [
        ["fix", "Every DNS answer now shows the name it is for above the value, so a CNAME reads as login.broker -> the target instead of a target on its own."],
        ["better", "An answer for a name other than the one you asked about - the far end of a CNAME chain - is highlighted, so a redirected lookup is obvious."],
      ],
    },
    {
      version: "0.26.4",
      date: "2026-08-29",
      title: "Pinned tools click and drag",
      changes: [
        ["fix", "Pinned tools capture the pointer only after movement starts, so a normal click opens the tool while a drag still reorders it."],
      ],
    },
    {
      version: "0.26.3",
      date: "2026-08-29",
      title: "Pinned-tool dragging works in the WebView",
      changes: [
        ["fix", "Pinned tools now use captured pointer movement instead of unreliable browser drag events, so insertion zones appear and dropping changes their order."],
      ],
    },
    {
      version: "0.26.2",
      date: "2026-08-29",
      title: "Pinned-tool drop zones stay visible",
      changes: [
        ["fix", "Dragging a pinned tool now keeps the source faded and shows a visible insertion line inside the destination chip."],
      ],
    },
    {
      version: "0.26.1",
      date: "2026-08-29",
      title: "Event Log opens from Help",
      changes: [
        ["fix", "Event Log Streamer opens from its Help card again instead of failing on its disabled renderer."],
      ],
    },
    {
      version: "0.26.0",
      date: "2026-08-29",
      title: "Put pinned tools in your order",
      changes: [
        ["new", "Pinned tools can be dragged into a new order in the status bar or the all-pins panel; the order and its Ctrl+number shortcuts persist."],
        ["better", "Alt+arrow moves a focused pin without a mouse."],
      ],
    },
    {
      version: "0.25.9",
      date: "2026-08-29",
      title: "One heading per repair tool",
      changes: [
        ["fix", "GPU, network, Explorer cache, and print spooler repair screens no longer repeat their title inside the page."],
      ],
    },
    {
      version: "0.25.8",
      date: "2026-08-29",
      title: "Audio tools connect",
      changes: [
        ["fix", "Audio Subsystem Bouncer has one title, and it and Sound Device Switcher now link directly to each other."],
      ],
    },
    {
      version: "0.25.7",
      date: "2026-08-29",
      title: "Window bounds identify the real strays",
      changes: [
        ["fix", "Window Bounds Recalibrator no longer mistakes minimized or deliberately small windows for off-screen windows."],
      ],
    },
    {
      version: "0.25.6",
      date: "2026-08-29",
      title: "Help is a command reference",
      changes: [
        ["better", "Help now shows the exact searchable command forms, including Run <project>, Terminal, Pull, filters, rescan, and process termination."],
        ["better", "Project-detail actions are listed separately, without generic search instructions."],
      ],
    },
    {
      version: "0.25.5",
      date: "2026-08-29",
      title: "Help is always in search",
      changes: [
        ["better", "Help always appears in an empty Ctrl+K list, after your latest-used destinations — you do not have to remember to open it first."],
        ["better", "Typing help, guide, docs, or ? also finds Help."],
      ],
    },
    {
      version: "0.25.4",
      date: "2026-08-29",
      title: "Help documents real commands",
      changes: [
        ["better", "Help now lists the complete project action set: Open, Run, Code, Terminal, Pull, Explorer, External shell, and Copy path."],
        ["better", "Removed the generic search tutorial and separated project commands from application commands."],
      ],
    },
    {
      version: "0.25.3",
      date: "2026-08-29",
      title: "Help links to every tool",
      changes: [
        ["better", "Every tool card in Help is now a keyboard-accessible button that opens that tool directly."],
      ],
    },
    {
      version: "0.25.2",
      date: "2026-08-29",
      title: "Repair tools are easier to find",
      changes: [
        ["fix", "Searching for tool or tools now finds each of the nine repair tools as its own result."],
      ],
    },
    {
      version: "0.25.1",
      date: "2026-08-29",
      title: "Help is a tool too",
      changes: [
        ["new", "A searchable and pinnable Help tool explains Ctrl+K and > search, recent destinations, result ranking, keyboard navigation, pins, and Ctrl+1…9 shortcuts."],
        ["new", "Help briefly describes generated project, filter, terminal, rescan, and process-kill commands."],
        ["new", "Help lists every currently available core, Windows, diagnostic, encoding, hashing, time, and format tool in compact groups."],
      ],
    },
    {
      version: "0.25.0",
      date: "2026-08-29",
      title: "System and repairs use their real designs",
      changes: [
        ["better", "System now follows the supplied workspace design with Environment, Lock Inspector, and Log Tail modes in one tool."],
        ["new", "Environment has User and Machine scopes, a variable navigator, numbered PATH diagnostics, a selected-variable inspector, and a findings panel."],
        ["fix", "Event Log Streamer's header and every event row now share exactly one column definition and reserve the scrollbar gutter, so Time, Level, Provider, ID, and Channel stay aligned."],
        ["better", "Every repair tool now uses its supplied selector, service list, device list, cache inventory, print queue, or ordered-step design instead of the generic repair card."],
        ["better", "Audio services, GPUs and monitors, network steps, Explorer caches, and print jobs are read from the machine before their repair action is offered."],
      ],
    },
    {
      version: "0.24.7",
      date: "2026-08-29",
      title: "Event Log Streamer has its inspector",
      changes: [
        ["better", "Event Log Streamer now follows the supplied split design: dense live events on the left and a persistent selected-event inspector on the right."],
        ["new", "Selected events can be inspected as their formatted message or the native XML returned by Windows."],
        ["new", "Regex presets cover unhandled exceptions, Win32 codes, timeouts, access failures, and port collisions."],
        ["better", "Channels, severity levels, pause/resume state, clearing, timestamps, providers, IDs, and channels remain visible while the stream updates."],
      ],
    },
    {
      version: "0.24.6",
      date: "2026-08-29",
      title: "Registry is a registry workspace",
      changes: [
        ["better", "Registry now follows the supplied three-pane design: hives and bookmarks on the left, subkeys and values in the center, and selected-value details on the right."],
        ["better", "Browse has parent navigation, an editable path, folder-style subkeys, and an inline type/value editor instead of browser prompts."],
        ["new", "Change Watch polls the selected key and records created, changed, and deleted values in a timestamped feed."],
        ["fix", "Registry deletion still requires a second click, now in the value detail pane where the affected key and data remain visible."],
      ],
    },
    {
      version: "0.24.5",
      date: "2026-08-29",
      title: "Sound Device Switcher",
      changes: [
        ["better", "The tool that changes your default playback and recording device is now called Sound Device Switcher, so Ctrl+K for \"sound\" finds it."],
      ],
    },
    {
      version: "0.24.4",
      date: "2026-08-29",
      title: "As many UUIDs as you ask for",
      changes: [
        ["better", "UUID generator has an input again: type how many you want (up to 10,000). The old ×10 toggle is gone."],
      ],
    },
    {
      version: "0.24.3",
      date: "2026-08-29",
      title: "Find tools by typing tool",
      changes: [
        ["fix", "Ctrl+K for \"tool\" or \"tools\" lists the tools again — they were matching but ranked under project rows and falling off the list."],
      ],
    },
    {
      version: "0.24.2",
      date: "2026-08-29",
      title: "The repair tools do the repair",
      changes: [
        ["fix", "Default Device Hot-Swapper now lists real playback and recording endpoints inside DevHQ and assigns the selected one to Console, Multimedia, and Communications instead of opening Sound Settings."],
        ["fix", "Window Bounds Recalibrator now lists genuinely off-screen windows and pulls the selected one into the primary viewport instead of opening Display Settings."],
        ["better", "Adapter and Bluetooth Power-Cycler lists real devices and restarts only the one you select."],
        ["better", "USB Hub Re-enumerator lists present USB devices and restarts the selected device through Plug and Play instead of doing a generic scan."],
      ],
    },
    {
      version: "0.24.1",
      date: "2026-08-29",
      title: "Windows tools fit the window",
      changes: [
        ["fix", "Windows tools no longer cover the search bar or collapse their content area; they fill the space below the toolbar like every other screen."],
        ["fix", "Windows tools now use DevHQ's real icons instead of showing names such as play_arrow as button text."],
        ["better", "Every Windows tool surface, panel, field, table and log output now follows the active light or dark theme."],
        ["better", "Windows tools share the same header, pin, close, refresh, spacing and control styles as DNS and the utility tools."],
      ],
    },
    {
      version: "0.24.0",
      date: "2026-08-29",
      title: "Windows tools where search can find them",
      changes: [
        ["new", "Event Log Streamer reads and filters live Application, System, and Security events without opening Event Viewer."],
        ["new", "Registry browses real keys and values, with explicit two-step confirmation before deletion."],
        ["new", "System audits user and machine PATH entries and calls out missing folders, duplicates, and unresolved variables."],
        ["new", "Log Tail follows the newest lines in a local text log, with bounded output and text or regular-expression filtering."],
        ["new", "Lock Inspector uses Windows Restart Manager to name the processes holding a file or folder and whether Windows considers them restartable."],
        ["new", "Nine separate allow-listed repair tools cover audio, display, networking, devices, Explorer caches, and stuck print queues, with a second click before disruptive work."],
        ["better", "Every new tool is separately searchable and pinnable, runs off the window thread, and reports its current phase in the status bar."],
      ],
    },
    {
      version: "0.23.12",
      date: "2026-08-29",
      title: "Skip the startup scan when it is still fresh",
      changes: [
        ["better", "Opening the app no longer rescans if the last scan finished within five minutes — the project list comes back immediately. Rescan / F5 still reads the disk."],
      ],
    },
    {
      version: "0.23.11",
      date: "2026-08-29",
      title: "Empty search is latest used only",
      changes: [
        ["better", "An empty Ctrl+K list is only the tools you opened last — not pins, and not Process Explorer or DNS unless you used them."],
      ],
    },
    {
      version: "0.23.10",
      date: "2026-08-29",
      title: "Search leads with what you use",
      changes: [
        ["better", "Ctrl+K no longer dumps the whole util catalog when the box is empty — type to find a tool you have not opened yet."],
        ["fix", "Opening search no longer keeps leftover project-filter text, which was ranking random keyword hits."],
      ],
    },
    {
      version: "0.23.9",
      date: "2026-08-29",
      title: "Download opens Save As",
      changes: [
        ["fix", "Download on a utility tool now opens the real Windows Save As dialog instead of silently doing nothing in the WebView."],
      ],
    },
    {
      version: "0.23.8",
      date: "2026-08-29",
      title: "Huge output becomes a download",
      changes: [
        ["better", "When a utility tool's output is over a million characters, the window no longer tries to paint it — you get a Download .txt button instead, so the UI stays responsive."],
      ],
    },
    {
      version: "0.23.7",
      date: "2026-08-29",
      title: "Big pastes no longer blow the stack",
      changes: [
        ["fix", "Encoding a longer paste as Base64, hex or binary no longer throws \"Maximum call stack size exceeded\" — the old path spread every byte onto the call stack at once."],
      ],
    },
    {
      version: "0.23.6",
      date: "2026-08-29",
      title: "Copy any cell",
      changes: [
        ["better", "Utility tool output can be selected and copied as normal text — the page no longer blocks selection there."],
        ["better", "Row results (Unix time, GUID formats, hashes, and the rest) and JWT-style blocks each have their own copy button on the value."],
      ],
    },
    {
      version: "0.23.5",
      date: "2026-08-29",
      title: "Detect only on Anything",
      changes: [
        ["better", "The detect strip only appears on Anything, and only when it actually recognised what you pasted — other tools and empty inputs stay clean."],
      ],
    },
    {
      version: "0.23.4",
      date: "2026-08-29",
      title: "Tools without the chatter",
      changes: [
        ["better", "Utility tools no longer flash lines like \"Generated a fresh batch\" — the in-tool status strip is gone. Copy, paste, regenerate and the rest just do the thing; only a real clipboard failure shows in the bottom status bar."],
      ],
    },
    {
      version: "0.23.3",
      date: "2026-08-29",
      title: "No empty action on the toolbar",
      changes: [
        ["fix", "Utility tools that have no primary action (HTML repair, Base64, and the rest) no longer show an empty blue button on the right of the toolbar."],
        ["better", "The HMAC key field placeholder says \"signing key\" instead of \"shared secret\"."],
      ],
    },
    {
      version: "0.23.2",
      date: "2026-08-29",
      title: "Tools stay blank until you paste",
      changes: [
        ["better", "Utility tools no longer pre-fill sample text, and the Sample control is gone — paste or type what you have."],
        ["better", "Anything no longer uses the sparkle icon that read as an AI button."],
      ],
    },
    {
      version: "0.23.1",
      date: "2026-08-29",
      title: "The window starts again",
      changes: [
        ["fix", "Opening the app no longer dies before the overview is drawn: the new utility tools were overwriting names the DNS tool still uses, so the shell never finished wiring — search, close, and everything else looked dead."],
      ],
    },
    {
      version: "0.23.0",
      date: "2026-08-29",
      title: "The small tools, pinned like the big ones",
      changes: [
        ["new", "Twenty local utility tools — Base64, URL, HTML entities, hex, binary, SHA-256/512, MD5, HMAC, JWT decode, UUID, GUID formats, Unix time, Windows FILETIME, JSON, XML, YAML, HTML repair, CSV, and an Anything catch-all that sniffs what you pasted."],
        ["new", "Each one is a tool of its own in search and can be pinned to the status bar (Ctrl+1…9), same as DNS and Process Explorer. They share one page: modes, flags, paste/sample/clear, and copy or send the output back into the input."],
        ["new", "Paste a JWT, GUID, timestamp, JSON, XML or base64-looking blob and the tool offers to switch to the matching one, carrying the input with it."],
        ["better", "Nothing in this set leaves the machine — digests and transforms run in the window itself."],
      ],
    },
    {
      version: "0.22.0",
      date: "2026-08-29",
      title: "DNS, and the file that overrules it",
      changes: [
        ["new", "A DNS tool. Ctrl+K, type \"DNS\", Enter — or pin it to the status bar like any other tool. It has no tab at the top of the window and never will."],
        ["new", "Type a name and press Enter: every record type comes back at once — A, AAAA, CNAME, MX, TXT, NS, SOA, SRV and CAA — with real TTLs, the response code and how long it took. Type an address instead and it goes the other way and finds the name."],
        ["new", "The same question is put to your own resolver and to Cloudflare, Google, Quad9 and OpenDNS side by side. When they disagree, the odd one out is marked — which is how you tell a stale cache from a change that has not landed yet."],
        ["new", "Your hosts file, edited safely: a switch per line to comment it out and back, a row to add one, and a delete that can be undone. Nothing touches disk until you press Apply, and every line you have changed is marked until you do."],
        ["new", "Applying takes a copy of the file first, asks Windows for administrator rights only if it has to, and flushes the resolver cache afterwards so the change is actually in force. Restore puts the last copy back."],
        ["new", "When the name you looked up is in your hosts file, the tool says so above the records — that mapping is what your machine will use, whatever DNS says. \"Highlight it\" jumps to the line."],
        ["new", "A name that comes back NXDOMAIN offers to pin itself to 127.0.0.1 in one click."],
        ["new", "The left column fills itself in from the projects you have scanned: every host in their git remotes, .env files and docker-compose files, next to everything your hosts file already has an opinion about. One flat A-to-Z list, one row per name however many places it turns up in."],
        ["better", "Hosts lines that point a real public domain at an address of your own are called out, and so are lines shadowed by an earlier mapping that always wins."],
        ["better", "Flush cache empties the Windows resolver cache and re-runs the lookup, so you can see what changed."],
      ],
    },
    {
      version: "0.21.1",
      date: "2026-08-29",
      title: "Sorting that means it",
      changes: [
        ["fix", "Sorting in the Process Explorer now runs across the whole list: ask for the most memory and the row at the top really is the hungriest process on the machine, not the hungriest one on whichever shelf it happened to sit on."],
        ["fix", "Every row on screen is now measured, so a process that holds no port no longer sinks to the bottom of a sort with nothing to sort it by."],
        ["fix", "The detail pane on the right scrolls again — the process tree and the facts below it were being squashed instead of scrolled past."],
        ["better", "The Dev filter is gone. Your dev servers keep their shelf at the top of the list, so there was never anything to filter down to."],
        ["better", "The \"Listening\" filter is now called \"Ports\", and ordering by port number is gone: the list sorts by CPU or memory, memory first."],
      ],
    },
    {
      version: "0.21.0",
      date: "2026-08-29",
      title: "Tools are found, not filed",
      changes: [
        ["new", "Tools no longer take a tab at the top of the window. The Process Explorer — and every tool added beside it — is found by searching for it: Ctrl+K, type its name, Enter."],
        ["new", "Keep the ones you use: pin a tool and it gets a chip in the status bar, next to Terminal, visible from every screen. Click the chip to open it, the × on the end of it to give the seat back — and if that tool is the one you are looking at, the × closes it too. Ctrl+1 to Ctrl+9 jump straight in."],
        ["new", "Pin from wherever you are standing — the pin beside a row in search, the button in a tool's own header, or the dashed slot that appears in the status bar while an unpinned tool is open."],
        ["better", "With nothing pinned, the status bar shows nothing: the dock appears the first time you pin something and disappears again when you unpin the last one."],
        ["new", "Pin as many as you like. The bar keeps the first four and the rest open upward under \"more\", with their shortcut numbers and a way to unpin."],
        ["better", "The Process Explorer now has a header saying what it is, with the pin and the way back to the overview on the end of it."],
        ["better", "Search knows about tools and destinations, and puts the ones you have pinned at the top of the list."],
        ["better", "The mouse's back button now leaves a tool the way it already left a project's details — one step back to the overview."],
      ],
    },
    {
      version: "0.20.0",
      date: "2026-08-28",
      title: "The port explorer, redrawn",
      changes: [
        ["new", "The Processes screen is now a port explorer: one row per port, sorted into your dev servers, the databases and services you rely on, and the rest of Windows."],
        ["new", "Selecting a port opens a panel for it — what holds it, its process tree, live CPU and memory graphs, and its executable, folder and command line."],
        ["new", "Pin the ports you keep coming back to. They sit along the top with a live CPU trace, and a pin stays put across restarts because it remembers the port, not the process."],
        ["new", "Killing something can now take its whole tree, so a supervisor cannot restart the worker on the way down. The confirmation names every process going with it."],
        ["new", "A port belonging to a project with a run command can be restarted: it is stopped and started again in a terminal."],
        ["new", "CPU, memory and uptime are read every two seconds while the explorer is open, straight from Windows rather than through a process sweep. The reading can be paused."],
        ["new", "The port list can be ordered by port number, CPU or memory, either way up. Ordering by cost keeps itself up to date as the readings come in, and holds still while the pointer is over the list."],
        ["better", "The explorer opens a shell in the terminal dock at the bottom rather than a separate window, so you can type in the folder while still watching the port."],
        ["new", "A port belonging to a scanned project has a `Project` button straight to that project's details."],
      ],
    },
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
