//! Reporting a fault or a wish to the feedback broker.
//!
//! The POST is made here and only here. The key that authenticates it never
//! leaves this module: it is not handed to a window, not written to the health
//! log, and not put into any message that can reach the front end. A webview
//! that could see the header could leak it to any page it later loads, so the
//! front end asks for a report and is told only whether it arrived.
//!
//! The key comes from `FEEDBACK_BROKER_API_KEY` if that is set, and otherwise
//! from `BUILT_IN_KEY` below. The built-in one is a deliberate trade-off, made
//! so that reporting works for whoever installs WinT: a packaged app does not
//! inherit the environment of the shell that installed it, so an app that only
//! read the variable would report nothing for everybody but the developer.
//!
//! What that costs is worth being clear about. The key is in this repository and
//! therefore in its history, so replacing it means rotating it at the broker
//! rather than deleting a line. It is also recoverable from the shipped binary
//! by anyone who runs `strings` on it, which makes it a shared credential rather
//! than a secret: it authenticates "some copy of WinT", never a person, and
//! anyone who extracts it can post to this workspace. It is therefore only ever
//! good for writing feedback, and the variable still wins where it is set, so a
//! rotated key can be put in place without a rebuild.
//!
//! Two things send from here. The user does, through the form in App health,
//! and those always go. The app does, when it catches a fault it did not
//! expect, and those are held to a budget: one bad selector inside a render
//! throws three times a second, and a service that receives all of them is a
//! service nobody reads. The same fault is sent once per `DEDUPE`, and no more
//! than `BUDGET` automatic reports leave in a `BUDGET_WINDOW`.
//!
//! Nothing here may change what the app does. Every entry point returns its
//! error to the caller or swallows it; a broker that is down, misconfigured or
//! answering 500 is a telemetry failure and nothing else.

use std::collections::HashMap;
use std::sync::{Mutex, OnceLock};
use std::time::{Duration, Instant};

const ENDPOINT: &str = "https://feedback.broker/api/ingest";
const WORKSPACE: &str = "wint";
const KEY_VAR: &str = "FEEDBACK_BROKER_API_KEY";

/// The key used when the environment does not name one. See the note at the top
/// of this file: it ships inside the binary on purpose, and it is a shared
/// write-only credential rather than a secret. Rotate it at the broker rather
/// than trying to take it out of this repository's history.
const BUILT_IN_KEY: &str = "fb_fa2W5u_dO3FBeYM8QlaKhKz2wf0OYuni";

/// Short on purpose. A report is never worth making the caller wait, and the
/// user-initiated one is behind a button that has to come back.
const CONNECT_TIMEOUT: Duration = Duration::from_secs(3);
const TIMEOUT: Duration = Duration::from_secs(6);

/// How long the same automatic fault stays silent after it has been sent once.
const DEDUPE: Duration = Duration::from_secs(600);
/// The ceiling on automatic reports, so one failing loop cannot flood.
const BUDGET: usize = 8;
const BUDGET_WINDOW: Duration = Duration::from_secs(3600);

const MAX_TITLE: usize = 160;
const MAX_TEXT: usize = 2000;
const MAX_FIELD: usize = 120;

/// What the caller wants to say. `kind` decides which of the last fields the
/// broker is given: a bug carries severity, area, environment and page, a
/// request carries a category, and sending the other set is a 400.
#[derive(Debug, Clone, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Report {
    pub kind: String,
    pub title: String,
    #[serde(default)]
    pub description: Option<String>,
    #[serde(default)]
    pub severity: Option<String>,
    #[serde(default)]
    pub area: Option<String>,
    #[serde(default)]
    pub category: Option<String>,
    #[serde(default)]
    pub reporter: Option<String>,
    #[serde(default)]
    pub environment: Option<String>,
    #[serde(default)]
    pub page: Option<String>,
}

/// What the broker answered, as much of it as the window is allowed to know.
#[derive(Debug, Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Receipt {
    pub kind: String,
    pub id: String,
    pub url: Option<String>,
}

/// True when a key is present, so the form can say the app has nowhere to send
/// this rather than failing on the press. Never returns the key itself.
pub fn configured() -> bool {
    api_key().is_some()
}

/// The key to authenticate with. The environment wins, so a rotated key can be
/// put in place on a machine without waiting for a build; the built-in one is
/// what makes reporting work for an ordinary install. Only an empty or
/// whitespace variable falls through - a variable someone set deliberately to
/// blank is treated as "not set" rather than as a key of no characters.
fn api_key() -> Option<String> {
    let from_env = std::env::var(KEY_VAR)
        .ok()
        .map(|key| key.trim().to_string())
        .filter(|key| !key.is_empty());
    from_env.or_else(|| {
        let built_in = BUILT_IN_KEY.trim();
        (!built_in.is_empty()).then(|| built_in.to_string())
    })
}

/// The kinds the broker accepts. Anything else is refused here rather than
/// spent on a round trip that comes back 400.
fn valid_kind(kind: &str) -> bool {
    matches!(kind, "bug" | "request")
}

/// The severities the broker accepts. An unrecognised one is dropped rather
/// than sent, so a typo in a caller costs the whole report nothing.
fn valid_severity(severity: &str) -> bool {
    matches!(severity, "critical" | "high" | "medium" | "low")
}

/// Cuts a string to `limit` characters on a character boundary, collapsing the
/// whitespace: a stack trace pasted into a title is still one line.
fn clip(text: &str, limit: usize) -> String {
    let flat = text.split_whitespace().collect::<Vec<_>>().join(" ");
    if flat.chars().count() <= limit {
        return flat;
    }
    let kept: String = flat.chars().take(limit.saturating_sub(1)).collect();
    format!("{kept}\u{2026}")
}

/// Everything that must never leave this machine, taken out of a string before
/// it is put in the body.
///
/// The list is deliberately wider than what the app knows it sends. A
/// description is typed by a person and a caught error carries whatever the
/// throwing code put in it, so both are treated as text of unknown origin: a
/// secret named in passing is removed, the signed-in Windows account is removed
/// from every path, and the key this module authenticates with is removed last
/// of all, whatever it happens to be surrounded by.
pub fn redact(text: &str) -> String {
    // `name=value`, `name: value`, `"name":"value"` for any name that reads as
    // a secret. The value ends at whitespace or at a character that cannot be
    // part of one, so the sentence around it survives.
    const SECRET_WORDS: [&str; 12] = [
        "password",
        "passwd",
        "secret",
        "token",
        "apikey",
        "api_key",
        "api-key",
        "authorization",
        "auth",
        "cookie",
        "session",
        "bearer",
    ];

    let chars: Vec<char> = text.chars().collect();
    let lower: Vec<char> = text.to_lowercase().chars().collect();
    let mut out = String::with_capacity(text.len());
    let mut i = 0usize;

    while i < chars.len() {
        let mut matched = false;
        for word in SECRET_WORDS {
            let w: Vec<char> = word.chars().collect();
            if !lower[i..].starts_with(&w[..]) {
                continue;
            }
            // Only a whole word, so "authorized" is not a secret.
            if i > 0 && (chars[i - 1].is_ascii_alphanumeric() || chars[i - 1] == '_') {
                continue;
            }
            let mut j = i + w.len();
            let mut separators = 0usize;
            while j < chars.len()
                && (chars[j].is_whitespace()
                    || matches!(chars[j], '=' | ':' | '"' | '\'' | '[' | ']' | '>'))
            {
                if matches!(chars[j], '=' | ':') {
                    separators += 1;
                }
                j += 1;
            }
            // `bearer <token>` has no separator; everything else needs one, or
            // the word was just a word in a sentence.
            if separators == 0 && word != "bearer" {
                continue;
            }
            let value_start = j;
            // `authorization: Bearer <token>` puts a scheme where the value
            // should be. Taking out the word "Bearer" and leaving the token
            // behind it is worse than doing nothing, so a scheme is stepped
            // over and what follows it is taken as the value.
            loop {
                let token_start = j;
                while j < chars.len()
                    && !chars[j].is_whitespace()
                    && !matches!(chars[j], '"' | '\'' | ',' | ';' | ')' | '}' | ']')
                {
                    j += 1;
                }
                let token: String = chars[token_start..j].iter().collect::<String>().to_lowercase();
                if !matches!(token.as_str(), "bearer" | "basic" | "digest" | "token") {
                    break;
                }
                let mut after = j;
                while after < chars.len() && chars[after] == ' ' {
                    after += 1;
                }
                // A scheme with nothing after it is all there is to remove.
                if after == j || after >= chars.len() {
                    break;
                }
                j = after;
            }
            if j == value_start {
                continue;
            }
            out.extend(&chars[i..value_start]);
            out.push_str("[redacted]");
            i = j;
            matched = true;
            break;
        }
        if !matched {
            out.push(chars[i]);
            i += 1;
        }
    }

    let out = redact_user_paths(&out);
    let out = redact_emails(&out);
    // Last, and unconditionally: whatever the key is, it is not in the text.
    scrub_key(&out, api_key().as_deref())
}

/// Takes this process's own key out of a string, whatever surrounds it.
///
/// The key is passed in rather than read here so the guarantee can be asserted
/// in a test without touching the environment the rest of the suite shares.
/// A very short key is left alone: it would blank half the report, and a key
/// that short is not one the broker issued.
fn scrub_key(text: &str, key: Option<&str>) -> String {
    match key {
        Some(key) if key.chars().count() >= 8 => text.replace(key, "[redacted]"),
        _ => text.to_string(),
    }
}

/// `C:\Users\niels\...` names a person. The shape of the path is what makes a
/// report useful, not whose account it is under.
fn redact_user_paths(text: &str) -> String {
    let chars: Vec<char> = text.chars().collect();
    let lower: Vec<char> = text.to_lowercase().chars().collect();
    let needle: Vec<char> = "users".chars().collect();
    let mut out = String::with_capacity(text.len());
    let mut i = 0usize;
    while i < chars.len() {
        if matches!(chars[i], '\\' | '/') && lower[i + 1..].starts_with(&needle[..]) {
            let after = i + 1 + needle.len();
            if after < chars.len() && matches!(chars[after], '\\' | '/') {
                let mut j = after + 1;
                while j < chars.len()
                    && !matches!(chars[j], '\\' | '/')
                    && !chars[j].is_whitespace()
                {
                    j += 1;
                }
                if j > after + 1 {
                    out.extend(&chars[i..=after]);
                    out.push_str("[user]");
                    i = j;
                    continue;
                }
            }
        }
        out.push(chars[i]);
        i += 1;
    }
    out
}

fn redact_emails(text: &str) -> String {
    text.split_whitespace()
        .map(|word| match word.find('@') {
            Some(at) if at > 0 && word[at + 1..].contains('.') => "[email]".to_string(),
            _ => word.to_string(),
        })
        .collect::<Vec<_>>()
        .join(" ")
}

/// The exact body the broker is sent. Kept as its own function so what leaves
/// the machine can be asserted in a test without a network.
pub fn body(report: &Report) -> serde_json::Value {
    let mut map = serde_json::Map::new();
    map.insert("workspace".into(), WORKSPACE.into());
    map.insert("kind".into(), report.kind.clone().into());
    map.insert(
        "title".into(),
        clip(&redact(&report.title), MAX_TITLE).into(),
    );

    /// Redacts, clips, and leaves the field out entirely when nothing is left
    /// of it: the broker treats an absent optional and an empty one alike, and
    /// an empty string in the body only makes the report harder to read.
    fn put(
        map: &mut serde_json::Map<String, serde_json::Value>,
        name: &str,
        value: &Option<String>,
        limit: usize,
    ) {
        if let Some(text) = value {
            let text = clip(&redact(text), limit);
            if !text.is_empty() {
                map.insert(name.into(), text.into());
            }
        }
    }
    put(&mut map, "description", &report.description, MAX_TEXT);
    put(&mut map, "reporter", &report.reporter, MAX_FIELD);

    if report.kind == "bug" {
        if let Some(severity) = report.severity.as_deref().map(str::trim) {
            if valid_severity(severity) {
                map.insert("severity".into(), severity.into());
            }
        }
        put(&mut map, "area", &report.area, MAX_FIELD);
        put(&mut map, "environment", &report.environment, MAX_FIELD);
        put(&mut map, "page", &report.page, MAX_FIELD);
    } else {
        put(&mut map, "category", &report.category, MAX_FIELD);
    }
    serde_json::Value::Object(map)
}

/// What a broker answer means to the app. Nothing here is fatal - the worst
/// case is a line in the health log - but the user pressing the button is told
/// whether their report arrived.
pub fn describe_status(status: u16) -> Result<(), String> {
    match status {
        200..=299 => Ok(()),
        400..=499 => Err(format!(
            "The feedback service refused the report ({status}). Nothing was kept."
        )),
        _ => Err(format!(
            "The feedback service is not answering right now ({status}). Nothing was sent."
        )),
    }
}

/// Sends one report and waits for the answer. The caller is already off the
/// main thread; see `feedback_submit` in `lib.rs`.
pub fn submit(report: &Report) -> Result<Receipt, String> {
    let key = preflight(report, api_key())?;

    let client = reqwest::blocking::Client::builder()
        .connect_timeout(CONNECT_TIMEOUT)
        .timeout(TIMEOUT)
        .build()
        .map_err(|e| redact(&format!("Could not open a connection: {e}")))?;

    let response = client
        .post(ENDPOINT)
        .header("x-feedback-key", &key)
        .json(&body(report))
        .send()
        // The error can name the URL and the TLS failure; it is redacted all
        // the same, because it is about to be shown and logged.
        .map_err(|e| redact(&format!("Could not reach the feedback service: {e}")))?;

    let status = response.status().as_u16();
    describe_status(status)?;

    // A 201 whose body does not parse is still a report that arrived.
    let answered = response
        .json::<serde_json::Value>()
        .unwrap_or(serde_json::Value::Null);
    Ok(Receipt {
        kind: answered
            .get("kind")
            .and_then(|v| v.as_str())
            .unwrap_or(&report.kind)
            .to_string(),
        id: answered
            .get("id")
            .and_then(|v| v.as_str())
            .unwrap_or_default()
            .to_string(),
        url: answered
            .get("url")
            .and_then(|v| v.as_str())
            .map(str::to_string),
    })
}

/// Everything that can be decided before the network is touched: that the
/// report is one the broker accepts, and that there is a key to send it with.
/// Separate from `submit` so both refusals can be asserted without a socket and
/// without an environment variable.
///
/// The message about a missing key names the variable and never a value.
fn preflight(report: &Report, key: Option<String>) -> Result<String, String> {
    if !valid_kind(&report.kind) {
        return Err("A report is either a bug or a request.".into());
    }
    if report.title.trim().is_empty() {
        return Err("A report needs a one-line summary.".into());
    }
    key.ok_or_else(|| {
        format!(
            "This build has no feedback key, so there is nowhere to send this. Set {KEY_VAR} in the app's environment."
        )
    })
}

/// The state behind the budget. One lock, held for the length of a map lookup.
struct Limiter {
    seen: HashMap<String, Instant>,
    sent: Vec<Instant>,
}

fn limiter() -> &'static Mutex<Limiter> {
    static LIMITER: OnceLock<Mutex<Limiter>> = OnceLock::new();
    LIMITER.get_or_init(|| {
        Mutex::new(Limiter {
            seen: HashMap::new(),
            sent: Vec::new(),
        })
    })
}

/// Why an automatic report was not sent, for the health log and the tests.
#[derive(Debug, PartialEq, Eq)]
pub enum Allowed {
    Yes,
    Duplicate,
    OverBudget,
}

/// Decides whether this automatic report leaves, and counts it if it does.
/// `now` is a parameter so the windows can be tested without waiting for them.
pub fn allow_at(fingerprint: &str, now: Instant) -> Allowed {
    let Ok(mut state) = limiter().lock() else {
        // A poisoned lock is not a reason to start flooding.
        return Allowed::OverBudget;
    };
    state
        .seen
        .retain(|_, at| now.saturating_duration_since(*at) < DEDUPE);
    state
        .sent
        .retain(|at| now.saturating_duration_since(*at) < BUDGET_WINDOW);

    if state.seen.contains_key(fingerprint) {
        return Allowed::Duplicate;
    }
    if state.sent.len() >= BUDGET {
        return Allowed::OverBudget;
    }
    state.seen.insert(fingerprint.to_string(), now);
    state.sent.push(now);
    Allowed::Yes
}

/// What makes two faults the same fault. The line and column move with every
/// edit and the times differ on every throw, so no digit is part of it.
pub fn fingerprint(area: &str, title: &str) -> String {
    let title: String = redact(title)
        .chars()
        .filter(|c| !c.is_ascii_digit())
        .collect();
    clip(&format!("{area}|{title}"), 200)
}

/// A caught fault the app did not expect, reported as a bug on a best effort.
///
/// Returns at once: the POST is made on a thread of its own, so a slow or dead
/// broker can never be in the way of whatever was being done when the fault
/// happened. Nothing is returned for a caller to act on, because there is
/// nothing sensible for a caller to do about it.
pub fn report_error(area: &str, title: &str, detail: &str, environment: &str, page: &str) {
    if !configured() {
        return;
    }
    match allow_at(&fingerprint(area, title), Instant::now()) {
        Allowed::Yes => {}
        Allowed::Duplicate => return,
        Allowed::OverBudget => {
            crate::health::record("feedback", "an automatic report was held back by the budget");
            return;
        }
    }
    let report = Report {
        kind: "bug".into(),
        title: clip(&redact(title), MAX_TITLE),
        description: Some(detail.to_string()),
        severity: Some("medium".into()),
        area: Some(area.to_string()),
        category: None,
        reporter: None,
        environment: Some(environment.to_string()),
        page: Some(page.to_string()),
    };
    std::thread::Builder::new()
        .name("feedback-report".into())
        .spawn(move || {
            if let Err(why) = submit(&report) {
                // Redacted again on the way into the log: the log is a file the
                // user can open and paste anywhere.
                crate::health::record("feedback", redact(&why));
            }
        })
        .ok();
}

#[cfg(test)]
mod tests {
    use super::*;

    fn bug(title: &str) -> Report {
        Report {
            kind: "bug".into(),
            title: title.into(),
            description: Some("it fell over".into()),
            severity: Some("high".into()),
            area: Some("Torrents".into()),
            category: Some("ignored for a bug".into()),
            reporter: Some("visitor-1234".into()),
            environment: Some("WinT 0.171.0 / WebView2 120".into()),
            page: Some("/torrents".into()),
        }
    }

    #[test]
    fn a_bug_maps_to_the_documented_shape() {
        let sent = body(&bug("Torrent list stopped refreshing"));
        assert_eq!(sent["workspace"], "wint");
        assert_eq!(sent["kind"], "bug");
        assert_eq!(sent["title"], "Torrent list stopped refreshing");
        assert_eq!(sent["description"], "it fell over");
        assert_eq!(sent["severity"], "high");
        assert_eq!(sent["area"], "Torrents");
        assert_eq!(sent["reporter"], "visitor-1234");
        assert_eq!(sent["environment"], "WinT 0.171.0 / WebView2 120");
        assert_eq!(sent["page"], "/torrents");
        // A bug carries no category, whatever the caller filled in.
        assert!(sent.get("category").is_none());
    }

    #[test]
    fn a_request_carries_a_category_and_no_bug_fields() {
        let mut report = bug("Let me sort torrents by ratio");
        report.kind = "request".into();
        report.category = Some("Torrents".into());
        let sent = body(&report);
        assert_eq!(sent["kind"], "request");
        assert_eq!(sent["category"], "Torrents");
        for field in ["severity", "area", "environment", "page"] {
            assert!(sent.get(field).is_none(), "{field} does not belong here");
        }
    }

    #[test]
    fn an_unknown_severity_is_dropped_rather_than_sent() {
        let mut report = bug("Something broke");
        report.severity = Some("catastrophic".into());
        assert!(body(&report).get("severity").is_none());
    }

    #[test]
    fn empty_optionals_are_left_out_entirely() {
        let mut report = bug("Something broke");
        report.description = Some("   ".into());
        report.reporter = None;
        let sent = body(&report);
        assert!(sent.get("description").is_none());
        assert!(sent.get("reporter").is_none());
    }

    #[test]
    fn a_long_title_is_clipped() {
        let sent = body(&bug(&"x".repeat(400)));
        assert!(sent["title"].as_str().unwrap().chars().count() <= MAX_TITLE);
    }

    #[test]
    fn named_secrets_are_removed() {
        for (text, leak) in [
            ("login failed with password=hunter2 on retry", "hunter2"),
            (
                "header authorization: Bearer abc.def.ghi failed",
                "abc.def.ghi",
            ),
            ("cookie=sid_9f3ac1 was rejected", "sid_9f3ac1"),
            (
                "{\"token\":\"ghp_0123456789abcdef\"}",
                "ghp_0123456789abcdef",
            ),
            ("api_key = fb_live_zzzz", "fb_live_zzzz"),
        ] {
            let out = redact(text);
            assert!(out.contains("[redacted]"), "nothing redacted in {text:?}");
            assert!(!out.contains(leak), "{leak} survived in {out:?}");
        }
    }

    #[test]
    fn a_word_that_only_looks_like_a_secret_is_left_alone() {
        let out = redact("the authorized user is not a secret keeper");
        assert_eq!(out, "the authorized user is not a secret keeper");
    }

    #[test]
    fn the_account_name_is_taken_out_of_paths() {
        let out = redact("failed reading C:\\Users\\niels\\AppData\\Local\\wint\\health.log");
        assert!(out.contains("C:\\Users\\[user]\\AppData"), "{out}");
        assert!(!out.to_lowercase().contains("niels"));
    }

    #[test]
    fn an_address_is_taken_out() {
        let out = redact("reported by niels@example.com just now");
        assert_eq!(out, "reported by [email] just now");
    }

    #[test]
    fn the_key_never_reaches_the_body_whatever_carried_it() {
        // The case that matters most: the key coming back through a field the
        // app filled in itself, out of an error message or a copied header.
        let key = "fb_test_SECRETKEY_98765";
        for carrier in [
            key.to_string(),
            format!("upstream said {key} is invalid"),
            format!("x-feedback-key:{key}"),
        ] {
            let out = scrub_key(&carrier, Some(key));
            assert!(!out.contains(key), "{out}");
            assert!(out.contains("[redacted]"), "{out}");
        }
        // No key configured, or one too short to be one, changes nothing.
        assert_eq!(scrub_key("plain text", None), "plain text");
        assert_eq!(scrub_key("plain text", Some("xt")), "plain text");
    }

    #[test]
    fn a_bad_kind_or_an_empty_title_is_refused_before_the_network() {
        let key = "fb_test_SECRETKEY_98765";
        let mut wrong_kind = bug("Something broke");
        wrong_kind.kind = "praise".into();
        assert!(preflight(&wrong_kind, Some(key.into())).is_err());
        assert!(preflight(&bug("   "), Some(key.into())).is_err());
        // A report the broker would accept comes back with the key to send it.
        assert_eq!(
            preflight(&bug("Something broke"), Some(key.into())),
            Ok(key.to_string())
        );
    }

    #[test]
    fn a_plain_build_has_a_key_so_the_form_is_never_dead() {
        // The whole reason the key is built in: an install that never set the
        // variable still reports, rather than showing everyone a form that says
        // there is nowhere to send this.
        assert!(configured(), "a build with no environment set has no key");
        assert!(!BUILT_IN_KEY.trim().is_empty());
    }

    #[test]
    fn the_built_in_key_is_redacted_like_any_other() {
        // It ships in the binary, so it can turn up in a broker error message or
        // in something a user pasted. It must still never go back out in a body.
        let carrier = format!("upstream said {BUILT_IN_KEY} is invalid");
        let out = redact(&carrier);
        assert!(!out.contains(BUILT_IN_KEY), "{out}");
        assert!(out.contains("[redacted]"), "{out}");
    }

    #[test]
    fn without_a_key_nothing_is_attempted_and_nothing_is_named() {
        let why = preflight(&bug("Something broke"), None).unwrap_err();
        assert!(why.contains(KEY_VAR), "{why}");
        // The advice names the variable. It never carries a value.
        assert!(!why.contains("fb_"), "{why}");
    }

    #[test]
    fn non_2xx_is_a_telemetry_failure_not_a_panic() {
        assert!(describe_status(201).is_ok());
        assert!(describe_status(200).is_ok());
        for bad in [400u16, 401, 429, 500, 503] {
            let why = describe_status(bad).unwrap_err();
            assert!(why.contains(&bad.to_string()), "{why}");
        }
    }

    #[test]
    fn the_same_fault_is_sent_once_then_counted_out() {
        let now = Instant::now();
        let print = fingerprint("unit-test-dedupe", "the same throw at line 12");
        assert_eq!(allow_at(&print, now), Allowed::Yes);
        assert_eq!(allow_at(&print, now), Allowed::Duplicate);
        // The line number moving is still the same fault.
        let moved = fingerprint("unit-test-dedupe", "the same throw at line 98");
        assert_eq!(allow_at(&moved, now), Allowed::Duplicate);
        // Past the window it is news again.
        assert_eq!(
            allow_at(&print, now + DEDUPE + Duration::from_secs(1)),
            Allowed::Yes
        );
    }

    #[test]
    fn a_flood_of_different_faults_stops_at_the_budget() {
        let now = Instant::now();
        let mut sent = 0;
        for i in 0..200 {
            if allow_at(
                &fingerprint("unit-test-budget", &format!("fault {i} of many")),
                now,
            ) == Allowed::Yes
            {
                sent += 1;
            }
        }
        assert!(sent <= BUDGET, "{sent} reports left for 200 faults");
    }
}
