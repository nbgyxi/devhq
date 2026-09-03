use super::{provider::ToolCall, tools::ToolRegistry};
use serde::Serialize;
use serde_json::{json, Value};
use std::sync::{
    atomic::{AtomicBool, Ordering},
    Mutex, OnceLock,
};
use std::{
    io::{BufRead, BufReader, Read, Write},
    process::{Child, Command, Stdio},
};
use tauri::{AppHandle, Emitter};

static KEYS: OnceLock<Mutex<CloudKeys>> = OnceLock::new();
static TASK: OnceLock<Mutex<Option<CloudTask>>> = OnceLock::new();
static ACTIVE: AtomicBool = AtomicBool::new(false);
static CURSOR: OnceLock<Mutex<Option<CursorTask>>> = OnceLock::new();
struct CursorTask {
    child: Child,
    app: AppHandle,
    request_id: String,
}
struct CloudTask {
    handle: tauri::async_runtime::JoinHandle<()>,
    app: AppHandle,
    request_id: String,
}

#[derive(Default)]
struct CloudKeys {
    anthropic: String,
    openai: String,
    cursor: String,
}
#[derive(Clone, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CloudStatus {
    claude_configured: bool,
    openai_configured: bool,
    cursor_configured: bool,
    credential_storage: String,
}
#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct Chunk {
    request_id: String,
    text: String,
    done: bool,
    error: String,
    kind: String,
    question: String,
    choices: Vec<String>,
}
#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct Step {
    request_id: String,
    id: String,
    name: String,
    status: String,
    detail: String,
}
#[derive(Default)]
struct Turn {
    text: String,
    calls: Vec<ToolCall>,
    output: Vec<Value>,
}

fn keys() -> &'static Mutex<CloudKeys> {
    KEYS.get_or_init(|| Mutex::new(CloudKeys::default()))
}
fn task() -> &'static Mutex<Option<CloudTask>> {
    TASK.get_or_init(|| Mutex::new(None))
}
fn cursor_task() -> &'static Mutex<Option<CursorTask>> {
    CURSOR.get_or_init(|| Mutex::new(None))
}
pub fn status() -> CloudStatus {
    load_persisted();
    let v = keys().lock().unwrap_or_else(|e| e.into_inner());
    CloudStatus {
        claude_configured: !v.anthropic.is_empty(),
        openai_configured: !v.openai.is_empty(),
        cursor_configured: !v.cursor.is_empty(),
        credential_storage: storage_name().into(),
    }
}
pub fn configure(provider: &str, key: String) -> Result<CloudStatus, String> {
    let key = key.trim();
    if key.is_empty() {
        return Err("Enter an API key first.".into());
    }
    persist(provider, key)?;
    let mut v = keys()
        .lock()
        .map_err(|_| "Could not access the API key store.".to_string())?;
    match provider {
        "claude" => v.anthropic = key.into(),
        "openai" => v.openai = key.into(),
        "cursor" => v.cursor = key.into(),
        _ => return Err("Unknown cloud provider.".into()),
    }
    drop(v);
    Ok(status())
}
pub fn remove(provider: &str) -> Result<CloudStatus, String> {
    delete_persisted(provider)?;
    let mut v = keys()
        .lock()
        .map_err(|_| "Could not access the API key store.".to_string())?;
    match provider {
        "claude" => v.anthropic.clear(),
        "openai" => v.openai.clear(),
        "cursor" => v.cursor.clear(),
        _ => return Err("Unknown cloud provider.".into()),
    }
    drop(v);
    Ok(status())
}

#[cfg(windows)]
fn entry(provider: &str) -> Result<keyring::Entry, String> {
    keyring::Entry::new("WinT AI providers", provider)
        .map_err(|e| format!("Could not access Windows Credential Manager: {e}"))
}
#[cfg(windows)]
fn persist(provider: &str, secret: &str) -> Result<(), String> {
    entry(provider)?
        .set_password(secret)
        .map_err(|e| format!("Could not save the API key in Windows Credential Manager: {e}"))
}
#[cfg(windows)]
fn delete_persisted(provider: &str) -> Result<(), String> {
    match entry(provider)?.delete_credential() {
        Ok(()) | Err(keyring::Error::NoEntry) => Ok(()),
        Err(e) => Err(format!(
            "Could not remove the API key from Windows Credential Manager: {e}"
        )),
    }
}
#[cfg(windows)]
fn load_persisted() {
    let mut values = keys().lock().unwrap_or_else(|e| e.into_inner());
    if values.anthropic.is_empty() {
        values.anthropic = entry("claude")
            .and_then(|e| e.get_password().map_err(|e| e.to_string()))
            .unwrap_or_default();
    }
    if values.openai.is_empty() {
        values.openai = entry("openai")
            .and_then(|e| e.get_password().map_err(|e| e.to_string()))
            .unwrap_or_default();
    }
    if values.cursor.is_empty() {
        values.cursor = entry("cursor")
            .and_then(|e| e.get_password().map_err(|e| e.to_string()))
            .unwrap_or_default();
    }
}
#[cfg(windows)]
fn storage_name() -> &'static str {
    "Windows Credential Manager"
}

#[cfg(not(windows))]
fn persist(_: &str, _: &str) -> Result<(), String> {
    Err("Persistent API-key storage is only available on Windows.".into())
}
#[cfg(not(windows))]
fn delete_persisted(_: &str) -> Result<(), String> {
    Ok(())
}
#[cfg(not(windows))]
fn load_persisted() {}
#[cfg(not(windows))]
fn storage_name() -> &'static str {
    "Memory only"
}

fn definitions(registry: &ToolRegistry, anthropic: bool) -> Vec<Value> {
    registry.definitions().into_iter().map(|t|if anthropic{json!({"name":t.name,"description":t.description,"input_schema":t.parameters})}else{json!({"type":"function","name":t.name,"description":t.description,"parameters":t.parameters})}).collect()
}
fn emit_text(app: &AppHandle, id: &str, text: &str) {
    if !text.is_empty() {
        let _ = app.emit(
            "assistant:chunk",
            Chunk {
                request_id: id.into(),
                text: text.into(),
                done: false,
                error: String::new(),
                kind: "text".into(),
                question: String::new(),
                choices: vec![],
            },
        );
    }
}
fn provider_error(code: reqwest::StatusCode, body: &str) -> String {
    let message = serde_json::from_str::<Value>(body)
        .ok()
        .and_then(|v| {
            v.pointer("/error/message")
                .and_then(Value::as_str)
                .map(str::to_owned)
        })
        .unwrap_or_else(|| body.chars().take(300).collect());
    format!("Provider request failed ({code}): {message}")
}

async fn events(
    mut response: reqwest::Response,
    mut handle: impl FnMut(Value) -> Result<(), String>,
) -> Result<(), String> {
    let code = response.status();
    if !code.is_success() {
        let body = response.text().await.unwrap_or_default();
        return Err(provider_error(code, &body));
    }
    let mut buffer = String::new();
    while let Some(bytes) = response
        .chunk()
        .await
        .map_err(|e| format!("Cloud stream failed: {e}"))?
    {
        buffer.push_str(&String::from_utf8_lossy(&bytes));
        loop {
            let boundary = match (buffer.find("\n\n"), buffer.find("\r\n\r\n")) {
                (Some(a), Some(b)) => Some((a.min(b), if a <= b { 2 } else { 4 })),
                (Some(a), None) => Some((a, 2)),
                (None, Some(b)) => Some((b, 4)),
                _ => None,
            };
            let Some((end, len)) = boundary else { break };
            let event: String = buffer.drain(..end + len).collect();
            for line in event.lines().filter_map(|l| l.strip_prefix("data: ")) {
                if line != "[DONE]" {
                    handle(
                        serde_json::from_str(line)
                            .map_err(|e| format!("Invalid cloud stream event: {e}"))?,
                    )?;
                }
            }
        }
    }
    Ok(())
}

async fn claude_turn(
    client: &reqwest::Client,
    model: &str,
    key: &str,
    messages: &[Value],
    tools: &[Value],
    app: &AppHandle,
    id: &str,
) -> Result<Turn, String> {
    let response=client.post("https://api.anthropic.com/v1/messages").header("x-api-key",key).header("anthropic-version","2023-06-01").json(&json!({"model":model,"max_tokens":4096,"messages":messages,"tools":tools,"stream":true})).send().await.map_err(|e|format!("Claude request failed: {e}"))?;
    let mut turn = Turn::default();
    let mut blocks: Vec<Value> = vec![];
    let mut args: Vec<String> = vec![];
    events(response, |event| {
        match event["type"].as_str().unwrap_or("") {
            "content_block_start" => {
                let i = event["index"].as_u64().unwrap_or(0) as usize;
                while blocks.len() <= i {
                    blocks.push(Value::Null);
                    args.push(String::new())
                }
                blocks[i] = event["content_block"].clone();
            }
            "content_block_delta" => {
                let i = event["index"].as_u64().unwrap_or(0) as usize;
                if let Some(text) = event.pointer("/delta/text").and_then(Value::as_str) {
                    turn.text.push_str(text);
                    if let Some(value) = blocks.get_mut(i).and_then(|b| b.get_mut("text")) {
                        if let Some(existing) = value.as_str() {
                            *value = Value::String(format!("{existing}{text}"))
                        }
                    }
                    emit_text(app, id, text)
                }
                if let Some(part) = event.pointer("/delta/partial_json").and_then(Value::as_str) {
                    if let Some(v) = args.get_mut(i) {
                        v.push_str(part)
                    }
                }
            }
            "error" => {
                return Err(event
                    .pointer("/error/message")
                    .and_then(Value::as_str)
                    .unwrap_or("Claude stream failed.")
                    .into())
            }
            _ => {}
        }
        Ok(())
    })
    .await?;
    for (i, block) in blocks.iter_mut().enumerate() {
        if block["type"] == "tool_use" {
            let arguments: Value =
                serde_json::from_str(args.get(i).map(String::as_str).unwrap_or("{}"))
                    .map_err(|e| format!("Claude returned invalid tool arguments: {e}"))?;
            block["input"] = arguments.clone();
            turn.calls.push(ToolCall {
                id: block["id"].as_str().unwrap_or("").into(),
                name: block["name"].as_str().unwrap_or("").into(),
                arguments,
            });
        }
    }
    turn.output = blocks;
    Ok(turn)
}

async fn openai_turn(
    client: &reqwest::Client,
    model: &str,
    key: &str,
    input: &[Value],
    tools: &[Value],
    app: &AppHandle,
    id: &str,
) -> Result<Turn, String> {
    let response=client.post("https://api.openai.com/v1/responses").bearer_auth(key).json(&json!({"model":model,"input":input,"tools":tools,"stream":true,"store":false,"max_output_tokens":4096,"parallel_tool_calls":false})).send().await.map_err(|e|format!("OpenAI request failed: {e}"))?;
    let mut turn = Turn::default();
    events(response, |event| {
        match event["type"].as_str().unwrap_or("") {
            "response.output_text.delta" => {
                if let Some(text) = event["delta"].as_str() {
                    turn.text.push_str(text);
                    emit_text(app, id, text)
                }
            }
            "response.output_item.done" => turn.output.push(event["item"].clone()),
            "response.failed" | "error" => {
                return Err(event
                    .pointer("/response/error/message")
                    .or_else(|| event.pointer("/error/message"))
                    .and_then(Value::as_str)
                    .unwrap_or("OpenAI stream failed.")
                    .into())
            }
            _ => {}
        }
        Ok(())
    })
    .await?;
    for item in &turn.output {
        if item["type"] == "function_call" {
            turn.calls.push(ToolCall {
                id: item["call_id"].as_str().unwrap_or("").into(),
                name: item["name"].as_str().unwrap_or("").into(),
                arguments: serde_json::from_str(item["arguments"].as_str().unwrap_or("{}"))
                    .map_err(|e| format!("OpenAI returned invalid tool arguments: {e}"))?,
            });
        }
    }
    Ok(turn)
}

fn execute_tools(
    app: &AppHandle,
    id: &str,
    registry: &ToolRegistry,
    calls: &[ToolCall],
) -> Vec<(ToolCall, Result<Value, String>)> {
    calls
        .iter()
        .cloned()
        .map(|call| {
            let sid = format!("tool-{}", call.id);
            let _ = app.emit(
                "assistant:step",
                Step {
                    request_id: id.into(),
                    id: sid.clone(),
                    name: call.name.clone(),
                    status: "running".into(),
                    detail: call.arguments.to_string(),
                },
            );
            let result = registry.execute(&call);
            let _ = app.emit(
                "assistant:step",
                Step {
                    request_id: id.into(),
                    id: sid,
                    name: call.name.clone(),
                    status: if result.is_ok() { "done" } else { "error" }.into(),
                    detail: result
                        .as_ref()
                        .map(|v| format!("Returned {} characters", v.to_string().len()))
                        .unwrap_or_else(|e| e.clone()),
                },
            );
            (call, result)
        })
        .collect()
}

async fn run(
    app: AppHandle,
    id: String,
    model: String,
    prompt: String,
    key: String,
    roots: Vec<String>,
    tool_call_cap: usize,
) -> Result<(), String> {
    let anthropic = model.starts_with("claude:");
    let model = model
        .split_once(':')
        .map(|(_, v)| v)
        .ok_or("Unknown cloud model.")?;
    let areas = [
        "project",
        "ports",
        "dns",
        "hosts",
        "network",
        "path-ping",
        "disk-space",
        "windows:events",
        "windows:registry",
        "windows:system",
        "windows:log-tail",
        "windows:lock-inspector",
        "windows:repair-swap",
        "windows:time-tracker",
    ]
    .map(str::to_string);
    let registry = ToolRegistry::routed(Some(app.clone()), roots, &areas);
    let tools = definitions(&registry, anthropic);
    let client = reqwest::Client::builder()
        .user_agent("WinT/0.43")
        .build()
        .map_err(|e| e.to_string())?;
    let mut messages = vec![json!({"role":"user","content":prompt})];
    let mut input = vec![json!({"role":"user","content":prompt})];
    let mut call_count = 0usize;
    for n in 0..=tool_call_cap {
        let sid = format!("cloud-{n}");
        let name = if anthropic {
            "Call Claude"
        } else {
            "Call OpenAI"
        };
        let _ = app.emit(
            "assistant:step",
            Step {
                request_id: id.clone(),
                id: sid.clone(),
                name: name.into(),
                status: "running".into(),
                detail: "Streaming response".into(),
            },
        );
        let turn = if anthropic {
            claude_turn(&client, model, &key, &messages, &tools, &app, &id).await?
        } else {
            openai_turn(&client, model, &key, &input, &tools, &app, &id).await?
        };
        let _ = app.emit(
            "assistant:step",
            Step {
                request_id: id.clone(),
                id: sid,
                name: name.into(),
                status: "done".into(),
                detail: if turn.calls.is_empty() {
                    format!("{} characters streamed", turn.text.len())
                } else {
                    format!("{} tool call(s) requested", turn.calls.len())
                },
            },
        );
        if turn.calls.is_empty() {
            return Ok(());
        }
        if call_count + turn.calls.len() > tool_call_cap {
            return Err(format!(
                "The cloud assistant reached the {tool_call_cap}-call tool limit."
            ));
        }
        call_count += turn.calls.len();
        let results = execute_tools(&app, &id, &registry, &turn.calls);
        if anthropic {
            messages.push(json!({"role":"assistant","content":turn.output}));
            messages.push(json!({"role":"user","content":results.into_iter().map(|(call,result)|json!({"type":"tool_result","tool_use_id":call.id,"content":result.as_ref().map(Value::to_string).unwrap_or_else(|e|e.clone()),"is_error":result.is_err()})).collect::<Vec<_>>()}));
        } else {
            input.extend(turn.output);
            input.extend(results.into_iter().map(|(call,result)|json!({"type":"function_call_output","call_id":call.id,"output":result.as_ref().map(Value::to_string).unwrap_or_else(|e|e.clone())})));
        }
    }
    Err(format!(
        "The cloud assistant reached the {tool_call_cap}-call tool limit."
    ))
}

fn cursor_tool_label(value: &Value) -> Option<(String, String)> {
    let (raw_name, call) = value
        .as_object()?
        .iter()
        .find(|(name, call)| name.ends_with("ToolCall") && call.is_object())?;
    let stem = raw_name.strip_suffix("ToolCall").unwrap_or(raw_name);
    let name = match stem {
        "read" => "Read file".into(),
        "write" => "Write file".into(),
        "delete" => "Delete file".into(),
        "shell" | "terminal" => "Run command".into(),
        "grep" | "search" => "Search files".into(),
        "list" => "List files".into(),
        "webSearch" => "Search the web".into(),
        "mcp" => "Use MCP tool".into(),
        other => {
            let mut label = String::new();
            for character in other.chars() {
                if character.is_uppercase() && !label.is_empty() {
                    label.push(' ');
                }
                label.push(character.to_ascii_lowercase());
            }
            let mut characters = label.chars();
            characters
                .next()
                .map(|first| first.to_ascii_uppercase().to_string() + characters.as_str())
                .unwrap_or_else(|| "Thinking".into())
        }
    };
    let args = call.get("args").and_then(Value::as_object);
    let detail = args
        .and_then(|args| {
            ["path", "command", "query", "pattern", "url"]
                .iter()
                .find_map(|key| args.get(*key).and_then(Value::as_str))
        })
        .unwrap_or("")
        .to_string();
    Some((name, detail))
}

fn cursor_chat(
    app: AppHandle,
    id: String,
    prompt: String,
    key: String,
    roots: Vec<String>,
    tool_call_cap: usize,
) -> Result<(), String> {
    let (mut command, cursor_command) = cursor_agent_command();
    command
        .args(["--print", "--output-format", "stream-json"])
        .env("CURSOR_API_KEY", key)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    if let Some(root) = roots
        .first()
        .filter(|root| std::path::Path::new(root).is_dir())
    {
        command.current_dir(root);
    }
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        command.creation_flags(0x0800_0000);
    }
    let mut child = command.spawn().map_err(|e| {
        ACTIVE.store(false, Ordering::SeqCst);
        format!("Could not start Cursor Agent using {cursor_command}: {e}")
    })?;
    if let Some(mut stdin) = child.stdin.take() {
        stdin.write_all(prompt.as_bytes()).map_err(|e| {
            let _ = child.kill();
            ACTIVE.store(false, Ordering::SeqCst);
            format!("Could not send the prompt to Cursor Agent: {e}")
        })?;
    }
    let stdout = child
        .stdout
        .take()
        .ok_or_else(|| "Could not read Cursor Agent output.".to_string())?;
    let stderr = child.stderr.take();
    *cursor_task()
        .lock()
        .map_err(|_| "Could not track the Cursor Agent process.".to_string())? = Some(CursorTask {
        child,
        app: app.clone(),
        request_id: id.clone(),
    });
    std::thread::spawn(move || {
        let mut calls = 0usize;
        let mut final_error = String::new();
        for line in BufReader::new(stdout).lines() {
            let Ok(line) = line else { break };
            let Ok(event) = serde_json::from_str::<Value>(&line) else {
                continue;
            };
            match event["type"].as_str().unwrap_or("") {
                "assistant" => {
                    if let Some(content) =
                        event.pointer("/message/content").and_then(Value::as_array)
                    {
                        for block in content {
                            if block["type"] == "text" {
                                emit_text(&app, &id, block["text"].as_str().unwrap_or(""));
                            }
                        }
                    }
                }
                "tool_call" => {
                    let call_id = event["call_id"].as_str().unwrap_or("cursor-tool");
                    let subtype = event["subtype"].as_str().unwrap_or("");
                    let (name, detail) = cursor_tool_label(&event["tool_call"])
                        .unwrap_or_else(|| ("Thinking".into(), "Cursor is working".into()));
                    if subtype == "started" {
                        calls += 1;
                        if calls > tool_call_cap {
                            final_error =
                                format!("Cursor reached WinT's {tool_call_cap}-call tool limit.");
                            if let Ok(mut active) = cursor_task().lock() {
                                if let Some(run) = active.as_mut() {
                                    let _ = run.child.kill();
                                }
                            }
                            break;
                        }
                    }
                    let _ = app.emit(
                        "assistant:step",
                        Step {
                            request_id: id.clone(),
                            id: format!("cursor-{call_id}"),
                            name,
                            status: if subtype == "started" {
                                "running"
                            } else {
                                "done"
                            }
                            .into(),
                            detail,
                        },
                    );
                }
                "result" if event["is_error"].as_bool().unwrap_or(false) => {
                    final_error = event["result"]
                        .as_str()
                        .unwrap_or("Cursor Agent failed.")
                        .into()
                }
                _ => {}
            }
        }
        let status = cursor_task()
            .lock()
            .ok()
            .and_then(|mut active| active.take())
            .and_then(|mut run| run.child.wait().ok());
        if final_error.is_empty() && status.is_some_and(|status| !status.success()) {
            let mut text = String::new();
            if let Some(mut stderr) = stderr {
                let _ = stderr.read_to_string(&mut text);
            }
            final_error = if text.trim().is_empty() {
                "Cursor Agent stopped unexpectedly.".into()
            } else {
                text.trim().into()
            };
        }
        let _ = app.emit(
            "assistant:chunk",
            Chunk {
                request_id: id,
                text: String::new(),
                done: true,
                error: final_error,
                kind: "text".into(),
                question: String::new(),
                choices: vec![],
            },
        );
        ACTIVE.store(false, Ordering::SeqCst);
    });
    Ok(())
}

#[cfg(windows)]
fn cursor_agent_command() -> (Command, String) {
    crate::cursor::agent_command()
}

#[cfg(not(windows))]
fn cursor_agent_command() -> (Command, String) {
    (Command::new("agent"), "`agent`".into())
}

pub fn chat(
    app: AppHandle,
    id: String,
    model: String,
    prompt: String,
    roots: Vec<String>,
    tool_call_cap: usize,
) -> Result<(), String> {
    let tool_call_cap = tool_call_cap.clamp(1, 100);
    let provider = if model.starts_with("claude:") {
        "claude"
    } else if model.starts_with("cursor:") {
        "cursor"
    } else {
        "openai"
    };
    let key = {
        let v = keys()
            .lock()
            .map_err(|_| "Could not access the API key store.".to_string())?;
        match provider {
            "claude" => v.anthropic.clone(),
            "cursor" => v.cursor.clone(),
            _ => v.openai.clone(),
        }
    };
    if key.is_empty() {
        return Err(format!(
            "Configure the {provider} API key before using this model."
        ));
    }
    if ACTIVE.swap(true, Ordering::SeqCst) {
        return Err("The assistant is already answering.".into());
    }
    if provider == "cursor" {
        return cursor_chat(app, id, prompt, key, roots, tool_call_cap);
    }
    let mut active = task().lock().map_err(|_| {
        ACTIVE.store(false, Ordering::SeqCst);
        "Could not access the cloud task.".to_string()
    })?;
    let finish_app = app.clone();
    let finish_id = id.clone();
    let cancel_app = app.clone();
    let cancel_id = id.clone();
    let handle = tauri::async_runtime::spawn(async move {
        let error = run(app, id, model, prompt, key, roots, tool_call_cap)
            .await
            .err()
            .unwrap_or_default();
        let _ = finish_app.emit(
            "assistant:chunk",
            Chunk {
                request_id: finish_id,
                text: String::new(),
                done: true,
                error,
                kind: "text".into(),
                question: String::new(),
                choices: vec![],
            },
        );
        ACTIVE.store(false, Ordering::SeqCst);
    });
    *active = Some(CloudTask {
        handle,
        app: cancel_app,
        request_id: cancel_id,
    });
    Ok(())
}
pub fn cancel() {
    ACTIVE.store(false, Ordering::SeqCst);
    if let Ok(mut active) = cursor_task().lock() {
        if let Some(mut active) = active.take() {
            let _ = active.child.kill();
            let _ = active.app.emit(
                "assistant:chunk",
                Chunk {
                    request_id: active.request_id,
                    text: String::new(),
                    done: true,
                    error: String::new(),
                    kind: "text".into(),
                    question: String::new(),
                    choices: vec![],
                },
            );
        }
    }
    if let Ok(mut active) = task().lock() {
        if let Some(active) = active.take() {
            active.handle.abort();
            let _ = active.app.emit(
                "assistant:chunk",
                Chunk {
                    request_id: active.request_id,
                    text: String::new(),
                    done: true,
                    error: String::new(),
                    kind: "text".into(),
                    question: String::new(),
                    choices: vec![],
                },
            );
        }
    }
}
