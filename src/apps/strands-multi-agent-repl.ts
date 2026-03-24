import { stdin as input, stdout as output } from "node:process";
import { createInterface } from "node:readline/promises";
import { Agent, tool } from "@strands-agents/sdk";
import { z } from "zod";
import {
  buildWorkspaceTools,
  createStrandsConversationManager,
  createStrandsModel,
  createStrandsSessionManager,
  getAssistantText,
  getStrandsRuntimeConfig,
  getStrandsSessionStoreLabel,
} from "../lib/strands";
import { setupTracer } from '@strands-agents/sdk/telemetry'

setupTracer({
  exporters: { otlp: true, console: true }, // Send traces to OTLP endpoint and console debug
})

const repoResearchInputSchema = z.object({
  question: z.string().trim().min(1),
  suggestedPaths: z.array(z.string().trim().min(1)).max(10).optional(),
}).strict();

const criticInputSchema = z.object({
  originalQuestion: z.string().trim().min(1),
  draftAnswer: z.string().trim().min(1),
}).strict();

function createRepoResearcherAgent() {
  const config = getStrandsRuntimeConfig();

  return new Agent({
    name: "Repo Researcher",
    model: createStrandsModel(config),
    tools: buildWorkspaceTools(),
    printer: false,
    systemPrompt: `You are a repo researcher.
Your job is to inspect the local codebase and return concise findings backed by evidence.
Use tools aggressively when file or code facts are needed.
Do not give a polished final answer for the user.

Important behavior:
- Start broad when needed: use getWorkingDirectory, listDirectory, and searchFiles to discover relevant files yourself.
- Treat any suggested paths as hints, not requirements.
- If a suggested path does not exist, keep investigating instead of asking the user for a corrected path.
- Ask the user for help only if the workspace itself is inaccessible or the question truly cannot be answered from the repo.

Return:
- the key findings
- the evidence used
- relevant file paths
- any uncertainty or missing evidence`,
  });
}

function createCriticAgent() {
  const config = getStrandsRuntimeConfig();

  return new Agent({
    name: "Critic",
    model: createStrandsModel(config),
    printer: false,
    systemPrompt: `You are a critical reviewer.
Your job is to review a draft answer for unsupported claims, weak reasoning, missing evidence, and important omissions.
Be concise and concrete.
Return short bullet points only.
If the draft is strong, say so briefly and mention any residual risk.`,
  });
}

function buildSpecialistTools() {
  return [
    tool({
      name: "repoResearcher",
      description: "Delegates to a repo research specialist that inspects the local codebase, discovers relevant files itself, and returns evidence-backed findings.",
      inputSchema: repoResearchInputSchema,
      callback: async (toolInput) => {
        const researcher = createRepoResearcherAgent();
        await researcher.initialize();

        const prompt = [
          `Question: ${toolInput.question}`,
          toolInput.suggestedPaths && toolInput.suggestedPaths.length > 0
            ? `Suggested paths to inspect first if they exist: ${toolInput.suggestedPaths.join(", ")}`
            : null,
          "Investigate the repo and return concise findings with file references when possible.",
          "If the suggested paths are wrong or missing, discover the right files yourself by searching the workspace.",
        ].filter(Boolean).join("\n");

        const result = await researcher.invoke(prompt);
        return getAssistantText(result) || "No findings returned.";
      },
    }),
    tool({
      name: "critic",
      description: "Delegates to a critic specialist that reviews a draft answer for weak claims, omissions, and unsupported statements.",
      inputSchema: criticInputSchema,
      callback: async (toolInput) => {
        const critic = createCriticAgent();
        await critic.initialize();

        const prompt = [
          `Original question: ${toolInput.originalQuestion}`,
          `Draft answer:\n${toolInput.draftAnswer}`,
          "Review this draft and return brief critique bullets only.",
        ].join("\n\n");

        const result = await critic.invoke(prompt);
        return getAssistantText(result) || "No critique returned.";
      },
    }),
  ];
}

async function createMultiAgentRuntime() {
  const config = getStrandsRuntimeConfig();
  const sessionManager = await createStrandsSessionManager(config);
  const conversationManager = createStrandsConversationManager(config);

  const orchestrator = new Agent({
    name: "Strands Multi-Agent Orchestrator",
    model: createStrandsModel(config),
    tools: buildSpecialistTools(),
    printer: true,
    systemPrompt: `You are an orchestrator agent.
You have access to two specialist agents as tools:
- repoResearcher: use this when you need facts from the local codebase
- critic: use this to review your draft before finalizing when accuracy matters

Workflow:
- use repoResearcher when the answer depends on repository facts
- synthesize a draft answer yourself
- use critic when the answer includes non-trivial claims or architectural explanation
- then produce the final user-facing answer

Important behavior:
- Do not ask the user for file paths unless the repoResearcher reports that the workspace itself is inaccessible.
- If a first research pass is inconclusive, call repoResearcher again with a better question instead of bouncing the problem back to the user.

Do not claim repo facts you have not verified.`,
    conversationManager,
    sessionManager,
  });

  return {
    config,
    orchestrator,
    sessionManager,
  };
}

async function main() {
  let { config, orchestrator, sessionManager } = await createMultiAgentRuntime();
  await orchestrator.initialize();

  const rl = createInterface({ input, output });

  console.log(`Model: ${config.modelId}`);
  console.log(`Session: ${config.sessionId}`);
  console.log(`Session store: ${getStrandsSessionStoreLabel(config)}`);
  console.log(`Session storage: ${config.sessionStorageType}`);
  console.log(`Conversation manager: ${config.conversationManagerType}`);
  console.log("Pattern: agents-as-tools");
  console.log("Agents: orchestrator, repo_researcher, critic");
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
        ({ config, orchestrator, sessionManager } = await createMultiAgentRuntime());
        await orchestrator.initialize();
        console.log("Conversation cleared.");
        continue;
      }

      const result = await orchestrator.invoke(userInput);
      console.log(`\nAssistant: ${getAssistantText(result) || "[No text content returned]"}`);
    }
  } finally {
    rl.close();
  }
}

main().catch((error) => {
  const message = error instanceof Error ? error.message : String(error);
  console.error(`\nStrands multi-agent REPL failed: ${message}`);
  console.error("Check .env, AWS_PROFILE, AWS_REGION/AWS_DEFAULT_REGION, AGENT_MODEL_ID, and session storage settings.");
  process.exitCode = 1;
});
