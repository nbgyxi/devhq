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
    position_seconds: i64,
    duration_seconds: i64,
    can_seek: bool,
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
    let timeline = session
        .GetTimelineProperties()
        .map_err(|error| error.to_string())?;
    let playback = session
        .GetPlaybackInfo()
        .map_err(|error| error.to_string())?;
    let controls = playback.Controls().map_err(|error| error.to_string())?;
    let source_id = session
        .SourceAppUserModelId()
        .map(|value| value.to_string())
        .unwrap_or_default();
    let wanted = source_id.to_ascii_lowercase();
    let source_file = wanted
        .rsplit(['\\', '/'])
        .next()
        .unwrap_or(&wanted)
        .to_string();
    let sidebar = crate::appbar::sidebar_window_handle(&app);
    let source_for_lookup = source_id.clone();
    let (launch_target, source) = crate::off_thread(move || {
        let window = crate::appbar::list_windows(sidebar)
            .into_iter()
            .find_map(|window| {
                let app = window.app.to_ascii_lowercase();
                let exe = window.exe.to_ascii_lowercase();
                (app == wanted || exe.ends_with(&source_file)).then_some(window)
            });
        // The media API exposes an AppUserModelID, not the friendly name the
        // Start menu shows. Ask the shell first (important for packaged and
        // Tauri apps), then use the executable's product description.
        let shell_name = unsafe { crate::suggest::shell_item(&source_for_lookup) }
            .map(|(name, _)| name);
        let exe_name = window
            .as_ref()
            .and_then(|window| crate::appbar::exe_description(&window.exe));
        let target = window.map(|window| window.exe).unwrap_or_default();
        (target, shell_name.or(exe_name).unwrap_or_else(|| source_name(&source_for_lookup)))
    })
    .await
    .unwrap_or_else(|| (String::new(), source_name(&source_id)));
    Ok(MediaState {
        available: true,
        title: properties
            .Title()
            .map(|value| value.to_string())
            .unwrap_or_default(),
        artist: properties
            .Artist()
            .map(|value| value.to_string())
            .unwrap_or_default(),
        source,
        source_id,
        launch_target,
        playing: playback
            .PlaybackStatus()
            .map(|status| status == PlaybackStatus::Playing)
            .unwrap_or(false),
        position_seconds: timeline
            .Position()
            .map(|value| value.Duration / 10_000_000)
            .unwrap_or(0),
        duration_seconds: timeline
            .EndTime()
            .map(|value| value.Duration / 10_000_000)
            .unwrap_or(0),
        can_seek: controls.IsPlaybackPositionEnabled().unwrap_or(false),
        can_previous: controls.IsPreviousEnabled().unwrap_or(false),
        can_next: controls.IsNextEnabled().unwrap_or(false),
    })
}

#[tauri::command]
pub async fn media_focus(
    app: AppHandle,
    source_id: String,
    launch_target: Option<String>,
) -> Result<(), String> {
    let wanted = source_id.to_ascii_lowercase();
    let source_file = wanted
        .rsplit(['\\', '/'])
        .next()
        .unwrap_or(&wanted)
        .to_string();
    let sidebar = crate::appbar::sidebar_window_handle(&app);
    let found = crate::off_thread(move || {
        crate::appbar::list_windows(sidebar)
            .into_iter()
            .find(|window| {
                let app = window.app.to_ascii_lowercase();
                let exe = window.exe.to_ascii_lowercase();
                app == wanted || exe.ends_with(&source_file)
            })
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
        "back10" | "ahead10" => {
            let timeline = session
                .GetTimelineProperties()
                .map_err(|error| error.to_string())?;
            let delta = if command == "back10" {
                -100_000_000
            } else {
                100_000_000
            };
            let start = timeline
                .StartTime()
                .map(|value| value.Duration)
                .unwrap_or(0);
            let end = timeline
                .EndTime()
                .map(|value| value.Duration)
                .unwrap_or(i64::MAX);
            let position = timeline.Position().map(|value| value.Duration).unwrap_or(0);
            session.TryChangePlaybackPositionAsync(position.saturating_add(delta).clamp(start, end))
        }
        _ => return Err("Unknown media command.".into()),
    }
    .map_err(|error| error.to_string())?;
    operation.await.map_err(|error| error.to_string())
}
