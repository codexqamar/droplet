#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

//! DROPLET desktop shell.
//!
//! Launch sequence:
//!   1. verify the daemon bundle against the signed manifest (integrity.rs)
//!   2. on failure: signed tamper report to the cloud (attest.rs), fatal dialog, exit 78
//!   3. spawn the daemon with a per-launch secret over env, read its port from stdout
//!   4. proxy UI → daemon calls through a Tauri command so the secret never reaches the webview
//!   5. re-verify every 15 minutes while running; daemon exit 78 is also treated as tamper
//!   6. staff (admin portal) calls go straight to the cloud through `cloud_request`; the session
//!      cookie lives only in this process's memory, never in the webview or on disk

mod attest;
mod integrity;

use rand::RngCore;
use std::io::{BufRead, BufReader};
use std::path::PathBuf;
use std::process::{Child, Command, Stdio};
use std::sync::Mutex;
use std::time::Duration;

const API: &str = match option_env!("DROPLET_API") {
    Some(v) => v,
    None => "https://api.droplet.example",
};

/// Staff web session for the admin portal. In memory only: closing the app signs staff out.
#[derive(Default)]
struct StaffSession(Mutex<Option<String>>);

struct Daemon {
    port: u16,
    secret: String,
    child: Mutex<Child>,
}

/// Keep Windows' resize shadow and rounded corners without its accent-coloured frame.
/// The webview itself is deliberately opaque: transparent undecorated WebView2 windows
/// can expose a stale non-client strip when maximized.
#[cfg(windows)]
fn configure_window_chrome(window: &tauri::WebviewWindow) {
    use std::ffi::c_void;
    use std::mem::size_of_val;
    use windows_sys::Win32::Graphics::Dwm::{
        DwmSetWindowAttribute, DWMWA_BORDER_COLOR, DWMWA_COLOR_NONE,
        DWMWA_WINDOW_CORNER_PREFERENCE, DWMWCP_ROUND,
    };

    let Ok(hwnd) = window.hwnd() else { return };
    let hwnd = hwnd.0 as *mut c_void;
    let corner = DWMWCP_ROUND;
    let border = DWMWA_COLOR_NONE;
    unsafe {
        let _ = DwmSetWindowAttribute(
            hwnd,
            DWMWA_WINDOW_CORNER_PREFERENCE as u32,
            (&corner as *const _) as *const c_void,
            size_of_val(&corner) as u32,
        );
        let _ = DwmSetWindowAttribute(
            hwnd,
            DWMWA_BORDER_COLOR as u32,
            (&border as *const _) as *const c_void,
            size_of_val(&border) as u32,
        );
    }
}

pub(crate) fn machine_id() -> String {
    #[cfg(windows)]
    {
        use winreg::{enums::HKEY_LOCAL_MACHINE, RegKey};
        RegKey::predef(HKEY_LOCAL_MACHINE)
            .open_subkey(r"SOFTWARE\Microsoft\Cryptography")
            .and_then(|k| k.get_value::<String, _>("MachineGuid"))
            .unwrap_or_default()
    }
    #[cfg(target_os = "macos")]
    {
        let out = Command::new("/usr/sbin/ioreg").args(["-rd1", "-c", "IOPlatformExpertDevice"]).output();
        out.ok()
            .and_then(|o| String::from_utf8(o.stdout).ok())
            .and_then(|s| s.lines().find(|l| l.contains("IOPlatformUUID")).map(|l| l.rsplit('"').nth(1).unwrap_or("").to_owned()))
            .unwrap_or_default()
    }
    #[cfg(all(not(windows), not(target_os = "macos")))]
    {
        std::fs::read_to_string("/etc/machine-id").map(|s| s.trim().to_owned()).unwrap_or_default()
    }
}

fn daemon_dir() -> PathBuf {
    let exe = std::env::current_exe().expect("current exe");
    let base = exe.parent().expect("exe dir");
    #[cfg(target_os = "macos")]
    let base = &base.join("../Resources");
    base.join("daemon")
}

fn fatal_tamper(detail: &str) -> ! {
    rfd::MessageDialog::new()
        .set_level(rfd::MessageLevel::Error)
        .set_title("DROPLET - integrity check failed")
        .set_description(format!(
            "DROPLET detected that its program files have been modified and has stopped for your protection.\n\n\
             Your trade account has been locked and the account owner has been emailed recovery instructions.\n\n\
             Details: {detail}"
        ))
        .show();
    std::process::exit(integrity::EXIT_TAMPER);
}

fn gate(dir: &PathBuf) {
    match integrity::verify(dir) {
        Ok(r) if r.ok() => {}
        Ok(r) => {
            if let Err(e) = attest::report_tamper(API, &r) {
                eprintln!("tamper report not delivered: {e}");
            }
            let detail = if r.signature_valid {
                format!("{} file(s) differ from the signed release", r.mismatches.len())
            } else {
                "release signature invalid".to_owned()
            };
            fatal_tamper(&detail);
        }
        Err(e) => fatal_tamper(&e.0),
    }
}

fn spawn_daemon(dir: &PathBuf) -> Daemon {
    let mut secret = [0u8; 32];
    rand::thread_rng().fill_bytes(&mut secret);
    let secret = hex::encode(secret);
    let exe = dir.join(if cfg!(windows) { "droplet-daemon.exe" } else { "droplet-daemon" });

    let mut cmd = Command::new(exe);
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        const CREATE_NO_WINDOW: u32 = 0x0800_0000;
        cmd.creation_flags(CREATE_NO_WINDOW);
    }
    let mut child = cmd
        .env("DROPLET_LAUNCH_SECRET", &secret)
        .env("DROPLET_API", API)
        .stdout(Stdio::piped())
        .stdin(Stdio::null())
        .stderr(Stdio::null())
        .spawn()
        .unwrap_or_else(|e| fatal_tamper(&format!("daemon failed to start: {e}")));

    let stdout = child.stdout.take().expect("piped stdout");
    let port = BufReader::new(stdout)
        .lines()
        .map_while(Result::ok)
        .find_map(|l| l.strip_prefix("DROPLET_DAEMON_PORT=").and_then(|p| p.parse::<u16>().ok()))
        .unwrap_or_else(|| match child.wait().ok().and_then(|s| s.code()) {
            Some(integrity::EXIT_TAMPER) => fatal_tamper("local engine refused to start"),
            other => panic!("daemon exited before announcing port: {other:?}"),
        });
    Daemon { port, secret, child: Mutex::new(child) }
}

/// UI → daemon proxy. Only paths under /v1/ are forwarded. Runs off the main thread so a
/// slow sync never freezes the window.
#[tauri::command]
async fn daemon_request(
    state: tauri::State<'_, Daemon>,
    method: String,
    path: String,
    body: Option<serde_json::Value>,
) -> Result<serde_json::Value, String> {
    if !path.starts_with("/v1/") || path.contains("..") {
        return Err("invalid path".into());
    }
    let url = format!("http://127.0.0.1:{}{}", state.port, path);
    let secret = state.secret.clone();
    tauri::async_runtime::spawn_blocking(move || {
        let req = ureq::request(&method, &url)
            .set("X-Droplet-Launch", &secret)
            .timeout(Duration::from_secs(90));
        let res = match body {
            Some(b) => req.send_json(b),
            None => req.call(),
        };
        match res {
            Ok(r) => r.into_json().map_err(|e| e.to_string()),
            Err(ureq::Error::Status(code, r)) => Err(format!("{code}:{}", r.into_string().unwrap_or_default())),
            Err(e) => Err(format!("0:{e}")),
        }
    })
    .await
    .map_err(|e| e.to_string())?
}

fn session_from_set_cookie(header: &str) -> Option<Option<String>> {
    let pair = header.split(';').next()?.trim();
    let value = pair.strip_prefix("dl_session=")?;
    Some(if value.is_empty() { None } else { Some(value.to_owned()) })
}

/// UI → cloud API proxy for the admin portal. Only /v1/ paths on the configured API.
#[tauri::command]
async fn cloud_request(
    session: tauri::State<'_, StaffSession>,
    method: String,
    path: String,
    body: Option<serde_json::Value>,
) -> Result<serde_json::Value, String> {
    if !path.starts_with("/v1/") || path.contains("..") || path.contains("://") {
        return Err("400:{\"error\":\"INVALID_PATH\"}".into());
    }
    if !matches!(method.as_str(), "GET" | "POST" | "PUT" | "PATCH" | "DELETE") {
        return Err("400:{\"error\":\"INVALID_METHOD\"}".into());
    }
    let url = format!("{API}{path}");
    let cookie = session.0.lock().map_err(|e| e.to_string())?.clone();
    let (result, set_cookie) = tauri::async_runtime::spawn_blocking(move || {
        let mut req = ureq::request(&method, &url).timeout(Duration::from_secs(30));
        if let Some(token) = cookie {
            req = req.set("Cookie", &format!("dl_session={token}"));
        }
        let res = match body {
            Some(b) => req.send_json(b),
            None => req.call(),
        };
        match res {
            Ok(r) => {
                let sc = r.header("set-cookie").map(str::to_owned);
                (r.into_json::<serde_json::Value>().map_err(|e| format!("0:{e}")), sc)
            }
            Err(ureq::Error::Status(code, r)) => {
                let sc = r.header("set-cookie").map(str::to_owned);
                (Err(format!("{code}:{}", r.into_string().unwrap_or_default())), sc)
            }
            Err(e) => (Err(format!("0:{e}")), None),
        }
    })
    .await
    .map_err(|e| e.to_string())?;
    if let Some(update) = set_cookie.as_deref().and_then(session_from_set_cookie) {
        *session.0.lock().map_err(|e| e.to_string())? = update;
    }
    result
}

fn main() {
    let dir = daemon_dir();
    gate(&dir);
    let daemon = spawn_daemon(&dir);

    tauri::Builder::default()
        .manage(daemon)
        .manage(StaffSession::default())
        .invoke_handler(tauri::generate_handler![daemon_request, cloud_request])
        .setup(move |app| {
            use tauri::Manager;
            if let Some(window) = app.get_webview_window("main") {
                // Defence in depth: keep the custom shell even if a stale platform setting or
                // upgraded WebView runtime ignores the static window configuration.
                let _ = window.set_decorations(false);
                if let Some(icon) = app.default_window_icon() {
                    let _ = window.set_icon(icon.clone());
                }
                #[cfg(windows)]
                configure_window_chrome(&window);
            }
            let handle = app.handle().clone();
            std::thread::spawn(move || loop {
                std::thread::sleep(Duration::from_secs(15 * 60));
                gate(&dir);
                let state = handle.state::<Daemon>();
                let mut child = state.child.lock().expect("daemon lock");
                if let Ok(Some(status)) = child.try_wait() {
                    if status.code() == Some(integrity::EXIT_TAMPER) {
                        fatal_tamper("local engine halted after the cloud confirmed tampering");
                    }
                }
            });
            Ok(())
        })
        .on_window_event(|window, event| {
            if let tauri::WindowEvent::Destroyed = event {
                use tauri::Manager;
                let _ = window.state::<Daemon>().child.lock().map(|mut c| c.kill());
            }
        })
        .run(tauri::generate_context!())
        .expect("error while running DROPLET");
}
