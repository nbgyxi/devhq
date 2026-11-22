use serde::Serialize;
use serde_json::{json, Value};
use std::path::Path;

fn forward_to_wint(arguments: impl IntoIterator<Item = String>) -> Result<String, String> {
    let term_id =
        std::env::var_os("WINT_TERM_ID").ok_or("WinT terminal context is unavailable.")?;
    // Each running WinT owns its own queue. This matters when the installed
    // app and WinT Dev are open together: their terminal ids both begin at the
    // same value, so a shared queue can make the wrong process claim a split.
    // Older hosted terminals did not receive WINT_WT_QUEUE, so retain the old
    // location as a compatibility fallback until those sessions are closed.
    let queue = if let Some(queue) = std::env::var_os("WINT_WT_QUEUE") {
        std::path::PathBuf::from(queue)
    } else {
        let Some(local) = std::env::var_os("LOCALAPPDATA") else {
            return Err("the local application-data folder is unavailable.".into());
        };
        std::path::PathBuf::from(local)
            .join("WinT")
            .join("runtime")
            .join("requests")
    };
    if let Err(error) = std::fs::create_dir_all(&queue) {
        return Err(format!("could not open WinT's request queue: {error}"));
    }
    let stamp = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default()
        .as_nanos();
    let name = format!("wt-{}-{stamp}.json", std::process::id());
    let pending = queue.join(format!(".{name}.tmp"));
    let ready = queue.join(&name);
    let mut forwarded = vec![
        "wt.exe".to_string(),
        format!("--wint-wt={}", term_id.to_string_lossy()),
    ];
    forwarded.extend(arguments);
    let result = serde_json::to_vec(&forwarded)
        .map_err(|error| error.to_string())
        .and_then(|bytes| std::fs::write(&pending, bytes).map_err(|error| error.to_string()))
        .and_then(|_| std::fs::rename(&pending, &ready).map_err(|error| error.to_string()));
    if let Err(error) = result {
        let _ = std::fs::remove_file(&pending);
        return Err(format!("could not send the command to WinT: {error}"));
    }
    // `wt` holds the prompt until WinT says what happened. The pane opens in
    // another process, so without this the shell gets its prompt straight back
    // and a pane that never started looks exactly like one that did.
    //
    // WinT answers beside the queue under the same process id: a request in
    // `requests-<pid>` is answered in `replies-<pid>`. Looking in a plain
    // `replies` instead missed every answer, so `wt` sat out its full wait and
    // then reported a failure for a pane that had opened.
    let replies = queue.with_file_name(reply_folder_name(&queue));
    let reply = replies.join(&name);
    let taken_by = std::time::Instant::now() + std::time::Duration::from_secs(5);
    let answer_by = std::time::Instant::now() + std::time::Duration::from_secs(20);
    let mut taken = false;
    loop {
        if let Ok(bytes) = std::fs::read(&reply) {
            let _ = std::fs::remove_file(&reply);
            let answer: Value = serde_json::from_slice(&bytes).unwrap_or(Value::Null);
            let message = answer.get("message").and_then(Value::as_str).unwrap_or("");
            if answer.get("ok").and_then(Value::as_bool) == Some(true) {
                return Ok(message.to_string());
            }
            return Err(if message.is_empty() {
                "WinT could not run this command.".into()
            } else {
                message.into()
            });
        }
        if !taken {
            taken = !ready.exists();
            if !taken && std::time::Instant::now() >= taken_by {
                let _ = std::fs::remove_file(&ready);
                return Err(
                    "WinT did not take this command. Its terminal panel is not listening.".into(),
                );
            }
        } else if std::time::Instant::now() >= answer_by {
            // Taken, but no window owned up to it: the terminal this was typed
            // in is no longer one WinT is showing.
            return Err("WinT took this command but never reported what happened to it.".into());
        }
        std::thread::sleep(std::time::Duration::from_millis(20));
    }
}

/// `requests-<pid>` becomes `replies-<pid>`. The legacy shared `requests`
/// folder had a plain `replies` beside it.
fn reply_folder_name(queue: &std::path::Path) -> String {
    let name = queue
        .file_name()
        .map(|name| name.to_string_lossy().into_owned())
        .unwrap_or_default();
    match name.strip_prefix("requests") {
        Some(pid) => format!("replies{pid}"),
        None => "replies".into(),
    }
}

fn run_as_wt_proxy() -> bool {
    let invoked_as_wt = std::env::current_exe()
        .ok()
        .and_then(|path| {
            path.file_stem()
                .map(|name| name.to_string_lossy().into_owned())
        })
        .is_some_and(|name| name.eq_ignore_ascii_case("wt"));
    if !invoked_as_wt {
        return false;
    }
    match forward_to_wint(std::env::args().skip(1)) {
        Ok(message) => {
            if !message.is_empty() {
                println!("{message}");
            }
            std::process::exit(0);
        }
        Err(error) => {
            eprintln!("wt: {error}");
            std::process::exit(1);
        }
    }
}

const HELP: &str = r#"WinT CLI

Usage: wint <command> [arguments]

Project
  scan [ROOT]                         Scan projects (default: detected code root)
  git status PATH                     Inspect a repository
  git diff PATH                       Print its staged and unstaged patch
  git pull PATH [GROUP]               Pull and inspect it again
  todo scan PATH                      Find TODO/FIXME notes
  todo excerpt PATH FILE LINE         Show source around a note
  open PATH TARGET                    Open with explorer, reveal, vscode, or terminal

Machine
  ports list                          List listening processes
  ports sample PID...                 Sample CPU and memory
  ports kill PID EXE PROCESS [--tree] Kill only if process identity still matches
  disk drives                         List local disks
  disk scan PATH                      Measure direct children
  system report                       Audit PATH and environment
  system active-window                Describe the foreground window
  system keep-awake on|off [--display] [--away]
  event-log QUERY_JSON                Query Windows Event Log
  registry list PATH                  List a registry key
  registry change CHANGE_JSON         Apply a registry change
  log tail PATH [LINES]               Read the end of a log (default: 200)
  lock inspect PATH                   Find processes locking a path
  audio list                          List audio endpoints
  audio default ID                    Set the default endpoint
  repair list ID                      List repair targets
  repair run ID [TARGET]              Run a repair (potentially destructive)

Network and DNS
  dns lookup NAME [SERVER] [TYPE...]  Resolve records
  dns compare NAME [TYPE]             Compare resolvers (default: A)
  dns reverse ADDRESS                 Reverse lookup
  dns flush                           Flush the Windows DNS cache
  dns hosts                           Read the hosts file and backups
  dns hosts-write REQUEST_JSON        Write with optimistic concurrency + backup
  net capability|components|rate      Inspect packet capture support/state
  net backlog [LIMIT]                 Read captured frames
  net stop|clear                      Control the current capture
  net export [PATH]                   Export captured frames to pcapng
  netusage sample                      Which processes are using the line
  netusage watch [MINUTES]             Measure per-app TCP bytes (needs admin)

Projects cockpit (what agents report about each project; see `wint help cockpit`)
  cockpit list [--status S]           The favorite projects, worst status first
  cockpit get PROJECT                 One project's status, KPIs and notes
  cockpit set PROJECT [--status S] [--summary TEXT] [--next TEXT] [--by NAME]
  cockpit note PROJECT KIND TEXT [--source SRC] [--by NAME]
  cockpit unnote PROJECT NOTE_ID      Remove one note
  cockpit kpi PROJECT LABEL VALUE [--tone good|warn|bad] [--by NAME]
  cockpit apply PROJECT JSON|-        Apply an update object (- reads stdin)
  cockpit clear PROJECT               Remove everything observed about it
  cockpit report FILE|- [--title T] [--by NAME]  Show an HTML summary above the cards
  cockpit report-clear                Remove the summary report
  cockpit dir                         Print the folder the cockpit lives in
  mcp                                 Serve the cockpit over MCP on stdio
  connect claude                      Add this wint to Claude Desktop's config

GitHub and app
  github status                      Check gh authentication
  github api METHOD ENDPOINT [JSON]   Call an allow-listed GitHub API endpoint
  root                                Print the default code root
  version                             Print the CLI version
  app                                 Launch the WinT desktop app

Output is JSON except for help, version, git diff, and app. Pass --pretty to
pretty-print JSON. Every path may be absolute, so this command works from any
directory. Run `wint help <area>` for the same command overview.
"#;

fn need(args: &[String], index: usize, name: &str) -> Result<String, String> {
    args.get(index)
        .cloned()
        .ok_or_else(|| format!("Missing {name}. Run `wint help`."))
}

fn number<T: std::str::FromStr>(value: String, name: &str) -> Result<T, String> {
    value
        .parse()
        .map_err(|_| format!("Invalid {name}: {value}"))
}

fn parsed<T: serde::de::DeserializeOwned>(value: String, name: &str) -> Result<T, String> {
    serde_json::from_str(&value).map_err(|e| format!("Invalid {name} JSON: {e}"))
}

const COCKPIT_HELP: &str = r#"WinT Projects cockpit

WinT's Projects view shows, on each project's card, what agents have observed:
a status (healthy, attention, incident, unknown), a one-line summary, the next
thing to do, up to 8 KPIs and a list of notes. Only the projects starred as
favorites in WinT get reports: `list` shows those, and the rest are refused.
Any agent can write them:

  wint cockpit set devhq --status attention --summary "CI red since 09:10" --by Grok
  wint cockpit note devhq Risk "feat/x has 4 unmerged commits, 19 days old" --source GitHub --by Grok
  wint cockpit kpi devhq "Open PRs" 3 --tone warn
  echo {"next":"Review PR #212","addNotes":[{"kind":"Waiting","text":"..."}]} | wint cockpit apply devhq -

Sending the same note (same kind and text) again updates it instead of adding
a copy, so a bot can rerun safely. --by defaults to $WINT_AGENT, then "CLI".

For Claude Desktop, add to %APPDATA%\Claude\claude_desktop_config.json:

  { "mcpServers": { "wint": { "command": "<path to this wint.exe>", "args": ["mcp"] } } }

The data is plain JSON in `wint cockpit dir`; README.md there describes it.
"#;

type Flags = Vec<(String, String)>;

/// `--name value` pairs after the positional arguments. A flag given twice
/// keeps both, in order.
fn flags(args: &[String]) -> Result<(Vec<String>, Flags), String> {
    let mut positional = Vec::new();
    let mut named = Vec::new();
    let mut i = 0;
    while i < args.len() {
        if let Some(name) = args[i].strip_prefix("--") {
            let value = args
                .get(i + 1)
                .cloned()
                .ok_or_else(|| format!("--{name} needs a value."))?;
            named.push((name.to_string(), value));
            i += 2;
        } else {
            positional.push(args[i].clone());
            i += 1;
        }
    }
    Ok((positional, named))
}

fn flag<'a>(named: &'a [(String, String)], name: &str) -> Option<&'a str> {
    named.iter().rev().find(|(n, _)| n == name).map(|(_, v)| v.as_str())
}

fn cockpit(args: &[String], pretty: bool) -> Result<(), String> {
    use wint_lib::cockpit;
    let action = need(args, 1, "cockpit action")?;
    let (pos, named) = flags(&args[2..])?;
    let agent = flag(&named, "by")
        .map(str::to_string)
        .or_else(|| std::env::var("WINT_AGENT").ok().filter(|v| !v.trim().is_empty()))
        .unwrap_or_else(|| "CLI".into());
    let project = || need(&pos, 0, "project");
    match action.as_str() {
        "help" => {
            print!("{COCKPIT_HELP}");
            Ok(())
        }
        "dir" => emit(json!({ "dir": cockpit::dir()?.display().to_string() }), pretty),
        "list" => emit(cockpit::overview(flag(&named, "status")), pretty),
        "get" => emit(cockpit::project(&project()?)?, pretty),
        "set" => {
            let mut update = serde_json::Map::new();
            for name in ["status", "summary", "next"] {
                if let Some(value) = flag(&named, name) {
                    update.insert(name.into(), json!(value));
                }
            }
            emit(cockpit::apply_as_agent(&project()?, &Value::Object(update), &agent)?, pretty)
        }
        "note" => {
            let note = json!({
                "kind": need(&pos, 1, "note kind (Risk, Next, Waiting...)")?,
                "text": need(&pos, 2, "note text")?,
                "source": flag(&named, "source").unwrap_or(""),
            });
            emit(cockpit::apply_as_agent(&project()?, &json!({ "addNotes": [note] }), &agent)?, pretty)
        }
        "unnote" => emit(
            cockpit::apply_as_agent(&project()?, &json!({ "removeNotes": [need(&pos, 1, "note id")?] }), &agent)?,
            pretty,
        ),
        "kpi" => {
            let name = project()?;
            let label = need(&pos, 1, "KPI label")?;
            let value = need(&pos, 2, "KPI value")?;
            // One KPI changes; the rest are carried over in their order.
            let mut kpis: Vec<Value> = cockpit::read(&cockpit::resolve(&name)?.key)
                .map(|o| o.kpis.into_iter().map(|k| json!(k)).collect())
                .unwrap_or_default();
            let fresh = json!({ "label": label, "value": value, "tone": flag(&named, "tone").unwrap_or("") });
            match kpis.iter_mut().find(|k| k["label"].as_str().is_some_and(|l| l.eq_ignore_ascii_case(&label))) {
                Some(existing) => *existing = fresh,
                None => kpis.push(fresh),
            }
            emit(cockpit::apply_as_agent(&name, &json!({ "kpis": kpis }), &agent)?, pretty)
        }
        "apply" => {
            let source = need(&pos, 1, "update JSON (or - to read stdin)")?;
            let text = if source == "-" {
                let mut text = String::new();
                std::io::Read::read_to_string(&mut std::io::stdin(), &mut text)
                    .map_err(|e| format!("Could not read stdin: {e}"))?;
                text
            } else {
                source
            };
            let update: Value = parsed(text.trim_start_matches('\u{feff}').to_string(), "update")?;
            emit(cockpit::apply_as_agent(&project()?, &update, &agent)?, pretty)
        }
        "report" => {
            let source = need(&pos, 0, "report file (or - to read stdin, or --clear)")?;
            let html = if source == "-" {
                let mut text = String::new();
                std::io::Read::read_to_string(&mut std::io::stdin(), &mut text)
                    .map_err(|e| format!("Could not read stdin: {e}"))?;
                text
            } else {
                std::fs::read_to_string(&source).map_err(|e| format!("Could not read {source}: {e}"))?
            };
            let report = cockpit::set_report(&html, flag(&named, "title").unwrap_or(""), &agent)?;
            emit(json!({ "shown": true, "title": report.title, "bytes": report.html.len() }), pretty)
        }
        "report-clear" => emit(json!({ "cleared": cockpit::clear_report()? }), pretty),
        "clear" => {
            let name = project()?;
            emit(json!({ "cleared": cockpit::clear_as_agent(&name)?, "project": name }), pretty)
        }
        other => Err(format!("Unknown cockpit action: {other}. Run `wint help cockpit`.")),
    }
}

fn emit<T: Serialize>(value: T, pretty: bool) -> Result<(), String> {
    let text = if pretty {
        serde_json::to_string_pretty(&value)
    } else {
        serde_json::to_string(&value)
    }
    .map_err(|e| e.to_string())?;
    println!("{text}");
    Ok(())
}

fn run(mut args: Vec<String>) -> Result<(), String> {
    let pretty = args.iter().any(|a| a == "--pretty");
    args.retain(|a| a != "--pretty");
    let command = args.first().map(String::as_str).unwrap_or("help");
    match command {
        "help" | "-h" | "--help" => {
            if args.get(1).map(String::as_str) == Some("cockpit") {
                print!("{COCKPIT_HELP}");
            } else {
                print!("{HELP}");
            }
            Ok(())
        }
        "cockpit" => cockpit(&args, pretty),
        "mcp" => wint_lib::cockpit_mcp::serve(),
        "connect" => match need(&args, 1, "what to connect (claude)")?.as_str() {
            "claude" => {
                let me = std::env::current_exe().map_err(|e| e.to_string())?;
                let state = wint_lib::cockpit::connect_claude(&me)?;
                eprintln!("Connected. Quit Claude Desktop completely (tray icon → Quit) and open it again.");
                emit(state, pretty)
            }
            other => Err(format!("Cannot connect {other}. Only `wint connect claude` exists.")),
        },
        "version" | "-V" | "--version" => {
            println!("{}", env!("CARGO_PKG_VERSION"));
            Ok(())
        }
        "root" => emit(json!({ "root": wint_lib::default_root_sync() }), pretty),
        "scan" => {
            let root = args
                .get(1)
                .cloned()
                .unwrap_or_else(wint_lib::default_root_sync);
            emit(wint_lib::scan_root(root), pretty)
        }
        "git" => match need(&args, 1, "git action")?.as_str() {
            "status" => {
                let path = need(&args, 2, "path")?;
                let info = wint_lib::git::read(Path::new(&path))
                    .ok_or("Not a Git repository or Git is unavailable.")?;
                emit(info, pretty)
            }
            "diff" => {
                let diff = wint_lib::git_diff_sync(need(&args, 2, "path")?)?;
                if pretty {
                    emit(diff, true)
                } else {
                    print!("{}", diff.text);
                    Ok(())
                }
            }
            "pull" => emit(
                wint_lib::git_pull_sync(
                    need(&args, 2, "path")?,
                    args.get(3).cloned().unwrap_or_default(),
                )?,
                pretty,
            ),
            other => Err(format!("Unknown git action: {other}")),
        },
        "todo" => match need(&args, 1, "todo action")?.as_str() {
            "scan" => emit(
                wint_lib::todo::scan(Path::new(&need(&args, 2, "path")?)),
                pretty,
            ),
            "excerpt" => emit(
                wint_lib::todo::excerpt(
                    Path::new(&need(&args, 2, "path")?),
                    &need(&args, 3, "file")?,
                    number(need(&args, 4, "line")?, "line")?,
                )?,
                pretty,
            ),
            other => Err(format!("Unknown todo action: {other}")),
        },
        "open" => {
            let path = need(&args, 1, "path")?;
            let target = need(&args, 2, "target")?;
            if target == "terminal" && std::env::var_os("WINT_TERM_ID").is_some() {
                // When this CLI is run from a WinT terminal, keep the new
                // terminal in WinT as another tab beside the caller. Outside
                // WinT, open_in_sync retains the native cmd-window behavior.
                forward_to_wint([
                    "new-tab".to_string(),
                    "--startingDirectory".to_string(),
                    path,
                ])?;
            } else {
                wint_lib::open_in_sync(path, target, None)?;
            }
            emit(json!({"ok": true}), pretty)
        }
        "ports" => match need(&args, 1, "ports action")?.as_str() {
            "list" => emit(wint_lib::procs::port_list(), pretty),
            "sample" => emit(
                wint_lib::procs::sample(
                    args[2..]
                        .iter()
                        .map(|v| number(v.clone(), "PID"))
                        .collect::<Result<Vec<u32>, _>>()?,
                ),
                pretty,
            ),
            "kill" => {
                let pid = number(need(&args, 2, "PID")?, "PID")?;
                let exe = need(&args, 3, "executable path")?;
                let process = need(&args, 4, "process name")?;
                if args.iter().any(|a| a == "--tree") {
                    wint_lib::procs::kill_tree(pid, &exe, &process)?
                } else {
                    wint_lib::procs::kill(pid, &exe, &process)?
                }
                emit(json!({"ok": true, "pid": pid}), pretty)
            }
            other => Err(format!("Unknown ports action: {other}")),
        },
        "disk" => match need(&args, 1, "disk action")?.as_str() {
            "drives" => emit(wint_lib::disk_space::drives()?, pretty),
            "scan" => emit(wint_lib::disk_space::scan(need(&args, 2, "path")?)?, pretty),
            other => Err(format!("Unknown disk action: {other}")),
        },
        "dns" => match need(&args, 1, "DNS action")?.as_str() {
            "lookup" => emit(
                wint_lib::dns::lookup(
                    &need(&args, 2, "name")?,
                    args.get(3).map(String::as_str).unwrap_or(""),
                    args.get(4..).unwrap_or(&[]),
                ),
                pretty,
            ),
            "compare" => emit(
                wint_lib::dns::compare(
                    &need(&args, 2, "name")?,
                    args.get(3).map(String::as_str).unwrap_or("A"),
                ),
                pretty,
            ),
            "reverse" => emit(wint_lib::dns::reverse(&need(&args, 2, "address")?), pretty),
            "flush" => emit(json!({"result": wint_lib::dns::flush_cache()}), pretty),
            "hosts" => emit(
                json!({"file": wint_lib::dns::hosts_read(), "backups": wint_lib::dns::backups()}),
                pretty,
            ),
            "hosts-write" => emit(
                wint_lib::dns::hosts_write(parsed(need(&args, 2, "request")?, "request")?),
                pretty,
            ),
            other => Err(format!("Unknown DNS action: {other}")),
        },
        "system" => match need(&args, 1, "system action")?.as_str() {
            "report" => emit(wint_lib::windows_tools::system_report()?, pretty),
            "active-window" => emit(wint_lib::windows_tools::active_window()?, pretty),
            "keep-awake" => {
                let on = need(&args, 2, "on or off")? == "on";
                emit(
                    wint_lib::windows_tools::keep_awake_set(
                        on,
                        on && args.iter().any(|a| a == "--display"),
                        on && args.iter().any(|a| a == "--away"),
                        0,
                        false,
                        120,
                        String::new(),
                    )?,
                    pretty,
                )
            }
            other => Err(format!("Unknown system action: {other}")),
        },
        "event-log" => emit(
            wint_lib::windows_tools::event_query(parsed(need(&args, 1, "query")?, "query")?)?,
            pretty,
        ),
        "registry" => match need(&args, 1, "registry action")?.as_str() {
            "list" => emit(
                wint_lib::windows_tools::registry_list(&need(&args, 2, "path")?)?,
                pretty,
            ),
            "change" => emit(
                wint_lib::windows_tools::registry_change(parsed(
                    need(&args, 2, "change")?,
                    "change",
                )?),
                pretty,
            ),
            other => Err(format!("Unknown registry action: {other}")),
        },
        "log" if need(&args, 1, "log action")? == "tail" => emit(
            wint_lib::windows_tools::log_tail(
                &need(&args, 2, "path")?,
                number(
                    args.get(3).cloned().unwrap_or_else(|| "200".into()),
                    "lines",
                )?,
            )?,
            pretty,
        ),
        "lock" if need(&args, 1, "lock action")? == "inspect" => emit(
            wint_lib::windows_tools::lock_inspect(&need(&args, 2, "path")?)?,
            pretty,
        ),
        "audio" => match need(&args, 1, "audio action")?.as_str() {
            "list" => emit(wint_lib::windows_tools::audio_devices()?, pretty),
            "default" => emit(
                wint_lib::windows_tools::audio_set_default(&need(&args, 2, "device ID")?),
                pretty,
            ),
            other => Err(format!("Unknown audio action: {other}")),
        },
        "repair" => match need(&args, 1, "repair action")?.as_str() {
            "list" => emit(
                wint_lib::windows_tools::repair_targets(&need(&args, 2, "repair ID")?)?,
                pretty,
            ),
            "run" => {
                let id = need(&args, 2, "repair ID")?;
                emit(
                    if let Some(target) = args.get(3) {
                        wint_lib::windows_tools::repair_target_run(&id, target)
                    } else {
                        wint_lib::windows_tools::repair_run(&id)
                    },
                    pretty,
                )
            }
            other => Err(format!("Unknown repair action: {other}")),
        },
        "net" => match need(&args, 1, "network action")?.as_str() {
            "capability" => emit(wint_lib::network::capability(), pretty),
            "components" => emit(wint_lib::network::components()?, pretty),
            "rate" => emit(wint_lib::network::rate(), pretty),
            "backlog" => emit(
                wint_lib::network::backlog(number(
                    args.get(2).cloned().unwrap_or_else(|| "500".into()),
                    "limit",
                )?),
                pretty,
            ),
            "stop" => emit(json!({"result": wint_lib::network::stop()?}), pretty),
            "clear" => {
                wint_lib::network::clear();
                emit(json!({"ok": true}), pretty)
            }
            "export" => emit(wint_lib::network::export(args.get(2).cloned())?, pretty),
            other => Err(format!("Unknown network action: {other}")),
        },
        // The elevated half of the Speed Test tool's per-app panel. `watch`
        // blocks for as long as it samples and is started hidden through
        // `runas`; `sample` is here so the same numbers can be looked at from
        // a shell without the app.
        "netusage" => match need(&args, 1, "net usage action")?.as_str() {
            "watch" => {
                let minutes = args.get(2).cloned().unwrap_or_else(|| "30".into());
                wint_lib::net_usage::watch(number(minutes, "minutes")?)?;
                emit(json!({"ok": true}), pretty)
            }
            "sample" => emit(wint_lib::net_usage::report(), pretty),
            other => Err(format!("Unknown net usage action: {other}")),
        },
        "github" => match need(&args, 1, "GitHub action")?.as_str() {
            "status" => emit(wint_lib::github::github_status_now(), pretty),
            "api" => {
                let body: Option<Value> =
                    args.get(4).map(|v| parsed(v.clone(), "body")).transpose()?;
                let value = tauri::async_runtime::block_on(wint_lib::github::github_api(
                    need(&args, 2, "method")?,
                    need(&args, 3, "endpoint")?,
                    body,
                ))?;
                emit(value, pretty)
            }
            other => Err(format!("Unknown GitHub action: {other}")),
        },
        "app" => {
            let app = std::env::var_os("WINT_APP")
                .map(std::path::PathBuf::from)
                .unwrap_or(
                    std::env::current_exe()
                        .map_err(|e| e.to_string())?
                        .with_file_name("wint-desktop.exe"),
                );
            if !app.is_file() {
                return Err("The desktop executable was not found. Build WinT before installing the CLI, or set WINT_APP to its absolute path.".into());
            }
            std::process::Command::new(&app)
                .spawn()
                .map_err(|e| format!("Could not launch {}: {e}", app.display()))?;
            Ok(())
        }
        other => Err(format!("Unknown command: {other}. Run `wint help`.")),
    }
}

fn main() {
    if run_as_wt_proxy() {
        return;
    }
    if let Err(error) = run(std::env::args().skip(1).collect()) {
        eprintln!("wint: {error}");
        std::process::exit(2);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn replies_sit_beside_the_queue_under_the_same_process_id() {
        let runtime = Path::new("runtime");
        assert_eq!(reply_folder_name(&runtime.join("requests-18776")), "replies-18776");
        assert_eq!(reply_folder_name(&runtime.join("requests")), "replies");
    }
}
