/**
 * Registers a signed desktop build in the release registry and stages its installer for download.
 * Called by apps/desktop/scripts/build.ps1 after signing; in production this is a CI step that
 * uploads to the private bucket instead of copying into releases/.
 *
 *   tsx scripts/register-release.ts <manifest-info.json> <installer.exe>
 */
import { PrismaClient } from "@prisma/client";
import { createHash } from "node:crypto";
import { copyFileSync, mkdirSync, readFileSync } from "node:fs";
import { basename, join } from "node:path";
import { RELEASES_DIR } from "../src/routes/desktop.js";

const [infoPath, installer] = process.argv.slice(2);
if (!infoPath || !installer) throw new Error("usage: register-release <manifest-info.json> <installer>");
const { fileCount: _files, ...info } = JSON.parse(readFileSync(infoPath, "utf8").replace(/^﻿/, "")) as {
  fileCount?: number;
  buildId: string;
  version: string;
  platform: string;
  manifestRoot: string;
  manifestSig: string;
};

const bytes = readFileSync(installer);
const artifactSha256 = createHash("sha256").update(bytes).digest("hex");
const artifactKey = `${info.buildId.replace(/[^A-Za-z0-9._-]/g, "_")}-${basename(installer)}`;
mkdirSync(RELEASES_DIR, { recursive: true });
copyFileSync(installer, join(RELEASES_DIR, artifactKey));

const prisma = new PrismaClient();
const release = await prisma.desktopRelease.upsert({
  where: { buildId: info.buildId },
  create: { ...info, artifactKey, artifactSha256 },
  update: { manifestRoot: info.manifestRoot, manifestSig: info.manifestSig, artifactKey, artifactSha256, revokedAt: null },
});
console.log(`Registered ${release.buildId} (${info.platform}) root=${info.manifestRoot.slice(0, 12)}… sha256=${artifactSha256.slice(0, 12)}…`);
await prisma.$disconnect();
