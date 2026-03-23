import { integer, sqliteTable, text } from "drizzle-orm/sqlite-core";

export const sessionsTable = sqliteTable("agent_sessions", {
  id: text("id").primaryKey(),
  conversationSummary: text("conversation_summary").notNull().default(""),
  createdAt: text("created_at").notNull(),
  updatedAt: text("updated_at").notNull(),
});

export const sessionMessagesTable = sqliteTable("session_messages", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  sessionId: text("session_id")
    .notNull()
    .references(() => sessionsTable.id, { onDelete: "cascade" }),
  payloadJson: text("payload_json").notNull(),
  createdAt: text("created_at").notNull(),
});

export const sessionTranscriptMessagesTable = sqliteTable("session_transcript_messages", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  sessionId: text("session_id")
    .notNull()
    .references(() => sessionsTable.id, { onDelete: "cascade" }),
  payloadJson: text("payload_json").notNull(),
  createdAt: text("created_at").notNull(),
});

export const strandsLatestSnapshotsTable = sqliteTable("strands_latest_snapshots", {
  storageKey: text("storage_key").primaryKey(),
  sessionId: text("session_id").notNull(),
  scope: text("scope").notNull(),
  scopeId: text("scope_id").notNull(),
  snapshotJson: text("snapshot_json").notNull(),
  updatedAt: text("updated_at").notNull(),
});

export const strandsHistoricalSnapshotsTable = sqliteTable("strands_historical_snapshots", {
  storageKey: text("storage_key").primaryKey(),
  sessionId: text("session_id").notNull(),
  scope: text("scope").notNull(),
  scopeId: text("scope_id").notNull(),
  snapshotId: text("snapshot_id").notNull(),
  snapshotJson: text("snapshot_json").notNull(),
  createdAt: text("created_at").notNull(),
});

export const strandsSnapshotManifestsTable = sqliteTable("strands_snapshot_manifests", {
  storageKey: text("storage_key").primaryKey(),
  sessionId: text("session_id").notNull(),
  scope: text("scope").notNull(),
  scopeId: text("scope_id").notNull(),
  manifestJson: text("manifest_json").notNull(),
  updatedAt: text("updated_at").notNull(),
});
