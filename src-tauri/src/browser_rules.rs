//! Which browser, and which profile, a link belongs in.
//!
//! Windows only lets one application be *the* browser. Once that application
//! is WinT (see `browser_assoc`), every `http:` and `https:` link on the
//! machine arrives here as a command line, and this module answers the only
//! question that matters: where does it actually go?
//!
//! * A **rule naming one browser** is a decision. The link is handed straight
//!   to it and nothing is shown — the whole point is that a routed link feels
//!   exactly like clicking a link always did.
//! * A **rule naming several** is a shortlist, not a decision. Some sites are
//!   genuinely ambiguous, and the honest answer to "which browser for x.com?"
//!   is sometimes "one of these three". The chooser goes up with those three
//!   on it, so what is left to answer is one keypress wide.
//! * **No rule** and the link is unknown, so WinT either asks or sends it to
//!   the browser named in `Rules::unmatched` — one browser taking everything
//!   nobody has thought about is what a settled setup looks like. The chooser
//!   window is a sibling window of its own, opened with the URL already in
//!   it, and the answer can be remembered as a new rule.
//! * Whatever the route, only the browsers in `installed_browsers_visible`
//!   are ever *offered*. A PC accumulates browsers nobody intends to open a
//!   link in again, and `Rules::hidden` is how they stop being suggested.
//!
//! Held down at the moment the link arrives, `Rules::ask_key` beats all of
//! it and puts the chooser up anyway.
//!
//! Nothing here ever opens a link the user did not answer for. Closing the
//! chooser drops the link, which is a real answer and the only one that
//! leaves no trace.
//!
//! ## The window must never block
//!
//! Every link is a person waiting for a page. `dispatch` is called from the
//! single-instance callback, which runs on Tauri's own thread, so it does
//! nothing there but hand the URL to a thread of its own. Reading the rules,
//! reading the registry and `CreateProcess` all happen on that thread.
//!
//! ## No loops
//!
//! A rule that pointed back at WinT would bounce a link between two processes
//! for ever. WinT is therefore never listed as a browser, and `launch` refuses
//! any target whose executable is this one.

use std::path::{Path, PathBuf};
use std::sync::Mutex;

use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Emitter, Manager};

use crate::off_thread;

/// Where the rules live. One `ui_state` key: durable, written through a
/// temporary file and fsynced, because a routing rule is something the user
/// would call saved.
const STORE: &str = "browser-rules";

/// One profile of one browser.
#[derive(Serialize, Deserialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct Profile {
    /// The folder to start the browser with — `Profile 1`, or a Firefox
    /// profile's name. This is what identifies the profile to the browser.
    pub dir: String,
    /// What the user called it, when they called it anything.
    pub name: Option<String>,
}

/// An installed browser, as the chooser draws it.
#[derive(Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct Browser {
    /// The exe path, which is also the identity: two channels of the same
    /// browser are two entries, and each has its own profiles.
    pub exe: String,
    /// The name Windows has for it.
    pub name: String,
    /// `chromium`, `firefox` or `other` — how a profile is passed on the
    /// command line, and whether profiles exist at all.
    pub kind: String,
    pub profiles: Vec<Profile>,
    /// The shell's own icon, as a data URL, or nothing when Windows had none.
    pub icon: Option<String>,
}

/// One routing rule.
#[derive(Serialize, Deserialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct Rule {
    pub id: String,
    /// What is matched: a host for `host` and `domain`, a URL prefix for
    /// `url`. Always stored lowercased.
    pub pattern: String,
    /// `domain` (the host and everything under it), `host` (that host alone)
    /// or `url` (every link starting with this text).
    pub scope: String,
    /// Where links matching this rule may go.
    ///
    /// One target is a decision: the link opens there and nothing is shown.
    /// Several is a shortlist — some sites are genuinely ambiguous, and the
    /// honest answer to "which browser for x.com?" can be "one of these
    /// three". A shortlisted link puts the chooser up with only those on it,
    /// so the question that remains is small and the answer is one keypress.
    #[serde(default)]
    pub targets: Vec<Target>,
    /// The single target rules used to be written as, before a rule could
    /// hold more than one. Read for a rule saved by an older build, and
    /// written back out as `targets` the next time that rule is saved.
    #[serde(default)]
    pub exe: String,
    #[serde(default)]
    pub browser: String,
    #[serde(default)]
    pub profile: Option<String>,
    #[serde(default)]
    pub profile_name: Option<String>,
    #[serde(default = "yes")]
    pub enabled: bool,
    /// Milliseconds since the epoch, so the list can be ordered by age.
    #[serde(default)]
    pub created: i64,
    /// How many links this rule has sent somewhere. The cheapest possible
    /// answer to "is this rule still doing anything?".
    #[serde(default)]
    pub uses: u64,
}

fn yes() -> bool {
    true
}

impl Rule {
    /// Everywhere a link under this rule may go, newest shape first.
    ///
    /// A rule written by an older build has no `targets` and one set of loose
    /// browser fields; it reads as a shortlist of one, so nothing else in
    /// this module has to know which shape it was saved in.
    pub fn choices(&self) -> Vec<Target> {
        if !self.targets.is_empty() {
            return self.targets.clone();
        }
        if self.exe.is_empty() {
            return Vec::new();
        }
        vec![Target {
            exe: self.exe.clone(),
            browser: self.browser.clone(),
            profile: self.profile.clone(),
            profile_name: self.profile_name.clone(),
        }]
    }

    /// Fold the old single-target fields into `targets`, so a rule is only
    /// ever written in one shape once it has been touched.
    fn migrate(&mut self) {
        if self.targets.is_empty() {
            self.targets = self.choices();
        }
        self.exe = String::new();
        self.browser = String::new();
        self.profile = None;
        self.profile_name = None;
    }
}

/// Everything the Browser tool saves.
#[derive(Serialize, Deserialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct Rules {
    #[serde(default)]
    pub rules: Vec<Rule>,
    /// What happens to a link no rule matches.
    ///
    /// `None` asks, which is the right behaviour for somebody still working
    /// out where things belong. A target means the opposite: open it there
    /// and do not ask. That is what a settled setup looks like — one browser
    /// takes everything that has not been thought about, and the rules are
    /// only for the sites that are exceptions to it.
    #[serde(default)]
    pub unmatched: Option<Target>,
    /// Where a link no rule matches goes, as a shortlist.
    ///
    /// The same shape as a rule's `targets`, because "everything else" is a
    /// rule like the others - the last one consulted. Empty asks between
    /// every browser, one opens there without a word, and several put the
    /// chooser up with those on it and nothing else.
    ///
    /// `unmatched` above is the single-browser shape this replaced. It is
    /// read once, on the next save, and then cleared.
    #[serde(default)]
    pub unmatched_targets: Vec<Target>,
    /// Browsers and profiles WinT should behave as though this PC does not
    /// have.
    ///
    /// A machine accumulates browsers — one that came with Windows, one
    /// installed for a single site three years ago, four profiles in the one
    /// that is actually used. Offering all of them every time is what makes a
    /// chooser something to read rather than glance at, and most of those
    /// rows are never going to be the answer.
    ///
    /// Anything listed here is filtered out of `installed`, which is the one
    /// place the browsers are read. The chooser, the rule editor, the
    /// suggestions and the default all draw from that, so hiding something
    /// hides it everywhere rather than in one list at a time.
    ///
    /// A rule that already names a hidden browser still routes to it: the
    /// rule is an explicit instruction, and this only decides what gets
    /// *offered*.
    #[serde(default)]
    pub hidden: Vec<Target>,
    /// A key that, held while a link is clicked, puts the chooser up whatever
    /// the rules say.
    ///
    /// Routing that cannot be overridden is routing you have to go and edit
    /// the moment it is wrong once — and "this one time, somewhere else" is
    /// the commonest thing to want. `shift`, `ctrl`, `alt` or `none`.
    ///
    /// It is read when WinT is handed the link, which is a moment after the
    /// click rather than during it. Holding the key until the page opens is
    /// what makes it reliable, and that is what the tool tells the user.
    #[serde(default = "default_ask_key")]
    pub ask_key: String,
}

fn default_ask_key() -> String {
    "shift".into()
}

/// Written by hand rather than derived, because a derived `String` default is
/// empty and an empty `ask_key` means *no* override. An install with no rules
/// file yet must still answer Shift, exactly as one whose file simply has no
/// `askKey` in it does.
impl Default for Rules {
    fn default() -> Self {
        Self {
            rules: Vec::new(),
            unmatched: None,
            unmatched_targets: Vec::new(),
            hidden: Vec::new(),
            ask_key: default_ask_key(),
        }
    }
}

/// Whether the override key is down right now.
///
/// `GetAsyncKeyState` asks the keyboard, not a message queue, so this works
/// from a background thread in a process that has no window focused — which
/// is exactly the situation: the click happened in somebody else's app.
#[cfg(windows)]
fn ask_key_held(key: &str) -> bool {
    use windows::Win32::UI::Input::KeyboardAndMouse::{
        GetAsyncKeyState, VK_CONTROL, VK_MENU, VK_SHIFT,
    };
    let code = match key {
        "shift" => VK_SHIFT,
        "ctrl" => VK_CONTROL,
        "alt" => VK_MENU,
        // "none", or anything unrecognised: no override at all.
        _ => return false,
    };
    // The high bit is "down now"; the low bit is "was pressed since last
    // asked", which would fire on a key pressed for something else entirely.
    (unsafe { GetAsyncKeyState(code.0 as i32) } as u16 & 0x8000) != 0
}

#[cfg(not(windows))]
fn ask_key_held(_key: &str) -> bool {
    false
}

/// A browser and profile, named the way a rule names one.
#[derive(Serialize, Deserialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct Target {
    pub exe: String,
    #[serde(default)]
    pub browser: String,
    #[serde(default)]
    pub profile: Option<String>,
    #[serde(default)]
    pub profile_name: Option<String>,
}

/// One link waiting for an answer, and what it may be answered with.
///
/// The shortlist travels with the link rather than being worked out again in
/// the chooser: the rules were already read to decide that this link needed
/// asking about at all, and a second read could disagree with the first.
#[derive(Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct PendingLink {
    pub url: String,
    /// The browsers to offer. Empty means "every browser on this PC" — the
    /// link matched no rule, so nothing has narrowed it yet.
    pub choices: Vec<Target>,
    /// The rule that shortlisted it, when one did. The chooser names it, and
    /// answering can narrow that same rule rather than writing a new one.
    pub rule_id: Option<String>,
    pub rule_pattern: Option<String>,
}

/// Links the shell handed over that nothing has answered yet.
///
/// Queued rather than pushed straight into a window, for the same reason
/// torrents are: the chooser may still be building when the URL arrives. It
/// drains this on mount, so a first link and a hundredth take the same path.
#[derive(Default)]
pub struct PendingUrls(pub Mutex<Vec<PendingLink>>);

// ---- reading and writing the rules -----------------------------------------

fn load(app: &AppHandle) -> Rules {
    crate::ui_state::read(app, STORE)
        .and_then(|value| serde_json::from_value(value).ok())
        .unwrap_or_default()
}

fn store(app: &AppHandle, rules: &Rules) -> Result<(), String> {
    let value = serde_json::to_value(rules).map_err(|e| e.to_string())?;
    crate::ui_state::write(app, STORE, &value)
}

// ---- matching ---------------------------------------------------------------

/// The host of a URL, lowercased, without userinfo or port. `None` for
/// anything that is not shaped like one.
pub fn host_of(url: &str) -> Option<String> {
    let rest = url.split_once("://")?.1;
    let authority = rest
        .split(['/', '?', '#'])
        .next()
        .filter(|part| !part.is_empty())?;
    let host = authority.rsplit_once('@').map_or(authority, |(_, h)| h);
    // A bracketed IPv6 literal keeps its brackets; only a trailing `:port` on
    // an ordinary host is cut.
    let host = if host.starts_with('[') {
        host.split_once(']').map_or(host, |(h, _)| h).trim_matches('[')
    } else {
        host.split_once(':').map_or(host, |(h, _)| h)
    };
    (!host.is_empty()).then(|| host.to_ascii_lowercase())
}

/// Whether one rule covers one link, and how specifically. A bigger number is
/// a better match, so the most specific rule wins however the list is ordered.
fn score(rule: &Rule, url: &str, host: Option<&str>) -> Option<usize> {
    if !rule.enabled || rule.pattern.is_empty() {
        return None;
    }
    let lower = url.to_ascii_lowercase();
    match rule.scope.as_str() {
        // A URL prefix is the most specific thing anyone can write, and a
        // longer one beats a shorter one.
        "url" => lower
            .starts_with(&rule.pattern)
            .then(|| 100_000 + rule.pattern.len()),
        "host" => (host? == rule.pattern).then_some(50_000),
        // The host itself, or anything under it. `example.com` must not match
        // `notexample.com`, which is why the dot is part of the test.
        _ => {
            let host = host?;
            (host == rule.pattern || host.ends_with(&format!(".{}", rule.pattern)))
                .then_some(rule.pattern.len())
        }
    }
}

/// The rule that owns this link, if any.
pub fn resolve<'a>(rules: &'a Rules, url: &str) -> Option<&'a Rule> {
    let host = host_of(url);
    rules
        .rules
        .iter()
        .filter_map(|rule| score(rule, url, host.as_deref()).map(|score| (score, rule)))
        .max_by_key(|(score, _)| *score)
        .map(|(_, rule)| rule)
}

// ---- launching ---------------------------------------------------------------

/// How a browser is told which profile to use.
pub(crate) fn kind_of(exe: &str) -> String {
    let stem = Path::new(exe)
        .file_stem()
        .unwrap_or_default()
        .to_string_lossy()
        .to_ascii_lowercase();
    #[cfg(windows)]
    if crate::appbar::CHROMIUM_EXES.contains(&stem.as_str()) {
        return "chromium".into();
    }
    #[cfg(not(windows))]
    if ["msedge", "chrome", "brave", "vivaldi", "opera", "thorium"].contains(&stem.as_str()) {
        return "chromium".into();
    }
    if ["firefox", "waterfox", "librewolf", "zen", "floorp"].contains(&stem.as_str()) {
        return "firefox".into();
    }
    "other".into()
}

/// True for WinT's own executable, under any name Windows might spell it with.
fn is_wint(exe: &str) -> bool {
    // Both sides are canonicalized: `current_exe` gives a plain path and
    // `canonicalize` gives a `\\?\` one, so comparing them raw never matches
    // even for the same file.
    let same_file = std::env::current_exe()
        .ok()
        .and_then(|mine| std::fs::canonicalize(mine).ok())
        .zip(std::fs::canonicalize(exe).ok())
        .map(|(mine, theirs)| mine == theirs)
        .unwrap_or(false);
    same_file
        || Path::new(exe)
            .file_stem()
            .map(|stem| stem.to_string_lossy().eq_ignore_ascii_case("wint"))
            .unwrap_or(false)
}

/// Start a browser on one link. Returns once the process has been created —
/// never once the page has loaded, which is the browser's business.
pub fn launch(exe: &str, profile: Option<&str>, url: &str) -> Result<(), String> {
    if exe.trim().is_empty() {
        return Err("That rule does not name a browser.".into());
    }
    // A rule pointing back at WinT would hand the link to a second WinT,
    // which would resolve the same rule again, for ever.
    if is_wint(exe) {
        return Err("WinT cannot open a link in itself.".into());
    }
    if !url.starts_with("http://") && !url.starts_with("https://") {
        return Err("Only http and https links are opened this way.".into());
    }
    let mut command = std::process::Command::new(exe);
    match (kind_of(exe).as_str(), profile) {
        (_, None) | (_, Some("")) => {}
        ("chromium", Some(dir)) => {
            command.arg(format!("--profile-directory={dir}"));
        }
        ("firefox", Some(name)) => {
            command.args(["-P", name, "-new-tab"]);
        }
        // Anything else takes the URL and nothing more; passing a flag it
        // does not understand is how a browser opens a search for `-P`.
        _ => {}
    }
    command.arg(url);
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        // The browser is its own window from here on; WinT must not be left
        // holding a console or waiting on it.
        const DETACHED_PROCESS: u32 = 0x0000_0008;
        command.creation_flags(DETACHED_PROCESS);
    }
    command
        .spawn()
        .map(|_| ())
        .map_err(|e| format!("Could not start {exe}: {e}"))
}

// ---- the browsers this machine has -------------------------------------------

#[cfg(windows)]
pub(crate) fn installed_browsers() -> Vec<Browser> {
    use crate::reg::{get_sz, subkeys};
    use windows::Win32::System::Registry::{HKEY_CURRENT_USER, HKEY_LOCAL_MACHINE};

    // Every browser registers itself as an internet client, in whichever hive
    // it was installed into. A 32-bit browser on a 64-bit Windows lands in the
    // WOW node, and a per-user install lands in HKCU.
    const ROOTS: [(&str, bool); 3] = [
        (r"SOFTWARE\Clients\StartMenuInternet", false),
        (r"SOFTWARE\WOW6432Node\Clients\StartMenuInternet", false),
        (r"Software\Clients\StartMenuInternet", true),
    ];
    let mut browsers: Vec<Browser> = Vec::new();
    for (path, per_user) in ROOTS {
        let hive = if per_user {
            HKEY_CURRENT_USER
        } else {
            HKEY_LOCAL_MACHINE
        };
        for key in subkeys(hive, path) {
            let base = format!(r"{path}\{key}");
            let command = get_sz(hive, &format!(r"{base}\shell\open\command"), None)
                .unwrap_or_default();
            let Some(exe) = exe_of(&command) else { continue };
            // WinT registers itself here too, and is the one browser that
            // must never appear in its own chooser.
            if is_wint(&exe) {
                continue;
            }
            if !Path::new(&exe).is_file() {
                continue;
            }
            if browsers
                .iter()
                .any(|found| found.exe.eq_ignore_ascii_case(&exe))
            {
                continue;
            }
            let name = get_sz(hive, &format!(r"{base}\Capabilities"), Some("ApplicationName"))
                .or_else(|| get_sz(hive, &base, None))
                .filter(|name| !name.trim().is_empty())
                .unwrap_or_else(|| key.clone());
            let kind = kind_of(&exe);
            browsers.push(Browser {
                profiles: profiles_of(&exe, &kind),
                exe,
                name,
                kind,
                icon: None,
            });
        }
    }
    browsers.sort_by_key(|browser| browser.name.to_ascii_lowercase());
    browsers
}

#[cfg(not(windows))]
pub(crate) fn installed_browsers() -> Vec<Browser> {
    Vec::new()
}

/// The executable out of a `shell\open\command` value. The value is usually
/// `"C:\…\chrome.exe" -- "%1"`, but a bare unquoted path happens too.
fn exe_of(command: &str) -> Option<String> {
    let command = command.trim();
    if command.is_empty() {
        return None;
    }
    let exe = if let Some(rest) = command.strip_prefix('"') {
        rest.split_once('"').map(|(exe, _)| exe)?.to_string()
    } else {
        // Unquoted: everything up to `.exe`, so a path with spaces in it and
        // an argument after it still comes apart in the right place.
        let lower = command.to_ascii_lowercase();
        match lower.find(".exe") {
            Some(end) => command[..end + 4].to_string(),
            None => command.split_whitespace().next()?.to_string(),
        }
    };
    (!exe.trim().is_empty()).then(|| exe.trim().to_string())
}

/// Every profile of one browser, in the order it would like to be listed.
fn profiles_of(exe: &str, kind: &str) -> Vec<Profile> {
    match kind {
        "chromium" => chromium_profiles(exe),
        "firefox" => firefox_profiles(exe),
        _ => Vec::new(),
    }
}

#[cfg(windows)]
fn chromium_profiles(exe: &str) -> Vec<Profile> {
    let mut profiles: Vec<Profile> = Vec::new();
    for data in crate::appbar::user_data_dirs(exe) {
        let Ok(entries) = std::fs::read_dir(&data) else {
            continue;
        };
        for entry in entries.filter_map(Result::ok) {
            if !entry.path().is_dir() {
                continue;
            }
            let dir = entry.file_name().to_string_lossy().into_owned();
            // A profile is `Default` or `Profile N`; everything else under
            // User Data is the browser's own bookkeeping.
            if dir != "Default" && !dir.starts_with("Profile ") {
                continue;
            }
            // Without a Preferences file the folder is a leftover, not a
            // profile anything can be opened in.
            if !entry.path().join("Preferences").is_file() {
                continue;
            }
            if profiles.iter().any(|found| found.dir == dir) {
                continue;
            }
            let name = crate::appbar::profile_name(&data, &dir);
            profiles.push(Profile { dir, name });
        }
        // The first user-data folder that really exists is this install's.
        if !profiles.is_empty() {
            break;
        }
    }
    profiles.sort_by_key(|profile| (profile.dir != "Default", profile.dir.clone()));
    profiles
}

#[cfg(not(windows))]
fn chromium_profiles(_exe: &str) -> Vec<Profile> {
    Vec::new()
}

/// Firefox keeps its profiles in an ini file, and is named by name rather
/// than by folder on the command line.
fn firefox_profiles(exe: &str) -> Vec<Profile> {
    let stem = Path::new(exe)
        .file_stem()
        .unwrap_or_default()
        .to_string_lossy()
        .to_ascii_lowercase();
    let Some(appdata) = std::env::var_os("APPDATA") else {
        return Vec::new();
    };
    let vendor: &[&str] = match stem.as_str() {
        "librewolf" => &["librewolf"],
        "waterfox" => &[r"Waterfox"],
        "zen" => &[r"zen"],
        "floorp" => &[r"Floorp"],
        _ => &[r"Mozilla\Firefox"],
    };
    let mut profiles = Vec::new();
    for tail in vendor {
        let ini = PathBuf::from(&appdata).join(tail).join("profiles.ini");
        let Ok(text) = std::fs::read_to_string(&ini) else {
            continue;
        };
        for block in text.split('[') {
            if !block.starts_with("Profile") {
                continue;
            }
            let name = block.lines().find_map(|line| {
                line.strip_prefix("Name=")
                    .map(|value| value.trim().to_string())
            });
            if let Some(name) = name.filter(|name| !name.is_empty()) {
                if !profiles.iter().any(|found: &Profile| found.dir == name) {
                    profiles.push(Profile {
                        name: Some(name.clone()),
                        dir: name,
                    });
                }
            }
        }
        if !profiles.is_empty() {
            break;
        }
    }
    profiles
}

// ---- dispatch ----------------------------------------------------------------

/// A link the shell handed to WinT.
///
/// Called from the single-instance callback and from startup, both of which
/// run where the window is drawn, so it does nothing here but start a thread.
/// Everything that reads a file, reads the registry or starts a process
/// happens on that thread.
pub fn dispatch(app: &AppHandle, url: String) {
    let app = app.clone();
    std::thread::spawn(move || {
        let rules = load(&app);
        let matched = resolve(&rules, &url).cloned();
        // Held down through the click: be asked anyway, whatever the rules
        // say — including a rule that would have opened silently, and
        // including the browser everything unmatched goes to.
        //
        // Every browser is offered rather than the shortlist, because
        // somebody overriding their own routing is by definition not after
        // the usual answers. The rule that *would* have taken this link is
        // still handed over, so the chooser offers to settle that rule rather
        // than to write a second one beside it.
        if ask_key_held(&rules.ask_key) {
            return ask(&app, url, Vec::new(), matched.as_ref());
        }
        let Some(rule) = matched else {
            // Nothing claims this link. Either the user has settled on a
            // browser for everything they have not thought about — in which
            // case it goes there without a word — or they have not, and the
            // question is worth putting, with the browsers they shortlisted
            // or all of them if they never shortlisted any.
            let choices = unmatched_choices(&rules);
            // Several browsers is the same answer a rule gives when it
            // shortlists: the question is not settled, only made small.
            if choices.len() == 1 {
                return open_unmatched(&app, &url, &choices[0]);
            }
            return ask(&app, url, choices, None);
        };
        let choices = rule.choices();
        // A rule that shortlists several browsers has not decided anything —
        // it has only made the question small. The chooser is put up with
        // those browsers on it and nothing else.
        if choices.len() != 1 {
            return ask(&app, url, choices, Some(&rule));
        }
        let target = &choices[0];
        match launch(&target.exe, target.profile.as_deref(), &url) {
            Ok(()) => {
                // A routed link shows nothing of its own — but a window that
                // happens to be open says where the link went, because silent
                // work is the one thing this app does not do.
                let _ = app.emit(
                    "browser:routed",
                    serde_json::json!({
                        "url": url,
                        "browser": target.browser,
                        "profile": target.profile_name.clone().or_else(|| target.profile.clone()),
                        "pattern": rule.pattern,
                    }),
                );
                count_use(&app, &rule.id);
            }
            // The browser is gone, or refused to start. Asking is better than
            // dropping the link on the floor, and with every browser offered
            // rather than the one that just failed.
            Err(_) => ask(&app, url, Vec::new(), None),
        }
    });
}

/// Send a link nothing claimed to the browser the user made the default for
/// everything else.
///
/// Said out loud in the status bar, and with the site named, because this is
/// the one routing decision the user did not make about this particular site:
/// seeing "opened x.com in Chrome" is how they notice that x.com should have
/// had a rule of its own.
fn open_unmatched(app: &AppHandle, url: &str, target: &Target) {
    if launch(&target.exe, target.profile.as_deref(), url).is_err() {
        // The default browser is gone or refused to start. The link is worth
        // more than the setting, so the question is put after all.
        return ask(app, url.to_string(), Vec::new(), None);
    }
    let _ = app.emit(
        "browser:routed",
        serde_json::json!({
            "url": url,
            "browser": target.browser,
            "profile": target.profile_name.clone().or_else(|| target.profile.clone()),
            "pattern": "",
            "unmatched": true,
        }),
    );
}

/// Put the chooser up for a link that still needs answering — because no rule
/// claimed it, or because the rule that did offers a choice.
fn ask(app: &AppHandle, url: String, choices: Vec<Target>, rule: Option<&Rule>) {
    let link = PendingLink {
        url: url.clone(),
        choices,
        rule_id: rule.map(|rule| rule.id.clone()),
        rule_pattern: rule.map(|rule| rule.pattern.clone()),
    };
    if let Ok(mut pending) = app.state::<PendingUrls>().0.lock() {
        pending.push(link);
    }
    if crate::tool_window::browser_ask_open(app, &url).is_ok() {
        return;
    }
    // The chooser could not be shown. A question nobody can answer is worse
    // than a guess, so the link opens at the best guess available and the
    // status bar says where it went.
    if let Ok(mut pending) = app.state::<PendingUrls>().0.lock() {
        pending.retain(|queued| queued.url != url);
    }
    // In order of how much each knows about *this* link: the first browser
    // the link's own rule named, then the browser everything unmatched goes
    // to, then the first of the shortlist.
    let rules = load(app);
    let guess = rule
        .and_then(|rule| rule.choices().into_iter().next())
        .or_else(|| unmatched_choices(&rules).into_iter().next())
        .or_else(|| first_visible_target(&rules));
    if let Some(guess) = guess {
        let _ = launch(&guess.exe, guess.profile.as_deref(), &url);
        let _ = app.emit(
            "browser:routed",
            serde_json::json!({
                "url": url,
                "browser": guess.browser,
                "profile": guess.profile_name,
                "pattern": "",
                "unmatched": true,
            }),
        );
    }
}

/// One more link through this rule. Best effort: a lost count is worth less
/// than the link it belongs to, and the link has already been opened.
fn count_use(app: &AppHandle, id: &str) {
    let mut rules = load(app);
    if let Some(rule) = rules.rules.iter_mut().find(|rule| rule.id == id) {
        rule.uses = rule.uses.saturating_add(1);
        let _ = store(app, &rules);
    }
}

// ---- commands ----------------------------------------------------------------

/// The browsers WinT will actually offer: everything installed, minus
/// everything hidden.
///
/// This is the one place the browsers are read, which is what makes hiding
/// one mean something. The chooser, the rule editor, the suggestions and the
/// default all come through here, so a profile taken out is taken out of all
/// four rather than out of the list that happened to be in front of you.
pub(crate) fn installed_browsers_visible(rules: &Rules) -> Vec<Browser> {
    let mut browsers = installed_browsers();
    if rules.hidden.is_empty() {
        return browsers;
    }
    let is_hidden = |exe: &str, profile: Option<&str>| {
        rules.hidden.iter().any(|gone| {
            gone.exe.eq_ignore_ascii_case(exe) && gone.profile.as_deref() == profile
        })
    };
    for browser in &mut browsers {
        browser
            .profiles
            .retain(|profile| !is_hidden(&browser.exe, Some(&profile.dir)));
    }
    browsers.retain(|browser| {
        // A browser with profiles that has had every one of them hidden is
        // itself hidden: there is nothing left of it to pick. One with no
        // profiles at all is hidden only by hiding the browser itself.
        if browser.profiles.is_empty() {
            !is_hidden(&browser.exe, None) && !hides_whole_browser(rules, &browser.exe)
        } else {
            !is_hidden(&browser.exe, None)
        }
    });
    browsers
}

/// Where a link no rule matches goes.
///
/// Reads the shortlist, falling back to the single browser a version
/// before this one saved. Nothing else looks at `unmatched` directly, so
/// this is the only place the two shapes have to be told apart.
fn unmatched_choices(rules: &Rules) -> Vec<Target> {
    if !rules.unmatched_targets.is_empty() {
        return rules.unmatched_targets.clone();
    }
    rules.unmatched.clone().into_iter().collect()
}

/// The first browser and profile WinT would offer, as a target.
///
/// The last resort when a link has to open somewhere and nothing has said
/// where: better the first browser this user has not hidden than a link that
/// silently goes nowhere.
fn first_visible_target(rules: &Rules) -> Option<Target> {
    let browser = installed_browsers_visible(rules).into_iter().next()?;
    let profile = browser.profiles.first();
    Some(Target {
        exe: browser.exe,
        browser: browser.name,
        profile: profile.map(|profile| profile.dir.clone()),
        profile_name: profile.and_then(|profile| profile.name.clone()),
    })
}

/// Whether every profile this browser had is on the hidden list — the case
/// where the profiles are gone but the browser was never named directly.
fn hides_whole_browser(rules: &Rules, exe: &str) -> bool {
    rules
        .hidden
        .iter()
        .any(|gone| gone.exe.eq_ignore_ascii_case(exe))
}

/// Every browser installed on this machine, with its profiles. Icons are left
/// out: the chooser asks for those separately so the list itself is drawn in
/// the first frame.
#[tauri::command]
pub async fn browser_list(app: AppHandle) -> Vec<Browser> {
    off_thread(move || installed_browsers_visible(&load(&app)))
        .await
        .unwrap_or_default()
}

/// Everything installed, hidden or not. Only the settings list needs this —
/// it is where a hidden browser is ticked back on, so it is the one place
/// that has to be able to see one.
#[tauri::command]
pub async fn browser_list_all() -> Vec<Browser> {
    off_thread(installed_browsers).await.unwrap_or_default()
}

/// The shell's icons for a batch of browsers, in the order asked. Separate
/// from `browser_list` because entering the shell's apartment is the slow
/// part, and no icon is worth making the chooser wait.
#[tauri::command]
pub async fn browser_icons(exes: Vec<String>) -> Vec<Option<String>> {
    let count = exes.len();
    off_thread(move || crate::apps::icons(&exes))
        .await
        .unwrap_or_else(|| vec![None; count])
}

#[tauri::command]
pub async fn browser_rules_load(app: AppHandle) -> Rules {
    off_thread(move || load(&app)).await.unwrap_or_default()
}

#[tauri::command]
pub async fn browser_rules_save(app: AppHandle, rules: Rules) -> Result<(), String> {
    off_thread(move || {
        let mut rules = rules;
        for rule in &mut rules.rules {
            rule.pattern = rule.pattern.trim().to_ascii_lowercase();
            // Everything that reads a rule reads `targets`, so this is where
            // a rule saved in the old single-browser shape stops being one.
            rule.migrate();
            // The same browser and profile twice would put the same row on
            // the chooser twice, which is not a choice.
            rule.targets
                .dedup_by(|a, b| a.exe.eq_ignore_ascii_case(&b.exe) && a.profile == b.profile);
        }
        // "Everything else" written in the old single-browser shape becomes
        // a shortlist of one, the same way a rule does, and stops being
        // written in two places that could disagree.
        if rules.unmatched_targets.is_empty() {
            rules.unmatched_targets.extend(rules.unmatched.take());
        }
        rules.unmatched = None;
        rules
            .unmatched_targets
            .dedup_by(|a, b| a.exe.eq_ignore_ascii_case(&b.exe) && a.profile == b.profile);
        rules
            .hidden
            .dedup_by(|a, b| a.exe.eq_ignore_ascii_case(&b.exe) && a.profile == b.profile);
        store(&app, &rules)
    })
    .await
    .unwrap_or_else(|| Err("Saving the rules timed out.".into()))
}

/// What would happen to this link right now. The Browser tool's way of
/// showing a rule works before a link depends on it.
#[tauri::command]
pub async fn browser_rules_test(app: AppHandle, url: String) -> Option<Rule> {
    off_thread(move || resolve(&load(&app), &url).cloned())
        .await
        .flatten()
}

/// Whatever the shell left behind, taken once. Draining rather than reading is
/// deliberate: a link must never be opened twice because the chooser was
/// closed and opened again.
#[tauri::command]
pub fn browser_pending_urls(state: tauri::State<'_, PendingUrls>) -> Vec<PendingLink> {
    state
        .0
        .lock()
        .map(|mut queue| std::mem::take(&mut *queue))
        .unwrap_or_default()
}

/// Open one link in one browser, and optionally remember the answer.
///
/// `remember` is a scope — `domain`, `host` or `url` — or nothing for "just
/// this once". The rule is written *before* the browser is started, so a
/// browser that fails to start still leaves the answer recorded rather than
/// asking the same question again next time.
#[tauri::command]
pub async fn browser_open_url(
    app: AppHandle,
    url: String,
    target: Target,
    remember: Option<String>,
    rule_id: Option<String>,
) -> Result<(), String> {
    off_thread(move || {
        match remember.as_deref().filter(|scope| !scope.is_empty()) {
            // "Always this one": the rule that shortlisted this link had
            // several browsers on it and the user has just settled it. The
            // rule is narrowed rather than a second one written, so the
            // shortlist does not survive next to the answer that replaced it.
            Some("only") => {
                let mut rules = load(&app);
                let id = rule_id
                    .as_deref()
                    .ok_or("There is no rule to settle for this link.")?;
                let rule = rules
                    .rules
                    .iter_mut()
                    .find(|rule| rule.id == id)
                    .ok_or("That rule is no longer there.")?;
                rule.migrate();
                rule.targets = vec![target.clone()];
                store(&app, &rules)?;
            }
            Some(scope) => {
                let pattern = pattern_for(&url, scope)?;
                let mut rules = load(&app);
                // One pattern, one rule: answering again about the same site
                // replaces the old answer rather than piling a second one on
                // it.
                rules
                    .rules
                    .retain(|rule| !(rule.scope == scope && rule.pattern == pattern));
                rules.rules.push(Rule {
                    id: format!("{}-{}", now_ms(), rules.rules.len()),
                    pattern,
                    scope: scope.to_string(),
                    targets: vec![target.clone()],
                    exe: String::new(),
                    browser: String::new(),
                    profile: None,
                    profile_name: None,
                    enabled: true,
                    created: now_ms(),
                    uses: 0,
                });
                store(&app, &rules)?;
            }
            None => {}
        }
        // A link that came through a shortlist still went through that rule,
        // whichever branch of it the user took.
        if let Some(id) = rule_id.as_deref() {
            count_use(&app, id);
        }
        launch(&target.exe, target.profile.as_deref(), &url)?;
        let _ = app.emit(
            "browser:routed",
            serde_json::json!({
                "url": url,
                "browser": target.browser,
                "profile": target.profile_name.or(target.profile),
                "pattern": "",
            }),
        );
        Ok(())
    })
    .await
    .unwrap_or_else(|| Err("Opening that link timed out.".into()))
}

/// What a remembered answer about this link is written down as.
fn pattern_for(url: &str, scope: &str) -> Result<String, String> {
    match scope {
        "url" => {
            // Everything up to the query: remembering `?utm_source=…` would
            // make a rule that never matches anything again.
            let trimmed = url.split(['?', '#']).next().unwrap_or(url);
            Ok(trimmed.to_ascii_lowercase())
        }
        "host" | "domain" => {
            host_of(url).ok_or_else(|| format!("{url} has no host to make a rule from."))
        }
        other => Err(format!("{other} is not a scope a rule can have.")),
    }
}

fn now_ms() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|since| since.as_millis() as i64)
        .unwrap_or_default()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn target(exe: &str) -> Target {
        Target {
            exe: exe.into(),
            browser: exe.into(),
            profile: None,
            profile_name: None,
        }
    }

    fn rule(pattern: &str, scope: &str) -> Rule {
        Rule {
            id: pattern.into(),
            pattern: pattern.into(),
            scope: scope.into(),
            targets: vec![target(r"C:\chrome.exe")],
            exe: String::new(),
            browser: String::new(),
            profile: None,
            profile_name: None,
            enabled: true,
            created: 0,
            uses: 0,
        }
    }

    #[test]
    fn host_is_read_without_userinfo_or_port() {
        assert_eq!(host_of("https://Example.COM/x"), Some("example.com".into()));
        assert_eq!(host_of("http://a:b@host:8080/"), Some("host".into()));
        assert_eq!(host_of("https://[::1]:443/"), Some("::1".into()));
        assert_eq!(host_of("not a url"), None);
    }

    #[test]
    fn a_domain_rule_does_not_match_a_lookalike() {
        let rules = Rules {
            rules: vec![rule("example.com", "domain")],
            unmatched: None,
            unmatched_targets: Vec::new(),
            ask_key: "shift".into(),
            hidden: Vec::new(),
        };
        assert!(resolve(&rules, "https://mail.example.com/").is_some());
        assert!(resolve(&rules, "https://example.com/").is_some());
        assert!(resolve(&rules, "https://notexample.com/").is_none());
    }

    #[test]
    fn the_most_specific_rule_wins() {
        let rules = Rules {
            rules: vec![
                rule("example.com", "domain"),
                rule("mail.example.com", "host"),
                rule("https://example.com/admin", "url"),
            ],
            unmatched: None,
            unmatched_targets: Vec::new(),
            ask_key: "shift".into(),
            hidden: Vec::new(),
        };
        assert_eq!(
            resolve(&rules, "https://mail.example.com/").unwrap().scope,
            "host"
        );
        assert_eq!(
            resolve(&rules, "https://example.com/admin/x")
                .unwrap()
                .scope,
            "url"
        );
        assert_eq!(
            resolve(&rules, "https://www.example.com/").unwrap().scope,
            "domain"
        );
    }

    #[test]
    fn a_disabled_rule_matches_nothing() {
        let mut off = rule("example.com", "domain");
        off.enabled = false;
        let rules = Rules {
            rules: vec![off],
            unmatched: None,
            unmatched_targets: Vec::new(),
            ask_key: "shift".into(),
            hidden: Vec::new(),
        };
        assert!(resolve(&rules, "https://example.com/").is_none());
    }

    #[test]
    fn a_rule_saved_by_an_older_build_reads_as_a_shortlist_of_one() {
        let mut old = rule("example.com", "domain");
        old.targets = Vec::new();
        old.exe = r"C:\firefox.exe".into();
        old.browser = "Firefox".into();
        let choices = old.choices();
        assert_eq!(choices.len(), 1);
        assert_eq!(choices[0].exe, r"C:\firefox.exe");
        // And saving it moves it to the new shape without changing where the
        // link goes.
        old.migrate();
        assert!(old.exe.is_empty());
        assert_eq!(old.choices()[0].browser, "Firefox");
    }

    #[test]
    fn a_rule_with_no_browser_at_all_offers_nothing() {
        let mut empty = rule("example.com", "domain");
        empty.targets = Vec::new();
        assert!(empty.choices().is_empty());
    }

    #[test]
    fn a_shortlist_keeps_every_browser_on_it() {
        let mut many = rule("x.com", "domain");
        many.targets = vec![
            target(r"C:\chrome.exe"),
            target(r"C:\firefox.exe"),
            target(r"C:\msedge.exe"),
        ];
        let rules = Rules {
            rules: vec![many],
            unmatched: None,
            unmatched_targets: Vec::new(),
            ask_key: "shift".into(),
            hidden: Vec::new(),
        };
        let matched = resolve(&rules, "https://x.com/home").expect("the rule matches");
        assert_eq!(matched.choices().len(), 3);
    }

    #[test]
    fn the_exe_comes_out_of_a_shell_command() {
        assert_eq!(
            exe_of("\"C:\\Program Files\\Google\\Chrome\\chrome.exe\" -- \"%1\""),
            Some(r"C:\Program Files\Google\Chrome\chrome.exe".into())
        );
        assert_eq!(
            exe_of(r"C:\Program Files\Mozilla Firefox\firefox.exe -osint -url %1"),
            Some(r"C:\Program Files\Mozilla Firefox\firefox.exe".into())
        );
        assert_eq!(exe_of("  "), None);
    }

    #[test]
    fn a_remembered_url_rule_drops_the_query() {
        assert_eq!(
            pattern_for("https://Example.com/a/b?c=1#d", "url").unwrap(),
            "https://example.com/a/b"
        );
        assert_eq!(
            pattern_for("https://Example.com/a?x", "domain").unwrap(),
            "example.com"
        );
    }
}
