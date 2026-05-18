import { createClient } from "@libsql/client";
import { drizzle } from "drizzle-orm/libsql";
import { config } from "./config.js";
import * as schema from "./schema.js";

export const libsql = createClient({
  url: config.DATABASE_URL,
  authToken: config.TURSO_AUTH_TOKEN,
});

export const db = drizzle(libsql, { schema });

export type Db = typeof db;
