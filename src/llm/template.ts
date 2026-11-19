/**
 * Deterministic reply template + the reply validator.
 * The template is the safety net for the LLM drafter and the whole drafter in mock mode.
 * Neither function decides anything: they only word / check a decision already made by the engine.
 */
import { findInrAmounts, formatInr } from "../format";
import type { Decision, DraftInput } from "../types";
import { countHinglishMarkers } from "./mock";

export const MAX_DRAFT_CHARS = 2500;
export const SIGNATURE = "RouteMax Claims Desk";

/* ----------------------------------------------------------------- template */

const NEEDED_EN: Record<string, string> = {
  photos: "clear photos of the damaged goods and the packaging",
  claim_amount: "the amount you are claiming",
  shipment_id: "the RouteMax shipment ID (it starts with SHP-)",
  sender_verification: "confirmation of this claim from the email address registered with RouteMax for this account",
};

const NEEDED_HINGLISH: Record<string, string> = {
  photos: "damaged maal aur packaging ki clear photos",
  claim_amount: "aap kitna amount claim kar rahe hain",
  shipment_id: "RouteMax shipment ID (SHP- se shuru hota hai)",
  sender_verification: "RouteMax ke saath registered email address se is claim ki confirmation",
};

function cleanName(name: string | null): string | null {
  if (!name) return null;
  const n = name.replace(/[\r\n\t]+/g, " ").replace(/[^\p{L}\p{M} .&'-]/gu, "").replace(/\s+/g, " ").trim();
  return n ? n.slice(0, 60) : null;
}

function neededList(input: DraftInput, dict: Record<string, string>): string[] {
  return input.missing_info.map((k) => `- ${dict[k] ?? k.replace(/_/g, " ")}`);
}

function priorLineEn(input: DraftInput): string | null {
  const p = input.prior_claim;
  if (!p) return null;
  let s = `Earlier claim ${p.claim_id}`;
  if (p.decision === "approve") {
    s += " was approved";
    if (p.paid_date) s += ` and paid on ${p.paid_date}`;
    else if (p.decided_date) s += ` on ${p.decided_date}`;
  } else if (p.decision === "reject") {
    s += " was rejected";
    if (p.decided_date) s += ` on ${p.decided_date}`;
  } else {
    s += " is with the Claims Manager and is awaiting a decision";
  }
  if (p.payment_ref) s += ` (payment reference ${p.payment_ref})`;
  return s + ".";
}

function priorLineHinglish(input: DraftInput): string | null {
  const p = input.prior_claim;
  if (!p) return null;
  let s = `Pehle wala claim ${p.claim_id}`;
  if (p.decision === "approve") {
    s += " approve ho chuka hai";
    if (p.paid_date) s += ` aur ${p.paid_date} ko pay ho chuka hai`;
  } else if (p.decision === "reject") {
    s += " reject ho chuka hai";
  } else {
    s += " Claims Manager ke paas hai aur uska decision abhi baaki hai";
  }
  if (p.payment_ref) s += ` (payment reference ${p.payment_ref})`;
  return s + ".";
}

function renderEnglish(input: DraftInput): string[] {
  const name = cleanName(input.customer_name);
  const lines: string[] = [`Dear ${name ?? "Customer"},`, ""];
  lines.push(
    input.shipment_id
      ? `Thank you for contacting RouteMax about shipment ${input.shipment_id}.`
      : "Thank you for contacting RouteMax.",
    "",
  );
  const kind = input.claim_type ? `${input.claim_type} claim` : "claim";
  switch (input.decision) {
    case "approve":
      lines.push(`Decision: your ${kind} has been approved for ${formatInr(input.approved_amount_inr)}.`);
      break;
    case "reject":
      lines.push(`Decision: we are unable to approve this ${kind} and it has been rejected.`);
      break;
    case "need_info":
      lines.push(`Decision: we need more information before we can process this ${kind}.`);
      break;
    case "escalate":
      lines.push(
        `Decision: your ${kind} has been forwarded to the Claims Manager for review. ` +
          "No final decision has been made yet, and we will update you once that is complete.",
      );
      break;
    case "duplicate":
      lines.push(
        "Decision: this is a duplicate of a claim that has already been decided for this shipment, so no new claim has been opened.",
      );
      break;
    case "not_a_claim":
      lines.push(
        "Decision: your message is not being treated as a claim, so no claim has been opened. " +
          "We have passed your request to the RouteMax customer service team.",
      );
      break;
  }
  if (input.decision === "duplicate") {
    const prior = priorLineEn(input);
    if (prior) lines.push("", prior);
  }
  if (input.customer_reason.trim()) lines.push("", `Reason: ${input.customer_reason.trim()}`);
  if (input.decision === "need_info" && input.missing_info.length > 0) {
    lines.push("", "Please send us:", ...neededList(input, NEEDED_EN));
  }
  lines.push(
    "",
    "This decision is subject to review by the RouteMax claims team. " +
      `If anything here looks wrong, please reply to this email quoting reference ${input.claim_id}.`,
    "",
    "Regards,",
    SIGNATURE,
  );
  return lines;
}

function renderHinglish(input: DraftInput): string[] {
  const name = cleanName(input.customer_name);
  const lines: string[] = [name ? `Namaste ${name} ji,` : "Namaste,", ""];
  lines.push(
    input.shipment_id
      ? `RouteMax ko likhne ke liye dhanyavaad. Yeh reply aapke shipment ${input.shipment_id} ke baare mein hai.`
      : "RouteMax ko likhne ke liye dhanyavaad.",
    "",
  );
  const kind = input.claim_type ? `${input.claim_type} claim` : "claim";
  switch (input.decision) {
    case "approve":
      lines.push(
        `Decision: aapka ${kind} approve ho gaya hai. Approved amount: ${formatInr(input.approved_amount_inr)}.`,
      );
      break;
    case "reject":
      lines.push(`Decision: maaf kijiye, hum yeh ${kind} approve nahi kar sakte. Claim reject kiya gaya hai.`);
      break;
    case "need_info":
      lines.push(`Decision: is ${kind} ko process karne ke liye humein kuch aur jaankari ki zaroorat hai.`);
      break;
    case "escalate":
      lines.push(
        `Decision: aapka ${kind} review ke liye Claims Manager ko forward kar diya gaya hai. ` +
          "Abhi final decision nahi hua hai; decision hone par hum aapko update karenge.",
      );
      break;
    case "duplicate":
      lines.push(
        "Decision: yeh ek duplicate claim hai. Is shipment ka claim pehle hi decide ho chuka hai, isliye naya claim nahi khola gaya hai.",
      );
      break;
    case "not_a_claim":
      lines.push(
        "Decision: aapka message claim nahi hai (not a claim), isliye koi claim nahi khola gaya hai. " +
          "Aapki request humne RouteMax customer service team ko bhej di hai.",
      );
      break;
  }
  if (input.decision === "duplicate") {
    const prior = priorLineHinglish(input);
    if (prior) lines.push("", prior);
  }
  if (input.customer_reason.trim()) lines.push("", `Kaaran (reason): ${input.customer_reason.trim()}`);
  if (input.decision === "need_info" && input.missing_info.length > 0) {
    lines.push("", "Kripya yeh bhej dijiye:", ...neededList(input, NEEDED_HINGLISH));
  }
  lines.push(
    "",
    "Yeh decision RouteMax claims team ke review ke adheen hai (subject to review). " +
      `Koi sawaal ho to is email ka reply karein, reference ${input.claim_id}.`,
    "",
    "Dhanyavaad,",
    SIGNATURE,
  );
  return lines;
}

/**
 * Deterministic reply for a decision. English unless the customer wrote Hinglish.
 * Only an `approve` reply states a rupee amount, and only the approved amount.
 */
export function renderTemplateReply(input: DraftInput): string {
  const lines = input.language === "hinglish" ? renderHinglish(input) : renderEnglish(input);
  let text = lines.join("\n");
  const lower = text.toLowerCase();
  const missing = input.required_reply_tokens.filter((t) => t.trim() && !lower.includes(t.toLowerCase()));
  if (missing.length > 0) {
    // Put the reference line just above the closing so the signature stays last.
    const closingAt = lines.length - 4;
    lines.splice(closingAt, 0, `Reference: ${missing.join(", ")}`, "");
    text = lines.join("\n");
  }
  return text;
}

/* ---------------------------------------------------------------- validator */

const DECISION_MARKERS: Record<Decision, RegExp> = {
  approve: /approv/i,
  reject: /reject|unable to approve|cannot (accept|approve)|can ?not be (accepted|approved)|declin|approve nahi/i,
  need_info: /need|require|please (send|share|provide)|bhej|zaroorat/i,
  escalate: /manager|escalat|forward/i,
  duplicate: /duplicate|already|pehle hi/i,
  not_a_claim: /not (a|being treated as a) claim|no claim|claim nahi|forward|request/i,
};

const PAYMENT_PROMISE =
  /will be (paid|credited|refunded|settled|reimbursed)|we will (pay|refund|credit|reimburse)|payment (will|shall) be|pay kar denge|paisa (mil|aa) jayega/i;
/** An affirmative "approved" in a reply whose decision is not approve (the earlier claim of a duplicate is exempt). */
const SAYS_APPROVED = /\b(has|have) been approved\b|\bis approved\b|\bwe have approved\b|\bapprove ho (gaya|chuka)\b/i;
const SAYS_REJECTED = /\b(has|have) been rejected\b|\bunable to approve\b|\bcannot approve\b|\breject (kiya|ho) (gaya|chuka)\b/i;

/**
 * The "reply check": does this draft say what the engine decided, and nothing more?
 * Used by the drafter (retry / fall back to the template) and by the eval harness.
 */
export function validateDraft(draft: string, input: DraftInput): { ok: boolean; problems: string[] } {
  const problems: string[] = [];
  const text = (draft ?? "").trim();
  if (text.length === 0) {
    return { ok: false, problems: ["draft is empty"] };
  }
  if (text.length > MAX_DRAFT_CHARS) {
    problems.push(`draft is too long (${text.length} chars, max ${MAX_DRAFT_CHARS})`);
  }

  if (!DECISION_MARKERS[input.decision].test(text)) {
    problems.push(`draft does not clearly state the decision "${input.decision}"`);
  }

  const lower = text.toLowerCase();
  for (const token of input.required_reply_tokens) {
    if (token.trim() && !lower.includes(token.toLowerCase())) {
      problems.push(`draft is missing required token "${token}"`);
    }
  }

  const amounts = findInrAmounts(text);
  if (input.decision === "approve") {
    const approved = input.approved_amount_inr;
    if (!amounts.includes(approved)) {
      problems.push(`draft must state the approved amount ${formatInr(approved)}`);
    }
    const extra = [...new Set(amounts.filter((a) => a !== approved))];
    if (extra.length > 0) {
      problems.push(
        `draft mentions rupee amounts other than the approved amount: ${extra.map(formatInr).join(", ")}`,
      );
    }
    if (SAYS_REJECTED.test(text)) problems.push("draft says the claim is rejected but the decision is approve");
  } else {
    if (amounts.length > 0) {
      problems.push(
        `draft must not mention any rupee amount for decision "${input.decision}" (found ${[...new Set(amounts)]
          .map(formatInr)
          .join(", ")})`,
      );
    }
    if (PAYMENT_PROMISE.test(text)) {
      problems.push(`draft promises a payment but the decision is "${input.decision}"`);
    }
    if (input.decision !== "duplicate" && SAYS_APPROVED.test(text)) {
      problems.push(`draft says the claim is approved but the decision is "${input.decision}"`);
    }
  }

  if (input.language === "hinglish" && countHinglishMarkers(text) < 2) {
    problems.push("draft is not in Hinglish (romanised Hindi mixed with English), the customer's language");
  }

  return { ok: problems.length === 0, problems };
}
