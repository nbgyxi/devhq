use serde::Serialize;
use tauri::AppHandle;
use windows::core::Interface;
use windows::Media::Control::{
    GlobalSystemMediaTransportControlsSession as Session,
    GlobalSystemMediaTransportControlsSessionManager as SessionManager,
    GlobalSystemMediaTransportControlsSessionPlaybackStatus as PlaybackStatus,
};
use windows::Win32::Media::Audio::{
    eMultimedia, eRender, AudioSessionStateActive, IAudioSessionControl2, IAudioSessionManager2,
    IMMDeviceEnumerator, ISimpleAudioVolume, MMDeviceEnumerator,
};
use windows::Win32::System::Com::{CoCreateInstance, CLSCTX_ALL};

#[derive(Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MediaState {
    available: bool,
    title: String,
    artist: String,
    source: String,
    source_id: String,
    launch_target: String,
    playing: bool,
    can_previous: bool,
    can_next: bool,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AudioStream {
    pid: u32,
    name: String,
    executable: String,
    muted: bool,
    volume: u32,
}

fn process_path(pid: u32) -> String {
    use windows::Win32::Foundation::CloseHandle;
    use windows::Win32::System::Threading::{
        OpenProcess, QueryFullProcessImageNameW, PROCESS_NAME_WIN32,
        PROCESS_QUERY_LIMITED_INFORMATION,
    };
    unsafe {
        let Ok(process) = OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, false, pid) else {
            return String::new();
        };
        let mut buffer = [0u16; 1024];
        let mut len = buffer.len() as u32;
        let ok = QueryFullProcessImageNameW(
            process,
            PROCESS_NAME_WIN32,
            windows::core::PWSTR(buffer.as_mut_ptr()),
            &mut len,
        )
        .is_ok();
        let _ = CloseHandle(process);
        if ok {
            String::from_utf16_lossy(&buffer[..len as usize])
        } else {
            String::new()
        }
    }
}

fn audio_sessions() -> Result<Vec<(u32, ISimpleAudioVolume)>, String> {
    let _apartment = crate::com::Apartment::multi_threaded();
    unsafe {
        let devices: IMMDeviceEnumerator = CoCreateInstance(&MMDeviceEnumerator, None, CLSCTX_ALL)
            .map_err(|error| error.to_string())?;
        let device = devices
            .GetDefaultAudioEndpoint(eRender, eMultimedia)
            .map_err(|error| error.to_string())?;
        let manager: IAudioSessionManager2 = device
            .Activate(CLSCTX_ALL, None)
            .map_err(|error| error.to_string())?;
        let sessions = manager
            .GetSessionEnumerator()
            .map_err(|error| error.to_string())?;
        let count = sessions.GetCount().unwrap_or(0);
        let mut result = Vec::new();
        for index in 0..count {
            let Ok(control) = sessions.GetSession(index) else {
                continue;
            };
            if control.GetState().ok() != Some(AudioSessionStateActive) {
                continue;
            }
            let Ok(control2) = control.cast::<IAudioSessionControl2>() else {
                continue;
            };
            let Ok(volume) = control.cast::<ISimpleAudioVolume>() else {
                continue;
            };
            let pid = control2.GetProcessId().unwrap_or(0);
            if pid != 0 {
                result.push((pid, volume));
            }
        }
        Ok(result)
    }
}

#[tauri::command]
pub async fn media_audio_streams() -> Result<Vec<AudioStream>, String> {
    crate::off_thread(|| {
        let sessions = audio_sessions()?;
        let mut streams = Vec::new();
        for (pid, volume) in sessions {
            let executable = process_path(pid);
            let name = std::path::Path::new(&executable)
                .file_stem()
                .map(|value| value.to_string_lossy().into_owned())
                .filter(|value| !value.is_empty())
                .unwrap_or_else(|| format!("Process {pid}"));
            let muted = unsafe {
                volume
                    .GetMute()
                    .map(|value| value.as_bool())
                    .unwrap_or(false)
            };
            let level = unsafe { volume.GetMasterVolume().unwrap_or(0.0) };
            streams.push(AudioStream {
                pid,
                name,
                executable,
                muted,
                volume: (level * 100.0).round().clamp(0.0, 100.0) as u32,
            });
        }
        streams.sort_by(|a, b| {
            a.name
                .to_ascii_lowercase()
                .cmp(&b.name.to_ascii_lowercase())
        });
        Ok(streams)
    })
    .await
    .unwrap_or_else(|| Err("Could not read active audio streams.".into()))
}

#[tauri::command]
pub async fn media_audio_mute(pid: u32, muted: bool) -> Result<(), String> {
    crate::off_thread(move || {
        let mut found = false;
        for (session_pid, volume) in audio_sessions()? {
            if session_pid == pid {
                unsafe {
                    volume
                        .SetMute(muted, std::ptr::null())
                        .map_err(|error| error.to_string())?;
                }
                found = true;
            }
        }
        found
            .then_some(())
            .ok_or_else(|| "That audio stream has ended.".to_string())
    })
    .await
    .unwrap_or_else(|| Err("Could not change the audio stream.".into()))
}

/// The pids holding an active render audio session, plus every ancestor of
/// those pids.
///
/// A browser does not play sound from the process that owns its windows: Chrome
/// and Edge render audio in a utility child, Firefox in a content child. The
/// window we want belongs to the browser process those children descend from,
/// so the ancestors are what make the set usable for matching a window.
fn audio_owner_pids() -> std::collections::HashSet<u32> {
    use windows::Win32::System::Diagnostics::ToolHelp::{
        CreateToolhelp32Snapshot, Process32FirstW, Process32NextW, PROCESSENTRY32W,
        TH32CS_SNAPPROCESS,
    };
    let mut owners: std::collections::HashSet<u32> = audio_sessions()
        .map(|sessions| sessions.into_iter().map(|(pid, _)| pid).collect())
        .unwrap_or_default();
    if owners.is_empty() {
        return owners;
    }
    let mut parents: std::collections::HashMap<u32, (u32, String)> =
        std::collections::HashMap::new();
    unsafe {
        let Ok(snapshot) = CreateToolhelp32Snapshot(TH32CS_SNAPPROCESS, 0) else {
            return owners;
        };
        let mut entry = PROCESSENTRY32W {
            dwSize: std::mem::size_of::<PROCESSENTRY32W>() as u32,
            ..Default::default()
        };
        if Process32FirstW(snapshot, &mut entry).is_ok() {
            loop {
                let len = entry
                    .szExeFile
                    .iter()
                    .position(|c| *c == 0)
                    .unwrap_or(entry.szExeFile.len());
                let name = String::from_utf16_lossy(&entry.szExeFile[..len]).to_ascii_lowercase();
                parents.insert(entry.th32ProcessID, (entry.th32ParentProcessID, name));
                if Process32NextW(snapshot, &mut entry).is_err() {
                    break;
                }
            }
        }
        let _ = windows::Win32::Foundation::CloseHandle(snapshot);
    }
    // Walk up from every audio pid, but only while the parent runs the same
    // executable — that is what reaches a browser's or Spotify's own process
    // without climbing on into explorer.exe, which owns windows of its own.
    // Only pids new to the set are followed, so a recycled parent cannot spin
    // this forever.
    let mut queue: Vec<u32> = owners.iter().copied().collect();
    while let Some(pid) = queue.pop() {
        let Some((parent, name)) = parents.get(&pid) else {
            continue;
        };
        if *parent == 0 || *parent == pid {
            continue;
        }
        if parents.get(parent).is_some_and(|(_, up)| up == name) && owners.insert(*parent) {
            queue.push(*parent);
        }
    }
    owners
}

fn window_pid(id: &str) -> u32 {
    use windows::Win32::Foundation::HWND;
    use windows::Win32::UI::WindowsAndMessaging::GetWindowThreadProcessId;
    let Ok(raw) = id.parse::<isize>() else {
        return 0;
    };
    let mut pid = 0u32;
    unsafe {
        GetWindowThreadProcessId(
            HWND(raw as *mut std::ffi::c_void),
            Some(std::ptr::addr_of_mut!(pid)),
        );
    }
    pid
}

/// Text stripped to letters, digits and single spaces, so a window title and a
/// track title can be compared without tripping over the dashes, quotes and
/// bullets each side decorates its own with.
fn comparable(text: &str) -> String {
    let mut out = String::with_capacity(text.len());
    for ch in text.chars() {
        if ch.is_alphanumeric() {
            out.extend(ch.to_lowercase());
        } else if !out.ends_with(' ') {
            out.push(' ');
        }
    }
    out.trim().to_string()
}

/// The window that is making the sound, not merely one belonging to the app.
///
/// A browser is why this cannot be the first match: one Chrome or Edge install
/// has a window per profile and many windows per profile, and the enumeration
/// hands them over in z-order, so the first match is whichever window happens
/// to be in front. Three signals narrow it down, most telling first:
///
/// * the AppUserModelID the media session names, which browsers set per
///   profile — the only signal that tells two profiles apart, since they share
///   one browser process;
/// * the track (or artist) appearing in the window title, which is how a
///   browser window whose playing tab is the one on top gives itself away;
/// * the window belonging to the process tree holding the audio session, which
///   still works when the playing tab is a background tab.
fn pick_source_window(
    windows: Vec<crate::appbar::OpenWindow>,
    source_id: &str,
    title: &str,
    artist: &str,
) -> Option<crate::appbar::OpenWindow> {
    let wanted = source_id.to_ascii_lowercase();
    let source_file = wanted
        .rsplit(['\\', '/'])
        .next()
        .unwrap_or(&wanted)
        .to_string();
    let track = comparable(title);
    let artist = comparable(artist);
    let mut candidates: Vec<(u32, crate::appbar::OpenWindow)> = windows
        .into_iter()
        .filter_map(|window| {
            let identity = if !wanted.is_empty() && window.app.to_ascii_lowercase() == wanted {
                2
            } else if !source_file.is_empty()
                && window.exe.to_ascii_lowercase().ends_with(&source_file)
            {
                1
            } else {
                return None;
            };
            Some((identity, window))
        })
        .collect();
    if candidates.len() < 2 {
        return candidates.pop().map(|(_, window)| window);
    }
    // Worth a process snapshot only once more than one window is in play.
    let owners = audio_owner_pids();
    let mut scored: Vec<(u32, crate::appbar::OpenWindow)> = candidates
        .into_iter()
        .map(|(identity, window)| {
            let seen = comparable(&window.title);
            let named = if track.len() > 2 && seen.contains(&track) {
                2
            } else if artist.len() > 2 && seen.contains(&artist) {
                1
            } else {
                0
            };
            let sounding =
                u32::from(!owners.is_empty() && owners.contains(&window_pid(&window.id)));
            let onscreen = u32::from(!window.minimized);
            // Identity outranks the rest: a window of the wrong profile is the
            // wrong window however loudly its neighbours match.
            let score = identity * 100 + named * 20 + sounding * 4 + onscreen;
            (score, window)
        })
        .collect();
    scored.sort_by_key(|(score, _)| std::cmp::Reverse(*score));
    scored.into_iter().next().map(|(_, window)| window)
}

fn source_name(id: &str) -> String {
    let leaf = id.rsplit(['\\', '/']).next().unwrap_or(id);
    let stem = leaf.strip_suffix(".exe").unwrap_or(leaf);
    match stem.to_ascii_lowercase().as_str() {
        "spotify" => "Spotify".into(),
        "chrome" => "Chrome".into(),
        "msedge" => "Edge".into(),
        "firefox" => "Firefox".into(),
        "music.ui" => "Media Player".into(),
        _ => stem.split('.').next().unwrap_or(stem).to_string(),
    }
}

async fn manager() -> Result<SessionManager, String> {
    SessionManager::RequestAsync()
        .map_err(|error| error.to_string())?
        .await
        .map_err(|error| error.to_string())
}

/// Windows' "current" session is not always the one that is making sound.
/// Prefer any session that reports Playing, then fall back to Windows' choice.
fn active_session(manager: &SessionManager) -> Option<Session> {
    if let Ok(sessions) = manager.GetSessions() {
        if let Ok(count) = sessions.Size() {
            for index in 0..count {
                let Ok(session) = sessions.GetAt(index) else {
                    continue;
                };
                let playing = session
                    .GetPlaybackInfo()
                    .ok()
                    .and_then(|info| info.PlaybackStatus().ok())
                    .is_some_and(|status| status == PlaybackStatus::Playing);
                if playing {
                    return Some(session);
                }
            }
        }
    }
    manager.GetCurrentSession().ok()
}

#[tauri::command]
pub async fn media_state(app: AppHandle) -> Result<MediaState, String> {
    let manager = manager().await?;
    let Some(session) = active_session(&manager) else {
        return Ok(MediaState::default());
    };
    let properties = session
        .TryGetMediaPropertiesAsync()
        .map_err(|error| error.to_string())?
        .await
        .map_err(|error| error.to_string())?;
    let playback = session
        .GetPlaybackInfo()
        .map_err(|error| error.to_string())?;
    let controls = playback.Controls().map_err(|error| error.to_string())?;
    let source_id = session
        .SourceAppUserModelId()
        .map(|value| value.to_string())
        .unwrap_or_default();
    let title = properties
        .Title()
        .map(|value| value.to_string())
        .unwrap_or_default();
    let artist = properties
        .Artist()
        .map(|value| value.to_string())
        .unwrap_or_default();
    let sidebar = crate::appbar::sidebar_window_handle(&app);
    let source_for_lookup = source_id.clone();
    let (track, performer) = (title.clone(), artist.clone());
    let (launch_target, source) = crate::off_thread(move || {
        let window = pick_source_window(
            crate::appbar::list_windows(sidebar),
            &source_for_lookup,
            &track,
            &performer,
        );
        // The media API exposes an AppUserModelID, not the friendly name the
        // Start menu shows. Ask the shell first (important for packaged and
        // Tauri apps), then use the executable's product description.
        let shell_name =
            unsafe { crate::suggest::shell_item(&source_for_lookup) }.map(|(name, _)| name);
        let exe_name = window
            .as_ref()
            .and_then(|window| crate::appbar::exe_description(&window.exe));
        let target = window.map(|window| window.exe).unwrap_or_default();
        (
            target,
            shell_name
                .or(exe_name)
                .unwrap_or_else(|| source_name(&source_for_lookup)),
        )
    })
    .await
    .unwrap_or_else(|| (String::new(), source_name(&source_id)));
    Ok(MediaState {
        available: true,
        title,
        artist,
        source,
        source_id,
        launch_target,
        playing: playback
            .PlaybackStatus()
            .map(|status| status == PlaybackStatus::Playing)
            .unwrap_or(false),
        can_previous: controls.IsPreviousEnabled().unwrap_or(false),
        can_next: controls.IsNextEnabled().unwrap_or(false),
    })
}

#[tauri::command]
pub async fn media_focus(
    app: AppHandle,
    source_id: String,
    launch_target: Option<String>,
    title: Option<String>,
    artist: Option<String>,
) -> Result<(), String> {
    let sidebar = crate::appbar::sidebar_window_handle(&app);
    let wanted = source_id.clone();
    let (title, artist) = (title.unwrap_or_default(), artist.unwrap_or_default());
    let found = crate::off_thread(move || {
        pick_source_window(
            crate::appbar::list_windows(sidebar),
            &wanted,
            &title,
            &artist,
        )
        .map(|window| (window.id, window.active))
    })
    .await
    .flatten();
    if let Some(found) = found {
        return if found.1 {
            Ok(())
        } else {
            crate::appbar::sidebar_activate(found.0).await
        };
    }
    let target = launch_target
        .filter(|target| !target.is_empty())
        .unwrap_or(source_id);
    crate::off_thread(move || crate::suggest::launch(&target, &[]))
        .await
        .unwrap_or_else(|| Err("Could not start the media app.".into()))
}

#[tauri::command]
pub async fn media_command(command: String) -> Result<bool, String> {
    let manager = manager().await?;
    let session = active_session(&manager).ok_or_else(|| "No active media session.".to_string())?;
    let operation = match command.as_str() {
        "previous" => session.TrySkipPreviousAsync(),
        "toggle" => session.TryTogglePlayPauseAsync(),
        "next" => session.TrySkipNextAsync(),
        _ => return Err("Unknown media command.".into()),
    }
    .map_err(|error| error.to_string())?;
    operation.await.map_err(|error| error.to_string())
}
