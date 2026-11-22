//! `wint mcp`: the Projects cockpit as an MCP server on stdio.
//!
//! This is how Claude Desktop (or any MCP client) reads and writes the
//! observations WinT shows on its project cards. Add to
//! `%APPDATA%\Claude\claude_desktop_config.json`:
//!
//! ```json
//! { "mcpServers": { "wint": { "command": "C:\\...\\wint.exe", "args": ["mcp"] } } }
//! ```
//!
//! Newline-delimited JSON-RPC 2.0, as the stdio transport specifies. Only the
//! tools capability is offered. Nothing but protocol messages is ever written
//! to stdout; anything worth saying goes to stderr, which clients log.

use crate::cockpit;
use serde_json::{json, Value};
use std::io::{BufRead, Write};

const PROTOCOL_VERSIONS: &[&str] = &["2025-06-18", "2025-03-26", "2024-11-05"];

const INSTRUCTIONS: &str = "WinT is a desktop app that lists the user's development projects \
with their git state. Its Projects view is a status cockpit: each project card shows a health \
status (healthy, attention, incident), a one-line summary, the next thing to do, a few KPIs and \
notes written by agents like you. Call list_projects first: it returns only the projects the user \
starred as favorites, and only those may be updated - leave every other project alone. \
Keep summaries to one line and notes short and specific, with a source. Re-sending a note with \
the same kind and text updates it instead of duplicating it, so it is safe to rerun.";

fn tools() -> Value {
    let project = json!({
        "type": "string",
        "description": "The project's name, key or folder path, as list_projects shows it. Must be one of the favorites list_projects returns."
    });
    let agent = json!({
        "type": "string",
        "description": "Who is writing, shown on the card. Defaults to the name of this MCP client."
    });
    let note = json!({
        "type": "object",
        "properties": {
            "kind": { "type": "string", "description": "A one-word label: Risk, Next, Waiting, Branch, Promise, Cause, Gap..." },
            "text": { "type": "string", "description": "What was observed, in a sentence or two." },
            "source": { "type": "string", "description": "Where it was seen: GitHub, Email, Sentry, Stripe..." }
        },
        "required": ["text"]
    });
    json!([
        {
            "name": "list_projects",
            "title": "List projects",
            "description": "The projects the user starred as favorites in WinT - the only ones to report on - worst status first: name, key, path, branch, uncommitted changes, ahead/behind, running processes, last commit, and the current status, summary and next step.",
            "inputSchema": {
                "type": "object",
                "properties": {
                    "status": { "type": "string", "enum": ["healthy", "attention", "incident", "unknown"], "description": "Only projects with this status." }
                }
            },
            "annotations": { "readOnlyHint": true }
        },
        {
            "name": "get_project",
            "title": "Get one project",
            "description": "One project's scan details and every observation on it, including note ids.",
            "inputSchema": { "type": "object", "properties": { "project": project }, "required": ["project"] },
            "annotations": { "readOnlyHint": true }
        },
        {
            "name": "update_project",
            "title": "Update a project's status",
            "description": "Set the status, summary, next step and KPIs, and add or remove notes, in one call. Anything left out stays as it is; an empty string clears a field.",
            "inputSchema": {
                "type": "object",
                "properties": {
                    "project": project,
                    "status": { "type": "string", "enum": ["healthy", "attention", "incident", "unknown"] },
                    "summary": { "type": "string", "description": "One line on how the project is doing." },
                    "next": { "type": "string", "description": "The single next thing the user should do here." },
                    "kpis": {
                        "type": "array",
                        "description": "Replaces all KPIs. Up to 8; the first 4 show on the card.",
                        "items": {
                            "type": "object",
                            "properties": {
                                "label": { "type": "string" },
                                "value": { "type": "string" },
                                "tone": { "type": "string", "enum": ["good", "warn", "bad", ""] }
                            },
                            "required": ["label", "value"]
                        }
                    },
                    "add_notes": { "type": "array", "items": note },
                    "remove_notes": { "type": "array", "items": { "type": "string" }, "description": "Ids of notes to remove (from get_project)." },
                    "clear_notes": { "type": "boolean", "description": "Remove every note before adding any." },
                    "agent": agent
                },
                "required": ["project"]
            },
            "annotations": { "destructiveHint": false, "idempotentHint": true }
        },
        {
            "name": "add_note",
            "title": "Add a note to a project",
            "description": "Add one observation to a project's card.",
            "inputSchema": {
                "type": "object",
                "properties": {
                    "project": project,
                    "kind": { "type": "string" },
                    "text": { "type": "string" },
                    "source": { "type": "string" },
                    "agent": agent
                },
                "required": ["project", "text"]
            },
            "annotations": { "destructiveHint": false, "idempotentHint": true }
        },
        {
            "name": "clear_project",
            "title": "Clear a project",
            "description": "Remove everything observed about a project: status, summary, KPIs and notes.",
            "inputSchema": { "type": "object", "properties": { "project": project }, "required": ["project"] },
            "annotations": { "destructiveHint": true, "idempotentHint": true }
        },
        {
            "name": "set_report",
            "title": "Set the summary report",
            "description": "Show a summary report at the top of WinT's Projects window, replacing the last one. Write it after going through the projects: what needs the user first, what changed, what is fine. Give rich HTML as a fragment: headings, short paragraphs, lists, tables, inline styles or a <style> block. Scripts do not run and nothing loads from outside except https images. Use WinT's colours so it fits light and dark mode: var(--text), var(--dim), var(--accent), var(--red), var(--amber), var(--green), var(--bg2), var(--line). Keep it short enough to read in a minute.",
            "inputSchema": {
                "type": "object",
                "properties": {
                    "html": { "type": "string", "description": "The report, as an HTML fragment." },
                    "title": { "type": "string", "description": "A short title shown above it." },
                    "agent": agent
                },
                "required": ["html"]
            },
            "annotations": { "destructiveHint": false, "idempotentHint": true }
        },
        {
            "name": "clear_report",
            "title": "Remove the summary report",
            "description": "Remove the summary report from the top of WinT's Projects window.",
            "inputSchema": { "type": "object", "properties": {} },
            "annotations": { "destructiveHint": true, "idempotentHint": true }
        }
    ])
}

/// What a client calls itself, as the cards should name it.
fn agent_name(client: &str) -> String {
    match client.trim() {
        "" => "MCP agent".into(),
        "claude-ai" | "claude-desktop" => "Claude Desktop".into(),
        "claude-code" => "Claude Code".into(),
        other => other.chars().take(60).collect(),
    }
}

fn arg<'a>(args: &'a Value, name: &str) -> Option<&'a Value> {
    args.get(name).filter(|v| !v.is_null())
}

fn call(name: &str, args: &Value, client: &str) -> Result<Value, String> {
    let agent = agent_name(client);
    let project = || arg(args, "project").and_then(Value::as_str).unwrap_or("").to_string();
    match name {
        "list_projects" => Ok(cockpit::overview(arg(args, "status").and_then(Value::as_str))),
        "get_project" => cockpit::project(&project()),
        "update_project" => {
            let mut update = args.clone();
            if let Value::Object(map) = &mut update {
                map.remove("project");
            }
            cockpit::apply_as_agent(&project(), &update, &agent).map(|o| json!(o))
        }
        "add_note" => {
            let note = json!({
                "kind": arg(args, "kind").cloned().unwrap_or(json!("Note")),
                "text": arg(args, "text").cloned().unwrap_or(json!("")),
                "source": arg(args, "source").cloned().unwrap_or(json!("")),
            });
            let mut update = json!({ "addNotes": [note] });
            if let Some(who) = arg(args, "agent") {
                update["agent"] = who.clone();
            }
            cockpit::apply_as_agent(&project(), &update, &agent).map(|o| json!(o))
        }
        "clear_project" => {
            cockpit::clear_as_agent(&project()).map(|had| json!({ "cleared": had, "project": project() }))
        }
        "set_report" => {
            let text = |n: &str| arg(args, n).and_then(Value::as_str).unwrap_or("").to_string();
            let who = { let named = text("agent"); if named.trim().is_empty() { agent.clone() } else { named } };
            cockpit::set_report(&text("html"), &text("title"), &who).map(|r| {
                json!({ "shown": true, "title": r.title, "bytes": r.html.len(), "updatedAt": r.updated_at })
            })
        }
        "clear_report" => cockpit::clear_report().map(|had| json!({ "cleared": had })),
        other => Err(format!("No tool called {other}.")),
    }
}

/// One message in, at most one reply out. Notifications and stray responses
/// get no reply, as JSON-RPC requires.
fn handle(message: &Value, client: &mut String) -> Option<Value> {
    let method = message.get("method")?.as_str().unwrap_or("");
    let id = message.get("id").cloned()?;
    let params = message.get("params").cloned().unwrap_or(Value::Null);
    let result: Result<Value, (i64, String)> = match method {
        "initialize" => {
            *client = params
                .pointer("/clientInfo/name")
                .and_then(Value::as_str)
                .unwrap_or("")
                .to_string();
            let asked = params.get("protocolVersion").and_then(Value::as_str).unwrap_or("");
            let version = if PROTOCOL_VERSIONS.contains(&asked) { asked } else { PROTOCOL_VERSIONS[0] };
            Ok(json!({
                "protocolVersion": version,
                "capabilities": { "tools": { "listChanged": false } },
                "serverInfo": { "name": "wint-cockpit", "title": "WinT Projects cockpit", "version": env!("CARGO_PKG_VERSION") },
                "instructions": INSTRUCTIONS,
            }))
        }
        "ping" => Ok(json!({})),
        "tools/list" => Ok(json!({ "tools": tools() })),
        "tools/call" => {
            let name = params.get("name").and_then(Value::as_str).unwrap_or("");
            let args = params.get("arguments").cloned().unwrap_or_else(|| json!({}));
            // A tool that fails is still a successful call: the model reads the
            // error and can correct itself, which a protocol error would hide.
            Ok(match call(name, &args, client) {
                Ok(value) => json!({
                    "content": [{ "type": "text", "text": serde_json::to_string_pretty(&value).unwrap_or_default() }],
                    "isError": false,
                }),
                Err(error) => json!({
                    "content": [{ "type": "text", "text": error }],
                    "isError": true,
                }),
            })
        }
        "resources/list" => Ok(json!({ "resources": [] })),
        "prompts/list" => Ok(json!({ "prompts": [] })),
        other => Err((-32601, format!("Method not found: {other}"))),
    };
    Some(match result {
        Ok(result) => json!({ "jsonrpc": "2.0", "id": id, "result": result }),
        Err((code, message)) => json!({ "jsonrpc": "2.0", "id": id, "error": { "code": code, "message": message } }),
    })
}

/// Serves until the client closes stdin.
pub fn serve() -> Result<(), String> {
    let stdin = std::io::stdin();
    let mut out = std::io::stdout().lock();
    let mut client = String::new();
    eprintln!("wint mcp: serving the Projects cockpit from {}", cockpit::dir().map(|d| d.display().to_string()).unwrap_or_default());
    for line in stdin.lock().lines() {
        let line = line.map_err(|e| e.to_string())?;
        // A BOM is what PowerShell puts in front of anything piped into us.
        let line = line.trim_start_matches('\u{feff}');
        if line.trim().is_empty() {
            continue;
        }
        let reply = match serde_json::from_str::<Value>(line) {
            Ok(Value::Array(batch)) => {
                let replies: Vec<Value> = batch.iter().filter_map(|m| handle(m, &mut client)).collect();
                (!replies.is_empty()).then_some(Value::Array(replies))
            }
            Ok(message) => handle(&message, &mut client),
            Err(e) => Some(json!({
                "jsonrpc": "2.0", "id": null,
                "error": { "code": -32700, "message": format!("Parse error: {e}") }
            })),
        };
        if let Some(reply) = reply {
            writeln!(out, "{reply}").map_err(|e| e.to_string())?;
            out.flush().map_err(|e| e.to_string())?;
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn initialize_answers_in_the_clients_version_and_notifications_get_nothing() {
        let mut client = String::new();
        let reply = handle(
            &json!({"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2024-11-05","clientInfo":{"name":"claude-ai"}}}),
            &mut client,
        )
        .unwrap();
        assert_eq!(reply["result"]["protocolVersion"], "2024-11-05");
        assert_eq!(agent_name(&client), "Claude Desktop");
        assert!(handle(&json!({"jsonrpc":"2.0","method":"notifications/initialized"}), &mut client).is_none());
        let tools = handle(&json!({"jsonrpc":"2.0","id":2,"method":"tools/list"}), &mut client).unwrap();
        assert_eq!(tools["result"]["tools"].as_array().unwrap().len(), 7);
    }
}
