/** Dev helper: prints the current authenticator code for a user (reads the encrypted secret). */
import { PrismaClient } from "@prisma/client";
import { decryptSecret, totpNow } from "../src/lib/mfa.js";

const email = process.argv[2];
if (!email) throw new Error("usage: npm run totp -- <email>");
const prisma = new PrismaClient();
const user = await prisma.user.findUniqueOrThrow({
  where: { email: email.toLowerCase() },
  include: { mfaFactors: { where: { confirmedAt: { not: null } } } },
});
const factor = user.mfaFactors[0];
if (!factor) throw new Error(`${email} has no confirmed authenticator`);
const left = 30 - (Math.floor(Date.now() / 1000) % 30);
console.log(`${totpNow(decryptSecret(factor.secretEnc))}  (valid ~${left}s)`);
await prisma.$disconnect();
