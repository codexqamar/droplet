/**
 * Operator command: print a fresh one-time link that creates this install's first administrator.
 * Use it when you hand a new DROPLET install to a business. Refuses once an admin exists
 * (after that, admins invite further staff from Admin portal > Team).
 *
 *   npm run setup-link
 */
import { prisma } from "../src/db.js";
import { adminExists, createSetupLink, SETUP_LINK_TTL_HOURS } from "../src/onboarding.js";

if (await adminExists()) {
  console.log("This install already has an administrator. Invite more staff from Admin portal > Team.");
} else {
  const { url, expiresAt } = await createSetupLink();
  console.log(`\nOne-time admin setup link (valid ${SETUP_LINK_TTL_HOURS}h, until ${expiresAt.toISOString()}):\n\n  ${url}\n`);
}
await prisma.$disconnect();
