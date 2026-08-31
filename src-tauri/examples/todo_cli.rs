//! Headless check of the TODO / FIXME scan, so it can be exercised without
//! launching the window: `cargo run --example todo_cli -- C:\code\devhq`
fn main() {
    let root = std::env::args().nth(1).unwrap_or_else(|| ".".into());
    let report = devhq_lib::todo::scan(std::path::Path::new(&root));
    for item in &report.items {
        println!("{:6} {}:{}  {}", item.kind, item.file, item.line, item.text);
    }
    println!(
        "-- {} notes, truncated: {}",
        report.items.len(),
        report.truncated
    );
}
