import { existsSync } from "node:fs";
import { mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { AuditEntry, ClaimsStore, Decision, ProcessedEmail } from "../types";
import { FileStore } from "./file";
import { MemoryStore, priorClaimsFromProcessed } from "./index";

const POLICY = {
  defaultWindowDays: 7,
  keyAccountWindows: {},
  smallClaimPhotoWaiverInr: 5000,
  shortageProRata: true,
  payConsequentialLoss: false,
  approvalLimitInr: 50000,
};

function record(hash: string, claimId: string, shipmentId: string, decision: Decision, amount = 0): ProcessedEmail {
  const row = { claim_id: claimId, shipment_id: shipmentId, decision, approved_amount_inr: amount, reason: `${decision} (test)`, draft_reply: "Dear customer" };
  return {
    email_hash: hash,
    claim_id: claimId,
    processed_at: "2026-11-10T09:30:00.000Z",
    llm_mode: "mock",
    model: "mock-heuristic-v1",
    rows: [row],
    details: [{ row, rule_ids: ["R9"], trace: [{ rule: "R9", outcome: "fire", note: "test" }], customer_reason: "test", extracted_claim: null, facts: { n: 1 } }],
  };
}

function audit(n: number): AuditEntry {
  return {
    ts: `2026-11-10T09:30:0${n}.000Z`,
    event: "decision",
    email_hash: `h${n}`,
    claim_id: `C0${n}`,
    shipment_id: "SHP-1010",
    decision: "approve",
    approved_amount_inr: 100 * n,
    rule_ids: ["R9"],
    reason: `entry ${n}`,
    inputs: { n },
    config_snapshot: POLICY,
    llm_mode: "mock",
    model: "mock-heuristic-v1",
  };
}

let dir: string;
let fileCount = 0;
beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), "routemax-store-"));
});
afterAll(async () => {
  await rm(dir, { recursive: true, force: true });
});
/** A fresh path in a not-yet-existing sub-directory (FileStore must create the parent). */
const freshPath = () => join(dir, `run-${fileCount++}`, "nested", "state.json");

const implementations: Array<[string, () => ClaimsStore]> = [
  ["MemoryStore", () => new MemoryStore()],
  ["FileStore", () => new FileStore(freshPath())],
];

describe.each(implementations)("%s", (_name, make) => {
  it("starts empty", async () => {
    const store = make();
    expect(await store.getByEmailHash("nope")).toBeNull();
    expect(await store.listProcessed()).toEqual([]);
    expect(await store.listAudit()).toEqual([]);
    expect(await store.findDecidedByShipment("SHP-1010")).toEqual([]);
  });

  it("saves and reads back by email hash, in insertion order", async () => {
    const store = make();
    const a = record("hash-a", "C01", "SHP-1010", "approve", 4000);
    const b = record("hash-b", "C02", "SHP-1001", "reject");
    expect(await store.saveProcessed(a)).toEqual(a);
    expect(await store.saveProcessed(b)).toEqual(b);
    expect(await store.getByEmailHash("hash-a")).toEqual(a);
    expect((await store.listProcessed()).map((r) => r.email_hash)).toEqual(["hash-a", "hash-b"]);
  });

  it("saveProcessed is insert-if-absent: the first writer wins", async () => {
    const store = make();
    const first = record("same-hash", "C01", "SHP-1010", "approve", 4000);
    const second = record("same-hash", "C99", "SHP-1010", "reject");
    await store.saveProcessed(first);
    expect(await store.saveProcessed(second)).toEqual(first);
    expect(await store.listProcessed()).toEqual([first]);
    expect(await store.getByEmailHash("same-hash")).toEqual(first);
  });

  it("concurrent saves of the same hash store exactly one record", async () => {
    const store = make();
    const results = await Promise.all(
      [1, 2, 3, 4, 5].map((n) => store.saveProcessed(record("race", `C0${n}`, "SHP-1010", "approve", n))),
    );
    expect(new Set(results.map((r) => r.claim_id)).size).toBe(1);
    expect(await store.listProcessed()).toHaveLength(1);
  });

  it("returns deep copies so callers cannot mutate state", async () => {
    const store = make();
    const input = record("hash-a", "C01", "SHP-1010", "approve", 4000);
    const saved = await store.saveProcessed(input);
    input.rows[0].decision = "reject";
    saved.rows[0].approved_amount_inr = 1;
    (await store.listProcessed())[0].claim_id = "MUTATED";
    const fetched = await store.getByEmailHash("hash-a");
    expect(fetched).toEqual(record("hash-a", "C01", "SHP-1010", "approve", 4000));
    fetched!.details[0].facts.n = 99;
    expect((await store.getByEmailHash("hash-a"))!.details[0].facts.n).toBe(1);

    const entry = audit(1);
    await store.appendAudit(entry);
    entry.reason = "changed after append";
    (await store.listAudit())[0].reason = "changed after read";
    expect((await store.listAudit())[0].reason).toBe("entry 1");
  });

  it("findDecidedByShipment returns only approve/reject/escalate rows for that shipment", async () => {
    const store = make();
    await store.saveProcessed(record("h1", "C01", "SHP-1010", "approve", 4000));
    await store.saveProcessed(record("h2", "C02", "SHP-1010", "need_info"));
    await store.saveProcessed(record("h3", "C03", "SHP-1010", "duplicate"));
    await store.saveProcessed(record("h4", "C04", "SHP-1010", "not_a_claim"));
    await store.saveProcessed(record("h5", "C05", "SHP-1010", "escalate", 60000));
    await store.saveProcessed(record("h6", "C06", "SHP-1010", "reject"));
    await store.saveProcessed(record("h7", "C07", "SHP-1001", "approve", 500));

    const decided = await store.findDecidedByShipment("shp-1010");
    expect(decided.map((c) => [c.claim_id, c.decision])).toEqual([
      ["C01", "approve"],
      ["C05", "escalate"],
      ["C06", "reject"],
    ]);
    expect(decided[0]).toEqual({
      source: "state",
      claim_id: "C01",
      shipment_id: "SHP-1010",
      decision: "approve",
      approved_amount_inr: 4000,
      decided_date: "2026-11-10",
      payment_ref: null,
      paid_date: null,
      notes: null,
    });
    expect(await store.findDecidedByShipment("SHP-1001")).toHaveLength(1);
    expect(await store.findDecidedByShipment("SHP-9999")).toEqual([]);
    expect(await store.findDecidedByShipment("")).toEqual([]);
  });

  it("audit log is newest-last and limit returns the last N", async () => {
    const store = make();
    for (const n of [1, 2, 3, 4]) await store.appendAudit(audit(n));
    expect((await store.listAudit()).map((e) => e.claim_id)).toEqual(["C01", "C02", "C03", "C04"]);
    expect((await store.listAudit(2)).map((e) => e.claim_id)).toEqual(["C03", "C04"]);
    expect((await store.listAudit(10)).map((e) => e.claim_id)).toEqual(["C01", "C02", "C03", "C04"]);
    expect(await store.listAudit(0)).toEqual([]);
  });

  it("reset wipes processed emails and audit", async () => {
    const store = make();
    await store.saveProcessed(record("h1", "C01", "SHP-1010", "approve", 4000));
    await store.appendAudit(audit(1));
    await store.reset();
    expect(await store.listProcessed()).toEqual([]);
    expect(await store.listAudit()).toEqual([]);
    expect(await store.getByEmailHash("h1")).toBeNull();
    expect(await store.findDecidedByShipment("SHP-1010")).toEqual([]);
    // and the store is usable again afterwards
    await store.saveProcessed(record("h1", "C01", "SHP-1010", "approve", 4000));
    expect(await store.listProcessed()).toHaveLength(1);
  });
});

describe("priorClaimsFromProcessed", () => {
  it("handles multi-row records and matches case-insensitively", () => {
    const multi = record("h1", "C01", "SHP-1010", "approve", 4000);
    multi.rows.push({ claim_id: "C01-2", shipment_id: "SHP-1001", decision: "reject", approved_amount_inr: 0, reason: "r", draft_reply: "d" });
    expect(priorClaimsFromProcessed([multi], " shp-1001 ")).toMatchObject([{ claim_id: "C01-2", decision: "reject", source: "state" }]);
    expect(priorClaimsFromProcessed([multi], "SHP-1010")).toHaveLength(1);
    expect(priorClaimsFromProcessed([], "SHP-1010")).toEqual([]);
  });
});

describe("FileStore persistence", () => {
  it("creates the parent directory, writes valid JSON and leaves no temp files", async () => {
    const path = freshPath();
    const store = new FileStore(path);
    expect(existsSync(path)).toBe(false); // lazy: nothing touched until first use
    await store.saveProcessed(record("h1", "C01", "SHP-1010", "approve", 4000));
    await store.appendAudit(audit(1));
    const onDisk = JSON.parse(await readFile(path, "utf8"));
    expect(onDisk.processed).toHaveLength(1);
    expect(onDisk.audit).toHaveLength(1);
    expect(await readdir(join(path, ".."))).toEqual(["state.json"]);
  });

  it("survives re-instantiation (state, idempotency and audit)", async () => {
    const path = freshPath();
    const first = new FileStore(path);
    const original = record("h1", "C01", "SHP-1010", "approve", 4000);
    await first.saveProcessed(original);
    await first.saveProcessed(record("h2", "C02", "SHP-1001", "need_info"));
    await first.appendAudit(audit(1));
    await first.appendAudit(audit(2));

    const second = new FileStore(path);
    expect(await second.getByEmailHash("h1")).toEqual(original);
    expect((await second.listProcessed()).map((r) => r.email_hash)).toEqual(["h1", "h2"]);
    expect((await second.listAudit(1)).map((e) => e.claim_id)).toEqual(["C02"]);
    expect(await second.findDecidedByShipment("SHP-1010")).toHaveLength(1);
    // idempotency still holds against what was loaded from disk
    expect(await second.saveProcessed(record("h1", "C99", "SHP-1010", "reject"))).toEqual(original);
    expect(await second.listProcessed()).toHaveLength(2);
  });

  it("reset persists: a new instance sees an empty store", async () => {
    const path = freshPath();
    const first = new FileStore(path);
    await first.saveProcessed(record("h1", "C01", "SHP-1010", "approve", 4000));
    await first.reset();
    const second = new FileStore(path);
    expect(await second.listProcessed()).toEqual([]);
    expect(await second.listAudit()).toEqual([]);
  });

  it("fails loudly on a corrupt state file, and reset() recovers it", async () => {
    const path = freshPath();
    const seeded = new FileStore(path);
    await seeded.reset(); // creates the directory + file
    await writeFile(path, "{ not json", "utf8");
    const store = new FileStore(path);
    await expect(store.listProcessed()).rejects.toThrow(/not valid JSON/);
    await store.reset();
    expect(await store.listProcessed()).toEqual([]);
  });
});
