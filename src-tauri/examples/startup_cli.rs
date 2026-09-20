//! Headless smoke test for the Startup and tray tool, so the registry reads,
//! the shortcut targets and the tray matching can be checked without launching
//! the window: `cargo run --example startup_cli`
fn main() {
    println!("== starts with Windows ==");
    for entry in wint_lib::startup::entries() {
        println!(
            "[{}] {:<34} {:<26} running={} tray={}\n      {}",
            if entry.enabled { "on " } else { "off" },
            entry.name,
            entry.source,
            entry.running,
            entry.tray,
            entry.command,
        );
    }
    println!("\n== notification area ==");
    for icon in wint_lib::startup::tray_icons() {
        println!(
            "{:<34} running={:<5} promoted={:<5} {}",
            icon.name, icon.running, icon.promoted, icon.origin,
        );
    }
}
