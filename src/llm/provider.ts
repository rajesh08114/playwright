import { z } from "zod";

export const LlmRequest = z.object({ system: z.string(), user: z.string(), maxTokens: z.number().int().positive().max(32_000), temperature: z.number().min(0).max(2).default(0) });
export const LlmResponse = z.object({ text: z.string(), provider: z.string(), model: z.string(), usage: z.object({ inputTokens: z.number().int().nonnegative().optional(), outputTokens: z.number().int().nonnegative().optional() }).optional() });
export type LlmRequest = z.infer<typeof LlmRequest>;
export type LlmResponse = z.infer<typeof LlmResponse>;
export interface LlmProvider { readonly name: string; complete(request: LlmRequest, signal?: AbortSignal): Promise<LlmResponse>; }
export class DisabledLlmProvider implements LlmProvider {
  readonly name = "disabled";
  async complete(): Promise<LlmResponse> { throw new Error("LLM calls are disabled; deterministic planning remains available"); }
}
