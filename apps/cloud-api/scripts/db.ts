/**
 * Local PostgreSQL for development: a real Postgres 17 server managed by npm (no Docker,
 * no system install). Data lives in apps/cloud-api/.pgdata. Production uses managed Postgres.
 *
 *   tsx scripts/db.ts          start (initialises the cluster on first run), stays in foreground
 */
import EmbeddedPostgres from "embedded-postgres";
import { existsSync } from "node:fs";
import { join } from "node:path";

export const DEV_DB = { port: 5544, user: "droplet", password: "droplet-dev", database: "droplet" };
export const DEV_DATABASE_URL = `postgresql://${DEV_DB.user}:${DEV_DB.password}@127.0.0.1:${DEV_DB.port}/${DEV_DB.database}`;

const dataDir = join(import.meta.dirname, "..", ".pgdata");

const pg = new EmbeddedPostgres({
  databaseDir: dataDir,
  user: DEV_DB.user,
  password: DEV_DB.password,
  port: DEV_DB.port,
  persistent: true,
  onLog: (m) => { if (process.env.DB_VERBOSE) console.log(String(m).trim()); },
  onError: (e) => console.error("[db]", e instanceof Error ? e.message : String(e)),
});

const fresh = !existsSync(join(dataDir, "PG_VERSION"));
if (fresh) await pg.initialise();
await pg.start();
if (fresh) await pg.createDatabase(DEV_DB.database);
console.log(`[db] postgres ready on 127.0.0.1:${DEV_DB.port}${fresh ? " (new cluster)" : ""}`);

const stop = async () => {
  await pg.stop();
  process.exit(0);
};
process.on("SIGINT", stop);
process.on("SIGTERM", stop);
// Keep the process alive while the server runs.
setInterval(() => {}, 1 << 30);
