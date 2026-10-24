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

## What buyers and distributors get

* **Ordering:** quick order by SKU, paste or **CSV upload**, **camera barcode scanning** on phones, reorder, and **saved order lists** per job, site or van. Prices resolve server-side: contract, then tier, then list.
* **Live stock:** availability per **branch/warehouse**, refreshed every 15 seconds in the portal, with **lead times** on backorder items.
* **Pay online:** statement balances and overdue invoices by card or **Bacs Direct Debit** (Stripe Checkout); payments post to the statement immediately.
* **Multi-user trade accounts:** owners invite colleagues, nominate approvers and set **per-buyer spending limits**; orders above a limit wait for the customer's own approver. Accounts can **require a PO number**.
* **Shipment tracking:** carrier, tracking number and link on every shipped order, emailed to the buyer.
* **Mobile:** the portal is phone-friendly and installable to the home screen (PWA).
* **Accounting / ERP:** an API-key integration API (catalogue, stock and contract prices in; orders, invoices and payments out), signed webhooks, and Xero / Sage CSV exports.

## Demo instance

Set `DROPLET_DEMO=1` (and optionally `DEMO_PASSWORD`) on a separate demo deployment, create the admin from the setup link, then **Settings → Load demo data** (or `node dist/scripts/demo-data.js` in the container). It adds three branches, 26 products and three trade accounts with contract prices, orders, saved lists, an order waiting for buyer approval, and a simulated checkout. Never enable it on a distributor's live install. Locally: `npm --prefix apps/cloud-api run db:demo`.

## Before a real distributor goes live

* **Code signing.** `npm run desktop:build -- -Production -SignThumbprint <cert>` (or `-SignCommand` for Azure Trusted Signing). The build signs the app, the local engine, the installer and uninstaller, verifies the signatures and refuses `-Production` without them.
* **Release key off the build machine.** Provide the Ed25519 release key as `DROPLET_RELEASE_KEY` from your secret store (never written to disk) or `-ReleaseKeyFile` on removable/mounted storage. `-Production` refuses the dev key in `.keys/`.
* **Email.** Set `SMTP_URL` and `MAIL_FROM` (Postmark, SES, Resend, Mailgun, Microsoft 365). Admin portal → Integrations → **Send test email**.
* **MFA key backup.** Store `DROPLET_MFA_ENC_KEY` in your password manager or vault. Admin portal → Security shows its fingerprint so you can check the backup matches.
* **Payments.** Set `STRIPE_SECRET_KEY`, `STRIPE_WEBHOOK_SECRET`, `STRIPE_PAYMENT_METHODS=card,bacs_debit` and add the webhook in Stripe.
