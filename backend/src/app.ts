import { Hono } from "hono";
import { cors } from "hono/cors";
import { secureHeaders } from "hono/secure-headers";
import { config, isProduction } from "./config.js";
import { libsql } from "./db.js";
import { errorResponse, requestContext } from "./security.js";
import { registerAuthRoutes } from "./auth.js";
import { registerEventRoutes } from "./events.js";
import { registerFileRoutes } from "./files.js";
import { registerSupportRoutes } from "./support.js";
import { registerContentRoutes } from "./content.js";

export function createApp() {
  const app = new Hono();

  app.onError((error) => errorResponse(error));
  app.use("*", requestContext);
  app.use("*", secureHeaders());
  app.use(
    "*",
    cors({
      origin: config.CORS_ORIGIN ?? "http://localhost:3000",
      credentials: true,
    }),
  );

  app.get("/health", (c) => c.json({ ok: true }));
  app.get("/ready", async (c) => {
    await libsql.execute("select 1");
    const r2Configured = Boolean(config.R2_ACCOUNT_ID && config.R2_ACCESS_KEY_ID && config.R2_SECRET_ACCESS_KEY && (config.R2_BUCKET_NAME || config.R2_BUCKET));
    const emailConfigured = Boolean(config.BREVO_API_KEY && config.EMAIL_FROM);
    const ok = !isProduction || (r2Configured && emailConfigured);
    return c.json({
      ok,
      db: true,
      r2Configured,
      emailConfigured,
    }, ok ? 200 : 503);
  });

  registerAuthRoutes(app);
  registerEventRoutes(app);
  registerFileRoutes(app);
  registerSupportRoutes(app);
  registerContentRoutes(app);

  return app;
}
