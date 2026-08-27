use serde::Serialize;
use std::path::Path;

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct Tech {
    pub name: String,
    /// Declared version as written in the manifest (`^18.2.0`, `2021`, ...), or
    /// empty when the manifest only proves the technology is present.
    pub version: String,
    /// One of: lang, runtime, framework, ui, build, data, test, infra, tool.
    pub kind: String,
}

#[derive(Serialize, Clone, Default)]
#[serde(rename_all = "camelCase")]
pub struct TechReport {
    pub tech: Vec<Tech>,
    pub description: String,
    pub version: String,
    pub package_manager: String,
    pub scripts: Vec<[String; 2]>,
    pub dep_count: u32,
    pub dev_dep_count: u32,
    pub flags: Vec<String>,
}

/// Dependency name -> (display name, kind). The lookup is exact, so `react` and
/// `react-native` never claim each other's entry.
const DEP_MAP: &[(&str, &str, &str)] = &[
    ("next", "Next.js", "framework"),
    ("nuxt", "Nuxt", "framework"),
    ("@sveltejs/kit", "SvelteKit", "framework"),
    ("@angular/core", "Angular", "framework"),
    ("@nestjs/core", "NestJS", "framework"),
    ("astro", "Astro", "framework"),
    ("expo", "Expo", "framework"),
    ("react-native", "React Native", "framework"),
    ("electron", "Electron", "framework"),
    ("@tauri-apps/cli", "Tauri", "framework"),
    ("react", "React", "ui"),
    ("vue", "Vue", "ui"),
    ("svelte", "Svelte", "ui"),
    ("solid-js", "Solid", "ui"),
    ("tailwindcss", "Tailwind", "ui"),
    ("typescript", "TypeScript", "lang"),
    ("vite", "Vite", "build"),
    ("webpack", "webpack", "build"),
    ("esbuild", "esbuild", "build"),
    ("rollup", "Rollup", "build"),
    ("express", "Express", "framework"),
    ("fastify", "Fastify", "framework"),
    ("koa", "Koa", "framework"),
    ("hono", "Hono", "framework"),
    ("socket.io", "Socket.IO", "framework"),
    ("prisma", "Prisma", "data"),
    ("@prisma/client", "Prisma", "data"),
    ("drizzle-orm", "Drizzle", "data"),
    ("mongoose", "MongoDB", "data"),
    ("pg", "Postgres", "data"),
    ("mysql2", "MySQL", "data"),
    ("better-sqlite3", "SQLite", "data"),
    ("redis", "Redis", "data"),
    ("firebase", "Firebase", "data"),
    ("firebase-admin", "Firebase", "data"),
    ("@supabase/supabase-js", "Supabase", "data"),
    ("@google-cloud/firestore", "Firestore", "data"),
    ("stripe", "Stripe", "data"),
    ("@anthropic-ai/sdk", "Anthropic SDK", "data"),
    ("openai", "OpenAI SDK", "data"),
    ("jest", "Jest", "test"),
    ("vitest", "Vitest", "test"),
    ("@playwright/test", "Playwright", "test"),
    ("playwright", "Playwright", "test"),
    ("cypress", "Cypress", "test"),
];

const CARGO_MAP: &[(&str, &str, &str)] = &[
    ("tauri", "Tauri", "framework"),
    ("axum", "Axum", "framework"),
    ("actix-web", "Actix", "framework"),
    ("rocket", "Rocket", "framework"),
    ("tokio", "Tokio", "runtime"),
    ("serde", "Serde", "tool"),
    ("reqwest", "reqwest", "tool"),
    ("sqlx", "SQLx", "data"),
    ("diesel", "Diesel", "data"),
    ("bevy", "Bevy", "framework"),
];

const PY_MAP: &[(&str, &str, &str)] = &[
    ("django", "Django", "framework"),
    ("flask", "Flask", "framework"),
    ("fastapi", "FastAPI", "framework"),
    ("streamlit", "Streamlit", "framework"),
    ("torch", "PyTorch", "data"),
    ("tensorflow", "TensorFlow", "data"),
    ("pandas", "pandas", "data"),
    ("numpy", "NumPy", "data"),
    ("anthropic", "Anthropic SDK", "data"),
    ("openai", "OpenAI SDK", "data"),
];

pub fn inspect(path: &Path) -> TechReport {
    let mut r = TechReport::default();

    // ---- Node ----------------------------------------------------------
    if let Some(pkg) = read_json(&path.join("package.json")) {
        push(&mut r, "Node", &engine_node(&pkg, path), "runtime");
        r.description = str_of(&pkg, "description");
        r.version = str_of(&pkg, "version");
        if let Some(scripts) = pkg.get("scripts").and_then(|s| s.as_object()) {
            r.scripts = scripts
                .iter()
                .map(|(k, v)| [k.clone(), v.as_str().unwrap_or("").to_string()])
                .collect();
            r.scripts.sort_by(|a, b| a[0].cmp(&b[0]));
        }
        let deps = pkg.get("dependencies").and_then(|d| d.as_object());
        let dev = pkg.get("devDependencies").and_then(|d| d.as_object());
        r.dep_count = deps.map(|d| d.len() as u32).unwrap_or(0);
        r.dev_dep_count = dev.map(|d| d.len() as u32).unwrap_or(0);
        for table in [deps, dev].into_iter().flatten() {
            for (name, display, kind) in DEP_MAP {
                if let Some(v) = table.get(*name).and_then(|v| v.as_str()) {
                    push(&mut r, display, v, kind);
                }
            }
        }
        r.package_manager = if path.join("pnpm-lock.yaml").exists() {
            "pnpm"
        } else if path.join("yarn.lock").exists() {
            "yarn"
        } else if path.join("bun.lockb").exists() || path.join("bun.lock").exists() {
            "bun"
        } else if path.join("package-lock.json").exists() {
            "npm"
        } else {
            "none"
        }
        .to_string();
        if !path.join("node_modules").exists() {
            r.flags.push("deps not installed".into());
        }
    }

    // ---- Rust ----------------------------------------------------------
    for cargo in [path.join("Cargo.toml"), path.join("src-tauri/Cargo.toml")] {
        let Ok(text) = std::fs::read_to_string(&cargo) else { continue };
        let edition = toml_value(&text, "package", "edition").unwrap_or_default();
        let rust_version = toml_value(&text, "package", "rust-version").unwrap_or_default();
        let shown = if rust_version.is_empty() { edition } else { rust_version };
        push(&mut r, "Rust", &shown, "lang");
        if r.version.is_empty() {
            r.version = toml_value(&text, "package", "version").unwrap_or_default();
        }
        for (name, display, kind) in CARGO_MAP {
            if let Some(v) = toml_dep_version(&text, name) {
                push(&mut r, display, &v, kind);
            }
        }
    }
    if let Some(conf) = read_json(&path.join("src-tauri/tauri.conf.json")) {
        let v = str_of(&conf, "version");
        if !v.is_empty() {
            r.version = v;
        }
        push(&mut r, "Tauri", "", "framework");
    }

    // ---- Python --------------------------------------------------------
    let py_manifests = ["pyproject.toml", "requirements.txt", "Pipfile", "setup.py"];
    if py_manifests.iter().any(|f| path.join(f).exists()) {
        let pyver = std::fs::read_to_string(path.join(".python-version"))
            .map(|s| s.trim().to_string())
            .unwrap_or_default();
        push(&mut r, "Python", &pyver, "runtime");
        let mut blob = String::new();
        for f in py_manifests {
            if let Ok(t) = std::fs::read_to_string(path.join(f)) {
                blob.push_str(&t.to_lowercase());
                blob.push('\n');
            }
        }
        for (name, display, kind) in PY_MAP {
            if blob.contains(name) {
                push(&mut r, display, "", kind);
            }
        }
    }

    // ---- Go / .NET / Java ----------------------------------------------
    if let Ok(gomod) = std::fs::read_to_string(path.join("go.mod")) {
        let v = gomod
            .lines()
            .find_map(|l| l.strip_prefix("go "))
            .unwrap_or("")
            .trim()
            .to_string();
        push(&mut r, "Go", &v, "lang");
    }
    if let Some(proj) = first_match(path, &["csproj", "sln", "fsproj"]) {
        let framework = std::fs::read_to_string(&proj)
            .ok()
            .and_then(|t| between(&t, "<TargetFramework>", "</TargetFramework>"))
            .unwrap_or_default();
        push(&mut r, ".NET", &framework, "runtime");
    }
    if path.join("pom.xml").exists() || path.join("build.gradle").exists() {
        push(&mut r, "Java", "", "lang");
    }

    // ---- Infra ----------------------------------------------------------
    if path.join("Dockerfile").exists() {
        push(&mut r, "Docker", "", "infra");
    }
    if path.join("docker-compose.yml").exists() || path.join("docker-compose.yaml").exists() {
        push(&mut r, "Compose", "", "infra");
    }
    if path.join(".github/workflows").exists() {
        push(&mut r, "GitHub Actions", "", "infra");
    }
    if path.join("vercel.json").exists() {
        push(&mut r, "Vercel", "", "infra");
    }
    if path.join("app.yaml").exists() || path.join("cloudbuild.yaml").exists() {
        push(&mut r, "Google Cloud", "", "infra");
    }
    if path.join("terraform").exists() || first_match(path, &["tf"]).is_some() {
        push(&mut r, "Terraform", "", "infra");
    }
    if let Some(app) = read_json(&path.join("app.json")) {
        if app.get("expo").is_some() {
            push(&mut r, "Expo", "", "framework");
        }
    }
    if r.tech.is_empty() && path.join("index.html").exists() {
        push(&mut r, "Static site", "", "framework");
    }

    // ---- Housekeeping flags ---------------------------------------------
    if !path.join("README.md").exists() && !path.join("readme.md").exists() {
        r.flags.push("no README".into());
    }
    if path.join(".env").exists() {
        r.flags.push(".env present".into());
    }
    if path.join("CLAUDE.md").exists() {
        r.flags.push("CLAUDE.md".into());
    }
    r
}

/// Adds a technology unless it was already recorded. First writer wins, so the
/// manifest that carries a version beats a later bare presence check.
fn push(r: &mut TechReport, name: &str, version: &str, kind: &str) {
    if r.tech.iter().any(|t| t.name == name) {
        return;
    }
    r.tech.push(Tech {
        name: name.to_string(),
        version: version.to_string(),
        kind: kind.to_string(),
    });
}

fn read_json(path: &Path) -> Option<serde_json::Value> {
    let text = std::fs::read_to_string(path).ok()?;
    serde_json::from_str(&text).ok()
}

fn str_of(v: &serde_json::Value, key: &str) -> String {
    v.get(key).and_then(|x| x.as_str()).unwrap_or("").to_string()
}

fn engine_node(pkg: &serde_json::Value, path: &Path) -> String {
    if let Some(v) = pkg.get("engines").and_then(|e| e.get("node")).and_then(|n| n.as_str()) {
        return v.to_string();
    }
    std::fs::read_to_string(path.join(".nvmrc"))
        .map(|s| s.trim().to_string())
        .unwrap_or_default()
}

/// Minimal TOML reader: the value of `key` inside `[section]`. Enough for the
/// handful of scalar fields we want without pulling in a TOML parser.
fn toml_value(text: &str, section: &str, key: &str) -> Option<String> {
    let header = format!("[{section}]");
    let mut in_section = false;
    for line in text.lines() {
        let line = line.trim();
        if line.starts_with('[') {
            in_section = line == header;
            continue;
        }
        if !in_section {
            continue;
        }
        let Some(rest) = line.strip_prefix(key) else { continue };
        let rest = rest.trim_start();
        if let Some(v) = rest.strip_prefix('=') {
            return Some(v.trim().trim_matches('"').to_string());
        }
    }
    None
}

/// Version of a Cargo dependency, from either `dep = "1.2"` or
/// `dep = { version = "1.2", ... }`, in any `[*dependencies]` table.
fn toml_dep_version(text: &str, dep: &str) -> Option<String> {
    let mut in_deps = false;
    for line in text.lines() {
        let line = line.trim();
        if line.starts_with('[') {
            in_deps = line.contains("dependencies]");
            continue;
        }
        if !in_deps {
            continue;
        }
        let Some(rest) = line.strip_prefix(dep) else { continue };
        let rest = rest.trim_start();
        let Some(rest) = rest.strip_prefix('=') else { continue };
        let rest = rest.trim();
        if rest.starts_with('{') {
            return Some(between(rest, "version = \"", "\"").unwrap_or_default());
        }
        return Some(rest.trim_matches('"').to_string());
    }
    None
}

fn between(text: &str, start: &str, end: &str) -> Option<String> {
    let i = text.find(start)? + start.len();
    let j = text[i..].find(end)? + i;
    Some(text[i..j].to_string())
}

/// First direct child of `path` carrying one of the given extensions.
fn first_match(path: &Path, exts: &[&str]) -> Option<std::path::PathBuf> {
    for entry in std::fs::read_dir(path).ok()?.flatten() {
        let p = entry.path();
        if let Some(ext) = p.extension().and_then(|e| e.to_str()) {
            if exts.iter().any(|e| e.eq_ignore_ascii_case(ext)) {
                return Some(p);
            }
        }
    }
    None
}
