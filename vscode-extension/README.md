# WinT Terminal

WinT's terminal in a VS Code panel. It is the same terminal WinT draws, running on its own: WinT does not need to be installed or running.

What it adds over VS Code's own terminal:

- **Ctrl+R** opens a searchable history of every command your shells remember (PowerShell, Git Bash, NuShell), sorted by recent, most used or best match.
- **Editor-style selection.** Shift+arrow keys select, Ctrl+Shift+arrow keys select by word, Ctrl+X cuts from the command you are typing, and typing over a selection replaces it.
- **Box selection** with Alt+drag.
- **Kept scrollback.** Terminals that were open when VS Code closed come back with what they printed.

Open it from the **WinT Terminal** tab in the panel, or with **WinT: New WinT Terminal** from the Command Palette.

## Keys

Keys go to the shell, except the ones listed in `wintTerminal.keysForVSCode`. By default these are F1, Ctrl+P, Ctrl+Shift+P, Ctrl+J, Ctrl+B, Ctrl+Tab and a few other panel and navigation shortcuts.

## Settings

| Setting | |
|---|---|
| `wintTerminal.defaultShell` | The shell a new terminal opens with |
| `wintTerminal.enhancedHistorySearch` | Ctrl+R opens WinT's history search rather than the shell's own |
| `wintTerminal.keepScrollback` | Reopen terminals, with their output, after a reload |
| `wintTerminal.keysForVSCode` | Keys that go to VS Code instead of the shell |

## Limits

- It is a panel next to VS Code's terminals, not one of them. Tasks, debugging and extensions that drive VS Code terminals do not use it.
- Windows only.
