fn main() {
    // `package-msix.ps1` sets this for the Store package only. Dev and plain
    // `npm run build` leave it unset, so What's new never hashes a debug exe
    // or shows the checksum work bar outside an official package.
    println!("cargo:rerun-if-env-changed=WINT_OFFICIAL_BUILD");
    if std::env::var_os("WINT_OFFICIAL_BUILD").is_some() {
        println!("cargo:rustc-env=WINT_OFFICIAL_BUILD=1");
    }
    let _ = comctl32_for_tests();
    tauri_build::build()
}

/// Let `cargo test` binaries load at all.
///
/// `tauri-runtime-wry` statically imports `TaskDialogIndirect`, which exists
/// only in comctl32 **v6**. `wint.exe` gets v6 because `tauri-build` embeds a
/// manifest asking for it, but that manifest is attached through
/// `rustc-link-arg-bins` and Cargo has no equivalent that reaches the unit-test
/// binary — `rustc-link-arg-tests` covers `tests/` only, and embedding a second
/// manifest into every target makes the app's own bin fail to link with a
/// duplicate resource. Without v6 a test binary dies on load with
/// `STATUS_ENTRYPOINT_NOT_FOUND` before one test runs.
///
/// So comctl32 is delay-loaded instead: nothing here calls into it, the import
/// is resolved on first use rather than at load, and the app — which does have
/// the manifest — is unaffected. `delayimp.lib` supplies the thunk helper.
fn comctl32_for_tests() -> Option<()> {
    if std::env::var("CARGO_CFG_TARGET_ENV").ok()? != "msvc" {
        return None;
    }
    println!("cargo:rustc-link-arg=/DELAYLOAD:comctl32.dll");
    println!("cargo:rustc-link-arg=delayimp.lib");
    // Not every linked target imports comctl32 at all, and one that does not
    // would otherwise warn about a /DELAYLOAD it has no use for.
    println!("cargo:rustc-link-arg=/IGNORE:4199");
    Some(())
}
