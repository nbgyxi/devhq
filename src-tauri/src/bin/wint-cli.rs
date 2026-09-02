use serde::Serialize;
use serde_json::{json, Value};
use std::path::Path;

fn run_as_wt_proxy() -> bool {
    let invoked_as_wt = std::env::current_exe().ok()
        .and_then(|path| path.file_stem().map(|name| name.to_string_lossy().into_owned()))
        .is_some_and(|name| name.eq_ignore_ascii_case("wt"));
    if !invoked_as_wt { return false; }
    let term_id = std::env::var_os("WINT_TERM_ID");
    let Some(term_id) = term_id else {
        eprintln!("wt: WinT terminal context is unavailable.");
        std::process::exit(2);
    };
    let Some(local) = std::env::var_os("LOCALAPPDATA") else {
        eprintln!("wt: the local application-data folder is unavailable.");
        std::process::exit(2);
    };
    let queue = std::path::PathBuf::from(local).join("WinT").join("runtime").join("requests");
    if let Err(error) = std::fs::create_dir_all(&queue) {
        eprintln!("wt: could not open WinT's request queue: {error}");
        std::process::exit(2);
    }
    let stamp = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default().as_nanos();
    let name = format!("wt-{}-{stamp}.json", std::process::id());
    let pending = queue.join(format!(".{name}.tmp"));
    let ready = queue.join(&name);
    let mut forwarded = vec!["wt.exe".to_string(), format!("--wint-wt={}", term_id.to_string_lossy())];
    forwarded.extend(std::env::args().skip(1));
    let result = serde_json::to_vec(&forwarded)
        .map_err(|error| error.to_string())
        .and_then(|bytes| std::fs::write(&pending, bytes).map_err(|error| error.to_string()))
        .and_then(|_| std::fs::rename(&pending, &ready).map_err(|error| error.to_string()));
    if let Err(error) = result {
        let _ = std::fs::remove_file(&pending);
        eprintln!("wt: could not send the command to WinT: {error}");
        std::process::exit(2);
    }
    // `wt` holds the prompt until WinT says what happened. The pane opens in
    // another process, so without this the shell gets its prompt straight back
    // and a pane that never started looks exactly like one that did.
    let replies = queue.with_file_name("replies");
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
                if !message.is_empty() { println!("{message}"); }
                std::process::exit(0);
            }
            eprintln!("wt: {}", if message.is_empty() { "WinT could not run this command." } else { message });
            std::process::exit(1);
        }
        if !taken {
            taken = !ready.exists();
            if !taken && std::time::Instant::now() >= taken_by {
                let _ = std::fs::remove_file(&ready);
                eprintln!("wt: WinT did not take this command. Its terminal panel is not listening.");
                std::process::exit(1);
            }
        } else if std::time::Instant::now() >= answer_by {
            // Taken, but no window owned up to it: the terminal this was typed
            // in is no longer one WinT is showing.
            eprintln!("wt: WinT took this command but never reported what happened to it.");
            std::process::exit(1);
        }
        std::thread::sleep(std::time::Duration::from_millis(20));
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

GitHub and app
  github status                       Check gh authentication
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
            print!("{HELP}");
            Ok(())
        }
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
            wint_lib::open_in_sync(need(&args, 1, "path")?, need(&args, 2, "target")?)?;
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
            "scan" => emit(
                wint_lib::disk_space::scan(need(&args, 2, "path")?)?,
                pretty,
            ),
            other => Err(format!("Unknown disk action: {other}")),
        },
        "dns" => match need(&args, 1, "DNS action")?.as_str() {
            "lookup" => emit(
                wint_lib::dns::lookup(
                    &need(&args, 2, "name")?,
                    args.get(3).map(String::as_str).unwrap_or(""),
                    &args.get(4..).unwrap_or(&[]).to_vec(),
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
        "github" => match need(&args, 1, "GitHub action")?.as_str() {
            "status" => emit(wint_lib::github::github_status(), pretty),
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
    if run_as_wt_proxy() { return; }
    if let Err(error) = run(std::env::args().skip(1).collect()) {
        eprintln!("wint: {error}");
        std::process::exit(2);
    }
}
