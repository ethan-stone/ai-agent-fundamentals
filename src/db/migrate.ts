import { mkdir } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { Database } from "bun:sqlite";
import { drizzle } from "drizzle-orm/bun-sqlite";
import { migrate } from "drizzle-orm/bun-sqlite/migrator";
import { readMigrationFiles } from "drizzle-orm/migrator";

const WORKSPACE_ROOT = process.cwd();
const DB_PATH = resolve(WORKSPACE_ROOT, "data", "agent-memory.sqlite");
const MIGRATIONS_FOLDER = resolve(WORKSPACE_ROOT, "drizzle");
const MIGRATIONS_TABLE = "__drizzle_migrations";

function hasLegacyMemoryTables(sqlite: Database): boolean {
  const rows = sqlite.query<{ name: string }, []>(`
    SELECT name
    FROM sqlite_master
    WHERE type = 'table'
      AND name IN ('agent_sessions', 'session_messages')
  `).all();

  return rows.length === 2;
}

function getAppliedMigrationCount(sqlite: Database): number {
  sqlite.run(`
    CREATE TABLE IF NOT EXISTS "${MIGRATIONS_TABLE}" (
      id SERIAL PRIMARY KEY,
      hash text NOT NULL,
      created_at numeric
    )
  `);

  const row = sqlite.query<{ count: number }, []>(`SELECT COUNT(*) as count FROM "${MIGRATIONS_TABLE}"`).get();
  return Number(row?.count ?? 0);
}

function baselineLegacyDatabase(sqlite: Database): void {
  if (!hasLegacyMemoryTables(sqlite)) {
    return;
  }

  if (getAppliedMigrationCount(sqlite) > 0) {
    return;
  }

  const migrations = readMigrationFiles({ migrationsFolder: MIGRATIONS_FOLDER });
  const latestMigration = migrations.at(-1);

  if (!latestMigration) {
    return;
  }

  sqlite.query(`
    INSERT INTO "${MIGRATIONS_TABLE}" ("hash", "created_at")
    VALUES (?, ?)
  `).run(latestMigration.hash, latestMigration.folderMillis);
}

export async function runMigrations(dbPath = DB_PATH): Promise<void> {
  await mkdir(dirname(dbPath), { recursive: true });

  const sqlite = new Database(dbPath, { create: true });
  sqlite.run("PRAGMA foreign_keys = ON;");

  try {
    baselineLegacyDatabase(sqlite);
    const db = drizzle(sqlite);
    migrate(db, { migrationsFolder: MIGRATIONS_FOLDER });
  } finally {
    sqlite.close();
  }
}

if (import.meta.main) {
  await runMigrations();
  console.log(`Applied migrations to ${DB_PATH}`);
}
