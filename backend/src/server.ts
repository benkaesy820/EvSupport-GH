import { serve } from "@hono/node-server";
import { config } from "./config.js";
import { createApp } from "./app.js";
import { startJobs, stopJobs } from "./jobs.js";
import { closeAllStreams } from "./events.js";

const app = createApp();

startJobs();

const server = serve({
  fetch: app.fetch,
  hostname: config.HOST,
  port: config.PORT,
});

console.log(`evComm backend listening on http://${config.HOST}:${config.PORT}`);

function shutdown() {
  stopJobs();
  closeAllStreams();
  server.close(() => process.exit(0));
}

process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);

export default app;
