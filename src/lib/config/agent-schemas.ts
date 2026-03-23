import { z } from "zod";

export const MAX_FILE_CHUNK_CHARACTERS = 8_000;
export const DEFAULT_FILE_CHUNK_OFFSET = 0;
export const DEFAULT_SEARCH_LIMIT = 20;
export const MAX_SEARCH_RESULTS = 50;

const trimmedStringSchema = z.string().trim().min(1);

export const runtimeConfigSchema = z.object({
  AGENT_MODEL_ID: trimmedStringSchema,
  AWS_PROFILE: trimmedStringSchema,
  AWS_REGION: trimmedStringSchema.optional(),
  AWS_DEFAULT_REGION: trimmedStringSchema.optional(),
  MAX_AGENT_ITERATIONS: z.coerce.number().int().positive(),
}).superRefine((value, ctx) => {
  if (!value.AWS_REGION && !value.AWS_DEFAULT_REGION) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: "AWS_REGION or AWS_DEFAULT_REGION is required.",
      path: ["AWS_REGION"],
    });
  }
});

export const emptyInputSchema = z.object({}).strict();

export const listDirectoryInputSchema = z.object({
  path: z.string().trim().min(1).optional(),
}).strict();

export const readTextFileInputSchema = z.object({
  path: z.string().trim().min(1),
}).strict();

export const readFileChunkInputSchema = z.object({
  path: z.string().trim().min(1),
  offset: z.coerce.number().int().nonnegative().default(DEFAULT_FILE_CHUNK_OFFSET),
  maxCharacters: z.coerce.number().int().positive().max(MAX_FILE_CHUNK_CHARACTERS).default(MAX_FILE_CHUNK_CHARACTERS),
}).strict();

export const searchFilesInputSchema = z.object({
  query: z.string().trim().min(1),
  path: z.string().trim().min(1).optional(),
  searchType: z.enum(["content", "fileName"]).default("content"),
  limit: z.coerce.number().int().positive().max(MAX_SEARCH_RESULTS).default(DEFAULT_SEARCH_LIMIT),
}).strict();
