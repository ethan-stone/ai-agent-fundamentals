import { describe, expect, test } from "bun:test";
import type { Message, ToolResultBlock } from "@aws-sdk/client-bedrock-runtime";
import {
  formatMessagesForSummary,
  MAX_CONTEXT_MESSAGES,
  RECENT_MESSAGES_TO_KEEP,
  SlidingWindowConversationManager,
  selectMessagesForModelContext,
  shouldCompactConversation,
  splitMessagesForCompaction,
} from "./memory";

function createTextMessage(role: "user" | "assistant", text: string): Message {
  return {
    role,
    content: [{ text }],
  };
}

function createToolResultMessage(toolUseId: string, text: string): Message {
  const toolResult: ToolResultBlock = {
    toolUseId,
    content: [{ text }],
  };

  return {
    role: "user",
    content: [{ toolResult }],
  };
}

describe("memory helpers", () => {
  test("exposes the same behavior through a conversation manager instance", () => {
    const manager = new SlidingWindowConversationManager();
    const messages = [
      createTextMessage("user", "Find the scripts in package.json"),
      createTextMessage("assistant", "I will inspect the file"),
    ];

    expect(manager.formatMessagesForSummary(messages)).toContain("USER: Find the scripts in package.json");
    expect(manager.selectMessagesForModelContext(messages)).toEqual(messages);
  });

  test("formats messages into a summary-friendly transcript", () => {
    const summary = formatMessagesForSummary([
      createTextMessage("user", "Find the scripts in package.json"),
      createTextMessage("assistant", "I will inspect the file"),
    ]);

    expect(summary).toContain("USER: Find the scripts in package.json");
    expect(summary).toContain("ASSISTANT: I will inspect the file");
  });

  test("detects when compaction should happen", () => {
    const messages = Array.from({ length: 13 }, (_, index) =>
      createTextMessage(index % 2 === 0 ? "user" : "assistant", `message ${index}`),
    );

    expect(shouldCompactConversation(messages)).toBe(true);
  });

  test("keeps the most recent messages during compaction", () => {
    const messages = Array.from({ length: 10 }, (_, index) =>
      createTextMessage(index % 2 === 0 ? "user" : "assistant", `message ${index}`),
    );

    const { messagesToSummarize, messagesToKeep } = splitMessagesForCompaction(messages);

    expect(messagesToKeep).toHaveLength(RECENT_MESSAGES_TO_KEEP);
    expect(messagesToSummarize).toHaveLength(10 - RECENT_MESSAGES_TO_KEEP);
    expect(messagesToKeep[0]?.content?.[0]).toEqual({ text: "message 4" });
    expect(messagesToKeep.at(-1)?.content?.[0]).toEqual({ text: "message 9" });
  });

  test("selects only the most recent messages for model context", () => {
    const messages = Array.from({ length: 14 }, (_, index) =>
      createTextMessage(index % 2 === 0 ? "user" : "assistant", `message ${index}`),
    );

    const selectedMessages = selectMessagesForModelContext(messages);

    expect(selectedMessages).toHaveLength(MAX_CONTEXT_MESSAGES);
    expect(selectedMessages[0]?.content?.[0]).toEqual({ text: "message 6" });
    expect(selectedMessages.at(-1)?.content?.[0]).toEqual({ text: "message 13" });
  });

  test("never returns a truncated context that starts with an assistant message", () => {
    const messages = Array.from({ length: 9 }, (_, index) =>
      createTextMessage(index % 2 === 0 ? "user" : "assistant", `message ${index}`),
    );

    const selectedMessages = selectMessagesForModelContext(messages);

    expect(selectedMessages[0]?.role).toBe("user");
    expect(selectedMessages[0]?.content?.[0]).toEqual({ text: "message 2" });
    expect(selectedMessages).toHaveLength(7);
  });

  test("never returns a truncated context that starts with a tool-result-only user message", () => {
    const messages: Message[] = [
      createTextMessage("user", "Explore this repo"),
      createTextMessage("assistant", "I should inspect the workspace"),
      createToolResultMessage("tooluse_1", "{\"workspaceRoot\":\"/repo\"}"),
      createTextMessage("assistant", "Now I can inspect the source directory"),
      createToolResultMessage("tooluse_2", "{\"path\":\"src\"}"),
      createTextMessage("assistant", "I found several TypeScript files"),
      createTextMessage("user", "What is the purpose of this repo?"),
      createTextMessage("assistant", "I should read the README"),
      createToolResultMessage("tooluse_3", "{\"path\":\"README.md\"}"),
    ];

    const selectedMessages = selectMessagesForModelContext(messages);

    expect(selectedMessages[0]?.role).toBe("user");
    expect(selectedMessages[0]?.content?.[0]).toEqual({ text: "What is the purpose of this repo?" });
    expect(selectedMessages).toHaveLength(3);
  });
});
