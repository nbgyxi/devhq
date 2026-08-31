//! Headless check that a page view actually reaches PageRain, so the reporting
//! can be exercised without launching the window:
//! `cargo run --example analytics_cli -- /overview`
//!
//! The id is a throwaway, not the one the app keeps for the user.
fn main() {
    let path = std::env::args()
        .nth(1)
        .unwrap_or_else(|| "/overview".into());
    let visitor = "devhq-cli-check";
    match devhq_lib::analytics::page_view(visitor, &path) {
        Ok(()) => println!("sent {path} as {visitor}"),
        Err(why) => {
            eprintln!("not sent: {why}");
            std::process::exit(1);
        }
    }
}
