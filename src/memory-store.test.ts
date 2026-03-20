import { describe, expect, test } from "bun:test";
import { mkdtemp } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import type { Message } from "@aws-sdk/client-bedrock-runtime";
import { createSqliteSessionStore } from "./session-store";

function createTextMessage(role: "user" | "assistant", text: string): Message {
  return {
    role,
    content: [{ text }],
  };
}

describe("sqlite memory store", () => {
  test("persists messages and conversation summary by session id", async () => {
    const tempDir = await mkdtemp(join(tmpdir(), "agent-memory-store-"));
    const store = await createSqliteSessionStore(join(tempDir, "memory.sqlite"));

    await store.ensureSession("session-a");
    await store.appendMessages("session-a", [
      createTextMessage("user", "Find the entrypoint"),
      createTextMessage("assistant", "I will inspect the repo"),
    ]);

    const loadedSession = await store.loadSession("session-a");
    const initialTranscript = await store.loadTranscript("session-a");

    expect(loadedSession.sessionId).toBe("session-a");
    expect(loadedSession.storedMessageCount).toBe(2);
    expect(loadedSession.transcriptMessageCount).toBe(2);
    expect(loadedSession.messages[0]?.content?.[0]).toEqual({ text: "Find the entrypoint" });
    expect(loadedSession.conversationSummary).toBe("");
    expect(initialTranscript).toHaveLength(2);

    await store.replaceSessionMemory("session-a", {
      conversationSummary: "The user wants to inspect the repo entrypoint.",
      messages: [createTextMessage("user", "Continue from the prior inspection")],
    });

    const compactedSession = await store.loadSession("session-a");
    const transcriptAfterCompaction = await store.loadTranscript("session-a");

    expect(compactedSession.conversationSummary).toContain("inspect the repo entrypoint");
    expect(compactedSession.storedMessageCount).toBe(1);
    expect(compactedSession.transcriptMessageCount).toBe(2);
    expect(compactedSession.messages[0]?.content?.[0]).toEqual({ text: "Continue from the prior inspection" });
    expect(transcriptAfterCompaction).toHaveLength(2);
    expect(transcriptAfterCompaction[0]?.content?.[0]).toEqual({ text: "Find the entrypoint" });
    expect(transcriptAfterCompaction[1]?.content?.[0]).toEqual({ text: "I will inspect the repo" });
  });

  test("clears session memory without deleting the session record", async () => {
    const tempDir = await mkdtemp(join(tmpdir(), "agent-memory-store-"));
    const store = await createSqliteSessionStore(join(tempDir, "memory.sqlite"));

    await store.ensureSession("session-b");
    await store.appendMessages("session-b", [createTextMessage("user", "Hello")]);
    await store.clearSession("session-b");

    const clearedSession = await store.loadSession("session-b");

    expect(clearedSession.sessionId).toBe("session-b");
    expect(clearedSession.conversationSummary).toBe("");
    expect(clearedSession.messages).toHaveLength(0);
    expect(clearedSession.storedMessageCount).toBe(0);
    expect(clearedSession.transcriptMessageCount).toBe(0);
  });
});
