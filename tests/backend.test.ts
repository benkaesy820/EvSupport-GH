import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { resolve } from "node:path";
import { createClient } from "@libsql/client";

const testDbPath = resolve("test.sqlite");
if (existsSync(testDbPath)) rmSync(testDbPath);

process.env.NODE_ENV = "test";
process.env.DATABASE_URL = `file:${testDbPath}`;
process.env.JWT_ACCESS_SECRET = "test-access-secret-test-access-secret";
process.env.JWT_REFRESH_SECRET = "test-refresh-secret-test-refresh-secret";

const client = createClient({ url: process.env.DATABASE_URL });
const migrations = readdirSync(resolve("drizzle"))
  .filter((file) => file.endsWith(".sql"))
  .sort();

for (const file of migrations) {
  const sql = readFileSync(resolve("drizzle", file), "utf8");
  for (const statement of sql.split("--> statement-breakpoint").map((part) => part.trim()).filter(Boolean)) {
    await client.execute(statement);
  }
}

const { createApp } = await import("../src/app.js");
const app = createApp();

test("health responds", async () => {
  const response = await app.request("/health");
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { ok: true });
});

test("auth-protected route returns consistent unauthorized error", async () => {
  const response = await app.request("/me");
  assert.equal(response.status, 401);
  assert.deepEqual(await response.json(), {
    error: "UNAUTHORIZED",
    message: "Authentication is required.",
    details: {},
  });
});

test("login validates request body", async () => {
  const response = await app.request("/auth/login", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ email: "not-an-email", password: "" }),
  });
  assert.equal(response.status, 400);
  const body = await response.json();
  assert.equal(body.error, "VALIDATION_ERROR");
});
