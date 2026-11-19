/**
 * Seed-data loaders (pure CSV text -> validated rows) and the lookup tools with failure injection.
 * PURE / Workers-safe: no node:* imports here. File reading lives in ./node-loader (Node only).
 */
import { appConfig } from "../config";
import { parseCsv } from "../csv";
import {
  PastDecisionSchema,
  ShipmentSchema,
  type ClaimTools,
  type LookupFailMode,
  type LookupResult,
  type PastDecision,
  type PriorClaim,
  type PriorClaimsResult,
  type Shipment,
} from "../types";

export interface SeedData {
  shipments: Shipment[];
  pastDecisions: PastDecision[];
}

/* ---------------------------------------------------------------- loaders */

const SHIPMENT_COLUMNS = [
  "shipment_id",
  "customer",
  "delivered_date",
  "pieces_shipped",
  "declared_value_inr",
  "pod_status",
  "pod_remarks",
] as const;

const PAST_DECISION_COLUMNS = [
  "claim_id",
  "shipment_id",
  "customer",
  "claim_type",
  "filed_date",
  "delivered_date",
  "claim_amount_inr",
  "photo_attached",
  "decision",
  "approved_amount_inr",
  "decided_by",
  "notes",
] as const;

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

const DECISION_MAP: Record<string, PastDecision["decision"]> = {
  approved: "approve",
  approve: "approve",
  rejected: "reject",
  reject: "reject",
  escalated: "escalate",
  escalate: "escalate",
  need_info: "need_info",
};

/** Strict numeric parse: "" / "12abc" / "1,000" become NaN so Zod rejects the row. */
function toNumber(value: string): number {
  return /^\d+(\.\d+)?$/.test(value) ? Number(value) : Number.NaN;
}

function toBoolean(value: string): boolean | string {
  const v = value.toLowerCase();
  if (v === "yes" || v === "y" || v === "true") return true;
  if (v === "no" || v === "n" || v === "false") return false;
  return value; // left as a string so Zod reports it
}

function describeIssues(issues: ReadonlyArray<{ path: PropertyKey[]; message: string }>): string {
  return issues.map((i) => `${i.path.map(String).join(".") || "(row)"}: ${i.message}`).join("; ");
}

/** Shared scaffolding: header check + per-row conversion with a clear, located error. */
function loadRows<T>(
  file: string,
  text: string,
  columns: readonly string[],
  convert: (raw: Record<string, string>) => T,
): T[] {
  const rows = parseCsv(text);
  if (rows.length === 0) throw new Error(`${file}: no data rows found`);
  const missing = columns.filter((c) => !(c in rows[0]));
  if (missing.length > 0) throw new Error(`${file}: missing column(s): ${missing.join(", ")}`);
  return rows.map((raw, i) => {
    try {
      return convert(raw);
    } catch (err) {
      const id = raw.claim_id || raw.shipment_id || "?";
      // +2: one for the header line, one for 1-based numbering.
      throw new Error(`${file}: bad row ${i + 2} (${id}): ${err instanceof Error ? err.message : String(err)}`);
    }
  });
}

function requireText(field: string, value: string): void {
  if (value === "") throw new Error(`${field}: must not be empty`);
}

function requireDate(field: string, value: string): void {
  if (!ISO_DATE.test(value)) throw new Error(`${field}: expected YYYY-MM-DD, got "${value}"`);
}

export function parseShipmentsCsv(text: string): Shipment[] {
  const seen = new Set<string>();
  return loadRows("shipments.csv", text, SHIPMENT_COLUMNS, (raw) => {
    const parsed = ShipmentSchema.safeParse({
      shipment_id: raw.shipment_id,
      customer: raw.customer,
      delivered_date: raw.delivered_date,
      pieces_shipped: toNumber(raw.pieces_shipped),
      declared_value_inr: toNumber(raw.declared_value_inr),
      pod_status: raw.pod_status,
      pod_remarks: raw.pod_remarks ?? "",
    });
    if (!parsed.success) throw new Error(describeIssues(parsed.error.issues));
    const s = parsed.data;
    requireText("shipment_id", s.shipment_id);
    requireText("customer", s.customer);
    requireDate("delivered_date", s.delivered_date);
    const key = idKey(s.shipment_id);
    if (seen.has(key)) throw new Error(`shipment_id: duplicate "${s.shipment_id}"`);
    seen.add(key);
    return s;
  });
}

export function parsePastDecisionsCsv(text: string): PastDecision[] {
  return loadRows("past_decisions_oct.csv", text, PAST_DECISION_COLUMNS, (raw) => {
    const parsed = PastDecisionSchema.safeParse({
      claim_id: raw.claim_id,
      shipment_id: raw.shipment_id,
      customer: raw.customer,
      claim_type: raw.claim_type.toLowerCase(),
      filed_date: raw.filed_date,
      delivered_date: raw.delivered_date,
      claim_amount_inr: toNumber(raw.claim_amount_inr),
      photo_attached: toBoolean(raw.photo_attached),
      decision: DECISION_MAP[raw.decision.toLowerCase()] ?? raw.decision,
      approved_amount_inr: toNumber(raw.approved_amount_inr),
      decided_by: raw.decided_by,
      notes: raw.notes ?? "",
    });
    if (!parsed.success) throw new Error(describeIssues(parsed.error.issues));
    const p = parsed.data;
    requireText("claim_id", p.claim_id);
    requireText("shipment_id", p.shipment_id);
    requireDate("filed_date", p.filed_date);
    requireDate("delivered_date", p.delivered_date);
    return p;
  });
}

/** A past decision as a DECIDED prior claim. null for need_info (still open, not decided). */
export function pastDecisionToPriorClaim(p: PastDecision): PriorClaim | null {
  if (p.decision === "need_info") return null;
  const notes = p.notes.trim();
  const ref = /\b(PAY-\d+)\b/i.exec(notes);
  const paid = /paid\s+(\d{4}-\d{2}-\d{2})/i.exec(notes);
  return {
    source: "past_decisions",
    claim_id: p.claim_id,
    shipment_id: p.shipment_id,
    decision: p.decision,
    approved_amount_inr: p.approved_amount_inr,
    decided_date: p.filed_date || null,
    payment_ref: ref ? ref[1].toUpperCase() : null,
    paid_date: paid ? paid[1] : null,
    notes: notes === "" ? null : notes,
  };
}

/* ------------------------------------------------------------------ tools */

export interface ToolOptions {
  failMode?: LookupFailMode;
  timeoutMs?: number;
}

export class LookupTimeoutError extends Error {
  constructor(readonly timeoutMs: number) {
    super(`timeout after ${timeoutMs}ms`);
    this.name = "LookupTimeoutError";
  }
}

/**
 * Race a promise against a deadline. Rejects with LookupTimeoutError if `promise` has not settled
 * within `ms`. The deadline timer is always cleared as soon as the promise settles, so nothing is
 * left pending. It is deliberately NOT unref'd: while a caller is awaiting us the timer is the only
 * thing guaranteeing the await ever completes (an unref'd timer would let Node exit mid-await).
 */
export function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new LookupTimeoutError(ms)), ms);
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (err: unknown) => {
        clearTimeout(timer);
        reject(err);
      },
    );
  });
}

function idKey(id: string): string {
  return id.trim().toUpperCase();
}

function failure(err: unknown): string {
  const detail = err instanceof Error ? err.message : String(err);
  return `lookup failed: ${detail || "unknown error"}`;
}

/** A backend that never answers. Holds no timer and no handle, so there is nothing to leak. */
function hang<T>(): Promise<T> {
  return new Promise<T>(() => {});
}

export function createTools(data: SeedData, opts: ToolOptions = {}): ClaimTools {
  const failMode: LookupFailMode = opts.failMode ?? "none";
  const timeoutMs =
    typeof opts.timeoutMs === "number" && Number.isFinite(opts.timeoutMs) && opts.timeoutMs > 0
      ? opts.timeoutMs
      : appConfig.lookupTimeoutMs;

  const shipments = new Map<string, Shipment>();
  for (const s of data.shipments) shipments.set(idKey(s.shipment_id), s);

  const priorClaims = new Map<string, PriorClaim[]>();
  for (const p of data.pastDecisions) {
    const claim = pastDecisionToPriorClaim(p);
    if (!claim) continue;
    const key = idKey(p.shipment_id);
    const list = priorClaims.get(key);
    if (list) list.push(claim);
    else priorClaims.set(key, [claim]);
  }

  async function fetchShipment(id: string): Promise<LookupResult> {
    if (failMode === "error") throw new Error("shipment service error (injected)");
    if (failMode === "timeout") return hang<LookupResult>();
    if (failMode === "not_found") return { status: "not_found" };
    const shipment = shipments.get(idKey(id));
    return shipment ? { status: "found", shipment: { ...shipment } } : { status: "not_found" };
  }

  async function fetchPriorClaims(shipmentId: string): Promise<PriorClaimsResult> {
    const claims = priorClaims.get(idKey(shipmentId)) ?? [];
    return { status: "ok", claims: claims.map((c) => ({ ...c })) };
  }

  return {
    async lookupShipment(id: string): Promise<LookupResult> {
      try {
        return await withTimeout(fetchShipment(id), timeoutMs);
      } catch (err) {
        return { status: "error", error: failure(err) };
      }
    },
    async lookupPriorClaims(shipmentId: string): Promise<PriorClaimsResult> {
      try {
        return await withTimeout(fetchPriorClaims(shipmentId), timeoutMs);
      } catch (err) {
        return { status: "error", error: failure(err) };
      }
    },
  };
}
