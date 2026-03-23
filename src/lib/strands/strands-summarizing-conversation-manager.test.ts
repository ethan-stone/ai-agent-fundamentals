import { describe, expect, test } from "bun:test";
import { Message, TextBlock, ToolResultBlock } from "@strands-agents/sdk";
import {
  findSummarySplitIndex,
  replaceMessagesWithSummary,
} from "./strands-summarizing-conversation-manager";

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

describe("StrandsSummarizingConversationManager helpers", () => {
  test("chooses a summary split that leaves a valid user message at the start of the remaining window", () => {
    const messages = [
      createTextMessage("user", "Initial request"),
      createTextMessage("assistant", "Planning"),
      createToolResultMessage("tooluse_1", "{\"workspaceRoot\":\"/repo\"}"),
      createTextMessage("assistant", "More planning"),
      createToolResultMessage("tooluse_2", "{\"path\":\"src\"}"),
      createTextMessage("assistant", "Found files"),
      createTextMessage("user", "Now explain the eval harness"),
      createTextMessage("assistant", "I should inspect src/evals.ts"),
      createToolResultMessage("tooluse_3", "{\"path\":\"src/evals.ts\"}"),
    ];

    const splitIndex = findSummarySplitIndex(messages, 0.35, 3);

    expect(splitIndex).toBe(6);
    expect(messages[splitIndex!]?.role).toBe("user");
    expect(messages[splitIndex!]?.content[0]).toEqual(new TextBlock("Now explain the eval harness"));
  });

  test("injects the summary into the first remaining user message to avoid starting with consecutive synthetic turns", () => {
    const messages = [
      createTextMessage("user", "Turn 1"),
      createTextMessage("assistant", "Turn 2"),
      createTextMessage("user", "Turn 3"),
      createTextMessage("assistant", "Turn 4"),
    ];

    const changed = replaceMessagesWithSummary(messages, 2, "- Earlier work happened");

    expect(changed).toBe(true);
    expect(messages).toHaveLength(2);
    expect(messages[0]?.role).toBe("user");
    expect(messages[0]?.content[0]).toEqual(new TextBlock("Summary of earlier conversation:\n- Earlier work happened"));
    expect(messages[0]?.content[1]).toEqual(new TextBlock("Turn 3"));
  });
});
