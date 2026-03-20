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
