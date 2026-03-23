import {
  AfterInvocationEvent,
  ConversationManager,
  Message,
  TextBlock,
  ToolResultBlock,
  type ConversationManagerReduceOptions,
  type LocalAgent,
} from "@strands-agents/sdk";

export type BedrockSafeConversationManagerConfig = {
  windowSize?: number;
  shouldTruncateResults?: boolean;
};

const DEFAULT_WINDOW_SIZE = 12;
const TOOL_RESULT_TOO_LARGE_MESSAGE = "The tool result was too large!";

function hasToolResult(message: Message): boolean {
  return message.content.some((block) => block.type === "toolResultBlock");
}

function hasToolUse(message: Message): boolean {
  return message.content.some((block) => block.type === "toolUseBlock");
}

function hasUserTextContent(message: Message): boolean {
  return message.role === "user"
    && message.content.some((block) => block.type === "textBlock" && block.text.trim().length > 0);
}

export function trimMessagesToValidBedrockWindow(messages: Message[], windowSize: number): boolean {
  if (messages.length <= windowSize) {
    return false;
  }

  let trimIndex = messages.length - windowSize;

  while (trimIndex < messages.length) {
    const oldestMessage = messages[trimIndex];

    if (!oldestMessage) {
      break;
    }

    if (!hasUserTextContent(oldestMessage)) {
      trimIndex += 1;
      continue;
    }

    if (hasToolResult(oldestMessage)) {
      trimIndex += 1;
      continue;
    }

    if (hasToolUse(oldestMessage)) {
      const nextMessage = messages[trimIndex + 1];
      const nextHasToolResult = nextMessage ? hasToolResult(nextMessage) : false;

      if (!nextHasToolResult) {
        trimIndex += 1;
        continue;
      }
    }

    break;
  }

  if (trimIndex >= messages.length) {
    return false;
  }

  messages.splice(0, trimIndex);
  return true;
}

function findLastMessageWithToolResults(messages: Message[]): number | undefined {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const currentMessage = messages[index];

    if (currentMessage && hasToolResult(currentMessage)) {
      return index;
    }
  }

  return undefined;
}

function truncateToolResults(messages: Message[], messageIndex: number): boolean {
  const message = messages[messageIndex];

  if (!message) {
    return false;
  }

  let foundToolResultToTruncate = false;

  for (const block of message.content) {
    if (block.type !== "toolResultBlock") {
      continue;
    }

    const firstContent = block.content[0];
    const contentText = firstContent && firstContent.type === "textBlock" ? firstContent.text : "";

    if (block.status === "error" && contentText === TOOL_RESULT_TOO_LARGE_MESSAGE) {
      return false;
    }

    foundToolResultToTruncate = true;
    break;
  }

  if (!foundToolResultToTruncate) {
    return false;
  }

  messages[messageIndex] = new Message({
    role: message.role,
    content: message.content.map((block) => {
      if (block.type !== "toolResultBlock") {
        return block;
      }

      return new ToolResultBlock({
        toolUseId: block.toolUseId,
        status: "error",
        content: [new TextBlock(TOOL_RESULT_TOO_LARGE_MESSAGE)],
      });
    }),
  });

  return true;
}

export class BedrockSafeConversationManager extends ConversationManager {
  readonly name = "custom:bedrock-safe-conversation-manager";

  constructor(
    private readonly config: BedrockSafeConversationManagerConfig = {},
  ) {
    super();
  }

  override initAgent(agent: LocalAgent): void {
    super.initAgent(agent);
    agent.addHook(AfterInvocationEvent, (event) => {
      this.trim(event.agent.messages);
    });
  }

  override reduce({ agent, error }: ConversationManagerReduceOptions): boolean {
    if (error && this.config.shouldTruncateResults !== false) {
      const messageIndex = findLastMessageWithToolResults(agent.messages);

      if (messageIndex !== undefined && truncateToolResults(agent.messages, messageIndex)) {
        return true;
      }
    }

    return this.trim(agent.messages);
  }

  private trim(messages: Message[]): boolean {
    return trimMessagesToValidBedrockWindow(messages, this.config.windowSize ?? DEFAULT_WINDOW_SIZE);
  }
}
