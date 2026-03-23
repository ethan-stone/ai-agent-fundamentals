import {
  BeforeModelCallEvent,
  ConversationManager,
  Message,
  Model,
  TextBlock,
  ToolResultBlock,
  type Agent,
  type ConversationManagerReduceOptions,
  type LocalAgent,
} from "@strands-agents/sdk";
import { trimMessagesToValidBedrockWindow } from "./strands-conversation-manager";

export type StrandsSummarizingConversationManagerConfig = {
  summaryTriggerMessages?: number;
  summaryRatio?: number;
  preserveRecentMessages?: number;
  fallbackWindowSize?: number;
  shouldTruncateResults?: boolean;
  summarizationSystemPrompt?: string;
};

const DEFAULT_SUMMARY_TRIGGER_MESSAGES = 16;
const DEFAULT_SUMMARY_RATIO = 0.35;
const DEFAULT_PRESERVE_RECENT_MESSAGES = 8;
const DEFAULT_FALLBACK_WINDOW_SIZE = 12;
const TOOL_RESULT_TOO_LARGE_MESSAGE = "The tool result was too large!";

const DEFAULT_SUMMARIZATION_PROMPT = `You are a conversation summarizer. Provide a concise summary of the conversation history.

Format requirements:
- Use bullet points.
- Do not respond conversationally.
- Do not address the user directly.
- Do not comment on tool availability.

Include:
- The main topics, goals, and constraints.
- Important tools used and their relevant results.
- Key technical facts, file paths, or code details established so far.
- Open questions or unfinished work that still matter.

Write in the third person.`;

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

function isValidBedrockWindowStart(messages: Message[], index: number): boolean {
  const candidate = messages[index];

  if (!candidate || !hasUserTextContent(candidate) || hasToolResult(candidate)) {
    return false;
  }

  if (hasToolUse(candidate)) {
    const nextMessage = messages[index + 1];
    return nextMessage ? hasToolResult(nextMessage) : false;
  }

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

export function findSummarySplitIndex(
  messages: Message[],
  summaryRatio: number,
  preserveRecentMessages: number,
): number | null {
  const initialSplitIndex = Math.max(1, Math.floor(messages.length * summaryRatio));
  const maxSummarizableCount = messages.length - preserveRecentMessages;

  if (maxSummarizableCount <= 0) {
    return null;
  }

  let splitIndex = Math.min(initialSplitIndex, maxSummarizableCount);

  while (splitIndex < messages.length && !isValidBedrockWindowStart(messages, splitIndex)) {
    splitIndex += 1;
  }

  return splitIndex >= messages.length ? null : splitIndex;
}

export function replaceMessagesWithSummary(
  messages: Message[],
  splitIndex: number,
  summaryText: string,
): boolean {
  const trimmedSummary = summaryText.trim();

  if (!trimmedSummary) {
    return false;
  }

  const remainingMessages = messages.slice(splitIndex);
  const summaryPrefix = `Summary of earlier conversation:\n${trimmedSummary}`;

  if (remainingMessages[0] && hasUserTextContent(remainingMessages[0]) && !hasToolResult(remainingMessages[0])) {
    const firstRemainingMessage = remainingMessages[0];
    remainingMessages[0] = new Message({
      role: "user",
      content: [new TextBlock(summaryPrefix), ...firstRemainingMessage.content],
    });
  } else {
    remainingMessages.unshift(new Message({
      role: "user",
      content: [new TextBlock(summaryPrefix)],
    }));
  }

  messages.splice(0, messages.length, ...remainingMessages);
  return true;
}

async function readAggregatedResult(model: Model, messages: Message[], systemPrompt: string) {
  const stream = model.streamAggregated(messages, {
    systemPrompt,
    toolSpecs: [],
  });

  while (true) {
    const next = await stream.next();

    if (next.done) {
      return next.value;
    }
  }
}

function getMessageText(message: Message): string {
  return message.content
    .filter((block) => block.type === "textBlock")
    .map((block) => block.text.trim())
    .filter(Boolean)
    .join("\n");
}

export class StrandsSummarizingConversationManager extends ConversationManager {
  readonly name = "custom:strands-summarizing-conversation-manager";

  constructor(
    private readonly config: StrandsSummarizingConversationManagerConfig = {},
  ) {
    super();
  }

  override initAgent(agent: LocalAgent): void {
    super.initAgent(agent);
    agent.addHook(BeforeModelCallEvent, async (event) => {
      await this.summarizeIfNeeded(event.agent as Agent);
    });
  }

  override reduce({ agent, error }: ConversationManagerReduceOptions): boolean {
    if (error && this.config.shouldTruncateResults !== false) {
      const messageIndex = findLastMessageWithToolResults(agent.messages);

      if (messageIndex !== undefined && truncateToolResults(agent.messages, messageIndex)) {
        return true;
      }
    }

    return trimMessagesToValidBedrockWindow(
      agent.messages,
      this.config.fallbackWindowSize ?? DEFAULT_FALLBACK_WINDOW_SIZE,
    );
  }

  private async summarizeIfNeeded(agent: Agent): Promise<void> {
    const summaryTriggerMessages = this.config.summaryTriggerMessages ?? DEFAULT_SUMMARY_TRIGGER_MESSAGES;

    if (agent.messages.length <= summaryTriggerMessages) {
      return;
    }

    const summaryRatio = clampSummaryRatio(this.config.summaryRatio ?? DEFAULT_SUMMARY_RATIO);
    const preserveRecentMessages = this.config.preserveRecentMessages ?? DEFAULT_PRESERVE_RECENT_MESSAGES;
    const splitIndex = findSummarySplitIndex(agent.messages, summaryRatio, preserveRecentMessages);

    if (splitIndex === null) {
      return;
    }

    const messagesToSummarize = agent.messages.slice(0, splitIndex);

    if (messagesToSummarize.length === 0) {
      return;
    }

    try {
      const result = await readAggregatedResult(
        agent.model,
        [
          ...messagesToSummarize,
          new Message({
            role: "user",
            content: [new TextBlock("Please summarize this conversation history.")],
          }),
        ],
        this.config.summarizationSystemPrompt ?? DEFAULT_SUMMARIZATION_PROMPT,
      );
      const summaryText = getMessageText(result.message);
      replaceMessagesWithSummary(agent.messages, splitIndex, summaryText);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      console.warn(`Summarizing conversation manager fell back without summary: ${message}`);
    }
  }
}

function clampSummaryRatio(value: number): number {
  return Math.max(0.1, Math.min(0.8, value));
}
