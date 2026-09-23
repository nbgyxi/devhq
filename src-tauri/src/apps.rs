//! Every application installed on this machine, for the global search.
//!
//! Windows already keeps the authoritative list: the **Apps folder**, the
//! shell namespace behind `shell:AppsFolder` and the thing the Start menu's
//! own "All apps" is a view of. It holds desktop programs (as Start menu
//! shortcuts) and Store apps alike, so there is nothing to walk by hand and
//! nothing to guess about UWP.
//!
//! The list is read once, off-thread, and handed to the front end whole. The
//! front end keeps it in its own cache and searches that cache in memory, so
//! typing never waits for the shell — the refresh here only exists to notice
//! that something was installed or removed since last time.

use serde::Serialize;

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct InstalledApp {
    /// The name the Start menu shows.
    pub name: String,
    /// The AppUserModelID, handed straight back to `launch`.
    pub target: String,
}

/// Shell entries that are in the Apps folder but are not applications anyone
/// means to start from a search box.
const NOISE: [&str; 6] = [
    "wint.exe",
    "windows.immersivecontrolpanel",
    "microsoft.windows.startmenuexperiencehost",
    "microsoft.windows.shellexperiencehost",
    "microsoft.windows.search",
    "microsoft.windows.sechealthui",
];

fn is_noise(name: &str, target: &str) -> bool {
    let name = name.to_ascii_lowercase();
    let target = target.to_ascii_lowercase();
    if name.is_empty() || target.is_empty() {
        return true;
    }
    NOISE.iter().any(|bad| target.contains(bad) || name == *bad)
}

/// Everything in `shell:AppsFolder`, by display name and AppUserModelID.
#[cfg(windows)]
pub fn installed() -> Vec<InstalledApp> {
    use windows::core::HSTRING;
    use windows::Win32::System::Com::CoTaskMemFree;
    use windows::Win32::UI::Shell::{
        BHID_EnumItems, IEnumShellItems, IShellItem, SHCreateItemFromParsingName,
        SIGDN_NORMALDISPLAY, SIGDN_PARENTRELATIVEPARSING,
    };

    let _apartment = crate::com::Apartment::single_threaded();
    let mut apps: Vec<InstalledApp> = Vec::new();
    unsafe {
        let folder: IShellItem =
            match SHCreateItemFromParsingName(&HSTRING::from("shell:AppsFolder"), None) {
                Ok(item) => item,
                Err(_) => return apps,
            };
        let items: IEnumShellItems = match folder.BindToHandler(None, &BHID_EnumItems) {
            Ok(items) => items,
            Err(_) => return apps,
        };
        let read = |item: &IShellItem, kind| -> String {
            match item.GetDisplayName(kind) {
                Ok(raw) => {
                    let text = raw.to_string().unwrap_or_default();
                    CoTaskMemFree(Some(raw.0 as *const _));
                    text
                }
                Err(_) => String::new(),
            }
        };
        loop {
            let mut batch: [Option<IShellItem>; 32] = Default::default();
            let mut fetched = 0u32;
            if items.Next(&mut batch, Some(&mut fetched)).is_err() || fetched == 0 {
                break;
            }
            for item in batch.iter().take(fetched as usize).flatten() {
                let name = read(item, SIGDN_NORMALDISPLAY);
                let target = read(item, SIGDN_PARENTRELATIVEPARSING);
                if is_noise(&name, &target) {
                    continue;
                }
                apps.push(InstalledApp { name, target });
            }
        }
    }
    apps.sort_by_key(|app| app.name.to_ascii_lowercase());
    // The same app can be reached through more than one entry; the name sort
    // puts any such pair next to each other.
    apps.dedup_by(|a, b| a.target == b.target);
    apps
}

/// The icons for a batch of applications, in the order asked.
///
/// A batch rather than one call each: entering the shell's apartment and
/// leaving it again is the expensive part, and a machine has hundreds of
/// these. The front end still asks in chunks, so no single call runs long and
/// the icons it already has keep being drawn while the rest arrive.
#[cfg(windows)]
pub fn icons(targets: &[String]) -> Vec<Option<String>> {
    let _apartment = crate::com::Apartment::single_threaded();
    targets
        .iter()
        .map(|target| unsafe { crate::suggest::shell_item(target).and_then(|(_, icon)| icon) })
        .collect()
}

#[cfg(not(windows))]
pub fn installed() -> Vec<InstalledApp> {
    Vec::new()
}

#[cfg(not(windows))]
pub fn icons(targets: &[String]) -> Vec<Option<String>> {
    targets.iter().map(|_| None).collect()
}
