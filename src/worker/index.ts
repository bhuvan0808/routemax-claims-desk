/**
 * Cloudflare Worker entry: wires the real bindings into the Hono app (app.ts).
 * The UI in ./public is served by Workers static assets before this code runs.
 *
 * Drafts only: nothing here sends email or pays a claim.
 */
import pastDecisionsCsv from "../../data/past_decisions_oct.csv";
import shipmentsCsv from "../../data/shipments.csv";
import { appConfig } from "../config";
import { createDrafter, createExtractor, type LlmOptions } from "../llm";
import { resolvePolicy } from "../policy.config";
import { createTools, parsePastDecisionsCsv, parseShipmentsCsv, type SeedData } from "../tools";
import { createApp, resolveRuntime } from "./app";
import { ClaimsStoreDO, DurableObjectStore } from "./do-store";

/** Seed data is bundled as text (wrangler `rules`) and parsed once per isolate. */
const seed: SeedData = {
  shipments: parseShipmentsCsv(shipmentsCsv),
  pastDecisions: parsePastDecisionsCsv(pastDecisionsCsv),
};

const app = createApp({
  buildDeps: ({ env, failMode }) => {
    // Effective mode is "groq" only when requested AND the secret is set; otherwise the offline mock.
    const runtime = resolveRuntime(env);
    const llm: LlmOptions = {
      mode: runtime.llm_mode,
      apiKey: runtime.llm_mode === "groq" ? env.GROQ_API_KEY : undefined,
      model: runtime.model,
      baseUrl: appConfig.groqBaseUrl,
      timeoutMs: appConfig.llmTimeoutMs,
    };
    return {
      extractor: createExtractor(llm),
      drafter: createDrafter(llm),
      tools: createTools(seed, { failMode, timeoutMs: appConfig.lookupTimeoutMs }),
      store: new DurableObjectStore(env),
      policy: resolvePolicy(env.POLICY_OVERRIDES),
    };
  },
});

export default app;
export { ClaimsStoreDO };
