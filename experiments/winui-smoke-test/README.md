# DevHQ WinUI 3 smoke test

An isolated, native-Windows UI experiment. It does not call the DevHQ backend
and does not touch the Tauri application.

The window now draws the DevHQ overview natively so the two can be held up side
by side: the toolbar, the summary strip, the filter chips, the card grid and the
status bar, in the palette from `src/styles.css` — the same hex values, light
and dark. **The data is fixed sample data and nothing is wired up**: buttons,
chips and the search box do nothing. It is there to answer one question — does
this look right — before any of it is worth building for real.

```powershell
cd C:\code\devhq\experiments\winui-smoke-test
dotnet run
```

The first run registers a local debug package and launches it with package
identity.

Things worth looking at:

- **Both palettes.** The sun in the title bar flips the whole window between the
  dark and light values, without restarting under a different system theme.
- **The terminal dock.** The Terminal button on the right of the status bar
  opens it, below the status bar as on the web, in the DevHQ Dark scheme with
  its chrome mixed out of that scheme rather than out of the window's theme.
  Drag the grip along its top edge to resize it. The transcript is canned, but
  the prompt on the last line is a real text field — the place to try Shift+Home,
  Shift+End, Delete and the caret. **No shell is running behind it**: Enter
  echoes the line and says so.
- **Resizing and scaling.** The card grid reflows at 330px minimum, the way the
  CSS grid does; try it at 125% and 175% too.
- **Where it is not the web app.** The title bar is the native `TitleBar`
  control with real caption buttons, not the hand-drawn one; cards in a row take
  a uniform height rather than sizing to their own content.

Files: `Theme.xaml` holds the palette and the control looks (app and terminal
both), `MainPage.xaml` the overview and the dock, `SampleData.cs` the projects
on screen, `WrapPanel.cs` the wrapping panel WinUI does not ship.
