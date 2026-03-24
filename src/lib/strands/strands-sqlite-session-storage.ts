import { mkdir } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { createClient, type Client } from "@libsql/client";
import { and, asc, eq, gt } from "drizzle-orm";
import { drizzle } from "drizzle-orm/libsql";
import type { Snapshot, SnapshotLocation, SnapshotManifest, SnapshotStorage } from "@strands-agents/sdk";
import { runMigrations } from "../db/migrate";
import {
  strandsHistoricalSnapshotsTable,
  strandsLatestSnapshotsTable,
  strandsSnapshotManifestsTable,
} from "../db/schema";

const WORKSPACE_ROOT = process.cwd();
const DEFAULT_DB_PATH = resolve(WORKSPACE_ROOT, "data", "agent-memory.sqlite");
const SCHEMA_VERSION = "1.0";

function getLatestStorageKey(location: SnapshotLocation): string {
  return `${location.sessionId}:${location.scope}:${location.scopeId}:latest`;
}

function getHistoricalStorageKey(location: SnapshotLocation, snapshotId: string): string {
  return `${location.sessionId}:${location.scope}:${location.scopeId}:history:${snapshotId}`;
}

function getManifestStorageKey(location: SnapshotLocation): string {
  return `${location.sessionId}:${location.scope}:${location.scopeId}:manifest`;
}

export class SqliteSnapshotStorage implements SnapshotStorage {
  private readonly client: Client;
  private readonly db;
  private initialized = false;

  constructor(private readonly dbPath: string = DEFAULT_DB_PATH) {
    this.client = createClient({ url: `file:${dbPath}` });
    this.db = drizzle(this.client);
  }

  private async initialize(): Promise<void> {
    if (this.initialized) {
      return;
    }

    await mkdir(dirname(this.dbPath), { recursive: true });
    await this.client.execute("PRAGMA foreign_keys = ON;");
    await runMigrations(this.dbPath);
    this.initialized = true;
  }

  async saveSnapshot(params: {
    location: SnapshotLocation;
    snapshotId: string;
    isLatest: boolean;
    snapshot: Snapshot;
  }): Promise<void> {
    await this.initialize();
    const now = new Date().toISOString();
    const serializedSnapshot = JSON.stringify(params.snapshot);

    if (params.isLatest) {
      const storageKey = getLatestStorageKey(params.location);
      this.db.insert(strandsLatestSnapshotsTable).values({
        storageKey,
        sessionId: params.location.sessionId,
        scope: params.location.scope,
        scopeId: params.location.scopeId,
        snapshotJson: serializedSnapshot,
        updatedAt: now,
      }).onConflictDoUpdate({
        target: strandsLatestSnapshotsTable.storageKey,
        set: {
          snapshotJson: serializedSnapshot,
          updatedAt: now,
        },
      }).run();
      return;
    }

    this.db.insert(strandsHistoricalSnapshotsTable).values({
      storageKey: getHistoricalStorageKey(params.location, params.snapshotId),
      sessionId: params.location.sessionId,
      scope: params.location.scope,
      scopeId: params.location.scopeId,
      snapshotId: params.snapshotId,
      snapshotJson: serializedSnapshot,
      createdAt: now,
    }).onConflictDoNothing().run();
  }

  async loadSnapshot(params: {
    location: SnapshotLocation;
    snapshotId?: string;
  }): Promise<Snapshot | null> {
    await this.initialize();

    if (params.snapshotId === undefined) {
      const row = await this.db.select()
        .from(strandsLatestSnapshotsTable)
        .where(eq(strandsLatestSnapshotsTable.storageKey, getLatestStorageKey(params.location)))
        .get();

      return row ? JSON.parse(row.snapshotJson) as Snapshot : null;
    }

    const row = await this.db.select()
      .from(strandsHistoricalSnapshotsTable)
      .where(eq(strandsHistoricalSnapshotsTable.storageKey, getHistoricalStorageKey(params.location, params.snapshotId)))
      .get();

    return row ? JSON.parse(row.snapshotJson) as Snapshot : null;
  }

  async listSnapshotIds(params: {
    location: SnapshotLocation;
    limit?: number;
    startAfter?: string;
  }): Promise<string[]> {
    await this.initialize();

    const filters = and(
      eq(strandsHistoricalSnapshotsTable.sessionId, params.location.sessionId),
      eq(strandsHistoricalSnapshotsTable.scope, params.location.scope),
      eq(strandsHistoricalSnapshotsTable.scopeId, params.location.scopeId),
      params.startAfter ? gt(strandsHistoricalSnapshotsTable.snapshotId, params.startAfter) : undefined,
    );

    const baseQuery = this.db.select({
      snapshotId: strandsHistoricalSnapshotsTable.snapshotId,
    }).from(strandsHistoricalSnapshotsTable)
      .where(filters)
      .orderBy(asc(strandsHistoricalSnapshotsTable.snapshotId));

    const rows = params.limit !== undefined
      ? await baseQuery.limit(params.limit).all()
      : await baseQuery.all();

    return rows.map((row) => row.snapshotId);
  }

  async deleteSession(params: { sessionId: string }): Promise<void> {
    await this.initialize();

    await this.db.transaction(async (tx) => {
      await tx.delete(strandsLatestSnapshotsTable)
        .where(eq(strandsLatestSnapshotsTable.sessionId, params.sessionId))
        .run();
      await tx.delete(strandsHistoricalSnapshotsTable)
        .where(eq(strandsHistoricalSnapshotsTable.sessionId, params.sessionId))
        .run();
      await tx.delete(strandsSnapshotManifestsTable)
        .where(eq(strandsSnapshotManifestsTable.sessionId, params.sessionId))
        .run();
    });
  }

  async loadManifest(params: { location: SnapshotLocation }): Promise<SnapshotManifest> {
    await this.initialize();

    const row = await this.db.select()
      .from(strandsSnapshotManifestsTable)
      .where(eq(strandsSnapshotManifestsTable.storageKey, getManifestStorageKey(params.location)))
      .get();

    if (!row) {
      return {
        schemaVersion: SCHEMA_VERSION,
        updatedAt: new Date().toISOString(),
      };
    }

    return JSON.parse(row.manifestJson) as SnapshotManifest;
  }

  async saveManifest(params: { location: SnapshotLocation; manifest: SnapshotManifest }): Promise<void> {
    await this.initialize();
    const now = new Date().toISOString();
    const serializedManifest = JSON.stringify(params.manifest);

    this.db.insert(strandsSnapshotManifestsTable).values({
      storageKey: getManifestStorageKey(params.location),
      sessionId: params.location.sessionId,
      scope: params.location.scope,
      scopeId: params.location.scopeId,
      manifestJson: serializedManifest,
      updatedAt: now,
    }).onConflictDoUpdate({
      target: strandsSnapshotManifestsTable.storageKey,
      set: {
        manifestJson: serializedManifest,
        updatedAt: now,
      },
    }).run();
  }
}
