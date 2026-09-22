use serde::Serialize;
use windows::Media::Control::{
    GlobalSystemMediaTransportControlsSessionManager as SessionManager,
    GlobalSystemMediaTransportControlsSessionPlaybackStatus as PlaybackStatus,
};

#[derive(Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MediaState {
    available: bool,
    title: String,
    artist: String,
    playing: bool,
    position_seconds: i64,
    duration_seconds: i64,
    can_seek: bool,
    can_previous: bool,
    can_next: bool,
}

async fn manager() -> Result<SessionManager, String> {
    SessionManager::RequestAsync()
        .map_err(|error| error.to_string())?
        .await
        .map_err(|error| error.to_string())
}

#[tauri::command]
pub async fn media_state() -> Result<MediaState, String> {
    let Some(session) = manager().await?.GetCurrentSession().ok() else {
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
pub async fn media_command(command: String) -> Result<bool, String> {
    let session = manager()
        .await?
        .GetCurrentSession()
        .map_err(|_| "No active media session.".to_string())?;
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
