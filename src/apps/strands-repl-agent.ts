import { stdin as input, stdout as output } from "node:process";
import { createInterface } from "node:readline/promises";
import { Agent } from "@strands-agents/sdk";
import {
  buildWorkspaceTools,
  createStrandsConversationManager,
  createStrandsModel,
  createStrandsSessionManager,
  getAssistantText,
  getStrandsRuntimeConfig,
  getStrandsSessionStoreLabel,
} from "../lib/strands";

async function createStrandsAgent() {
  const config = getStrandsRuntimeConfig();
  const sessionManager = await createStrandsSessionManager(config);
  const conversationManager = createStrandsConversationManager(config);

  const agent = new Agent({
    name: "Strands REPL Agent",
    model: createStrandsModel(config),
    tools: buildWorkspaceTools(),
    printer: true,
    systemPrompt: `You are a helpful AI agent running in a local coding workspace.
Use tools when they would improve accuracy.
When answering questions about local files, prefer inspecting the workspace instead of guessing.
Be concise, explicit about assumptions, and focus on the next useful step.`,
    conversationManager,
    sessionManager,
  });

  return {
    config,
    agent,
    sessionManager,
  };
}

async function main() {
  let { config, agent, sessionManager } = await createStrandsAgent();
  await agent.initialize();

  const rl = createInterface({ input, output });

  console.log(`Model: ${config.modelId}`);
  console.log(`Session: ${config.sessionId}`);
  console.log(`Session store: ${getStrandsSessionStoreLabel(config)}`);
  console.log(`Session storage: ${config.sessionStorageType}`);
  console.log(`Conversation manager: ${config.conversationManagerType}`);
  console.log(`AWS profile: ${config.awsProfile}`);
  console.log(`AWS region: ${config.awsRegion}`);
  console.log(`Workspace: ${process.cwd()}`);
  console.log("Commands: /exit, /clear");

  try {
    while (true) {
      const userInput = (await rl.question("\nYou: ")).trim();

      if (!userInput) {
        continue;
      }

      if (userInput === "/exit") {
        break;
      }

      if (userInput === "/clear") {
        await sessionManager.deleteSession();
        ({ config, agent, sessionManager } = await createStrandsAgent());
        await agent.initialize();
        console.log("Conversation cleared.");
        continue;
      }

      const result = await agent.invoke(userInput);
      console.log(`\nAssistant: ${getAssistantText(result) || "[No text content returned]"}`);
    }
  } finally {
    rl.close();
  }
}

main().catch((error) => {
  const message = error instanceof Error ? error.message : String(error);
  console.error(`\nStrands agent failed: ${message}`);
  console.error("Check .env, AWS_PROFILE, AWS_REGION/AWS_DEFAULT_REGION, AGENT_MODEL_ID, and S3 session bucket access.");
  process.exitCode = 1;
});
