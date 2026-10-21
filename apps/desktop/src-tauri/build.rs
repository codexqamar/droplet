fn main() {
    // Release builds must embed the release verification key; dev builds run unsigned.
    println!("cargo:rerun-if-env-changed=DROPLET_RELEASE_PUBKEY");
    if std::env::var("PROFILE").as_deref() == Ok("release") && std::env::var("DROPLET_RELEASE_PUBKEY").is_err() {
        panic!("DROPLET_RELEASE_PUBKEY must be set for release builds");
    }
    tauri_build::build()
}
