//! Headless smoke test for the health recorder, so the log path, the panic
//! hook, the in-flight register and the report can be checked without
//! launching the window: `cargo run --example health_cli`
fn main() {
    wint_lib::health::start("0.120.0 (test)");
    let job = wint_lib::health::job_started("health_cli.rs:1");
    println!("in flight: {}", wint_lib::health::in_flight_summary());
    wint_lib::health::job_finished(job);
    wint_lib::health::record("ui", "a line from the window");

    // A panic on another thread must reach the log and not the void.
    let _ = std::thread::spawn(|| panic!("a deliberate test panic")).join();

    let report = wint_lib::health::report(20);
    println!("log: {}", report.path);
    println!("in flight now: {}", report.in_flight);
    for line in report.lines {
        println!("  {line}");
    }
}
