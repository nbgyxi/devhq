//! Native common-item dialogs: choose a folder, or save a text file.
//!
//! The common item dialog runs its own modal message loop for as long as it is
//! on screen, and that loop must never be the one drawing the WinT window
//! (see CLAUDE.md). Everything here therefore runs on a worker thread: it
//! enters a single-threaded apartment of its own, shows the dialog, and hands
//! the chosen path back. The main window keeps painting throughout; it is only
//! disabled, the way any owned modal disables its owner.

use windows::core::{HSTRING, PCWSTR};
use windows::Win32::Foundation::HWND;
use windows::Win32::System::Com::{
    CoCreateInstance, CoInitializeEx, CoTaskMemFree, CoUninitialize, CLSCTX_INPROC_SERVER,
    COINIT_APARTMENTTHREADED, COINIT_DISABLE_OLE1DDE,
};
use windows::Win32::UI::Shell::Common::COMDLG_FILTERSPEC;
use windows::Win32::UI::Shell::{
    FileOpenDialog, FileSaveDialog, IFileOpenDialog, IFileSaveDialog, IShellItem,
    SHCreateItemFromParsingName, FOS_FORCEFILESYSTEM, FOS_OVERWRITEPROMPT, FOS_PATHMUSTEXIST,
    FOS_PICKFOLDERS, SIGDN_FILESYSPATH,
};

/// `HRESULT_FROM_WIN32(ERROR_CANCELLED)` - the user closed the dialog. Not an
/// error: it simply means the path they already had stands.
const CANCELLED: i32 = -2147023673;

/// Shows the picker and returns the folder, or `None` if it was dismissed.
/// `owner` is the main window's `HWND` as a plain integer, so the handle can
/// cross the thread boundary; zero leaves the dialog unowned.
pub fn pick_folder(owner: isize, start: Option<String>) -> Result<Option<String>, String> {
    unsafe {
        // A window already in an apartment stays in it: `RPC_E_CHANGED_MODE`
        // means someone got here first, and then this thread must not undo it.
        let entered =
            CoInitializeEx(None, COINIT_APARTMENTTHREADED | COINIT_DISABLE_OLE1DDE).is_ok();
        let picked = show(owner, start);
        if entered {
            CoUninitialize();
        }
        picked
    }
}

unsafe fn show(owner: isize, start: Option<String>) -> Result<Option<String>, String> {
    let dialog: IFileOpenDialog = CoCreateInstance(&FileOpenDialog, None, CLSCTX_INPROC_SERVER)
        .map_err(|e| format!("Could not open the folder picker: {e}"))?;

    let options = dialog.GetOptions().unwrap_or_default();
    dialog
        .SetOptions(options | FOS_PICKFOLDERS | FOS_FORCEFILESYSTEM | FOS_PATHMUSTEXIST)
        .map_err(|e| format!("Could not open the folder picker: {e}"))?;
    let _ = dialog.SetTitle(PCWSTR(HSTRING::from("Choose a folder to scan").as_ptr()));

    // Whatever is already typed is where the dialog starts, when it exists. A
    // path that does not resolve is not worth reporting - the dialog just opens
    // wherever Windows would have opened it anyway.
    if let Some(start) = start.filter(|s| !s.trim().is_empty()) {
        let path = HSTRING::from(start.trim());
        if let Ok(item) =
            SHCreateItemFromParsingName::<_, _, IShellItem>(PCWSTR(path.as_ptr()), None)
        {
            let _ = dialog.SetFolder(&item);
        }
    }

    let hwnd = (owner != 0).then_some(HWND(owner as *mut core::ffi::c_void));
    if let Err(e) = dialog.Show(hwnd) {
        if e.code().0 == CANCELLED {
            return Ok(None);
        }
        return Err(format!("Could not open the folder picker: {e}"));
    }

    let item = dialog
        .GetResult()
        .map_err(|e| format!("Could not read the chosen folder: {e}"))?;
    let wide = item
        .GetDisplayName(SIGDN_FILESYSPATH)
        .map_err(|e| format!("Could not read the chosen folder: {e}"))?;
    let path = wide
        .to_string()
        .map_err(|_| "That folder has a name Windows could not hand over.".to_string());
    CoTaskMemFree(Some(wide.0 as *const core::ffi::c_void));
    path.map(Some)
}

/// Shows Save As, writes UTF-8 text to the chosen path, and returns that path —
/// or `None` if the dialog was dismissed.
pub fn save_text_file(
    owner: isize,
    default_name: String,
    text: String,
) -> Result<Option<String>, String> {
    unsafe {
        let entered =
            CoInitializeEx(None, COINIT_APARTMENTTHREADED | COINIT_DISABLE_OLE1DDE).is_ok();
        let saved = show_save(owner, default_name, text);
        if entered {
            CoUninitialize();
        }
        saved
    }
}

fn sanitize_file_name(name: &str) -> String {
    let base = name.rsplit(['/', '\\']).next().unwrap_or(name).trim();
    let cleaned: String = base
        .chars()
        .filter(|c| *c != '\0' && !r#"<>:"|?*"#.contains(*c))
        .collect();
    let cleaned = cleaned.trim();
    if cleaned.is_empty() {
        "output.txt".into()
    } else {
        cleaned.to_string()
    }
}

unsafe fn show_save(
    owner: isize,
    default_name: String,
    text: String,
) -> Result<Option<String>, String> {
    let dialog: IFileSaveDialog = CoCreateInstance(&FileSaveDialog, None, CLSCTX_INPROC_SERVER)
        .map_err(|e| format!("Could not open the save dialog: {e}"))?;

    let options = dialog.GetOptions().unwrap_or_default();
    dialog
        .SetOptions(options | FOS_FORCEFILESYSTEM | FOS_PATHMUSTEXIST | FOS_OVERWRITEPROMPT)
        .map_err(|e| format!("Could not open the save dialog: {e}"))?;
    let _ = dialog.SetTitle(PCWSTR(HSTRING::from("Save output").as_ptr()));

    let filter_txt = HSTRING::from("Text files");
    let filter_txt_spec = HSTRING::from("*.txt");
    let filter_all = HSTRING::from("All files");
    let filter_all_spec = HSTRING::from("*.*");
    let filters = [
        COMDLG_FILTERSPEC {
            pszName: PCWSTR(filter_txt.as_ptr()),
            pszSpec: PCWSTR(filter_txt_spec.as_ptr()),
        },
        COMDLG_FILTERSPEC {
            pszName: PCWSTR(filter_all.as_ptr()),
            pszSpec: PCWSTR(filter_all_spec.as_ptr()),
        },
    ];
    let _ = dialog.SetFileTypes(&filters);
    let _ = dialog.SetFileTypeIndex(1);
    let _ = dialog.SetDefaultExtension(PCWSTR(HSTRING::from("txt").as_ptr()));

    let name = HSTRING::from(sanitize_file_name(&default_name));
    let _ = dialog.SetFileName(PCWSTR(name.as_ptr()));

    let hwnd = (owner != 0).then_some(HWND(owner as *mut core::ffi::c_void));
    if let Err(e) = dialog.Show(hwnd) {
        if e.code().0 == CANCELLED {
            return Ok(None);
        }
        return Err(format!("Could not open the save dialog: {e}"));
    }

    let item = dialog
        .GetResult()
        .map_err(|e| format!("Could not read the chosen file: {e}"))?;
    let wide = item
        .GetDisplayName(SIGDN_FILESYSPATH)
        .map_err(|e| format!("Could not read the chosen file: {e}"))?;
    let path = wide
        .to_string()
        .map_err(|_| "That file has a name Windows could not hand over.".to_string())?;
    CoTaskMemFree(Some(wide.0 as *const core::ffi::c_void));

    std::fs::write(&path, text.as_bytes()).map_err(|e| format!("Could not write the file: {e}"))?;
    Ok(Some(path))
}
