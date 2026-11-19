/**
 * The pipeline: one email in, result rows out.
 *
 *   parse headers (code) -> EXTRACT (LLM) -> ground (code) -> lookup tools -> DECIDE (pure code) -> DRAFT (LLM) -> store + audit
 *
 * The LLM never chooses a decision or an amount. Everything it returns is validated (Zod),
 * grounded against the email text, and then only used as INPUT to the deterministic engine.
 * Pure w.r.t. platform: runs unchanged in Node (CLI, evals) and in the Worker.
 */
import { decide, normaliseShipmentId } from "./engine";
import { findShipmentIdMention, hashEmail, parseEmail } from "./email";
import { groundAmount, groundShipmentId } from "./grounding";
import { detectConsequentialLoss, renderTemplateReply } from "./llm";
import {
  ExtractionSchema,
  LookupResultSchema,
  PriorClaimsResultSchema,
  type AuditEntry,
  type ClaimDetail,
  type DraftInput,
  type EngineDecision,
  type EngineInput,
  type ExtractedClaim,
  type Extraction,
  type LookupResult,
  type ParsedEmail,
  type PipelineDeps,
  type PriorClaim,
  type PriorClaimsResult,
  type ProcessedEmail,
  type ProcessInput,
  type ProcessResult,
  type ResultRow,
} from "./types";

function errText(err: unknown): string {
  const msg = err instanceof Error ? err.message : String(err);
  return msg.replace(/\s+/g, " ").slice(0, 300);
}

function toResult(record: ProcessedEmail, replay: boolean): ProcessResult {
  return {
    claim_id: record.claim_id,
    email_hash: record.email_hash,
    idempotent_replay: replay,
    rows: record.rows,
    details: record.details,
  };
}

/** Tools must never throw, but a tool is a boundary: trust nothing, validate the shape. */
async function safeLookupShipment(deps: PipelineDeps, id: string): Promise<LookupResult> {
  try {
    const parsed = LookupResultSchema.safeParse(await deps.tools.lookupShipment(id));
    return parsed.success
      ? parsed.data
      : { status: "error", error: "lookup failed: malformed response from shipment lookup" };
  } catch (err) {
    return { status: "error", error: `lookup failed: ${errText(err)}` };
  }
}

async function safePriorClaims(deps: PipelineDeps, shipmentId: string): Promise<PriorClaimsResult> {
  try {
    const past = PriorClaimsResultSchema.safeParse(await deps.tools.lookupPriorClaims(shipmentId));
    if (!past.success) return { status: "error", error: "prior-claims lookup returned a malformed response" };
    if (past.data.status === "error") return past.data;
    const fromState = await deps.store.findDecidedByShipment(shipmentId);
    return { status: "ok", claims: [...past.data.claims, ...fromState] };
  } catch (err) {
    return { status: "error", error: `prior-claims lookup failed: ${errText(err)}` };
  }
}

/**
 * Last line of defence, independent of the engine: an approval must have a successful lookup,
 * and no amount may exceed min(claimed, declared) or be negative. A violation is converted to
 * an escalation with amount 0, never silently "fixed".
 */
function enforceInvariants(decision: EngineDecision, input: EngineInput): EngineDecision {
  const problems: string[] = [];
  const amount = decision.approved_amount_inr;
  const found = input.lookup?.status === "found" ? input.lookup.shipment : null;
  const claimed = input.claim?.claimed_amount_inr ?? null;

  if (!Number.isInteger(amount) || amount < 0) problems.push("amount is not a non-negative integer");
  if (decision.decision === "approve") {
    if (!found) problems.push("approve without a successful shipment lookup");
    if (amount <= 0) problems.push("approve with zero amount");
  }
  if (amount > 0) {
    if (decision.decision !== "approve" && decision.decision !== "escalate")
      problems.push(`${decision.decision} with a non-zero amount`);
    if (!found || claimed === null || amount > Math.min(claimed, found.declared_value_inr))
      problems.push("amount exceeds min(claimed, declared value)");
  }
  if (problems.length === 0) return decision;
  return {
    ...decision,
    decision: "escalate",
    approved_amount_inr: 0,
    rule_ids: [...decision.rule_ids, "E3"],
    reason: `E3: safety invariant violated (${problems.join("; ")}) - no automatic decision, manual review required. Engine said: ${decision.reason}`,
    customer_reason:
      "Your claim needs a manual review by our claims team before we can confirm the outcome.",
    missing_info: [],
    prior_claim: null,
  };
}

export async function processEmail(input: ProcessInput, deps: PipelineDeps): Promise<ProcessResult> {
  const now = deps.now ?? (() => new Date().toISOString());
  const llm_mode = deps.extractor.mode;
  const model = deps.extractor.model;
  const email_hash = await hashEmail(input.raw);

  /* ---- idempotency: same email -> stored result, nothing new written (except an audit line) ---- */
  const existing = await deps.store.getByEmailHash(email_hash);
  if (existing) {
    await deps.store.appendAudit({
      ts: now(),
      event: "idempotent_replay",
      email_hash,
      claim_id: existing.claim_id,
      shipment_id: existing.rows.map((r) => r.shipment_id).join("|"),
      decision: null,
      approved_amount_inr: 0,
      rule_ids: [],
      reason: "Same email submitted again; stored result returned, no new rows created.",
      inputs: { submitted_claim_id: input.claimId ?? null },
      config_snapshot: deps.policy,
      llm_mode,
      model,
    });
    return toResult(existing, true);
  }

  const email: ParsedEmail = parseEmail(input.raw);
  const claim_id = (input.claimId ?? "").trim() || `E-${email_hash.slice(0, 8)}`;
  const emailText = `${email.subject}\n${email.body}`;
  const emailSummary = {
    from: email.from,
    date_raw: email.date_raw,
    date: email.date,
    subject: email.subject,
    attachments: email.attachments,
    image_attachments: email.image_attachments,
  };

  /* ---- EXTRACT (LLM) ---- */
  let extraction: Extraction;
  try {
    extraction = ExtractionSchema.parse(await deps.extractor.extract(email));
  } catch (err) {
    // Could not read the email reliably -> a human reads it. Not persisted, so a retry is possible.
    const mention = findShipmentIdMention(emailText);
    const shipment_id = normaliseShipmentId(mention).id ?? "";
    const reason = `E1: automatic extraction failed (${errText(err)}) - no decision made, manual review required.`;
    const draftInput: DraftInput = {
      claim_id,
      shipment_id,
      decision: "escalate",
      approved_amount_inr: 0,
      customer_reason:
        "We could not process your email automatically, so it has been passed to our claims team for manual review.",
      required_reply_tokens: shipment_id ? [shipment_id] : [],
      missing_info: [],
      language: "en",
      customer_name: null,
      claim_type: null,
      prior_claim: null,
    };
    const row: ResultRow = {
      claim_id,
      shipment_id,
      decision: "escalate",
      approved_amount_inr: 0,
      reason,
      draft_reply: renderTemplateReply(draftInput),
    };
    await deps.store.appendAudit({
      ts: now(),
      event: "extraction_failed",
      email_hash,
      claim_id,
      shipment_id,
      decision: "escalate",
      approved_amount_inr: 0,
      rule_ids: ["E1"],
      reason,
      inputs: { email: emailSummary, error: errText(err) },
      config_snapshot: deps.policy,
      llm_mode,
      model,
    });
    const detail: ClaimDetail = {
      row,
      rule_ids: ["E1"],
      trace: [{ rule: "E1", outcome: "fire", note: "extraction failed" }],
      customer_reason: draftInput.customer_reason,
      extracted_claim: null,
      facts: {},
    };
    return { claim_id, email_hash, idempotent_replay: false, rows: [row], details: [detail] };
  }

  /* ---- one engine run per claim (or a single R0 run when it is not a claim) ---- */
  type Unit = { claim: ExtractedClaim | null; notes: string[] };
  const units: Unit[] = [];
  if (!extraction.is_claim) {
    units.push({ claim: null, notes: [] });
  } else {
    const claims: ExtractedClaim[] =
      extraction.claims.length > 0
        ? extraction.claims
        : [
            {
              shipment_id_raw: null,
              claim_type: "damage",
              claimed_amount_inr: null,
              pieces_claimed_missing: null,
              summary: "Claim email with no identifiable shipment or details.",
              customer_states_no_photos: false,
              consequential_loss_mentioned: false,
            },
          ];
    const consequentialInEmail = detectConsequentialLoss(emailText);
    for (const c of claims) {
      const notes: string[] = [];
      const id = groundShipmentId(c.shipment_id_raw, emailText, normaliseShipmentId);
      if (!id.grounded)
        notes.push(`E2: extracted shipment id "${c.shipment_id_raw}" does not appear in the email; ignored.`);
      const amt = groundAmount(c.claimed_amount_inr, emailText);
      if (!amt.grounded)
        notes.push(
          `E2: extracted amount ${c.claimed_amount_inr} does not appear in the email; treated as not stated.`,
        );
      units.push({
        claim: {
          ...c,
          shipment_id_raw: id.raw,
          claimed_amount_inr: amt.amount,
          // can only make the outcome stricter
          consequential_loss_mentioned: c.consequential_loss_mentioned || consequentialInEmail,
        },
        notes,
      });
    }
  }

  const rows: ResultRow[] = [];
  const details: ClaimDetail[] = [];
  const audits: AuditEntry[] = [];
  const decidedInThisEmail: PriorClaim[] = [];
  const processed_at = now();

  for (const unit of units) {
    const claim = unit.claim;
    const norm = claim ? normaliseShipmentId(claim.shipment_id_raw) : { id: null, corrected: false };
    let lookup: LookupResult | null = null;
    let prior: PriorClaimsResult = { status: "ok", claims: [] };

    if (claim && norm.id) {
      lookup = await safeLookupShipment(deps, norm.id);
      if (lookup.status === "found") {
        const canonical = lookup.shipment.shipment_id;
        prior = await safePriorClaims(deps, canonical);
        if (prior.status === "ok") {
          const sameEmail = decidedInThisEmail.filter(
            (p) => p.shipment_id.toUpperCase() === canonical.toUpperCase(),
          );
          prior = { status: "ok", claims: [...prior.claims, ...sameEmail] };
        }
      }
    }

    const engineInput: EngineInput = {
      is_claim: extraction.is_claim,
      email: {
        date: email.date,
        sender_email: email.sender_email,
        sender_domain: email.sender_domain,
        image_attachments: email.image_attachments,
      },
      claim,
      shipment_id_normalised: norm.id,
      shipment_id_corrected: norm.corrected,
      lookup,
      prior_claims: prior,
      policy: deps.policy,
    };

    /* ---- DECIDE (pure, deterministic) ---- */
    const decision = enforceInvariants(decide(engineInput), engineInput);

    const shipment_id =
      lookup?.status === "found"
        ? lookup.shipment.shipment_id
        : (norm.id ??
          claim?.shipment_id_raw ??
          (claim ? "" : (normaliseShipmentId(findShipmentIdMention(emailText)).id ?? "")));

    /* ---- DRAFT (LLM words it; cannot change it) ---- */
    const draftInput: DraftInput = {
      claim_id,
      shipment_id,
      decision: decision.decision,
      approved_amount_inr: decision.approved_amount_inr,
      customer_reason: decision.customer_reason,
      required_reply_tokens: decision.required_reply_tokens,
      missing_info: decision.missing_info,
      language: extraction.language,
      customer_name: extraction.customer_name,
      claim_type: claim?.claim_type ?? null,
      prior_claim: decision.prior_claim,
    };
    let draft_reply: string;
    try {
      draft_reply = await deps.drafter.draft(draftInput);
    } catch {
      draft_reply = renderTemplateReply(draftInput);
    }

    const reason = [decision.reason, ...unit.notes].join(" ");
    const row: ResultRow = {
      claim_id,
      shipment_id,
      decision: decision.decision,
      approved_amount_inr: decision.approved_amount_inr,
      reason,
      draft_reply,
    };
    rows.push(row);
    details.push({
      row,
      rule_ids: decision.rule_ids,
      trace: decision.trace,
      customer_reason: decision.customer_reason,
      extracted_claim: claim,
      facts: decision.facts,
    });
    audits.push({
      ts: processed_at,
      event: "decision",
      email_hash,
      claim_id,
      shipment_id,
      decision: decision.decision,
      approved_amount_inr: decision.approved_amount_inr,
      rule_ids: decision.rule_ids,
      reason,
      inputs: { email: emailSummary, language: extraction.language, engine_input: engineInput },
      config_snapshot: deps.policy,
      llm_mode,
      model,
    });
    if (
      shipment_id &&
      (decision.decision === "approve" || decision.decision === "reject" || decision.decision === "escalate")
    ) {
      decidedInThisEmail.push({
        source: "state",
        claim_id,
        shipment_id,
        decision: decision.decision,
        approved_amount_inr: decision.approved_amount_inr,
        decided_date: email.date,
        payment_ref: null,
        paid_date: null,
        notes: "earlier item in the same email",
      });
    }
  }

  /* ---- store (insert-if-absent: first writer wins) + audit ---- */
  const record: ProcessedEmail = { email_hash, claim_id, processed_at, llm_mode, model, rows, details };
  const stored = await deps.store.saveProcessed(record);
  const weWrote = stored.claim_id === record.claim_id && stored.processed_at === record.processed_at;
  if (weWrote) {
    for (const entry of audits) await deps.store.appendAudit(entry);
  }
  return toResult(stored, !weWrote);
}
