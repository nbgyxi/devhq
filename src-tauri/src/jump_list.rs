use super::TrayTool;
use windows::core::{Interface, PCWSTR};
use windows::Win32::Foundation::PROPERTYKEY;
use windows::Win32::System::Com::StructuredStorage::PROPVARIANT;
use windows::Win32::System::Com::{
    CoCreateInstance, CoInitializeEx, CoUninitialize, CLSCTX_INPROC_SERVER,
    COINIT_APARTMENTTHREADED,
};
use windows::Win32::UI::Shell::Common::{IObjectArray, IObjectCollection};
use windows::Win32::UI::Shell::PropertiesSystem::IPropertyStore;
use windows::Win32::UI::Shell::{
    DestinationList, EnumerableObjectCollection, ICustomDestinationList, IShellLinkW, ShellLink,
};
use std::path::PathBuf;

const PKEY_TITLE: PROPERTYKEY = PROPERTYKEY {
    fmtid: windows::core::GUID::from_u128(0xf29f85e0_4ff9_1068_ab91_08002b27b3d9),
    pid: 2,
};

fn wide(value: &str) -> Vec<u16> {
    value.encode_utf16().chain(Some(0)).collect()
}

/// Replace WinT's Windows taskbar Jump List with the same recent tools used
/// by Ctrl+K and the tray. Each item launches the current executable with a
/// tool argument; the single-instance plugin hands that argument to the open
/// window when WinT is already running.
pub fn set_recent_tools(tools: &[TrayTool], packaged_icons: Option<PathBuf>) -> Result<(), String> {
    let tools = tools
        .iter()
        .take(6)
        .map(|tool| (tool.id.clone(), tool.name.clone()))
        .collect::<Vec<_>>();
    std::thread::spawn(move || unsafe { set_recent_tools_com(&tools, packaged_icons) })
        .join()
        .map_err(|_| "Windows Jump List update panicked".to_string())?
        .map_err(|error| error.to_string())
}

unsafe fn set_recent_tools_com(
    tools: &[(String, String)],
    packaged_icons: Option<PathBuf>,
) -> windows::core::Result<()> {
    CoInitializeEx(None, COINIT_APARTMENTTHREADED).ok()?;
    let result = (|| {
        let executable = std::env::current_exe().map_err(|_| windows::core::Error::from_win32())?;
        let executable = wide(&executable.to_string_lossy());
        let list: ICustomDestinationList =
            CoCreateInstance(&DestinationList, None, CLSCTX_INPROC_SERVER)?;
        let mut slots = 0;
        let _: IObjectArray = list.BeginList(&mut slots)?;
        let collection: IObjectCollection =
            CoCreateInstance(&EnumerableObjectCollection, None, CLSCTX_INPROC_SERVER)?;

        for (id, name) in tools {
            let link: IShellLinkW = CoCreateInstance(&ShellLink, None, CLSCTX_INPROC_SERVER)?;
            let arguments = wide(&format!("--open-tool={id}"));
            link.SetPath(PCWSTR(executable.as_ptr()))?;
            link.SetArguments(PCWSTR(arguments.as_ptr()))?;
            let development_icon = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
                .join("icons").join("tools").join("dark").join(format!("{id}.ico"));
            let icon = packaged_icons.as_ref()
                .map(|directory| directory.join(format!("{id}.ico")))
                .filter(|path| path.is_file())
                .unwrap_or(development_icon);
            if icon.is_file() {
                let icon = wide(&icon.to_string_lossy());
                link.SetIconLocation(PCWSTR(icon.as_ptr()), 0)?;
            }
            let properties: IPropertyStore = link.cast()?;
            let title = PROPVARIANT::from(name.as_str());
            properties.SetValue(&PKEY_TITLE, &title)?;
            properties.Commit()?;
            collection.AddObject(&link)?;
        }

        if !tools.is_empty() {
            let array: IObjectArray = collection.cast()?;
            list.AddUserTasks(&array)?;
        }
        list.CommitList()
    })();
    CoUninitialize();
    result
}
