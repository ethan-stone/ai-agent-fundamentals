import type { Tool } from "@aws-sdk/client-bedrock-runtime";
import { toJSONSchema, z } from "zod";

export type ToolDefinition = {
  tool: Tool;
  handler: (input: Record<string, unknown>) => Promise<unknown>;
};

type BedrockToolInputSchema = NonNullable<NonNullable<Tool["toolSpec"]>["inputSchema"]>;
type BedrockToolJsonSchema = NonNullable<NonNullable<Tool["toolSpec"]>["inputSchema"]>["json"];

export function formatZodError(error: z.ZodError): string {
  return error.issues
    .map((issue) => {
      const path = issue.path.length > 0 ? `${issue.path.join(".")}: ` : "";
      return `${path}${issue.message}`;
    })
    .join("; ");
}

export function parseWithSchema<TSchema extends z.ZodTypeAny>(
  schema: TSchema,
  input: unknown,
  context: string,
): z.infer<TSchema> {
  const result = schema.safeParse(input);

  if (!result.success) {
    throw new Error(`${context} validation failed: ${formatZodError(result.error)}`);
  }

  return result.data;
}

export function toBedrockInputSchema(schema: z.ZodTypeAny): BedrockToolJsonSchema {
  const jsonSchema = toJSONSchema(schema);

  if ("$schema" in jsonSchema) {
    const { $schema: _ignored, ...rest } = jsonSchema;
    return rest as BedrockToolJsonSchema;
  }

  return jsonSchema as BedrockToolJsonSchema;
}

export function defineTool<TSchema extends z.ZodTypeAny>(config: {
  name: string;
  description: string;
  schema: TSchema;
  handler: (input: z.infer<TSchema>) => Promise<unknown> | unknown;
}): ToolDefinition {
  return {
    tool: {
      toolSpec: {
        name: config.name,
        description: config.description,
        inputSchema: {
          json: toBedrockInputSchema(config.schema),
        } as BedrockToolInputSchema,
      },
    },
    handler: async (input) => {
      const parsedInput = parseWithSchema(config.schema, input, config.name);
      return config.handler(parsedInput);
    },
  };
}
