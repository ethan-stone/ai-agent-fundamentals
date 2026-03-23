import { describe, expect, test } from "bun:test";
import {
  MAX_FILE_CHUNK_CHARACTERS,
  MAX_SEARCH_RESULTS,
  readFileChunkInputSchema,
  runtimeConfigSchema,
  searchFilesInputSchema,
} from "./agent-schemas";

describe("runtimeConfigSchema", () => {
  test("accepts AWS_REGION when present", () => {
    const parsed = runtimeConfigSchema.parse({
      AGENT_MODEL_ID: "model-id",
      AWS_PROFILE: "profile",
      AWS_REGION: "us-east-1",
      MAX_AGENT_ITERATIONS: "8",
    });

    expect(parsed.AWS_REGION).toBe("us-east-1");
    expect(parsed.MAX_AGENT_ITERATIONS).toBe(8);
  });

  test("accepts AWS_DEFAULT_REGION when AWS_REGION is absent", () => {
    const parsed = runtimeConfigSchema.parse({
      AGENT_MODEL_ID: "model-id",
      AWS_PROFILE: "profile",
      AWS_DEFAULT_REGION: "us-west-2",
      MAX_AGENT_ITERATIONS: "4",
    });

    expect(parsed.AWS_DEFAULT_REGION).toBe("us-west-2");
    expect(parsed.MAX_AGENT_ITERATIONS).toBe(4);
  });

  test("rejects config without any region", () => {
    const result = runtimeConfigSchema.safeParse({
      AGENT_MODEL_ID: "model-id",
      AWS_PROFILE: "profile",
      MAX_AGENT_ITERATIONS: "8",
    });

    expect(result.success).toBe(false);
    expect(result.error?.issues.some((issue) => issue.message.includes("required"))).toBe(true);
  });
});

describe("readFileChunkInputSchema", () => {
  test("coerces numeric input and applies defaults", () => {
    const parsed = readFileChunkInputSchema.parse({
      path: "README.md",
      offset: "12",
    });

    expect(parsed.offset).toBe(12);
    expect(parsed.maxCharacters).toBe(MAX_FILE_CHUNK_CHARACTERS);
  });

  test("rejects values above the max character cap", () => {
    const result = readFileChunkInputSchema.safeParse({
      path: "README.md",
      maxCharacters: MAX_FILE_CHUNK_CHARACTERS + 1,
    });

    expect(result.success).toBe(false);
  });
});

describe("searchFilesInputSchema", () => {
  test("applies defaults for search type and limit", () => {
    const parsed = searchFilesInputSchema.parse({
      query: "agent",
    });

    expect(parsed.searchType).toBe("content");
    expect(parsed.limit).toBeLessThanOrEqual(MAX_SEARCH_RESULTS);
  });

  test("rejects unsupported search types", () => {
    const result = searchFilesInputSchema.safeParse({
      query: "agent",
      searchType: "symbol",
    });

    expect(result.success).toBe(false);
  });
});
