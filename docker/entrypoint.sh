#!/bin/sh
# DROPLET container start: apply pending database migrations, then run the server.
# On a brand-new database the server prints a one-time admin setup link in the logs.
set -eu

missing=""
for v in DATABASE_URL DROPLET_SIGNING_SECRET DROPLET_MFA_ENC_KEY PORTAL_ORIGIN; do
  eval "val=\${$v:-}"
  [ -n "$val" ] || missing="$missing $v"
done
if [ -n "$missing" ]; then
  echo "DROPLET: missing required environment variables:$missing" >&2
  echo "See .env.production.example in the repository." >&2
  exit 1
fi

echo "DROPLET: applying database migrations..."
attempt=1
until node_modules/.bin/prisma migrate deploy; do
  if [ "$attempt" -ge 10 ]; then
    echo "DROPLET: database not reachable after $attempt attempts" >&2
    exit 1
  fi
  echo "DROPLET: database not ready (attempt $attempt), retrying in 5s..."
  attempt=$((attempt + 1))
  sleep 5
done

exec node dist/src/server.js
