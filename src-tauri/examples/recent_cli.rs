//! Why a VS Code-family editor's recent projects are, or are not, in the
//! sidebar's right-click menu.
//!
//! The rail reads that list out of the editor's own state database rather
//! than Windows' jump list, and every step of that read can come back empty
//! for a different reason. This walks the same steps and says which one gave
//! out.
//!
//!     cargo run --example recent_cli            # %APPDATA%\Code
//!     cargo run --example recent_cli Cursor     # any sibling editor

fn main() {
    let stem = std::env::args().nth(1).unwrap_or_else(|| "Code".to_string());
    let Some(appdata) = std::env::var_os("APPDATA") else {
        println!("No APPDATA.");
        return;
    };
    let db = std::path::PathBuf::from(appdata)
        .join(&stem)
        .join("User")
        .join("globalStorage")
        .join("state.vscdb");
    println!("database {}", db.display());
    if !db.is_file() {
        println!("  not there — the rail falls back to Windows' jump list");
        return;
    }

    let connection = match rusqlite::Connection::open_with_flags(
        &db,
        rusqlite::OpenFlags::SQLITE_OPEN_READ_ONLY | rusqlite::OpenFlags::SQLITE_OPEN_NO_MUTEX,
    ) {
        Ok(connection) => connection,
        Err(error) => {
            println!("  could not open it: {error}");
            return;
        }
    };
    let _ = connection.busy_timeout(std::time::Duration::from_millis(200));

    println!("tables:");
    if let Ok(mut statement) = connection.prepare("SELECT name FROM sqlite_master WHERE type = 'table'") {
        if let Ok(rows) = statement.query_map([], |row| row.get::<_, String>(0)) {
            for name in rows.flatten() {
                println!("  {name}");
            }
        }
    }

    // Everything the editor keeps that holds a path, so a list that has moved
    // to a new name is still found.
    println!("keys whose value mentions a folder or file URI:");
    if let Ok(mut statement) = connection
        .prepare("SELECT key, length(value) FROM ItemTable WHERE value LIKE '%folderUri%' OR value LIKE '%fileUri%' OR value LIKE '%file:///%'")
    {
        if let Ok(rows) = statement.query_map([], |row| {
            Ok((row.get::<_, String>(0)?, row.get::<_, i64>(1)?))
        }) {
            let mut any = false;
            for (key, len) in rows.flatten() {
                any = true;
                println!("  {key} ({len} bytes)");
            }
            if !any {
                println!("  none");
            }
        }
    }

    // Which keys look like a recent list at all — the name has moved before.
    println!("keys holding a path history:");
    match connection.prepare("SELECT key, length(value) FROM ItemTable WHERE key LIKE '%recent%' OR key LIKE '%history%'") {
        Ok(mut statement) => {
            let rows = statement.query_map([], |row| {
                Ok((row.get::<_, String>(0)?, row.get::<_, i64>(1)?))
            });
            match rows {
                Ok(rows) => {
                    let mut any = false;
                    for row in rows.flatten() {
                        any = true;
                        println!("  {} ({} bytes)", row.0, row.1);
                    }
                    if !any {
                        println!("  none");
                    }
                }
                Err(error) => println!("  {error}"),
            }
        }
        Err(error) => println!("  {error}"),
    }

    const KEY: &str = "history.recentlyOpenedPathsList";
    let text: Option<String> = connection
        .query_row("SELECT value FROM ItemTable WHERE key = ?1", [KEY], |row| row.get(0))
        .ok();
    let Some(text) = text else {
        println!("{KEY}: not in this database");
        return;
    };
    println!("{KEY}: {} bytes", text.len());

    let value: serde_json::Value = match serde_json::from_str(&text) {
        Ok(value) => value,
        Err(error) => {
            println!("  not JSON: {error}");
            return;
        }
    };
    let Some(entries) = value["entries"].as_array() else {
        let shape: Vec<&String> = value.as_object().map(|map| map.keys().collect()).unwrap_or_default();
        println!("  no `entries` array; top-level keys are {shape:?}");
        return;
    };
    println!("  {} entries", entries.len());
    for entry in entries.iter().take(12) {
        let uri = entry["folderUri"]
            .as_str()
            .or_else(|| entry["workspace"]["configPath"].as_str())
            .or_else(|| entry["fileUri"].as_str());
        match uri {
            // Remote entries (WSL, SSH, containers) have no local path to open.
            Some(uri) if !uri.starts_with("file:///") => println!("  skipped (not local) {uri}"),
            Some(uri) => println!("  {uri}"),
            None => {
                let shape: Vec<&String> = entry.as_object().map(|map| map.keys().collect()).unwrap_or_default();
                println!("  skipped (no uri) keys {shape:?}");
            }
        }
    }
}
