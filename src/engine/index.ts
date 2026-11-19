/**
 * RouteMax claims RULES ENGINE. Deterministic and pure: same EngineInput => same EngineDecision.
 * No I/O, no system clock, no randomness, no LLM.
 *
 * Facts come from the shipment record and the email HEADERS, never from the customer's wording.
 * Evaluation order: R0, R2, R1, R3, R5/R6, R4, R7, R8b, R8, R9.
 */
import { calendarDaysBetween } from "../email";
import { formatInr } from "../format";
import type { Decision, DecideFn, EngineDecision, PriorClaim, RuleTrace } from "../types";
import {
  hasSubstantiveRemark,
  normaliseShipmentId,
  parsePodReceivedCount,
  podSignedGoodCondition,
  senderMatchesCustomer,
} from "./helpers";

export { normaliseShipmentId, parsePodReceivedCount, senderMatchesCustomer };

const RULE_ORDER = ["R0", "R2", "R1", "R3", "R5", "R6", "R4", "R7", "R8b", "R8", "R9"] as const;

const MANUAL_REVIEW = "it has been forwarded to our claims team for a manual review";

function plural(n: number, word: string): string {
  return `${n} ${word}${Math.abs(n) === 1 ? "" : "s"}`;
}

function keyAccountWindow(windows: Record<string, number>, customer: string): number | null {
  const wanted = customer.trim().toLowerCase();
  for (const name of Object.keys(windows).sort()) {
    if (name.trim().toLowerCase() === wanted) return windows[name];
  }
  return null;
}

export const decide: DecideFn = (input) => {
  const { email, claim, policy } = input;
  const trace: RuleTrace[] = [];
  const seen = new Set<string>();
  const ruleIds: string[] = [];
  const reasons: string[] = [];
  let tokens: string[] = [];
  const facts: Record<string, unknown> = {
    customer: null,
    sender_matches_customer: null,
    days_since_delivery: null,
    window_days: null,
    claimed_amount_inr: claim?.claimed_amount_inr ?? null,
    declared_value_inr: null,
    payable_inr: null,
    pod_received_count: null,
    pod_missing: null,
    photos_present: null,
    photos_required: null,
  };

  /** Record a rule in the audit trace. `base` is the main rule id when `rule` is a sub-id (R2a...). */
  const mark = (rule: string, outcome: RuleTrace["outcome"], note: string, base: string = rule): void => {
    trace.push({ rule, outcome, note });
    seen.add(base);
  };
  /** A rule that decided or changed the outcome/amount: goes into rule_ids and the reason. */
  const fire = (id: string, sentence: string): void => {
    if (!ruleIds.includes(id)) ruleIds.push(id);
    reasons.push(`${id}: ${sentence}`);
  };
  /** A passing check worth showing the reviewer: reason only. */
  const say = (id: string, sentence: string): void => {
    reasons.push(`${id}: ${sentence}`);
  };
  const finish = (
    decision: Decision,
    amount: number,
    customerReason: string,
    extra: { missing_info?: string[]; prior_claim?: PriorClaim | null } = {},
  ): EngineDecision => {
    const decidedBy = ruleIds.length > 0 ? ruleIds[ruleIds.length - 1] : "an earlier rule";
    for (const rule of RULE_ORDER) {
      if (!seen.has(rule)) trace.push({ rule, outcome: "skip", note: `not reached (decided by ${decidedBy})` });
    }
    const paying = decision === "approve" || decision === "escalate";
    return {
      decision,
      approved_amount_inr: paying && Number.isFinite(amount) ? Math.max(0, Math.floor(amount)) : 0,
      rule_ids: ruleIds,
      reason: reasons.join(" "),
      customer_reason: customerReason,
      required_reply_tokens: tokens,
      missing_info: extra.missing_info ?? [],
      prior_claim: extra.prior_claim ? { ...extra.prior_claim } : null,
      trace,
      facts,
    };
  };

  /* ---------------------------------------------------------------- R0 */
  if (!input.is_claim) {
    mark("R0", "fire", "email is not a damage/shortage claim");
    fire("R0", "email is not a damage or shortage claim -> not_a_claim.");
    return finish(
      "not_a_claim",
      0,
      "Your message does not appear to be a damage or shortage claim, so no claim has been opened.",
    );
  }
  if (!claim) {
    mark("R0", "fire", "flagged as a claim but no claim details were extracted");
    fire("R0", "email is flagged as a claim but no claim details were extracted -> escalate for manual review.");
    return finish("escalate", 0, `We could not read the details of your claim automatically, so ${MANUAL_REVIEW}.`);
  }
  mark("R0", "pass", "email is a claim");

  /* ---------------------------------------------------------------- R2 */
  const rawId = claim.shipment_id_raw?.trim() || null;
  const normId = input.shipment_id_normalised;

  if (!normId) {
    const what = rawId ? `"${rawId}" is not a usable shipment id` : "no shipment id given";
    mark("R2a", "fire", what, "R2");
    fire("R2", `${what} -> need_info (shipment_id).`);
    return finish(
      "need_info",
      0,
      "We could not find a valid shipment ID in your email, so we are unable to look up the delivery record.",
      { missing_info: ["shipment_id"] },
    );
  }

  const lookup = input.lookup;
  if (!lookup || lookup.status === "error") {
    // Tool errors already read "lookup failed: timeout ..."; do not say it twice.
    const why = lookup ? lookup.error.replace(/^lookup failed:?\s*/i, "") || "unknown error" : "no lookup result";
    tokens = [rawId ?? normId];
    mark("R2b", "fire", `lookup failed for ${normId}: ${why}`, "R2");
    fire(
      "R2",
      `shipment lookup failed for ${normId} (${why}); a claim is never approved without a successful shipment lookup -> escalate.`,
    );
    return finish(
      "escalate",
      0,
      `We could not retrieve the delivery record for this shipment just now, so ${MANUAL_REVIEW}.`,
    );
  }
  if (lookup.status === "not_found") {
    tokens = [rawId ?? normId];
    mark("R2c", "fire", `shipment not found: ${normId}`, "R2");
    fire("R2", `shipment not found for id ${normId} -> need_info (shipment_id).`);
    return finish(
      "need_info",
      0,
      "We could not find a shipment with the ID given in your email. Please check the shipment ID and send it to us again.",
      { missing_info: ["shipment_id"] },
    );
  }

  const shipment = lookup.shipment;
  const shipmentId = shipment.shipment_id;
  tokens = [shipmentId];
  facts.customer = shipment.customer;
  facts.declared_value_inr = shipment.declared_value_inr;
  const senderOk = senderMatchesCustomer(email.sender_email, shipment.customer);
  facts.sender_matches_customer = senderOk;
  const sender = email.sender_email || "(no sender address)";

  if (!senderOk) {
    if (input.shipment_id_corrected) {
      mark("R2d", "fire", `fuzzy id match rejected: sender ${sender} does not match ${shipment.customer}`, "R2");
      fire(
        "R2",
        `id "${rawId ?? normId}" resembles ${shipmentId}, but the fuzzy match was not accepted because the sender ${sender} does not match the shipment's customer (${shipment.customer}) -> need_info (sender_verification).`,
      );
    } else {
      mark("R2d", "fire", `sender ${sender} does not match ${shipment.customer}`, "R2");
      fire(
        "R2",
        `shipment ${shipmentId} is registered to a different customer (${shipment.customer}) than the sender ${sender} -> need_info (sender_verification).`,
      );
    }
    return finish(
      "need_info",
      0,
      "We could not match this shipment to the email address the claim was sent from. Please confirm the shipment ID, or write to us from the email address registered for the shipment.",
      { missing_info: ["sender_verification"] },
    );
  }
  if (input.shipment_id_corrected) {
    mark("R2", "fire", `id "${rawId ?? normId}" normalised to ${shipmentId}; sender matches ${shipment.customer}`);
    fire("R2", `id "${rawId ?? normId}" normalised to ${shipmentId}; sender matches ${shipment.customer}.`);
  } else {
    mark("R2", "pass", `shipment ${shipmentId} found; sender matches ${shipment.customer}`);
  }

  /* ---------------------------------------------------------------- R1 */
  const prior = input.prior_claims;
  if (prior.status === "error") {
    const why = prior.error.replace(/^lookup failed:?\s*/i, "") || "unknown error";
    mark("R1", "fire", `prior-claims lookup failed: ${why}`);
    fire("R1", `prior-claims lookup failed (${why}); cannot rule out a duplicate -> escalate.`);
    return finish(
      "escalate",
      0,
      `We could not check our earlier claim records for this shipment just now, so ${MANUAL_REVIEW}.`,
    );
  }
  if (prior.claims.length > 0) {
    const earlier = prior.claims.find((c) => !!c.payment_ref) ?? prior.claims[0];
    const bits: string[] = [earlier.decision];
    if (earlier.paid_date) bits.push(`paid ${earlier.paid_date}`);
    else if (earlier.decided_date) bits.push(`decided ${earlier.decided_date}`);
    if (earlier.payment_ref) bits.push(`ref ${earlier.payment_ref}`);
    mark("R1", "fire", `duplicate of ${earlier.claim_id}`);
    fire("R1", `duplicate of ${earlier.claim_id} (${bits.join(", ")}) -> no second decision or payout.`);
    tokens = [shipmentId, earlier.claim_id];
    if (earlier.payment_ref) tokens.push(earlier.payment_ref);

    let outcome: string;
    if (earlier.decision === "approve") {
      const paid = [
        earlier.paid_date ? `paid on ${earlier.paid_date}` : "",
        earlier.payment_ref ? `payment reference ${earlier.payment_ref}` : "",
      ].filter((s) => s.length > 0);
      outcome = `was already approved under claim ${earlier.claim_id}${paid.length ? ` (${paid.join(", ")})` : ""}`;
    } else if (earlier.decision === "reject") {
      outcome = `was already reviewed and closed under claim ${earlier.claim_id}`;
    } else {
      outcome = `is already under review with our Claims Manager under claim ${earlier.claim_id}`;
    }
    return finish(
      "duplicate",
      0,
      `A claim for this shipment ${outcome}, so we cannot process it a second time.`,
      { prior_claim: earlier },
    );
  }
  mark("R1", "pass", "no earlier decided claim on this shipment");

  /* ---------------------------------------------------------------- R3 */
  if (!email.date) {
    mark("R3", "fire", "email has no usable Date header");
    fire(
      "R3",
      "email has no usable Date header; cannot verify the time limit and the system clock is never used -> escalate.",
    );
    return finish("escalate", 0, `We could not confirm the date your claim was filed, so ${MANUAL_REVIEW}.`);
  }
  const days = calendarDaysBetween(shipment.delivered_date, email.date);
  const keyWindow = keyAccountWindow(policy.keyAccountWindows, shipment.customer);
  const windowDays = keyWindow ?? policy.defaultWindowDays;
  facts.window_days = windowDays;
  const span = `${shipment.delivered_date} -> ${email.date}`;
  const windowLabel =
    keyWindow !== null ? `key-account window ${windowDays} for ${shipment.customer}` : `window ${windowDays}`;

  if (!Number.isFinite(days)) {
    mark("R3", "fire", `cannot compute days since delivery (${span})`);
    fire("R3", `cannot compute days since delivery (${span}); time limit not verifiable -> escalate.`);
    return finish("escalate", 0, `We could not confirm the delivery date for this shipment, so ${MANUAL_REVIEW}.`);
  }
  facts.days_since_delivery = days;
  if (days < 0) {
    mark("R3", "fire", `email date is before delivery (${span})`);
    fire("R3", `email is dated ${plural(-days, "day")} before delivery (${span}) -> escalate.`);
    return finish(
      "escalate",
      0,
      `The date on your email is earlier than the recorded delivery date of the shipment, so ${MANUAL_REVIEW}.`,
    );
  }
  if (days > windowDays) {
    mark("R3", "fire", `filed ${plural(days, "day")} after delivery; ${windowLabel}`);
    fire(
      "R3",
      `filed ${plural(days, "day")} after delivery (${span}); ${keyWindow !== null ? "key-account window" : "window"} is ${plural(windowDays, "day")} -> reject.`,
    );
    return finish(
      "reject",
      0,
      `The claim was filed ${plural(days, "day")} after delivery, which is outside our ${windowDays}-day claims window.`,
    );
  }
  const r3 = `filed ${plural(days, "day")} after delivery (${windowLabel}).`;
  if (keyWindow !== null && days > policy.defaultWindowDays) {
    // The key-account override is what keeps this claim alive.
    mark("R3", "fire", r3);
    fire("R3", r3);
  } else {
    mark("R3", "pass", r3);
    say("R3", r3);
  }

  /* ----------------------------------------------------------- R5 / R6 */
  const goodCondition = podSignedGoodCondition(shipment.pod_status);
  const substantive = hasSubstantiveRemark(shipment.pod_remarks);
  const remarks = shipment.pod_remarks.trim();
  const shipped = shipment.pieces_shipped;
  const received = parsePodReceivedCount(shipment.pod_remarks, shipped);
  facts.pod_received_count = received;
  let podMissing: number | null = null;

  if (claim.claim_type === "damage") {
    if (goodCondition && !substantive) {
      mark("R5", "fire", "POD signed in good condition with no damage remarks");
      fire("R5", 'POD signed "received in good condition" with no damage remarks -> reject.');
      return finish(
        "reject",
        0,
        "The proof of delivery was signed as received in good condition with no remarks, so we are unable to accept a damage claim for this shipment.",
      );
    }
    mark("R5", "pass", remarks ? `POD remarks: "${remarks}"` : `POD status: "${shipment.pod_status}"`);
    mark("R6", "skip", "not a shortage claim");
  } else {
    mark("R5", "skip", "not a damage claim");
    if (received === null) {
      if (goodCondition && !substantive) {
        mark("R6", "fire", "POD signed clean; no shortage noted");
        fire("R6", 'POD signed "received in good condition" with no shortage noted -> reject.');
        return finish(
          "reject",
          0,
          "The proof of delivery was signed as received in good condition with no shortage noted, so we are unable to accept a shortage claim for this shipment.",
        );
      }
      mark("R6", "fire", "POD does not state a piece count");
      fire(
        "R6",
        `POD does not state a piece count (remarks: "${remarks}"); shortage cannot be verified -> escalate for a manual check.`,
      );
      return finish(
        "escalate",
        0,
        `The proof of delivery does not state how many pieces were received, so ${MANUAL_REVIEW}.`,
      );
    }
    if (received >= shipped) {
      mark("R6", "fire", `POD confirms full count (${received} of ${shipped})`);
      fire("R6", `POD confirms the full count (${received} of ${shipped} pieces received) -> reject.`);
      return finish(
        "reject",
        0,
        `The proof of delivery confirms that the full count of ${plural(shipped, "piece")} was received, so we are unable to accept a shortage claim for this shipment.`,
      );
    }
    podMissing = shipped - received;
    facts.pod_missing = podMissing;
    const r6 = `POD shows ${received} of ${shipped} pieces received (${podMissing} short).`;
    mark("R6", "pass", r6);
    say("R6", r6);
  }

  /* ----------------------------------------------------------- R4 + R7 */
  const claimedRaw = claim.claimed_amount_inr;
  const claimed = claimedRaw !== null && Number.isFinite(claimedRaw) && claimedRaw > 0 ? claimedRaw : null;
  const missing: string[] = [];
  const needInfoReasons: string[] = [];

  if (claim.claim_type === "damage") {
    const images = email.image_attachments.length;
    const photosPresent = images > 0 && !claim.customer_states_no_photos;
    const waived =
      policy.smallClaimPhotoWaiverInr > 0 && claimed !== null && claimed <= policy.smallClaimPhotoWaiverInr;
    facts.photos_present = photosPresent;
    facts.photos_required = !waived;
    if (photosPresent) {
      const r4 = `photos attached (${plural(images, "image file")}).`;
      mark("R4", "pass", r4);
      say("R4", r4);
    } else if (waived) {
      mark("R4", "fire", `no photos, but claim is within the small-claim waiver (${formatInr(policy.smallClaimPhotoWaiverInr)})`);
      fire(
        "R4",
        `photo requirement waived for small claim (${formatInr(claimed as number)} <= ${formatInr(policy.smallClaimPhotoWaiverInr)}).`,
      );
    } else {
      const why =
        images > 0
          ? "customer states there are no photos for this claim"
          : "no image attachments in the email headers";
      mark("R4", "fire", why);
      fire("R4", `${why} -> need_info (photos).`);
      missing.push("photos");
      needInfoReasons.push(
        "Damage claims need photos of the damaged goods before we can decide, and we do not have photos for this claim.",
      );
    }
  } else {
    facts.photos_present = email.image_attachments.length > 0;
    facts.photos_required = false;
    mark("R4", "skip", "shortage claims do not need photos");
  }

  if (claimed === null) {
    mark("R7", "fire", "no claim amount stated");
    fire("R7", "no claim amount stated -> need_info (claim_amount).");
    missing.push("claim_amount");
    needInfoReasons.push("Your email does not state the amount you are claiming.");
  }
  if (missing.length > 0) {
    return finish("need_info", 0, needInfoReasons.join(" "), { missing_info: missing });
  }

  const claimedAmount = claimed as number;
  const declared = shipment.declared_value_inr;
  let payable = Math.floor(Math.min(claimedAmount, declared));
  let capNote = "";
  let capCustomerNote = "";
  if (declared < claimedAmount) {
    capNote = `claimed ${formatInr(claimedAmount)} capped at declared value ${formatInr(declared)}.`;
    capCustomerNote = " Please note that the payable amount is limited to the declared value of the shipment.";
  }
  if (claim.claim_type === "shortage" && policy.shortageProRata && podMissing !== null && shipped > 0) {
    const proRata = Math.floor((podMissing * declared) / shipped);
    if (proRata < payable) {
      payable = proRata;
      capNote = `claimed ${formatInr(claimedAmount)} capped pro-rata at ${formatInr(proRata)} (${podMissing} of ${shipped} pieces missing x declared value ${formatInr(declared)}).`;
      capCustomerNote =
        " Please note that the payable amount is limited to the declared value of the missing pieces.";
    }
  }
  if (!capNote && payable < claimedAmount) {
    capNote = `claimed amount rounded down to whole rupees (${formatInr(payable)}).`;
  }
  facts.payable_inr = payable;

  if (payable <= 0) {
    mark("R7", "fire", `payable is ${formatInr(payable)} (declared value ${formatInr(declared)})`);
    fire(
      "R7",
      `payable amount is ${formatInr(payable)} (claimed ${formatInr(claimedAmount)}, declared value ${formatInr(declared)}) -> escalate.`,
    );
    return finish(
      "escalate",
      0,
      `We could not confirm a payable value for this shipment from our records, so ${MANUAL_REVIEW}.`,
    );
  }
  if (capNote) {
    mark("R7", "fire", capNote);
    fire("R7", capNote);
  } else {
    mark("R7", "pass", `claimed ${formatInr(claimedAmount)} is within declared value ${formatInr(declared)}`);
  }

  /* --------------------------------------------------------- R8b / R8 */
  const escalations: string[] = [];
  if (!policy.payConsequentialLoss && claim.consequential_loss_mentioned) {
    mark("R8b", "fire", "claim includes consequential loss");
    fire(
      "R8b",
      `claim includes consequential loss (downtime, lost sales or similar), which is not payable; the goods-only value must be confirmed by the Claims Manager (recommended upper bound ${formatInr(payable)}).`,
    );
    escalations.push(
      "Your claim includes losses beyond the value of the goods themselves, which our claims policy does not cover, so it has been forwarded to our Claims Manager to confirm the payable value of the goods.",
    );
  } else {
    mark("R8b", "pass", claim.consequential_loss_mentioned ? "consequential loss is payable under current policy" : "no consequential loss mentioned");
  }
  if (payable > policy.approvalLimitInr) {
    mark("R8", "fire", `payable ${formatInr(payable)} exceeds approval limit ${formatInr(policy.approvalLimitInr)}`);
    fire(
      "R8",
      `payable ${formatInr(payable)} exceeds the ${formatInr(policy.approvalLimitInr)} approval limit - Claims Manager approval required (recommended ${formatInr(payable)}).`,
    );
    escalations.push(
      escalations.length > 0
        ? "Claims of this value also need approval from our Claims Manager."
        : "Claims of this value need approval from our Claims Manager, so your claim has been forwarded for review.",
    );
  } else {
    mark("R8", "pass", `payable ${formatInr(payable)} is within approval limit ${formatInr(policy.approvalLimitInr)}`);
  }
  if (escalations.length > 0) {
    return finish("escalate", payable, escalations.join(" ") + capCustomerNote);
  }

  /* ---------------------------------------------------------------- R9 */
  mark("R9", "fire", `approve ${formatInr(payable)}`);
  fire("R9", `approve ${formatInr(payable)}.`);
  return finish(
    "approve",
    payable,
    `Your ${claim.claim_type} claim has been checked against the delivery record and approved.${capCustomerNote}`,
  );
};
