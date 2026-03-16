import { describe, expect, test } from "bun:test";
import { z } from "zod";
import { defineTool } from "./tooling";

describe("defineTool", () => {
  test("uses zod JSON schema for the Bedrock tool definition", () => {
    const tool = defineTool({
      name: "echo",
      description: "Echoes a string",
      schema: z.object({
        message: z.string(),
      }).strict(),
      handler: ({ message }) => ({ echoed: message }),
    });

    expect(tool.tool.toolSpec?.name).toBe("echo");
    expect(tool.tool.toolSpec?.inputSchema).toEqual({
      json: {
        type: "object",
        properties: {
          message: {
            type: "string",
          },
        },
        required: ["message"],
        additionalProperties: false,
      },
    });
  });

  test("validates input before calling the handler", async () => {
    let callCount = 0;

    const tool = defineTool({
      name: "echo",
      description: "Echoes a string",
      schema: z.object({
        message: z.string().min(1),
      }).strict(),
      handler: ({ message }) => {
        callCount += 1;
        return { echoed: message };
      },
    });

    await expect(tool.handler({ message: "" })).rejects.toThrow("echo validation failed");
    expect(callCount).toBe(0);
  });

  test("passes parsed input to the handler", async () => {
    const tool = defineTool({
      name: "count",
      description: "Counts things",
      schema: z.object({
        limit: z.coerce.number().int().positive(),
      }).strict(),
      handler: ({ limit }) => ({ limit }),
    });

    await expect(tool.handler({ limit: "3" })).resolves.toEqual({ limit: 3 });
  });
});
