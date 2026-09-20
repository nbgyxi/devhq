//! Headless smoke test for the Wi-Fi reader, so the radio, the current link
//! and the networks in range can be checked without launching the window:
//! `cargo run --example wifi_cli`
fn main() {
    println!("current: {:?}", wint_lib::wifi::current());
    for network in wint_lib::wifi::networks() {
        println!(
            "{:<32} {:>3}%  secured={} known={} connected={}",
            network.ssid, network.signal, network.secured, network.known, network.connected
        );
    }
}
