//! Which shell a terminal runs, and where on this computer it is.
//!
//! Every profile is looked for the same way: what the user put on PATH, what an
//! installer put in Program Files, and only then a copy WinT downloaded - which
//! WinT tells this module about through [`set_managed_lookup`]. A host that has
//! no such copies simply never calls it.

use std::path::{Path, PathBuf};
use std::sync::OnceLock;

use serde::Serialize;

/// Shells tried in order. The first that starts wins, so a machine with
/// PowerShell 7 gets it and everything else falls back to what ships with Windows.
pub(crate) const SHELLS: &[&str] = &["pwsh.exe", "powershell.exe"];

// ---- saying which folder the shell is in ---------------------------------
//
// A terminal's title should say where it is, and after a `cd` only the shell
// knows that. Nothing outside the process can read it: PowerShell deliberately
// never moves the process's own working directory, so the PEB still names the
// folder the shell started in for the rest of the session.
//
// So the shell is asked to say so, the way Windows Terminal asks: `OSC 9;9`
// with the path, written on every prompt. `vt.rs` picks it up and it becomes
// the session's `cwd`.

/// Wraps whatever prompt the user's profile left behind — the hook runs after
/// the profile, and `-NoExit` keeps the shell interactive afterwards. Deliberately
/// free of double quotes: it travels as one quoted command-line argument.
const PWSH_CWD_HOOK: &str = concat!(
    "$global:__wintPrompt = $function:prompt; ",
    "function global:prompt { ",
    "$__wintPath = $ExecutionContext.SessionState.Path.CurrentLocation; ",
    "if ($__wintPath.Provider.Name -eq 'FileSystem') { ",
    "[Console]::Write([char]27 + ']9;9;' + $__wintPath.ProviderPath + [char]7) }; ",
    "& $global:__wintPrompt }",
);

/// A PowerShell command line that reports its folder. `exe` is already quoted
/// when it needs to be.
pub(crate) fn pwsh_interactive(exe: &str) -> String {
    format!(r#"{exe} -NoLogo -NoExit -Command "{PWSH_CWD_HOOK}""#)
}

/// The same thing for the shells that take it from the environment instead:
/// `cmd.exe` builds its prompt out of `PROMPT` (`$e` is an escape, `$P` the
/// path), and bash runs `PROMPT_COMMAND` before every prompt. Both are the
/// defaults with the report put in front, so nothing about the prompt changes.
pub(crate) fn cwd_reporting_env() -> [(&'static str, String); 2] {
    [
        ("PROMPT", "$e]9;9;$P$e\\$P$G".into()),
        (
            "PROMPT_COMMAND",
            r#"printf '\033]9;9;%s\007' "$(cygpath -w "$PWD" 2>/dev/null || pwd)""#.into(),
        ),
    ]
}

pub(crate) fn shell_command(profile: &str) -> Result<String, String> {
    match profile {
        "pwsh" => pwsh_path(false)
            .map(|path| pwsh_interactive(&format!(r#""{}""#, path.display())))
            .ok_or_else(|| "PowerShell 7 was not found.".into()),
        "pwsh-preview" => pwsh_path(true)
            .map(|path| pwsh_interactive(&format!(r#""{}""#, path.display())))
            .ok_or_else(|| "PowerShell Preview was not found.".into()),
        "powershell" => Ok(pwsh_interactive("powershell.exe")),
        "cmd" => Ok("cmd.exe".into()),
        "nu" => Ok(nu_path()
            .map(|path| format!(r#""{}""#, path.display()))
            .unwrap_or_else(|| "nu.exe".into())),
        "wsl" => Ok("wsl.exe --exec bash --login".into()),
        // The one profile that opens on a machine that does not have it. There
        // is no useful dead end here: the pane itself is where the CLI gets
        // installed and signed in, so a missing Claude Code opens the
        // walkthrough instead of an error dialog.
        "claude" => match claude_program() {
            Some(path) => Ok(program_command(&path)),
            None => claude_setup_command(),
        },
        "git-bash" => {
            let Some(bash) = git_bash_path() else {
                return Err(
                    "Git Bash was not found. Install Git for Windows or choose another shell."
                        .into(),
                );
            };
            Ok(format!(r#""{}" --login -i"#, bash.display()))
        }
        _ => Err("Unknown terminal shell.".into()),
    }
}

pub fn find_command(name: &str) -> Option<PathBuf> {
    std::env::var_os("PATH").and_then(|path| {
        std::env::split_paths(&path)
            .map(|dir| dir.join(name))
            .find(|path| path.is_file())
    })
}

/// The first of several names to turn up on PATH. A CLI installed by npm is a
/// `.cmd` shim beside an `.exe` that may not exist, and which of the two is
/// there is not something to guess at.
pub fn find_program_on_path(names: &[&str]) -> Option<PathBuf> {
    find_programs_on_path(names).into_iter().next()
}

/// Every one of those names that is on PATH, in PATH order.
///
/// The first hit is not always the real thing: another program's launcher can
/// sit earlier on PATH under the same name and answer for it. A caller that can
/// tell a working install from a broken stand-in walks the whole list.
pub fn find_programs_on_path(names: &[&str]) -> Vec<PathBuf> {
    std::env::var_os("PATH")
        .map(|path| {
            std::env::split_paths(&path)
                .flat_map(|dir| {
                    names
                        .iter()
                        .map(move |name| dir.join(name))
                        .collect::<Vec<_>>()
                })
                .filter(|path| path.is_file())
                .collect()
        })
        .unwrap_or_default()
}

/// A command line that starts `path`, whatever kind of file it is.
///
/// `CreateProcess` starts images, not scripts: a `.cmd` or `.bat` shim — which
/// is how npm puts a CLI on PATH — has to be handed to an interpreter, and an
/// `.exe` must not be, because that would leave a `cmd.exe` sitting between the
/// pane and the process whose console it actually is.
fn program_command(path: &Path) -> String {
    let script = path
        .extension()
        .is_some_and(|ext| ext.eq_ignore_ascii_case("cmd") || ext.eq_ignore_ascii_case("bat"));
    if script {
        format!(r#"cmd.exe /d /c ""{}"""#, path.display())
    } else {
        format!(r#""{}""#, path.display())
    }
}

/// Where a shell is looked for, in order: what the user put on PATH, what an
/// installer put in Program Files, and only then the copy WinT downloaded for
/// them. A real installation always wins - WinT's copy is the backstop for a
/// machine that has none, never a replacement for one that has.
fn pwsh_path(preview: bool) -> Option<PathBuf> {
    if !preview {
        if let Some(path) = find_command("pwsh.exe") {
            return Some(path);
        }
    }
    let folder = if preview { "7-preview" } else { "7" };
    std::env::var_os("ProgramFiles")
        .map(PathBuf::from)
        .map(|root| root.join("PowerShell").join(folder).join("pwsh.exe"))
        .filter(|path| path.is_file())
        .or_else(|| managed_exe(if preview { "pwsh-preview" } else { "pwsh" }))
}

fn nu_path() -> Option<PathBuf> {
    find_command("nu.exe").or_else(|| managed_exe("nu"))
}

/// The walkthrough a Claude Code pane opens into when the CLI is not on this
/// computer yet: what it is, who it signs in as, and the one keystroke that
/// installs it. It ends by starting Claude, so a machine that had nothing is
/// looking at a signed-in chat without leaving the pane.
///
/// It installs nothing on its own. Nothing is fetched, and no browser opens,
/// until the person reading it picks a numbered option - which is why this can
/// be the *default* behaviour of opening the profile.
const CLAUDE_SETUP_PS1: &str = r##"
function Line($text, $color) {
  if ($color) { Write-Host $text -ForegroundColor $color } else { Write-Host $text }
}

Line 'Claude Code' 'Cyan'
Line '-----------' 'DarkGray'
Line ''
Line 'This pane runs Anthropic''s Claude Code CLI, in this project''s folder.'
Line 'It is not installed on this computer yet.'
Line ''
Line 'WinT does not ship it and holds no key for it. You install the CLI and sign'
Line 'in as yourself; WinT only gives it a terminal to run in.' 'DarkGray'
Line ''

$npm = Get-Command npm -ErrorAction SilentlyContinue

Line 'How would you like to install it?' 'White'
if ($npm) {
  Line '  [1] npm install -g @anthropic-ai/claude-code'
} else {
  Line '  [1] npm - unavailable, Node.js is not installed' 'DarkGray'
}
Line '  [2] Open the install instructions in your browser'
Line '  [Enter] Not now - leave me at a PowerShell prompt'
Line ''
$choice = (Read-Host 'Choice').Trim()
Line ''

if ($choice -eq '2') {
  Start-Process 'https://docs.claude.com/en/docs/claude-code/setup'
  Line 'Opened the install page. Open a Claude Code terminal again once it is installed.' 'DarkGray'
  return
}

if ($choice -ne '1') {
  Line 'Nothing was installed. This pane is an ordinary PowerShell prompt.' 'DarkGray'
  return
}

if (-not $npm) {
  Line 'Node.js is not installed, so npm cannot run.' 'Yellow'
  Line 'Install Node.js from https://nodejs.org and open this terminal again, or pick [2].' 'DarkGray'
  return
}

Line 'Installing Claude Code. npm''s output follows.' 'White'
Line ''
npm install -g '@anthropic-ai/claude-code'
Line ''
if ($LASTEXITCODE -ne 0) {
  Line 'The install did not finish - npm''s output above says why.' 'Red'
  return
}

# npm put the shim somewhere this process has never looked. Re-reading PATH from
# the registry is what a brand new terminal would have done anyway.
$machine = [Environment]::GetEnvironmentVariable('PATH', 'Machine')
$user = [Environment]::GetEnvironmentVariable('PATH', 'User')
$env:PATH = "$machine;$user;" + (Join-Path $env:APPDATA 'npm')

$claude = Get-Command claude -ErrorAction SilentlyContinue
if (-not $claude) {
  Line 'Claude Code installed, but is not on PATH in this pane yet.' 'Yellow'
  Line 'Close this terminal and open a Claude Code one again.' 'DarkGray'
  return
}

Line 'Installed. Starting Claude Code - it asks you to sign in the first time.' 'Green'
Line ''
& $claude.Source
"##;

/// Writes the walkthrough out fresh and returns the command line that runs it.
///
/// Fresh every time on purpose: the script is WinT's, not the user's, and a
/// stale copy left by an older version would be the one thing here nobody
/// thinks to look at. `-NoExit` is what keeps the pane usable after the script
/// ends, however it ended.
fn claude_setup_command() -> Result<String, String> {
    let dir = runtime_root();
    std::fs::create_dir_all(&dir)
        .map_err(|e| format!("Could not prepare the setup script: {e}"))?;
    let script = dir.join("claude-setup.ps1");
    std::fs::write(&script, CLAUDE_SETUP_PS1)
        .map_err(|e| format!("Could not write the setup script: {e}"))?;
    Ok(format!(
        r#"powershell.exe -NoLogo -NoProfile -ExecutionPolicy Bypass -NoExit -File "{}""#,
        script.display()
    ))
}

/// Where the Claude Code CLI is looked for: PATH first, then the two places its
/// own installers put it.
///
/// Unlike every other profile here this is never something WinT provides. The
/// CLI is the user's own install, signed in as them, and WinT only starts it in
/// a pane — no key is read, stored or passed. A machine without it gets a
/// disabled entry saying so, not a download.
pub fn claude_program() -> Option<PathBuf> {
    find_program_on_path(&["claude.exe", "claude.cmd", "claude.bat"])
        .or_else(|| {
            std::env::var_os("USERPROFILE")
                .map(PathBuf::from)
                .map(|home| home.join(".local").join("bin").join("claude.exe"))
                .filter(|path| path.is_file())
        })
        .or_else(|| {
            std::env::var_os("APPDATA")
                .map(PathBuf::from)
                .map(|roaming| roaming.join("npm").join("claude.cmd"))
                .filter(|path| path.is_file())
        })
}

/// The program a pane was asked to run, against what this computer has.
///
/// `wt split-pane … pwsh -NoExit -Command …` is what these lines look like
/// everywhere they are written, and the whole point of taking them here is that
/// they run on this machine unchanged. PowerShell 7 not being installed is not
/// a reason to leave the pane empty when the same line runs perfectly well in
/// Windows PowerShell - but it is a reason to say which one is running, because
/// the two are not the same shell.
///
/// Anything else is left exactly as it was written. Guessing at a substitute
/// for an arbitrary program is how a pane ends up quietly running the wrong
/// thing.
pub(crate) fn resolve_pane_command(command: &str) -> (String, Option<String>) {
    let trimmed = command.trim();
    let (first, rest) = trimmed
        .split_once(char::is_whitespace)
        .unwrap_or((trimmed, ""));
    // NuShell gets the same treatment for the same reason: WinT may hold the
    // only copy on the machine, and `nu` alone would not find it. `bash` is
    // deliberately not in this list - it means Git Bash to one person and WSL
    // to the next, and picking one of those is guessing.
    if first.eq_ignore_ascii_case("nu") || first.eq_ignore_ascii_case("nu.exe") {
        if find_command("nu.exe").is_some() {
            return (command.to_string(), None);
        }
        return match nu_path() {
            Some(path) => (format!("\"{}\" {rest}", path.display()), None),
            None => (command.to_string(), None),
        };
    }
    let names_pwsh = ["pwsh", "pwsh.exe"]
        .iter()
        .any(|name| first.eq_ignore_ascii_case(name));
    // On PATH is the case that needs no help at all: the line runs as written.
    if !names_pwsh || find_command("pwsh.exe").is_some() {
        return (command.to_string(), None);
    }
    // There is a PowerShell 7 here, it is just not something `CreateProcess`
    // can find by name - an install that never joined PATH, or the copy WinT
    // downloaded. Naming the file is the difference between the pane running
    // what was asked for and not opening at all.
    if let Some(path) = pwsh_path(false) {
        let managed = managed_exe("pwsh").is_some_and(|copy| copy == path);
        return (
            format!("\"{}\" {rest}", path.display()),
            managed.then(|| "This pane is the PowerShell 7 WinT downloaded.".to_string()),
        );
    }
    let Some(installed) = find_command("powershell.exe") else {
        return (command.to_string(), None);
    };
    (
        format!("\"{}\" {rest}", installed.display()),
        Some("PowerShell 7 is not installed, so this pane is Windows PowerShell.".into()),
    )
}

fn git_bash_path() -> Option<PathBuf> {
    let mut candidates = Vec::new();
    for variable in ["ProgramFiles", "ProgramFiles(x86)"] {
        if let Some(root) = std::env::var_os(variable) {
            candidates.push(PathBuf::from(root).join("Git").join("bin").join("bash.exe"));
        }
    }
    if let Some(root) = std::env::var_os("LOCALAPPDATA") {
        candidates.push(
            PathBuf::from(root)
                .join("Programs")
                .join("Git")
                .join("bin")
                .join("bash.exe"),
        );
    }
    candidates
        .into_iter()
        .find(|path| path.is_file())
        .or_else(|| managed_exe("git-bash"))
}

/// Where WinT keeps the programs it manages itself - the shells it downloaded,
/// the `wt.exe` proxy, the Claude Code walkthrough. The same folder whichever
/// program is asking, so the host writes the walkthrough where WinT would.
pub fn runtime_root() -> PathBuf {
    std::env::var_os("LOCALAPPDATA")
        .map(PathBuf::from)
        .unwrap_or_else(std::env::temp_dir)
        .join("WinT")
        .join("runtime")
}

static MANAGED: OnceLock<fn(&str) -> Option<PathBuf>> = OnceLock::new();

/// Tells this module how to find the copies of shells WinT downloaded. Only
/// WinT has a catalogue of those; until it has said, there are none.
pub fn set_managed_lookup(lookup: fn(&str) -> Option<PathBuf>) {
    let _ = MANAGED.set(lookup);
}

fn managed_exe(profile: &str) -> Option<PathBuf> {
    MANAGED.get().and_then(|lookup| lookup(profile))
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ShellAvailability {
    profile: &'static str,
    available: bool,
    reason: Option<&'static str>,
    /// The profile opens, but into a pane that installs the thing first. Only
    /// Claude Code does this: every other profile either starts a shell that is
    /// already on the machine or is honestly unavailable.
    setup: bool,
}

/// Every profile, and whether this computer can open it. Looks at the disk,
/// so it is never asked on a thread that draws anything.
pub fn availability() -> Vec<ShellAvailability> {
    let candidates = [
        (
            "pwsh",
            pwsh_path(false),
            "PowerShell 7 is not installed or is not on PATH.",
        ),
        (
            "pwsh-preview",
            pwsh_path(true),
            "PowerShell Preview is not installed.",
        ),
        (
            "powershell",
            find_command("powershell.exe"),
            "Windows PowerShell is not available.",
        ),
        (
            "cmd",
            find_command("cmd.exe"),
            "Command Prompt is not available.",
        ),
        ("git-bash", git_bash_path(), "Git Bash is not installed."),
        (
            "wsl",
            find_command("wsl.exe"),
            "Windows Subsystem for Linux is not installed.",
        ),
        (
            "nu",
            nu_path(),
            "NuShell is not installed or is not on PATH.",
        ),
    ];
    let mut found = vec![ShellAvailability {
        profile: "auto",
        available: true,
        reason: None,
        setup: false,
    }];
    found.extend(candidates.into_iter().map(|(profile, path, reason)| {
        let available = path.is_some();
        ShellAvailability {
            profile,
            available,
            reason: if available { None } else { Some(reason) },
            setup: false,
        }
    }));
    // Claude Code is never reported unavailable. A machine without it opens
    // the pane anyway and gets the setup walkthrough, because "unavailable"
    // is a dead end for the one profile where the way out is three
    // keystrokes inside the pane itself.
    let installed = claude_program().is_some();
    found.push(ShellAvailability {
        profile: "claude",
        available: true,
        reason: (!installed).then_some(
            "Not installed yet — opening it walks you through installing and signing in.",
        ),
        setup: !installed,
    });
    found
}
