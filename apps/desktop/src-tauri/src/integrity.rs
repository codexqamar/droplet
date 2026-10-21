//! Pre-launch integrity gate. Mirrors `droplet_daemon/integrity.py` exactly; the shell runs this
//! before the daemon is spawned, so a tampered Python bundle never executes.
//!
//! The shell binary itself is covered by the OS: Authenticode (Windows) / notarized hardened
//! runtime (macOS). Patching it breaks that signature, and the cloud's manifestRoot check
//! catches a re-signed fork because its manifest is not in the release registry.

use base64::{engine::general_purpose::STANDARD as B64, Engine};
use ed25519_dalek::{Signature, Verifier, VerifyingKey};
use serde::Serialize;
use sha2::{Digest, Sha256};
use std::collections::{BTreeMap, BTreeSet};
use std::fs::File;
use std::io::Read;
use std::path::Path;
use walkdir::WalkDir;

pub const EXIT_TAMPER: i32 = 78;
const MANIFEST: &str = "manifest.json";
const SIGNATURE: &str = "manifest.sig";
const RELEASE_PUBKEY_B64: Option<&str> = option_env!("DROPLET_RELEASE_PUBKEY");

#[derive(Debug, Clone, Serialize)]
pub struct Mismatch {
    pub path: String,
    pub expected: String,
    pub actual: String,
}

#[derive(Debug, Clone)]
pub struct Report {
    pub build_id: String,
    pub manifest_root: String,
    pub signature_valid: bool,
    pub mismatches: Vec<Mismatch>,
}

impl Report {
    pub fn ok(&self) -> bool {
        self.signature_valid && self.mismatches.is_empty()
    }
}

#[derive(Debug)]
pub struct IntegrityError(pub String);

fn sha256_file(path: &Path) -> std::io::Result<String> {
    let mut f = File::open(path)?;
    let mut h = Sha256::new();
    let mut buf = vec![0u8; 1 << 20];
    loop {
        let n = f.read(&mut buf)?;
        if n == 0 {
            break;
        }
        h.update(&buf[..n]);
    }
    Ok(hex::encode(h.finalize()))
}

fn verify_signature(message: &[u8], sig_b64: &str) -> bool {
    let Some(pk_b64) = RELEASE_PUBKEY_B64 else { return false };
    let (Ok(pk), Ok(sig)) = (B64.decode(pk_b64), B64.decode(sig_b64.trim())) else { return false };
    let (Ok(pk), Ok(sig)) = (<[u8; 32]>::try_from(pk.as_slice()), Signature::from_slice(&sig)) else { return false };
    VerifyingKey::from_bytes(&pk).map(|k| k.verify(message, &sig).is_ok()).unwrap_or(false)
}

pub fn verify(bundle: &Path) -> Result<Report, IntegrityError> {
    let err = |m: String| IntegrityError(m);
    let raw = std::fs::read_to_string(bundle.join(MANIFEST)).map_err(|e| err(format!("manifest: {e}")))?;
    let sig = std::fs::read_to_string(bundle.join(SIGNATURE)).map_err(|e| err(format!("signature: {e}")))?;
    let manifest: serde_json::Value = serde_json::from_str(&raw).map_err(|e| err(format!("manifest json: {e}")))?;
    // serde_json's default Map is ordered (BTreeMap) and compact: identical to canonical_json().
    let canonical = serde_json::to_string(&manifest).map_err(|e| err(e.to_string()))?;

    let files: BTreeMap<String, String> = serde_json::from_value(manifest["files"].clone())
        .map_err(|e| err(format!("manifest files: {e}")))?;
    let mut report = Report {
        build_id: manifest["buildId"].as_str().unwrap_or_default().to_owned(),
        manifest_root: hex::encode(Sha256::digest(canonical.as_bytes())),
        signature_valid: verify_signature(canonical.as_bytes(), &sig),
        mismatches: vec![],
    };

    let mut seen = BTreeSet::new();
    for entry in WalkDir::new(bundle).follow_links(false) {
        let entry = entry.map_err(|e| err(e.to_string()))?;
        if entry.file_type().is_dir() {
            continue;
        }
        let rel = entry
            .path()
            .strip_prefix(bundle)
            .map_err(|e| err(e.to_string()))?
            .to_string_lossy()
            .replace('\\', "/");
        if rel == MANIFEST || rel == SIGNATURE {
            continue;
        }
        seen.insert(rel.clone());
        let expected = files.get(&rel).cloned().unwrap_or_else(|| "<absent>".into());
        if entry.path_is_symlink() {
            report.mismatches.push(Mismatch { path: rel, expected, actual: "<symlink>".into() });
            continue;
        }
        let actual = sha256_file(entry.path()).map_err(|e| err(e.to_string()))?;
        if actual != expected {
            report.mismatches.push(Mismatch { path: rel, expected, actual });
        }
    }
    for (rel, expected) in &files {
        if !seen.contains(rel) {
            report.mismatches.push(Mismatch { path: rel.clone(), expected: expected.clone(), actual: "<missing>".into() });
        }
    }
    Ok(report)
}
