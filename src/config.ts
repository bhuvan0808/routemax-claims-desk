/**
 * Runtime (non-policy) config. Secrets are NEVER here: the Groq key is read from env GROQ_API_KEY only.
 */
import { LlmModeSchema, LookupFailModeSchema, type LlmMode, type LookupFailMode } from "./types";

export const appConfig = {
  /** Groq OpenAI-compatible endpoint. */
  groqBaseUrl: "https://api.groq.com/openai/v1",
  /**
   * Model used for extract + draft in LLM_MODE=groq. Must support structured output (json_schema).
   * Chosen from Groq's docs by the LLM-layer build; see ASSUMPTIONS.md. Override with env GROQ_MODEL.
   */
  groqModel: "openai/gpt-oss-120b",
  temperature: 0,
  llmTimeoutMs: 20000,
  /** A lookup that takes longer than this is treated as a tool error (-> escalate). */
  lookupTimeoutMs: 2000,
  mockModelName: "mock-heuristic-v1",
} as const;

/** Anything unrecognised falls back to the safe, offline default. */
export function parseLlmMode(value: string | undefined | null): LlmMode {
  const parsed = LlmModeSchema.safeParse((value ?? "").trim().toLowerCase());
  return parsed.success ? parsed.data : "mock";
}

export function parseFailMode(value: string | undefined | null): LookupFailMode {
  const parsed = LookupFailModeSchema.safeParse((value ?? "").trim().toLowerCase());
  return parsed.success ? parsed.data : "none";
}
