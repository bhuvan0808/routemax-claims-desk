import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { beforeAll, describe, expect, it } from "vitest";
import { LookupResultSchema, PriorClaimsResultSchema } from "../types";
import {
  createTools,
  parsePastDecisionsCsv,
  parseShipmentsCsv,
  pastDecisionToPriorClaim,
  withTimeout,
  type SeedData,
} from "./index";
import { loadSeedData } from "./node-loader";

// (string form: the Workers and Node `URL` types clash under this tsconfig)
const DATA_DIR = resolve(dirname(fileURLToPath(import.meta.url)), "../../data");

let seed: SeedData;
beforeAll(async () => {
  seed = await loadSeedData(DATA_DIR);
});

describe("loaders (real CSVs)", () => {
  it("loads 16 shipments with numeric fields", () => {
    expect(seed.shipments).toHaveLength(16);
    const s = seed.shipments.find((x) => x.shipment_id === "SHP-1010");
    expect(s).toEqual({
      shipment_id: "SHP-1010",
      customer: "Metro Hardware",
      delivered_date: "2026-11-07",
      pieces_shipped: 10,
      declared_value_inr: 25000,
      pod_status: "Signed with remarks",
      pod_remarks: "1 carton dented",
    });
  });

  it("maps empty pod_remarks to an empty string", () => {
    const s = seed.shipments.find((x) => x.shipment_id === "SHP-1007");
    expect(s?.pod_remarks).toBe("");
    expect(s?.pod_status).toBe("Signed - received in good condition");
  });

  it("loads 26 past decisions with normalised decisions and booleans", () => {
    expect(seed.pastDecisions).toHaveLength(26);
    const decisions = new Set(seed.pastDecisions.map((p) => p.decision));
    expect([...decisions].sort()).toEqual(["approve", "escalate", "need_info", "reject"]);
    const c0901 = seed.pastDecisions.find((p) => p.claim_id === "C-0901");
    expect(c0901).toMatchObject({ decision: "approve", photo_attached: false, claim_amount_inr: 2400, approved_amount_inr: 2400 });
    const c0907 = seed.pastDecisions.find((p) => p.claim_id === "C-0907");
    expect(c0907).toMatchObject({ decision: "escalate", photo_attached: true, claim_amount_inr: 88000, approved_amount_inr: 64000 });
    expect(seed.pastDecisions.find((p) => p.claim_id === "C-0903")?.decision).toBe("reject");
    expect(seed.pastDecisions.find((p) => p.claim_id === "C-0908")?.decision).toBe("need_info");
  });

  it("keeps quoted notes containing commas intact, and empty notes empty", () => {
    expect(seed.pastDecisions.find((p) => p.claim_id === "C-0905")?.notes).toBe("POD clean, no remarks");
    expect(seed.pastDecisions.find((p) => p.claim_id === "C-0931")?.notes).toBe("paid 2026-10-20, ref PAY-7781");
    expect(seed.pastDecisions.find((p) => p.claim_id === "C-0902")?.notes).toBe("");
  });
});

describe("loaders fail loudly on bad seed data", () => {
  const header = "shipment_id,customer,delivered_date,pieces_shipped,declared_value_inr,pod_status,pod_remarks";

  it("rejects a non-numeric value and names the row", () => {
    expect(() => parseShipmentsCsv(`${header}\nSHP-1,Acme,2026-11-01,ten,5000,Signed,`)).toThrow(/bad row 2 \(SHP-1\).*pieces_shipped/);
  });

  it("rejects an empty number, a bad date and a duplicate id", () => {
    expect(() => parseShipmentsCsv(`${header}\nSHP-1,Acme,2026-11-01,3,,Signed,`)).toThrow(/declared_value_inr/);
    expect(() => parseShipmentsCsv(`${header}\nSHP-1,Acme,07/11/2026,3,5000,Signed,`)).toThrow(/delivered_date/);
    expect(() =>
      parseShipmentsCsv(`${header}\nSHP-1,Acme,2026-11-01,3,5000,Signed,\nshp-1,Acme,2026-11-01,3,5000,Signed,`),
    ).toThrow(/bad row 3.*duplicate/);
  });

  it("rejects a missing column and an empty file", () => {
    expect(() => parseShipmentsCsv("shipment_id,customer\nSHP-1,Acme")).toThrow(/missing column/);
    expect(() => parseShipmentsCsv("")).toThrow(/no data rows/);
  });

  it("rejects an unknown past decision / photo flag", () => {
    const h = "claim_id,shipment_id,customer,claim_type,filed_date,delivered_date,claim_amount_inr,photo_attached,decision,approved_amount_inr,decided_by,notes";
    expect(() => parsePastDecisionsCsv(`${h}\nC-1,SHP-1,Acme,damage,2026-10-02,2026-09-30,100,no,maybe,0,Rahul,`)).toThrow(/bad row 2 \(C-1\).*decision/);
    expect(() => parsePastDecisionsCsv(`${h}\nC-1,SHP-1,Acme,damage,2026-10-02,2026-09-30,100,perhaps,approved,0,Rahul,`)).toThrow(/photo_attached/);
  });
});

describe("pastDecisionToPriorClaim", () => {
  it("extracts payment ref and paid date from notes", () => {
    const p = seed.pastDecisions.find((x) => x.claim_id === "C-0931")!;
    expect(pastDecisionToPriorClaim(p)).toEqual({
      source: "past_decisions",
      claim_id: "C-0931",
      shipment_id: "SHP-0987",
      decision: "approve",
      approved_amount_inr: 6500,
      decided_date: "2026-10-10",
      payment_ref: "PAY-7781",
      paid_date: "2026-10-20",
      notes: "paid 2026-10-20, ref PAY-7781",
    });
  });

  it("returns null for need_info and null notes when empty", () => {
    expect(pastDecisionToPriorClaim(seed.pastDecisions.find((x) => x.claim_id === "C-0908")!)).toBeNull();
    const plain = pastDecisionToPriorClaim(seed.pastDecisions.find((x) => x.claim_id === "C-0902")!);
    expect(plain).toMatchObject({ notes: null, payment_ref: null, paid_date: null });
  });
});

describe("lookupShipment", () => {
  it("finds a shipment (case-insensitive, trimmed) in the default mode", async () => {
    const tools = createTools(seed);
    const exact = await tools.lookupShipment("SHP-1010");
    expect(exact).toMatchObject({ status: "found", shipment: { shipment_id: "SHP-1010", declared_value_inr: 25000 } });
    expect(await tools.lookupShipment("  shp-1010 ")).toEqual(exact);
    expect(LookupResultSchema.safeParse(exact).success).toBe(true);
  });

  it("returns not_found for an unknown id", async () => {
    const tools = createTools(seed, { failMode: "none" });
    expect(await tools.lookupShipment("SHP-9999")).toEqual({ status: "not_found" });
    expect(await tools.lookupShipment("")).toEqual({ status: "not_found" });
  });

  it("does not let callers mutate seed data", async () => {
    const tools = createTools(seed);
    const first = await tools.lookupShipment("SHP-1010");
    if (first.status !== "found") throw new Error("expected found");
    first.shipment.declared_value_inr = 1;
    const second = await tools.lookupShipment("SHP-1010");
    expect(second).toMatchObject({ status: "found", shipment: { declared_value_inr: 25000 } });
  });

  it("failMode=error returns an error result", async () => {
    const tools = createTools(seed, { failMode: "error" });
    expect(await tools.lookupShipment("SHP-1010")).toEqual({
      status: "error",
      error: "lookup failed: shipment service error (injected)",
    });
  });

  it("failMode=not_found hides every record", async () => {
    const tools = createTools(seed, { failMode: "not_found" });
    expect(await tools.lookupShipment("SHP-1010")).toEqual({ status: "not_found" });
  });

  it("failMode=timeout returns an error after roughly timeoutMs and never throws", async () => {
    const tools = createTools(seed, { failMode: "timeout", timeoutMs: 30 });
    const started = Date.now();
    const result = await tools.lookupShipment("SHP-1010");
    const elapsed = Date.now() - started;
    expect(result).toEqual({ status: "error", error: "lookup failed: timeout after 30ms" });
    expect(elapsed).toBeGreaterThanOrEqual(20);
    expect(elapsed).toBeLessThan(1000);
  });

  it("never throws, even on a nonsense id, and every error starts with 'lookup failed'", async () => {
    const tools = createTools(seed);
    const result = await tools.lookupShipment(undefined as unknown as string);
    expect(result.status).toBe("error");
    if (result.status === "error") expect(result.error.startsWith("lookup failed")).toBe(true);
  });
});

describe("withTimeout", () => {
  it("passes through a value and a rejection that settle in time", async () => {
    await expect(withTimeout(Promise.resolve(7), 30)).resolves.toBe(7);
    await expect(withTimeout(Promise.reject(new Error("boom")), 30)).rejects.toThrow("boom");
  });

  it("rejects when the promise does not settle in time", async () => {
    await expect(withTimeout(new Promise(() => {}), 20)).rejects.toThrow("timeout after 20ms");
  });
});

describe("lookupPriorClaims", () => {
  it("returns the paid claim for SHP-0987", async () => {
    const tools = createTools(seed);
    const result = await tools.lookupPriorClaims("shp-0987");
    expect(PriorClaimsResultSchema.safeParse(result).success).toBe(true);
    expect(result).toEqual({
      status: "ok",
      claims: [
        {
          source: "past_decisions",
          claim_id: "C-0931",
          shipment_id: "SHP-0987",
          decision: "approve",
          approved_amount_inr: 6500,
          decided_date: "2026-10-10",
          payment_ref: "PAY-7781",
          paid_date: "2026-10-20",
          notes: "paid 2026-10-20, ref PAY-7781",
        },
      ],
    });
  });

  it("returns none for SHP-0957 (need_info is not decided) and for unknown shipments", async () => {
    const tools = createTools(seed);
    expect(await tools.lookupPriorClaims("SHP-0957")).toEqual({ status: "ok", claims: [] });
    expect(await tools.lookupPriorClaims("SHP-1010")).toEqual({ status: "ok", claims: [] });
  });

  it("includes rejected and escalated claims", async () => {
    const tools = createTools(seed);
    expect(await tools.lookupPriorClaims("SHP-0952")).toMatchObject({ status: "ok", claims: [{ claim_id: "C-0903", decision: "reject", approved_amount_inr: 0 }] });
    expect(await tools.lookupPriorClaims("SHP-0956")).toMatchObject({ status: "ok", claims: [{ claim_id: "C-0907", decision: "escalate", approved_amount_inr: 64000 }] });
  });

  it("is not affected by failMode", async () => {
    for (const failMode of ["error", "timeout", "not_found"] as const) {
      const tools = createTools(seed, { failMode, timeoutMs: 30 });
      const result = await tools.lookupPriorClaims("SHP-0987");
      expect(result).toMatchObject({ status: "ok", claims: [{ claim_id: "C-0931", payment_ref: "PAY-7781" }] });
    }
  });
});
