import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { readdir, readFile, stat } from "node:fs/promises";
import { relative, resolve } from "node:path";
import { randomUUID } from "node:crypto";
import { fromIni } from "@aws-sdk/credential-providers";
import { S3Client } from "@aws-sdk/client-s3";
import { Agent, BedrockModel, SessionManager, tool, type ToolList } from "@strands-agents/sdk";
import { S3Storage } from "@strands-agents/sdk/session/s3-storage";
import { z } from "zod";
import {
  MAX_FILE_CHUNK_CHARACTERS,
  listDirectoryInputSchema,
  readFileChunkInputSchema,
  readTextFileInputSchema,
  searchFilesInputSchema,
} from "../config";
import { parseWithSchema } from "../core";
import { runtimeConfigSchema } from "../config/agent-schemas";
import { BedrockSafeConversationManager } from "./strands-conversation-manager";
import { CustomS3SnapshotStorage } from "./strands-custom-session-storage";
import { StrandsSummarizingConversationManager } from "./strands-summarizing-conversation-manager";

const WORKSPACE_ROOT = process.cwd();
const MAX_FILE_BYTES = 16_000;
const DEFAULT_SESSION_BUCKET = "ai-agent-fundamentals-session-state-475216627762-us-east-1-an";
const DEFAULT_SESSION_PREFIX = "strands";
const execFileAsync = promisify(execFile);

export const strandsConfigSchema = runtimeConfigSchema.extend({
  STRANDS_SESSION_BUCKET: z.string().trim().min(1).default(DEFAULT_SESSION_BUCKET),
  STRANDS_SESSION_PREFIX: z.string().trim().min(1).default(DEFAULT_SESSION_PREFIX),
  STRANDS_SESSION_ID: z.string().trim().min(1).optional(),
  STRANDS_SESSION_STORAGE: z.enum(["native", "custom", "sqlite"]).default("native"),
  STRANDS_CONVERSATION_MANAGER: z.enum(["safe", "summarizing"]).default("safe"),
});

export type StrandsRuntimeConfig = {
  modelId: string;
  awsProfile: string;
  awsRegion: string;
  sessionBucket: string;
  sessionPrefix: string;
  sessionId: string;
  sessionStorageType: "native" | "custom" | "sqlite";
  conversationManagerType: "safe" | "summarizing";
};

export function getStrandsRuntimeConfig(): StrandsRuntimeConfig {
  const parsedConfig = parseWithSchema(strandsConfigSchema, process.env, "Strands runtime config");

  return {
    modelId: parsedConfig.AGENT_MODEL_ID,
    awsProfile: parsedConfig.AWS_PROFILE,
    awsRegion: parsedConfig.AWS_REGION ?? parsedConfig.AWS_DEFAULT_REGION!,
    sessionBucket: parsedConfig.STRANDS_SESSION_BUCKET,
    sessionPrefix: parsedConfig.STRANDS_SESSION_PREFIX,
    sessionId: parsedConfig.STRANDS_SESSION_ID ?? randomUUID(),
    sessionStorageType: parsedConfig.STRANDS_SESSION_STORAGE,
    conversationManagerType: parsedConfig.STRANDS_CONVERSATION_MANAGER,
  };
}

export function createStrandsModel(config: StrandsRuntimeConfig) {
  const credentials = fromIni({ profile: config.awsProfile });

  return new BedrockModel({
    modelId: config.modelId,
    maxTokens: 1000,
    temperature: 0.7,
    clientConfig: {
      region: config.awsRegion,
      credentials,
    },
  });
}

export async function createStrandsSessionManager(config: StrandsRuntimeConfig) {
  const credentials = fromIni({ profile: config.awsProfile });
  const s3Client = new S3Client({
    region: config.awsRegion,
    credentials,
  });

  const snapshotStorage = config.sessionStorageType === "custom"
    ? new CustomS3SnapshotStorage({
      bucket: config.sessionBucket,
      prefix: config.sessionPrefix,
      s3Client,
    })
    : config.sessionStorageType === "sqlite"
      ? new (await import("./strands-sqlite-session-storage")).SqliteSnapshotStorage()
      : new S3Storage({
        bucket: config.sessionBucket,
        prefix: config.sessionPrefix,
        s3Client,
      });

  return new SessionManager({
    sessionId: config.sessionId,
    storage: {
      snapshot: snapshotStorage,
    },
  });
}

export function createStrandsConversationManager(config: StrandsRuntimeConfig) {
  return config.conversationManagerType === "summarizing"
    ? new StrandsSummarizingConversationManager({
      summaryTriggerMessages: 16,
      summaryRatio: 0.35,
      preserveRecentMessages: 8,
      fallbackWindowSize: 12,
      shouldTruncateResults: true,
    })
    : new BedrockSafeConversationManager({
      windowSize: 12,
      shouldTruncateResults: true,
    });
}

export function getStrandsSessionStoreLabel(config: StrandsRuntimeConfig) {
  return config.sessionStorageType === "sqlite"
    ? "sqlite:data/agent-memory.sqlite"
    : `s3://${config.sessionBucket}/${config.sessionPrefix}`;
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

export function buildWorkspaceTools(): ToolList {
  return [
    tool({
      name: "getCurrentDateTime",
      description: "Returns the current local date and time for this runtime.",
      callback: async () => JSON.stringify(getCurrentDateTime(), null, 2),
    }),
    tool({
      name: "getWorkingDirectory",
      description: "Returns the current workspace root for this agent process.",
      callback: async () => JSON.stringify(await getWorkingDirectory(), null, 2),
    }),
    tool({
      name: "listDirectory",
      description: "Lists files and directories within the workspace. Use this to explore the repo structure.",
      inputSchema: listDirectoryInputSchema,
      callback: async (toolInput) => JSON.stringify(await listDirectory(toolInput), null, 2),
    }),
    tool({
      name: "readTextFile",
      description: "Reads a UTF-8 text file from the workspace and returns its contents.",
      inputSchema: readTextFileInputSchema,
      callback: async (toolInput) => JSON.stringify(await readTextFileTool(toolInput), null, 2),
    }),
    tool({
      name: "readFileChunk",
      description: "Reads part of a UTF-8 text file so larger files can be inspected incrementally.",
      inputSchema: readFileChunkInputSchema,
      callback: async (toolInput) => JSON.stringify(await readFileChunk(toolInput), null, 2),
    }),
    tool({
      name: "searchFiles",
      description: "Searches file contents or file names within the workspace using ripgrep.",
      inputSchema: searchFilesInputSchema,
      callback: async (toolInput) => JSON.stringify(await searchFiles(toolInput), null, 2),
    }),
  ];
}

export function getAssistantText(result: Awaited<ReturnType<Agent["invoke"]>>) {
  return result.toString().trim();
}
