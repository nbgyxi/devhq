//! The Wi-Fi radio: what it is connected to, what it can see, and switching
//! between them.
//!
//! This talks to `wlanapi` directly rather than parsing `netsh wlan`. The
//! commands print their keys in the display language, so a parser reading
//! "SSID" and "Signal" quietly returns nothing on a Windows that is not in
//! English; the API returns the same fields whatever the language is.
//!
//! Connecting is only ever done through a profile Windows already has. Joining
//! a new network means a password, a key type and a consent prompt, which is
//! Windows' own flyout's job — `open_picker` hands it over rather than
//! building a profile XML and asking for a password in a sidebar.

use serde::Serialize;
use windows::core::{GUID, HSTRING, PCWSTR};
use windows::Win32::Foundation::{ERROR_SUCCESS, HANDLE};
use windows::Win32::NetworkManagement::WiFi::{
    dot11_BSS_type_infrastructure, wlan_connection_mode_profile,
    wlan_intf_opcode_current_connection, WlanCloseHandle, WlanConnect, WlanDisconnect,
    WlanEnumInterfaces, WlanFreeMemory, WlanGetAvailableNetworkList, WlanOpenHandle,
    WlanQueryInterface, WlanScan, WLAN_AVAILABLE_NETWORK_CONNECTED,
    WLAN_AVAILABLE_NETWORK_HAS_PROFILE, WLAN_AVAILABLE_NETWORK_LIST, WLAN_CONNECTION_ATTRIBUTES,
    WLAN_CONNECTION_PARAMETERS, WLAN_INTERFACE_INFO_LIST,
};

/// An open handle to the WLAN service, closed however the caller leaves.
struct Client(HANDLE);

impl Drop for Client {
    fn drop(&mut self) {
        unsafe {
            WlanCloseHandle(self.0, None);
        }
    }
}

/// The service and the first wireless interface it reports. `None` on a
/// machine with no Wi-Fi adapter, which is not an error — it is most desktops.
fn open() -> Option<(Client, GUID)> {
    unsafe {
        let mut handle = HANDLE::default();
        let mut version = 0u32;
        // Version 2 is every Windows since Vista.
        if WlanOpenHandle(2, None, &mut version, &mut handle) != ERROR_SUCCESS.0 {
            return None;
        }
        let client = Client(handle);
        let mut list: *mut WLAN_INTERFACE_INFO_LIST = std::ptr::null_mut();
        if WlanEnumInterfaces(client.0, None, &mut list) != ERROR_SUCCESS.0 || list.is_null() {
            return None;
        }
        let guid = ((*list).dwNumberOfItems > 0).then(|| (*list).InterfaceInfo[0].InterfaceGuid);
        WlanFreeMemory(list.cast());
        Some((client, guid?))
    }
}

fn ssid_string(ssid: &windows::Win32::NetworkManagement::WiFi::DOT11_SSID) -> String {
    let len = (ssid.uSSIDLength as usize).min(ssid.ucSSID.len());
    String::from_utf8_lossy(&ssid.ucSSID[..len]).to_string()
}

/// The network this machine is associated with, and how strong it is.
pub fn current() -> Option<(String, u32)> {
    let (client, guid) = open()?;
    unsafe {
        let mut size = 0u32;
        let mut data: *mut std::ffi::c_void = std::ptr::null_mut();
        if WlanQueryInterface(
            client.0,
            &guid,
            wlan_intf_opcode_current_connection,
            None,
            &mut size,
            &mut data,
            None,
        ) != ERROR_SUCCESS.0
            || data.is_null()
        {
            return None;
        }
        let attributes = &*(data as *const WLAN_CONNECTION_ATTRIBUTES);
        let ssid = ssid_string(&attributes.wlanAssociationAttributes.dot11Ssid);
        let signal = attributes.wlanAssociationAttributes.wlanSignalQuality;
        WlanFreeMemory(data);
        (!ssid.is_empty()).then_some((ssid, signal))
    }
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Network {
    pub ssid: String,
    /// 0-100, as Windows itself reports it.
    pub signal: u32,
    pub secured: bool,
    /// Whether Windows has a profile for it — only these can be joined from
    /// here, because the rest need a password.
    pub known: bool,
    pub connected: bool,
}

/// Every network in range, strongest first, one row per name.
pub fn networks() -> Vec<Network> {
    let Some((client, guid)) = open() else {
        return Vec::new();
    };
    let mut found: Vec<Network> = Vec::new();
    unsafe {
        let mut list: *mut WLAN_AVAILABLE_NETWORK_LIST = std::ptr::null_mut();
        if WlanGetAvailableNetworkList(client.0, &guid, 0, None, &mut list) != ERROR_SUCCESS.0
            || list.is_null()
        {
            return Vec::new();
        }
        let count = (*list).dwNumberOfItems as usize;
        let networks = std::slice::from_raw_parts((*list).Network.as_ptr(), count);
        for network in networks {
            let ssid = ssid_string(&network.dot11Ssid);
            if ssid.is_empty() {
                continue;
            }
            let known = network.dwFlags & WLAN_AVAILABLE_NETWORK_HAS_PROFILE != 0;
            let connected = network.dwFlags & WLAN_AVAILABLE_NETWORK_CONNECTED != 0;
            // One name can appear twice — once with a profile, once without.
            // The strongest reading wins, and either half being known or
            // connected counts for the row.
            if let Some(seen) = found.iter_mut().find(|other| other.ssid == ssid) {
                seen.signal = seen.signal.max(network.wlanSignalQuality);
                seen.known |= known;
                seen.connected |= connected;
                continue;
            }
            found.push(Network {
                ssid,
                signal: network.wlanSignalQuality,
                secured: network.bSecurityEnabled.as_bool(),
                known,
                connected,
            });
        }
        WlanFreeMemory(list.cast());
    }
    found.sort_by(|a, b| {
        b.connected
            .cmp(&a.connected)
            .then_with(|| b.signal.cmp(&a.signal))
    });
    found
}

/// Ask the radio to look again. The answer arrives in the service's own time,
/// so this returns as soon as the request is in — the next read of `networks`
/// is the one that sees the result.
pub fn scan() {
    if let Some((client, guid)) = open() {
        unsafe {
            WlanScan(client.0, &guid, None, None, None);
        }
    }
}

/// Join a network Windows already has a profile for. The profile's name is the
/// SSID for every network joined the ordinary way.
pub fn connect(ssid: &str) -> Result<(), String> {
    let (client, guid) = open().ok_or("This machine has no Wi-Fi adapter.")?;
    let profile = HSTRING::from(ssid);
    let parameters = WLAN_CONNECTION_PARAMETERS {
        wlanConnectionMode: wlan_connection_mode_profile,
        strProfile: PCWSTR(profile.as_ptr()),
        pDot11Ssid: std::ptr::null_mut(),
        pDesiredBssidList: std::ptr::null_mut(),
        dot11BssType: dot11_BSS_type_infrastructure,
        dwFlags: 0,
    };
    let status = unsafe { WlanConnect(client.0, &guid, &parameters, None) };
    if status == ERROR_SUCCESS.0 {
        Ok(())
    } else {
        Err(format!("Windows would not join {ssid} (error {status})."))
    }
}

pub fn disconnect() -> Result<(), String> {
    let (client, guid) = open().ok_or("This machine has no Wi-Fi adapter.")?;
    let status = unsafe { WlanDisconnect(client.0, &guid, None) };
    if status == ERROR_SUCCESS.0 {
        Ok(())
    } else {
        Err(format!("Windows would not disconnect (error {status})."))
    }
}

/// Windows' own Wi-Fi flyout, which is where a new network's password belongs.
pub fn open_picker() -> Result<(), String> {
    use std::os::windows::process::CommandExt;
    const DETACHED_PROCESS: u32 = 0x0000_0008;
    std::process::Command::new("explorer.exe")
        .arg("ms-availablenetworks:")
        .creation_flags(DETACHED_PROCESS)
        .spawn()
        .map(|_| ())
        .map_err(|e| format!("Could not open the Wi-Fi list: {e}"))
}
