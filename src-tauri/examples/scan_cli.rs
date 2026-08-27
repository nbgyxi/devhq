//! Headless smoke test for the scanner, so the scan can be exercised without
//! launching the window: `cargo run --example scan_cli -- C:\code`
fn main() {
    let root = std::env::args().nth(1).unwrap_or_else(|| r"C:\code".into());
    let result = devhq_lib::scan_root(root);
    println!("{}", serde_json::to_string_pretty(&result).unwrap());
}
