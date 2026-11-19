import { describe, expect, it } from "vitest";
import { findInrAmounts } from "../format";
import { defaultPolicy } from "../policy.config";
import {
  EngineDecisionSchema,
  type EngineDecision,
  type EngineInput,
  type ExtractedClaim,
  type PolicyConfig,
  type PriorClaim,
  type Shipment,
} from "../types";
import { decide, normaliseShipmentId, parsePodReceivedCount, senderMatchesCustomer } from "./index";

/* ------------------------------------------------------------ fixtures */

const GOOD = "Signed - received in good condition";
const REMARKS = "Signed with remarks";

function ship(
  shipment_id: string,
  customer: string,
  delivered_date: string,
  pieces_shipped: number,
  declared_value_inr: number,
  pod_status: string,
  pod_remarks: string,
): Shipment {
  return { shipment_id, customer, delivered_date, pieces_shipped, declared_value_inr, pod_status, pod_remarks };
}

/** Hand-copied from data/shipments.csv. */
const SHIPMENTS: Record<string, Shipment> = Object.fromEntries(
  [
    ship("SHP-1001", "Apex Pharma", "2026-11-07", 30, 60000, REMARKS, "1 box crushed"),
    ship("SHP-1002", "Bluewave Electronics", "2026-10-30", 20, 85000, REMARKS, "2 cartons dented"),
    ship("SHP-1003", "Zenith Retail", "2026-10-29", 40, 48000, REMARKS, "37 pieces received"),
    ship("SHP-1004", "Kirana Mart", "2026-11-08", 15, 18000, REMARKS, "outer carton damaged"),
    ship("SHP-1005", "Nova Textiles", "2026-11-06", 22, 40000, REMARKS, "2 rolls stained"),
    ship("SHP-1006", "Orbit Auto Parts", "2026-11-05", 18, 72000, REMARKS, "cartons wet"),
    ship("SHP-1007", "Sunrise Foods", "2026-11-04", 50, 35000, GOOD, ""),
    ship("SHP-1009", "Desi Bazaar", "2026-11-08", 25, 30000, REMARKS, "20 received"),
    ship("SHP-1010", "Metro Hardware", "2026-11-07", 10, 25000, REMARKS, "1 carton dented"),
    ship("SHP-1011", "Bluewave Electronics", "2026-11-09", 12, 90000, GOOD, "12 pieces received"),
    ship("SHP-1012", "Nova Textiles", "2026-11-02", 8, 12000, REMARKS, "1 roll torn"),
    ship("SHP-1013", "Zenith Retail", "2026-11-06", 60, 120000, REMARKS, "pallet broken"),
    ship("SHP-1014", "Orbit Auto Parts", "2026-11-07", 14, 40000, REMARKS, "scratches on 2 units"),
    ship("SHP-1015", "Orbit Auto Parts", "2026-11-08", 9, 22000, REMARKS, "box corner crushed"),
    ship("SHP-1016", "Sunrise Foods", "2026-11-09", 40, 28000, GOOD, ""),
    ship("SHP-0987", "Apex Pharma", "2026-10-08", 20, 30000, REMARKS, "1 carton torn"),
  ].map((s) => [s.shipment_id, s]),
);

const SENDERS: Record<string, string> = {
  "Apex Pharma": "ops@apexpharma.in",
  "Bluewave Electronics": "logistics@bluewave.co",
  "Zenith Retail": "stores@zenithretail.com",
  "Kirana Mart": "kiranamart.blr@gmail.com",
  "Nova Textiles": "accounts@novatextiles.in",
  "Orbit Auto Parts": "purchase@orbitauto.in",
  "Sunrise Foods": "qa@sunrisefoods.in",
  "Desi Bazaar": "desibazaar.orders@gmail.com",
  "Metro Hardware": "orders@metrohardware.in",
};

const PRIOR_C0931: PriorClaim = {
  source: "past_decisions",
  claim_id: "C-0931",
  shipment_id: "SHP-0987",
  decision: "approve",
  approved_amount_inr: 6500,
  decided_date: "2026-10-10",
  payment_ref: "PAY-7781",
  paid_date: "2026-10-20",
  notes: "paid 2026-10-20, ref PAY-7781",
};

interface Opts {
  claim?: Partial<ExtractedClaim>;
  images?: string[];
  date?: string | null;
  sender?: string;
  policy?: Partial<PolicyConfig>;
  lookup?: EngineInput["lookup"];
  prior?: EngineInput["prior_claims"];
  shipment?: Partial<Shipment>;
  rawId?: string;
}

/** A well-formed damage claim on a found shipment, sent by the right customer on 2026-11-10 with 2 photos. */
function mk(id: string, o: Opts = {}): EngineInput {
  const base = SHIPMENTS[id];
  const shipment: Shipment | null = base ? { ...base, ...o.shipment } : null;
  const raw = o.rawId ?? id;
  const norm = normaliseShipmentId(raw);
  const lookup: EngineInput["lookup"] =
    o.lookup !== undefined ? o.lookup : shipment ? { status: "found", shipment } : { status: "not_found" };
  const sender = o.sender ?? (shipment ? SENDERS[shipment.customer] : "someone@example.com");
  return {
    is_claim: true,
    email: {
      date: o.date === undefined ? "2026-11-10" : o.date,
      sender_email: sender,
      sender_domain: sender.split("@")[1] ?? "",
      image_attachments: o.images ?? ["photo1.jpg", "photo2.jpg"],
    },
    claim: {
      shipment_id_raw: raw,
      claim_type: "damage",
      claimed_amount_inr: 10000,
      pieces_claimed_missing: null,
      summary: "Customer reports a problem with the shipment.",
      customer_states_no_photos: false,
      consequential_loss_mentioned: false,
      ...o.claim,
    },
    shipment_id_normalised: norm.id,
    shipment_id_corrected: norm.corrected,
    lookup,
    prior_claims: o.prior ?? { status: "ok", claims: [] },
    policy: { ...defaultPolicy, ...o.policy },
  };
}

/** Invariants that must hold for EVERY decision. */
function check(input: EngineInput): EngineDecision {
  const d = decide(input);
  expect(() => EngineDecisionSchema.parse(d)).not.toThrow();
  expect(Number.isInteger(d.approved_amount_inr)).toBe(true);
  expect(d.approved_amount_inr).toBeGreaterThanOrEqual(0);
  if (d.approved_amount_inr > 0) {
    expect(["approve", "escalate"]).toContain(d.decision);
    expect(input.lookup?.status).toBe("found");
    const claimed = input.claim?.claimed_amount_inr;
    const declared = input.lookup?.status === "found" ? input.lookup.shipment.declared_value_inr : 0;
    expect(claimed).not.toBeNull();
    expect(d.approved_amount_inr).toBeLessThanOrEqual(Math.min(claimed as number, declared));
  }
  if (d.decision === "approve") {
    expect(input.lookup?.status).toBe("found");
    expect(d.approved_amount_inr).toBeGreaterThan(0);
  }
  if (["reject", "need_info", "duplicate", "not_a_claim"].includes(d.decision)) {
    expect(d.approved_amount_inr).toBe(0);
  }
  if (d.decision === "need_info") expect(d.missing_info.length).toBeGreaterThan(0);
  else expect(d.missing_info).toEqual([]);
  if (d.decision !== "duplicate") expect(d.prior_claim).toBeNull();
  expect(d.rule_ids.length).toBeGreaterThan(0);
  expect(d.reason.length).toBeGreaterThan(0);
  expect(d.customer_reason.length).toBeGreaterThan(0);
  // customer-facing text: no rule ids, no rupee amounts
  expect(d.customer_reason).not.toMatch(/\bR\d[a-z]?\b/);
  expect(findInrAmounts(d.customer_reason)).toEqual([]);
  expect(d.customer_reason).not.toMatch(/\bRs\b|₹|INR/);
  // every main rule appears in the trace
  for (const r of ["R0", "R2", "R1", "R3", "R5", "R6", "R4", "R7", "R8b", "R8", "R9"]) {
    expect(d.trace.some((t) => t.rule === r || (r === "R2" && t.rule.startsWith("R2")))).toBe(true);
  }
  return d;
}

/* ----------------------------------------------------- normaliseShipmentId */

describe("normaliseShipmentId", () => {
  it.each([
    ["SHP-1O10", "SHP-1010", true],
    ["shp 1010", "SHP-1010", false],
    ["SHP1010", "SHP-1010", false],
    ["SHP-1010", "SHP-1010", false],
    ["SHP-0987", "SHP-0987", false],
    ["shp_1010", "SHP-1010", false],
    ["SHP – 1010", "SHP-1010", false],
    [" SHP-1010. ", "SHP-1010", false],
    ["shp-l0lo", "SHP-1010", true],
    ["SHP-I010", "SHP-1010", true],
    ["SHP-123456", "SHP-123456", false],
  ])("%s -> %s (corrected=%s)", (raw, id, corrected) => {
    expect(normaliseShipmentId(raw)).toEqual({ id, corrected });
  });

  it.each([["INV-22"], [""], ["SHP"], ["SHP-12"], ["SHP-1234567"], ["SHP-10X0"], ["1010"], ["shipment"]])(
    "%s -> null",
    (raw) => {
      expect(normaliseShipmentId(raw)).toEqual({ id: null, corrected: false });
    },
  );

  it("null / undefined -> null", () => {
    expect(normaliseShipmentId(null)).toEqual({ id: null, corrected: false });
    expect(normaliseShipmentId(undefined)).toEqual({ id: null, corrected: false });
  });
});

/* --------------------------------------------------- senderMatchesCustomer */

describe("senderMatchesCustomer", () => {
  it.each(Object.entries(SENDERS).map(([customer, sender]) => [sender, customer]))(
    "%s is %s",
    (sender, customer) => {
      expect(senderMatchesCustomer(sender, customer)).toBe(true);
    },
  );

  it.each([
    ["logistics@bluewave.co", "Apex Pharma"],
    ["randomguy@gmail.com", "Kirana Mart"],
    ["", "Apex Pharma"],
    ["not-an-email", "Apex Pharma"],
    ["ops@apexpharma.in", ""],
    ["ops@apexpharma.attacker.com", "Apex Pharma"], // customer name only in a sub-domain
    ["apexpharma@attacker.com", "Apex Pharma"], // mailbox name is not trusted on a company domain
    ["ops@orbit.in", "Orbit Auto Parts"], // prefix too short to be evidence
  ])("%s is NOT %s", (sender, customer) => {
    expect(senderMatchesCustomer(sender, customer)).toBe(false);
  });

  it("is case-insensitive and handles .co.in and yahoo.*", () => {
    expect(senderMatchesCustomer("OPS@ApexPharma.IN", "Apex Pharma")).toBe(true);
    expect(senderMatchesCustomer("ops@apexpharma.co.in", "Apex Pharma")).toBe(true);
    expect(senderMatchesCustomer("kirana.mart@yahoo.co.in", "Kirana Mart")).toBe(true);
  });
});

/* --------------------------------------------------- parsePodReceivedCount */

describe("parsePodReceivedCount", () => {
  it.each([
    ["37 pieces received", 40, 37],
    ["20 received", 25, 20],
    ["received 20", 25, 20],
    ["12 pieces received", 12, 12],
    ["3 short", 40, 37],
    ["short by 3", 40, 37],
    ["3 pieces short", 40, 37],
    ["POD: 5 short", 30, 25],
    ["Only 37 pcs received", 40, 37],
    ["37 of 40 received", 40, 37],
    ["37 pieces received, 3 short", 40, 37],
  ])("%s (shipped %i) -> %i", (remarks, shipped, expected) => {
    expect(parsePodReceivedCount(remarks, shipped)).toBe(expected);
  });

  it.each([
    ["1 box crushed"],
    ["2 cartons dented"],
    ["cartons wet"],
    [""],
    ["outer carton damaged"],
    ["scratches on 2 units"],
    ["2 rolls stained"],
    ["received 2 cartons dented"],
    ["2 units received damaged"],
    ["received in good condition"],
    ["37 pieces received, 5 short"], // contradictory -> a human checks
    ["50 short"], // more than shipped
  ])("%s -> null", (remarks) => {
    expect(parsePodReceivedCount(remarks, 40)).toBeNull();
  });
});

/* ------------------------------------------------------------------ golden */

describe("golden cases (email date 2026-11-10, default policy)", () => {
  it("C01 SHP-1001 damage 18000 with 2 photos -> approve 18000", () => {
    const d = check(mk("SHP-1001", { claim: { claimed_amount_inr: 18000 } }));
    expect(d.decision).toBe("approve");
    expect(d.approved_amount_inr).toBe(18000);
    expect(d.rule_ids).toEqual(["R9"]);
    expect(d.reason).toBe(
      "R3: filed 3 days after delivery (window 7). R4: photos attached (2 image files). R9: approve Rs 18,000.",
    );
    expect(d.required_reply_tokens).toEqual(["SHP-1001"]);
    expect(d.facts).toMatchObject({
      days_since_delivery: 3,
      window_days: 7,
      claimed_amount_inr: 18000,
      declared_value_inr: 60000,
      payable_inr: 18000,
      photos_present: true,
      photos_required: true,
      customer: "Apex Pharma",
      sender_matches_customer: true,
    });
  });

  it("C02 SHP-1002 filed 11 days after delivery -> reject", () => {
    const d = check(mk("SHP-1002", { claim: { claimed_amount_inr: 22000 } }));
    expect(d.decision).toBe("reject");
    expect(d.rule_ids).toEqual(["R3"]);
    expect(d.reason).toBe(
      "R3: filed 11 days after delivery (2026-10-30 -> 2026-11-10); window is 7 days -> reject.",
    );
    expect(d.customer_reason).toBe(
      "The claim was filed 11 days after delivery, which is outside our 7-day claims window.",
    );
    expect(d.facts.days_since_delivery).toBe(11);
  });

  it("C03 SHP-1003 Zenith shortage, POD 37 of 40 -> approve 9000 on the key-account window", () => {
    const d = check(mk("SHP-1003", { claim: { claim_type: "shortage", claimed_amount_inr: 9000 }, images: [] }));
    expect(d.decision).toBe("approve");
    expect(d.approved_amount_inr).toBe(9000);
    expect(d.rule_ids).toEqual(["R3", "R9"]);
    expect(d.reason).toContain("R3: filed 12 days after delivery (key-account window 15 for Zenith Retail).");
    expect(d.reason).toContain("R6: POD shows 37 of 40 pieces received (3 short).");
    expect(d.facts).toMatchObject({
      days_since_delivery: 12,
      window_days: 15,
      pod_received_count: 37,
      pod_missing: 3,
      photos_required: false,
    });
  });

  it("C04 SHP-1004 damage 3200 without images -> need_info photos", () => {
    const d = check(mk("SHP-1004", { claim: { claimed_amount_inr: 3200 }, images: [] }));
    expect(d.decision).toBe("need_info");
    expect(d.missing_info).toEqual(["photos"]);
    expect(d.rule_ids).toEqual(["R4"]);
    expect(d.facts.photos_present).toBe(false);
  });

  it("C06 SHP-1006 damage 95000 (declared 72000) with consequential loss -> escalate 72000", () => {
    const d = check(
      mk("SHP-1006", { claim: { claimed_amount_inr: 95000, consequential_loss_mentioned: true } }),
    );
    expect(d.decision).toBe("escalate");
    expect(d.approved_amount_inr).toBe(72000);
    expect(d.rule_ids).toEqual(["R7", "R8b", "R8"]);
    expect(d.reason).toContain("R7: claimed Rs 95,000 capped at declared value Rs 72,000.");
    expect(d.reason).toContain("R8b: claim includes consequential loss");
    expect(d.reason).toContain(
      "R8: payable Rs 72,000 exceeds the Rs 50,000 approval limit - Claims Manager approval required (recommended Rs 72,000).",
    );
    expect(d.customer_reason).toContain("Claims Manager");
  });

  it("C07 SHP-1007 damage with a clean POD -> reject", () => {
    const d = check(mk("SHP-1007", { claim: { claimed_amount_inr: 8000 } }));
    expect(d.decision).toBe("reject");
    expect(d.rule_ids).toEqual(["R5"]);
  });

  it("C08 SHP-0987 with prior claim C-0931 -> duplicate 0", () => {
    const d = check(
      mk("SHP-0987", { claim: { claimed_amount_inr: 6500 }, prior: { status: "ok", claims: [PRIOR_C0931] } }),
    );
    expect(d.decision).toBe("duplicate");
    expect(d.approved_amount_inr).toBe(0);
    expect(d.rule_ids).toEqual(["R1"]);
    expect(d.reason).toContain("R1: duplicate of C-0931 (approve, paid 2026-10-20, ref PAY-7781)");
    expect(d.prior_claim).toEqual(PRIOR_C0931);
    expect(d.required_reply_tokens).toEqual(["SHP-0987", "C-0931", "PAY-7781"]);
    for (const token of d.required_reply_tokens.slice(1)) expect(d.customer_reason).toContain(token);
  });

  it("C09 SHP-1009 shortage 7500, POD 20 of 25 -> approve 7500", () => {
    const d = check(mk("SHP-1009", { claim: { claim_type: "shortage", claimed_amount_inr: 7500 }, images: [] }));
    expect(d.decision).toBe("approve");
    expect(d.approved_amount_inr).toBe(7500);
    expect(d.rule_ids).toEqual(["R9"]);
    expect(d.facts).toMatchObject({ pod_received_count: 20, pod_missing: 5 });
  });

  it("C10 corrected id SHP-1O10 from orders@metrohardware.in -> approve 4000", () => {
    const d = check(mk("SHP-1010", { rawId: "SHP-1O10", claim: { claimed_amount_inr: 4000 } }));
    expect(d.decision).toBe("approve");
    expect(d.approved_amount_inr).toBe(4000);
    expect(d.rule_ids).toEqual(["R2", "R9"]);
    expect(d.reason).toContain('R2: id "SHP-1O10" normalised to SHP-1010; sender matches Metro Hardware.');
    expect(d.required_reply_tokens).toEqual(["SHP-1010"]);
  });

  it("C11 SHP-1011 shortage, POD confirms 12 of 12 -> reject", () => {
    const d = check(mk("SHP-1011", { claim: { claim_type: "shortage", claimed_amount_inr: 15000 }, images: [] }));
    expect(d.decision).toBe("reject");
    expect(d.rule_ids).toEqual(["R6"]);
    expect(d.facts.pod_received_count).toBe(12);
  });

  it("C12 SHP-1012 filed 8 days after delivery -> reject", () => {
    const d = check(mk("SHP-1012", { claim: { claimed_amount_inr: 5000 } }));
    expect(d.decision).toBe("reject");
    expect(d.rule_ids).toEqual(["R3"]);
    expect(d.facts.days_since_delivery).toBe(8);
    expect(d.customer_reason).toContain("8 days");
  });

  it("C13 SHP-1013 damage 58000 (declared 120000) -> escalate 58000", () => {
    const d = check(mk("SHP-1013", { claim: { claimed_amount_inr: 58000 } }));
    expect(d.decision).toBe("escalate");
    expect(d.approved_amount_inr).toBe(58000);
    expect(d.rule_ids).toEqual(["R8"]);
    expect(d.customer_reason).toBe(
      "Claims of this value need approval from our Claims Manager, so your claim has been forwarded for review.",
    );
  });

  it("C14 SHP-1014 -> approve 6000; SHP-1015 with customer_states_no_photos -> need_info", () => {
    const a = check(mk("SHP-1014", { claim: { claimed_amount_inr: 6000 } }));
    expect(a.decision).toBe("approve");
    expect(a.approved_amount_inr).toBe(6000);

    const b = check(mk("SHP-1015", { claim: { claimed_amount_inr: 4500, customer_states_no_photos: true } }));
    expect(b.decision).toBe("need_info");
    expect(b.missing_info).toEqual(["photos"]);
    expect(b.facts.photos_present).toBe(false);
  });

  it("C15 not a claim -> not_a_claim 0", () => {
    const input: EngineInput = {
      ...mk("SHP-1001"),
      is_claim: false,
      claim: null,
      shipment_id_normalised: null,
      shipment_id_corrected: false,
      lookup: null,
    };
    const d = check(input);
    expect(d.decision).toBe("not_a_claim");
    expect(d.rule_ids).toEqual(["R0"]);
    expect(d.required_reply_tokens).toEqual([]);
  });
});

/* ---------------------------------------------------------- policy variants */

describe("policy variants", () => {
  it("smallClaimPhotoWaiverInr=5000: C04 approves 3200, SHP-1015 approves 4500", () => {
    const policy = { smallClaimPhotoWaiverInr: 5000 };
    const c04 = check(mk("SHP-1004", { claim: { claimed_amount_inr: 3200 }, images: [], policy }));
    expect(c04.decision).toBe("approve");
    expect(c04.approved_amount_inr).toBe(3200);
    expect(c04.rule_ids).toEqual(["R4", "R9"]);
    expect(c04.reason).toContain("R4: photo requirement waived for small claim");
    expect(c04.facts.photos_required).toBe(false);

    const c14b = check(
      mk("SHP-1015", { claim: { claimed_amount_inr: 4500, customer_states_no_photos: true }, policy }),
    );
    expect(c14b.decision).toBe("approve");
    expect(c14b.approved_amount_inr).toBe(4500);
  });

  it("waiver boundary: exactly at the waiver passes, 1 rupee over still needs photos", () => {
    const policy = { smallClaimPhotoWaiverInr: 5000 };
    expect(check(mk("SHP-1004", { claim: { claimed_amount_inr: 5000 }, images: [], policy })).decision).toBe("approve");
    expect(check(mk("SHP-1004", { claim: { claimed_amount_inr: 5001 }, images: [], policy })).decision).toBe("need_info");
  });

  it("shortageProRata=true: C03 pays 3600, C09 pays 6000", () => {
    const policy = { shortageProRata: true };
    const c03 = check(mk("SHP-1003", { claim: { claim_type: "shortage", claimed_amount_inr: 9000 }, images: [], policy }));
    expect(c03.decision).toBe("approve");
    expect(c03.approved_amount_inr).toBe(3600);
    expect(c03.rule_ids).toEqual(["R3", "R7", "R9"]);
    expect(c03.reason).toContain("capped pro-rata at Rs 3,600");

    const c09 = check(mk("SHP-1009", { claim: { claim_type: "shortage", claimed_amount_inr: 7500 }, images: [], policy }));
    expect(c09.decision).toBe("approve");
    expect(c09.approved_amount_inr).toBe(6000);
  });

  it("shortageProRata does not raise a claim that is already below the pro-rata value", () => {
    const d = check(
      mk("SHP-1009", { claim: { claim_type: "shortage", claimed_amount_inr: 2000 }, images: [], policy: { shortageProRata: true } }),
    );
    expect(d.approved_amount_inr).toBe(2000);
    expect(d.rule_ids).toEqual(["R9"]);
  });

  it("payConsequentialLoss=true: consequential loss alone does not escalate", () => {
    const d = check(
      mk("SHP-1001", {
        claim: { claimed_amount_inr: 18000, consequential_loss_mentioned: true },
        policy: { payConsequentialLoss: true },
      }),
    );
    expect(d.decision).toBe("approve");
  });
});

/* ------------------------------------------------------------- boundaries */

describe("R3 time limit", () => {
  it("day 7 of 7 passes, day 8 rejects", () => {
    // SHP-1001 delivered 2026-11-07
    expect(check(mk("SHP-1001", { date: "2026-11-14" })).decision).toBe("approve");
    const late = check(mk("SHP-1001", { date: "2026-11-15" }));
    expect(late.decision).toBe("reject");
    expect(late.facts.days_since_delivery).toBe(8);
  });

  it("day 0 (same day as delivery) passes", () => {
    expect(check(mk("SHP-1001", { date: "2026-11-07" })).decision).toBe("approve");
  });

  it("key account: day 15 passes, day 16 rejects", () => {
    // SHP-1013 Zenith Retail delivered 2026-11-06, declared 120000
    const ok = check(mk("SHP-1013", { date: "2026-11-21", claim: { claimed_amount_inr: 20000 } }));
    expect(ok.decision).toBe("approve");
    expect(ok.rule_ids).toEqual(["R3", "R9"]);
    const late = check(mk("SHP-1013", { date: "2026-11-22", claim: { claimed_amount_inr: 20000 } }));
    expect(late.decision).toBe("reject");
    expect(late.rule_ids).toEqual(["R3"]);
    expect(late.customer_reason).toContain("15-day");
  });

  it("key-account name match is case-insensitive", () => {
    const d = check(
      mk("SHP-1003", {
        claim: { claim_type: "shortage", claimed_amount_inr: 9000 },
        policy: { keyAccountWindows: { "ZENITH retail": 15 } },
      }),
    );
    expect(d.decision).toBe("approve");
    expect(d.facts.window_days).toBe(15);
  });

  it("null email date -> escalate 0 (never guesses with the system clock)", () => {
    const d = check(mk("SHP-1001", { date: null }));
    expect(d.decision).toBe("escalate");
    expect(d.approved_amount_inr).toBe(0);
    expect(d.rule_ids).toEqual(["R3"]);
    expect(d.facts.days_since_delivery).toBeNull();
  });

  it("email dated before delivery -> escalate 0", () => {
    const d = check(mk("SHP-1001", { date: "2026-11-05" }));
    expect(d.decision).toBe("escalate");
    expect(d.approved_amount_inr).toBe(0);
    expect(d.facts.days_since_delivery).toBe(-2);
  });
});

describe("R7 cap / R8 approval limit", () => {
  it("exactly 50,000 approves; 50,001 escalates", () => {
    const at = check(mk("SHP-1013", { claim: { claimed_amount_inr: 50000 } }));
    expect(at.decision).toBe("approve");
    expect(at.approved_amount_inr).toBe(50000);
    const over = check(mk("SHP-1013", { claim: { claimed_amount_inr: 50001 } }));
    expect(over.decision).toBe("escalate");
    expect(over.approved_amount_inr).toBe(50001);
    expect(over.rule_ids).toEqual(["R8"]);
  });

  it("claimed > declared is capped at declared value and approved when under the limit", () => {
    // SHP-1015 declared 22000
    const d = check(mk("SHP-1015", { claim: { claimed_amount_inr: 30000 } }));
    expect(d.decision).toBe("approve");
    expect(d.approved_amount_inr).toBe(22000);
    expect(d.rule_ids).toEqual(["R7", "R9"]);
    expect(d.reason).toContain("R7: claimed Rs 30,000 capped at declared value Rs 22,000.");
    expect(d.customer_reason).toContain("the payable amount is limited to the declared value of the shipment");
  });

  it("the cap is applied before the approval limit (claimed 60000, declared 40000 -> approve 40000)", () => {
    const d = check(mk("SHP-1014", { claim: { claimed_amount_inr: 60000 } }));
    expect(d.decision).toBe("approve");
    expect(d.approved_amount_inr).toBe(40000);
  });

  it("consequential loss under the limit escalates with the payable as upper bound (R8b only)", () => {
    const d = check(mk("SHP-1001", { claim: { claimed_amount_inr: 18000, consequential_loss_mentioned: true } }));
    expect(d.decision).toBe("escalate");
    expect(d.approved_amount_inr).toBe(18000);
    expect(d.rule_ids).toEqual(["R8b"]);
  });

  it("fractional claimed amounts are floored to whole rupees", () => {
    const d = check(mk("SHP-1001", { claim: { claimed_amount_inr: 4500.75 } }));
    expect(d.decision).toBe("approve");
    expect(d.approved_amount_inr).toBe(4500);
  });

  it("declared value 0 -> escalate 0, never approve", () => {
    const d = check(mk("SHP-1001", { shipment: { declared_value_inr: 0 } }));
    expect(d.decision).toBe("escalate");
    expect(d.approved_amount_inr).toBe(0);
  });

  it("missing amount -> need_info claim_amount", () => {
    const d = check(mk("SHP-1001", { claim: { claimed_amount_inr: null } }));
    expect(d.decision).toBe("need_info");
    expect(d.missing_info).toEqual(["claim_amount"]);
    expect(d.rule_ids).toEqual(["R7"]);
  });

  it("zero amount is treated as missing", () => {
    const d = check(mk("SHP-1001", { claim: { claimed_amount_inr: 0 } }));
    expect(d.decision).toBe("need_info");
    expect(d.missing_info).toEqual(["claim_amount"]);
  });

  it("photos AND amount missing -> ONE need_info listing both", () => {
    const d = check(mk("SHP-1001", { claim: { claimed_amount_inr: null }, images: [] }));
    expect(d.decision).toBe("need_info");
    expect(d.missing_info).toEqual(["photos", "claim_amount"]);
    expect(d.rule_ids).toEqual(["R4", "R7"]);
  });

  it("small-claim waiver cannot apply when the amount is unknown", () => {
    const d = check(
      mk("SHP-1001", { claim: { claimed_amount_inr: null }, images: [], policy: { smallClaimPhotoWaiverInr: 5000 } }),
    );
    expect(d.missing_info).toEqual(["photos", "claim_amount"]);
  });
});

describe("R4 photos", () => {
  it("PDF-only attachments (no image files) -> need_info photos", () => {
    const d = check(mk("SHP-1001", { images: [] }));
    expect(d.decision).toBe("need_info");
    expect(d.missing_info).toEqual(["photos"]);
  });

  it("shortage claims never need photos", () => {
    const d = check(mk("SHP-1009", { claim: { claim_type: "shortage", claimed_amount_inr: 7500, customer_states_no_photos: true }, images: [] }));
    expect(d.decision).toBe("approve");
  });
});

describe("R5 / R6 proof of delivery", () => {
  it("damage on a good-condition POD whose only remark is a piece count -> reject", () => {
    const d = check(mk("SHP-1011", { claim: { claimed_amount_inr: 15000 } }));
    expect(d.decision).toBe("reject");
    expect(d.rule_ids).toEqual(["R5"]);
  });

  it("damage on a good-condition POD that still carries a damage remark passes R5", () => {
    const d = check(mk("SHP-1007", { shipment: { pod_remarks: "2 cartons wet" }, claim: { claimed_amount_inr: 8000 } }));
    expect(d.decision).toBe("approve");
  });

  it("shortage on a clean POD (good condition, no remarks) -> reject", () => {
    const d = check(mk("SHP-1016", { claim: { claim_type: "shortage", claimed_amount_inr: 4000 }, images: [] }));
    expect(d.decision).toBe("reject");
    expect(d.rule_ids).toEqual(["R6"]);
  });

  it("shortage where the POD has remarks but no piece count -> escalate 0 for a manual check", () => {
    const d = check(mk("SHP-1001", { claim: { claim_type: "shortage", claimed_amount_inr: 4000 }, images: [] }));
    expect(d.decision).toBe("escalate");
    expect(d.approved_amount_inr).toBe(0);
    expect(d.rule_ids).toEqual(["R6"]);
  });

  it("the customer's own missing-piece count is never used as evidence", () => {
    const d = check(
      mk("SHP-1011", { claim: { claim_type: "shortage", claimed_amount_inr: 15000, pieces_claimed_missing: 4 }, images: [] }),
    );
    expect(d.decision).toBe("reject");
  });
});

describe("R2 shipment lookup and sender", () => {
  it("no usable id -> need_info shipment_id", () => {
    const d = check({ ...mk("SHP-1001", { rawId: "INV-22" }), lookup: null });
    expect(d.decision).toBe("need_info");
    expect(d.missing_info).toEqual(["shipment_id"]);
    expect(d.rule_ids).toEqual(["R2"]);
  });

  it("no id at all -> need_info shipment_id", () => {
    const input = mk("SHP-1001");
    const d = check({
      ...input,
      claim: { ...input.claim!, shipment_id_raw: null },
      shipment_id_normalised: null,
      lookup: null,
    });
    expect(d.decision).toBe("need_info");
    expect(d.missing_info).toEqual(["shipment_id"]);
    expect(d.required_reply_tokens).toEqual([]);
  });

  it("lookup error -> escalate 0 and says 'lookup failed'", () => {
    const d = check(mk("SHP-1001", { lookup: { status: "error", error: "timeout" } }));
    expect(d.decision).toBe("escalate");
    expect(d.approved_amount_inr).toBe(0);
    expect(d.rule_ids).toEqual(["R2"]);
    expect(d.reason).toContain("lookup failed");
    expect(d.reason).toContain("never approved without a successful shipment lookup");
    expect(d.required_reply_tokens).toEqual(["SHP-1001"]);
  });

  it("tool errors that already start with 'lookup failed' are not repeated", () => {
    const d = check(mk("SHP-1001", { lookup: { status: "error", error: "lookup failed: timeout after 30ms" } }));
    expect(d.decision).toBe("escalate");
    expect(d.reason).toBe(
      "R2: shipment lookup failed for SHP-1001 (timeout after 30ms); a claim is never approved without a successful shipment lookup -> escalate.",
    );
  });

  it("lookup null with a usable id -> escalate 0 and says 'lookup failed'", () => {
    const d = check(mk("SHP-1001", { lookup: null }));
    expect(d.decision).toBe("escalate");
    expect(d.approved_amount_inr).toBe(0);
    expect(d.reason).toContain("lookup failed");
  });

  it("lookup not_found -> need_info shipment_id", () => {
    const d = check(mk("SHP-1008", { claim: { claimed_amount_inr: 9000 } }));
    expect(d.decision).toBe("need_info");
    expect(d.missing_info).toEqual(["shipment_id"]);
    expect(d.reason).toContain("shipment not found");
    expect(d.required_reply_tokens).toEqual(["SHP-1008"]);
  });

  it("sender mismatch on an exact id -> need_info sender_verification, other customer not revealed", () => {
    const d = check(mk("SHP-1002", { sender: "ops@apexpharma.in", date: "2026-11-01" }));
    expect(d.decision).toBe("need_info");
    expect(d.missing_info).toEqual(["sender_verification"]);
    expect(d.rule_ids).toEqual(["R2"]);
    expect(d.reason).toContain("registered to a different customer");
    expect(d.customer_reason).not.toMatch(/bluewave/i);
    expect(d.facts.sender_matches_customer).toBe(false);
  });

  it("sender mismatch on a corrected id -> fuzzy match not accepted", () => {
    const d = check(mk("SHP-1010", { rawId: "SHP-1O10", sender: "randomguy@gmail.com" }));
    expect(d.decision).toBe("need_info");
    expect(d.missing_info).toEqual(["sender_verification"]);
    expect(d.reason).toContain("fuzzy match was not accepted");
    expect(d.customer_reason).not.toMatch(/metro/i);
  });

  it("empty sender never matches", () => {
    const d = check(mk("SHP-1001", { sender: "" }));
    expect(d.decision).toBe("need_info");
    expect(d.missing_info).toEqual(["sender_verification"]);
  });

  it("is_claim=true with no extracted claim -> escalate 0", () => {
    const d = check({ ...mk("SHP-1001"), claim: null });
    expect(d.decision).toBe("escalate");
    expect(d.approved_amount_inr).toBe(0);
  });
});

describe("R1 duplicates", () => {
  it("prior-claims lookup error -> escalate 0 (cannot rule out a duplicate)", () => {
    const d = check(mk("SHP-1001", { prior: { status: "error", error: "timeout" } }));
    expect(d.decision).toBe("escalate");
    expect(d.approved_amount_inr).toBe(0);
    expect(d.rule_ids).toEqual(["R1"]);
  });

  it("prefers the prior claim that carries a payment reference", () => {
    const unpaid: PriorClaim = { ...PRIOR_C0931, source: "state", claim_id: "C03", payment_ref: null, paid_date: null };
    const d = check(mk("SHP-0987", { prior: { status: "ok", claims: [unpaid, PRIOR_C0931] } }));
    expect(d.decision).toBe("duplicate");
    expect(d.prior_claim?.claim_id).toBe("C-0931");
  });

  it("a prior claim without a payment ref -> tokens are shipment id and claim id only", () => {
    const rejected: PriorClaim = {
      ...PRIOR_C0931,
      source: "state",
      claim_id: "C02",
      decision: "reject",
      approved_amount_inr: 0,
      payment_ref: null,
      paid_date: null,
    };
    const d = check(mk("SHP-1001", { prior: { status: "ok", claims: [rejected] } }));
    expect(d.decision).toBe("duplicate");
    expect(d.required_reply_tokens).toEqual(["SHP-1001", "C02"]);
  });

  it("duplicate is detected before the time limit (SHP-0987 is 33 days old)", () => {
    const d = check(mk("SHP-0987", { prior: { status: "ok", claims: [PRIOR_C0931] } }));
    expect(d.decision).toBe("duplicate");
    expect(d.rule_ids).toEqual(["R1"]);
  });
});

/* ------------------------------------------------------------ determinism */

describe("purity", () => {
  const inputs: EngineInput[] = [
    mk("SHP-1001", { claim: { claimed_amount_inr: 18000 } }),
    mk("SHP-1006", { claim: { claimed_amount_inr: 95000, consequential_loss_mentioned: true } }),
    mk("SHP-0987", { prior: { status: "ok", claims: [PRIOR_C0931] } }),
    mk("SHP-1003", { claim: { claim_type: "shortage", claimed_amount_inr: 9000 }, policy: { shortageProRata: true } }),
    mk("SHP-1001", { lookup: { status: "error", error: "timeout" } }),
  ];

  it("same input twice deep-equals", () => {
    for (const input of inputs) {
      expect(decide(input)).toEqual(decide(structuredClone(input)));
      expect(JSON.stringify(decide(input))).toBe(JSON.stringify(decide(input)));
    }
  });

  it("does not mutate its input", () => {
    for (const input of inputs) {
      const before = JSON.stringify(input);
      const d = decide(input);
      d.rule_ids.push("X");
      d.required_reply_tokens.push("X");
      if (d.prior_claim) d.prior_claim.claim_id = "X";
      expect(JSON.stringify(input)).toBe(before);
    }
  });
});
