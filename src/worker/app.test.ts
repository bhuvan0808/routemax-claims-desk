/**
 * Route tests for the Worker app (no Cloudflare runtime needed: app.request() + an in-memory store).
 *
 * The real pipeline / store / tools / LLM modules are used when they load. If one of them is not
 * buildable yet (parallel build), a small in-file fake with the same contract from src/types.ts
 * stands in, so the HTTP behaviour is still covered. `implementations` is logged once.
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { beforeAll, describe, expect, it, vi } from "vitest";
import { parseCsvRows } from "../csv";
import { hashEmail, parseEmail } from "../email";
import { defaultPolicy } from "../policy.config";
import type {
  AuditEntry,
  ClaimDetail,
  ClaimTools,
  ClaimsStore,
  Drafter,
  Extractor,
  LookupFailMode,
  PipelineDeps,
  PriorClaim,
  ProcessInput,
  ProcessResult,
  ProcessedEmail,
  ResultRow,
} from "../types";

const implementations = vi.hoisted(() => ({}) as Record<string, "real" | "fake">);

vi.mock("../pipeline", async () => {
  try {
    const actual = await vi.importActual<Record<string, unknown>>("../pipeline");
    if (typeof actual.processEmail !== "function") throw new Error("processEmail missing");
    implementations.pipeline = "real";
    return actual;
  } catch {
    implementations.pipeline = "fake";
    return { processEmail: fakeProcessEmail };
  }
});

import { createApp, MAX_EMAIL_BYTES } from "./app";

/* ------------------------------------------------------------------ fakes */

async function fakeProcessEmail(input: ProcessInput, deps: PipelineDeps): Promise<ProcessResult> {
  const email_hash = await hashEmail(input.raw);
  const existing = await deps.store.getByEmailHash(email_hash);
  if (existing) {
    return { claim_id: existing.claim_id, email_hash, idempotent_replay: true, rows: existing.rows, details: existing.details };
  }
  const claim_id = input.claimId ?? `E-${email_hash.slice(0, 8)}`;
  const extraction = await deps.extractor.extract(parseEmail(input.raw));
  const rows: ResultRow[] = [];
  const details: ClaimDetail[] = [];
  for (const claim of extraction.claims) {
    const shipment_id = (claim.shipment_id_raw ?? "").toUpperCase();
    const lookup = await deps.tools.lookupShipment(shipment_id);
    const decision = lookup.status === "error" ? "escalate" : lookup.status === "found" ? "approve" : "need_info";
    const approved_amount_inr = decision === "approve" ? Math.round(claim.claimed_amount_inr ?? 0) : 0;
    const rule = decision === "escalate" ? "R9" : decision === "approve" ? "R7" : "R1";
    const draft_reply = await deps.drafter.draft({
      claim_id,
      shipment_id,
      decision,
      approved_amount_inr,
      customer_reason: "fake",
      required_reply_tokens: [],
      missing_info: [],
      language: extraction.language,
      customer_name: extraction.customer_name,
      claim_type: claim.claim_type,
      prior_claim: null,
    });
    const row: ResultRow = { claim_id, shipment_id, decision, approved_amount_inr, reason: `${rule}: fake engine`, draft_reply };
    rows.push(row);
    details.push({
      row,
      rule_ids: [rule],
      trace: [{ rule, outcome: "fire", note: "fake engine" }],
      customer_reason: "fake",
      extracted_claim: claim,
      facts: {},
    });
  }
  const saved = await deps.store.saveProcessed({
    email_hash,
    claim_id,
    processed_at: (deps.now ?? (() => new Date().toISOString()))(),
    llm_mode: deps.extractor.mode,
    model: deps.extractor.model,
    rows,
    details,
  });
  return { claim_id: saved.claim_id, email_hash, idempotent_replay: false, rows: saved.rows, details: saved.details };
}

class FakeStore implements ClaimsStore {
  private processed = new Map<string, ProcessedEmail>();
  private audit: AuditEntry[] = [];
  async getByEmailHash(hash: string) {
    return this.processed.get(hash) ?? null;
  }
  async saveProcessed(record: ProcessedEmail) {
    const existing = this.processed.get(record.email_hash);
    if (existing) return existing;
    this.processed.set(record.email_hash, record);
    return record;
  }
  async listProcessed() {
    return [...this.processed.values()];
  }
  async findDecidedByShipment(): Promise<PriorClaim[]> {
    return [];
  }
  async appendAudit(entry: AuditEntry) {
    this.audit.push(entry);
  }
  async listAudit(limit?: number) {
    return limit ? this.audit.slice(-limit) : [...this.audit];
  }
  async reset() {
    this.processed.clear();
    this.audit = [];
  }
}

const fakeExtractor: Extractor = {
  mode: "mock",
  model: "fake-extractor",
  async extract(email) {
    const text = `${email.subject}\n${email.body}`;
    const id = /\bSHP[\s-]*\d{3,6}\b/i.exec(text);
    const amount = /Rs\.?\s*([\d,]+)/i.exec(text);
    return {
      is_claim: true,
      language: "en",
      customer_name: null,
      claims: [
        {
          shipment_id_raw: id ? id[0] : null,
          claim_type: "damage",
          claimed_amount_inr: amount ? Number(amount[1].replace(/,/g, "")) : null,
          pieces_claimed_missing: null,
          summary: "fake",
          customer_states_no_photos: false,
          consequential_loss_mentioned: false,
        },
      ],
    };
  },
};

const fakeDrafter: Drafter = {
  mode: "mock",
  model: "fake-drafter",
  async draft(input) {
    return `Dear customer,\nRegarding ${input.shipment_id}: "${input.decision}", noted.\nRouteMax Claims Desk`;
  },
};

function fakeTools(failMode: LookupFailMode): ClaimTools {
  return {
    async lookupShipment(id) {
      if (failMode === "error") return { status: "error", error: "lookup service error (injected)" };
      if (failMode === "timeout") return { status: "error", error: "timeout" };
      if (failMode === "not_found") return { status: "not_found" };
      return {
        status: "found",
        shipment: {
          shipment_id: id,
          customer: "Fake Customer",
          delivered_date: "2026-11-07",
          pieces_shipped: 10,
          declared_value_inr: 100000,
          pod_status: "Signed with remarks",
          pod_remarks: "1 box crushed",
        },
      };
    },
    async lookupPriorClaims() {
      return { status: "ok", claims: [] };
    },
  };
}

/* ------------------------------------------- real modules, when they load */

let MemoryStoreCtor: (new () => ClaimsStore) | null = null;
let makeTools: (failMode: LookupFailMode) => ClaimTools = fakeTools;
let extractor: Extractor = fakeExtractor;
let drafter: Drafter = fakeDrafter;

async function tryImport(spec: string): Promise<Record<string, any> | null> {
  try {
    return (await import(/* @vite-ignore */ spec)) as Record<string, any>;
  } catch {
    return null;
  }
}

function dataFile(name: string): string {
  return readFileSync(fileURLToPath(new URL(`../../data/${name}`, import.meta.url).href), "utf8");
}

beforeAll(async () => {
  const store = await tryImport("../store");
  if (store?.MemoryStore) MemoryStoreCtor = store.MemoryStore;
  implementations.store = MemoryStoreCtor ? "real" : "fake";

  const tools = await tryImport("../tools");
  if (tools?.createTools && tools.parseShipmentsCsv && tools.parsePastDecisionsCsv) {
    const seed = {
      shipments: tools.parseShipmentsCsv(dataFile("shipments.csv")),
      pastDecisions: tools.parsePastDecisionsCsv(dataFile("past_decisions_oct.csv")),
    };
    makeTools = (failMode) => tools.createTools(seed, { failMode, timeoutMs: 200 });
    implementations.tools = "real";
  } else {
    implementations.tools = "fake";
  }

  const llm = await tryImport("../llm");
  if (llm?.createExtractor && llm.createDrafter) {
    extractor = llm.createExtractor({ mode: "mock" });
    drafter = llm.createDrafter({ mode: "mock" });
    implementations.llm = "real";
  } else {
    implementations.llm = "fake";
  }
  console.info("app.test implementations:", JSON.stringify(implementations));
});

/* ---------------------------------------------------------------- harness */

const C01 = dataFile("claim_emails/C01.txt");
const C07 = dataFile("claim_emails/C07.txt");
const SECRET = "gsk_test_secret_DO_NOT_LEAK_123";

function makeEnv(overrides: Record<string, string> = {}): Env {
  return {
    LLM_MODE: "mock",
    LOOKUP_FAIL_MODE: "none",
    ALLOW_FAULT_INJECTION: "1",
    POLICY_OVERRIDES: "",
    ...overrides,
  } as unknown as Env;
}

function build() {
  const store: ClaimsStore = MemoryStoreCtor ? new MemoryStoreCtor() : new FakeStore();
  const failModes: LookupFailMode[] = [];
  const app = createApp({
    buildDeps: ({ failMode }) => {
      failModes.push(failMode);
      return {
        extractor,
        drafter,
        tools: makeTools(failMode),
        store,
        policy: defaultPolicy,
        now: () => "2026-11-19T10:00:00.000Z",
      };
    },
  });
  const postJson = (path: string, body: unknown, env = makeEnv(), headers: Record<string, string> = {}) =>
    app.request(
      path,
      { method: "POST", headers: { "content-type": "application/json", ...headers }, body: JSON.stringify(body) },
      env,
    );
  return { app, store, failModes, postJson };
}

function expectProcessResult(body: any) {
  expect(Object.keys(body).sort()).toEqual(["claim_id", "details", "email_hash", "idempotent_replay", "rows"]);
  expect(body.email_hash).toMatch(/^[0-9a-f]{64}$/);
  expect(Array.isArray(body.rows)).toBe(true);
  expect(body.rows.length).toBeGreaterThan(0);
  expect(body.details).toHaveLength(body.rows.length);
  for (const row of body.rows) {
    expect(Object.keys(row).sort()).toEqual(
      ["approved_amount_inr", "claim_id", "decision", "draft_reply", "reason", "shipment_id"].sort(),
    );
  }
}

/* ------------------------------------------------------------------ tests */

describe("GET /health", () => {
  it("reports the effective mode and falls back to mock without a key", async () => {
    const { app } = build();
    const res = await app.request("/health", {}, makeEnv({ LLM_MODE: "groq" }));
    expect(res.status).toBe(200);
    const body = (await res.json()) as any;
    expect(body).toMatchObject({
      ok: true,
      service: "routemax-claims-desk",
      llm_mode: "mock",
      llm_mode_requested: "groq",
      groq_key_present: false,
      lookup_fail_mode: "none",
      fault_injection_allowed: true,
    });
    expect(typeof body.model).toBe("string");
    expect(body.policy).toMatchObject({ defaultWindowDays: 7, approvalLimitInr: 50000 });
  });

  it("never returns the Groq key", async () => {
    const { app } = build();
    const env = makeEnv({ LLM_MODE: "groq", GROQ_API_KEY: SECRET, GROQ_MODEL: "some/model", ALLOW_FAULT_INJECTION: "0" });
    const res = await app.request("/health", {}, env);
    const text = await res.text();
    expect(text).not.toContain(SECRET);
    const body = JSON.parse(text);
    expect(body).toMatchObject({
      llm_mode: "groq",
      model: "some/model",
      groq_key_present: true,
      fault_injection_allowed: false,
    });
    expect(Object.keys(body)).not.toContain("GROQ_API_KEY");
  });

  it("applies POLICY_OVERRIDES and flags an invalid one", async () => {
    const { app } = build();
    const ok = await app.request("/health", {}, makeEnv({ POLICY_OVERRIDES: '{"smallClaimPhotoWaiverInr":5000}' }));
    expect(((await ok.json()) as any).policy.smallClaimPhotoWaiverInr).toBe(5000);
    const bad = await app.request("/health", {}, makeEnv({ POLICY_OVERRIDES: "{not json" }));
    expect(bad.status).toBe(500);
    expect(((await bad.json()) as any).ok).toBe(false);
  });
});

describe("POST /claims", () => {
  it("accepts JSON { email, claim_id }", async () => {
    const { postJson } = build();
    const res = await postJson("/claims", { email: C01, claim_id: "C01" });
    expect(res.status).toBe(200);
    const body = (await res.json()) as any;
    expectProcessResult(body);
    expect(body.claim_id).toBe("C01");
    expect(body.idempotent_replay).toBe(false);
    expect(body.rows[0].claim_id).toBe("C01");
    expect(body.rows[0].shipment_id).toBe("SHP-1001");
  });

  it("accepts a text/plain raw email with ?claim_id=", async () => {
    const { app } = build();
    const res = await app.request(
      "/claims?claim_id=C07",
      { method: "POST", headers: { "content-type": "text/plain" }, body: C07 },
      makeEnv(),
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as any;
    expectProcessResult(body);
    expect(body.claim_id).toBe("C07");
    expect(body.rows[0].shipment_id).toBe("SHP-1007");
  });

  it("derives a claim id from the hash when none is given", async () => {
    const { postJson } = build();
    const body = (await (await postJson("/claims", { email: C01 })).json()) as any;
    expect(body.claim_id).toBe(`E-${body.email_hash.slice(0, 8)}`);
  });

  it("rejects empty, oversized and malformed input with 400 { error }", async () => {
    const { app, postJson, store } = build();
    const cases: Response[] = [
      await postJson("/claims", { email: "" }),
      await postJson("/claims", { email: "   \n  " }),
      await postJson("/claims", {}),
      await postJson("/claims", { email: 42 }),
      await postJson("/claims", { email: C01, claim_id: "bad id\r\nx-injected: 1" }),
      await postJson("/claims", { email: "x".repeat(MAX_EMAIL_BYTES + 1) }),
      await app.request("/claims", { method: "POST", headers: { "content-type": "text/plain" }, body: "" }, makeEnv()),
      await app.request(
        "/claims",
        { method: "POST", headers: { "content-type": "application/json" }, body: "{not json" },
        makeEnv(),
      ),
    ];
    for (const res of cases) {
      expect(res.status).toBe(400);
      expect(typeof ((await res.json()) as any).error).toBe("string");
    }
    expect(await store.listProcessed()).toHaveLength(0);
  });

  it("is idempotent: the same email again is a replay and writes nothing new", async () => {
    const { app, postJson } = build();
    const first = (await (await postJson("/claims", { email: C01, claim_id: "C01" })).json()) as any;
    const before = (await (await app.request("/claims", {}, makeEnv())).json()) as any;

    // Same email, different line endings + a different claim id: still the same email.
    const again = await postJson("/claims", { email: C01.replace(/\r?\n/g, "\r\n"), claim_id: "C99" });
    expect(again.status).toBe(200);
    const second = (await again.json()) as any;
    expect(second.idempotent_replay).toBe(true);
    expect(second.email_hash).toBe(first.email_hash);
    expect(second.claim_id).toBe("C01");
    expect(second.rows).toEqual(first.rows);

    const after = (await (await app.request("/claims", {}, makeEnv())).json()) as any;
    expect(before.count).toBe(1);
    expect(after.count).toBe(1);
    expect(after.rows).toEqual(before.rows);
  });
});

describe("x-lookup-fail fault injection", () => {
  it("is honoured when ALLOW_FAULT_INJECTION=1", async () => {
    const { postJson, failModes } = build();
    const res = await postJson("/claims", { email: C01, claim_id: "C01" }, makeEnv(), { "x-lookup-fail": "error" });
    expect(res.status).toBe(200);
    expect(res.headers.get("x-lookup-fail-effective")).toBe("error");
    expect(failModes).toEqual(["error"]);
    const body = (await res.json()) as any;
    // A failed lookup must never auto-approve: a human decides.
    expect(body.rows[0].decision).toBe("escalate");
    expect(body.rows[0].approved_amount_inr).toBe(0);
  });

  it("is ignored when ALLOW_FAULT_INJECTION is not 1", async () => {
    const { postJson, failModes } = build();
    const env = makeEnv({ ALLOW_FAULT_INJECTION: "0" });
    const res = await postJson("/claims", { email: C01, claim_id: "C01" }, env, { "x-lookup-fail": "error" });
    expect(res.status).toBe(200);
    expect(res.headers.get("x-lookup-fail-effective")).toBe("none");
    expect(failModes).toEqual(["none"]);
    expect(((await res.json()) as any).rows[0].decision).not.toBe("escalate");
  });

  it("falls back to the env mode for an unknown header value", async () => {
    const { app, failModes } = build();
    const res = await app.request(
      "/claims",
      { headers: { "x-lookup-fail": "explode" } },
      makeEnv({ LOOKUP_FAIL_MODE: "not_found" }),
    );
    expect(res.headers.get("x-lookup-fail-effective")).toBe("not_found");
    expect(failModes).toEqual(["not_found"]);
  });
});

describe("POST /claims/batch", () => {
  it("processes emails sequentially, in order, and reports replays", async () => {
    const { app, postJson } = build();
    const res = await postJson("/claims/batch", {
      emails: [
        { email: C01, claim_id: "C01" },
        { email: C07, claim_id: "C07" },
        { email: C01, claim_id: "C01-again" },
      ],
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as any;
    expect(body.results).toHaveLength(3);
    body.results.forEach(expectProcessResult);
    expect(body.results.map((r: any) => r.claim_id)).toEqual(["C01", "C07", "C01"]);
    expect(body.results.map((r: any) => r.idempotent_replay)).toEqual([false, false, true]);
    expect(body.rows).toEqual(body.results.flatMap((r: any) => r.rows));

    const list = (await (await app.request("/claims", {}, makeEnv())).json()) as any;
    expect(list.count).toBe(2);
    expect(list.claims.map((c: any) => c.claim_id)).toEqual(["C01", "C07"]);
    expect(Object.keys(list.claims[0]).sort()).toEqual(
      ["claim_id", "details", "email_hash", "llm_mode", "model", "processed_at", "rows"].sort(),
    );
  });

  it("rejects bad batches with 400 before processing anything", async () => {
    const { postJson, store } = build();
    const tooMany = Array.from({ length: 101 }, (_, i) => ({ email: `${C01}\n${i}` }));
    for (const body of [{}, { emails: [] }, { emails: "nope" }, { emails: tooMany }, { emails: [{ email: C01 }, { email: "" }] }]) {
      const res = await postJson("/claims/batch", body);
      expect(res.status).toBe(400);
      expect(typeof ((await res.json()) as any).error).toBe("string");
    }
    expect(await store.listProcessed()).toHaveLength(0);
  });
});

describe("GET /results.csv", () => {
  it("has the exact header, CSV content type and RFC 4180 quoting", async () => {
    const { app, postJson, store } = build();
    await postJson("/claims", { email: C01, claim_id: "C01" });
    const tricky: ResultRow = {
      claim_id: "CSV-1",
      shipment_id: "SHP-9999",
      decision: "reject",
      approved_amount_inr: 0,
      reason: 'R3: filed late, customer said "urgent", twice',
      draft_reply: "Dear customer,\nWe cannot approve this claim.\n\nRegards,\nRouteMax",
    };
    await store.saveProcessed({
      email_hash: "f".repeat(64),
      claim_id: "CSV-1",
      processed_at: "2026-11-19T10:00:00.000Z",
      llm_mode: "mock",
      model: "test",
      rows: [tricky],
      details: [{ row: tricky, rule_ids: ["R3"], trace: [], customer_reason: "late", extracted_claim: null, facts: {} }],
    });

    const res = await app.request("/results.csv", {}, makeEnv());
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("text/csv; charset=utf-8");
    expect(res.headers.get("content-disposition")).toBe('attachment; filename="results.csv"');
    const csv = await res.text();
    expect(csv.split("\r\n")[0]).toBe("claim_id,shipment_id,decision,approved_amount_inr,reason,draft_reply");
    expect(csv).toContain(
      'CSV-1,SHP-9999,reject,0,"R3: filed late, customer said ""urgent"", twice","Dear customer,\nWe cannot approve this claim.\n\nRegards,\nRouteMax"\r\n',
    );

    // Round trip: every field survives quoting, and the CSV matches GET /claims row for row.
    const list = (await (await app.request("/claims", {}, makeEnv())).json()) as any;
    const parsed = parseCsvRows(csv);
    expect(parsed).toHaveLength(list.rows.length + 1);
    expect(parsed.slice(1)).toEqual(
      list.rows.map((r: ResultRow) => [
        r.claim_id,
        r.shipment_id,
        r.decision,
        String(r.approved_amount_inr),
        r.reason,
        r.draft_reply.replace(/\r\n?/g, "\n"),
      ]),
    );
  });

  it("returns just the header when nothing has been processed", async () => {
    const { app } = build();
    const csv = await (await app.request("/results.csv", {}, makeEnv())).text();
    expect(csv).toBe("claim_id,shipment_id,decision,approved_amount_inr,reason,draft_reply\r\n");
  });
});

describe("admin, audit and errors", () => {
  it("POST /admin/reset is refused outside demo mode and wipes state inside it", async () => {
    const { app, postJson } = build();
    await postJson("/claims", { email: C01, claim_id: "C01" });

    const refused = await app.request("/admin/reset", { method: "POST" }, makeEnv({ ALLOW_FAULT_INJECTION: "0" }));
    expect(refused.status).toBe(403);
    expect(((await (await app.request("/claims", {}, makeEnv())).json()) as any).count).toBe(1);

    const done = await app.request("/admin/reset", { method: "POST" }, makeEnv());
    expect(done.status).toBe(200);
    const list = (await (await app.request("/claims", {}, makeEnv())).json()) as any;
    expect(list).toMatchObject({ count: 0, rows: [], claims: [] });
  });

  it("GET /audit returns { entries }", async () => {
    const { app, postJson } = build();
    await postJson("/claims", { email: C01, claim_id: "C01" });
    const res = await app.request("/audit?limit=5", {}, makeEnv());
    expect(res.status).toBe(200);
    const body = (await res.json()) as any;
    expect(Array.isArray(body.entries)).toBe(true);
    expect(body.entries.length).toBeLessThanOrEqual(5);
  });

  it("unknown paths are a JSON 404", async () => {
    const { app } = build();
    const res = await app.request("/nope", {}, makeEnv());
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: "Not found" });
  });

  it("unexpected failures are a generic 500 with no stack or secret", async () => {
    const app = createApp({
      buildDeps: () => {
        throw new Error(`upstream exploded with key ${SECRET}`);
      },
    });
    const quiet = vi.spyOn(console, "error").mockImplementation(() => {});
    const res = await app.request(
      "/claims",
      { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ email: C01 }) },
      makeEnv({ GROQ_API_KEY: SECRET }),
    );
    const logged = JSON.stringify(quiet.mock.calls);
    quiet.mockRestore();
    expect(res.status).toBe(500);
    const text = await res.text();
    expect(Object.keys(JSON.parse(text))).toEqual(["error"]);
    expect(text).not.toContain(SECRET);
    expect(text).not.toContain("exploded");
    expect(text).not.toMatch(/\bat \w+.*:\d+/);
    expect(logged).not.toContain(SECRET);
  });
});
