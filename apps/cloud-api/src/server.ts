import Fastify from "fastify";
import { config } from "./config.js";
import { errorHandler } from "./auth.js";
import { desktopRoutes } from "./routes/desktop.js";
import { deviceRoutes } from "./routes/devices.js";
import { recoveryRoutes, sweepExpiredRecoveries } from "./routes/recovery.js";
import { syncRoutes } from "./routes/sync.js";
import { sessionRoutes } from "./routes/session.js";
import { portalRoutes } from "./routes/portal.js";
import { adminRoutes } from "./routes/admin.js";
import { notificationRoutes } from "./routes/notifications.js";
import { opsRoutes } from "./routes/ops.js";
import { integrationRoutes } from "./routes/integration.js";
import { onboardingRoutes } from "./routes/onboarding.js";
import { announceSetupIfNeeded } from "./onboarding.js";
import fastifyStatic from "@fastify/static";
import { existsSync } from "node:fs";
import { join } from "node:path";

// Signed tokens travel as path params, so allow long params.
const app = Fastify({ logger: true, trustProxy: true, bodyLimit: 2 * 1024 * 1024, maxParamLength: 2048 });
app.setErrorHandler(errorHandler);

await app.register(deviceRoutes);
await app.register(desktopRoutes);
await app.register(recoveryRoutes);
await app.register(syncRoutes);
await app.register(sessionRoutes);
await app.register(portalRoutes);
await app.register(onboardingRoutes);
await app.register(adminRoutes);
await app.register(notificationRoutes);
await app.register(opsRoutes);
await app.register(integrationRoutes);

// Production-style single origin: serve the built portal (apps/web/dist) with SPA fallback.
const webDist = config.webDistDir;
if (existsSync(webDist)) {
  await app.register(fastifyStatic, { root: webDist, wildcard: false });
  app.setNotFoundHandler((req, reply) =>
    req.url.startsWith("/v1/") ? reply.status(404).send({ error: "NOT_FOUND" }) : reply.sendFile("index.html"),
  );
}
app.get("/healthz", async () => ({ ok: true }));

// In production run the sweeper as a dedicated cron worker, not in every API replica.
if (process.env.RUN_SWEEPER === "1") {
  setInterval(() => void sweepExpiredRecoveries().catch((e) => app.log.error(e)), 60_000);
}

await app.listen({ port: config.port, host: process.env.HOST ?? "127.0.0.1" });
await announceSetupIfNeeded((m) => console.log(m));
