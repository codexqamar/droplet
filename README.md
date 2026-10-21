# DROPLET B2B Trade Portal

Web portal, cloud API and an integrity-hardened Windows desktop app for trade customers.
Architecture, handshake, sync protocol and the security state machine: **[docs/ARCHITECTURE.md](docs/ARCHITECTURE.md)**.

## Quick start (Windows, Node 22+, Python 3.12+)

```bash
npm run setup
```

```bash
npm run dev
```

`setup` installs everything, writes `apps/cloud-api/.env` with fresh dev secrets, starts the bundled PostgreSQL 17 (no Docker needed) on port 5544 and migrates. The install starts **empty**: no demo data. `dev` runs Postgres, the API on :8080 and the portal on http://localhost:5173.

**First administrator:** the API prints a one-time setup link at first boot (or run `npm --prefix apps/cloud-api run setup-link`). Open it, create the admin, sign in, turn on two-step verification, and the admin portal opens at `/admin`. From there you approve trade applications, set pricing and credit, work orders and quotes, and invite staff. Selling DROPLET to a business works the same way: **[docs/ONBOARDING.md](docs/ONBOARDING.md)**.

## Desktop app

```bash
npm run desktop:build
```

Builds and registers a signed release: generates a dev release key in `apps/desktop/.keys/`, bundles the Python engine with PyInstaller, signs its file manifest, builds the UI from `apps/web` in desktop mode, compiles the Tauri shell and produces `apps/desktop/src-tauri/target/release/bundle/nsis/DROPLET_<version>_x64-setup.exe`, then registers it in the cloud release registry. Needs Rust (rustup) and the MSVC build tools.

To install it the way a customer would: sign in to the portal, open **Desktop app**, select **Get signed installer**, download, install, and paste the enrollment code on first launch. Staff use the shield button in the title bar (or **Staff member?** on the connect screen) to sign in to the admin portal.

Every install and upgrade places a **DROPLET** desktop shortcut and Start menu entry pointing at the app's embedded icon and refreshes the Windows icon cache. The build regenerates icons from `apps/desktop/assets/icon.svg`, re-embeds them in the exe and fails if the exe would show a generic icon.

## Layout

```
apps/
  web/            React + Tailwind. One UI, two targets: browser (cookie session → cloud API)
                  and desktop (VITE_TARGET=desktop → Tauri proxy → local engine / cloud)
    src/admin/    admin portal (staff)
  cloud-api/      Fastify + Prisma + PostgreSQL
    src/routes/session.ts     login (password + TOTP), logout, apply, MFA enrollment
    src/routes/onboarding.ts  first-admin setup link, staff/buyer invitations
    src/routes/admin.ts       admin portal API (accounts, orders, quotes, catalogue, team, security)
    src/routes/portal.ts      dashboard read model, orders, quotes
    src/routes/devices.ts     attestation challenge/verify, device enrollment
    src/routes/desktop.ts     single-use signed installer links
    src/routes/recovery.ts    tamper-lock recovery (token + password + TOTP)
    src/routes/sync.ts        desktop catalogue pull, order push, snapshot
    src/security/             tamper → lock → recovery state machine + executor
    scripts/                  embedded Postgres, setup-link, totp, register-release
  desktop/
    src-tauri/    Rust shell: integrity gate, signed tamper report, daemon supervisor + proxy
    daemon/       Python local engine (FastAPI + SQLite), DPAPI-protected device key
    tools/        build_manifest.py (hash + sign bundle)
    scripts/      build.ps1 (full release pipeline), make-icons.mjs
```

## Not production-ready yet

* **Code signing.** The installer is not Authenticode-signed; SmartScreen will warn. Add your certificate (or Azure Trusted Signing) as `bundle.windows.signCommand` in `tauri.conf.json`.
* **Release key.** The dev key lives on disk in `.keys/`; production signing belongs in an HSM/KMS.
* **Email.** All emails (recovery, approvals, invitations, quote offers) print to the API console; bind `setMailTransport` to SES/Postmark.
