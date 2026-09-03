use super::provider::{ToolCall, ToolDefinition};
use serde_json::{json, Value};
use std::{
    collections::HashSet,
    fs,
    path::{Path, PathBuf},
    process::Command,
};
use tauri::{AppHandle, Emitter};
#[derive(Clone, Copy, Debug, PartialEq)]
pub enum Risk {
    Read,
}
pub struct ToolRegistry {
    roots: Vec<PathBuf>,
    enabled: HashSet<String>,
    area_tools: Vec<(String, String)>,
    app: Option<AppHandle>,
}
impl ToolRegistry {
    pub fn routed(app: Option<AppHandle>, roots: Vec<String>, areas: &[String]) -> Self {
        let mut enabled = HashSet::new();
        let mut area_tools = Vec::new();
        if areas.iter().any(|area| area == "project") {
            enabled.extend(
                [
                    "list_project_files",
                    "read_project_file",
                    "search_project_text",
                ]
                .map(str::to_string),
            );
        }
        if areas
            .iter()
            .any(|area| matches!(area.as_str(), "path-ping" | "network"))
        {
            enabled.insert("ping".into());
        }
        for area in areas {
            let names: &[&str] = match area.as_str() {
                "ports" => &["list_ports"],
                "dns" => &["dns_lookup", "dns_compare", "dns_reverse"],
                "hosts" => &["read_hosts"],
                "network" => &[
                    "network_capability",
                    "network_components",
                    "network_backlog",
                    "network_rate",
                ],
                "disk-space" => &["disk_drives", "disk_scan"],
                "windows:events" => &["query_event_log"],
                "windows:registry" => &["list_registry"],
                "windows:system" => &["system_report"],
                "windows:log-tail" => &["tail_log"],
                "windows:lock-inspector" => &["inspect_locks"],
                "windows:repair-swap" => &["list_audio_devices"],
                "windows:time-tracker" => &["active_window"],
                id if id.starts_with("windows:repair-") => &["list_repair_targets"],
                _ => &[],
            };
            enabled.extend(names.iter().copied().map(str::to_string));
        }
        for area in areas {
            if area == "text" || area == "general" || area == "project" {
                continue;
            }
            let tool_id = area
                .strip_prefix("utility:")
                .or_else(|| area.strip_prefix("windows:"))
                .unwrap_or(area);
            let name = format!(
                "open_{}",
                area.chars()
                    .map(|c| if c.is_ascii_alphanumeric() { c } else { '_' })
                    .collect::<String>()
            );
            enabled.insert(name.clone());
            area_tools.push((name, tool_id.to_string()));
        }
        Self {
            roots: roots
                .into_iter()
                .filter_map(|r| fs::canonicalize(r).ok())
                .collect(),
            enabled,
            area_tools,
            app,
        }
    }
    pub fn definitions(&self) -> Vec<ToolDefinition> {
        let mut tools = vec![
            ToolDefinition {
                name: "list_project_files".into(),
                description: "List files below a project directory open in WinT.".into(),
                parameters: json!({"type":"object","properties":{"path":{"type":"string"}},"required":["path"],"additionalProperties":false}),
            },
            ToolDefinition {
                name: "read_project_file".into(),
                description: "Read up to 64 KB from one UTF-8 file below a WinT project root."
                    .into(),
                parameters: json!({"type":"object","properties":{"path":{"type":"string"}},"required":["path"],"additionalProperties":false}),
            },
            ToolDefinition {
                name: "search_project_text".into(),
                description: "Search text files below a WinT project root for a literal query."
                    .into(),
                parameters: json!({"type":"object","properties":{"path":{"type":"string"},"query":{"type":"string"}},"required":["path","query"],"additionalProperties":false}),
            },
        ];
        tools.push(ToolDefinition {
            name: "ping".into(),
            description: "Ping one domain name or IP address and return the probe output.".into(),
            parameters: json!({"type":"object","properties":{"domain":{"type":"string","description":"Domain name or IP address to ping"}},"required":["domain"],"additionalProperties":false}),
        });
        let simple = [
            (
                "list_ports",
                "List current listening ports and their owning processes.",
                json!({"type":"object","properties":{},"additionalProperties":false}),
            ),
            (
                "dns_lookup",
                "Look up DNS records for a domain.",
                json!({"type":"object","properties":{"domain":{"type":"string"},"server":{"type":"string"},"types":{"type":"array","items":{"type":"string"}}},"required":["domain"],"additionalProperties":false}),
            ),
            (
                "dns_compare",
                "Compare one DNS record across configured and public resolvers.",
                json!({"type":"object","properties":{"domain":{"type":"string"},"recordType":{"type":"string"}},"required":["domain"],"additionalProperties":false}),
            ),
            (
                "dns_reverse",
                "Perform a reverse DNS lookup for an IP address.",
                json!({"type":"object","properties":{"address":{"type":"string"}},"required":["address"],"additionalProperties":false}),
            ),
            (
                "read_hosts",
                "Read and parse the Windows hosts file without changing it.",
                json!({"type":"object","properties":{},"additionalProperties":false}),
            ),
            (
                "network_capability",
                "Inspect packet-capture availability and current capability.",
                json!({"type":"object","properties":{},"additionalProperties":false}),
            ),
            (
                "network_components",
                "List network components available to packet capture.",
                json!({"type":"object","properties":{},"additionalProperties":false}),
            ),
            (
                "network_backlog",
                "Read recently captured network frames.",
                json!({"type":"object","properties":{"limit":{"type":"integer","minimum":1,"maximum":200}},"additionalProperties":false}),
            ),
            (
                "network_rate",
                "Read current packet and byte capture rates.",
                json!({"type":"object","properties":{},"additionalProperties":false}),
            ),
            (
                "disk_drives",
                "List local drives with total and free space.",
                json!({"type":"object","properties":{},"additionalProperties":false}),
            ),
            (
                "disk_scan",
                "Scan one directory and return its largest immediate children.",
                json!({"type":"object","properties":{"path":{"type":"string"}},"required":["path"],"additionalProperties":false}),
            ),
            (
                "query_event_log",
                "Query recent Windows Event Log records.",
                json!({"type":"object","properties":{"channels":{"type":"array","items":{"enum":["Application","System","Security"]}},"levels":{"type":"array","items":{"type":"string"}},"text":{"type":"string"},"limit":{"type":"integer","minimum":1,"maximum":200}},"additionalProperties":false}),
            ),
            (
                "list_registry",
                "Read keys and values at a Windows registry path.",
                json!({"type":"object","properties":{"path":{"type":"string"}},"required":["path"],"additionalProperties":false}),
            ),
            (
                "system_report",
                "Audit PATH entries and environment variables.",
                json!({"type":"object","properties":{},"additionalProperties":false}),
            ),
            (
                "tail_log",
                "Read the newest lines from a local log file.",
                json!({"type":"object","properties":{"path":{"type":"string"},"lines":{"type":"integer","minimum":10,"maximum":2000}},"required":["path"],"additionalProperties":false}),
            ),
            (
                "inspect_locks",
                "Find processes holding a file or folder open.",
                json!({"type":"object","properties":{"path":{"type":"string"}},"required":["path"],"additionalProperties":false}),
            ),
            (
                "list_audio_devices",
                "List playback and recording audio devices.",
                json!({"type":"object","properties":{},"additionalProperties":false}),
            ),
            (
                "active_window",
                "Read the current foreground application and window title.",
                json!({"type":"object","properties":{},"additionalProperties":false}),
            ),
            (
                "list_repair_targets",
                "List devices or resources that the selected repair tool can act on.",
                json!({"type":"object","properties":{"repair":{"type":"string"}},"required":["repair"],"additionalProperties":false}),
            ),
        ];
        tools.extend(
            simple
                .into_iter()
                .map(|(name, description, parameters)| ToolDefinition {
                    name: name.into(),
                    description: description.into(),
                    parameters,
                }),
        );
        tools.extend(self.area_tools.iter().map(|(name, id)| ToolDefinition {
            name: name.clone(),
            description: format!("Open WinT's {id} tool so the user can inspect results or confirm interactive and system-changing actions."),
            parameters: json!({"type":"object","properties":{"input":{"type":"string","description":"Optional value the user wants to use in the tool"}},"additionalProperties":false}),
        }));
        tools.retain(|tool| self.enabled.contains(&tool.name));
        tools
    }
    // Unknown names still enter the dispatcher as read-risk proposals so they
    // can be visibly rejected and fed back to the model. `execute` remains the
    // authority and never runs a name outside the exact match below.
    pub fn risk(&self, name: &str) -> Option<Risk> {
        let canonical = match name {
            "project.list" | "list_files" => "list_project_files",
            "project.read" | "open_file" => "read_project_file",
            "project.search" | "search_files" => "search_project_text",
            other => other,
        };
        self.enabled.contains(canonical).then_some(Risk::Read)
    }
    fn allowed(&self, value: &Value, file: bool) -> Result<PathBuf, String> {
        let raw = value
            .get("path")
            .and_then(Value::as_str)
            .ok_or("Tool path must be a string.")?;
        let path =
            fs::canonicalize(raw).map_err(|_| "The requested project path does not exist.")?;
        if !self.roots.iter().any(|root| path.starts_with(root)) {
            return Err("Tool path is outside WinT's project roots.".into());
        }
        if file && !path.is_file() {
            return Err("The requested path is not a file.".into());
        }
        if !file && !path.is_dir() {
            return Err("The requested path is not a directory.".into());
        }
        Ok(path)
    }
    pub fn execute(&self, call: &ToolCall) -> Result<Value, String> {
        if !call.arguments.is_object() {
            return Err("Tool arguments must be a JSON object.".into());
        }
        let name = match call.name.as_str() {
            "project.list" | "list_files" => "list_project_files",
            "project.read" | "open_file" => "read_project_file",
            "project.search" | "search_files" => "search_project_text",
            name => name,
        };
        if !self.enabled.contains(name) {
            return Err("That tool is not available for the routed request.".into());
        }
        match name {
            name if name.starts_with("open_") => {
                let (_, id) = self
                    .area_tools
                    .iter()
                    .find(|(tool, _)| tool == name)
                    .ok_or("Unknown WinT tool route.")?;
                let input = call
                    .arguments
                    .get("input")
                    .and_then(Value::as_str)
                    .unwrap_or("");
                if let Some(app) = &self.app {
                    app.emit("assistant:open-tool", json!({"id":id,"input":input}))
                        .map_err(|e| e.to_string())?;
                }
                Ok(
                    json!({"opened":id,"input":input,"interactive":true,"message":"The WinT tool was opened. The user remains in control of interactive or system-changing actions."}),
                )
            }
            "list_ports" => {
                serde_json::to_value(crate::procs::port_list()).map_err(|e| e.to_string())
            }
            "dns_lookup" => {
                let domain = required_str(&call.arguments, "domain")?;
                let server = call
                    .arguments
                    .get("server")
                    .and_then(Value::as_str)
                    .unwrap_or("");
                let types: Vec<String> = call
                    .arguments
                    .get("types")
                    .and_then(Value::as_array)
                    .map(|items| {
                        items
                            .iter()
                            .filter_map(Value::as_str)
                            .map(str::to_string)
                            .collect::<Vec<String>>()
                    })
                    .unwrap_or_default();
                serde_json::to_value(crate::dns::lookup(domain, server, &types))
                    .map_err(|e| e.to_string())
            }
            "dns_compare" => {
                let domain = required_str(&call.arguments, "domain")?;
                let record = call
                    .arguments
                    .get("recordType")
                    .and_then(Value::as_str)
                    .unwrap_or("A");
                serde_json::to_value(crate::dns::compare(domain, record)).map_err(|e| e.to_string())
            }
            "dns_reverse" => serde_json::to_value(crate::dns::reverse(required_str(
                &call.arguments,
                "address",
            )?))
            .map_err(|e| e.to_string()),
            "read_hosts" => {
                serde_json::to_value(crate::dns::hosts_read()).map_err(|e| e.to_string())
            }
            "network_capability" => {
                serde_json::to_value(crate::network::capability()).map_err(|e| e.to_string())
            }
            "network_components" => {
                serde_json::to_value(crate::network::components()?).map_err(|e| e.to_string())
            }
            "network_backlog" => serde_json::to_value(crate::network::backlog(
                call.arguments
                    .get("limit")
                    .and_then(Value::as_u64)
                    .unwrap_or(50)
                    .clamp(1, 200) as usize,
            ))
            .map_err(|e| e.to_string()),
            "network_rate" => {
                serde_json::to_value(crate::network::rate()).map_err(|e| e.to_string())
            }
            "disk_drives" => {
                serde_json::to_value(crate::disk_space::drives()?).map_err(|e| e.to_string())
            }
            "disk_scan" => serde_json::to_value(crate::disk_space::scan(
                required_str(&call.arguments, "path")?.into(),
            )?)
            .map_err(|e| e.to_string()),
            "query_event_log" => {
                let strings = |name: &str| {
                    call.arguments
                        .get(name)
                        .and_then(Value::as_array)
                        .map(|values| {
                            values
                                .iter()
                                .filter_map(Value::as_str)
                                .map(str::to_string)
                                .collect::<Vec<_>>()
                        })
                        .unwrap_or_default()
                };
                let channels = strings("channels");
                let query = crate::windows_tools::EventQuery {
                    channels: if channels.is_empty() {
                        vec!["Application".into(), "System".into()]
                    } else {
                        channels
                    },
                    levels: strings("levels"),
                    text: call
                        .arguments
                        .get("text")
                        .and_then(Value::as_str)
                        .unwrap_or("")
                        .chars()
                        .take(200)
                        .collect(),
                    limit: call
                        .arguments
                        .get("limit")
                        .and_then(Value::as_u64)
                        .unwrap_or(50)
                        .clamp(1, 200) as u32,
                };
                serde_json::to_value(crate::windows_tools::event_query(query)?)
                    .map_err(|e| e.to_string())
            }
            "list_registry" => serde_json::to_value(crate::windows_tools::registry_list(
                required_str(&call.arguments, "path")?,
            )?)
            .map_err(|e| e.to_string()),
            "system_report" => serde_json::to_value(crate::windows_tools::system_report()?)
                .map_err(|e| e.to_string()),
            "tail_log" => serde_json::to_value(crate::windows_tools::log_tail(
                required_str(&call.arguments, "path")?,
                call.arguments
                    .get("lines")
                    .and_then(Value::as_u64)
                    .unwrap_or(100)
                    .clamp(10, 2000) as u32,
            )?)
            .map_err(|e| e.to_string()),
            "inspect_locks" => serde_json::to_value(crate::windows_tools::lock_inspect(
                required_str(&call.arguments, "path")?,
            )?)
            .map_err(|e| e.to_string()),
            "list_audio_devices" => serde_json::to_value(crate::windows_tools::audio_devices()?)
                .map_err(|e| e.to_string()),
            "active_window" => serde_json::to_value(crate::windows_tools::active_window()?)
                .map_err(|e| e.to_string()),
            "list_repair_targets" => {
                let repair = required_str(&call.arguments, "repair")?.trim_start_matches("repair-");
                if ![
                    "audio", "swap", "gpu", "bounds", "net", "wifi", "radio", "usb", "shell",
                    "spooler",
                ]
                .contains(&repair)
                {
                    return Err("Unknown repair tool.".into());
                }
                serde_json::to_value(crate::windows_tools::repair_targets(repair)?)
                    .map_err(|e| e.to_string())
            }
            "ping" => {
                let target = call
                    .arguments
                    .get("domain")
                    .and_then(Value::as_str)
                    .map(str::trim)
                    .filter(|value| !value.is_empty() && value.len() <= 253)
                    .ok_or("Ping domain must contain 1 to 253 characters.")?;
                if !target
                    .chars()
                    .all(|c| c.is_ascii_alphanumeric() || matches!(c, '.' | '-' | ':' | '%'))
                {
                    return Err("Ping accepts one domain name or IP address.".into());
                }
                let mut command = Command::new("ping.exe");
                command.args(["-n", "4", "-w", "3000", target]);
                #[cfg(windows)]
                {
                    use std::os::windows::process::CommandExt;
                    command.creation_flags(0x0800_0000);
                }
                let output = command
                    .output()
                    .map_err(|e| format!("Could not start ping: {e}"))?;
                let mut text = String::from_utf8_lossy(&output.stdout).to_string();
                if text.is_empty() {
                    text = String::from_utf8_lossy(&output.stderr).to_string();
                }
                if text.len() > 12000 {
                    text.truncate(12000);
                }
                Ok(json!({"domain":target,"success":output.status.success(),"output":text}))
            }
            "list_project_files" => {
                let root = self.allowed(&call.arguments, false)?;
                let mut rows = Vec::new();
                walk(&root, 0, &mut |p| {
                    if rows.len() < 200 {
                        rows.push(p.strip_prefix(&root).unwrap_or(p).display().to_string())
                    }
                });
                Ok(json!({"files":rows,"truncated":rows.len()>=200}))
            }
            "read_project_file" => {
                let path = self.allowed(&call.arguments, true)?;
                if fs::metadata(&path).map_err(|e| e.to_string())?.len() > 65536 {
                    return Err("That file is larger than the 64 KB read limit.".into());
                }
                let text = String::from_utf8(fs::read(&path).map_err(|e| e.to_string())?)
                    .map_err(|_| "That file is not UTF-8 text.")?;
                Ok(json!({"path":path.display().to_string(),"content":text}))
            }
            "search_project_text" => {
                let root = self.allowed(&call.arguments, false)?;
                let query = call
                    .arguments
                    .get("query")
                    .and_then(Value::as_str)
                    .filter(|q| !q.is_empty() && q.len() <= 200)
                    .ok_or("Search query must contain 1 to 200 characters.")?;
                let mut hits = Vec::new();
                walk(&root, 0, &mut |p| {
                    if hits.len() >= 80 {
                        return;
                    }
                    let Ok(meta) = fs::metadata(p) else { return };
                    if meta.len() > 262144 {
                        return;
                    }
                    let Ok(text) = fs::read_to_string(p) else {
                        return;
                    };
                    for (n, line) in text.lines().enumerate() {
                        if line.contains(query) {
                            hits.push(json!({"path":p.display().to_string(),"line":n+1,"text":line.chars().take(300).collect::<String>()}));
                            if hits.len() >= 80 {
                                break;
                            }
                        }
                    }
                });
                Ok(json!({"matches":hits,"truncated":hits.len()>=80}))
            }
            _ => Err("The model requested an unknown tool.".into()),
        }
    }
}
fn required_str<'a>(args: &'a Value, name: &str) -> Result<&'a str, String> {
    args.get(name)
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|value| !value.is_empty() && value.len() <= 4096)
        .ok_or_else(|| format!("{name} must be a non-empty string."))
}
fn walk(path: &Path, depth: usize, visit: &mut impl FnMut(&Path)) {
    if depth > 5 {
        return;
    }
    let Ok(entries) = fs::read_dir(path) else {
        return;
    };
    for entry in entries.flatten() {
        let p = entry.path();
        let name = entry.file_name();
        let name = name.to_string_lossy();
        if name.starts_with('.')
            || matches!(
                name.as_ref(),
                "node_modules" | "target" | "dist" | "build" | "vendor"
            )
        {
            continue;
        }
        if p.is_dir() {
            walk(&p, depth + 1, visit)
        } else {
            visit(&p)
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::time::{SystemTime, UNIX_EPOCH};
    fn root() -> PathBuf {
        let p = std::env::temp_dir().join(format!(
            "wint-ai-tools-{}",
            SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        fs::create_dir_all(&p).unwrap();
        p
    }
    #[test]
    fn reads_only_below_registered_root() {
        let dir = root();
        let file = dir.join("README.md");
        fs::write(&file, "hello WinT").unwrap();
        let registry = ToolRegistry::routed(None, vec![dir.display().to_string()], &["project".to_string()]);
        let call = ToolCall {
            id: "1".into(),
            name: "read_project_file".into(),
            arguments: json!({"path":file}),
        };
        assert_eq!(registry.execute(&call).unwrap()["content"], "hello WinT");
        let _ = fs::remove_dir_all(dir);
    }
    #[test]
    fn rejects_paths_outside_registered_root() {
        let dir = root();
        let registry = ToolRegistry::routed(None, vec![dir.display().to_string()], &["project".to_string()]);
        let call = ToolCall {
            id: "1".into(),
            name: "read_project_file".into(),
            arguments: json!({"path":std::env::current_exe().unwrap()}),
        };
        assert!(registry.execute(&call).unwrap_err().contains("outside"));
        let _ = fs::remove_dir_all(dir);
    }
    #[test]
    fn ping_route_exposes_only_ping() {
        let registry = ToolRegistry::routed(None, Vec::new(), &["path-ping".into()]);
        let names = registry
            .definitions()
            .into_iter()
            .map(|tool| tool.name)
            .collect::<Vec<_>>();
        assert_eq!(names, vec!["ping", "open_path_ping"]);
        assert!(registry.risk("read_project_file").is_none());
    }
    #[test]
    fn every_app_tool_route_has_a_scoped_call_list() {
        let routes = [
            "ports",
            "dns",
            "hosts",
            "network",
            "path-ping",
            "disk-space",
            "terminal",
            "settings",
            "utility:base64",
            "utility:url",
            "utility:html",
            "utility:hex",
            "utility:binary",
            "utility:sha256",
            "utility:sha512",
            "utility:md5",
            "utility:hmac",
            "utility:jwt",
            "utility:uuid",
            "utility:guid",
            "utility:unix",
            "utility:filetime",
            "utility:json",
            "utility:xml",
            "utility:yaml",
            "utility:markup",
            "utility:csv",
            "utility:any",
            "windows:help",
            "windows:events",
            "windows:registry",
            "windows:system",
            "windows:log-tail",
            "windows:lock-inspector",
            "windows:clipboard",
            "windows:keep-awake",
            "windows:time-tracker",
            "windows:repair-audio",
            "windows:repair-swap",
            "windows:repair-gpu",
            "windows:repair-bounds",
            "windows:repair-net",
            "windows:repair-wifi",
            "windows:repair-radio",
            "windows:repair-usb",
            "windows:repair-shell",
            "windows:repair-spooler",
        ];
        for route in routes {
            let registry = ToolRegistry::routed(None, Vec::new(), &[route.into()]);
            assert!(
                !registry.definitions().is_empty(),
                "missing call list for {route}"
            );
            assert!(registry
                .definitions()
                .iter()
                .all(|tool| registry.enabled.contains(&tool.name)));
        }
    }
    #[test]
    fn text_route_has_no_tools() {
        let registry = ToolRegistry::routed(None, Vec::new(), &["text".into()]);
        assert!(registry.definitions().is_empty());
    }
}
