import { z } from 'zod';

export const MODEL_CONTEXT_PROTOCOL_VERSION = 1;

/** Limits applied to app-supplied data. Everything from the app is untrusted input. */
export const LIMITS = {
  toolName: 64,
  description: 1024,
  inputSchemaBytes: 16 * 1024,
  inputSchemaDepth: 8,
  stackChars: 64 * 1024,
  resultTextChars: 1024 * 1024,
  resultItems: 100,
  toolsPerConnection: 200,
  messageBytes: 2 * 1024 * 1024,
} as const;

export const ToolNameSchema = z
  .string()
  .min(1)
  .max(LIMITS.toolName)
  .regex(/^[a-zA-Z0-9_-]+$/, 'Tool names may only use a-z, A-Z, 0-9, "_" and "-".');

/**
 * `inputSchema` must be a JSON Schema for an object. `$ref` is rejected because the dev server
 * does not resolve references and an agent should not be pointed at remote schemas.
 */
export const InputSchemaSchema = z
  .object({ type: z.literal('object') })
  .passthrough()
  .superRefine((schema, ctx) => {
    const size = JSON.stringify(schema).length;
    if (size > LIMITS.inputSchemaBytes) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: `inputSchema is ${size} bytes; max is ${LIMITS.inputSchemaBytes}.`,
      });
    }
    const problem = findSchemaProblem(schema, 0);
    if (problem) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: problem });
    }
  });

function findSchemaProblem(value: unknown, depth: number): string | null {
  if (depth > LIMITS.inputSchemaDepth) {
    return `inputSchema nests deeper than ${LIMITS.inputSchemaDepth} levels.`;
  }
  if (Array.isArray(value)) {
    for (const item of value) {
      const problem = findSchemaProblem(item, depth + 1);
      if (problem) return problem;
    }
    return null;
  }
  if (value != null && typeof value === 'object') {
    for (const [key, child] of Object.entries(value)) {
      if (key === '$ref' || key === '$id' || key === '$schema') {
        return `inputSchema must not use "${key}".`;
      }
      const problem = findSchemaProblem(child, depth + 1);
      if (problem) return problem;
    }
  }
  return null;
}

export const ToolAnnotationsSchema = z
  .object({
    title: z
      .string()
      .max(LIMITS.toolName * 2)
      .optional(),
    readOnlyHint: z.boolean().optional(),
    destructiveHint: z.boolean().optional(),
    idempotentHint: z.boolean().optional(),
    openWorldHint: z.boolean().optional(),
  })
  .strict();

export type ToolAnnotations = z.infer<typeof ToolAnnotationsSchema>;

export const ToolDescriptorSchema = z
  .object({
    name: ToolNameSchema,
    description: z.string().min(1).max(LIMITS.description),
    inputSchema: InputSchemaSchema,
    annotations: ToolAnnotationsSchema.optional(),
  })
  .strict();

export type ToolDescriptor = z.infer<typeof ToolDescriptorSchema>;

export const RegisterToolParamsSchema = ToolDescriptorSchema.extend({
  stack: z.string().max(LIMITS.stackChars).optional(),
});

export type RegisterToolParams = z.infer<typeof RegisterToolParamsSchema>;

export const UnregisterToolParamsSchema = z.object({ name: ToolNameSchema }).strict();

export const HelloParamsSchema = z
  .object({
    protocolVersion: z.literal(MODEL_CONTEXT_PROTOCOL_VERSION),
    platform: z.string().max(32).optional(),
  })
  .strict();

export const ToolResultSchema = z.object({
  content: z
    .array(
      z.union([
        z.object({ type: z.literal('text'), text: z.string().max(LIMITS.resultTextChars) }),
        z.object({
          type: z.literal('image'),
          data: z.string().max(LIMITS.resultTextChars),
          mimeType: z.string().max(128),
        }),
      ])
    )
    .max(LIMITS.resultItems),
  isError: z.boolean().optional(),
});

export type ToolResult = z.infer<typeof ToolResultSchema>;

const JsonRpcIdSchema = z.union([z.string().max(128), z.number()]);

export const JsonRpcRequestSchema = z.object({
  jsonrpc: z.literal('2.0'),
  id: JsonRpcIdSchema.optional(),
  method: z.string().max(64),
  params: z.unknown().optional(),
});

export type JsonRpcRequest = z.infer<typeof JsonRpcRequestSchema>;

export const JsonRpcResponseSchema = z.object({
  jsonrpc: z.literal('2.0'),
  id: JsonRpcIdSchema,
  result: z.unknown().optional(),
  error: z
    .object({ code: z.number(), message: z.string().max(LIMITS.description) })
    .passthrough()
    .optional(),
});

export type JsonRpcResponse = z.infer<typeof JsonRpcResponseSchema>;

/** Formats Zod issues into one line for logs and error responses. */
export function formatIssues(error: z.ZodError): string {
  return error.issues
    .slice(0, 3)
    .map((issue) =>
      issue.path.length ? `${issue.path.join('.')}: ${issue.message}` : issue.message
    )
    .join('; ');
}
