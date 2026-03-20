export {
  MAX_CONTEXT_MESSAGES,
  MAX_SESSION_MESSAGES,
  MAX_SUMMARY_SOURCE_CHARS,
  RECENT_MESSAGES_TO_KEEP,
  SlidingWindowConversationManager,
  type ConversationManager,
  type ConversationWindow,
} from "./conversation-manager";

import { SlidingWindowConversationManager } from "./conversation-manager";

const defaultConversationManager = new SlidingWindowConversationManager();

export function formatMessagesForSummary(...args: Parameters<SlidingWindowConversationManager["formatMessagesForSummary"]>) {
  return defaultConversationManager.formatMessagesForSummary(...args);
}

export function shouldCompactConversation(...args: Parameters<SlidingWindowConversationManager["shouldCompactConversation"]>) {
  return defaultConversationManager.shouldCompactConversation(...args);
}

export function splitMessagesForCompaction(...args: Parameters<SlidingWindowConversationManager["splitMessagesForCompaction"]>) {
  return defaultConversationManager.splitMessagesForCompaction(...args);
}

export function selectMessagesForModelContext(...args: Parameters<SlidingWindowConversationManager["selectMessagesForModelContext"]>) {
  return defaultConversationManager.selectMessagesForModelContext(...args);
}
