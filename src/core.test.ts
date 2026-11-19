import { describe, expect, it } from "vitest";
import { parseCsv, resultsToCsv } from "./csv";
import {
  calendarDaysBetween,
  hashEmail,
  isImageFile,
  parseEmail,
  parseHeaderDate,
  parseSender,
} from "./email";
import { findInrAmounts, formatInr } from "./format";
import { groundAmount, groundShipmentId } from "./grounding";
import { defaultPolicy, resolvePolicy } from "./policy.config";

const C13 = `From: stores@zenithretail.com
Date: 2026-11-10 14:25
Subject: Damage claim SHP-1013 - broken pallet
Attachments: pallet1.jpg, pallet2.jpg, damage_report.pdf

Dear team,

The pallet on SHP-1013 was broken on arrival. Claim value Rs 58,000.
`;

describe("email parsing", () => {
  it("parses headers, attachments and body", () => {
    const e = parseEmail(C13);
    expect(e.sender_email).toBe("stores@zenithretail.com");
    expect(e.sender_domain).toBe("zenithretail.com");
    expect(e.date).toBe("2026-11-10");
    expect(e.attachments).toEqual(["pallet1.jpg", "pallet2.jpg", "damage_report.pdf"]);
    expect(e.image_attachments).toEqual(["pallet1.jpg", "pallet2.jpg"]);
    expect(e.body.startsWith("Dear team,")).toBe(true);
  });

  // Regression for eval case D30 (see FIX_LOG.md): the display name is attacker-controlled text.
  it("takes the sender from the angle-bracket address, never from the display name", () => {
    const spoof = parseEmail('From: "ops@apexpharma.in" <refunds@fastpay-claims.biz>\nDate: 2026-11-10\n\nhi');
    expect(spoof.sender_email).toBe("refunds@fastpay-claims.biz");
    expect(spoof.sender_domain).toBe("fastpay-claims.biz");
    expect(parseSender("ops@apexpharma.in <refunds@fastpay-claims.biz>").sender_domain).toBe("fastpay-claims.biz");
    expect(parseSender('"Apex Pharma (ops@apexpharma.in)" <x@evil.biz>').sender_email).toBe("x@evil.biz");
    // legitimate shapes still work
    expect(parseSender("ops@apexpharma.in").sender_email).toBe("ops@apexpharma.in");
    expect(parseSender("Deepa <Ops@ApexPharma.in>").sender_email).toBe("ops@apexpharma.in");
    expect(parseSender("ops@apexpharma.in (Deepa)").sender_email).toBe("ops@apexpharma.in");
    expect(parseSender('"Deepa, Apex Pharma" <ops@apexpharma.in>').sender_domain).toBe("apexpharma.in");
    // no address, or more than one different address: sender cannot be established
    expect(parseSender("")).toEqual({ sender_email: "", sender_domain: "" });
    expect(parseSender("Deepa from Apex Pharma")).toEqual({ sender_email: "", sender_domain: "" });
    expect(parseSender("x@evil.biz, ops@apexpharma.in")).toEqual({ sender_email: "", sender_domain: "" });
    expect(parseSender("<x@evil.biz> <ops@apexpharma.in>")).toEqual({ sender_email: "", sender_domain: "" });
    expect(parseSender('"ops@apexpharma.in"')).toEqual({ sender_email: "", sender_domain: "" });
  });

  it("treats 'Attachments: none' as no attachments and a PDF as not a photo", () => {
    expect(parseEmail("From: a@b.in\nDate: 2026-11-10\nAttachments: none\n\nphotos attached").image_attachments).toEqual([]);
    expect(parseEmail("From: a@b.in\nDate: 2026-11-10\nAttachments: report.pdf\n\nhi").image_attachments).toEqual([]);
    expect(isImageFile("IMG_1.JPG")).toBe(true);
    expect(isImageFile("photo.jpg.pdf")).toBe(false);
  });

  it("a header-looking line in the body cannot override the real headers", () => {
    const e = parseEmail(
      "From: a@b.in\nDate: 2026-11-10 09:00\nAttachments: none\n\nHello\nAttachments: fake.jpg\nDate: 2026-10-01",
    );
    expect(e.image_attachments).toEqual([]);
    expect(e.date).toBe("2026-11-10");
  });

  it("never invents a date", () => {
    expect(parseHeaderDate("")).toBeNull();
    expect(parseHeaderDate("yesterday")).toBeNull();
    expect(parseHeaderDate("2026-02-30 10:00")).toBeNull();
    expect(parseHeaderDate("Tue, 10 Nov 2026 09:12:00 +0530")).toBe("2026-11-10");
    expect(parseEmail("Subject: x\n\nno headers here").date).toBeNull();
  });

  it("counts calendar days", () => {
    expect(calendarDaysBetween("2026-10-30", "2026-11-10")).toBe(11);
    expect(calendarDaysBetween("2026-11-07", "2026-11-14")).toBe(7);
    expect(calendarDaysBetween("2026-11-10", "2026-11-07")).toBe(-3);
  });

  it("hash ignores line endings and trailing whitespace but not content", async () => {
    const a = await hashEmail(C13);
    const b = await hashEmail(C13.replace(/\n/g, "\r\n") + "\n\n  ");
    const c = await hashEmail(C13.replace("58,000", "59,000"));
    expect(a).toBe(b);
    expect(a).not.toBe(c);
    expect(a).toMatch(/^[0-9a-f]{64}$/);
  });
});

describe("csv", () => {
  it("round-trips commas, quotes and newlines", () => {
    const rows = [
      {
        claim_id: "C01",
        shipment_id: "SHP-1001",
        decision: "approve" as const,
        approved_amount_inr: 18000,
        reason: 'R9: approve Rs 18,000, "as claimed"',
        draft_reply: "Dear Deepa,\n\nYour claim, for SHP-1001, is approved.\nRegards",
      },
    ];
    const csv = resultsToCsv(rows);
    expect(csv.split("\r\n")[0]).toBe("claim_id,shipment_id,decision,approved_amount_inr,reason,draft_reply");
    const back = parseCsv(csv);
    expect(back).toHaveLength(1);
    expect(back[0].reason).toBe(rows[0].reason);
    expect(back[0].draft_reply).toBe(rows[0].draft_reply);
    expect(back[0].approved_amount_inr).toBe("18000");
  });
});

describe("money + grounding", () => {
  it("formats and finds rupee amounts", () => {
    expect(formatInr(18000)).toBe("Rs 18,000");
    expect(formatInr(120000)).toBe("Rs 1,20,000");
    expect(findInrAmounts("Claiming Rs 18,000 and ₹4500, also INR 7,500 and 2000/-")).toEqual(
      expect.arrayContaining([18000, 4500, 7500, 2000]),
    );
    expect(findInrAmounts("filed 11 days after delivery, window 7 days")).toEqual([]);
    expect(findInrAmounts("customers 3, cartons 12, drivers 4500")).toEqual([]); // words ending in "rs" are not money
    expect(findInrAmounts("Total Rs.4500 / rs 12,000 / Rupees 300")).toEqual([4500, 12000, 300]);
  });

  it("drops an extracted amount that is not written in the email", () => {
    expect(groundAmount(18000, "Claiming Rs 18,000.")).toEqual({ amount: 18000, grounded: true });
    expect(groundAmount(180000, "Claiming Rs 18,000.")).toEqual({ amount: null, grounded: false });
    expect(groundAmount(null, "no amount")).toEqual({ amount: null, grounded: true });
  });

  it("re-grounds a 'helpfully corrected' shipment id on what the customer wrote", () => {
    const norm = (raw: string | null) => {
      if (!raw) return { id: null, corrected: false };
      const digits = raw.toUpperCase().replace(/[^A-Z0-9]/g, "").replace(/^SHP/, "");
      const fixed = digits.replace(/O/g, "0");
      return /^\d{3,6}$/.test(fixed)
        ? { id: `SHP-${fixed}`, corrected: fixed !== digits }
        : { id: null, corrected: false };
    };
    expect(groundShipmentId("SHP-1010", "Claim SHP-1O10 dented", norm)).toEqual({ raw: "SHP-1O10", grounded: true });
    expect(groundShipmentId("SHP-7777", "Claim SHP-1O10 dented", norm)).toEqual({ raw: null, grounded: false });
    expect(groundShipmentId(null, "anything", norm)).toEqual({ raw: null, grounded: true });
  });
});

describe("policy", () => {
  it("merges overrides from JSON without code changes and rejects bad config", () => {
    expect(resolvePolicy('{"smallClaimPhotoWaiverInr":5000}').smallClaimPhotoWaiverInr).toBe(5000);
    expect(resolvePolicy("").approvalLimitInr).toBe(defaultPolicy.approvalLimitInr);
    expect(resolvePolicy({ shortageProRata: true }).shortageProRata).toBe(true);
    expect(() => resolvePolicy('{"approvalLimitInr":-1}')).toThrow();
  });
});
