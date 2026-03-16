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
import { access, appendFile, mkdir, readdir, readFile, stat } from "node:fs/promises";
import { join, relative, resolve } from "node:path";
import { stdin as input, stdout as output } from "node:process";
import { createInterface } from "node:readline/promises";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { z } from "zod";
import {
  MAX_FILE_CHUNK_CHARACTERS,
  MAX_SEARCH_RESULTS,
  emptyInputSchema,
  listDirectoryInputSchema,
  readFileChunkInputSchema,
  readTextFileInputSchema,
  runtimeConfigSchema,
  searchFilesInputSchema,
} from "./agent-schemas";
import { defineTool, parseWithSchema, type ToolDefinition } from "./tooling";

const WORKSPACE_ROOT = process.cwd();
const TRACE_DIR = resolve(WORKSPACE_ROOT, "traces");
const ENV_FILE_PATH = resolve(WORKSPACE_ROOT, ".env");
const MAX_FILE_BYTES = 16_000;
const MAX_TRACE_TEXT_LENGTH = 4_000;
const SYSTEM_PROMPT =
  `You are a helpful AI agent running in a local coding workspace.
Use tools when they would improve accuracy.
When answering questions about local files, prefer inspecting the workspace instead of guessing.
Be concise, explicit about assumptions, and focus on the next useful step.`;
const execFileAsync = promisify(execFile);

type RuntimeConfig = {
  modelId: string;
  awsProfile: string;
  awsRegion: string;
  maxAgentIterations: number;
};

async function assertLocalEnvFileExists(): Promise<void> {
  try {
    await access(ENV_FILE_PATH);
  } catch {
    throw new Error(`Missing required repo env file at ${ENV_FILE_PATH}.`);
  }
}

function getRuntimeConfig(): RuntimeConfig {
  const parsedConfig = parseWithSchema(runtimeConfigSchema, process.env, "Runtime config");

  return {
    modelId: parsedConfig.AGENT_MODEL_ID,
    awsProfile: parsedConfig.AWS_PROFILE,
    awsRegion: parsedConfig.AWS_REGION ?? parsedConfig.AWS_DEFAULT_REGION!,
    maxAgentIterations: parsedConfig.MAX_AGENT_ITERATIONS,
  };
}

const runtimeConfig = getRuntimeConfig();

const client = new BedrockRuntimeClient({
  region: runtimeConfig.awsRegion,
  credentials: fromIni({ profile: runtimeConfig.awsProfile }),
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
      modelId: runtimeConfig.modelId,
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

async function listDirectory(input: z.infer<typeof listDirectoryInputSchema>) {
  const requestedPath = input.path ?? ".";
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

async function readTextFileTool(input: z.infer<typeof readTextFileInputSchema>) {
  const resolvedPath = resolveWorkspacePath(input.path);
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

async function readFileChunk(input: z.infer<typeof readFileChunkInputSchema>) {
  const resolvedPath = resolveWorkspacePath(input.path);
  const fileStats = await stat(resolvedPath);

  if (!fileStats.isFile()) {
    throw new Error("Requested path is not a file.");
  }

  const safeMaxCharacters = Math.min(input.maxCharacters, MAX_FILE_CHUNK_CHARACTERS);
  const fileContent = await readFile(resolvedPath, "utf8");
  const content = fileContent.slice(input.offset, input.offset + safeMaxCharacters);

  return {
    path: relative(WORKSPACE_ROOT, resolvedPath),
    offset: input.offset,
    maxCharacters: safeMaxCharacters,
    returnedCharacters: content.length,
    returnedBytes: Buffer.byteLength(content, "utf8"),
    fileSizeBytes: fileStats.size,
    hasMore: input.offset + content.length < fileContent.length,
    content,
  };
}

async function searchFiles(input: z.infer<typeof searchFilesInputSchema>) {
  const resolvedPath = resolveWorkspacePath(input.path ?? ".");

  const args = input.searchType === "content"
    ? ["--json", "--smart-case", "--max-count", String(input.limit), input.query, resolvedPath]
    : ["--files", resolvedPath];
  let stdout = "";

  try {
    ({ stdout } = await execFileAsync("rg", args, { cwd: WORKSPACE_ROOT, maxBuffer: 1024 * 1024 }));
  } catch (error) {
    const details = error as { code?: number; stdout?: string };

    if (details.code === 1) {
      stdout = details.stdout ?? "";
    } else {
      throw new Error("searchFiles requires 'rg' (ripgrep) to be installed and available on PATH.");
    }
  }

  if (input.searchType === "fileName") {
    const matchedPaths = stdout
      .split("\n")
      .map((line) => line.trim())
      .filter(Boolean)
      .filter((line) => line.toLowerCase().includes(input.query.toLowerCase()))
      .slice(0, input.limit)
      .map((line) => relative(WORKSPACE_ROOT, line));

    return {
      query: input.query,
      searchType: input.searchType,
      path: relative(WORKSPACE_ROOT, resolvedPath) || ".",
      results: matchedPaths.map((matchedPath) => ({ path: matchedPath })),
      resultCount: matchedPaths.length,
    };
  }

  const results = stdout
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => {
      const parsedLine = JSON.parse(line) as Record<string, unknown>;
      return parsedLine;
    })
    .filter((event) => event.type === "match")
    .slice(0, input.limit)
    .map((event) => {
      const data = (event.data ?? {}) as Record<string, unknown>;
      const pathData = (data.path ?? {}) as Record<string, unknown>;
      const lineNumber = data.line_number;
      const lines = (data.lines ?? {}) as Record<string, unknown>;

      return {
        path: relative(WORKSPACE_ROOT, String(pathData.text ?? "")),
        lineNumber: typeof lineNumber === "number" ? lineNumber : null,
        preview: String(lines.text ?? "").trimEnd(),
      };
    });

  return {
    query: input.query,
    searchType: input.searchType,
    path: relative(WORKSPACE_ROOT, resolvedPath) || ".",
    results,
    resultCount: results.length,
  };
}

const TOOL_DEFINITIONS: ToolDefinition[] = [
  defineTool({
    name: "getCurrentDateTime",
    description: "Returns the current local date and time for this runtime.",
    schema: emptyInputSchema,
    handler: () => getCurrentDateTime(),
  }),
  defineTool({
    name: "getWorkingDirectory",
    description: "Returns the current workspace root for this agent process.",
    schema: emptyInputSchema,
    handler: () => getWorkingDirectory(),
  }),
  defineTool({
    name: "listDirectory",
    description: "Lists files and directories within the workspace. Use this to explore the repo structure.",
    schema: listDirectoryInputSchema,
    handler: (input) => listDirectory(input),
  }),
  defineTool({
    name: "readTextFile",
    description: "Reads a UTF-8 text file from the workspace and returns its contents.",
    schema: readTextFileInputSchema,
    handler: (input) => readTextFileTool(input),
  }),
  defineTool({
    name: "readFileChunk",
    description: "Reads part of a UTF-8 text file so larger files can be inspected incrementally.",
    schema: readFileChunkInputSchema,
    handler: (input) => readFileChunk(input),
  }),
  defineTool({
    name: "searchFiles",
    description: "Searches file contents or file names within the workspace using ripgrep.",
    schema: searchFilesInputSchema,
    handler: (input) => searchFiles(input),
  }),
];

const TOOLS = TOOL_DEFINITIONS.map((definition) => definition.tool);
const TOOL_HANDLERS = new Map<string, ToolDefinition["handler"]>(
  TOOL_DEFINITIONS.map((definition) => [definition.tool.toolSpec?.name ?? "", definition.handler]),
);

async function executeTool(toolUse: ToolUseBlock): Promise<string> {
  const input = getToolInput(toolUse);
  const toolName = toolUse.name;

  if (!toolName) {
    throw new Error("Tool request did not include a tool name.");
  }

  const handler = TOOL_HANDLERS.get(toolName);

  if (!handler) {
    throw new Error(`Unsupported tool requested: ${toolName}`);
  }

  return JSON.stringify(await handler(input), null, 2);
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
  for (let iteration = 0; iteration < runtimeConfig.maxAgentIterations; iteration += 1) {
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

  throw new Error(`Agent exceeded the max tool loop count of ${runtimeConfig.maxAgentIterations}.`);
}

async function main() {
  await assertLocalEnvFileExists();

  const rl = createInterface({ input, output });
  const messages: Message[] = [];
  const traceWriter = await createTraceWriter();

  console.log(`Model: ${runtimeConfig.modelId}`);
  console.log(`AWS profile: ${runtimeConfig.awsProfile}`);
  console.log(`AWS region: ${runtimeConfig.awsRegion}`);
  console.log(`Env file: ${ENV_FILE_PATH}`);
  console.log(`Workspace: ${WORKSPACE_ROOT}`);
  console.log(`Trace file: ${traceWriter.filePath}`);
  console.log("Commands: /exit, /clear");
  await traceWriter.logEvent({
    type: "session_started",
    data: {
      modelId: runtimeConfig.modelId,
      awsProfile: runtimeConfig.awsProfile,
      awsRegion: runtimeConfig.awsRegion,
      envFile: ENV_FILE_PATH,
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
  console.error("Check .env, AWS_PROFILE, AWS_REGION/AWS_DEFAULT_REGION, AGENT_MODEL_ID, and MAX_AGENT_ITERATIONS.");
  process.exitCode = 1;
});
