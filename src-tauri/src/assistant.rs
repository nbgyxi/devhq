use crate::ai::{provider::ToolCall, tools::ToolRegistry};
use serde::{Deserialize, Serialize};
use std::{
    fs,
    io::{BufReader, Read},
    path::{Path, PathBuf},
    process::{Child, Command, Stdio},
    sync::{
        atomic::{AtomicBool, Ordering},
        Mutex, OnceLock,
    },
};
use tauri::{AppHandle, Emitter};

static CHAT: OnceLock<Mutex<Option<Child>>> = OnceLock::new();
static AGENT_ACTIVE: AtomicBool = AtomicBool::new(false);
static CHAT_CANCELLED: AtomicBool = AtomicBool::new(false);
static CANCEL: AtomicBool = AtomicBool::new(false);
static DOWNLOADING: AtomicBool = AtomicBool::new(false);
const RUNTIME_URL:&str="https://github.com/ggml-org/llama.cpp/releases/download/b10516/llama-b10516-bin-win-cpu-x64.zip";
const RUNTIME_HASH: &str = "fbbbc55e0eb2e1b07f9dcb9488616c98ed47d9003b90e15e7c8c7812c4307cd3";

#[derive(Clone, Copy)]
struct Manifest {
    id: &'static str,
    name: &'static str,
    file: &'static str,
    url: &'static str,
    size: u64,
    hash: &'static str,
    memory: &'static str,
    tools: bool,
}
const CATALOG:&[Manifest]=&[
 Manifest{id:"qwen2.5-0.5b-q4",name:"Qwen 2.5 0.5B",file:"qwen2.5-0.5b-q4.gguf",url:"https://huggingface.co/bartowski/Qwen2.5-0.5B-Instruct-GGUF/resolve/main/Qwen2.5-0.5B-Instruct-Q4_K_M.gguf?download=true",size:397808192,hash:"6eb923e7d26e9cea28811e1a8e852009b21242fb157b26149d3b188f3a8c8653",memory:"2 GB",tools:false},
 Manifest{id:"qwen2.5-1.5b-q4",name:"Qwen 2.5 1.5B",file:"qwen2.5-1.5b-q4.gguf",url:"https://huggingface.co/bartowski/Qwen2.5-1.5B-Instruct-GGUF/resolve/main/Qwen2.5-1.5B-Instruct-Q4_K_M.gguf?download=true",size:986048768,hash:"1adf0b11065d8ad2e8123ea110d1ec956dab4ab038eab665614adba04b6c3370",memory:"4 GB",tools:true},
 Manifest{id:"qwen2.5-3b-q4",name:"Qwen 2.5 3B",file:"qwen2.5-3b-q4.gguf",url:"https://huggingface.co/bartowski/Qwen2.5-3B-Instruct-GGUF/resolve/main/Qwen2.5-3B-Instruct-Q4_K_M.gguf?download=true",size:1929903264,hash:"9c9f56a391a3abbd5b89d0245bf6106081bcc3173119d4229235dd9d23253f94",memory:"6 GB",tools:true},
 Manifest{id:"qwen2.5-coder-7b-q4",name:"Qwen2.5-Coder 7B",file:"qwen2.5-coder-7b-q4.gguf",url:"https://huggingface.co/Qwen/Qwen2.5-Coder-7B-Instruct-GGUF/resolve/main/qwen2.5-coder-7b-instruct-q4_k_m.gguf?download=true",size:4683073536,hash:"509287f78cb4d4cf6b3843734733b914b2c158e43e22a7f4bf5e963800894d3c",memory:"8 GB",tools:true},
 Manifest{id:"qwen3-coder-30b-a3b-q4",name:"Qwen3-Coder 30B-A3B",file:"qwen3-coder-30b-a3b-q4.gguf",url:"https://huggingface.co/unsloth/Qwen3-Coder-30B-A3B-Instruct-GGUF/resolve/main/Qwen3-Coder-30B-A3B-Instruct-Q4_K_M.gguf?download=true",size:18556689568,hash:"fadc3e5f8d42bf7e894a785b05082e47daee4df26680389817e2093056f088ad",memory:"24 GB",tools:true},
];

#[derive(Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Status {
    available: bool,
    version: String,
    models: Vec<Model>,
    catalog: Vec<CatalogItem>,
}
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Model {
    name: String,
    display_name: String,
    size: String,
    modified: String,
}
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct CatalogItem {
    id: String,
    display_name: String,
    size: u64,
    license: String,
    context_length: usize,
    tool_calling_support: bool,
    recommended_memory: String,
    installed: bool,
    /// Bytes an interrupted download left on disk. The row says so, because a
    /// paused 12 GB model that looks untouched is one the user starts over.
    partial: u64,
}
#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct Progress {
    model: String,
    detail: String,
    done: bool,
    error: String,
    downloaded: u64,
    total: u64,
    phase: String,
    /// Throughput and time left, already worded - "12.4 MB/s · 3m 07s left".
    /// Empty while there is nothing measured to say.
    rate: String,
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
#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct StepChunk {
    request_id: String,
    id: String,
    text: String,
}
#[derive(Deserialize)]
struct Question {
    question: String,
    #[serde(default)]
    choices: Vec<String>,
}
#[derive(Deserialize)]
struct ThinkingPlan {
    steps: Vec<String>,
}
#[derive(Clone, Deserialize, Serialize)]
pub struct RouteOption {
    id: String,
    name: String,
    description: String,
}
#[derive(Deserialize)]
struct IntentRoute {
    intents: Vec<String>,
}

fn dirs(root: &Path) -> (PathBuf, PathBuf) {
    (root.join("ai/runtime/b10516"), root.join("ai/models"))
}
fn item(id: &str) -> Result<Manifest, String> {
    CATALOG
        .iter()
        .copied()
        .find(|x| x.id == id)
        .ok_or_else(|| "That model is not in WinT's verified catalog.".into())
}
fn size(n: u64) -> String {
    if n >= 1_000_000_000 {
        format!("{:.1} GB", n as f64 / 1e9)
    } else {
        format!("{} MB", n / 1_000_000)
    }
}
/// Megabytes with digit grouping, for the readout that moves while a download
/// runs. `size` rounds a multi-gigabyte model to a tenth of a gigabyte, and
/// that figure stands still for a hundred megabytes at a time - long enough to
/// look stuck on exactly the downloads that take longest.
fn mb(n: u64) -> String {
    let digits = (n / 1_000_000).to_string();
    let mut out = String::new();
    for (i, c) in digits.chars().enumerate() {
        if i > 0 && (digits.len() - i) % 3 == 0 {
            out.push(',')
        }
        out.push(c)
    }
    format!("{out} MB")
}
fn seconds(n: u64) -> String {
    match n {
        0..=59 => format!("{n}s"),
        60..=3599 => format!("{}m {:02}s", n / 60, n % 60),
        _ => format!("{}h {:02}m", n / 3600, n % 3600 / 60),
    }
}
pub fn status(root: PathBuf) -> Status {
    let (r, m) = dirs(&root);
    let models = CATALOG
        .iter()
        .filter_map(|x| {
            let p = m.join(x.file);
            p.metadata()
                .ok()
                .filter(|v| v.len() == x.size)
                .map(|v| Model {
                    name: x.id.into(),
                    display_name: x.name.into(),
                    size: size(v.len()),
                    modified: "Installed locally".into(),
                })
        })
        .collect();
    Status {
        available: r.join("llama-cli.exe").is_file(),
        version: "llama.cpp b10516".into(),
        models,
        catalog: CATALOG
            .iter()
            .map(|x| CatalogItem {
                id: x.id.into(),
                display_name: x.name.into(),
                size: x.size,
                license: "Apache-2.0".into(),
                context_length: 32768,
                tool_calling_support: x.tools,
                recommended_memory: x.memory.into(),
                installed: m.join(x.file).is_file(),
                partial: crate::download::partial(&m.join(x.file), x.size),
            })
            .collect(),
    }
}
#[allow(clippy::too_many_arguments)]
fn progress(
    app: &AppHandle,
    model: &str,
    phase: &str,
    detail: String,
    rate: String,
    n: u64,
    total: u64,
    done: bool,
    error: String,
) {
    let _ = app.emit(
        "assistant:model-progress",
        Progress {
            model: model.into(),
            detail,
            done,
            error,
            downloaded: n,
            total,
            phase: phase.into(),
            rate,
        },
    );
}

fn download(
    app: &AppHandle,
    model: &str,
    phase: &str,
    url: &str,
    expected: u64,
    hash: &str,
    target: &Path,
) -> Result<(), String> {
    let mut report = |t: &crate::download::Tick| {
        let pct = if t.total > 0 {
            t.done as f64 / t.total as f64 * 100.0
        } else {
            0.0
        };
        let detail = if t.resumed > 0 {
            format!(
                "{} of {} · {pct:.1}% · resumed at {}",
                mb(t.done),
                mb(t.total),
                mb(t.resumed)
            )
        } else {
            format!("{} of {} · {pct:.1}%", mb(t.done), mb(t.total))
        };
        // A rate needs a measured interval before it means anything, and the
        // first report happens before any bytes have moved.
        let rate = if t.speed > 1.0 {
            match t.eta {
                Some(eta) => format!("{:.1} MB/s · {} left", t.speed / 1e6, seconds(eta)),
                None => format!("{:.1} MB/s", t.speed / 1e6),
            }
        } else {
            "Measuring speed…".into()
        };
        progress(
            app,
            model,
            phase,
            detail,
            rate,
            t.done,
            t.total,
            false,
            String::new(),
        )
    };
    crate::download::fetch(url, expected, hash, target, &CANCEL, &mut report)
}
fn runtime(app: &AppHandle, model: &str, root: &Path) -> Result<(), String> {
    let (r, _) = dirs(root);
    if r.join("llama-cli.exe").is_file() {
        return Ok(());
    }
    let archive = root.join("ai/runtime-b10516.zip");
    progress(
        app,
        model,
        "runtime",
        "Downloading the local runtime on demand…".into(),
        String::new(),
        0,
        18506923,
        false,
        String::new(),
    );
    download(
        app,
        model,
        "runtime",
        RUNTIME_URL,
        18506923,
        RUNTIME_HASH,
        &archive,
    )?;
    crate::download::unzip(&archive, &r, &CANCEL)?;
    let _ = fs::remove_file(archive);
    if !r.join("llama-cli.exe").is_file() {
        return Err("The verified runtime archive was incomplete.".into());
    }
    Ok(())
}

pub fn pull(app: AppHandle, root: PathBuf, model: String) -> Result<(), String> {
    let x = item(&model)?;
    if DOWNLOADING.swap(true, Ordering::SeqCst) {
        return Err("Another model is already downloading.".into());
    }
    CANCEL.store(false, Ordering::SeqCst);
    std::thread::spawn(move || {
        let result = runtime(&app, &model, &root).and_then(|_| {
            let target = dirs(&root).1.join(x.file);
            if target.is_file() {
                Ok(())
            } else {
                progress(
                    &app,
                    &model,
                    "model",
                    match crate::download::partial(&target, x.size) {
                        0 => format!("Downloading {}…", x.name),
                        n => format!("Resuming {} at {}…", x.name, mb(n)),
                    },
                    String::new(),
                    0,
                    x.size,
                    false,
                    String::new(),
                );
                download(&app, &model, "model", x.url, x.size, x.hash, &target)
            }
        });
        DOWNLOADING.store(false, Ordering::SeqCst);
        let error = result.err().unwrap_or_default();
        progress(
            &app,
            &model,
            "complete",
            if error.is_empty() {
                "Installed and ready".into()
            } else {
                String::new()
            },
            String::new(),
            x.size,
            x.size,
            true,
            error,
        )
    });
    Ok(())
}
pub fn cancel_pull() {
    CANCEL.store(true, Ordering::SeqCst)
}
pub fn delete_model(root: PathBuf, model: String) -> Result<(), String> {
    if AGENT_ACTIVE.load(Ordering::SeqCst) {
        return Err("Stop the local assistant before deleting one of its models.".into());
    }
    if DOWNLOADING.load(Ordering::SeqCst) {
        return Err("Finish or cancel the model download before deleting a model.".into());
    }
    let x = item(&model)?;
    let p = dirs(&root).1.join(x.file);
    if p.exists() {
        fs::remove_file(&p).map_err(|e| e.to_string())?
    }
    // Whatever a stopped download kept is part of what "delete" means here;
    // leaving it behind would hold gigabytes nothing on screen mentions.
    let _ = fs::remove_file(p.with_extension("part"));
    Ok(())
}

fn step(app: &AppHandle, request: &str, id: &str, name: &str, status: &str, detail: String) {
    let _ = app.emit(
        "assistant:step",
        Step {
            request_id: request.into(),
            id: id.into(),
            name: name.into(),
            status: status.into(),
            detail,
        },
    );
}
fn step_chunk(app: &AppHandle, request: &str, id: &str, text: &str) {
    let _ = app.emit(
        "assistant:step-chunk",
        StepChunk {
            request_id: request.into(),
            id: id.into(),
            text: text.into(),
        },
    );
}
#[derive(Default)]
struct ProtocolGate {
    buffer: String,
    plain: bool,
    emitted: bool,
}
impl ProtocolGate {
    fn push(&mut self, text: &str) -> Option<String> {
        if self.plain {
            self.emitted |= !text.is_empty();
            return Some(text.into());
        }
        self.buffer.push_str(text);
        let controls = [
            "WINT_TOOL_CALL",
            "WINT_QUESTION",
            "WINT_INVESTIGATION_PLAN",
            "WINT_RESEARCH_DONE",
            "WINT_CHANGE_PLAN",
            "WINT_IMPLEMENTATION_DONE",
        ];
        let candidate = self.buffer.trim_start();
        let upper = candidate.to_ascii_uppercase();
        if controls.iter().any(|p| p.starts_with(&upper)) {
            return None;
        }
        if controls.iter().any(|p| upper.starts_with(p)) {
            return None;
        }
        self.plain = true;
        let text = std::mem::take(&mut self.buffer);
        self.emitted |= !text.is_empty();
        Some(text)
    }
    fn finish(&mut self) -> Option<String> {
        let candidate = self.buffer.trim_start();
        if self.plain || is_control_output(candidate) {
            None
        } else {
            self.plain = true;
            let text = std::mem::take(&mut self.buffer);
            self.emitted |= !text.is_empty();
            Some(text)
        }
    }
    fn emitted(&self) -> bool {
        self.emitted
    }
}
fn is_control_output(text: &str) -> bool {
    let text = text.trim_start().to_ascii_uppercase();
    [
        "WINT_TOOL_CALL",
        "WINT_QUESTION",
        "WINT_INVESTIGATION_PLAN",
        "WINT_RESEARCH_DONE",
        "WINT_CHANGE_PLAN",
        "WINT_IMPLEMENTATION_DONE",
    ]
    .iter()
    .any(|marker| text.starts_with(marker))
}

#[derive(Clone, Copy, PartialEq)]
enum AgentStage {
    Understand,
    Investigate,
    ChangePlan,
    Implement,
    Evaluate,
}

impl AgentStage {
    fn allows(self, risk: crate::ai::tools::Risk) -> bool {
        use crate::ai::tools::Risk;
        match self {
            Self::Understand | Self::ChangePlan => false,
            Self::Investigate => risk == Risk::Read,
            Self::Implement => matches!(risk, Risk::Read | Risk::Write),
            Self::Evaluate => true,
        }
    }
}

fn stage_payload(text: &str, marker: &str) -> Result<Option<String>, String> {
    let Some(raw) = control_payload(text, marker) else {
        return Ok(None);
    };
    let value: serde_json::Value = serde_json::from_str(raw)
        .map_err(|_| format!("The model returned malformed {marker} JSON."))?;
    if !value.is_object() {
        return Err(format!("The model returned malformed {marker} JSON."));
    }
    Ok(Some(value.to_string()))
}
fn control_payload<'a>(text: &'a str, marker: &str) -> Option<&'a str> {
    let text = text.trim();
    let prefix = text.get(..marker.len())?;
    prefix
        .eq_ignore_ascii_case(marker)
        .then(|| text[marker.len()..].trim())
}
fn parse_question(text: &str) -> Result<Option<Question>, String> {
    let cleaned = clean_model_text(text);
    let raw = if let Some(raw) = control_payload(&cleaned, "WINT_QUESTION") {
        raw
    } else if cleaned.starts_with('{') && cleaned.ends_with('}') && cleaned.contains("\"question\"")
    {
        cleaned.as_str()
    } else {
        return Ok(None);
    };
    let question: Question = serde_json::from_str(raw)
        .map_err(|_| "The model returned a malformed question.".to_string())?;
    if question.question.trim().is_empty()
        || !(question.choices.is_empty() || (2..=5).contains(&question.choices.len()))
    {
        return Err("The model returned a malformed question.".into());
    }
    Ok(Some(question))
}
fn clean_model_text(text: &str) -> String {
    let trimmed = text.trim();
    for fence in ["```markdown", "```md"] {
        if let Some(body) = trimmed
            .strip_prefix(fence)
            .and_then(|value| value.strip_suffix("```"))
        {
            return body.trim().to_string();
        }
    }
    trimmed.to_string()
}
fn final_assistant_turn(saved: &str, fallback: &str) -> String {
    let normalized = saved.replace("\r\n", "\n");
    normalized
        .rsplit_once("\nAssistant:\n")
        .map(|(_, answer)| answer.trim())
        .filter(|answer| !answer.is_empty())
        .unwrap_or_else(|| fallback.trim())
        .to_string()
}
fn parse_plan(output: &str) -> Result<Vec<String>, String> {
    let text = output
        .trim()
        .strip_prefix("WINT_PLAN")
        .unwrap_or(output.trim())
        .trim()
        .trim_matches('`')
        .trim_start_matches("json")
        .trim();
    let start = text
        .find('{')
        .ok_or("The model did not return the required plan JSON.")?;
    let end = text
        .rfind('}')
        .ok_or("The model returned incomplete plan JSON.")?;
    let plan: ThinkingPlan = serde_json::from_str(&text[start..=end])
        .map_err(|_| "The model returned malformed plan JSON.")?;
    let steps: Vec<String> = plan
        .steps
        .into_iter()
        .map(|s| s.trim().chars().take(220).collect::<String>())
        .filter(|s| !s.is_empty())
        .collect();
    if steps.is_empty() {
        return Err("A Think plan must contain at least one step.".into());
    }
    Ok(steps)
}
fn run_model_stream<F: FnMut(&str)>(
    exe: &Path,
    model: &Path,
    prompt: &str,
    on_chunk: F,
) -> Result<String, String> {
    run_model_stream_limited(exe, model, prompt, 800, on_chunk)
}
fn run_model_stream_limited<F: FnMut(&str)>(
    exe: &Path,
    model: &Path,
    prompt: &str,
    max_tokens: usize,
    mut on_chunk: F,
) -> Result<String, String> {
    let stamp = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default()
        .as_nanos();
    let output_file =
        std::env::temp_dir().join(format!("wint-ai-{}-{stamp}.txt", std::process::id()));
    let output_name = output_file.to_string_lossy().to_string();
    let mut cmd = Command::new(exe);
    let max_tokens = max_tokens.to_string();
    cmd.args([
        "-m",
        &model.to_string_lossy(),
        "-p",
        prompt,
        "-n",
        &max_tokens,
        "-c",
        "8192",
        "--single-turn",
        "--no-display-prompt",
        "--simple-io",
        "--no-warmup",
        "--log-disable",
        "--no-perf",
        "--output",
        &output_name,
    ])
    .stdout(Stdio::piped())
    .stderr(Stdio::piped());
    hide(&mut cmd);
    let mut child = cmd
        .spawn()
        .map_err(|e| format!("Could not start local inference: {e}"))?;
    let stdout = child.stdout.take().ok_or("Could not read model output.")?;
    let stderr = child
        .stderr
        .take()
        .ok_or("Could not read runtime errors.")?;
    *CHAT
        .get_or_init(|| Mutex::new(None))
        .lock()
        .map_err(|_| "Local inference is unavailable.")? = Some(child);
    let errors = std::thread::spawn(move || {
        let mut s = String::new();
        let _ = BufReader::new(stderr).read_to_string(&mut s);
        s
    });
    let tail = prompt
        .lines()
        .rev()
        .find(|line| !line.trim().is_empty())
        .unwrap_or("")
        .trim();
    let mut reader = BufReader::new(stdout);
    let mut bytes = [0u8; 256];
    let mut pending = Vec::new();
    let mut answer = false;
    let mut output = String::new();
    loop {
        let got = reader.read(&mut bytes).unwrap_or(0);
        if got == 0 {
            break;
        }
        pending.extend_from_slice(&bytes[..got]);
        if !answer {
            while let Some(end) = pending.iter().position(|b| *b == b'\n') {
                let raw: Vec<u8> = pending.drain(..=end).collect();
                let line = String::from_utf8_lossy(&raw);
                let clean = line.trim_end_matches(['\r', '\n']);
                let echoed = clean.strip_prefix("> ").unwrap_or(clean).trim();
                if echoed == tail {
                    answer = true;
                    break;
                }
            }
            if !answer {
                continue;
            }
        }
        loop {
            match std::str::from_utf8(&pending) {
                Ok(text) => {
                    if !text.is_empty() {
                        output.push_str(text);
                        on_chunk(text)
                    }
                    pending.clear();
                    break;
                }
                Err(e) => {
                    let valid = e.valid_up_to();
                    if valid > 0 {
                        let text = unsafe { std::str::from_utf8_unchecked(&pending[..valid]) };
                        output.push_str(text);
                        on_chunk(text);
                        pending.drain(..valid);
                    }
                    if e.error_len().is_some() {
                        pending.drain(..1);
                        output.push('\u{fffd}');
                        on_chunk("�");
                        continue;
                    }
                    break;
                }
            }
        }
    }
    if answer && !pending.is_empty() {
        let text = String::from_utf8_lossy(&pending);
        output.push_str(&text);
        on_chunk(&text)
    }
    let ok = CHAT
        .get()
        .and_then(|m| m.lock().ok())
        .and_then(|mut s| s.take())
        .and_then(|mut c| c.wait().ok())
        .is_some_and(|s| s.success());
    let errors = errors.join().unwrap_or_default();
    let saved = fs::read_to_string(&output_file).unwrap_or_default();
    let _ = fs::remove_file(&output_file);
    if !ok {
        return Err(errors
            .lines()
            .last()
            .unwrap_or("Local inference stopped.")
            .into());
    }
    let framed = final_assistant_turn(&saved, &output);
    if framed.is_empty() {
        Err(
            "The model completed without producing an answer. Try again or choose a larger model."
                .into(),
        )
    } else {
        Ok(framed)
    }
}
fn run_model(exe: &Path, model: &Path, prompt: &str) -> Result<String, String> {
    run_model_stream(exe, model, prompt, |_| {})
}
fn route_intent(
    exe: &Path,
    model: &Path,
    question: &str,
    areas: &[RouteOption],
) -> Result<Vec<RouteOption>, String> {
    let options = serde_json::to_string(areas).unwrap_or_else(|_| "[]".into());
    let prompt = format!("Classify one WinT user request. Choose the best matching option IDs. Usually choose exactly one; choose multiple only when the request genuinely spans areas. Choose the text option when no tool or WinT area is relevant. Do not answer the request.\nOptions: {options}\nUser request: {question}\nReturn only WINT_INTENT followed by JSON {{\"intents\":[\"option-id\"]}}.\nAssistant:");
    let output = run_model_stream_limited(exe, model, &prompt, 160, |_| {})?;
    let text = output
        .trim()
        .strip_prefix("WINT_INTENT")
        .unwrap_or(output.trim())
        .trim();
    let start = text
        .find('{')
        .ok_or("The model did not return intent JSON.")?;
    let end = text
        .rfind('}')
        .ok_or("The model returned incomplete intent JSON.")?;
    let route: IntentRoute = serde_json::from_str(&text[start..=end])
        .map_err(|_| "The model returned malformed intent JSON.")?;
    let mut selected = Vec::new();
    for id in route.intents {
        if let Some(area) = areas.iter().find(|area| area.id == id) {
            if !selected.iter().any(|item: &RouteOption| item.id == area.id) {
                selected.push(area.clone())
            }
        }
    }
    if selected.is_empty() {
        areas
            .iter()
            .find(|area| area.id == "text" || area.id == "general")
            .cloned()
            .map(|area| vec![area])
            .ok_or_else(|| "No valid intent was selected.".into())
    } else {
        Ok(selected)
    }
}
fn area_instruction(area: &RouteOption) -> String {
    let guidance = match area.id.as_str() {
        "project" => "Use the attached project roots and project file tools. Ground setup, code, dependency, script, and Git claims in project evidence.",
        "project-write" => "Act as a coding agent for the attached project. Inspect relevant files before changing them, keep edits scoped to the request, and report the files changed and verification performed.",
        "project-agent" => "Act as an autonomous coding agent for the attached project. Inspect before editing, use project checks to evaluate changes, iterate on failures, keep edits scoped, and report changed files plus verification.",
        "terminal" => "Treat shell text as terminal evidence. Identify the shell and working-directory assumptions, explain failures precisely, and give commands appropriate for Windows unless context says otherwise.",
        "ports" => "Focus on listeners, owning processes, address families, conflicts, and safe port diagnostics.",
        "dns" => "Focus on record types, resolvers, caching, authoritative versus recursive answers, and concrete DNS diagnostics.",
        "hosts" => "Focus on Windows hosts-file syntax, precedence, permissions, and safe validation.",
        "network" | "path-ping" => "Focus on adapters, routes, reachability, latency, packet loss, and layered network diagnosis.",
        "disk-space" => "Focus on drive capacity, large paths, safe cleanup candidates, and avoid suggesting destructive deletion without evidence.",
        "settings" => "Answer specifically in terms of WinT settings and clearly distinguish existing behavior from proposed behavior.",
        id if id.starts_with("utility:") => "Treat this as a request about the named WinT utility. Explain the expected input, transformation, output, and relevant validation.",
        id if id.starts_with("windows:") => "Treat this as a request about the named WinT Windows tool. Focus on what it observes or changes, required privileges, safety, and interpretation of its result.",
        "text" | "general" => "Answer directly from the conversation. Do not assume project state, application state, terminal output, or tool results that were not supplied.",
        _ => "Answer directly and do not assume project or terminal context unless the request provides it.",
    };
    format!("{} ({}): {}", area.name, area.description, guidance)
}
pub fn chat(
    app: AppHandle,
    root: PathBuf,
    request_id: String,
    model: String,
    question: String,
    prompt: String,
    project_context: String,
    roots: Vec<String>,
    areas: Vec<RouteOption>,
    think: bool,
    tool_call_cap: usize,
) -> Result<(), String> {
    let x = item(&model)?;
    let exe = dirs(&root).0.join("llama-cli.exe");
    let path = dirs(&root).1.join(x.file);
    if !exe.is_file() || !path.is_file() {
        return Err("Download this model before chatting with it.".into());
    }
    if AGENT_ACTIVE.swap(true, Ordering::SeqCst) {
        return Err("The assistant is already answering.".into());
    }
    CHAT_CANCELLED.store(false, Ordering::SeqCst);
    let tool_call_cap = tool_call_cap.clamp(1, 100);
    std::thread::spawn(move || {
        let mut tool_calls_used = 0usize;
        step(
            &app,
            &request_id,
            "intent",
            "Route request",
            "running",
            "Choosing the relevant WinT area".into(),
        );
        let selected = match route_intent(&exe, &path, &question, &areas) {
            Ok(selected) => selected,
            Err(_) => areas
                .iter()
                .find(|area| area.id == "text" || area.id == "general")
                .cloned()
                .into_iter()
                .collect(),
        };
        let route_names = selected
            .iter()
            .map(|area| area.name.as_str())
            .collect::<Vec<_>>()
            .join(", ");
        step(
            &app,
            &request_id,
            "intent",
            "Route request",
            "done",
            if route_names.is_empty() {
                "Text-only response".into()
            } else {
                route_names
            },
        );
        let focus = selected
            .iter()
            .map(area_instruction)
            .collect::<Vec<_>>()
            .join("\n");
        let selected_ids = selected
            .iter()
            .map(|area| area.id.clone())
            .collect::<Vec<_>>();
        let registry = ToolRegistry::routed(Some(app.clone()), roots, &selected_ids);
        let tools = registry.definitions();
        let staged = selected_ids.iter().any(|id| id == "project-agent");
        let protocol = if tools.is_empty() {
            "\n\nNo callable tools are needed for this routed request. Ask a necessary question with WINT_QUESTION plus its JSON only when required; never ask for a value already present in the user's request. Otherwise answer in clean Markdown.".into()
        } else {
            let definitions = serde_json::to_string(&tools).unwrap_or_default();
            format!("\n\nCallable tools for this routed request only: {definitions}\nTo request one, output exactly WINT_TOOL_CALL on its own line followed by one JSON object with id, name, and arguments. To ask the user a genuinely necessary question, output exactly WINT_QUESTION on its own line followed by JSON {{\"question\":\"...\",\"choices\":[\"...\"]}}. Never ask for a domain, string, path, or other parameter already present in the user's request. Otherwise answer in clean Markdown. Never mix a tool request or question with prose.")
        };
        let base_prompt = prompt
            .trim_end()
            .strip_suffix("Assistant:")
            .unwrap_or(prompt.trim_end());
        let scoped_context = if selected_ids
            .iter()
            .any(|id| matches!(id.as_str(), "project" | "project-write" | "project-agent"))
        {
            format!("\n\nWinT project context:\n{project_context}")
        } else {
            String::new()
        };
        let base = format!("{base_prompt}{scoped_context}\n\nSelected WinT focus areas:\n{focus}\nUse only this routed context and these area-specific instructions for the response.");
        let stage_protocol = if staged {
            "\n\nFollow this backend-enforced workflow. First output WINT_INVESTIGATION_PLAN plus a JSON object describing what you need to understand and inspect. During investigation use only read tools, and call as many as evidence requires. Then output WINT_RESEARCH_DONE plus JSON summarizing evidence. Next output WINT_CHANGE_PLAN plus JSON with concrete, evidence-based edits. During implementation, read and write tools are available but checks are not. When edits are complete output WINT_IMPLEMENTATION_DONE plus JSON listing changed files. During evaluation, review files, run the available checks, and fix and re-check failures before the final Markdown answer. Never skip a stage or combine a workflow marker with prose."
        } else {
            ""
        };
        let mut working = format!("{base}{protocol}{stage_protocol}\n\nAssistant:");
        let mut agent_stage = AgentStage::Understand;
        if staged {
            for (id, name, detail) in [
                (
                    "agent-understand",
                    "Understand request",
                    "Form an investigation plan",
                ),
                (
                    "agent-investigate",
                    "Investigate project",
                    "Gather project evidence",
                ),
                (
                    "agent-plan",
                    "Plan changes",
                    "Turn evidence into scoped edits",
                ),
                ("agent-implement", "Make changes", "Apply the planned scope"),
                (
                    "agent-evaluate",
                    "Evaluate changes",
                    "Review and run project checks",
                ),
            ] {
                step(
                    &app,
                    &request_id,
                    id,
                    name,
                    if id == "agent-understand" {
                        "running"
                    } else {
                        "queued"
                    },
                    detail.into(),
                );
            }
        }
        step(
            &app,
            &request_id,
            "context",
            "Prepare context",
            "done",
            format!(
                "{} routed tool{} · {}",
                tools.len(),
                if tools.len() == 1 { "" } else { "s" },
                if scoped_context.is_empty() {
                    "no project context"
                } else {
                    "project context attached"
                }
            ),
        );
        let mut final_error = String::new();
        let mut delivered = false;
        if think {
            step(
                &app,
                &request_id,
                "planning",
                "Create plan",
                "running",
                "Requesting a structured plan".into(),
            );
            let plan_prompt=format!("{base}\nCreate a practical plan before answering. Output only WINT_PLAN followed by JSON {{\"steps\":[\"step one\",\"step two\"]}}. Include as many concrete steps as the task needs. Do not perform them yet.\nAssistant:");
            let plan_output = match run_model(&exe, &path, &plan_prompt) {
                Ok(v) => v,
                Err(e) => {
                    step(
                        &app,
                        &request_id,
                        "planning",
                        "Create plan",
                        "error",
                        e.clone(),
                    );
                    let _ = app.emit(
                        "assistant:chunk",
                        Chunk {
                            request_id: request_id.clone(),
                            text: String::new(),
                            done: true,
                            error: e,
                            kind: "text".into(),
                            question: String::new(),
                            choices: vec![],
                        },
                    );
                    AGENT_ACTIVE.store(false, Ordering::SeqCst);
                    return;
                }
            };
            let plan = match parse_plan(&plan_output) {
                Ok(v) => v,
                Err(e) => {
                    step(
                        &app,
                        &request_id,
                        "planning",
                        "Create plan",
                        "error",
                        e.clone(),
                    );
                    let _ = app.emit(
                        "assistant:chunk",
                        Chunk {
                            request_id: request_id.clone(),
                            text: String::new(),
                            done: true,
                            error: e,
                            kind: "text".into(),
                            question: String::new(),
                            choices: vec![],
                        },
                    );
                    AGENT_ACTIVE.store(false, Ordering::SeqCst);
                    return;
                }
            };
            step(
                &app,
                &request_id,
                "planning",
                "Create plan",
                "done",
                format!("{} validated steps", plan.len()),
            );
            for (i, label) in plan.iter().enumerate() {
                step(
                    &app,
                    &request_id,
                    &format!("plan-{i}"),
                    &format!("Step {}", i + 1),
                    "queued",
                    label.clone(),
                )
            }
            let plan_json = serde_json::to_string(&plan).unwrap_or_default();
            let mut results = String::new();
            for (i, label) in plan.iter().enumerate() {
                if CHAT_CANCELLED.load(Ordering::SeqCst) {
                    break;
                }
                let id = format!("plan-{i}");
                step(
                    &app,
                    &request_id,
                    &id,
                    &format!("Step {}", i + 1),
                    "running",
                    String::new(),
                );
                let mut step_prompt=format!("{base}{protocol}\n\nValidated plan: {plan_json}\nCompleted results:{results}\nPerform only step {} now: {}\nReturn a concise factual result in Markdown, not the overall answer.\nAssistant:",i+1,label);
                let mut gate = ProtocolGate::default();
                let mut result = match run_model_stream(&exe, &path, &step_prompt, |chunk| {
                    if let Some(text) = gate.push(chunk) {
                        step_chunk(&app, &request_id, &id, &text)
                    }
                }) {
                    Ok(v) => v,
                    Err(e) => {
                        step(
                            &app,
                            &request_id,
                            &id,
                            &format!("Step {}", i + 1),
                            "error",
                            e.clone(),
                        );
                        final_error = e;
                        break;
                    }
                };
                result = clean_model_text(&result);
                if let Some(text) = gate.finish() {
                    step_chunk(&app, &request_id, &id, &text)
                }
                if !gate.emitted() && !is_control_output(&result) {
                    step_chunk(&app, &request_id, &id, &result);
                }
                if let Some(raw) = control_payload(&result, "WINT_TOOL_CALL") {
                    if tool_calls_used >= tool_call_cap {
                        final_error =
                            format!("The assistant reached the {tool_call_cap}-call tool limit.");
                        break;
                    }
                    tool_calls_used += 1;
                    match serde_json::from_str::<ToolCall>(raw.trim()) {
                        Ok(call) => {
                            let tool_id = format!("{id}-tool");
                            step(
                                &app,
                                &request_id,
                                &tool_id,
                                &call.name,
                                "running",
                                call.arguments.to_string(),
                            );
                            match registry.execute(&call) {
                                Ok(value) => {
                                    let mut value = value.to_string();
                                    if value.len() > 12000 {
                                        value.truncate(12000);
                                        value.push_str("…[truncated]")
                                    }
                                    step(
                                        &app,
                                        &request_id,
                                        &tool_id,
                                        &call.name,
                                        "done",
                                        format!("Returned {} characters", value.len()),
                                    );
                                    step_prompt=format!("{step_prompt}\nTool result: {value}\nComplete this step now in concise Markdown.\nAssistant:");
                                    let mut gate = ProtocolGate::default();
                                    result =
                                        match run_model_stream(&exe, &path, &step_prompt, |chunk| {
                                            if let Some(text) = gate.push(chunk) {
                                                step_chunk(&app, &request_id, &id, &text);
                                            }
                                        }) {
                                            Ok(v) => v,
                                            Err(e) => {
                                                final_error = e;
                                                break;
                                            }
                                        };
                                    result = clean_model_text(&result);
                                    if let Some(text) = gate.finish() {
                                        step_chunk(&app, &request_id, &id, &text);
                                    }
                                    if !gate.emitted() && !is_control_output(&result) {
                                        step_chunk(&app, &request_id, &id, &result);
                                    }
                                }
                                Err(e) => {
                                    step(
                                        &app,
                                        &request_id,
                                        &tool_id,
                                        &call.name,
                                        "error",
                                        e.clone(),
                                    );
                                    result = format!("Tool request rejected: {e}")
                                }
                            }
                        }
                        Err(_) => result = "Malformed tool request; nothing executed.".into(),
                    }
                }
                match parse_question(&result) {
                    Ok(Some(q)) => {
                        step(
                            &app,
                            &request_id,
                            &id,
                            &format!("Step {}", i + 1),
                            "done",
                            "Waiting for your answer".into(),
                        );
                        let _ = app.emit(
                            "assistant:chunk",
                            Chunk {
                                request_id: request_id.clone(),
                                text: String::new(),
                                done: true,
                                error: String::new(),
                                kind: "question".into(),
                                question: q.question,
                                choices: q.choices,
                            },
                        );
                        AGENT_ACTIVE.store(false, Ordering::SeqCst);
                        return;
                    }
                    Err(e) => {
                        final_error = e;
                        break;
                    }
                    Ok(None) => {}
                }
                let mut stored = result.trim().to_string();
                if stored.len() > 4000 {
                    stored.truncate(4000);
                    stored.push_str("…[truncated]")
                }
                step(
                    &app,
                    &request_id,
                    &id,
                    &format!("Step {}", i + 1),
                    "done",
                    stored.clone(),
                );
                results.push_str(&format!("\nStep {} — {}:\n{}\n", i + 1, label, stored));
                if results.len() > 18000 {
                    results.truncate(18000)
                }
            }
            if !final_error.is_empty() || CHAT_CANCELLED.load(Ordering::SeqCst) {
                let _ = app.emit(
                    "assistant:chunk",
                    Chunk {
                        request_id: request_id.clone(),
                        text: String::new(),
                        done: true,
                        error: final_error,
                        kind: "text".into(),
                        question: String::new(),
                        choices: vec![],
                    },
                );
                AGENT_ACTIVE.store(false, Ordering::SeqCst);
                return;
            }
            working=format!("{base}{protocol}\n\nCompleted plan: {plan_json}\nStep results:{results}\nSynthesize the final answer now in polished Markdown. Do not output another plan.\nAssistant:");
        }
        for turn in 0..=(tool_call_cap + if staged { 8 } else { 0 }) {
            let inference_id = format!("model-{turn}");
            let inference_name = if staged {
                match agent_stage {
                    AgentStage::Understand => "Understand request",
                    AgentStage::Investigate => "Investigate project",
                    AgentStage::ChangePlan => "Plan changes",
                    AgentStage::Implement => "Make changes",
                    AgentStage::Evaluate => "Evaluate changes",
                }
            } else {
                "Final answer"
            };
            step(
                &app,
                &request_id,
                &inference_id,
                inference_name,
                "running",
                format!("{} · synthesis pass {}", x.name, turn + 1),
            );
            let mut gate = ProtocolGate::default();
            let mut output = match run_model_stream(&exe, &path, &working, |chunk| {
                if let Some(text) = gate.push(chunk) {
                    let _ = app.emit(
                        "assistant:chunk",
                        Chunk {
                            request_id: request_id.clone(),
                            text,
                            done: false,
                            error: String::new(),
                            kind: "text".into(),
                            question: String::new(),
                            choices: vec![],
                        },
                    );
                }
            }) {
                Ok(v) => v,
                Err(e) => {
                    if CHAT_CANCELLED.load(Ordering::SeqCst) {
                        step(
                            &app,
                            &request_id,
                            &inference_id,
                            "Final answer",
                            "done",
                            "Stopped by you".into(),
                        )
                    } else {
                        step(
                            &app,
                            &request_id,
                            &inference_id,
                            "Final answer",
                            "error",
                            e.clone(),
                        );
                        final_error = e
                    }
                    break;
                }
            };
            output = clean_model_text(&output);
            if let Some(text) = gate.finish() {
                let _ = app.emit(
                    "assistant:chunk",
                    Chunk {
                        request_id: request_id.clone(),
                        text,
                        done: false,
                        error: String::new(),
                        kind: "text".into(),
                        question: String::new(),
                        choices: vec![],
                    },
                );
            }
            if !gate.emitted() && !is_control_output(&output) {
                let _ = app.emit(
                    "assistant:chunk",
                    Chunk {
                        request_id: request_id.clone(),
                        text: output.clone(),
                        done: false,
                        error: String::new(),
                        kind: "text".into(),
                        question: String::new(),
                        choices: vec![],
                    },
                );
            }
            step(
                &app,
                &request_id,
                &inference_id,
                inference_name,
                "done",
                format!("{} characters received", output.len()),
            );
            if staged {
                let transition = match agent_stage {
                    AgentStage::Understand => stage_payload(&output, "WINT_INVESTIGATION_PLAN")
                        .map(|value| {
                            value.map(|payload| {
                                (
                                    AgentStage::Investigate,
                                    "agent-understand",
                                    "agent-investigate",
                                    payload,
                                )
                            })
                        }),
                    AgentStage::Investigate => {
                        stage_payload(&output, "WINT_RESEARCH_DONE").map(|value| {
                            value.map(|payload| {
                                (
                                    AgentStage::ChangePlan,
                                    "agent-investigate",
                                    "agent-plan",
                                    payload,
                                )
                            })
                        })
                    }
                    AgentStage::ChangePlan => {
                        stage_payload(&output, "WINT_CHANGE_PLAN").map(|value| {
                            value.map(|payload| {
                                (
                                    AgentStage::Implement,
                                    "agent-plan",
                                    "agent-implement",
                                    payload,
                                )
                            })
                        })
                    }
                    AgentStage::Implement => stage_payload(&output, "WINT_IMPLEMENTATION_DONE")
                        .map(|value| {
                            value.map(|payload| {
                                (
                                    AgentStage::Evaluate,
                                    "agent-implement",
                                    "agent-evaluate",
                                    payload,
                                )
                            })
                        }),
                    AgentStage::Evaluate => Ok(None),
                };
                match transition {
                    Ok(Some((next, completed_id, next_id, payload))) => {
                        step(
                            &app,
                            &request_id,
                            completed_id,
                            inference_name,
                            "done",
                            payload.clone(),
                        );
                        let next_name = match next {
                            AgentStage::Investigate => "Investigate project",
                            AgentStage::ChangePlan => "Plan changes",
                            AgentStage::Implement => "Make changes",
                            AgentStage::Evaluate => "Evaluate changes",
                            AgentStage::Understand => "Understand request",
                        };
                        step(
                            &app,
                            &request_id,
                            next_id,
                            next_name,
                            "running",
                            String::new(),
                        );
                        agent_stage = next;
                        let before = working
                            .trim_end()
                            .strip_suffix("Assistant:")
                            .unwrap_or(working.trim_end());
                        working = format!("{before}\nWorkflow result: {payload}\nContinue with the next required workflow stage.\nAssistant:");
                        continue;
                    }
                    Err(e) => {
                        final_error = e;
                        break;
                    }
                    Ok(None) => {}
                }
            }
            if let Some(raw) = control_payload(&output, "WINT_TOOL_CALL") {
                if tool_calls_used >= tool_call_cap {
                    final_error =
                        format!("The assistant reached the {tool_call_cap}-call tool limit.");
                    break;
                }
                tool_calls_used += 1;
                let call: ToolCall = match serde_json::from_str(raw.trim()) {
                    Ok(v) => v,
                    Err(_) => {
                        final_error =
                            "The model returned a malformed tool request; nothing was executed."
                                .into();
                        break;
                    }
                };
                let tool_id = format!("tool-{turn}");
                let Some(risk) = registry.risk(&call.name) else {
                    final_error =
                        "The model requested an unknown tool; nothing was executed.".into();
                    break;
                };
                if staged && !agent_stage.allows(risk) {
                    let before = working
                        .trim_end()
                        .strip_suffix("Assistant:")
                        .unwrap_or(working.trim_end());
                    working = format!("{before}\nThe backend rejected {} because it is not allowed in the current workflow stage. Complete the required stage marker first.\nAssistant:", call.name);
                    continue;
                }
                let mut args = call.arguments.to_string();
                if args.len() > 240 {
                    args.truncate(240);
                    args.push('…')
                }
                step(
                    &app,
                    &request_id,
                    &tool_id,
                    &call.name,
                    "running",
                    format!("{:?} · {}", risk, args),
                );
                match registry.execute(&call) {
                    Ok(result) => {
                        let mut result = result.to_string();
                        if result.len() > 16000 {
                            result.truncate(16000);
                            result.push_str("…[truncated]")
                        }
                        step(
                            &app,
                            &request_id,
                            &tool_id,
                            &call.name,
                            "done",
                            format!("Validated and returned {} characters", result.len()),
                        );
                        let before = working
                            .trim_end()
                            .strip_suffix("Assistant:")
                            .unwrap_or(working.trim_end());
                        working=format!("{before}Assistant requested tool {} with {}.\nTool result: {}\nContinue the current workflow stage; request another tool when the evidence or verification requires it.\nAssistant:",call.name,call.arguments,result);
                        continue;
                    }
                    Err(e) => {
                        step(&app, &request_id, &tool_id, &call.name, "error", e.clone());
                        let before = working
                            .trim_end()
                            .strip_suffix("Assistant:")
                            .unwrap_or(working.trim_end());
                        working=format!("{before}Tool request was rejected: {e}\nGive a safe final answer without that tool.\nAssistant:");
                        continue;
                    }
                }
            }
            match parse_question(&output) {
                Ok(Some(q)) => {
                    let _ = app.emit(
                        "assistant:chunk",
                        Chunk {
                            request_id: request_id.clone(),
                            text: String::new(),
                            done: true,
                            error: String::new(),
                            kind: "question".into(),
                            question: q.question,
                            choices: q.choices,
                        },
                    );
                    AGENT_ACTIVE.store(false, Ordering::SeqCst);
                    return;
                }
                Err(e) => {
                    final_error = e;
                    break;
                }
                Ok(None) => {}
            }
            if staged && agent_stage != AgentStage::Evaluate {
                let before = working
                    .trim_end()
                    .strip_suffix("Assistant:")
                    .unwrap_or(working.trim_end());
                working = format!("{before}\nYou attempted to finish before evaluation. Continue the required staged workflow and output its exact next marker.\nAssistant:");
                continue;
            }
            if staged {
                step(
                    &app,
                    &request_id,
                    "agent-evaluate",
                    "Evaluate changes",
                    "done",
                    "Reviewed the result and completed verification".into(),
                );
            }
            let _ = app.emit(
                "assistant:chunk",
                Chunk {
                    request_id: request_id.clone(),
                    text: output.clone(),
                    done: false,
                    error: String::new(),
                    kind: "replace".into(),
                    question: String::new(),
                    choices: vec![],
                },
            );
            delivered = true;
            break;
        }
        if !delivered && final_error.is_empty() && !CHAT_CANCELLED.load(Ordering::SeqCst) {
            final_error = format!("The assistant reached the {tool_call_cap}-call tool limit.")
        }
        let _ = app.emit(
            "assistant:chunk",
            Chunk {
                request_id,
                text: String::new(),
                done: true,
                error: final_error,
                kind: "text".into(),
                question: String::new(),
                choices: vec![],
            },
        );
        AGENT_ACTIVE.store(false, Ordering::SeqCst);
    });
    Ok(())
}
pub fn cancel_chat() {
    CHAT_CANCELLED.store(true, Ordering::SeqCst);
    if let Some(m) = CHAT.get() {
        if let Ok(mut s) = m.lock() {
            if let Some(c) = s.as_mut() {
                let _ = c.kill();
            }
        }
    }
}
#[cfg(windows)]
fn hide(c: &mut Command) {
    use std::os::windows::process::CommandExt;
    c.creation_flags(0x08000000);
}
#[cfg(not(windows))]
fn hide(_: &mut Command) {}
#[cfg(test)]
mod tests {
    use super::{
        clean_model_text, control_payload, final_assistant_turn, is_control_output, parse_plan,
        parse_question, ProtocolGate,
    };
    #[test]
    fn extracts_last_llama_assistant_turn() {
        let transcript = "User:\nExplain this\nAssistant:\n\nAssistant:\n## Project\n- Rust\n";
        assert_eq!(final_assistant_turn(transcript, ""), "## Project\n- Rust");
    }
    #[test]
    fn falls_back_when_runtime_writes_no_transcript() {
        assert_eq!(final_assistant_turn("", "plain answer\n"), "plain answer");
    }
    #[test]
    fn accepts_a_visible_plan() {
        assert_eq!(
            parse_plan("WINT_PLAN\n{\"steps\":[\"Inspect files\",\"Summarize\"]}").unwrap(),
            vec!["Inspect files", "Summarize"]
        );
    }
    #[test]
    fn accepts_more_than_six_steps() {
        let json = "{\"steps\":[\"1\",\"2\",\"3\",\"4\",\"5\",\"6\",\"7\",\"8\"]}";
        assert_eq!(parse_plan(json).unwrap().len(), 8);
    }
    #[test]
    fn rejects_an_empty_plan() {
        assert!(parse_plan("{\"steps\":[]}").is_err());
    }
    #[test]
    fn transcript_fallback_is_needed_when_stdout_was_empty() {
        let mut gate = ProtocolGate::default();
        assert_eq!(gate.finish(), Some(String::new()));
        assert!(!gate.emitted());
        assert!(!is_control_output("A saved final answer"));
        assert!(is_control_output("WINT_TOOL_CALL\n{}"));
    }
    #[test]
    fn questions_allow_leading_whitespace() {
        let text = "\n  WINT_QUESTION\n{\"question\":\"Which host?\",\"choices\":[\"A\",\"B\"]}";
        assert_eq!(
            control_payload(text, "WINT_QUESTION")
                .unwrap()
                .chars()
                .next(),
            Some('{')
        );
        assert_eq!(
            parse_question(text).unwrap().unwrap().question,
            "Which host?"
        );
        let mut gate = ProtocolGate::default();
        assert!(gate.push("\n  WINT_").is_none());
        assert!(gate.push("QUESTION\n{}").is_none());
        assert!(!gate.emitted());
        let bare = parse_question("{\"question\":\"What string should be used?\"}")
            .unwrap()
            .unwrap();
        assert!(bare.choices.is_empty());
    }
    #[test]
    fn unwraps_a_whole_markdown_fence() {
        assert_eq!(
            clean_model_text("```markdown\n| A | B |\n|---|---|\n| 1 | 2 |\n```"),
            "| A | B |\n|---|---|\n| 1 | 2 |"
        );
    }
}
