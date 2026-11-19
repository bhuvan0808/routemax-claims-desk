/**
 * Ambient declarations for the Worker. This file must stay a global script
 * (no top-level import/export) so `Env` and the "*.csv" module are visible everywhere.
 */

/** CSV seed files are bundled as text (see `rules` in wrangler.jsonc). */
declare module "*.csv" {
  const text: string;
  export default text;
}

/** Worker bindings + vars (wrangler.jsonc). GROQ_API_KEY is a secret: `wrangler secret put GROQ_API_KEY`. */
interface Env {
  ASSETS: Fetcher;
  CLAIMS_DO: DurableObjectNamespace<import("./do-store").ClaimsStoreDO>;
  /** "groq" | "mock". Falls back to mock when the key is missing. */
  LLM_MODE?: string;
  /** "none" | "error" | "timeout" | "not_found" */
  LOOKUP_FAIL_MODE?: string;
  /** "1" enables the x-lookup-fail header and POST /admin/reset (demo mode). */
  ALLOW_FAULT_INJECTION?: string;
  /** JSON, merged onto the default policy. */
  POLICY_OVERRIDES?: string;
  /** Secret. Never logged, never returned. */
  GROQ_API_KEY?: string;
  GROQ_MODEL?: string;
}
