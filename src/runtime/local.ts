/**
 * Node-only wiring for the CLI and the evals. The Worker wires the same pieces in src/worker/index.ts.
 */
import { appConfig, parseFailMode, parseLlmMode } from "../config";
import { createDrafter, createExtractor } from "../llm";
import { resolvePolicy } from "../policy.config";
import { MemoryStore } from "../store";
import { createTools } from "../tools";
import { loadSeedData } from "../tools/node-loader";
import type {
  ClaimsStore,
  LlmMode,
  LookupFailMode,
  PipelineDeps,
  PolicyConfig,
  Shipment,
} from "../types";

/** Load .env into process.env if present. Never prints it. Existing env vars win. */
export function loadDotEnv(path = ".env"): void {
  try {
    process.loadEnvFile(path);
  } catch {
    /* no .env: fine */
  }
}

export interface LocalDepsOptions {
  /** Folder holding shipments.csv and past_decisions_oct.csv. Default "data". */
  dataDir?: string;
  /** Default: env LLM_MODE, else "mock". */
  llmMode?: LlmMode;
  /** Merged over env POLICY_OVERRIDES, merged over the defaults in src/policy.config.ts. */
  policyOverrides?: Partial<PolicyConfig>;
  /** Default: env LOOKUP_FAIL_MODE, else "none". */
  failMode?: LookupFailMode;
  /** Default: a fresh MemoryStore. */
  store?: ClaimsStore;
  lookupTimeoutMs?: number;
  /** Synthetic shipments appended to the seed data (evals). */
  extraShipments?: Shipment[];
  /** Default: env GROQ_API_KEY. */
  groqApiKey?: string;
  groqModel?: string;
}

export async function createLocalDeps(opts: LocalDepsOptions = {}): Promise<PipelineDeps> {
  const seed = await loadSeedData(opts.dataDir ?? "data");
  if (opts.extraShipments?.length) seed.shipments.push(...opts.extraShipments);

  const mode = opts.llmMode ?? parseLlmMode(process.env.LLM_MODE);
  const apiKey = (opts.groqApiKey ?? process.env.GROQ_API_KEY ?? "").trim();
  const model =
    mode === "groq"
      ? (opts.groqModel ?? process.env.GROQ_MODEL ?? "").trim() || appConfig.groqModel
      : appConfig.mockModelName;
  const llm = { mode, apiKey, model };

  const policy = resolvePolicy(opts.policyOverrides, resolvePolicy(process.env.POLICY_OVERRIDES));

  return {
    extractor: createExtractor(llm),
    drafter: createDrafter(llm),
    tools: createTools(seed, {
      failMode: opts.failMode ?? parseFailMode(process.env.LOOKUP_FAIL_MODE),
      timeoutMs: opts.lookupTimeoutMs ?? appConfig.lookupTimeoutMs,
    }),
    store: opts.store ?? new MemoryStore(),
    policy,
  };
}
