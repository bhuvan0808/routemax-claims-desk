/**
 * LLM layer public API: EXTRACT and DRAFT.
 * - mode "mock": fully offline and deterministic (heuristic extractor + template drafter).
 * - mode "groq": Groq chat completions with structured output, validated and post-processed.
 * The LLM never chooses a decision or an amount; that is the deterministic engine's job.
 */
import { appConfig } from "../config";
import type { Drafter, Extractor, LlmMode } from "../types";
import { GroqClient, GroqDrafter, GroqExtractor } from "./groq";
import { mockExtract } from "./mock";
import { renderTemplateReply } from "./template";

export { detectConsequentialLoss, mockExtract } from "./mock";
export { renderTemplateReply, validateDraft } from "./template";

export interface LlmOptions {
  mode: LlmMode;
  /** Passed in by the caller from env GROQ_API_KEY. Never logged or put in an error message. */
  apiKey?: string;
  model?: string;
  baseUrl?: string;
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
}

function groqClient(opts: LlmOptions): GroqClient {
  const apiKey = (opts.apiKey ?? "").trim();
  if (!apiKey) throw new Error("GROQ_API_KEY missing");
  return new GroqClient({
    apiKey,
    model: opts.model?.trim() || appConfig.groqModel,
    baseUrl: opts.baseUrl?.trim() || appConfig.groqBaseUrl,
    fetchImpl: opts.fetchImpl,
    timeoutMs: opts.timeoutMs ?? appConfig.llmTimeoutMs,
  });
}

export function createExtractor(opts: LlmOptions): Extractor {
  if (opts.mode === "groq") return new GroqExtractor(groqClient(opts));
  return {
    mode: "mock",
    model: appConfig.mockModelName,
    extract: async (email) => mockExtract(email),
  };
}

export function createDrafter(opts: LlmOptions): Drafter {
  if (opts.mode === "groq") return new GroqDrafter(groqClient(opts));
  return {
    mode: "mock",
    model: appConfig.mockModelName,
    draft: async (input) => renderTemplateReply(input),
  };
}
