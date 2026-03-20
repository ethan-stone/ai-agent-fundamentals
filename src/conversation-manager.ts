import type { ContentBlock, Message, ToolResultBlock, ToolUseBlock } from "@aws-sdk/client-bedrock-runtime";

export const MAX_SESSION_MESSAGES = 12;
export const RECENT_MESSAGES_TO_KEEP = 6;
export const MAX_CONTEXT_MESSAGES = 8;
export const MAX_SUMMARY_SOURCE_CHARS = 8_000;

export type ConversationWindow = {
  messagesToSummarize: Message[];
  messagesToKeep: Message[];
};

export interface ConversationManager {
  formatMessagesForSummary(messages: Message[]): string;
  shouldCompactConversation(messages: Message[]): boolean;
  splitMessagesForCompaction(messages: Message[]): ConversationWindow;
  selectMessagesForModelContext(messages: Message[]): Message[];
}

function formatContentBlock(block: ContentBlock): string | null {
  if ("text" in block && typeof block.text === "string" && block.text.trim()) {
    return block.text.trim();
  }

  if ("toolUse" in block && block.toolUse) {
    const toolUse = block.toolUse as ToolUseBlock;
    return `Requested tool ${toolUse.name ?? "unknown"} with input ${JSON.stringify(toolUse.input ?? {})}`;
  }

  if ("toolResult" in block && block.toolResult) {
    const toolResult = block.toolResult as ToolResultBlock;
    const textBlocks = toolResult.content
      ?.flatMap((contentBlock) => ("text" in contentBlock && contentBlock.text ? [contentBlock.text] : []))
      .join(" ")
      .trim();

    return `Tool result for ${toolResult.toolUseId}: ${textBlocks ?? ""}`.trim();
  }

  return null;
}

function hasUserTextContent(message: Message): boolean {
  if (message.role !== "user") {
    return false;
  }

  return (message.content ?? []).some((block) => "text" in block && typeof block.text === "string" && block.text.trim().length > 0);
}

export class SlidingWindowConversationManager implements ConversationManager {
  constructor(
    private readonly options: {
      maxSessionMessages?: number;
      recentMessagesToKeep?: number;
      maxContextMessages?: number;
      maxSummarySourceChars?: number;
    } = {},
  ) {}

  formatMessagesForSummary(messages: Message[]): string {
    const lines = messages.flatMap((message) => {
      const content = (message.content ?? [])
        .map(formatContentBlock)
        .filter((value): value is string => Boolean(value))
        .join("\n");

      if (!content) {
        return [];
      }

      return [`${(message.role ?? "unknown").toUpperCase()}: ${content}`];
    });

    const combined = lines.join("\n\n");
    const maxSummarySourceChars = this.options.maxSummarySourceChars ?? MAX_SUMMARY_SOURCE_CHARS;

    if (combined.length <= maxSummarySourceChars) {
      return combined;
    }

    return `${combined.slice(0, maxSummarySourceChars)}\n...[truncated for summary]`;
  }

  shouldCompactConversation(messages: Message[]): boolean {
    const maxSessionMessages = this.options.maxSessionMessages ?? MAX_SESSION_MESSAGES;
    return messages.length > maxSessionMessages;
  }

  splitMessagesForCompaction(messages: Message[]): ConversationWindow {
    const recentMessagesToKeep = this.options.recentMessagesToKeep ?? RECENT_MESSAGES_TO_KEEP;
    const keepCount = Math.min(messages.length, recentMessagesToKeep);

    return {
      messagesToSummarize: messages.slice(0, messages.length - keepCount),
      messagesToKeep: messages.slice(messages.length - keepCount),
    };
  }

  selectMessagesForModelContext(messages: Message[]): Message[] {
    const maxContextMessages = this.options.maxContextMessages ?? MAX_CONTEXT_MESSAGES;
    const selectedMessages = messages.length <= maxContextMessages
      ? messages
      : messages.slice(messages.length - maxContextMessages);

    const firstSafeUserIndex = selectedMessages.findIndex(hasUserTextContent);

    if (firstSafeUserIndex <= 0) {
      return selectedMessages;
    }

    return selectedMessages.slice(firstSafeUserIndex);
  }
}
