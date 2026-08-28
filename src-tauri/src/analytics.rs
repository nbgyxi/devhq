//! PageRain page-view reporting.
//!
//! The POST is made here rather than from the window. The endpoint answers a
//! CORS preflight without an `Access-Control-Allow-Origin` header, so a `fetch`
//! from the webview is rejected before it ever reaches the network - the front
//! end cannot report a page view on its own. WinHTTP is not a browser, has no
//! such rule, and costs no dependency the app did not already carry.
//!
//! Nothing personal is sent: an anonymous id the front end keeps, and the name
//! of the screen. Never a project name, never a path on disk. The whole body
//! is the two fields built in `page_view` below - there is no third one.
//!
//! This file is only the wire. Whether anything is sent at all, and what the
//! id is, is decided in `src/analytics.js`: it holds the user's yes or no, and
//! the random number generated once and kept in the browser store. The link in
//! the question DevHQ asks on first run points here, so both halves can be
//! read before answering it.

const HOST: &str = "pagerain.net";
const ENDPOINT: &str = "/api/analytics/apps/de44f8ee-4897-410f-85a9-66ff62e246b5/events";

/// True for the ids PageRain accepts: 8-100 letters, digits or hyphens. A
/// rejected id comes back as a silent 400, so it is checked before the call
/// rather than after.
fn valid_visitor(id: &str) -> bool {
    (8..=100).contains(&id.chars().count())
        && id.chars().all(|c| c.is_ascii_alphanumeric() || c == '-')
}

/// Sends one page view. The error is returned rather than logged: analytics may
/// never change what the app does, so the caller decides what to do with it.
pub fn page_view(visitor_id: &str, path: &str) -> Result<(), String> {
    if !valid_visitor(visitor_id) {
        return Err("visitor id is not an anonymous id PageRain accepts".into());
    }
    let body = serde_json::json!({ "visitorId": visitor_id, "path": path }).to_string();
    post(&body)
}

#[cfg(windows)]
fn post(body: &str) -> Result<(), String> {
    use windows::core::PCWSTR;
    use windows::Win32::Networking::WinHttp::{
        WinHttpCloseHandle, WinHttpConnect, WinHttpOpen, WinHttpOpenRequest, WinHttpQueryHeaders,
        WinHttpReceiveResponse, WinHttpSendRequest, INTERNET_DEFAULT_HTTPS_PORT,
        WINHTTP_ACCESS_TYPE_AUTOMATIC_PROXY, WINHTTP_FLAG_SECURE, WINHTTP_QUERY_FLAG_NUMBER,
        WINHTTP_QUERY_STATUS_CODE,
    };

    fn wide(s: &str) -> Vec<u16> {
        s.encode_utf16().chain(std::iter::once(0)).collect()
    }

    /// Closes its handle however this function leaves - the early returns below
    /// would otherwise leak a session per failed report.
    struct Handle(*mut core::ffi::c_void);
    impl Drop for Handle {
        fn drop(&mut self) {
            if !self.0.is_null() {
                unsafe { WinHttpCloseHandle(self.0) }.ok();
            }
        }
    }

    let agent = wide("DevHQ");
    let host = wide(HOST);
    let verb = wide("POST");
    let object = wide(ENDPOINT);
    // No terminator: WinHTTP takes the header block as a counted slice.
    let headers: Vec<u16> = "Content-Type: application/json".encode_utf16().collect();

    unsafe {
        let session = Handle(WinHttpOpen(
            PCWSTR(agent.as_ptr()),
            WINHTTP_ACCESS_TYPE_AUTOMATIC_PROXY,
            PCWSTR::null(),
            PCWSTR::null(),
            0,
        ));
        if session.0.is_null() {
            return Err("could not open a WinHTTP session".into());
        }

        let conn = Handle(WinHttpConnect(
            session.0,
            PCWSTR(host.as_ptr()),
            INTERNET_DEFAULT_HTTPS_PORT,
            0,
        ));
        if conn.0.is_null() {
            return Err(format!("could not reach {HOST}"));
        }

        let req = Handle(WinHttpOpenRequest(
            conn.0,
            PCWSTR(verb.as_ptr()),
            PCWSTR(object.as_ptr()),
            PCWSTR::null(),
            PCWSTR::null(),
            std::ptr::null(),
            WINHTTP_FLAG_SECURE,
        ));
        if req.0.is_null() {
            return Err("could not build the request".into());
        }

        WinHttpSendRequest(
            req.0,
            Some(&headers),
            Some(body.as_ptr() as *const core::ffi::c_void),
            body.len() as u32,
            body.len() as u32,
            0,
        )
        .map_err(|e| format!("could not send the page view: {e}"))?;
        WinHttpReceiveResponse(req.0, std::ptr::null_mut())
            .map_err(|e| format!("no answer from {HOST}: {e}"))?;

        let mut status: u32 = 0;
        let mut len = std::mem::size_of::<u32>() as u32;
        WinHttpQueryHeaders(
            req.0,
            WINHTTP_QUERY_STATUS_CODE | WINHTTP_QUERY_FLAG_NUMBER,
            PCWSTR::null(),
            Some(&mut status as *mut u32 as *mut core::ffi::c_void),
            &mut len,
            std::ptr::null_mut(),
        )
        .map_err(|e| format!("could not read the status: {e}"))?;
        if !(200..300).contains(&status) {
            return Err(format!("PageRain answered {status}"));
        }
    }
    Ok(())
}

/// Off Windows there is no WinHTTP to post through, and nothing is reported.
#[cfg(not(windows))]
fn post(_body: &str) -> Result<(), String> {
    Err("page views are only reported on Windows".into())
}
