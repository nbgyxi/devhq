use serde::Serialize;
use serde_json::Value;
use std::process::Command;

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GhStatus {
    pub installed: bool,
    pub authenticated: bool,
    pub login: String,
    pub host: String,
    pub error: String,
}

fn command() -> Command {
    let mut cmd = Command::new("gh");
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        const CREATE_NO_WINDOW: u32 = 0x0800_0000;
        cmd.creation_flags(CREATE_NO_WINDOW);
    }
    cmd
}

#[tauri::command]
pub fn github_status() -> GhStatus {
    let version = command().arg("--version").output();
    if version.is_err() {
        return GhStatus {
            installed: false,
            authenticated: false,
            login: String::new(),
            host: String::new(),
            error: "GitHub CLI (gh) was not found on PATH.".into(),
        };
    }
    let out = command().args(["api", "user"]).output();
    match out {
        Ok(out) if out.status.success() => {
            let value: Value = serde_json::from_slice(&out.stdout).unwrap_or(Value::Null);
            GhStatus {
                installed: true,
                authenticated: true,
                login: value
                    .get("login")
                    .and_then(Value::as_str)
                    .unwrap_or("")
                    .into(),
                host: "github.com".into(),
                error: String::new(),
            }
        }
        Ok(out) => GhStatus {
            installed: true,
            authenticated: false,
            login: String::new(),
            host: "github.com".into(),
            error: String::from_utf8_lossy(&out.stderr).trim().into(),
        },
        Err(err) => GhStatus {
            installed: true,
            authenticated: false,
            login: String::new(),
            host: String::new(),
            error: err.to_string(),
        },
    }
}

fn safe_endpoint(endpoint: &str) -> bool {
    !endpoint.is_empty()
        && endpoint.len() < 1000
        && !endpoint.starts_with('-')
        && !endpoint
            .chars()
            .any(|c| c == '\0' || c == '\r' || c == '\n')
        && (endpoint.starts_with('/')
            || endpoint.starts_with("repos/")
            || endpoint.starts_with("notifications")
            || endpoint.starts_with("search/")
            || endpoint.starts_with("user")
            || endpoint.starts_with("rate_limit")
            || endpoint.starts_with("orgs/"))
}

#[tauri::command]
pub async fn github_api(
    method: String,
    endpoint: String,
    body: Option<Value>,
) -> Result<Value, String> {
    let method = method.to_uppercase();
    if !matches!(method.as_str(), "GET" | "POST" | "PUT" | "PATCH" | "DELETE")
        || !safe_endpoint(&endpoint)
    {
        return Err("Blocked unsafe GitHub API request.".into());
    }
    tauri::async_runtime::spawn_blocking(move || {
        let mut cmd = command();
        cmd.args([
            "api",
            "--method",
            &method,
            &endpoint,
            "--header",
            "Accept: application/vnd.github+json",
        ]);
        let input = body.map(|value| value.to_string());
        if input.is_some() {
            cmd.arg("--input").arg("-");
        }
        cmd.stdin(if input.is_some() {
            std::process::Stdio::piped()
        } else {
            std::process::Stdio::null()
        });
        cmd.stdout(std::process::Stdio::piped())
            .stderr(std::process::Stdio::piped());
        let mut child = cmd
            .spawn()
            .map_err(|e| format!("Could not start gh: {e}"))?;
        if let Some(input) = input {
            use std::io::Write;
            child
                .stdin
                .take()
                .ok_or("Could not open gh input")?
                .write_all(input.as_bytes())
                .map_err(|e| e.to_string())?;
        }
        let out = child.wait_with_output().map_err(|e| e.to_string())?;
        if !out.status.success() {
            let message = String::from_utf8_lossy(&out.stderr).trim().to_string();
            return Err(if message.is_empty() {
                format!("GitHub API returned {}", out.status)
            } else {
                message
            });
        }
        if out.stdout.is_empty() {
            return Ok(Value::Null);
        }
        serde_json::from_slice(&out.stdout).map_err(|e| format!("Invalid response from gh: {e}"))
    })
    .await
    .map_err(|e| e.to_string())?
}
