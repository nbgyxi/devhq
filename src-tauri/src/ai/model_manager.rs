use tauri::AppHandle;

/// Temporary local-runtime bridge. All UI commands pass through the manager,
/// so the app-managed, SHA-verified GGUF installer can replace this adapter
/// without changing conversations, tools, or the panel.
use std::path::PathBuf;
pub fn status(root: PathBuf) -> crate::assistant::Status {
    crate::assistant::status(root)
}
pub fn pull(app: AppHandle, root: PathBuf, model: String) -> Result<(), String> {
    crate::assistant::pull(app, root, model)
}
pub fn cancel_pull() {
    crate::assistant::cancel_pull()
}
pub fn delete_model(root: PathBuf, model: String) -> Result<(), String> {
    crate::assistant::delete_model(root, model)
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
    areas: Vec<crate::assistant::RouteOption>,
    think: bool,
    tool_call_cap: usize,
) -> Result<(), String> {
    crate::assistant::chat(
        app,
        root,
        request_id,
        model,
        question,
        prompt,
        project_context,
        roots,
        areas,
        think,
        tool_call_cap,
    )
}
pub fn cancel_chat() {
    crate::assistant::cancel_chat()
}
