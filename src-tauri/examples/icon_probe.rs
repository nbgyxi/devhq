fn main() {
    // The same call the tool makes, through the startup module.
    for entry in wint_lib::startup::entries() {
        if entry.exe.is_empty() { continue; }
        println!("{:<64} {:?}", entry.exe, wint_lib::startup::icon(&entry.exe).map(|u| u.len()));
    }
}
