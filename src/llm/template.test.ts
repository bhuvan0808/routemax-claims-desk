import { describe, expect, it } from "vitest";
import { findInrAmounts } from "../format";
import type { Decision, DraftInput, Language } from "../types";
import { createDrafter, renderTemplateReply, validateDraft } from "./index";

const PRIOR = {
  source: "past_decisions" as const,
  claim_id: "C-0931",
  shipment_id: "SHP-0987",
  decision: "approve" as const,
  approved_amount_inr: 6500,
  decided_date: "2026-10-18",
  payment_ref: "PAY-7781",
  paid_date: "2026-10-20",
  notes: null,
};

function input(decision: Decision, language: Language = "en", over: Partial<DraftInput> = {}): DraftInput {
  const base: DraftInput = {
    claim_id: "C01",
    shipment_id: "SHP-1001",
    decision,
    approved_amount_inr: decision === "approve" ? 18000 : decision === "escalate" ? 60000 : 0,
    customer_reason: "The claim was checked against the delivery record for this shipment.",
    required_reply_tokens: ["SHP-1001"],
    missing_info: decision === "need_info" ? ["photos", "claim_amount"] : [],
    language,
    customer_name: "Deepa",
    claim_type: "damage",
    prior_claim: null,
  };
  if (decision === "duplicate") {
    base.shipment_id = "SHP-0987";
    base.prior_claim = PRIOR;
    base.required_reply_tokens = ["SHP-0987", "C-0931", "PAY-7781"];
  }
  return { ...base, ...over };
}

const DECISIONS: Decision[] = ["approve", "reject", "need_info", "escalate", "duplicate", "not_a_claim"];
const LANGS: Language[] = ["en", "hinglish"];

describe("renderTemplateReply", () => {
  for (const lang of LANGS) {
    for (const decision of DECISIONS) {
      it(`${decision} / ${lang} passes validateDraft and follows the amount rule`, () => {
        const inp = input(decision, lang);
        const text = renderTemplateReply(inp);
        expect(validateDraft(text, inp)).toEqual({ ok: true, problems: [] });
        expect(text).toContain("RouteMax Claims Desk");
        expect(text).toContain(inp.shipment_id);
        expect(text).toContain(inp.customer_reason);
        expect(text.toLowerCase()).toContain("subject to review");
        expect(findInrAmounts(text)).toEqual(decision === "approve" ? [18000] : []);
        expect(renderTemplateReply(inp)).toBe(text); // deterministic
      });
    }
  }

  it("approve states exactly the formatted approved amount", () => {
    expect(renderTemplateReply(input("approve", "en", { approved_amount_inr: 120000 }))).toContain("Rs 1,20,000");
  });

  it("escalate names the Claims Manager, with no amount and no payment promise", () => {
    const text = renderTemplateReply(input("escalate"));
    expect(text).toMatch(/forwarded to the Claims Manager for review/);
    expect(text).not.toMatch(/Rs|60,000|will be paid/);
  });

  it("need_info lists what is needed", () => {
    const text = renderTemplateReply(input("need_info"));
    expect(text).toMatch(/photos/);
    expect(text).toMatch(/amount you are claiming/);
  });

  it("duplicate cites the earlier claim, its decision, paid date and payment ref", () => {
    for (const lang of LANGS) {
      const text = renderTemplateReply(input("duplicate", lang));
      expect(text).toContain("C-0931");
      expect(text).toContain("2026-10-20");
      expect(text).toContain("PAY-7781");
      expect(text).toMatch(/approve/i);
    }
  });

  it("appends required tokens that the wording did not already contain", () => {
    const inp = input("reject", "en", { required_reply_tokens: ["SHP-1001", "REF-42", "7"] });
    const text = renderTemplateReply(inp);
    expect(text).toContain("REF-42");
    expect(validateDraft(text, inp).ok).toBe(true);
    expect(text.trimEnd().endsWith("RouteMax Claims Desk")).toBe(true);
  });

  it("works with no shipment id, no name, no claim type; hi/other fall back to English", () => {
    for (const lang of ["hi", "other"] as Language[]) {
      const inp = input("not_a_claim", lang, { shipment_id: "", customer_name: null, claim_type: null, required_reply_tokens: [] });
      const text = renderTemplateReply(inp);
      expect(text).toMatch(/^Dear Customer,/);
      expect(validateDraft(text, inp).ok).toBe(true);
    }
  });

  it("mock drafter returns the template", async () => {
    const d = createDrafter({ mode: "mock" });
    expect(d.mode).toBe("mock");
    expect(await d.draft(input("approve"))).toBe(renderTemplateReply(input("approve")));
  });
});

describe("validateDraft rejects", () => {
  const sign = "\nThis is subject to review.\nRouteMax Claims Desk";

  it("empty and over-long drafts", () => {
    expect(validateDraft("  ", input("approve")).ok).toBe(false);
    expect(validateDraft("approved Rs 18,000 SHP-1001 " + "x".repeat(2600), input("approve")).ok).toBe(false);
  });

  it("wrong amount on approve", () => {
    const r = validateDraft(`Your claim on SHP-1001 is approved for Rs 81,000.${sign}`, input("approve"));
    expect(r.ok).toBe(false);
    expect(r.problems.join(" ")).toMatch(/Rs 18,000/);
  });

  it("extra amount on approve", () => {
    const r = validateDraft(
      `Your claim on SHP-1001 is approved for Rs 18,000 against the Rs 25,000 you claimed.${sign}`,
      input("approve"),
    );
    expect(r.ok).toBe(false);
    expect(r.problems.join(" ")).toMatch(/other than the approved amount/);
  });

  it("any rupee amount on a non-approve decision", () => {
    for (const d of ["reject", "need_info", "escalate", "duplicate", "not_a_claim"] as Decision[]) {
      const inp = input(d);
      const r = validateDraft(renderTemplateReply(inp) + "\nPS: the amount was Rs 60,000.", inp);
      expect(r.ok).toBe(false);
    }
  });

  it("missing required token", () => {
    const r = validateDraft(`Your claim is approved for Rs 18,000.${sign}`, input("approve"));
    expect(r.ok).toBe(false);
    expect(r.problems.join(" ")).toMatch(/SHP-1001/);
  });

  it("payment promise on reject", () => {
    const r = validateDraft(
      `We have rejected the claim on SHP-1001, but the amount will be paid next week.${sign}`,
      input("reject"),
    );
    expect(r.ok).toBe(false);
    expect(r.problems.join(" ")).toMatch(/promises a payment/);
  });

  it("missing decision marker", () => {
    const r = validateDraft(`We looked at your message about SHP-1001. Have a nice day.${sign}`, input("reject"));
    expect(r.ok).toBe(false);
    expect(r.problems.join(" ")).toMatch(/does not clearly state the decision/);
  });

  it("a reply that says approved when the decision is escalate", () => {
    const r = validateDraft(
      `Your claim on SHP-1001 has been approved and sent to the manager.${sign}`,
      input("escalate"),
    );
    expect(r.ok).toBe(false);
  });

  it("an English reply to a Hinglish customer", () => {
    const r = validateDraft(renderTemplateReply(input("reject", "en")), input("reject", "hinglish"));
    expect(r.ok).toBe(false);
  });

  it("duplicate may say the EARLIER claim was approved and paid", () => {
    const inp = input("duplicate");
    const text = `Dear Deepa,\nThis is a duplicate. Claim C-0931 on SHP-0987 was already approved and paid on 2026-10-20 (PAY-7781).${sign}`;
    expect(validateDraft(text, inp)).toEqual({ ok: true, problems: [] });
  });
});
