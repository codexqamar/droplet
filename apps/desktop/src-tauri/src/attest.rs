//! Signed tamper report sent by the shell itself. The shell is OS-code-signed, so its report is
//! the authoritative one; the daemon cannot be trusted to report on its own modification.

use crate::integrity::Report;
use base64::{engine::general_purpose::STANDARD as B64, Engine};
use ed25519_dalek::{Signer, SigningKey};
use serde_json::{json, Value};
use std::path::PathBuf;
use std::time::{SystemTime, UNIX_EPOCH};

/// Must match `DPAPI_ENTROPY` in droplet_daemon/device.py.
const DPAPI_ENTROPY: &[u8] = b"droplet-device-key-v1";

fn data_dir() -> Option<PathBuf> {
    std::env::var_os("LOCALAPPDATA")
        .or_else(|| std::env::var_os("XDG_DATA_HOME"))
        .map(|p| PathBuf::from(p).join("com.droplet.desktop"))
}

/// Windows DPAPI (user scope): the device key file is only decryptable by this Windows user.
#[cfg(windows)]
fn unprotect(blob: &[u8]) -> Option<Vec<u8>> {
    use windows_sys::Win32::Foundation::LocalFree;
    use windows_sys::Win32::Security::Cryptography::{CryptUnprotectData, CRYPT_INTEGER_BLOB};
    let input = CRYPT_INTEGER_BLOB { cbData: blob.len() as u32, pbData: blob.as_ptr() as *mut u8 };
    let entropy = CRYPT_INTEGER_BLOB { cbData: DPAPI_ENTROPY.len() as u32, pbData: DPAPI_ENTROPY.as_ptr() as *mut u8 };
    let mut out = CRYPT_INTEGER_BLOB { cbData: 0, pbData: std::ptr::null_mut() };
    // SAFETY: all pointers are valid for the call; the output buffer is copied then freed with LocalFree.
    unsafe {
        let ok = CryptUnprotectData(&input, std::ptr::null_mut(), &entropy, std::ptr::null(), std::ptr::null(), 0, &mut out);
        if ok == 0 || out.pbData.is_null() {
            return None;
        }
        let v = std::slice::from_raw_parts(out.pbData, out.cbData as usize).to_vec();
        LocalFree(out.pbData as _);
        Some(v)
    }
}

#[cfg(not(windows))]
fn unprotect(_blob: &[u8]) -> Option<Vec<u8>> {
    None // macOS: Keychain-backed key, not wired in this build.
}

/// Same identity the daemon enrolled with (device.json + DPAPI-protected device.key).
fn load_identity(dir: &std::path::Path) -> Option<(String, String, SigningKey)> {
    let state: Value = serde_json::from_str(&std::fs::read_to_string(dir.join("device.json")).ok()?).ok()?;
    let device_id = state["device_id"].as_str()?.to_owned();
    let salt = state["install_salt"].as_str()?.to_owned();
    let seed = unprotect(&std::fs::read(dir.join("device.key")).ok()?)?;
    let key = SigningKey::from_bytes(&<[u8; 32]>::try_from(seed.as_slice()).ok()?);
    Some((device_id, salt, key))
}

fn identity_dirs() -> Vec<PathBuf> {
    let Some(root) = data_dir() else { return Vec::new() };
    let mut dirs = vec![root.clone()];
    if let Ok(entries) = std::fs::read_dir(root.join("profiles")) {
        dirs.extend(entries.flatten().filter_map(|e| e.file_type().ok().filter(|t| t.is_dir()).map(|_| e.path())));
    }
    dirs
}

fn machine_hash(salt: &str) -> String {
    use sha2::{Digest, Sha256};
    hex::encode(Sha256::digest(format!("{}|{}", crate::machine_id(), salt).as_bytes()))
}

/// Best effort: an unenrolled or offline device still halts locally; the cloud then sees no
/// recent PASS for this device and keeps it untrusted.
pub fn report_tamper(api: &str, report: &Report) -> Result<(), String> {
    let identities: Vec<_> = identity_dirs().iter().filter_map(|dir| load_identity(dir)).collect();
    if identities.is_empty() {
        return Err("device not enrolled".into());
    }
    let mut delivered = 0usize;
    let mut last_error = None;
    for (device_id, salt, key) in identities {
        match report_one(api, report, &device_id, &salt, &key) {
            Ok(()) => delivered += 1,
            Err(e) => last_error = Some(e),
        }
    }
    if delivered > 0 { Ok(()) } else { Err(last_error.unwrap_or_else(|| "tamper report not delivered".into())) }
}

fn report_one(api: &str, report: &Report, device_id: &str, salt: &str, key: &SigningKey) -> Result<(), String> {
    let agent = ureq::AgentBuilder::new().timeout(std::time::Duration::from_secs(10)).build();
    let challenge: Value = agent
        .post(&format!("{api}/v1/devices/{device_id}/challenge"))
        .call()
        .map_err(|e| e.to_string())?
        .into_json()
        .map_err(|e| e.to_string())?;

    let payload = json!({
        "v": 1,
        "kind": "attest",
        "deviceId": device_id,
        "nonce": challenge["nonce"],
        "buildId": report.build_id,
        "manifestRoot": report.manifest_root,
        "machineHash": machine_hash(salt),
        "reporter": "shell",
        "mismatches": report.mismatches,
        "ts": SystemTime::now().duration_since(UNIX_EPOCH).map_err(|e| e.to_string())?.as_secs(),
    });
    let canonical = serde_json::to_string(&payload).map_err(|e| e.to_string())?;
    let signature = B64.encode(key.sign(canonical.as_bytes()).to_bytes());

    // 423 is the expected answer (TAMPER_DETECTED); any HTTP response means the cloud recorded it.
    match agent.post(&format!("{api}/v1/attest")).send_json(json!({ "payload": payload, "signature": signature })) {
        Ok(_) | Err(ureq::Error::Status(_, _)) => Ok(()),
        Err(e) => Err(e.to_string()),
    }
}
