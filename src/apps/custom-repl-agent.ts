import { stdin as input, stdout as output } from "node:process";
import { createInterface } from "node:readline/promises";
import { createAgentRuntime } from "../lib/custom";

async function main() {
  const agent = await createAgentRuntime({
    onToolRequest(name, toolInput) {
      console.log(`\n[tool] ${name}(${JSON.stringify(toolInput)})`);
    },
    onToolResult(name, result) {
      console.log(`[tool-result:${name}] ${result}`);
    },
  });

  const rl = createInterface({ input, output });
  const config = agent.getConfig();
  const traceFile = await agent.getTraceFilePath();

  console.log(`Model: ${config.modelId}`);
  console.log(`Session: ${agent.getSessionId()}`);
  console.log(`Session store: ${agent.getSessionStoreLabel()}`);
  console.log(`AWS profile: ${config.awsProfile}`);
  console.log(`AWS region: ${config.awsRegion}`);
  console.log(`Workspace: ${process.cwd()}`);
  console.log(`Trace file: ${traceFile}`);
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
        await agent.clearConversation();
        console.log("Conversation cleared.");
        continue;
      }

      const result = await agent.run(userInput);
      console.log(`\nAssistant: ${result.assistantText || "[No text content returned]"}`);
    }
  } finally {
    rl.close();
  }
}

main().catch((error) => {
  const message = error instanceof Error ? error.message : String(error);
  console.error(`\nAgent loop failed: ${message}`);
  console.error("Check .env, AWS_PROFILE, AWS_REGION/AWS_DEFAULT_REGION, AGENT_MODEL_ID, and MAX_AGENT_ITERATIONS.");
  process.exitCode = 1;
});
