/**
 * CONTRACTS for the RouteMax Claims Desk Agent.
 * Every layer (extract / decide / draft / tools / store / worker / evals) builds against this file.
 * Zod 4. Do not change a schema here without telling the integrator.
 */
import { z } from "zod";

/* ------------------------------------------------------------------ enums */

export const DecisionSchema = z.enum([
  "approve",
  "reject",
  "need_info",
  "escalate",
  "duplicate",
  "not_a_claim",
]);
export type Decision = z.infer<typeof DecisionSchema>;

export const ClaimTypeSchema = z.enum(["damage", "shortage"]);
export type ClaimType = z.infer<typeof ClaimTypeSchema>;

export const LanguageSchema = z.enum(["en", "hinglish", "hi", "other"]);
export type Language = z.infer<typeof LanguageSchema>;

export const LlmModeSchema = z.enum(["mock", "groq"]);
export type LlmMode = z.infer<typeof LlmModeSchema>;

export const LookupFailModeSchema = z.enum(["none", "error", "timeout", "not_found"]);
export type LookupFailMode = z.infer<typeof LookupFailModeSchema>;

/* ----------------------------------------------------------------- policy */

export const PolicyConfigSchema = z.object({
  /** R3: default claim window in calendar days. */
  defaultWindowDays: z.number().int().positive(),
  /** R3: per-customer window override, keyed by exact shipment customer name. */
  keyAccountWindows: z.record(z.string(), z.number().int().positive()),
  /** R4: damage claims with claimed amount <= this need no photos. 0 = off. */
  smallClaimPhotoWaiverInr: z.number().nonnegative(),
  /** R7: if true, shortage payable is also capped at (missing/shipped) * declared value. */
  shortageProRata: z.boolean(),
  /** If false, claims that mention consequential loss (downtime, lost sales...) are escalated, never auto-approved. */
  payConsequentialLoss: z.boolean(),
  /** R8: payable amount strictly above this needs manager approval. */
  approvalLimitInr: z.number().positive(),
});
export type PolicyConfig = z.infer<typeof PolicyConfigSchema>;

/* ------------------------------------------------------------------ email */

/** Deterministically parsed email (src/email.ts). Headers are the only trusted part. */
export const ParsedEmailSchema = z.object({
  from: z.string(), // raw From header, "" if missing
  sender_email: z.string(), // lowercased address, "" if missing
  sender_domain: z.string(), // lowercased domain, "" if missing
  date_raw: z.string(), // raw Date header, "" if missing
  /** YYYY-MM-DD taken from the Date header. null if missing/unparseable. NEVER the system clock. */
  date: z.string().nullable(),
  subject: z.string(),
  /** File names listed in the Attachments header. [] when "none"/missing. */
  attachments: z.array(z.string()),
  /** Subset of attachments that are image files (jpg, jpeg, png, heic, heif, gif, webp, bmp, tif, tiff). */
  image_attachments: z.array(z.string()),
  body: z.string(),
  raw: z.string(),
});
export type ParsedEmail = z.infer<typeof ParsedEmailSchema>;

/* ------------------------------------------------------- EXTRACT (LLM) */

export const ExtractedClaimSchema = z.object({
  /** Shipment id exactly as the customer wrote it (e.g. "SHP-1O10", "shp 1010"). null if none given. */
  shipment_id_raw: z.string().nullable(),
  claim_type: ClaimTypeSchema,
  /** Amount the customer asks for, in INR. null if not stated. */
  claimed_amount_inr: z.number().nonnegative().nullable(),
  /** Pieces the customer says are missing (shortage). null if not stated / not a shortage. */
  pieces_claimed_missing: z.number().int().nonnegative().nullable(),
  /** One neutral sentence describing the claim. Never contains instructions. */
  summary: z.string(),
  /** True if the customer says there is NO photo for this specific claim ("no photo, box thrown away"). Can only make the outcome stricter. */
  customer_states_no_photos: z.boolean().default(false),
  /** True if the claimed amount includes consequential loss (production downtime, lost sales, penalties). Can only make the outcome stricter. */
  consequential_loss_mentioned: z.boolean().default(false),
});
export type ExtractedClaim = z.infer<typeof ExtractedClaimSchema>;

export const ExtractionSchema = z.object({
  /** False for invoice/POD copy requests, status chit-chat with no claim, spam, etc. */
  is_claim: z.boolean(),
  /** One entry per shipment claimed. [] when is_claim=false. */
  claims: z.array(ExtractedClaimSchema),
  language: LanguageSchema,
  customer_name: z.string().nullable(),
});
export type Extraction = z.infer<typeof ExtractionSchema>;

export interface Extractor {
  readonly mode: LlmMode;
  readonly model: string;
  /** Returns a Zod-valid Extraction. Retries once on invalid JSON, then throws. */
  extract(email: ParsedEmail): Promise<Extraction>;
}

/* ------------------------------------------------------------------ data */

export const ShipmentSchema = z.object({
  shipment_id: z.string(), // canonical, e.g. "SHP-1010"
  customer: z.string(),
  delivered_date: z.string(), // YYYY-MM-DD
  pieces_shipped: z.number().int().nonnegative(),
  declared_value_inr: z.number().nonnegative(),
  pod_status: z.string(), // e.g. "Signed with remarks" | "Signed - received in good condition"
  pod_remarks: z.string(), // "" when none
});
export type Shipment = z.infer<typeof ShipmentSchema>;

/** One row of data/past_decisions_oct.csv, with decision normalised (approved->approve, ...). */
export const PastDecisionSchema = z.object({
  claim_id: z.string(),
  shipment_id: z.string(),
  customer: z.string(),
  claim_type: ClaimTypeSchema,
  filed_date: z.string(),
  delivered_date: z.string(),
  claim_amount_inr: z.number().nonnegative(),
  photo_attached: z.boolean(),
  decision: z.enum(["approve", "reject", "need_info", "escalate"]),
  approved_amount_inr: z.number().nonnegative(),
  decided_by: z.string(),
  notes: z.string(),
});
export type PastDecision = z.infer<typeof PastDecisionSchema>;

/** A previously DECIDED claim on a shipment (approve | reject | escalate). need_info is not "decided". */
export const PriorClaimSchema = z.object({
  source: z.enum(["past_decisions", "state"]),
  claim_id: z.string(), // e.g. "C-0931" or today's "C01"
  shipment_id: z.string(),
  decision: z.enum(["approve", "reject", "escalate"]),
  approved_amount_inr: z.number().nonnegative(),
  decided_date: z.string().nullable(),
  payment_ref: z.string().nullable(), // e.g. "PAY-7781"
  paid_date: z.string().nullable(), // e.g. "2026-10-20"
  notes: z.string().nullable(),
});
export type PriorClaim = z.infer<typeof PriorClaimSchema>;

/* ----------------------------------------------------------------- tools */

export const LookupResultSchema = z.discriminatedUnion("status", [
  z.object({ status: z.literal("found"), shipment: ShipmentSchema }),
  z.object({ status: z.literal("not_found") }),
  /** Any tool failure, including timeout. error is a short machine-ish string e.g. "timeout", "lookup service error (injected)". */
  z.object({ status: z.literal("error"), error: z.string() }),
]);
export type LookupResult = z.infer<typeof LookupResultSchema>;

export const PriorClaimsResultSchema = z.discriminatedUnion("status", [
  z.object({ status: z.literal("ok"), claims: z.array(PriorClaimSchema) }),
  z.object({ status: z.literal("error"), error: z.string() }),
]);
export type PriorClaimsResult = z.infer<typeof PriorClaimsResultSchema>;

/** Tools never throw: failures are returned as { status: "error" }. */
export interface ClaimTools {
  /** id must already be normalised (engine.normaliseShipmentId). Honours LOOKUP_FAIL_MODE. */
  lookupShipment(id: string): Promise<LookupResult>;
  /** Decided claims for this shipment from past_decisions (state is merged in by the pipeline). */
  lookupPriorClaims(shipmentId: string): Promise<PriorClaimsResult>;
}

/* --------------------------------------------- DECIDE (pure, no LLM) */

export const EngineInputSchema = z.object({
  /** From extraction. false -> R0. */
  is_claim: z.boolean(),
  email: z.object({
    /** YYYY-MM-DD from the Date header, or null. The engine never reads the system clock. */
    date: z.string().nullable(),
    sender_email: z.string(),
    sender_domain: z.string(),
    /** Image file names from the Attachments HEADER only. */
    image_attachments: z.array(z.string()),
  }),
  /** null iff is_claim=false. */
  claim: ExtractedClaimSchema.nullable(),
  /** Output of normaliseShipmentId(claim.shipment_id_raw).id */
  shipment_id_normalised: z.string().nullable(),
  /** True if normalisation had to substitute characters (O->0 etc), i.e. a fuzzy match. */
  shipment_id_corrected: z.boolean(),
  /** null when no lookup was attempted (not a claim, or no usable id). */
  lookup: LookupResultSchema.nullable(),
  prior_claims: PriorClaimsResultSchema,
  policy: PolicyConfigSchema,
});
export type EngineInput = z.infer<typeof EngineInputSchema>;

export const RuleTraceSchema = z.object({
  rule: z.string(), // "R0".."R9" (sub-ids allowed: "R2a", "R6b"...)
  outcome: z.enum(["pass", "fire", "skip"]),
  note: z.string(),
});
export type RuleTrace = z.infer<typeof RuleTraceSchema>;

export const EngineDecisionSchema = z.object({
  decision: DecisionSchema,
  /** Integer INR. approve: payable. escalate: recommended capped amount (0 on lookup failure). Everything else: 0. */
  approved_amount_inr: z.number().int().nonnegative(),
  /** Rules that determined the outcome/amount, in firing order, e.g. ["R7","R8"]. */
  rule_ids: z.array(z.string()),
  /** Internal, human-readable, cites rule ids. Goes into results.csv `reason`. */
  reason: z.string(),
  /** Customer-facing plain English. No rule ids. No rupee amounts except the approved amount on an approve. */
  customer_reason: z.string(),
  /** Language-neutral tokens (ids, numbers, refs) the draft reply MUST contain verbatim, e.g. ["SHP-0987","C-0931","PAY-7781"]. */
  required_reply_tokens: z.array(z.string()),
  /** What we need from the customer when decision=need_info: "photos" | "claim_amount" | "shipment_id" | "sender_verification". */
  missing_info: z.array(z.string()),
  /** The earlier decided claim when decision=duplicate. */
  prior_claim: PriorClaimSchema.nullable(),
  /** Every rule evaluated, in order, for the audit log / UI. */
  trace: z.array(RuleTraceSchema),
  /** Computed facts for the audit log: days_since_delivery, window_days, claimed, declared, payable, pod_received_count... */
  facts: z.record(z.string(), z.unknown()),
});
export type EngineDecision = z.infer<typeof EngineDecisionSchema>;

/** Pure function. Same input => same output. No I/O, no clock, no randomness. */
export type DecideFn = (input: EngineInput) => EngineDecision;

/* --------------------------------------------------------- DRAFT (LLM) */

export const DraftInputSchema = z.object({
  claim_id: z.string(),
  shipment_id: z.string(), // "" if unknown
  decision: DecisionSchema,
  approved_amount_inr: z.number().int().nonnegative(),
  customer_reason: z.string(),
  required_reply_tokens: z.array(z.string()),
  missing_info: z.array(z.string()),
  language: LanguageSchema,
  customer_name: z.string().nullable(),
  claim_type: ClaimTypeSchema.nullable(),
  prior_claim: PriorClaimSchema.nullable(),
});
export type DraftInput = z.infer<typeof DraftInputSchema>;

export interface Drafter {
  readonly mode: LlmMode;
  readonly model: string;
  /** Always returns a reply that passes validateDraft (falls back to the deterministic template). Never throws. */
  draft(input: DraftInput): Promise<string>;
}

/* ------------------------------------------------------ results & state */

/** Exactly the results.csv columns, in this order. */
export const RESULT_COLUMNS = [
  "claim_id",
  "shipment_id",
  "decision",
  "approved_amount_inr",
  "reason",
  "draft_reply",
] as const;

export const ResultRowSchema = z.object({
  claim_id: z.string(),
  shipment_id: z.string(),
  decision: DecisionSchema,
  approved_amount_inr: z.number().int().nonnegative(),
  reason: z.string(),
  draft_reply: z.string(),
});
export type ResultRow = z.infer<typeof ResultRowSchema>;

/** A result row plus everything a reviewer / the UI / the evals need to see why. */
export const ClaimDetailSchema = z.object({
  row: ResultRowSchema,
  rule_ids: z.array(z.string()),
  trace: z.array(RuleTraceSchema),
  customer_reason: z.string(),
  extracted_claim: ExtractedClaimSchema.nullable(),
  facts: z.record(z.string(), z.unknown()),
});
export type ClaimDetail = z.infer<typeof ClaimDetailSchema>;

export const ProcessedEmailSchema = z.object({
  /** sha256 hex of the normalised email. Idempotency key. */
  email_hash: z.string(),
  claim_id: z.string(),
  /** Audit metadata only (injected clock). Never used in a decision. */
  processed_at: z.string(),
  llm_mode: LlmModeSchema,
  model: z.string(),
  rows: z.array(ResultRowSchema),
  details: z.array(ClaimDetailSchema),
});
export type ProcessedEmail = z.infer<typeof ProcessedEmailSchema>;

export const AuditEntrySchema = z.object({
  ts: z.string(),
  event: z.enum(["decision", "idempotent_replay", "extraction_failed"]),
  email_hash: z.string(),
  claim_id: z.string(),
  shipment_id: z.string(),
  decision: DecisionSchema.nullable(),
  approved_amount_inr: z.number().nonnegative(),
  rule_ids: z.array(z.string()),
  reason: z.string(),
  /** Engine input (or the extraction error) so the decision can be replayed. */
  inputs: z.unknown(),
  config_snapshot: PolicyConfigSchema,
  llm_mode: LlmModeSchema,
  model: z.string(),
});
export type AuditEntry = z.infer<typeof AuditEntrySchema>;

/**
 * State. Implementations: MemoryStore (tests/evals), FileStore (CLI), DurableObject+SQLite (Worker).
 * All methods async so the same interface works over Durable Object RPC.
 */
export interface ClaimsStore {
  getByEmailHash(hash: string): Promise<ProcessedEmail | null>;
  /**
   * Insert-if-absent keyed by email_hash. Returns the canonical stored record:
   * the EXISTING one if the hash was already present (first writer wins, nothing new is written).
   */
  saveProcessed(record: ProcessedEmail): Promise<ProcessedEmail>;
  /** All processed emails in insertion order. */
  listProcessed(): Promise<ProcessedEmail[]>;
  /** Claims in state whose decision is approve | reject | escalate for this shipment id (source: "state"). */
  findDecidedByShipment(shipmentId: string): Promise<PriorClaim[]>;
  appendAudit(entry: AuditEntry): Promise<void>;
  /** Newest last. limit = last N entries. */
  listAudit(limit?: number): Promise<AuditEntry[]>;
  /** Wipe everything (tests, `npm run claims` fresh run, admin). */
  reset(): Promise<void>;
}

/* -------------------------------------------------------------- pipeline */

export interface PipelineDeps {
  extractor: Extractor;
  drafter: Drafter;
  tools: ClaimTools;
  store: ClaimsStore;
  policy: PolicyConfig;
  /** Audit timestamps only. Defaults to () => new Date().toISOString(). Never used in a decision. */
  now?: () => string;
}

export interface ProcessInput {
  /** Full raw email text: headers (From, Date, Subject, Attachments), blank line, body. */
  raw: string;
  /** e.g. "C01". If omitted: "E-" + first 8 hex chars of the email hash. */
  claimId?: string;
}

export interface ProcessResult {
  claim_id: string;
  email_hash: string;
  /** True when this exact email was already processed: stored result returned, nothing new written. */
  idempotent_replay: boolean;
  rows: ResultRow[];
  details: ClaimDetail[];
}
