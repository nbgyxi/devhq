//! Proves a test executable of this crate can be loaded and run at all.
//!
//! `tauri-runtime-wry` statically imports `TaskDialogIndirect`, which exists
//! only in comctl32 v6, so every test binary here needs the manifest that asks
//! for v6 (see `manifest_for_tests` in `build.rs`). Without it the process dies
//! with `STATUS_ENTRYPOINT_NOT_FOUND` before `main` runs — and a failure that
//! early reads as "the whole test suite is broken" rather than as a missing
//! manifest, which is why it gets a test of its own saying so.

#[test]
fn the_test_harness_starts_and_the_library_is_usable() {
    assert_eq!(wint_lib::vt::char_width('a'), 1);
    // A wide glyph, to prove this is the real terminal grid and not a stub.
    assert_eq!(wint_lib::vt::char_width('漢'), 2);
}
