/**
 * Loads sample data for sales demos (additive, never deletes; skips if already loaded).
 *
 *   npm run db:demo                         (development)
 *   node dist/scripts/demo-data.js          (Docker / Coolify container terminal)
 *
 * Set DEMO_PASSWORD to choose the demo users' password; otherwise one is generated and printed.
 */
import { loadDemoData } from "../src/demo.js";
import { prisma } from "../src/db.js";

const r = await loadDemoData();
console.log(r.message);
if (r.loaded) {
  console.log(`\nDemo sign-ins (password for all: ${r.password})`);
  for (const l of r.logins ?? []) console.log(`  ${l.email.padEnd(28)} ${l.account}: ${l.note}`);
}
await prisma.$disconnect();
