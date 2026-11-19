/**
 * HTTP surface of the Claims Desk. No Cloudflare-specific imports, so it is unit-testable
 * with `app.request()` and a MemoryStore (see app.test.ts). index.ts wires the real bindings.
 *
 * Email text is untrusted data: it is only ever passed to the pipeline as a string.
 * It is never interpreted, never eval'd and never used to build response headers.
 */
import { Hono } from "hono";
import type { Context } from "hono";
import { appConfig, parseFailMode, parseLlmMode } from "../config";
import { resultsToCsv } from "../csv";
import { processEmail as pipelineProcessEmail } from "../pipeline";
import { resolvePolicy } from "../policy.config";
import {
  LookupFailModeSchema,
  type LlmMode,
  type LookupFailMode,
  type PipelineDeps,
  type ProcessInput,
  type ProcessResult,
  type ResultRow,
} from "../types";

export const SERVICE_NAME = "routemax-claims-desk";
export const MAX_EMAIL_BYTES = 100 * 1024;
export const MAX_BATCH_EMAILS = 100;
const MAX_SINGLE_BODY_BYTES = 1024 * 1024;
const MAX_BATCH_BODY_BYTES = 16 * 1024 * 1024;
const CLAIM_ID_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;

type AppEnv = { Bindings: Env };
type Ctx = Context<AppEnv>;

export interface CreateAppOptions {
  buildDeps: (c: { env: Env; failMode: LookupFailMode }) => PipelineDeps | Promise<PipelineDeps>;
  /** Extra fields merged into GET /health. Must not contain secrets. */
  info?: (env: Env) => Record<string, unknown>;
  /** Test seam. Defaults to the real pipeline. */
  processEmail?: (input: ProcessInput, deps: PipelineDeps) => Promise<ProcessResult>;
}

export interface RuntimeInfo {
  /** Effective mode: "groq" only when requested AND a key is configured; otherwise the offline mock. */
  llm_mode: LlmMode;
  llm_mode_requested: LlmMode;
  model: string;
  groq_key_present: boolean;
  lookup_fail_mode: LookupFailMode;
  fault_injection_allowed: boolean;
}

/** Runtime switches derived from env. Never returns the key itself. */
export function resolveRuntime(env: Env): RuntimeInfo {
  const requested = parseLlmMode(env.LLM_MODE);
  const keyPresent = typeof env.GROQ_API_KEY === "string" && env.GROQ_API_KEY.trim() !== "";
  const effective: LlmMode = requested === "groq" && keyPresent ? "groq" : "mock";
  const groqModel = (env.GROQ_MODEL ?? "").trim() || appConfig.groqModel;
  return {
    llm_mode: effective,
    llm_mode_requested: requested,
    model: effective === "groq" ? groqModel : appConfig.mockModelName,
    groq_key_present: keyPresent,
    lookup_fail_mode: parseFailMode(env.LOOKUP_FAIL_MODE),
    fault_injection_allowed: env.ALLOW_FAULT_INJECTION === "1",
  };
}

/** A client error that is safe to show verbatim. */
class HttpError extends Error {
  constructor(
    readonly status: 400 | 403 | 404,
    message: string,
  ) {
    super(message);
  }
}

function envOf(c: Ctx): Env {
  return (c.env ?? {}) as Env;
}

/** env LOOKUP_FAIL_MODE, overridden by the x-lookup-fail header ONLY in demo mode. */
function failModeOf(c: Ctx): LookupFailMode {
  const env = envOf(c);
  const base = parseFailMode(env.LOOKUP_FAIL_MODE);
  if (env.ALLOW_FAULT_INJECTION !== "1") return base;
  const header = c.req.header("x-lookup-fail");
  if (header === undefined) return base;
  const parsed = LookupFailModeSchema.safeParse(header.trim().toLowerCase());
  return parsed.success ? parsed.data : base;
}

function byteLength(text: string): number {
  return new TextEncoder().encode(text).length;
}

function parseClaimId(value: unknown): string | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== "string") throw new HttpError(400, "claim_id must be a string");
  const v = value.trim();
  if (v === "") return undefined;
  if (!CLAIM_ID_RE.test(v)) {
    throw new HttpError(400, "claim_id may only contain letters, digits, '.', '_' and '-' (max 64 characters)");
  }
  return v;
}

function validateEmailText(value: unknown, label = "email"): string {
  if (typeof value !== "string") throw new HttpError(400, `${label} must be a string containing the raw email text`);
  if (value.trim() === "") throw new HttpError(400, `${label} is empty`);
  if (byteLength(value) > MAX_EMAIL_BYTES) throw new HttpError(400, `${label} is larger than 100 KB`);
  return value;
}

async function readBodyText(c: Ctx, maxBytes: number): Promise<string> {
  const declared = Number(c.req.header("content-length") ?? "0");
  if (Number.isFinite(declared) && declared > maxBytes) throw new HttpError(400, "request body is too large");
  const text = await c.req.text();
  if (text.length > maxBytes) throw new HttpError(400, "request body is too large");
  return text;
}

function parseJsonObject(text: string): Record<string, unknown> {
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    throw new HttpError(400, "request body is not valid JSON");
  }
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new HttpError(400, "request body must be a JSON object");
  }
  return value as Record<string, unknown>;
}

function isJson(c: Ctx): boolean {
  return (c.req.header("content-type") ?? "").toLowerCase().includes("application/json");
}

export function createApp(opts: CreateAppOptions): Hono<AppEnv> {
  const app = new Hono<AppEnv>();
  const run = opts.processEmail ?? pipelineProcessEmail;
  const depsFor = async (c: Ctx): Promise<PipelineDeps> =>
    await opts.buildDeps({ env: envOf(c), failMode: failModeOf(c) });

  app.use("*", async (c, next) => {
    // Value comes from a closed enum, never from the request body.
    c.header("x-lookup-fail-effective", failModeOf(c));
    c.header("x-content-type-options", "nosniff");
    c.header("cache-control", "no-store");
    await next();
  });

  app.get("/health", (c) => {
    const env = envOf(c);
    const runtime = resolveRuntime(env);
    const extra = opts.info?.(env) ?? {};
    try {
      const policy = resolvePolicy(env.POLICY_OVERRIDES);
      return c.json({ ok: true, service: SERVICE_NAME, ...runtime, policy, ...extra });
    } catch {
      return c.json(
        { ok: false, service: SERVICE_NAME, ...runtime, policy: null, error: "POLICY_OVERRIDES is invalid", ...extra },
        500,
      );
    }
  });

  app.post("/claims", async (c) => {
    let email: unknown;
    let claimId: string | undefined;
    const text = await readBodyText(c, MAX_SINGLE_BODY_BYTES);
    if (isJson(c)) {
      const body = parseJsonObject(text);
      email = body.email;
      claimId = parseClaimId(body.claim_id ?? c.req.query("claim_id"));
    } else {
      email = text;
      claimId = parseClaimId(c.req.query("claim_id"));
    }
    const raw = validateEmailText(email);
    const result = await run({ raw, claimId }, await depsFor(c));
    return c.json(result);
  });

  app.post("/claims/batch", async (c) => {
    const body = parseJsonObject(await readBodyText(c, MAX_BATCH_BODY_BYTES));
    const emails = body.emails;
    if (!Array.isArray(emails) || emails.length === 0) {
      throw new HttpError(400, "emails must be a non-empty array of { email, claim_id? }");
    }
    if (emails.length > MAX_BATCH_EMAILS) {
      throw new HttpError(400, `a batch may contain at most ${MAX_BATCH_EMAILS} emails`);
    }
    // Validate everything first so a bad item never leaves a half-processed batch.
    const inputs: ProcessInput[] = emails.map((item: unknown, i: number) => {
      if (item === null || typeof item !== "object" || Array.isArray(item)) {
        throw new HttpError(400, `emails[${i}] must be an object { email, claim_id? }`);
      }
      const entry = item as Record<string, unknown>;
      return { raw: validateEmailText(entry.email, `emails[${i}].email`), claimId: parseClaimId(entry.claim_id) };
    });

    const deps = await depsFor(c);
    const results: ProcessResult[] = [];
    // Strictly sequential and in order: an earlier email can make a later one a duplicate.
    for (const input of inputs) results.push(await run(input, deps));
    const rows: ResultRow[] = results.flatMap((r) => r.rows);
    return c.json({ results, rows });
  });

  app.get("/claims", async (c) => {
    const { store } = await depsFor(c);
    const processed = await store.listProcessed();
    const rows: ResultRow[] = processed.flatMap((p) => p.rows);
    const claims = processed.map((p) => ({
      claim_id: p.claim_id,
      email_hash: p.email_hash,
      processed_at: p.processed_at,
      llm_mode: p.llm_mode,
      model: p.model,
      rows: p.rows,
      details: p.details,
    }));
    return c.json({ count: processed.length, rows, claims });
  });

  app.get("/results.csv", async (c) => {
    const { store } = await depsFor(c);
    const rows = (await store.listProcessed()).flatMap((p) => p.rows);
    return c.body(resultsToCsv(rows), 200, {
      "content-type": "text/csv; charset=utf-8",
      "content-disposition": 'attachment; filename="results.csv"',
    });
  });

  app.get("/audit", async (c) => {
    const requested = Number.parseInt(c.req.query("limit") ?? "", 10);
    const limit = Number.isFinite(requested) ? Math.min(Math.max(requested, 1), 1000) : 50;
    const { store } = await depsFor(c);
    return c.json({ entries: await store.listAudit(limit) });
  });

  app.post("/admin/reset", async (c) => {
    if (envOf(c).ALLOW_FAULT_INJECTION !== "1") {
      throw new HttpError(403, "reset is only available in demo mode (ALLOW_FAULT_INJECTION=1)");
    }
    const { store } = await depsFor(c);
    await store.reset();
    return c.json({ ok: true, reset: true });
  });

  app.notFound((c) => c.json({ error: "Not found" }, 404));

  app.onError((err, c) => {
    if (err instanceof HttpError) return c.json({ error: err.message }, err.status);
    // Log the error type only: messages can carry upstream payloads. Never a stack, never a secret.
    console.error(`request failed: ${c.req.method} ${new URL(c.req.url).pathname}: ${err instanceof Error ? err.name : "error"}`);
    return c.json({ error: "Internal error while processing the request. Nothing was sent or paid." }, 500);
  });

  return app;
}
