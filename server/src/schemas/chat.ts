import { z } from 'zod';

const content = z.union([
  z.string(),
  z.array(z.object({ type: z.literal('text'), text: z.string() }).passthrough()),
]);
const instruction = z.object({ role: z.literal('system'), content, name: z.string().optional() });
const toolCall = z.object({
  id: z.string().min(1),
  type: z.literal('function'),
  function: z.object({ name: z.string().min(1), arguments: z.string() }),
  thought_signature: z.string().optional(),
});
const assistant = z.object({
  role: z.literal('assistant'),
  content: content.nullable().optional(),
  name: z.string().optional(),
  refusal: z.string().optional(),
  tool_calls: z.array(toolCall).optional(),
});
const tool = z.object({
  role: z.literal('tool'),
  content,
  tool_call_id: z.string().min(1),
  name: z.string().optional(),
});
const toolDefinition = z.object({
  type: z.literal('function'),
  function: z.object({
    name: z.string().min(1),
    description: z.string().optional(),
    parameters: z.record(z.string(), z.unknown()).optional(),
    strict: z.boolean().optional(),
  }),
});
const tokenLimit = z
  .number()
  .int()
  .positive()
  .safe()
  .nullish()
  .transform((value) => value ?? undefined);

export const chatCompletionBaseSchema = z.object({
  messages: z
    .array(
      z.discriminatedUnion('role', [
        instruction,
        instruction.extend({ role: z.literal('developer') }),
        instruction.extend({ role: z.literal('user') }),
        assistant,
        tool,
      ]),
    )
    .min(1),
  model: z
    .string()
    .optional()
    .describe('Use auto or omit to route automatically; provider/model selects a preferred model.'),
  temperature: z
    .number()
    .min(0)
    .max(2)
    .nullish()
    .transform((value) => value ?? undefined),
  max_tokens: tokenLimit,
  max_completion_tokens: tokenLimit.describe(
    'Alternative output-token limit. Do not combine with max_tokens.',
  ),
  top_p: z
    .number()
    .min(0)
    .max(1)
    .nullish()
    .transform((value) => value ?? undefined),
  stream: z.boolean().optional(),
  n: z
    .literal(1)
    .nullish()
    .transform((value) => value ?? undefined)
    .describe('Only one completion per request is supported.'),
  response_format: z
    .object({ type: z.literal('text') })
    .strict()
    .nullish()
    .transform((value) => value ?? undefined)
    .describe('Text output only. JSON/schema-constrained output is not supported.'),
  tools: z.array(toolDefinition).optional(),
  tool_choice: z
    .union([
      z.enum(['none', 'auto', 'required']),
      z.object({ type: z.literal('function'), function: z.object({ name: z.string().min(1) }) }),
    ])
    .optional(),
  parallel_tool_calls: z.boolean().optional(),
  stream_options: z.object({ include_usage: z.boolean().optional() }).strict().optional(),
});
export const chatCompletionSchema = chatCompletionBaseSchema.superRefine((request, context) => {
  if (request.stream_options !== undefined && request.stream !== true)
    context.addIssue({
      code: 'custom',
      path: ['stream_options'],
      message: 'stream_options requires stream=true.',
    });
  if (request.max_tokens !== undefined && request.max_completion_tokens !== undefined)
    context.addIssue({
      code: 'custom',
      path: ['max_completion_tokens'],
      message: 'Use either max_tokens or max_completion_tokens, not both.',
    });
});
export const supportedChatParameters = Object.keys(chatCompletionBaseSchema.shape);

export function isEmptyAssistantStub(message: {
  role: string;
  content?: unknown;
  refusal?: string;
  tool_calls?: unknown[];
}): boolean {
  return (
    message.role === 'assistant' &&
    !message.refusal &&
    !message.tool_calls?.length &&
    !(typeof message.content === 'string' && message.content.length > 0) &&
    !(Array.isArray(message.content) && message.content.length > 0)
  );
}
