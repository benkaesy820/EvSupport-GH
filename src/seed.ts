import { randomBytes, randomUUID } from "node:crypto";
import { hash } from "@node-rs/argon2";
import { count, eq } from "drizzle-orm";
import { db } from "./db.js";
import { agents, auditLogs, customers, supportChats, users } from "./schema.js";
import { config, isProduction } from "./config.js";

const explicitEmail = process.env.ADMIN_EMAIL?.trim().toLowerCase();
const explicitPassword = process.env.ADMIN_PASSWORD;
const explicitName = process.env.ADMIN_NAME?.trim();

const email = explicitEmail || "admin@evcomm.local";
const generatedPassword = randomBytes(18).toString("base64url");
const password = explicitPassword || generatedPassword;
const displayName = explicitName || "System Admin";

if (!explicitPassword && isProduction) {
  throw new Error("ADMIN_PASSWORD is required when NODE_ENV=production.");
}

if (password.length < 16) {
  throw new Error("ADMIN_PASSWORD must be at least 16 characters.");
}

const [{ value: userCount }] = await db.select({ value: count() }).from(users);
const [existingAdmin] = await db.select().from(users).where(eq(users.role, "admin")).limit(1);

if (userCount > 0 && !existingAdmin) {
  throw new Error("Users already exist but no admin was found. Refusing automatic bootstrap.");
}

if (existingAdmin) {
  console.log(`Admin already exists: ${existingAdmin.email}`);
} else {
  const adminId = randomUUID();
  await db.transaction(async (tx) => {
    await tx.insert(users).values({
      id: adminId,
      role: "admin",
      email,
      passwordHash: await hash(password),
      displayName,
      twoFactorEnabled: true,
    });

    await tx.insert(auditLogs).values({
      id: randomUUID(),
      actorId: adminId,
      action: "user_created",
      resourceType: "user",
      resourceId: adminId,
      metadata: { role: "admin", bootstrap: true },
    });
  });

  console.log(`Created bootstrap admin: ${email}`);
  if (!explicitPassword) {
    console.log(`Generated admin password: ${password}`);
    console.log("Store this password now. It will not be recoverable from the database.");
  }
}
console.log(`Database: ${config.DATABASE_URL}`);

async function ensureSampleUser(role: "agent" | "customer", sampleEmail: string, displayName: string, password: string) {
  const [existing] = await db.select().from(users).where(eq(users.email, sampleEmail)).limit(1);
  if (existing) return existing;

  const id = randomUUID();
  await db.transaction(async (tx) => {
    await tx.insert(users).values({
      id,
      role,
      email: sampleEmail,
      passwordHash: await hash(password),
      displayName,
      twoFactorEnabled: false,
    });
    if (role === "agent") await tx.insert(agents).values({ userId: id, skills: ["general_support", "technical_support"] });
    if (role === "customer") await tx.insert(customers).values({ userId: id, tags: ["sample"] });
  });
  return (await db.select().from(users).where(eq(users.id, id)).limit(1))[0];
}

if (process.env.SEED_SAMPLE_DATA === "1") {
  const agentPassword = process.env.SEED_AGENT_PASSWORD || randomBytes(18).toString("base64url");
  const customerPassword = process.env.SEED_CUSTOMER_PASSWORD || randomBytes(18).toString("base64url");
  const agent = await ensureSampleUser("agent", "agent@evcomm.local", "Sample Agent", agentPassword);
  const customer = await ensureSampleUser("customer", "customer@evcomm.local", "Sample Customer", customerPassword);

  await db.insert(supportChats).values({ id: randomUUID(), customerId: customer.id }).onConflictDoNothing();

  console.log(`Sample agent: ${agent.email}`);
  if (!process.env.SEED_AGENT_PASSWORD) console.log(`Sample agent password: ${agentPassword}`);
  console.log(`Sample customer: ${customer.email}`);
  if (!process.env.SEED_CUSTOMER_PASSWORD) console.log(`Sample customer password: ${customerPassword}`);
}
