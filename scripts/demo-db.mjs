#!/usr/bin/env node
/**
 * Starts an embedded PostgreSQL for local demos (no Docker required).
 * Keeps the process alive until Ctrl+C.
 */
import { mkdirSync, existsSync, writeFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";
import EmbeddedPostgres from "embedded-postgres";

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = join(__dirname, "..");
const dataDir = join(root, ".demo", "pgdata");
const port = Number(process.env.DEMO_PG_PORT ?? 5433);
const user = "qa";
const password = "qa";
const database = "qa_workbench";

mkdirSync(dataDir, { recursive: true });

const databaseUrl = `postgresql://${user}:${password}@127.0.0.1:${port}/${database}?schema=public`;

const pg = new EmbeddedPostgres({
  databaseDir: dataDir,
  user,
  password,
  port,
  persistent: true,
});

async function main() {
  const marker = join(dataDir, "PG_VERSION");
  if (!existsSync(marker)) {
    console.log("[demo-db] Initializing embedded Postgres cluster…");
    await pg.initialise();
  }

  console.log(`[demo-db] Starting Postgres on :${port}…`);
  await pg.start();

  try {
    await pg.createDatabase(database);
    console.log(`[demo-db] Database ${database} ready`);
  } catch {
    console.log(`[demo-db] Database ${database} already exists`);
  }

  // Sync root + api env for this demo session
  const envBody = [
    "NODE_ENV=development",
    "API_PORT=3001",
    "WEB_URL=http://localhost:3000",
    "API_URL=http://localhost:3001",
    `DATABASE_URL=${databaseUrl}`,
    "REDIS_URL=redis://127.0.0.1:6379",
    "SECRETS_ENCRYPTION_KEY=demo-local-secret-key-change-me-32b",
    "JIRA_BASE_URL=",
    "JIRA_EMAIL=",
    "JIRA_API_TOKEN=",
    "OLLAMA_BASE_URL=http://localhost:11434",
    "OLLAMA_MODEL=llama3.2",
    "",
  ].join("\n");
  writeFileSync(join(root, ".env"), envBody);
  writeFileSync(join(root, "apps/api/.env"), envBody);
  console.log("[demo-db] Wrote .env with embedded DATABASE_URL");

  console.log("[demo-db] Running migrations…");
  await run("npx", ["prisma", "migrate", "deploy", "--schema", "prisma/schema.prisma"], {
    cwd: join(root, "apps/api"),
    env: { ...process.env, DATABASE_URL: databaseUrl },
  });

  console.log("[demo-db] Postgres is up. Keep this terminal open.");
  console.log(`[demo-db] DATABASE_URL=${databaseUrl}`);

  const stop = async () => {
    console.log("\n[demo-db] Stopping…");
    try {
      await pg.stop();
    } catch {
      // ignore
    }
    process.exit(0);
  };
  process.on("SIGINT", stop);
  process.on("SIGTERM", stop);

  // Keep alive
  await new Promise(() => undefined);
}

function run(cmd, args, opts) {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, {
      ...opts,
      stdio: "inherit",
      shell: process.platform === "win32",
    });
    child.on("exit", (code) => {
      if (code === 0) resolve();
      else reject(new Error(`${cmd} exited ${code}`));
    });
  });
}

main().catch((err) => {
  console.error("[demo-db] Failed:", err);
  process.exit(1);
});
