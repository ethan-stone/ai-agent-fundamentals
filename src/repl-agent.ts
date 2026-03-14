import {
  BedrockRuntimeClient,
  ConverseCommand,
  type ContentBlock,
  type Message,
  type Tool,
  type ToolResultBlock,
  type ToolUseBlock,
} from "@aws-sdk/client-bedrock-runtime";
import { fromIni } from "@aws-sdk/credential-providers";
import { appendFile, mkdir, readdir, readFile, stat } from "node:fs/promises";
import { join, relative, resolve } from "node:path";
import { stdin as input, stdout as output } from "node:process";
import { createInterface } from "node:readline/promises";

const MODEL_ID = "us.amazon.nova-2-lite-v1:0";
const AWS_PROFILE = "personal-admin";
const AWS_REGION = process.env.AWS_REGION ?? process.env.AWS_DEFAULT_REGION ?? "us-east-1";
const WORKSPACE_ROOT = process.cwd();
const TRACE_DIR = resolve(WORKSPACE_ROOT, "traces");
const MAX_AGENT_ITERATIONS = 8;
const MAX_FILE_BYTES = 16_000;
const MAX_TRACE_TEXT_LENGTH = 4_000;
const SYSTEM_PROMPT =
  `You are a helpful AI agent running in a local coding workspace.
Use tools when they would improve accuracy.
When answering questions about local files, prefer inspecting the workspace instead of guessing.
Be concise, explicit about assumptions, and focus on the next useful step.`;
const TOOLS: Tool[] = [
  {
    toolSpec: {
      name: "getCurrentDateTime",
      description: "Returns the current local date and time for this runtime.",
      inputSchema: {
        json: {
          type: "object",
          properties: {},
          additionalProperties: false,
        },
      },
    },
  },
  {
    toolSpec: {
      name: "getWorkingDirectory",
      description: "Returns the current workspace root for this agent process.",
      inputSchema: {
        json: {
          type: "object",
          properties: {},
          additionalProperties: false,
        },
      },
    },
  },
  {
    toolSpec: {
      name: "listDirectory",
      description:
        "Lists files and directories within the workspace. Use this to explore the repo structure.",
      inputSchema: {
        json: {
          type: "object",
          properties: {
            path: {
              type: "string",
              description: "Optional relative path inside the workspace. Defaults to the workspace root.",
            },
          },
          additionalProperties: false,
        },
      },
    },
  },
  {
    toolSpec: {
      name: "readTextFile",
      description: "Reads a UTF-8 text file from the workspace and returns its contents.",
      inputSchema: {
        json: {
          type: "object",
          properties: {
            path: {
              type: "string",
              description: "Relative path to a text file inside the workspace.",
            },
          },
          required: ["path"],
          additionalProperties: false,
        },
      },
    },
  },
];

const client = new BedrockRuntimeClient({
  region: AWS_REGION,
  credentials: fromIni({ profile: AWS_PROFILE }),
});

type TraceEvent = {
  timestamp: string;
  sessionId: string;
  type:
  | "session_started"
  | "user_message"
  | "model_response"
  | "tool_request"
  | "tool_result"
  | "assistant_message"
  | "conversation_cleared"
  | "error";
  iteration?: number;
  data: Record<string, unknown>;
};

type TraceWriter = {
  sessionId: string;
  filePath: string;
  logEvent: (event: Omit<TraceEvent, "timestamp" | "sessionId">) => Promise<void>;
};

function createUserMessage(text: string): Message {
  return {
    role: "user",
    content: [{ text }],
  };
}

function getTextFromContent(content: ContentBlock[] | undefined): string {
  if (!content) {
    return "";
  }

  return content
    .flatMap((block) => ("text" in block && block.text ? [block.text] : []))
    .join("\n")
    .trim();
}

function truncateForTrace(value: string): string {
  if (value.length <= MAX_TRACE_TEXT_LENGTH) {
    return value;
  }

  return `${value.slice(0, MAX_TRACE_TEXT_LENGTH)}\n...[truncated]`;
}

function summarizeContentBlocks(content: ContentBlock[] | undefined) {
  return (content ?? []).map((block) => {
    if ("text" in block && typeof block.text === "string") {
      return {
        type: "text",
        text: truncateForTrace(block.text),
      };
    }

    if ("toolUse" in block && block.toolUse) {
      return {
        type: "toolUse",
        name: block.toolUse.name,
        toolUseId: block.toolUse.toolUseId,
        input: block.toolUse.input ?? {},
      };
    }

    return {
      type: "other",
    };
  });
}

async function createTraceWriter(): Promise<TraceWriter> {
  const startedAt = new Date();
  const sessionId = startedAt.toISOString().replaceAll(":", "-");
  const filePath = join(TRACE_DIR, `${sessionId}.jsonl`);

  await mkdir(TRACE_DIR, { recursive: true });

  return {
    sessionId,
    filePath,
    async logEvent(event) {
      const payload: TraceEvent = {
        timestamp: new Date().toISOString(),
        sessionId,
        ...event,
      };

      await appendFile(filePath, `${JSON.stringify(payload)}\n`, "utf8");
    },
  };
}

function getToolInput(toolUse: ToolUseBlock): Record<string, unknown> {
  const input = toolUse.input;

  if (!input || typeof input !== "object" || Array.isArray(input)) {
    return {};
  }

  return input as Record<string, unknown>;
}

function getOptionalString(input: Record<string, unknown>, key: string): string | undefined {
  const value = input[key];
  return typeof value === "string" ? value : undefined;
}

function resolveWorkspacePath(target = "."): string {
  const resolvedPath = resolve(WORKSPACE_ROOT, target);
  const relativePath = relative(WORKSPACE_ROOT, resolvedPath);

  if (relativePath === ".." || relativePath.startsWith("../")) {
    throw new Error("Path must stay inside the workspace.");
  }

  return resolvedPath;
}

async function sendConversation(messages: Message[]) {
  return client.send(
    new ConverseCommand({
      modelId: MODEL_ID,
      system: [{ text: SYSTEM_PROMPT }],
      messages,
      toolConfig: {
        tools: TOOLS,
      },
      inferenceConfig: {
        maxTokens: 1000,
        temperature: 0.7,
      },
    }),
  );
}

function getCurrentDateTime() {
  const now = new Date();

  return {
    iso: now.toISOString(),
    locale: Intl.DateTimeFormat(undefined, {
      dateStyle: "full",
      timeStyle: "long",
    }).format(now),
    timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
  };
}

async function getWorkingDirectory() {
  return {
    workspaceRoot: WORKSPACE_ROOT,
  };
}

async function listDirectory(input: Record<string, unknown>) {
  const requestedPath = getOptionalString(input, "path") ?? ".";
  const resolvedPath = resolveWorkspacePath(requestedPath);
  const entries = await readdir(resolvedPath, { withFileTypes: true });

  return {
    path: relative(WORKSPACE_ROOT, resolvedPath) || ".",
    entries: entries.slice(0, 200).map((entry) => ({
      name: entry.name,
      type: entry.isDirectory() ? "directory" : entry.isFile() ? "file" : "other",
    })),
  };
}

async function readTextFileTool(input: Record<string, unknown>) {
  const path = getOptionalString(input, "path");

  if (!path) {
    throw new Error("readTextFile requires a string 'path' input.");
  }

  const resolvedPath = resolveWorkspacePath(path);
  const fileStats = await stat(resolvedPath);

  if (!fileStats.isFile()) {
    throw new Error("Requested path is not a file.");
  }

  if (fileStats.size > MAX_FILE_BYTES) {
    throw new Error(`File is too large to read directly. Limit is ${MAX_FILE_BYTES} bytes.`);
  }

  return {
    path: relative(WORKSPACE_ROOT, resolvedPath),
    sizeBytes: fileStats.size,
    content: await readFile(resolvedPath, "utf8"),
  };
}

async function executeTool(toolUse: ToolUseBlock): Promise<string> {
  const input = getToolInput(toolUse);

  switch (toolUse.name) {
    case "getCurrentDateTime":
      return JSON.stringify(getCurrentDateTime(), null, 2);
    case "getWorkingDirectory":
      return JSON.stringify(await getWorkingDirectory(), null, 2);
    case "listDirectory":
      return JSON.stringify(await listDirectory(input), null, 2);
    case "readTextFile":
      return JSON.stringify(await readTextFileTool(input), null, 2);
    default:
      throw new Error(`Unsupported tool requested: ${toolUse.name}`);
  }
}

function createToolResultMessage(toolUseId: string, result: string): Message {
  const toolResult: ToolResultBlock = {
    toolUseId,
    content: [{ text: result }],
  };

  return {
    role: "user",
    content: [{ toolResult }],
  };
}

function isToolUseBlock(block: ContentBlock): block is ContentBlock & { toolUse: ToolUseBlock } {
  return "toolUse" in block && Boolean(block.toolUse);
}

async function runModelTurn(messages: Message[], traceWriter: TraceWriter): Promise<string> {
    for (let iteration = 0; iteration < MAX_AGENT_ITERATIONS; iteration += 1) {
      const response = await sendConversation(messages);
      const assistantMessage = response.output?.message;

      if (!assistantMessage || assistantMessage.role !== "assistant") {
        throw new Error("Bedrock did not return an assistant message.");
      }

      messages.push(assistantMessage);
      await traceWriter.logEvent({
        type: "model_response",
        iteration: iteration + 1,
        data: {
          stopReason: response.stopReason ?? "unknown",
          content: summarizeContentBlocks(assistantMessage.content),
        },
      });

      if (response.stopReason !== "tool_use") {
        const assistantText = getTextFromContent(assistantMessage.content);
        await traceWriter.logEvent({
          type: "assistant_message",
          iteration: iteration + 1,
          data: {
            text: truncateForTrace(assistantText),
          },
        });
        return assistantText;
      }

      const toolUseBlocks = (assistantMessage.content ?? []).filter(isToolUseBlock);

      if (toolUseBlocks.length === 0) {
        throw new Error("Bedrock indicated tool use, but no tool requests were returned.");
      }

      for (const block of toolUseBlocks) {
        const toolUse = block.toolUse;

        if (!toolUse.toolUseId) {
          throw new Error("Tool request did not include a toolUseId.");
        }

        const toolInput = getToolInput(toolUse);
        console.log(`\n[tool] ${toolUse.name}(${JSON.stringify(toolInput)})`);
        await traceWriter.logEvent({
          type: "tool_request",
          iteration: iteration + 1,
          data: {
            name: toolUse.name,
            toolUseId: toolUse.toolUseId,
            input: toolInput,
          },
        });

        const result = await executeTool(toolUse);
        console.log(`[tool-result] ${truncateForTrace(result)}`);
        await traceWriter.logEvent({
          type: "tool_result",
          iteration: iteration + 1,
          data: {
            name: toolUse.name,
            toolUseId: toolUse.toolUseId,
            result: truncateForTrace(result),
          },
        });
        messages.push(createToolResultMessage(toolUse.toolUseId, result));
      }
    }

    throw new Error(`Agent exceeded the max tool loop count of ${MAX_AGENT_ITERATIONS}.`);
  }

  async function main() {
    const rl = createInterface({ input, output });
    const messages: Message[] = [];
    const traceWriter = await createTraceWriter();

    console.log(`Model: ${MODEL_ID}`);
    console.log(`AWS profile: ${AWS_PROFILE}`);
    console.log(`AWS region: ${AWS_REGION}`);
    console.log(`Workspace: ${WORKSPACE_ROOT}`);
    console.log(`Trace file: ${traceWriter.filePath}`);
    console.log("Commands: /exit, /clear");
    await traceWriter.logEvent({
      type: "session_started",
      data: {
        modelId: MODEL_ID,
        awsProfile: AWS_PROFILE,
        awsRegion: AWS_REGION,
        workspaceRoot: WORKSPACE_ROOT,
        traceFile: traceWriter.filePath,
      },
    });

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
          messages.length = 0;
          console.log("Conversation cleared.");
          await traceWriter.logEvent({
            type: "conversation_cleared",
            data: {},
          });
          continue;
        }

        messages.push(createUserMessage(userInput));
        await traceWriter.logEvent({
          type: "user_message",
          data: {
            text: truncateForTrace(userInput),
          },
        });

        try {
          const assistantText = await runModelTurn(messages, traceWriter);
          console.log(`\nAssistant: ${assistantText || "[No text content returned]"}`);
        } catch (error) {
          messages.pop();
          await traceWriter.logEvent({
            type: "error",
            data: {
              message: error instanceof Error ? error.message : String(error),
            },
          });
          throw error;
        }
      }
    } finally {
      rl.close();
    }
  }

  main().catch((error) => {
    const message = error instanceof Error ? error.message : String(error);
    console.error(`\nAgent loop failed: ${message}`);
    process.exitCode = 1;
  });
