import {
  BedrockRuntimeClient,
  ConverseCommand,
  type ContentBlock,
  type Message,
  type ToolResultBlock,
  type ToolUseBlock,
} from "@aws-sdk/client-bedrock-runtime";
import { fromIni } from "@aws-sdk/credential-providers";
import { randomUUID } from "node:crypto";
import { access, appendFile, mkdir, readdir, readFile, stat } from "node:fs/promises";
import { join, relative, resolve } from "node:path";
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
import {
  SlidingWindowConversationManager,
  type ConversationManager,
} from "./conversation-manager";
import {
  createSqliteSessionStore,
  type SessionRecord,
  type SessionStore,
} from "./session-store";
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

export type RuntimeConfig = {
  modelId: string;
  awsProfile: string;
  awsRegion: string;
  maxAgentIterations: number;
};

export type TraceEvent = {
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
  | "memory_compacted"
  | "error";
  iteration?: number;
  data: Record<string, unknown>;
};

type TraceWriter = {
  sessionId: string;
  filePath: string;
  logEvent: (event: Omit<TraceEvent, "timestamp" | "sessionId">) => Promise<void>;
};

export type AgentRunResult = {
  assistantText: string;
  traceFile: string;
  sessionId: string;
};

export type AgentRuntimeOptions = {
  sessionId?: string;
  sessionStore?: SessionStore;
  memoryStore?: SessionStore;
  conversationManager?: ConversationManager;
  onToolRequest?: (name: string, input: Record<string, unknown>) => void;
  onToolResult?: (name: string, result: string) => void;
};

function getRuntimeConfig(): RuntimeConfig {
  const parsedConfig = parseWithSchema(runtimeConfigSchema, process.env, "Runtime config");

  return {
    modelId: parsedConfig.AGENT_MODEL_ID,
    awsProfile: parsedConfig.AWS_PROFILE,
    awsRegion: parsedConfig.AWS_REGION ?? parsedConfig.AWS_DEFAULT_REGION!,
    maxAgentIterations: parsedConfig.MAX_AGENT_ITERATIONS,
  };
}

export async function assertLocalEnvFileExists(): Promise<void> {
  try {
    await access(ENV_FILE_PATH);
  } catch {
    throw new Error(`Missing required repo env file at ${ENV_FILE_PATH}.`);
  }
}

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

function getTimestampLabel() {
  return new Date().toISOString().replaceAll(":", "-");
}

async function createTraceWriter(sessionId: string): Promise<TraceWriter> {
  const filePath = join(TRACE_DIR, `${getTimestampLabel()}-${sessionId}.jsonl`);

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
    .map((line) => JSON.parse(line) as Record<string, unknown>)
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

export class AgentRuntime {
  private readonly runtimeConfig: RuntimeConfig;
  private readonly client: BedrockRuntimeClient;
  private readonly sessionId: string;
  private readonly sessionStore: SessionStore;
  private readonly conversationManager: ConversationManager;
  private readonly traceWriterPromise: Promise<TraceWriter>;
  private readonly options: AgentRuntimeOptions;

  constructor(options: AgentRuntimeOptions = {}) {
    this.runtimeConfig = getRuntimeConfig();
    this.client = new BedrockRuntimeClient({
      region: this.runtimeConfig.awsRegion,
      credentials: fromIni({ profile: this.runtimeConfig.awsProfile }),
    });
    this.sessionId = options.sessionId ?? randomUUID();
    this.sessionStore = (options.sessionStore ?? options.memoryStore) as SessionStore;
    this.conversationManager = options.conversationManager ?? new SlidingWindowConversationManager();
    this.options = options;
    this.traceWriterPromise = createTraceWriter(this.sessionId);
  }

  getConfig(): RuntimeConfig {
    return this.runtimeConfig;
  }

  getSessionId(): string {
    return this.sessionId;
  }

  getSessionStoreLabel(): string {
    return this.sessionStore.getStorageLabel();
  }

  getMemoryStoreLabel(): string {
    return this.getSessionStoreLabel();
  }

  async getTraceFilePath(): Promise<string> {
    const traceWriter = await this.traceWriterPromise;
    return traceWriter.filePath;
  }

  async startSession(): Promise<void> {
    await assertLocalEnvFileExists();
    await this.sessionStore.ensureSession(this.sessionId);
    const traceWriter = await this.traceWriterPromise;
    await traceWriter.logEvent({
      type: "session_started",
      data: {
        sessionId: this.sessionId,
        modelId: this.runtimeConfig.modelId,
        awsProfile: this.runtimeConfig.awsProfile,
        awsRegion: this.runtimeConfig.awsRegion,
        envFile: ENV_FILE_PATH,
        workspaceRoot: WORKSPACE_ROOT,
        sessionStore: this.sessionStore.getStorageLabel(),
        traceFile: traceWriter.filePath,
      },
    });
  }

  async clearConversation(): Promise<void> {
    await this.sessionStore.clearSession(this.sessionId);
    const traceWriter = await this.traceWriterPromise;
    await traceWriter.logEvent({
      type: "conversation_cleared",
      data: {
        sessionId: this.sessionId,
      },
    });
  }

  async run(userInput: string): Promise<AgentRunResult> {
    const traceWriter = await this.traceWriterPromise;
    const trimmedInput = userInput.trim();

    if (!trimmedInput) {
      throw new Error("run requires non-empty input.");
    }

    const session = await this.sessionStore.loadSession(this.sessionId);
    const userMessage = createUserMessage(trimmedInput);
    session.messages.push(userMessage);
    await this.sessionStore.appendMessages(this.sessionId, [userMessage]);
    await traceWriter.logEvent({
      type: "user_message",
      data: {
        sessionId: this.sessionId,
        text: truncateForTrace(trimmedInput),
      },
    });

    try {
      const assistantText = await this.runModelTurn(session, traceWriter);
      return {
        assistantText,
        traceFile: traceWriter.filePath,
        sessionId: this.sessionId,
      };
    } catch (error) {
      await traceWriter.logEvent({
        type: "error",
        data: {
          sessionId: this.sessionId,
          message: error instanceof Error ? error.message : String(error),
        },
      });
      throw error;
    }
  }

  private async sendConversation(session: SessionRecord) {
    const systemBlocks = [{ text: SYSTEM_PROMPT }];

    if (session.conversationSummary) {
      systemBlocks.push({
        text: `Conversation summary of earlier context:\n${session.conversationSummary}`,
      });
    }

    return this.client.send(
      new ConverseCommand({
        modelId: this.runtimeConfig.modelId,
        system: systemBlocks,
        messages: this.conversationManager.selectMessagesForModelContext(session.messages),
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

  private async executeTool(toolUse: ToolUseBlock): Promise<string> {
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

  private async compactConversationIfNeeded(session: SessionRecord, traceWriter: TraceWriter): Promise<void> {
    if (!this.conversationManager.shouldCompactConversation(session.messages)) {
      return;
    }

    const { messagesToSummarize, messagesToKeep } = this.conversationManager.splitMessagesForCompaction(session.messages);
    const summarySource = this.conversationManager.formatMessagesForSummary(messagesToSummarize);
    const summaryPrompt = [
      "Summarize this prior conversation for future agent turns.",
      "Retain user goals, important constraints, relevant file paths, tool outcomes, and any unfinished work.",
      "Be concise and factual.",
      "",
      summarySource,
    ].join("\n");

    const response = await this.client.send(
      new ConverseCommand({
        modelId: this.runtimeConfig.modelId,
        system: [{ text: "You summarize prior agent conversations for context compression." }],
        messages: [{ role: "user", content: [{ text: summaryPrompt }] }],
        inferenceConfig: {
          maxTokens: 400,
          temperature: 0.2,
        },
      }),
    );

    const summaryText = getTextFromContent(response.output?.message?.content);

    if (!summaryText) {
      throw new Error("Conversation compaction failed to produce a summary.");
    }

    session.conversationSummary = session.conversationSummary
      ? `${session.conversationSummary}\n\n${summaryText}`.trim()
      : summaryText;
    session.messages = [...messagesToKeep];
    await this.sessionStore.replaceSessionMemory(this.sessionId, {
      conversationSummary: session.conversationSummary,
      messages: session.messages,
    });

    await traceWriter.logEvent({
      type: "memory_compacted",
      data: {
        sessionId: this.sessionId,
        summarizedMessageCount: messagesToSummarize.length,
        keptMessageCount: messagesToKeep.length,
        storedMessageCount: session.messages.length,
        modelContextMessageCount: this.conversationManager.selectMessagesForModelContext(session.messages).length,
        summaryText: truncateForTrace(session.conversationSummary),
      },
    });
  }

  private async runModelTurn(session: SessionRecord, traceWriter: TraceWriter): Promise<string> {
    for (let iteration = 0; iteration < this.runtimeConfig.maxAgentIterations; iteration += 1) {
      await this.compactConversationIfNeeded(session, traceWriter);
      const response = await this.sendConversation(session);
      const assistantMessage = response.output?.message;

      if (!assistantMessage || assistantMessage.role !== "assistant") {
        throw new Error("Bedrock did not return an assistant message.");
      }

      session.messages.push(assistantMessage);
      await this.sessionStore.appendMessages(this.sessionId, [assistantMessage]);
      await traceWriter.logEvent({
        type: "model_response",
        iteration: iteration + 1,
        data: {
          sessionId: this.sessionId,
          stopReason: response.stopReason ?? "unknown",
          storedMessageCount: session.messages.length,
          modelContextMessageCount: this.conversationManager.selectMessagesForModelContext(session.messages).length,
          content: summarizeContentBlocks(assistantMessage.content),
        },
      });

      if (response.stopReason !== "tool_use") {
        const assistantText = getTextFromContent(assistantMessage.content);
        await traceWriter.logEvent({
          type: "assistant_message",
          iteration: iteration + 1,
          data: {
            sessionId: this.sessionId,
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
        this.options.onToolRequest?.(toolUse.name ?? "unknown", toolInput);
        await traceWriter.logEvent({
          type: "tool_request",
          iteration: iteration + 1,
          data: {
            sessionId: this.sessionId,
            name: toolUse.name,
            toolUseId: toolUse.toolUseId,
            input: toolInput,
          },
        });

        const result = await this.executeTool(toolUse);
        this.options.onToolResult?.(toolUse.name ?? "unknown", result);
        await traceWriter.logEvent({
          type: "tool_result",
          iteration: iteration + 1,
          data: {
            sessionId: this.sessionId,
            name: toolUse.name,
            toolUseId: toolUse.toolUseId,
            result: truncateForTrace(result),
          },
        });
        const toolResultMessage = createToolResultMessage(toolUse.toolUseId, result);
        session.messages.push(toolResultMessage);
        await this.sessionStore.appendMessages(this.sessionId, [toolResultMessage]);
      }
    }

    throw new Error(`Agent exceeded the max tool loop count of ${this.runtimeConfig.maxAgentIterations}.`);
  }
}

export async function createAgentRuntime(options: AgentRuntimeOptions = {}): Promise<AgentRuntime> {
  const sessionStore = options.sessionStore ?? options.memoryStore ?? await createSqliteSessionStore();
  const runtime = new AgentRuntime({
    ...options,
    sessionStore,
  });
  await runtime.startSession();
  return runtime;
}
