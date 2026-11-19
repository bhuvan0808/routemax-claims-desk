/**
 * Pipeline integration tests (mock LLM, in-memory store, real seed data).
 * Focus: the things that must hold no matter what the LLM or a tool does.
 */
import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { findInrAmounts } from "./format";
import { processEmail } from "./pipeline";
import { createLocalDeps } from "./runtime/local";
import type { Extraction, Extractor, PipelineDeps, ResultRow } from "./types";

const EMAIL_DIR = join("data", "claim_emails");
const clock = () => "2026-11-10T10:00:00.000Z";

async function deps(overrides: Parameters<typeof createLocalDeps>[0] = {}): Promise<PipelineDeps> {
  const d = await createLocalDeps({ llmMode: "mock", failMode: "none", lookupTimeoutMs: 40, ...overrides });
  return { ...d, now: clock };
}
const read = (name: string) => readFile(join(EMAIL_DIR, `${name}.txt`), "utf8");

function fakeExtractor(extraction: Extraction | (() => never)): Extractor {
  return {
    mode: "mock",
    model: "fake-hostile-llm",
    async extract() {
      if (typeof extraction === "function") return extraction();
      return extraction;
    },
  };
}

const GOLDEN: Array<[string, string, ResultRow["decision"], number]> = [
  ["C01", "SHP-1001", "approve", 18000],
  ["C02", "SHP-1002", "reject", 0],
  ["C03", "SHP-1003", "approve", 9000],
  ["C04", "SHP-1004", "need_info", 0],
  ["C05", "SHP-1005", "need_info", 0],
  ["C06", "SHP-1006", "escalate", 72000],
  ["C07", "SHP-1007", "reject", 0],
  ["C08", "SHP-0987", "duplicate", 0],
  ["C09", "SHP-1009", "approve", 7500],
  ["C10", "SHP-1010", "approve", 4000],
  ["C11", "SHP-1011", "reject", 0],
  ["C12", "SHP-1012", "reject", 0],
  ["C13", "SHP-1013", "escalate", 58000],
  ["C14", "SHP-1014", "approve", 6000],
  ["C14", "SHP-1015", "need_info", 0],
  ["C15", "SHP-1016", "not_a_claim", 0],
];

describe("golden batch (mock mode)", () => {
  it("produces the 16 expected rows from today's 15 emails", async () => {
    const d = await deps();
    const files = (await readdir(EMAIL_DIR)).filter((f) => f.endsWith(".txt")).sort();
    const rows: ResultRow[] = [];
    for (const f of files) {
      const res = await processEmail({ raw: await readFile(join(EMAIL_DIR, f), "utf8"), claimId: f.replace(".txt", "") }, d);
      rows.push(...res.rows);
    }
    expect(rows.map((r) => [r.claim_id, r.shipment_id, r.decision, r.approved_amount_inr])).toEqual(GOLDEN);
    for (const r of rows) {
      expect(r.reason).toMatch(/R\d/); // every reason cites a rule id
      expect(r.draft_reply.length).toBeGreaterThan(20);
      const amounts = findInrAmounts(r.draft_reply);
      if (r.decision === "approve") expect(amounts).toEqual([r.approved_amount_inr]);
      else expect(amounts).toEqual([]); // no reply promises money the engine did not approve
    }
    const c08 = rows.find((r) => r.claim_id === "C08")!;
    expect(c08.reason).toContain("C-0931");
    expect(c08.draft_reply).toContain("PAY-7781");
    expect((await d.store.listAudit()).filter((a) => a.event === "decision")).toHaveLength(16);
  });
});

describe("idempotency and duplicates", () => {
  it("the same email twice returns the stored result and creates no new rows", async () => {
    const d = await deps();
    const raw = await read("C01");
    const first = await processEmail({ raw, claimId: "C01" }, d);
    const second = await processEmail({ raw: raw.replace(/\n/g, "\r\n") + "\n", claimId: "C01-again" }, d);
    expect(first.idempotent_replay).toBe(false);
    expect(second.idempotent_replay).toBe(true);
    expect(second.rows).toEqual(first.rows);
    expect(second.claim_id).toBe("C01");
    expect(await d.store.listProcessed()).toHaveLength(1);
    const audit = await d.store.listAudit();
    expect(audit.map((a) => a.event)).toEqual(["decision", "idempotent_replay"]);
  });

  it("a NEW email about an already-decided shipment is a duplicate, never a second approval", async () => {
    const d = await deps();
    const first = await processEmail({ raw: await read("C01"), claimId: "C01" }, d);
    expect(first.rows[0].decision).toBe("approve");
    const followUp = (await read("C01")).replace("Hi team,", "Hi team, sending this again as I got no reply.");
    const second = await processEmail({ raw: followUp, claimId: "C01-B" }, d);
    expect(second.idempotent_replay).toBe(false);
    expect(second.rows[0].decision).toBe("duplicate");
    expect(second.rows[0].approved_amount_inr).toBe(0);
    expect(second.rows[0].reason).toContain("C01");
  });

  it("a need_info is not a decision: the follow-up with photos is processed normally", async () => {
    const d = await deps();
    const noPhotos = await read("C04");
    expect((await processEmail({ raw: noPhotos, claimId: "C04" }, d)).rows[0].decision).toBe("need_info");
    const withPhotos = noPhotos.replace("Attachments: none", "Attachments: torn_box.jpg");
    const res = await processEmail({ raw: withPhotos, claimId: "C04-photos" }, d);
    expect(res.rows[0].decision).toBe("approve");
    expect(res.rows[0].approved_amount_inr).toBe(3200);
  });
});

describe("the LLM cannot choose the decision or the amount", () => {
  const base = {
    is_claim: true,
    language: "en" as const,
    customer_name: "Apex Pharma",
  };
  const claim = {
    shipment_id_raw: "SHP-1001",
    claim_type: "damage" as const,
    claimed_amount_inr: 18000,
    pieces_claimed_missing: null,
    summary: "One box crushed.",
    customer_states_no_photos: false,
    consequential_loss_mentioned: false,
  };

  it("an inflated amount that is not in the email is discarded (need_info, 0), not paid", async () => {
    const d = await deps();
    d.extractor = fakeExtractor({ ...base, claims: [{ ...claim, claimed_amount_inr: 59000 }] });
    const res = await processEmail({ raw: await read("C01"), claimId: "X1" }, d);
    expect(res.rows[0].decision).toBe("need_info");
    expect(res.rows[0].approved_amount_inr).toBe(0);
    expect(res.rows[0].reason).toContain("E2");
  });

  it("an invented shipment id is discarded (need_info, 0)", async () => {
    const d = await deps();
    d.extractor = fakeExtractor({ ...base, claims: [{ ...claim, shipment_id_raw: "SHP-1013" }] });
    const res = await processEmail({ raw: await read("C01"), claimId: "X2" }, d);
    expect(res.rows[0].decision).toBe("need_info");
    expect(res.rows[0].approved_amount_inr).toBe(0);
  });

  it("relabelling a no-photo damage claim as a shortage still cannot get it approved", async () => {
    const d = await deps();
    d.extractor = fakeExtractor({
      ...base,
      customer_name: "Kirana Mart",
      claims: [{ ...claim, shipment_id_raw: "SHP-1004", claim_type: "shortage", claimed_amount_inr: 3200 }],
    });
    const res = await processEmail({ raw: await read("C04"), claimId: "X3" }, d);
    expect(res.rows[0].decision).not.toBe("approve");
    expect(res.rows[0].approved_amount_inr).toBe(0);
  });

  it("extraction failure escalates with amount 0 and is not stored, so it can be retried", async () => {
    const d = await deps();
    d.extractor = fakeExtractor(() => {
      throw new Error("extraction failed: invalid JSON");
    });
    const res = await processEmail({ raw: await read("C01"), claimId: "X4" }, d);
    expect(res.rows[0].decision).toBe("escalate");
    expect(res.rows[0].approved_amount_inr).toBe(0);
    expect(res.rows[0].reason).toContain("E1");
    expect(await d.store.listProcessed()).toHaveLength(0);
    expect((await d.store.listAudit())[0].event).toBe("extraction_failed");
  });

  it("a drafter that throws falls back to the template; the decision is unchanged", async () => {
    const d = await deps();
    d.drafter = {
      mode: "mock",
      model: "broken",
      async draft() {
        throw new Error("network down");
      },
    };
    const res = await processEmail({ raw: await read("C01"), claimId: "X5" }, d);
    expect(res.rows[0].decision).toBe("approve");
    expect(findInrAmounts(res.rows[0].draft_reply)).toEqual([18000]);
  });
});

// Regression for eval case D30 (see FIX_LOG.md). Before the fix this approved Rs 18,000.
describe("sender identity cannot be spoofed through the From display name", () => {
  const spoofedFrom = (from: string) => async () => (await read("C01")).replace("From: ops@apexpharma.in", `From: ${from}`);

  it.each([
    ['"ops@apexpharma.in" <refunds@fastpay-claims.biz>', "display name is the customer's address"],
    ["ops@apexpharma.in <refunds@fastpay-claims.biz>", "unquoted display name"],
    ["refunds@fastpay-claims.biz, ops@apexpharma.in", "two different From addresses"],
    ["Deepa from Apex Pharma", "no address at all"],
  ])("From: %s (%s) -> need_info, amount 0", async (from) => {
    const d = await deps();
    const res = await processEmail({ raw: await spoofedFrom(from)(), claimId: "SPOOF" }, d);
    expect(res.rows[0].decision).toBe("need_info");
    expect(res.rows[0].approved_amount_inr).toBe(0);
    expect(res.rows[0].draft_reply).not.toContain("Apex Pharma is"); // reply must not confirm whose shipment it is
    expect(res.details[0].facts.sender_matches_customer).toBe(false);
  });

  it("the genuine sender with a display name is still approved", async () => {
    const d = await deps();
    const res = await processEmail({ raw: await spoofedFrom("Deepa <ops@apexpharma.in>")(), claimId: "REAL" }, d);
    expect(res.rows[0].decision).toBe("approve");
    expect(res.rows[0].approved_amount_inr).toBe(18000);
  });
});

describe("lookup failure never approves", () => {
  it.each([
    ["error", "escalate"],
    ["timeout", "escalate"],
    ["not_found", "need_info"],
  ] as const)("LOOKUP_FAIL_MODE=%s -> %s, amount 0", async (failMode, expected) => {
    const d = await deps({ failMode });
    const res = await processEmail({ raw: await read("C01"), claimId: "F" }, d);
    expect(res.rows[0].decision).toBe(expected);
    expect(res.rows[0].approved_amount_inr).toBe(0);
    if (expected === "escalate") expect(res.rows[0].reason.toLowerCase()).toContain("lookup failed");
  });

  it("a tool that throws or returns garbage is treated as a failed lookup", async () => {
    const d = await deps();
    d.tools = {
      async lookupShipment() {
        throw new Error("ECONNRESET");
      },
      async lookupPriorClaims() {
        return { status: "ok", claims: [] };
      },
    };
    const thrown = await processEmail({ raw: await read("C01"), claimId: "T1" }, d);
    expect(thrown.rows[0].decision).toBe("escalate");
    expect(thrown.rows[0].approved_amount_inr).toBe(0);

    const d2 = await deps();
    d2.tools = {
      lookupShipment: (async () => ({ status: "found" })) as never,
      async lookupPriorClaims() {
        return { status: "ok", claims: [] };
      },
    };
    const garbage = await processEmail({ raw: await read("C01"), claimId: "T2" }, d2);
    expect(garbage.rows[0].decision).toBe("escalate");
    expect(garbage.rows[0].approved_amount_inr).toBe(0);
  });

  it("if the prior-claims check fails we cannot rule out a duplicate, so no approval", async () => {
    const d = await deps();
    const real = d.tools;
    d.tools = {
      lookupShipment: (id) => real.lookupShipment(id),
      async lookupPriorClaims() {
        return { status: "error", error: "past decisions unavailable" };
      },
    };
    const res = await processEmail({ raw: await read("C01"), claimId: "P1" }, d);
    expect(res.rows[0].decision).toBe("escalate");
    expect(res.rows[0].approved_amount_inr).toBe(0);
  });
});
