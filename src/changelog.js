// The release history behind the version button in the status bar.
//
// Newest first. `wintChangelog.current` is the version the status bar shows,
// and it is the version at the top of this list - the two can never drift
// apart because there is only one place to write it down.
//
// `kind` is one of "new", "better" or "fix"; it only picks the colour and the
// word in front of the line.
//
// `buildChecksum` is the SHA-256 of that version's Store exe. It is written
// after the package is built, never before: putting the hash into this file
// first would change the binary, so the number would no longer match. What's
// new hashes the running exe for the current version only on an official
// Store package (`package-msix.ps1`); older versions show the recorded number
// from when they shipped. Dev builds never hash or show a live checksum line.
window.wintChangelog = (() => {
  const releases = [
    {
      version: "0.88.7",
      date: "2026-09-05",
      title: "Escape closes clipboard history",
      changes: [
        ["fix", "Escape now closes the clipboard picker even when one of its history rows has keyboard focus."],
      ],
    },
    {
      version: "0.88.6",
      date: "2026-09-05",
      title: "Click a clip to paste it",
      changes: [
        ["fix", "Clicking an item in the clipboard picker now returns to the original application and pastes it there, matching Enter."],
      ],
    },
    {
      version: "0.88.5",
      date: "2026-09-05",
      title: "Full clipboard history comes to the front",
      changes: [
        ["fix", "Open full history from the clipboard picker now restores and focuses the main WinT window before opening the Clipboard History tool."],
      ],
    },
    {
      version: "0.88.4",
      date: "2026-09-05",
      title: "Clipboard picker stays open through focus handoff",
      changes: [
        ["fix", "The clipboard picker no longer closes itself during the brief native-window-to-keyboard focus transition after its shortcut opens it."],
      ],
    },
    {
      version: "0.88.3",
      date: "2026-09-05",
      title: "Keyboard focus reaches the clipboard picker",
      changes: [
        ["fix", "Clipboard History opened by its system-wide shortcut now transfers keyboard focus into the picker, so arrows, repeated shortcut presses, Escape, and Enter work."],
      ],
    },
    {
      version: "0.88.2",
      date: "2026-09-05",
      title: "Pick with focus, paste at the original cursor",
      changes: [
        ["better", "The clipboard picker keeps keyboard focus for arrow-key navigation, then Enter returns to the window and cursor that opened it and pastes the selected entry there."],
      ],
    },
    {
      version: "0.88.1",
      date: "2026-09-05",
      title: "A separate shortcut for the full clipboard tool",
      changes: [
        ["better", "Hotkey settings now offer a separate, unbound action for opening the full Clipboard History tool, independently of the compact clipboard picker."],
      ],
    },
    {
      version: "0.88.0",
      date: "2026-09-05",
      title: "Clipboard history at the shortcut",
      changes: [
        ["better", "The Clipboard History shortcut now opens a compact picker instead of navigating away to the full tool."],
        ["new", "Pressing the Clipboard History shortcut again while its picker is open selects the next saved item."],
      ],
    },
    {
      version: "0.87.0",
      date: "2026-09-05",
      title: "GitHub workflows in every workspace",
      changes: [
        ["new", "The Save & upload panel now shows every GitHub Actions workflow in the repository, including the latest result for each one."],
        ["new", "Workflows that support manual runs now have a Run button beside their status."],
      ],
    },
    {
      version: "0.86.2",
      date: "2026-09-05",
      title: "Copy and redirect an agent",
      changes: [
        ["fix", "Text in a workspace agent conversation can now be selected and copied, including answers, code, and other transcript output."],
        ["new", "Every code block in a workspace agent answer now has its own Copy button, with confirmation when the code reaches the clipboard."],
        ["better", "Sending another message while any workspace agent, including Codex, is working now interrupts the current turn and delivers the new message immediately instead of holding it in a queue."],
      ],
    },
    {
      version: "0.86.1",
      date: "2026-09-05",
      title: "Usage sits above the box, not in the conversation",
      changes: [
        ["better", "How much of your five-hour and weekly usage is spent now shows as a small bar above the question box, with the percentage and when each window comes back. It is rewritten in place as the numbers move."],
        ["fix", "The warning about being near the five-hour limit no longer drops into the conversation as a new message on turn after turn."],
      ],
    },
    {
      version: "0.86.0",
      date: "2026-09-05",
      title: "See the page at phone width",
      changes: [
        ["new", "The browser panel can now draw the page at a laptop, tablet or phone width. The buttons sit at the end of the address bar, and they narrow the page inside the panel - the splitters stay exactly where you put them, so the terminal and the file tree do not have to shrink for a look at a narrow layout."],
        ["better", "The site really is that narrow, not scaled down: the browser is genuinely resized, so media queries and responsive layouts behave as they would on the device. The width you picked is remembered per project."],
      ],
    },
    {
      version: "0.85.0",
      date: "2026-09-05",
      title: "Keep typing while the agent works",
      changes: [
        ["new", "You can now write the next message to a workspace agent while it is still working. Enter no longer does nothing: the message is queued in the conversation, shown where it will land, and sent the instant the running turn finishes - so a follow-up you thought of halfway through does not wait for you to notice the agent stopped."],
        ["better", "A queued message can be taken back out with the cross on it, which puts the text back in the box. Pressing Stop does the same for everything still waiting, and a turn that ends in an error hands the queue back rather than firing it at a CLI that just failed."],
      ],
    },
    {
      version: "0.84.0",
      date: "2026-09-05",
      title: "Each workspace browses as itself",
      changes: [
        ["new", "The browser panel now keeps its own cookies, logins and site storage per workspace. Signing in to a site in one project no longer signs you in everywhere, and two projects can be signed in as two different accounts at once. Sign-ins survive closing the panel and quitting the app - but the first open after this update starts fresh, so expect to sign in once more per workspace."],
        ["fix", "Opening a workspace that is already open focuses that window instead of failing. Once its browser panel was open the window stopped being recognised as open at all, so the second attempt tried to build it again and reported an error."],
      ],
    },
    {
      version: "0.83.0",
      date: "2026-09-05",
      title: "The workspace offers to free a port that was taken",
      changes: [
        ["new", "A dev server that cannot have the port it asked for - Vite, Next, and the 'Using alternative port' line - now gets an offer in the corner of the workspace: free that port and start the command again. It names what is holding the port and which process it kills."],
        ["new", "The offer carries a 'Don't show this again' box for anyone who would rather deal with taken ports themselves."],
      ],
    },
    {
      version: "0.82.3",
      date: "2026-09-05",
      title: "Agent steps fold, and edits show what they changed",
      changes: [
        ["fix", "A long run of agent steps folds down to the three most recent again, behind an 'and 7 more' line that opens the rest. Thinking between two tools was quietly breaking the run apart, so ten steps were drawn as ten unfolded lines."],
        ["new", "A step that edits or writes a file shows the first three changed lines under it, added and removed, and opens the whole change in place."],
        ["new", "Thinking the CLI counts but will not send the text of keeps its own line among the steps, with the number of tokens it took, instead of vanishing."],
      ],
    },
    {
      version: "0.82.2",
      date: "2026-09-05",
      title: "Model downloads resume where they stopped",
      changes: [
        ["new", "A model download that is cancelled or interrupted keeps the megabytes it already fetched, and starting it again continues from that point instead of from zero. The model list shows how much is kept, offers Resume, and can discard it."],
        ["better", "Downloads report the exact megabytes transferred, the percentage, the current speed and the time remaining, updated several times a second — a multi-gigabyte model no longer sits on the same rounded figure for minutes."],
        ["better", "Shell downloads show their current speed alongside the megabytes transferred, and resume the same way."],
        ["fix", "Deleting a model also removes any partial download left on disk, so cancelled downloads cannot quietly hold gigabytes."],
      ],
    },
    {
      version: "0.82.1",
      date: "2026-09-05",
      title: "Local Qwen fits on a smaller machine",
      changes: [
        ["new", "The Qwen workspace agent now offers Qwen2.5-Coder 7B as its default local model: a verified 4.7 GB download recommended for machines with 8 GB of memory, while the stronger 30B model remains available."],
        ["better", "Settings › Models shows downloaded models by their friendly names and gives each one an explicit Delete action with confirmation."],
        ["fix", "Deleting a downloaded model clears it from every saved assistant conversation that selected it, so an old chat cannot remain pointed at a file that no longer exists."],
      ],
    },
    {
      version: "0.82.0",
      date: "2026-09-04",
      title: "Local Qwen can work through a project safely",
      changes: [
        ["new", "The Qwen workspace agent can inspect project files, make permission-scoped edits, and run declared checks through a repeated tool loop grounded in the open project."],
        ["better", "Qwen starts investigating immediately instead of loading the large local model once just to create a plan before it can read a file."],
        ["better", "Project writes stay below the open root, replace files atomically, reject files over 1 MB, and block repository metadata, dependency trees, build output, environment files, and private-key formats."],
        ["better", "Only declared npm scripts or fixed Cargo test, check, clippy, and build commands can be used to verify Qwen's changes."],
      ],
    },
    {
      version: "0.81.3",
      date: "2026-09-04",
      title: "A Cursor conversation reads in the order it happened",
      buildChecksum: "24a51f0e9d5f30537dec46c78b63ae6c02d1d03de0c96eea653be2f0e0a4b34c",
      changes: [
        ["fix", "Cursor's answers and its steps are back in the order they happened. Everything it said was folded into the first bubble of the turn and every step piled up underneath, because nothing closed the answer when a tool started - so a turn that read a file, said something, then read another one came out as one paragraph with a stack of tools below it."],
        ["fix", "Two things Cursor said one after the other are two paragraphs again, not one sentence running into the next."],
        ["new", "Cursor's thinking is shown while it thinks, dimmed and clamped to a few lines like every other agent's. It was streaming all along and being thrown away."],
        ["better", "The raw stream view names what it did with each of Cursor's lines instead of marking every one of them \"not rendered\", and its token-by-token lines collapse into one counted row the way Claude's do."],
      ],
    },
    {
      version: "0.81.2",
      date: "2026-09-04",
      title: "A workspace window stops building the panel it replaced",
      changes: [
        ["better", "Opening a workspace no longer sets up the old single-conversation Claude panel behind the one that replaced it. It could not be shown any more, but every window still built it, hung a second full-screen overlay off the page and listened to the same conversation twice - so every line the CLI said was read and thrown away a second time."],
      ],
    },
    {
      version: "0.81.1",
      date: "2026-09-04",
      title: "The lists in a workspace's chat stay where you can see them",
      changes: [
        ["fix", "The earlier-conversations list, the permission menu and the new-conversation picker no longer vanish behind the browser panel. They opened wider than the panel they belong to, and the browser is drawn by Windows on top of the window, so whatever crossed it was simply not there. They now open inside the panel: never wider than it, and never taller than the room under the bar - a long list scrolls instead."],
        ["better", "Opening one of those lists no longer blanks the page in the browser panel while it is up."],
      ],
    },
    {
      version: "0.81.0",
      date: "2026-09-04",
      title: "Clipboard history that was already there when you opened it",
      changes: [
        ["new", "Clipboard History now records every copy from the moment WinT starts, not only while the tool happens to be open. Windows tells WinT when the clipboard changes and the app keeps the history itself, so opening the tool shows what you copied an hour ago instead of an empty list."],
        ["better", "Windows no longer asks for permission to see what you copy, and the tool no longer re-reads the clipboard every 1.2 seconds while it is open."],
        ["better", "The history survives a restart, is written next to WinT's other data rather than inside browser storage, and keeps images copied from screenshot tools as well as from browsers."],
        ["new", "Forget unpinned clears the history in one click, twice to confirm, and leaves everything pinned where it is."],
      ],
    },
    {
      version: "0.80.1",
      date: "2026-09-04",
      title: "The terminal you open is one you can type into",
      changes: [
        ["fix", "Opening a conversation in a terminal now hands it the keyboard. It was opening as something to look at: the cursor blinked, nothing you typed reached it, and approving a command — the one thing that window exists for — took a click first to work out."],
        ["fix", "The terminal now resizes with the window instead of staying at whatever size it happened to open at, so a resized window no longer leaves the text drawn against the wrong width."],
        ["fix", "Opening a terminal from a second conversation no longer silently shows you the first conversation's session. The one that was open is closed and the one you asked for opens."],
        ["better", "Quitting the CLI in the terminal now returns you to the chat by itself, rather than leaving a dead screen with a close button on it."],
        ["fix", "The header names which agent the terminal is running and how to get back, and no longer mislays its own layout."],
      ],
    },
    {
      version: "0.80.0",
      date: "2026-09-04",
      title: "A conversation decides how much it may do",
      changes: [
        ["new", "Conversations now run in automatic mode, where the agent judges each tool on its own merits, rather than the old mode that accepted file edits and refused everything else. A command, a fetch, a script - the things that used to come back refused with nothing said - now mostly just run."],
        ["new", "A shield button on the title line sets how much that one conversation may do without asking: automatic, edits only, plan only, or refuse anything unapproved. It is per conversation, because a tab reading the code and a tab changing it are not owed the same trust, and it is remembered. A conversation held to anything but automatic marks the button."],
        ["better", "A refused tool now says which mode refused it, so the line points at the thing you can change rather than only at the terminal."],
      ],
    },
    {
      version: "0.79.4",
      date: "2026-09-04",
      title: "A silent minute now says what it is spending",
      changes: [
        ["new", "A long think is no longer a blank wait. Claude sends its thinking with the words withheld - only a running token count is real - so the waiting line now carries that count: \"Thinking… 1,350 thinking tokens · 41s\". A minute being spent and a minute wasted finally look different."],
        ["new", "Every turn opens with the model that answered and the permission mode it ran under, so what the answers below are worth is not something you have to remember."],
        ["new", "A usage limit that is no longer allowing work says so in the conversation instead of only killing the turn."],
        ["better", "A finished step is summed up in its own terms - \"34 lines\", \"36 files\", \"4 matches\" - taken from what the tool reported, rather than the first line of whatever it happened to print."],
        ["fix", "A step no longer crushes its own name to make room for its outcome. \"Read\" was being shortened to \"R…\" so the first line of the file could be shown; the name and its argument now keep the room and the outcome gives way first."],
        ["better", "The raw stream view now tells a line the panel deliberately passes over from one nothing matched at all. Only the second kind is highlighted and counted, so the count means what it says."],
      ],
    },
    {
      version: "0.79.3",
      date: "2026-09-04",
      title: "The raw stream, when the panel cannot explain itself",
      changes: [
        ["new", "A debug button on the conversation's title line opens the raw stream underneath it: every line the CLI sent, stamped with how far into the turn it arrived, and marked with what the panel made of it. Lines nothing renders are highlighted, runs of tokens are folded into one row that counts itself, and Copy puts the lot on the clipboard. When the panel goes quiet and you cannot tell whether the agent is working or wedged, this is the answer - a gap in the times is real silence, and untagged lines are the panel failing to draw what did arrive."],
        ["fix", "Installing an agent now shows npm's output as it runs and notices by itself when it has finished, instead of printing nothing and waiting for you to press \"Check again\". None of the install's progress was reaching the panel: those events name the window they came from and nothing finer, and the panel was looking for a conversation id in them that was never there."],
      ],
    },
    {
      version: "0.79.2",
      date: "2026-09-04",
      title: "The same buttons on a card and on a table row",
      changes: [
        ["better", "A project row in the table now offers Workspace, Code and Terminal - the same three the card offers - so switching between the overview and the table never moves a button or takes one away."],
        ["better", "Run and Pull are off the table row. Running a project or pulling it is something you do once you are looking at it, so both live on the project view (Run is also in the command palette)."],
      ],
    },
    {
      version: "0.79.1",
      date: "2026-09-04",
      title: "Save & upload says which folder you are working in",
      changes: [
        ["better", "Save & upload now opens with \"Working on the main folder\" (or master), or \"Working on a separate folder\" with the folder's name on the line underneath. The branch name used to be the headline, which only told you something if you already knew what a branch was."],
      ],
    },
    {
      version: "0.79.0",
      date: "2026-09-04",
      title: "Save & upload shows what is waiting, and can branch or join",
      changes: [
        ["new", "Save & upload lists everything you have saved but not uploaded yet, newest first, with when you saved it. The panel grows to fit the list up to two fifths of the column and the list scrolls after that, so a long queue never squeezes the file list out."],
        ["new", "On the shared branch there is now a button to carry on somewhere of your own, with a name suggested for you, so a change is not saved straight onto main by accident."],
        ["new", "Anywhere else, one button joins everything you saved into the shared branch and uploads it."],
        ["better", "When that cannot be done you are told why in plain words inside the panel - work still unsaved, the same lines changed on both sides, or the team's rules not letting you upload to the shared branch yourself - and a join that fails puts you back where you were with nothing changed."],
      ],
    },
    {
      version: "0.78.2",
      date: "2026-09-04",
      title: "The history list is no longer behind the browser",
      changes: [
        ["fix", "A workspace's earlier-conversations list, and the picker for starting a new one, are visible again when they open across the browser panel. The browser is drawn by Windows on top of the window, so a list reaching into it was simply not there; the page now steps the browser aside while such a list is open and puts it straight back."],
        ["better", "The browser only gets out of the way when the list would actually cross it, so a chat panel wide enough to hold its own list no longer blanks the page you were looking at."],
      ],
    },
    {
      version: "0.78.1",
      date: "2026-09-04",
      title: "Closing a workspace closes its shells",
      changes: [
        ["fix", "Closing a workspace window now closes the terminals it was holding. They used to keep running with nothing anywhere showing them, so a build or a dev server started in a workspace went on running until WinT itself was closed."],
        ["new", "What a workspace's terminals leave behind is checked the same way closing a single terminal already was: anything still running afterwards appears in WinT's status bar, with what it is and a button to kill it."],
        ["better", "Alt+F4 on a workspace now puts the window away as properly as the cross does - the browser panel and every shell are closed either way."],
      ],
    },
    {
      version: "0.78.0",
      date: "2026-09-04",
      title: "You can see what the agent is doing",
      changes: [
        ["new", "A running turn now shows its work as it happens: every tool the agent starts appears the moment it starts, with a live dot, and turns into a tick or a red cross carrying the first line of what came back. A step that only ever said it started could not be told from one that had hung."],
        ["new", "When the agent needs permission to run something, the chat says so on its own line instead of going quiet. Nothing in the chat can answer a permission prompt - the CLI is driven without anything to ask - so the line carries the button that opens the same conversation in a terminal, where you can approve it."],
        ["new", "Claude's thinking is shown while it thinks, dimmed and folded to a few lines, with the rest openable in place."],
        ["new", "The waiting line names the phase the CLI says it is in - asking the model, running a tool, compacting - and otherwise names the step still running, rather than always saying Thinking."],
        ["new", "A finished turn ends with what it took: how long, how many tokens, what it cost."],
        ["better", "Pasting a wall of text into the chat no longer buries the conversation - anything over a dozen lines folds to its opening lines, with a line that opens and closes the rest."],
        ["better", "An answer that carries on after a tool call now starts its own block instead of being appended to the bubble above the steps."],
        ["better", "The waiting line and the tab's live dot last until the turn actually ends, rather than stopping the moment the last token arrived."],
        ["better", "Cursor and Codex steps also appear as they start, and gain an outcome when they end."],
        ["fix", "A conversation no longer gets stuck on \"Session ID … is already in use\". A tab now knows its conversation exists from the moment the CLI names it, rather than only once the turn it is streaming has finished - so the next question resumes it instead of trying to start it again. A tab already in that state picks itself back up on the next try."],
        ["fix", "Pressing Enter twice while a turn is still running no longer starts a second run of the same conversation."],
        ["fix", "Adding a conversation from a pane's + menu no longer throws when the click lands on a node a redraw has already replaced."],
      ],
    },
    {
      version: "0.77.0",
      date: "2026-09-04",
      title: "The empty browser panel is a play button",
      changes: [
        ["new", "A workspace with nothing running opens on a big play button carrying the command that starts the project - npm run dev, cargo run, whatever the folder actually says. Pressing it types the command into the terminal below, and the panel opens on the address the server prints."],
        ["new", "The command sits in a box you can edit when the guess is wrong, and what you type there is kept for that project."],
        ["better", "The address bar shows where the browser panel actually is - a link followed inside the page, a redirect, an app rewriting its own address - instead of only the address it was told to open. Its empty state no longer suggests a localhost port that was never there."],
        ["fix", "Shrinking the window or dragging a divider now resizes the page in the browser panel with it, instead of leaving it drawn over the terminal at its old size."],
      ],
    },
    {
      version: "0.76.1",
      date: "2026-09-04",
      title: "Save & upload keeps its own height",
      changes: [
        ["fix", "Narrowing the sidebar no longer squeezes Save & upload into a scrollbar. Save, Upload and Get wrap onto more rows when they no longer fit side by side, and the panel is given exactly the height everything it is showing needs - header included, whether or not that header has wrapped."],
        ["better", "The panel re-measures itself when the window is resized as well as when a divider is dragged, and stops growing before it would squeeze the panel above it out of the column."],
      ],
    },
    {
      version: "0.76.0",
      date: "2026-09-04",
      title: "Every agent tab can reopen an earlier conversation",
      changes: [
        ["new", "The Agent panel keeps the conversations this project has had before. The history button on a tab opens the list - what it was about, when it was last touched, how many questions it took - and picking one replays it into that tab and carries on with it."],
        ["better", "The tabs now sit on a row of their own, and the row underneath names the conversation on screen and carries the buttons that act on it. Before, those buttons sat beside the whole strip and it was not clear which conversation they would hit."],
        ["fix", "A conversation opened from history is still the same conversation after the window is reloaded, instead of the next question starting over."],
      ],
    },
    {
      version: "0.75.1",
      date: "2026-09-04",
      title: "All / Changed survives a narrow sidebar",
      changes: [
        ["fix", "Squeezing the files panel no longer puts a scrollbar inside the All / Changed switch and hides half of it. The switch drops whole onto a second line of the panel header instead, with both words still readable."],
      ],
    },
    {
      version: "0.75.0",
      date: "2026-09-04",
      title: "The agent chat shows its work",
      changes: [
        ["new", "A chat that is working says so: a line with a spinner and the seconds it has been running appears the moment you send, and stays up between steps instead of leaving the panel blank."],
        ["new", "Steps the agent takes - files read, edits made, commands run, searches - are grouped into one block between answers. The three most recent stay visible and the rest fold behind a line that opens them in place."],
        ["better", "Answers are written out rather than pasted in, with a caret on the line being written, so a reply that arrives in one piece reads the same way as one that arrives token by token."],
        ["better", "Codex now names what it did - the commands it ran and the files it changed - the way the other agents already did."],
        ["fix", "Scrolling back through a conversation is no longer yanked to the bottom by every new token; the log follows along only when it was already at the end."],
      ],
    },
    {
      version: "0.74.5",
      date: "2026-09-03",
      title: "The browser follows the dev server again",
      changes: [
        ["fix", "Starting a dev server in a workspace terminal points the browser panel at it again. The panel was watching for the announcement but threw the moment one arrived, so it sat on its empty page no matter what the terminal printed."],
        ["better", "The address is now found however the server spells it - https, 0.0.0.0 and [::1] as well as localhost and 127.0.0.1 - and a 0.0.0.0 is turned into localhost, which is the one a browser can actually open."],
        ["better", "Opening a workspace whose dev server is already running points the browser at it straight away, instead of waiting for a restart to hear the address."],
      ],
    },
    {
      version: "0.74.4",
      date: "2026-09-03",
      title: "The gap under Save & upload is gone",
      changes: [
        ["fix", "The blank strip under Save & upload in a workspace is gone, and the Files panel above it now really does take the rest of the column. 0.74.2 only looked like it fixed this."],
      ],
    },
    {
      version: "0.74.3",
      date: "2026-09-03",
      title: "Send button back on the row",
      changes: [
        ["fix", "The agent chat's Send button sits beside the message box again, instead of wrapping onto its own line below it."],
      ],
    },
    {
      version: "0.74.2",
      date: "2026-09-03",
      title: "Files fills the column again",
      changes: [
        ["fix", "The Files panel in a workspace now fills the rest of the left column below Save & upload, instead of leaving a blank gap at the bottom of the column."],
      ],
    },
    {
      version: "0.74.1",
      date: "2026-09-03",
      title: "Open in VS Code opens the right project",
      changes: [
        ["fix", "Open in VS Code from a workspace file preview now opens (or reuses) that project's own window, instead of dropping the file into whichever window VS Code last had active."],
      ],
    },
    {
      version: "0.74.0",
      date: "2026-09-03",
      title: "A file preview you can edit",
      changes: [
        ["new", "A previewed file can now be edited in place - typing shows a dot and a Save button on the header, and the change is highlighted live as you type."],
        ["new", "Leaving an edited file - closing the preview, opening another file, or closing the window - now asks whether to save it or discard the change."],
        ["fix", "Open in VS Code now finds VS Code even when it was installed after the app last started, instead of silently doing nothing."],
        ["fix", "A workspace window's title bar now shows the same icon as its taskbar entry, instead of the main app's icon."],
      ],
    },
    {
      version: "0.73.0",
      date: "2026-09-03",
      title: "Overview opens on last scan",
      changes: [
        ["better", "Opening the overview now shows the projects from the last scan right away, in the same order, instead of waiting on a fresh one - a rescan still runs behind it and updates cards one by one as results land."],
      ],
    },
    {
      version: "0.72.1",
      date: "2026-09-03",
      title: "Save & upload sized to fit",
      changes: [
        ["fix", "The Save & upload panel now takes only the height its message box and buttons need, and the Files panel above it gets the rest - the divider between them no longer drags, since there's nothing left for it to decide."],
      ],
    },
    {
      version: "0.72.0",
      date: "2026-09-03",
      title: "Several conversations at once",
      changes: [
        ["new", "The Agent panel now holds conversations as tabs, so you can have more than one open at a time - including several of the same agent - switch between them, drag to reorder, or drag a tab to the edge to split the panel into two."],
        ["better", "The Agent panel fills the whole height of its column again; it used to stop halfway down with blank space below it."],
      ],
    },
    {
      version: "0.71.0",
      date: "2026-09-03",
      title: "A file preview that reads like code",
      changes: [
        ["new", "Clicking a file in a workspace's Files panel now shows it with syntax highlighting and line numbers, instead of plain text."],
        ["new", "Image files (PNG, JPEG, GIF, WebP, BMP, ICO, AVIF, SVG) open in the preview as a picture rather than raw bytes."],
        ["new", "The preview header now has Reveal in Explorer and Open in VS Code buttons for the file being shown."],
      ],
    },
    {
      version: "0.70.6",
      date: "2026-09-03",
      title: "A workspace theme of its own",
      changes: [
        ["new", "A workspace window's light or dark colors can now be set separately from the main window's, in Settings: align with the app, or pin it to light or dark."],
      ],
    },
    {
      version: "0.70.5",
      date: "2026-09-03",
      title: "A workspace of its own",
      changes: [
        ["better", "Workspace windows now carry their own taskbar icon instead of the main WinT icon, so an open workspace is easy to pick out among other windows."],
        ["fix", "A workspace window now follows light/dark mode like the rest of the app, instead of always opening dark. Its terminal panel keeps its own fixed terminal colors either way."],
      ],
    },
    {
      version: "0.70.4",
      date: "2026-09-03",
      title: "A terminal comes home",
      changes: [
        ["fix", "Popping a terminal out of a workspace and docking it back in now actually returns it to that workspace, instead of silently failing to dock."],
      ],
    },
    {
      version: "0.70.3",
      date: "2026-09-03",
      title: "Agent panel restored",
      changes: [
        ["fix", "Restored the workspace Agent panel to switch between Claude, Cursor, Copilot, Codex and Gemini, with cached install checks and a spinner while rechecking."],
      ],
    },
    {
      version: "0.70.2",
      date: "2026-09-03",
      title: "The status bar is gone",
      changes: [
        ["better", "The status bar that said transient things (Went back, Browsing..., Resized) has been removed to free vertical space. Errors and important feedback already surface in the relevant panels."],
      ],
    },
    {
      version: "0.70.1",
      date: "2026-09-03",
      title: "Room for a long branch name",
      changes: [
        ["fix", "A long branch name in Save & upload can wrap onto a second line, and the panel grows with it instead of clipping the name."],
      ],
    },
    {
      version: "0.70.0",
      date: "2026-09-03",
      title: "Branches, and git in its own words",
      changes: [
        ["new", "The branch in a workspace's Save & upload panel is a menu of every other branch: pick one and the workspace checks it out. When git refuses because it would tread on work you have not saved, it says so in its own words."],
        ["new", "Settings can put that panel into git's vocabulary — commit, push, pull, branch — instead of spelling out what each button does. Every open workspace changes its words the moment you turn it on."],
        ["fix", "A terminal popped out of a workspace docks back into that workspace, however it left it. Which dock is holding which terminal is now written where every window can read it, rather than asked for over a broadcast and answered too late."],
        ["better", "Save & upload takes the height of what it is showing instead of a fixed slice of the column, so the file list above it keeps everything else."],
      ],
    },
    {
      version: "0.69.4",
      date: "2026-09-03",
      title: "Two things a workspace panel no longer does",
      changes: [
        ["fix", "Panel headers no longer carry a grip that suggests they can be dragged to another slot. They never could: a window that takes file drops - which is how an attachment reaches the chat - never sees a drag inside the page, so the gesture was drawn but dead."],
        ["better", "Save & upload takes a fixed height under the file list rather than a share of the column. It is a line of state, a message box and three buttons, and everything it was not using now goes to the files above it."],
      ],
    },
    {
      version: "0.69.3",
      date: "2026-09-03",
      title: "The terminal panel loses its second headline",
      changes: [
        ["better", "The terminal panel in a workspace no longer carries a header above its tab strip. The strip already says which terminal each tab is, so the bar above it was the same headline twice - and a row of the panel spent on it, which the terminal now gets instead. The handle that drags the panel between slots sits at the head of the strip."],
        ["fix", "A panel can be dragged to another slot from the foot of the window, where the bottom panel hangs whenever there is no center panel for it to sit under."],
      ],
    },
    {
      version: "0.69.2",
      date: "2026-09-03",
      title: "Known agents open without waiting",
      changes: [
        ["better", "An agent whose CLI already worked on this computer opens straight into the chat. WinT still looks again in the background, and Check again still shows the spinner when you ask it to."],
      ],
    },
    {
      version: "0.69.1",
      date: "2026-09-03",
      title: "The browser panel opens where you left it",
      changes: [
        ["new", "The browser panel comes back on the page it was showing when you last closed the window, with the address in the box, instead of on the empty card that asks you to start a dev server."],
      ],
    },
    {
      version: "0.69.0",
      date: "2026-09-03",
      title: "Several agents at once",
      changes: [
        ["new", "The Agent panel holds a strip of conversations rather than one at a time: open Claude, Cursor, Copilot, Codex and Gemini together, or two of the same one, and switch between them the way you switch terminals. Each has its own CLI running, so two of them can be working on the same project at once."],
        ["new", "A conversation that is not on screen keeps answering. Its tab shows a pulsing dot while it works, the status bar says when it has answered, and switching to it shows everything it said while you were reading another."],
        ["better", "The plus on the strip starts another conversation with whichever agent you pick; the cross closes one and stops whatever it was answering. The last conversation stays, because a panel with none has no way back to an agent."],
        ["better", "A workspace reopens with the conversations it had open, in the same order, with the same one on top."],
      ],
    },
    {
      version: "0.68.0",
      date: "2026-09-03",
      title: "Paste a screenshot into the chat",
      changes: [
        ["new", "The workspace chat takes attachments. Paste a screenshot straight into the composer, or drag files onto the window, and they go up with your next message — Claude, Cursor, Copilot, Codex and Gemini all get them the same way."],
        ["new", "Text files are attachments too, whatever they are called: a log, a diff, a stack trace, a config, an extensionless Makefile. Anything binary is turned away rather than pasted in as noise."],
        ["new", "A paste too long to read in a three-line composer becomes a text file instead of a wall of text, so what you typed is still visible above what you pasted."],
        ["better", "Each attachment shows as a chip you can take back off before sending, with the path it will be given, and stays on the message once it has gone up."],
      ],
    },
    {
      version: "0.67.6",
      date: "2026-09-03",
      title: "A copilot that cannot answer is not installed",
      changes: [
        ["fix", "The Copilot panel no longer offers a chat that can never answer. VS Code's Copilot extension leaves a launcher called copilot on PATH that reports success while saying it cannot find the CLI, and WinT took that sentence for a version number and showed it as the installed Copilot. A version has to look like one now, and where several copilots answer to the name, the one that actually runs is used."],
        ["better", "Claude, Cursor, Codex and Gemini are checked the same way, so none of them can be reported as installed by something merely answering to the name."],
      ],
    },
    {
      version: "0.67.5",
      date: "2026-09-03",
      title: "Closing the file preview closes it",
      changes: [
        ["fix", "Closing a file preview in a workspace now puts it away. With no page loaded in the browser panel there was nothing covering the preview, so it stayed on screen and the button looked broken."],
      ],
    },
    {
      version: "0.67.4",
      date: "2026-09-03",
      title: "The address bar follows the page",
      changes: [
        ["fix", "Follow a link inside the browser panel and the address above it now changes with the page. It used to show whatever was last typed or detected, so after two clicks the box and the page disagreed, and Back landed somewhere the box could not name. Redirects and posted forms report themselves the same way."],
      ],
    },
    {
      version: "0.67.3",
      date: "2026-09-03",
      title: "The preview fits, and says where the file is",
      changes: [
        ["new", "The file preview has a button that shows the file in File Explorer, with the file already picked out in its folder."],
        ["fix", "A picture bigger than the panel is sized down to fit it instead of overflowing and having to be scrolled."],
      ],
    },
    {
      version: "0.67.2",
      date: "2026-09-03",
      title: "Agent install check shows a spinner",
      changes: [
        ["fix", "Switching to an agent or opening the panel no longer flashes \"isn't installed\" while WinT is still looking for the CLI — it says it is checking, with a spinner, until the answer is in."],
      ],
    },
    {
      version: "0.67.1",
      date: "2026-09-03",
      title: "A workspace terminal comes home",
      changes: [
        ["fix", "A terminal popped out of a workspace docks back into that workspace and not into the main window, whatever else is open - and the terminal panel opens for it if it had been put away. Only once the workspace itself has closed does WinT take such a terminal in, rather than leave a shell running with no window showing it."],
      ],
    },
    {
      version: "0.67.0",
      date: "2026-09-03",
      title: "The workspace file preview reads like code",
      changes: [
        ["new", "Files opened from a workspace's file list are syntax coloured - JavaScript, TypeScript, Rust, Python, the C family, Go, Java, C#, PHP, shell and PowerShell, SQL, CSS, HTML and XML, JSON, YAML, TOML, INI and Markdown - with numbered lines down the side that stay put when a long line is scrolled sideways."],
        ["new", "Images open in the preview instead of being turned away as binary: PNG, JPEG, GIF, WebP, BMP, AVIF, ICO and SVG, drawn on a chequerboard so transparency shows as transparency, up to 16 MB."],
        ["better", "The preview header says what it is showing - the language and the line count for a file, the pixel size and the file size for an image."],
      ],
    },
    {
      version: "0.66.1",
      date: "2026-09-03",
      title: "The assistant routes on meaning, not on words",
      changes: [
        ["fix", "The assistant no longer overrides its own routing when your question happens to contain a word like ping, binary or hex - it reads what you asked and picks the area itself, so \"helping\" or \"mapping\" no longer sends a question to Path Ping."],
      ],
    },
    {
      version: "0.66.0",
      date: "2026-09-03",
      title: "The workspace terminal is the terminal",
      changes: [
        ["new", "The terminal in a workspace is WinT's own terminal panel: several shells in tabs, a split down the middle, every shell type from the menu, restart a tab as another shell, drag tabs to reorder them, and drag one out into a window of its own."],
        ["better", "A workspace remembers which terminals it had open and brings them back, in the same order, the next time it opens - and keeps its own list, so its terminals and WinT's never turn up in each other's windows."],
        ["better", "Shell colours, markers, the default shell and the history settings are one answer for the whole app: a workspace terminal follows what WinT's settings say, and follows a change to them as it is made."],
        ["fix", "A terminal popped out into its own window now docks back into the window it came from rather than into whichever one heard first."],
      ],
    },
    {
      version: "0.65.0",
      date: "2026-09-03",
      title: "Codex in the Agent panel",
      changes: [
        ["new", "OpenAI's Codex CLI joins the Agent panel beside Claude, Cursor, Copilot and Gemini — install it, sign in, ask, stop, open the conversation in a terminal, and browse earlier chats for this project."],
      ],
    },
    {
      version: "0.64.1",
      date: "2026-09-03",
      title: "The AI panel says what it is for",
      changes: [
        ["better", "A new chat in the AI panel now explains that the assistant drives WinT and Windows itself - and when what you want is a coding agent, it names your own command-palette shortcut and the word to type to open a workspace."],
      ],
    },
    {
      version: "0.64.0",
      date: "2026-09-03",
      title: "Copilot and Gemini in the Agent panel",
      changes: [
        ["new", "GitHub Copilot joins the Agent panel beside Claude and Cursor — install the CLI, sign in, ask, stop, open the conversation in a terminal, and browse earlier chats for this project."],
        ["new", "Google's Gemini CLI is there too, with the same install, chat, history and terminal path as the other agents."],
      ],
    },
    {
      version: "0.63.0",
      date: "2026-09-03",
      title: "Claude and Cursor in one Agent panel",
      changes: [
        ["new", "The chat panel is now Agent: switch Claude Code and Cursor Agent with a control in the header, the same way the terminal picks a shell. Each keeps its own conversation, install state and history."],
        ["new", "Cursor Agent talks in the same panel — install, sign in, ask, stop, open the conversation in a full terminal, and browse earlier chats for this project."],
        ["better", "The right column no longer reserves an empty second slot for Cursor. One agent panel is enough; drag another panel there if you want the split."],
      ],
    },
    {
      version: "0.62.2",
      date: "2026-09-03",
      title: "Closing a file shows the browser again",
      changes: [
        ["fix", "Closing a file preview in the browser panel puts the browser back — the live page if one is open, or the empty state if not. The preview used to leave a blank hole."],
        ["better", "The browser address box no longer pretends localhost:3000 is already typed in. Its placeholder is just Address."],
      ],
    },
    {
      version: "0.62.1",
      date: "2026-09-03",
      title: "Hiding the browser leaves the chats",
      changes: [
        ["fix", "Hiding the workspace browser no longer takes the chats with it. The divider next to the browser was leaving the grid, and the right column slid into the gap and collapsed."],
        ["fix", "A workspace slot that has no panel in it is no longer drawn as an empty box. The right-bottom place held for Cursor was showing blank until that panel exists."],
      ],
    },
    {
      version: "0.62.0",
      date: "2026-09-03",
      title: "The chat writes, and remembers",
      changes: [
        ["new", "Answers are written out as they arrive instead of landing in jumps. The text is let out at the speed it is coming in, so a long answer reads as writing and never falls behind."],
        ["new", "A line under the conversation says what Claude is doing and how long it has been at it - Thinking, Reading, Running a command - from the moment you press Enter. The first question no longer looks like nothing happened."],
        ["new", "A clock in the corner of the chat opens every earlier conversation this project has had, newest first, with what you asked and when. Pick one and it comes back into the panel and carries on - conversations held in a terminal included."],
        ["new", "The browser panel has back, forward and a Go button, so an address you type goes somewhere without having to know that Enter was the only way to send it."],
        ["better", "Panels no longer carry a close button in their own header. The toolbar above already shows and hides them, and a panel that could close itself but not reopen itself was a door with a handle on one side."],
        ["fix", "Open in your real browser now opens the address in the box rather than only the one already loaded, and says what it did. Typing somewhere new and reaching for it did nothing at all, silently."],
      ],
    },
    {
      version: "0.61.1",
      date: "2026-09-03",
      title: "An answer about signing in is not a demand to sign in",
      changes: [
        ["fix", "Asking Claude something whose answer mentions signing in no longer wipes the chat and replaces it with the sign-in card. Any answer containing the words was being read as the CLI refusing to work; now only the CLI's own message counts, and an answer that arrives takes the card back down."],
      ],
    },
    {
      version: "0.61.0",
      date: "2026-09-03",
      title: "One conversation, two ways to see it",
      changes: [
        ["new", "The Claude chat and Claude's own interface are now the same conversation. Open it in a terminal from the chat header, do whatever the chat cannot - approve a command Claude wants to run, use a slash command, sign in - then close the terminal and carry on in the chat with all of it in the history."],
        ["new", "When a turn ends badly the chat says what probably happened and offers the way through. In chat mode Claude reads and edits freely, but anything it would normally ask you about it simply declines, because there is nobody to ask."],
        ["better", "That terminal opens over the whole window rather than in a pane. Claude's interface is a full-screen program, and cramming it into a narrow column is the thing this panel was built to stop. Escape closes it."],
      ],
    },
    {
      version: "0.60.1",
      date: "2026-09-03",
      title: "A tool that fails to open offers you another go",
      changes: [
        ["new", "A tool that could not open now has a Try again button on the error, instead of leaving you with the reason and no way to act on it."],
        ["fix", "Leaving a tool that failed to open throws it away. It was being kept warm like a working one, so coming back showed you the same cached error page without ever retrying."],
      ],
    },
    {
      version: "0.60.0",
      date: "2026-09-03",
      title: "Claude is a chat, not a terminal",
      changes: [
        ["new", "The workspace Claude panel is a real conversation now - your message, Claude's answer as it is written, and a line for each file it reads or edits. It was running the CLI's own full-screen interface in a narrow pane, which is why it opened onto theme pickers, boxes and wrapped ASCII art."],
        ["new", "Not installed? The panel says so and installs it for you, with npm's output in the panel rather than a terminal you have to answer. Not signed in? It says that too, and opens a terminal for the one step that genuinely needs one."],
        ["better", "Still your Claude Code, still your account. WinT asks for no API key, stores no credentials and reads none - it starts the CLI you installed and shows what it says."],
      ],
    },
    {
      version: "0.59.0",
      date: "2026-09-03",
      title: "The workspace browser finds your dev server",
      changes: [
        ["fix", "Starting a dev server in a workspace terminal now opens it in the browser panel. The address was being looked for in what the program wrote, and Windows does not hand that over unchanged - it repaints the screen, and a coloured, aligned banner like Nuxt's or Vite's arrives in pieces with the address split between them. It is read off the screen now, where it is one piece however it got there."],
        ["better", "Showing only changed files keeps the tree, with every folder holding a change already open, instead of flattening everything into one list of names."],
        ["better", "Hiding the workspace browser no longer leaves a hole where it was. The file list and the chat close up against each other and share the width."],
        ["better", "Project cards are down to Workspace, Code and Terminal. Pull has gone the way of Run - it is still on the project itself, in the table view and in the command palette."],
      ],
    },
    {
      version: "0.58.0",
      date: "2026-09-03",
      title: "The workspace says it is Alpha",
      buildChecksum: "20f35cc1e76cc91304853777a957680aa32ce431a72f4bbd02a6f393e7cf24ee",
      changes: [
        ["new", "The workspace window carries the same Alpha badge every tool does, and clicking it explains what that means: built, not yet put through its paces. Check what it tells you before acting on it."],
        ["better", "Project cards no longer carry a Run button. A card is where a project is recognised; running it is something you do once you are looking at it, and Run is still on the project itself, in the table view and in the command palette."],
      ],
    },
    {
      version: "0.57.2",
      date: "2026-09-03",
      title: "All or Changed, in words",
      changes: [
        ["better", "The workspace file list now says which files it is showing: an All / Changed switch instead of a funnel icon that could have meant anything. The Changed side carries the number, so you can see how much is waiting without switching to it."],
      ],
    },
    {
      version: "0.57.1",
      date: "2026-09-03",
      title: "Workspace dividers move",
      changes: [
        ["fix", "Dragging a divider in a workspace did nothing at all. The new size was being written where the stylesheet's own value overrode it, so every drag was thrown away."],
        ["better", "The dividers are easier to grab - the line stays thin, the target either side of it is not."],
        ["better", "The save-and-upload panel now starts small. It is a message box and three buttons, so the file list above it gets most of the column."],
      ],
    },
    {
      version: "0.57.0",
      date: "2026-09-03",
      title: "Workspaces",
      changes: [
        ["new", "The dev box is now called the workspace - on the project card, in the command palette and in the window title."],
        ["fix", "The workspace terminal opened onto \"Unknown terminal shell.\" instead of a shell. It was asking for a profile by a name that does not exist rather than for whichever shell this computer has."],
        ["fix", "The workspace stopped responding shortly after it finished loading. A terminal announcing a dev server held a lock while telling the rest of the app about it, and the question \"what is this terminal serving?\" was being answered on the thread that draws the window - so the two met and the window stopped."],
        ["fix", "A dev server address printed right at the end of a chunk of terminal output could stop that terminal from printing anything further."],
        ["better", "The save-and-upload panel is just a message box and its buttons now. The file list above it does the listing, and it can be filtered down to only the files you have changed."],
        ["fix", "The Store version of WinT could not open a terminal - it reported that the build does not contain the WinT CLI. The Store package was being assembled without that CLI, and without the tool icons the taskbar jump list uses."],
      ],
    },
    {
      version: "0.56.3",
      date: "2026-09-03",
      title: "The workspace terminal sits under the browser",
      changes: [
        ["better", "The bottom panel no longer runs the full width of the workspace. It sits under the center panel, where the terminal belongs to the browser above it rather than reading as a fourth unrelated strip - and the file list and the chat now run the full height of the window."],
        ["better", "Hide the center panel and the bottom one spreads across the window again, because there is nothing left for it to sit under."],
      ],
    },
    {
      version: "0.56.2",
      date: "2026-09-03",
      title: "The workspace opens",
      changes: [
        ["fix", "The workspace window came up stuck on \"Opening the workspace\" and ignored every click, including its own close button. The window was never granted permission to talk to WinT, so the first thing its page did failed and took the rest of the page with it."],
        ["fix", "The workspace title bar drags the window again, and double-clicking it maximises."],
        ["better", "A workspace that cannot start now says so on its status line instead of sitting there silently. It has no native frame, so a page that dies quietly is a window you cannot even close."],
      ],
    },
    {
      version: "0.56.1",
      date: "2026-09-03",
      title: "The workspace has a button",
      changes: [
        ["fix", "The workspace could only be reached by binding a hotkey to it. Every project card now has a Workspace button next to Code and Terminal, and typing a project name into the command palette offers it too."],
      ],
    },
    {
      version: "0.56.0",
      date: "2026-09-03",
      title: "Workspaces",
      changes: [
        ["new", "Every project can now open a workspace: one window holding the files, a save-and-upload panel, a terminal, a Claude chat and a browser, all pointed at that project. Find it in the command palette as \"Open workspace\"."],
        ["new", "The browser panel fills itself in. Start a dev server in the workspace terminal and the moment it prints a localhost address, the browser opens it - no copying the port across."],
        ["new", "Panels go where you want them. Drag a panel by its title bar onto another to swap the two, drag the dividers to resize, and use the row of icons in the title bar to hide and show any of them. The arrangement is remembered per project."],
        ["new", "The terminal and the Claude chat belong to the workspace but not to its window: close it and reopen it, and whatever was running is still running."],
      ],
    },
    {
      version: "0.55.2",
      date: "2026-09-03",
      title: "The Claude Code terminal sets itself up",
      changes: [
        ["better", "Claude Code is no longer greyed out as unavailable on a computer that does not have it. The terminal opens either way: the pane says what Claude Code is and who it signs in as, offers to install it, and then starts it so you can sign in - without leaving the pane."],
        ["better", "The terminal list marks that entry \"Set up\" instead of \"Unavailable\", and stops marking it once the CLI is there."],
      ],
    },
    {
      version: "0.55.1",
      date: "2026-09-02",
      title: "A popped-out terminal keeps its width",
      changes: [
        ["fix", "Popping a terminal out no longer puts a blank line between every line. The new window opened at a fixed size, and the narrower grid made the shell re-wrap everything already printed - so anything padded to the full width, like a dev server writing its timestamps down the right edge, spilled onto a second, empty-looking row. The window now opens with the width the terminal had in the panel."],
      ],
    },
    {
      version: "0.55.0",
      date: "2026-09-02",
      title: "Claude Code is a terminal type",
      changes: [
        ["new", "Claude Code now sits in the terminal list beside PowerShell and Git Bash. Open one on a project and you get the real Claude chat, in a pane, already in that folder."],
        ["new", "It uses the Claude Code you already have installed and signed in - WinT asks for no API key and stores no credentials. If it is not on this computer, the entry says so and tells you how to install it."],
      ],
    },
    {
      version: "0.54.0",
      date: "2026-09-02",
      title: "DevHQ is now WinT*",
      buildChecksum: "39ce63c9fa9d7e721ecb2cb9ebe59ac63eef613a1bbb1879a9f3fbc4fe24bd67",
      changes: [
        ["new", "DevHQ is now called WinT*. Same app, same license, same everything else - just a new name in the title bar, the Start menu, and everywhere else it's written."],
      ],
    },
    {
      version: "0.53.5",
      date: "2026-09-02",
      title: "A tool that failed to open once now recovers",
      buildChecksum: "e0266b14290ab55e7726a2e1b1e21cd3de37de0638e3243a128a0326a4b0a758",
      changes: [
        ["fix", "A tool's own isolated window could end up with a corrupted environment - most often from being interrupted mid-creation - and once it did, every future attempt to open that same tool failed the same way for good, with no visible way to recover. It now clears that environment and tries once more automatically the next time you open it."],
      ],
    },
    {
      version: "0.53.4",
      date: "2026-09-02",
      title: "Fewer flashes, fewer stalls",
      changes: [
        ["fix", "Windows tools (registry, lock inspector, audio, event log, repair targets, and the CLI's PATH check) no longer flash a console window every time they read from PowerShell."],
        ["fix", "Git could stall on \"Opening Git\" for several seconds if its last-opened repository sat somewhere no longer reachable - a disconnected network drive, an unmounted volume. It now gives up on an unreachable path quickly instead of waiting on it."],
      ],
    },
    {
      version: "0.53.3",
      date: "2026-09-02",
      title: "Search finds the tool you meant",
      changes: [
        ["better", "Search now answers to the words you would actually type. Every tool carries far more of them - the symptom (\"port already in use\", \"no sound\", \"window off screen\", \"cannot delete file\"), the other name for the thing (regedit, netstat, hexdump, caffeine, prettify, epoch), and the neighbouring spellings (sha-256, wi-fi, uuidv4, c#)."],
        ["better", "The Windows repairs are found by what is broken rather than by their names - \"printer stuck\", \"bluetooth\", \"taskbar frozen\", \"flush dns\" and \"usb not recognized\" all land on the right one."],
        ["better", "Rescan, the terminal panel and the per-project Run, Terminal and Pull rows match their common names too, so \"refresh\", \"console\" and \"fetch\" find them."],
      ],
    },
    {
      version: "0.53.2",
      date: "2026-09-02",
      title: "Git opens again",
      changes: [
        ["fix", "Git could stick on \"Opening version history…\" and stay there for good. If it was saved while still reading a repository it recorded that a read was under way, then on the way back waited for a read that had died with the old window - and saved the same flag again. It no longer remembers being mid-read, so it simply reads again."],
        ["fix", "Disk Space Usage could come back showing a scan that was already gone, and could never finish it."],
      ],
    },
    {
      version: "0.53.1",
      date: "2026-09-02",
      title: "A terminal straight into its own window",
      changes: [
        ["new", "A small pop-out button sits next to Terminal in the status bar. It opens a new shell straight in its own window - the bottom panel is never opened on the way and does not flicker, whether it was open or closed."],
      ],
    },
    {
      version: "0.53.0",
      date: "2026-09-02",
      title: "Going back to a tool stops rebuilding it",
      changes: [
        ["new", "The three most recently used tools stay in memory. Leaving one now hides it instead of throwing it away, so going back to it appears at once, still scrolled where you left it and still holding what you had typed - no reload, no loading screen."],
        ["better", "A tool kept in the background stops working while it is there. Process Explorer stops sampling the process table every two seconds and GitHub stops polling for notifications, and both pick up again when you return. Anything you started yourself - a packet capture, a log tail - keeps running."],
        ["better", "Three, not more: each of these tools runs in its own browser process, so a spare costs real memory. The utilities and Windows tools were never affected - they live in the main window and have always stayed loaded."],
        ["fix", "Popping a tool out of its own window now clears the copy held in memory, so docking it back no longer restores the state it had before it was popped out."],
      ],
    },
    {
      version: "0.52.0",
      date: "2026-09-02",
      title: "A tool says what it is while it opens",
      changes: [
        ["new", "Opening a tool no longer shows a blank grey panel while it starts. It shows the tool - by its real name, Process Explorer rather than ports - with a spinner and a shimmering outline of the page that is coming, centred in the space it will fill."],
        ["better", "A popped-out tool window carries its name in the title bar and on the taskbar from the very first frame, instead of reading \"Tool\" until the tool had loaded."],
        ["better", "The line along the bottom now says which tool is opening, and stops saying it the moment that tool has drawn itself."],
        ["better", "The loading line names the step it is really on - reaching WinT, loading the tool, starting it - so a tool that stalls says where."],
        ["fix", "A tool that fails to open now says so on that screen, with the reason. It used to throw you back to the overview and take the explanation with it."],
        ["fix", "Clicking the version in the status bar opens this list again. The window was being brought to the front and then hiding itself in the same breath, because it trusted Windows' answer about whether it had focus - Search already asked the second question that gets this right."],
      ],
    },
    {
      version: "0.51.1",
      date: "2026-09-02",
      title: "Tool windows open sooner",
      changes: [
        ["better", "Tools open faster, especially the first time. Every window carried the whole Material Symbols icon set - 5.2 MB - and no icon could appear until all of it had been read. Each tool keeps its own cache, so each one paid that toll on its first open. WinT now ships only the icons it actually draws: 465 KB, about a ninth of the size."],
        ["fix", "Every icon in the smaller set was checked against the original, one by one, so none of them changed shape or went missing."],
      ],
    },
    {
      version: "0.51.0",
      date: "2026-09-01",
      title: "Split first, choose the shell after",
      changes: [
        ["better", "The split button in a popped-out terminal just splits: side by side, running the same shell as the pane it came from, with nothing to answer first. Click it again to fold the second pane away."],
        ["new", "Right-click a pane tab to restart that pane on a different shell - PowerShell 7, Windows PowerShell, Command Prompt, Git Bash, WSL or NuShell - in the same folder and the same place on screen. With one terminal and no tab to aim at, the window title does the same thing."],
        ["better", "The shell menu marks the one the pane is already running and greys out the ones this computer does not have, saying why on hover."],
        ["better", "Dragging a popped-out terminal by its titlebar now only moves the window. Dropping it onto the terminal area was meant to dock it and never landed reliably; the dock button next to it always did."],
      ],
    },
    {
      version: "0.50.1",
      date: "2026-09-01",
      title: "Room for the shell list",
      changes: [
        ["better", "The shells WinT can fetch now use the full width of Settings instead of being squeezed into the narrow control column. Each one has room for its version, what state this computer is in and its button on a single line, and folds to two lines rather than truncating when the window is narrow."],
      ],
    },
    {
      version: "0.50.0",
      date: "2026-09-01",
      title: "Split a terminal in its own window",
      changes: [
        ["new", "A popped-out terminal splits like the panel does. The split button in its titlebar offers every shell this computer has - or the same one the pane is already running - side by side or stacked."],
        ["new", "Each pane in a split window has its own tab saying which shell it is, in the same colours and codes the panel uses, so the two sides can never be mistaken for each other. The tab carries the folder and a cross that closes just that pane."],
        ["new", "The divider between two panes can be dragged, in a popped-out window as well as in the panel. Closing one pane leaves the other with the whole window instead of taking the window with it."],
        ["better", "Clicking a pane makes it the one the titlebar, the debug report and `wt` commands are talking about."],
        ["fix", "A `wt split-pane pwsh` line now opens PowerShell 7 when the only copy on the machine is one that is not on PATH - an install that never joined it, or the one WinT downloaded - instead of falling back to Windows PowerShell. The same goes for `nu`."],
      ],
    },
    {
      version: "0.49.0",
      date: "2026-09-01",
      title: "A shell you do not have is now a button",
      changes: [
        ["new", "Settings › Terminal can fetch PowerShell 7, PowerShell Preview, NuShell and Git Bash for you. Each one comes straight from the project that publishes it, is checked against that project's own SHA-256 before anything is unpacked, and lands in WinT's own folder - nothing is installed on the machine and nothing else on it changes."],
        ["new", "A terminal or a `wt` pane that fails because the shell is not installed now offers to get it, instead of quoting a winget command to go and type somewhere else. The offer says how big the download is and which site it comes from."],
        ["new", "A shell WinT downloaded can be removed again from the same place, with the space it is taking shown next to it."],
        ["better", "A shell you installed yourself is always the one that runs. WinT's copy is only ever looked for after PATH and Program Files, so it can never quietly shadow a newer PowerShell or Git you maintain."],
        ["better", "Downloads report their megabytes on the status bar whether or not Settings is open, and can be cancelled mid-transfer; a cancelled or corrupt download is discarded rather than left half-unpacked."],
      ],
    },
    {
      version: "0.48.1",
      date: "2026-09-01",
      title: "The reset names the resolver that is failing",
      changes: [
        ["new", "Wi-Fi & Internet Reset now asks for administrator itself, once, for the run you asked for - the same prompt the hosts file uses. Restarting the adapter and clearing the ARP cache actually happen instead of being refused. Dismiss the prompt and it still does everything that does not need it, and says so."],
        ["new", "The connection list shows the DNS servers each adapter is using, and the reset asks every one of them for a name after it finishes: the system resolver, each configured server, and 1.1.1.1 as a control, each with the time it took. A name that resolves through 1.1.1.1 but not through the router points at the router's resolver rather than the connection."],
        ["fix", "Reset reports no longer come back with mojibake where an accent or a separator should be."],
      ],
    },
    {
      version: "0.48.0",
      date: "2026-09-01",
      title: "Reset the connection that keeps dropping",
      changes: [
        ["new", "Wi-Fi & Internet Reset is a new tool. It lists every connection on the machine with the network it is on, its signal, its address and its gateway, and resets the one you pick: the adapter goes down and up, the DNS and ARP caches go, and a fresh DHCP lease is taken."],
        ["new", "The reset answers with what it found afterwards - the address it came back with, whether the gateway replies, whether the internet is reachable and whether names still resolve - so an intermittent drop-out is either fixed or narrowed down in one click."],
        ["better", "Steps Windows refuses without administrator rights no longer abandon the reset. Everything else still runs, and the report names what was refused and says to run WinT as administrator for those."],
        ["fix", "Adapter and Bluetooth names with accents or symbols in them no longer come back as replacement characters in the repair tools."],
      ],
    },
    {
      version: "0.47.6",
      date: "2026-09-01",
      title: "Missing shells say what to install",
      changes: [
        ["better", "A shell that is not on this computer now reads as \"pwsh isn't installed\" with the command that installs it, instead of quoting the whole command line back with a Windows error number after it."],
        ["better", "The same sentence is what `wt` prints at the prompt and what a popped-out terminal shows, so the answer is the same wherever the pane was asked for."],
        ["better", "Picking a shell WinT cannot find from the terminal menu says how to install that one too, rather than only that it could not start."],
      ],
    },
    {
      version: "0.47.5",
      date: "2026-09-01",
      title: "wt lines written elsewhere run here",
      changes: [
        ["new", "A pane asked to run `pwsh` on a machine without PowerShell 7 runs Windows PowerShell instead, and says so on its first line. The `wt split-pane … pwsh …` lines everyone already has now work on a machine that never installed PowerShell 7, which is the entire point of WinT taking those lines."],
        ["better", "Every other program a pane is asked to run is left exactly as written - a pane quietly running something other than what was asked for would be worse than one that does not open."],
      ],
    },
    {
      version: "0.47.4",
      date: "2026-09-01",
      title: "Terminals stop fighting their own wt",
      buildChecksum: "2d33980a4f74e59449827b85b6debf1885498a78777f63433cc67c61608e3210",
      changes: [
        ["fix", "Opening a terminal no longer fails while a `wt` command is waiting. WinT copied its wt compatibility program over itself every time a shell started, which the running copy of that program blocks - so a split asked for by `wt` could not open the pane it was asking for."],
        ["better", "That program is only replaced when it has actually changed, and a copy still in use is moved aside instead of blocking the update. A shell never fails to open over it again."],
        ["better", "The failure dialog only names the program when the program is what failed, rather than blaming it for anything that went wrong on the way to the pane."],
      ],
    },
    {
      version: "0.47.3",
      date: "2026-09-01",
      title: "wt answers in the shell",
      changes: [
        ["new", "`wt` now waits for WinT and reports back into the terminal it was typed in: a pane that could not start prints the reason and exits non-zero, so a script that chains commands stops instead of carrying on as though the pane were there."],
        ["new", "`wt --help` prints what WinT supports at the prompt rather than only flashing it in the status bar."],
        ["better", "A `wt` command from a terminal WinT no longer holds says so at the prompt instead of returning silently."],
      ],
    },
    {
      version: "0.47.2",
      date: "2026-09-01",
      title: "A pane that cannot start says so",
      changes: [
        ["fix", "A `wt` command whose program is not installed - `split-pane … pwsh` on a machine without PowerShell 7 - now names that program instead of blaming the shell profile the pane would have used, which was always one that works."],
        ["fix", "The same failure in a popped-out terminal is written across that window's title instead of only into a console nobody reads."],
      ],
    },
    {
      version: "0.47.1",
      date: "2026-09-01",
      title: "wt split-pane lands again",
      changes: [
        ["fix", "`wt split-pane` and the other Windows Terminal commands work in WinT's terminals again: the queue WinT reads them from stopped for the rest of the run the moment it could not see a window, so every command after that was accepted and then thrown away."],
        ["better", "A `wt` command WinT does not take now says so in the shell instead of returning as though it had worked, and one from a terminal WinT no longer holds says so in the panel."],
      ],
    },
    {
      version: "0.47.0",
      date: "2026-09-01",
      title: "Direct AI model management",
      buildChecksum: "6ee70495927c95f80b0d9bcf74f993c3765d01690e8221040a264691609916f6",
      changes: [
        ["new", "Assistant settings include a Manage models shortcut that opens the pinned AI sidebar directly on installed models, downloads, and provider configuration."],
      ],
    },
    {
      version: "0.46.4",
      date: "2026-09-01",
      title: "Always-pinned AI",
      changes: [
        ["better", "The AI assistant always opens pinned beside WinT, and its redundant pin/unpin control has been removed."],
      ],
    },
    {
      version: "0.46.3",
      date: "2026-09-01",
      title: "AI beside Terminal",
      changes: [
        ["better", "The AI assistant button now lives in the bottom status bar immediately beside Terminal instead of occupying the title bar."],
      ],
    },
    {
      version: "0.46.2",
      date: "2026-09-01",
      title: "Compact pinned-tool shelf",
      changes: [
        ["better", "The expanded pinned-tools shelf has a small Compact button that returns pins to the status bar and restores the More control for overflow."],
      ],
    },
    {
      version: "0.46.1",
      date: "2026-09-01",
      title: "Visible pinned-tool overflow",
      changes: [
        ["fix", "The compact toolbar's More button now switches pinned tools to their dedicated wrapping shelf instead of opening a popover that isolated tool webviews could cover."],
      ],
    },
    {
      version: "0.46.0",
      date: "2026-09-01",
      title: "Readable release history",
      changes: [
        ["better", "What's new shows one collapsed row per major/minor release and reveals its main notes and patch releases when expanded."],
      ],
    },
    {
      version: "0.45.5",
      date: "2026-09-01",
      title: "Authorized version-window controls",
      changes: [
        ["fix", "What's new is now authorized to use native window controls, so clicking outside or pressing Escape hides it and dragging its header moves it."],
      ],
    },
    {
      version: "0.45.4",
      date: "2026-09-01",
      title: "Search-style version dismissal",
      changes: [
        ["fix", "What's new now hides its current native window directly on focus loss, using the same dismissal path as Search instead of routing the close through a backend command."],
      ],
    },
    {
      version: "0.45.3",
      date: "2026-09-01",
      title: "Reliable version-window activation",
      changes: [
        ["fix", "What's new confirms native focus after its page is ready, so outside-click dismissal works even when the initial Windows focus event arrived before the page subscribed."],
      ],
    },
    {
      version: "0.45.2",
      date: "2026-09-01",
      title: "Stable version-window focus",
      changes: [
        ["fix", "What's new waits for Windows to confirm that its native window received focus before enabling outside-click dismissal, so it no longer closes while opening."],
      ],
    },
    {
      version: "0.45.1",
      date: "2026-09-01",
      title: "Version window dismissal",
      changes: [
        ["fix", "What's new now closes reliably when its native window loses focus, even when WebView2 continues to report document focus."],
      ],
    },
    {
      version: "0.45.0",
      date: "2026-09-01",
      title: "Navigation above isolated tools",
      changes: [
        ["fix", "Help tool links now navigate through the shell bridge and acknowledge navigation before their isolated webview is replaced."],
        ["fix", "Switching tools from Help or the bottom bar serializes WebView2 teardown and creation, preventing Event Streamer and other isolated tools from freezing the app."],
        ["fix", "The `>` command-search shortcut works inside isolated tools without intercepting text fields or editors."],
        ["new", "What's new opens in a movable, resizable native dialog above every tool, closes with Escape, and dismisses when you click outside it."],
      ],
    },
    {
      version: "0.44.2",
      date: "2026-09-01",
      title: "Visible device tests",
      changes: [
        ["better", "Playback and microphone test buttons disable immediately and show Playing or Testing with a spinner until the test finishes."],
      ],
    },
    {
      version: "0.44.1",
      date: "2026-09-01",
      title: "Visible mute progress",
      changes: [
        ["better", "Mute and Unmute immediately disable the clicked control and show a spinner with the action in progress while Windows applies it."],
      ],
    },
    {
      version: "0.44.0",
      date: "2026-09-01",
      title: "Sound devices that really switch",
      changes: [
        ["fix", "Sound Device Switcher now uses the current Windows audio policy interface and verifies every default-device role before reporting success."],
        ["new", "Every playback and recording endpoint has its own volume and mute controls, playback test, or microphone input test."],
        ["better", "A device is shown as selected only when Windows reports it as the Console, Multimedia, and Communications default."],
      ],
    },
    {
      version: "0.43.4",
      date: "2026-09-01",
      title: "Tools that cannot take down the shell",
      buildChecksum: "945b20b9da431a83649694ffce0c16eafe54a12ca9705bd1568c87fae81e2e5f",
      changes: [
        ["better", "Every tool now runs in an isolated child WebView behind a shared, tool-agnostic shell, so navigation, Search, pins and window controls remain independent of tool failures."],
        ["new", "A versioned tool bridge carries context, state and shell requests between isolated tools and WinT, providing one host contract for current and future tools."],
        ["better", "Tool-specific actions now live inside their tools, including Event Log refresh, Registry reload, Environment scanning and Git help navigation."],
        ["better", "Pop-out and pop-in preserve the correct tool and shell layout without blocking the main window or exposing an intermediate overview."],
        ["new", "Search now opens in its own opaque, movable native window above isolated tools, focuses immediately and includes copyable focus diagnostics."],
        ["better", "Clicking the title-bar search anchors Search over that field, while Ctrl+K continues to open it in the center."],
        ["fix", "Native Search activation no longer dispatches WebView focus synchronously from the Windows hotkey callback, preventing a UI-thread deadlock."],
        ["fix", "Search only scans processes and ports for relevant kill queries instead of starting unnecessary background work whenever it opens."],
        ["fix", "Theme changes immediately repaint both the document and native background of an already-open isolated tool."],
      ],
    },
    {
      version: "0.43.3",
      date: "2026-08-31",
      title: "Clear Cursor activity",
      buildChecksum: "ee2c1acc02f6abc792bd7d102fff8747109d4e0b8df7823406fc55da0f04768c",
      changes: [
        ["fix", "Cursor activity names the tool being used instead of exposing internal timing fields; unknown activity appears neutrally as Thinking."],
      ],
    },
    {
      version: "0.43.2",
      date: "2026-08-31",
      title: "Cursor Agent discovery",
      changes: [
        ["fix", "Cursor Agent now starts through the installed `agent` runtime on Windows even when its PowerShell and command shims are invisible to desktop apps."],
      ],
    },
    {
      version: "0.43.1",
      date: "2026-08-31",
      title: "Home in the title bar",
      changes: [
        ["better", "A small Home button beside the title-bar search returns directly to the project overview."],
      ],
    },
    {
      version: "0.43.0",
      date: "2026-08-30",
      title: "Cloud assistant providers",
      changes: [
        ["new", "Claude, Codex, and GPT can now be configured with your own API key and selected beside local models."],
        ["new", "GPT offers the Luna, Terra, and Sol variants, with Luna selected by default for a newly configured OpenAI provider."],
        ["better", "Cloud API keys persist in Windows Credential Manager instead of browser storage, with an explicit warning about the limits of local credential protection."],
        ["better", "Cloud requests run away from the window thread and show their provider activity and API errors in the assistant."],
        ["better", "Claude, Codex, and GPT responses now stream live, can call WinT's validated project tools, and stop immediately when cancelled."],
        ["new", "Cursor Agent can now be configured as a provider using its API key and official streaming CLI, including visible tool activity and cancellation."],
        ["new", "The tool-call limit defaults to 20 and can be changed from Settings or the model panel for every assistant provider."],
        ["better", "Unused Windows AI provider scaffolding was removed from the assistant backend."],
      ],
    },
    {
      version: "0.42.0",
      date: "2026-08-30",
      title: "Local assistant panel",
      changes: [
        ["new", "A docked assistant can now download a verified local model on demand and run private multi-turn chats without another AI application."],
        ["new", "Three local model sizes can be installed, selected, cancelled during download, and deleted independently."],
        ["better", "The inference runtime and every model larger than 10 MB stay out of the installer and download only after an explicit choice."],
        ["better", "Assistant chats stream into local history and can be stopped without blocking the window."],
        ["better", "Provider-neutral conversations and Rust-controlled tool policy keep local models, Claude, GPT and Cursor integrations isolated."],
        ["fix", "Local chat now hides the inference runtime shell and receives the current WinT project facts instead of guessing what a project contains."],
        ["new", "Assistant answers render safe Markdown with headings, lists, emphasis, inline code and copyable code blocks."],
        ["new", "Read-only project tools can list files, read bounded text files and search project text through a validated four-step Rust agent loop."],
        ["new", "Assistant work is visible as model and tool steps, and questions can pause with two to five clickable answers."],
        ["new", "Pin the assistant to reserve space beside WinT, or leave it unpinned as an overlay; narrow windows automatically keep overlay behavior."],
        ["fix", "Failed assistant requests stop their pending dots, identify rejected tool names in the activity card, and retry safely without executing unknown tools."],
        ["new", "A persistent Think checkbox creates a validated plan, runs its steps sequentially with visible results, and performs a separate final-answer synthesis."],
        ["fix", "An assistant left open and pinned now restores open and pinned with the same reserved workspace width."],
        ["better", "Think plans may contain however many steps the model needs, with every step kept in the scrollable conversation."],
        ["better", "Docked mode now forms a full-height right column while the overview, status bar and terminal share the larger left side."],
        ["better", "Visible Think steps and final answers now appear directly as the local model generates them."],
        ["new", "A quick first-pass intent router selects project, terminal, network, utility or Windows-tool guidance before planning and answering."],
        ["better", "Intent routing now limits context and callable schemas to the selected area; ping requests receive a validated ping tool without unrelated project context."],
        ["new", "Every WinT page, utility, Windows inspector and repair now has a routed AI call list; safe inspections return structured results while interactive or system-changing actions open the exact tool for user control."],
      ],
    },
    {
      version: "0.40.1",
      date: "2026-08-30",
      title: "Favorite projects",
      changes: [
        ["new", "Star a project from the overview card, the table or its detail page. Stars stay across rescans and restarts."],
        ["new", "A Favorites filter chip shows only the projects you have starred."],
      ],
    },
    {
      version: "0.39.2",
      date: "2026-08-30",
      title: "Path Ping window controls",
      changes: [
        ["fix", "Path Ping's Back and Close buttons now return to the overview."],
        ["new", "Path Ping can now be opened in its own dockable window."],
      ],
    },
    {
      version: "0.39.1",
      date: "2026-08-30",
      title: "Path Ping follows the theme",
      changes: [
        ["fix", "Path Ping now uses WinT's light-theme surfaces, text, borders, selections and status colors throughout."],
      ],
    },
    {
      version: "0.39.0",
      date: "2026-08-30",
      title: "Path Ping",
      changes: [
        ["new", "Path Ping traces a destination and shows latency and packet loss at every hop as Windows measures it."],
        ["better", "Probe controls, hop details and a plain-language loss verdict keep route troubleshooting in one view."],
      ],
    },
    {
      version: "0.38.0",
      date: "2026-08-30",
      title: "Disk Space Usage",
      buildChecksum: "134d60bebc9797348a327da06a85a6adf8a281d7dc5d9f6b9475c69e7fa83260",
      changes: [
        ["new", "Disk Space Usage scans one selected drive and draws a live size diagram as folders are measured."],
        ["new", "Click a folder to drill into it, or right-click any area to reveal it in Explorer."],
        ["better", "Disk scans measure several top-level areas in parallel, and switching drives now cancels the active scan immediately."],
        ["better", "Docking a detached tool or terminal now restores and focuses the main WinT window."],
      ],
    },
    {
      version: "0.37.0",
      date: "2026-08-30",
      title: "Local active-window time tracker",
      changes: [
        ["new", "Active Window Time Tracker records application and window-title sessions while WinT is open, pauses after five minutes of idle time, and shows today, 7-day and 30-day summaries."],
        ["new", "Time history stays in an app-local database and can be exported as CSV; tracking is explicitly started or paused from the tool."],
      ],
    },
    {
      version: "0.36.2",
      date: "2026-08-30",
      title: "Images in clipboard history",
      changes: [
        ["new", "Clipboard History captures current and newly copied images, shows thumbnails and full previews with dimensions and size, and can copy an image back to Windows."],
        ["better", "Clipboard History uses an app-local IndexedDB database instead of preference storage and accepts images up to 25 MB."],
      ],
    },
    {
      version: "0.36.1",
      date: "2026-08-30",
      title: "Clipboard history",
      changes: [
        ["new", "Clipboard History keeps up to 250 local text clips with text, link and code filters, pinned entries, inspection, copy-back and explicit forgetting."],
      ],
    },
    {
      version: "0.36.0",
      date: "2026-08-30",
      title: "Hotkeys for anything",
      changes: [
        ["new", "Settings › Hotkeys can bind tools and global actions from the command-palette catalog, with search, filters, conflict warnings and one-click default restoration."],
      ],
    },
    {
      version: "0.35.6",
      date: "2026-08-30",
      title: "History selection stays invisible",
      changes: [
        ["fix", "Choosing a history result replaces the current input with terminal editing keys. Shells that do not bind Ctrl+K no longer print a literal ^K before the command."],
      ],
    },
    {
      version: "0.35.5",
      date: "2026-08-30",
      title: "History shows its source",
      changes: [
        ["better", "The history list shows whether a command came from PSReadLine, Bash history or NuShell history instead of displaying an unavailable time."],
      ],
    },
    {
      version: "0.35.4",
      date: "2026-08-30",
      title: "Reverse search can go forward",
      changes: [
        ["better", "Enhanced history follows native reverse-search controls: Ctrl+R moves to an older match, Ctrl+S goes back toward a newer match, and Ctrl+G cancels."],
      ],
    },
    {
      version: "0.35.3",
      date: "2026-08-30",
      title: "Ctrl+R stays native",
      changes: [
        ["better", "Pressing Ctrl+R again moves to the next matching command, just like the shell's reverse search."],
        ["better", "Enhanced search reads only native shell history. WinT no longer records or saves a separate command history, and refreshes the native files whenever search opens."],
      ],
    },
    {
      version: "0.35.2",
      date: "2026-08-30",
      title: "Honest history times",
      changes: [
        ["fix", "Imported shell history says when its time is unavailable instead of labeling every old command as just run. Commands observed by WinT still show their real relative time."],
      ],
    },
    {
      version: "0.35.1",
      date: "2026-08-30",
      title: "Ctrl+R includes existing history",
      changes: [
        ["fix", "Enhanced Ctrl+R imports existing PowerShell, Bash and NuShell history, so commands run before the feature was installed are searchable too."],
      ],
    },
    {
      version: "0.35.0",
      date: "2026-08-30",
      title: "A better Ctrl+R",
      changes: [
        ["new", "Ctrl+R opens a searchable command history across WinT terminals, ranked by recency, usage or best match, with keyboard actions to run or edit a result."],
        ["better", "Settings › Terminal can turn enhanced Ctrl+R off, handing the shortcut straight back to the shell's built-in history search."],
      ],
    },
    {
      version: "0.34.6",
      date: "2026-08-30",
      title: "Checksum only on Store builds",
      changes: [
        ["fix", "What's new only hashes the running exe for an official Store package. A dev build no longer shows \"Reading this build's checksum\" or a live checksum line."],
      ],
    },
    {
      version: "0.34.5",
      date: "2026-08-30",
      title: "clear clears the terminal",
      changes: [
        ["fix", "`clear` and Clear-Host empty the scrollback as well as the screen. The history above used to stay painted, and Restore settled onto it, so a clear looked like it had done nothing."],
      ],
    },
    {
      version: "0.34.4",
      date: "2026-08-30",
      title: "Resize leaves the terminal where it is",
      changes: [
        ["fix", "Resizing a terminal — the dock, a popped-out window, or the main window — no longer scrolls it. The view stays on the lines you were looking at; only Restore from maximized, and opening a terminal again, place the scroller."],
      ],
    },
    {
      version: "0.34.3",
      date: "2026-08-30",
      title: "Store builds name their checksum",
      buildChecksum: "5263398ecda1c20ff3f8cfea6b9bc01a9dc8c0e1590415e2b7ed2ac82d966543",
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
      title: "A new face for WinT",
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
        ["better", "Restored history is no longer a reconstruction. WinT used to save what a terminal's cells looked like and paint them back, which is why little things were off - a stray space in front of a command, output that had been coloured by a program coming back plain. Each terminal is now kept as the stream of bytes its shell actually wrote, and opening it feeds those bytes back through the same parser that drew them the first time. The scrollback you get back is not a copy of the old one; it is produced the same way it was produced originally."],
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
        ["better", "Arrow up, and every other keystroke, reaches the shell without waiting for the window. Typing used to be handed to the pseudoconsole on the same thread that draws WinT, behind a lock that closing or resizing a terminal can hold for a noticeable moment - so a recalled command could arrive late for no visible reason. Keystrokes now go onto the session's own queue, in the order you typed them, and a thread of its own does the waiting."],
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
        ["fix", "Dragging a popped-out tool by its title bar now just moves the window. Dropping it anywhere over WinT used to pull the tool back into the main window, so an ordinary move across the screen looked like the window had vanished. The dock button in the title bar is the way back in."],
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
        ["fix", "A popped-out tool's title bar matches the terminal: left-aligned name beside the WinT icon, without a material-icon ligature or the long hint crowding the strip."],
      ],
    },
    {
      version: "0.27.0",
      date: "2026-08-29",
      title: "Pop tools out into their own window",
      changes: [
        ["new", "Any tool can open in its own window from the Pop out button in its header."],
        ["new", "Drag a pinned tool past the edge of WinT to tear it into a new window, the same way terminal tabs do."],
        ["better", "Dock a popped-out tool back with the dock button, or by dragging its title bar onto WinT; closing the window leaves the tool available from its pin."],
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
        ["fix", "Default Device Hot-Swapper now lists real playback and recording endpoints inside WinT and assigns the selected one to Console, Multimedia, and Communications instead of opening Sound Settings."],
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
        ["fix", "Windows tools now use WinT's real icons instead of showing names such as play_arrow as button text."],
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
        ["new", "Terminals close immediately, then WinT checks their former child processes two seconds later and shows a numbered warning beside Terminal when any remain."],
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
        ["new", "Browser-readable port badges and Local development labels show the HTTP response code WinT received, including errors such as HTTP 500."],
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
        ["new", "WinT now asks before counting anything, and links you straight to the handful of lines that do it. Say no and nothing is ever sent."],
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
        ["new", "Terminal settings can rescan installed shells without restarting WinT."],
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
        ["new", "WinT now discovers installed shells at startup, including PowerShell stable and preview, Windows PowerShell, Command Prompt, Git Bash, WSL and NuShell."],
        ["better", "Unavailable shells are disabled in terminal menus, with a clear dialog if one still fails to launch."],
      ],
    },
    {
      version: "0.8.3",
      date: "2026-08-28",
      title: "Short terminal titles",
      changes: [
        ["better", "A popped-out terminal uses only its folder name in the taskbar and window title, such as wint instead of the full C:\\code\\wint path."],
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
        ["better", "WinT has a new app icon, cropped so the artwork fills the tile edge to edge - it shows up on the taskbar, in the window corner, in the installer and on the browser tab."],
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
        ["new", "WinT speaks Chinese, Hindi, Spanish, French, Arabic, Bengali, Portuguese, Russian and Indonesian besides English, and follows Windows by default."],
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
        ["new", "No terminal dependency: ConPTY through Microsoft's own bindings, plus WinT's own VT parser and screen grid."],
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
        ["new", "Point WinT at a folder of projects and see all of them at once."],
        ["new", "Per project: branch and upstream, staged, modified and untracked counts, ahead and behind, conflicts, stashes, the last commit and the 30-day commit count."],
        ["new", "A detail view with the changed-file list and the patch beside it."],
        ["new", "Open a project in VS Code, Explorer or an external shell."],
      ],
    },
  ];

  return { current: releases[0].version, releases };
})();
