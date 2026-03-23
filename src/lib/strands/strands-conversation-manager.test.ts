import { describe, expect, test } from "bun:test";
import { Message, TextBlock, ToolResultBlock } from "@strands-agents/sdk";
import { trimMessagesToValidBedrockWindow } from "./strands-conversation-manager";

function createTextMessage(role: "user" | "assistant", text: string): Message {
  return new Message({
    role,
    content: [new TextBlock(text)],
  });
}

function createToolResultMessage(toolUseId: string, text: string): Message {
  return new Message({
    role: "user",
    content: [
      new ToolResultBlock({
        toolUseId,
        status: "success",
        content: [new TextBlock(text)],
      }),
    ],
  });
}

describe("BedrockSafeConversationManager", () => {
  test("does not trim to a window that starts with an assistant message", () => {
    const messages = Array.from({ length: 9 }, (_, index) =>
      createTextMessage(index % 2 === 0 ? "user" : "assistant", `message ${index}`),
    );

    const changed = trimMessagesToValidBedrockWindow(messages, 8);

    expect(changed).toBe(true);
    expect(messages[0]?.role).toBe("user");
    expect(messages[0]?.content[0]).toEqual(new TextBlock("message 2"));
  });

  test("does not trim to a window that starts with a tool-result-only user message", () => {
    const messages = [
      createTextMessage("user", "Explore this repo"),
      createTextMessage("assistant", "I should inspect the workspace"),
      createToolResultMessage("tooluse_1", "{\"workspaceRoot\":\"/repo\"}"),
      createTextMessage("assistant", "Now I can inspect src"),
      createToolResultMessage("tooluse_2", "{\"path\":\"src\"}"),
      createTextMessage("assistant", "I found several files"),
      createTextMessage("user", "What is the purpose of this repo?"),
      createTextMessage("assistant", "I should read the README"),
      createToolResultMessage("tooluse_3", "{\"path\":\"README.md\"}"),
    ];

    const changed = trimMessagesToValidBedrockWindow(messages, 8);

    expect(changed).toBe(true);
    expect(messages[0]?.role).toBe("user");
    expect(messages[0]?.content[0]).toEqual(new TextBlock("What is the purpose of this repo?"));
  });
});
