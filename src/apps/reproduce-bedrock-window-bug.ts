import { BedrockModel, Message, SlidingWindowConversationManager, TextBlock } from "@strands-agents/sdk";

function createTextMessage(role: "user" | "assistant", text: string): Message {
  return new Message({
    role,
    content: [new TextBlock(text)],
  });
}

function summarizeMessage(message: Message): string {
  const parts = message.content.map((block) => {
    if (block.type === "textBlock") {
      return `text:${JSON.stringify(block.text)}`;
    }

    return block.type;
  });

  return `${message.role} [${parts.join(", ")}]`;
}

function trimWithSlidingWindow(messages: Message[], windowSize: number): Message[] {
  const trimmedMessages = [...messages];
  const manager = new SlidingWindowConversationManager({
    windowSize,
    shouldTruncateResults: false,
  });

  manager.reduce({
    agent: {
      messages: trimmedMessages,
    } as never,
    error: undefined as never,
  });

  return trimmedMessages;
}

function validateStart(messages: Message[]): string[] {
  const issues: string[] = [];
  const firstMessage = messages[0];

  if (!firstMessage) {
    issues.push("Conversation is empty.");
    return issues;
  }

  const startsWithUserText = firstMessage.role === "user"
    && firstMessage.content.some((block) => block.type === "textBlock" && block.text.trim().length > 0);

  if (!startsWithUserText) {
    issues.push("Conversation does not start with a real user text message.");
  }

  return issues;
}

function printMessages(label: string, messages: Message[]) {
  console.log(`\n${label}`);
  console.log(`Message count: ${messages.length}`);

  messages.forEach((message, index) => {
    console.log(`${index + 1}. ${summarizeMessage(message)}`);
  });

  const issues = validateStart(messages);

  if (issues.length === 0) {
    console.log("Validation: valid conversation prefix");
    return;
  }

  console.log("Validation:");
  for (const issue of issues) {
    console.log(`- ${issue}`);
  }
}

async function callBedrock(messages: Message[]) {
  const modelId = process.env.AGENT_MODEL_ID;
  const region = process.env.AWS_REGION ?? process.env.AWS_DEFAULT_REGION;

  if (!modelId || !region) {
    console.log("\nSkipping Bedrock call because AGENT_MODEL_ID or AWS region is missing.");
    return;
  }

  const model = new BedrockModel({
    modelId,
    region,
    maxTokens: 32,
    temperature: 0,
  });

  console.log("\nCalling Bedrock with the trimmed messages...");

  try {
    const stream = model.streamAggregated(messages, {
      systemPrompt: "You are a test assistant. Reply briefly.",
      toolSpecs: [],
    });

    while (true) {
      const next = await stream.next();

      if (next.done) {
        console.log(`Bedrock accepted the conversation. stopReason=${next.value.stopReason}`);
        return;
      }
    }
  } catch (error) {
    console.error(error);
  }
}

async function main() {
  const messages = Array.from({ length: 9 }, (_, index) =>
    createTextMessage(index % 2 === 0 ? "user" : "assistant", `message ${index}`),
  );
  const windowSize = 8;
  const trimmedMessages = trimWithSlidingWindow(messages, windowSize);

  console.log("Minimal reproduction for SlidingWindowConversationManager.");
  console.log("Expected: trimmed conversation should still start with a user message.");

  printMessages("Original messages", messages);
  printMessages(`Trimmed messages (windowSize=${windowSize})`, trimmedMessages);
  await callBedrock(trimmedMessages);

  const issues = validateStart(trimmedMessages);
  if (issues.length > 0) {
    process.exitCode = 1;
  }
}

main().catch((error) => {
  const message = error instanceof Error ? error.message : String(error);
  console.error(`Reproduction script failed: ${message}`);
  process.exitCode = 1;
});
