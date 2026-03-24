import { mkdir } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { createClient, type Client } from "@libsql/client";
import type { Message } from "@aws-sdk/client-bedrock-runtime";
import { asc, eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/libsql";
import { runMigrations } from "../db/migrate";
import { sessionMessagesTable, sessionTranscriptMessagesTable, sessionsTable } from "../db/schema";

const WORKSPACE_ROOT = process.cwd();
const DATA_DIR = resolve(WORKSPACE_ROOT, "data");
const DEFAULT_DB_PATH = resolve(DATA_DIR, "agent-memory.sqlite");

export type SessionRecord = {
  sessionId: string;
  conversationSummary: string;
  messages: Message[];
  storedMessageCount: number;
  transcriptMessageCount: number;
  createdAt: string;
  updatedAt: string;
};

export type ReplaceSessionMemoryInput = {
  conversationSummary: string;
  messages: Message[];
};

export interface SessionStore {
  initialize(): Promise<void>;
  ensureSession(sessionId: string): Promise<void>;
  loadSession(sessionId: string): Promise<SessionRecord>;
  loadTranscript(sessionId: string): Promise<Message[]>;
  appendMessages(sessionId: string, messages: Message[]): Promise<void>;
  replaceSessionMemory(sessionId: string, input: ReplaceSessionMemoryInput): Promise<void>;
  clearSession(sessionId: string): Promise<void>;
  getStorageLabel(): string;
}

function getIsoTimestamp(): string {
  return new Date().toISOString();
}

function serializeMessage(message: Message): string {
  return JSON.stringify(message);
}

function deserializeMessage(payloadJson: string): Message {
  return JSON.parse(payloadJson) as Message;
}

export class SqliteSessionStore implements SessionStore {
  private readonly client: Client;
  private readonly db;
  private initialized = false;

  constructor(private readonly dbPath: string = DEFAULT_DB_PATH) {
    this.client = createClient({ url: `file:${dbPath}` });
    this.db = drizzle(this.client);
  }

  async initialize(): Promise<void> {
    if (this.initialized) {
      return;
    }

    await mkdir(dirname(this.dbPath), { recursive: true });
    await this.client.execute("PRAGMA foreign_keys = ON;");
    await runMigrations(this.dbPath);
    this.initialized = true;
  }

  async ensureSession(sessionId: string): Promise<void> {
    await this.initialize();

    const existing = await this.db
      .select()
      .from(sessionsTable)
      .where(eq(sessionsTable.id, sessionId))
      .get();

    if (existing) {
      return;
    }

    const now = getIsoTimestamp();
    this.db.insert(sessionsTable).values({
      id: sessionId,
      conversationSummary: "",
      createdAt: now,
      updatedAt: now,
    }).run();
  }

  async loadSession(sessionId: string): Promise<SessionRecord> {
    await this.ensureSession(sessionId);

    const session = await this.db
      .select()
      .from(sessionsTable)
      .where(eq(sessionsTable.id, sessionId))
      .get();

    if (!session) {
      throw new Error(`Session ${sessionId} was not found.`);
    }

    const rows = await this.db
      .select()
      .from(sessionMessagesTable)
      .where(eq(sessionMessagesTable.sessionId, sessionId))
      .orderBy(asc(sessionMessagesTable.id))
      .all();

    const transcriptRows = await this.db
      .select()
      .from(sessionTranscriptMessagesTable)
      .where(eq(sessionTranscriptMessagesTable.sessionId, sessionId))
      .orderBy(asc(sessionTranscriptMessagesTable.id))
      .all();

    return {
      sessionId,
      conversationSummary: session.conversationSummary,
      messages: rows.map((row) => deserializeMessage(row.payloadJson)),
      storedMessageCount: rows.length,
      transcriptMessageCount: transcriptRows.length,
      createdAt: session.createdAt,
      updatedAt: session.updatedAt,
    };
  }

  async loadTranscript(sessionId: string): Promise<Message[]> {
    await this.ensureSession(sessionId);

    const rows = await this.db
      .select()
      .from(sessionTranscriptMessagesTable)
      .where(eq(sessionTranscriptMessagesTable.sessionId, sessionId))
      .orderBy(asc(sessionTranscriptMessagesTable.id))
      .all();

    return rows.map((row) => deserializeMessage(row.payloadJson));
  }

  async appendMessages(sessionId: string, messages: Message[]): Promise<void> {
    if (messages.length === 0) {
      return;
    }

    await this.ensureSession(sessionId);
    const now = getIsoTimestamp();

    await this.db.transaction(async (tx) => {
      await tx.insert(sessionMessagesTable).values(
        messages.map((message) => ({
          sessionId,
          payloadJson: serializeMessage(message),
          createdAt: now,
        })),
      );
      await tx.insert(sessionTranscriptMessagesTable).values(
        messages.map((message) => ({
          sessionId,
          payloadJson: serializeMessage(message),
          createdAt: now,
        })),
      );
      await tx.update(sessionsTable)
        .set({ updatedAt: now })
        .where(eq(sessionsTable.id, sessionId))
        .run();
    });
  }

  async replaceSessionMemory(sessionId: string, input: ReplaceSessionMemoryInput): Promise<void> {
    await this.ensureSession(sessionId);
    const now = getIsoTimestamp();

    await this.db.transaction(async (tx) => {
      await tx.delete(sessionMessagesTable)
        .where(eq(sessionMessagesTable.sessionId, sessionId))
        .run();

      if (input.messages.length > 0) {
        await tx.insert(sessionMessagesTable).values(
          input.messages.map((message) => ({
            sessionId,
            payloadJson: serializeMessage(message),
            createdAt: now,
          })),
        );
      }

      await tx.update(sessionsTable)
        .set({
          conversationSummary: input.conversationSummary,
          updatedAt: now,
        })
        .where(eq(sessionsTable.id, sessionId))
        .run();
    });
  }

  async clearSession(sessionId: string): Promise<void> {
    await this.ensureSession(sessionId);
    const now = getIsoTimestamp();

    await this.db.transaction(async (tx) => {
      await tx.delete(sessionMessagesTable)
        .where(eq(sessionMessagesTable.sessionId, sessionId))
        .run();
      await tx.delete(sessionTranscriptMessagesTable)
        .where(eq(sessionTranscriptMessagesTable.sessionId, sessionId))
        .run();
      await tx.update(sessionsTable)
        .set({
          conversationSummary: "",
          updatedAt: now,
        })
        .where(eq(sessionsTable.id, sessionId))
        .run();
    });
  }

  getStorageLabel(): string {
    return `sqlite:${this.dbPath}`;
  }
}

export async function createSqliteSessionStore(dbPath = DEFAULT_DB_PATH): Promise<SqliteSessionStore> {
  const store = new SqliteSessionStore(dbPath);
  await store.initialize();
  return store;
}
