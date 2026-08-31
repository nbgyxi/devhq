fn main() {
    // `package-msix.ps1` sets this for the Store package only. Dev and plain
    // `npm run build` leave it unset, so What's new never hashes a debug exe
    // or shows the checksum work bar outside an official package.
    println!("cargo:rerun-if-env-changed=DEVHQ_OFFICIAL_BUILD");
    if std::env::var_os("DEVHQ_OFFICIAL_BUILD").is_some() {
        println!("cargo:rustc-env=DEVHQ_OFFICIAL_BUILD=1");
    }
    tauri_build::build()
}
