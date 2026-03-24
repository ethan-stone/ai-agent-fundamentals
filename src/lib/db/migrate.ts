import { mkdir } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { createClient } from "@libsql/client";
import { drizzle } from "drizzle-orm/libsql";
import { migrate } from "drizzle-orm/libsql/migrator";
import { readMigrationFiles } from "drizzle-orm/migrator";

const WORKSPACE_ROOT = process.cwd();
const DB_PATH = resolve(WORKSPACE_ROOT, "data", "agent-memory.sqlite");
const MIGRATIONS_FOLDER = resolve(WORKSPACE_ROOT, "drizzle");
const MIGRATIONS_TABLE = "__drizzle_migrations";

async function hasLegacyMemoryTables(client: ReturnType<typeof createClient>): Promise<boolean> {
  const result = await client.execute(`
    SELECT name
    FROM sqlite_master
    WHERE type = 'table'
      AND name IN ('agent_sessions', 'session_messages')
  `);

  return result.rows.length === 2;
}

async function getAppliedMigrationCount(client: ReturnType<typeof createClient>): Promise<number> {
  await client.execute(`
    CREATE TABLE IF NOT EXISTS "${MIGRATIONS_TABLE}" (
      id SERIAL PRIMARY KEY,
      hash text NOT NULL,
      created_at numeric
    )
  `);

  const result = await client.execute(`SELECT COUNT(*) as count FROM "${MIGRATIONS_TABLE}"`);
  const row = result.rows[0] as { count?: number | string } | undefined;
  return Number(row?.count ?? 0);
}

async function baselineLegacyDatabase(client: ReturnType<typeof createClient>): Promise<void> {
  if (!await hasLegacyMemoryTables(client)) {
    return;
  }

  if (await getAppliedMigrationCount(client) > 0) {
    return;
  }

  const migrations = readMigrationFiles({ migrationsFolder: MIGRATIONS_FOLDER });
  const latestMigration = migrations.at(-1);

  if (!latestMigration) {
    return;
  }

  await client.execute({
    sql: `
    INSERT INTO "${MIGRATIONS_TABLE}" ("hash", "created_at")
    VALUES (?, ?)
  `,
    args: [latestMigration.hash, latestMigration.folderMillis],
  });
}

export async function runMigrations(dbPath = DB_PATH): Promise<void> {
  await mkdir(dirname(dbPath), { recursive: true });

  const client = createClient({ url: `file:${dbPath}` });
  await client.execute("PRAGMA foreign_keys = ON;");

  try {
    await baselineLegacyDatabase(client);
    const db = drizzle(client);
    await migrate(db, { migrationsFolder: MIGRATIONS_FOLDER });
  } finally {
    client.close();
  }
}

if (import.meta.main) {
  await runMigrations();
  console.log(`Applied migrations to ${DB_PATH}`);
}
