/**
 * State: processed emails (idempotency) + audit log.
 * PURE / Workers-safe: no node:* imports here. JSON-file persistence lives in ./file (Node only).
 */
import type { AuditEntry, ClaimsStore, PriorClaim, ProcessedEmail } from "../types";

/** Deep copy so callers can never mutate stored state (and stored state never aliases caller objects). */
export function deepCopy<T>(value: T): T {
  try {
    return structuredClone(value);
  } catch {
    // e.g. an audit `inputs` blob holding something non-cloneable: degrade to its JSON form.
    return JSON.parse(JSON.stringify(value)) as T;
  }
}

/** listAudit semantics: newest last; limit = last N entries; no limit = everything. */
export function lastN<T>(items: readonly T[], limit?: number): T[] {
  if (limit === undefined || limit === null || !Number.isFinite(limit)) return [...items];
  const n = Math.floor(limit);
  return n <= 0 ? [] : items.slice(-n);
}

const DECIDED = new Set<string>(["approve", "reject", "escalate"]);

/**
 * Claims already DECIDED (approve | reject | escalate) for a shipment, from processed-email records.
 * need_info / duplicate / not_a_claim rows are not decisions on the claim. Reusable by any store
 * implementation (Memory, File, Durable Object).
 */
export function priorClaimsFromProcessed(records: ProcessedEmail[], shipmentId: string): PriorClaim[] {
  const target = (shipmentId ?? "").trim().toUpperCase();
  if (target === "") return [];
  const out: PriorClaim[] = [];
  for (const record of records) {
    for (const row of record.rows) {
      if (row.shipment_id.trim().toUpperCase() !== target) continue;
      if (!DECIDED.has(row.decision)) continue;
      out.push({
        source: "state",
        claim_id: row.claim_id,
        shipment_id: row.shipment_id,
        decision: row.decision as PriorClaim["decision"],
        approved_amount_inr: row.approved_amount_inr,
        decided_date: record.processed_at.slice(0, 10) || null,
        payment_ref: null,
        paid_date: null,
        notes: null,
      });
    }
  }
  return out;
}

export class MemoryStore implements ClaimsStore {
  /** Map preserves insertion order, which is what listProcessed() promises. */
  private processed = new Map<string, ProcessedEmail>();
  private audit: AuditEntry[] = [];

  async getByEmailHash(hash: string): Promise<ProcessedEmail | null> {
    const found = this.processed.get(hash);
    return found ? deepCopy(found) : null;
  }

  async saveProcessed(record: ProcessedEmail): Promise<ProcessedEmail> {
    // No await between the check and the set: insert-if-absent is atomic within the event loop.
    const existing = this.processed.get(record.email_hash);
    if (existing) return deepCopy(existing);
    const stored = deepCopy(record);
    this.processed.set(stored.email_hash, stored);
    return deepCopy(stored);
  }

  async listProcessed(): Promise<ProcessedEmail[]> {
    return deepCopy([...this.processed.values()]);
  }

  async findDecidedByShipment(shipmentId: string): Promise<PriorClaim[]> {
    return priorClaimsFromProcessed([...this.processed.values()], shipmentId);
  }

  async appendAudit(entry: AuditEntry): Promise<void> {
    this.audit.push(deepCopy(entry));
  }

  async listAudit(limit?: number): Promise<AuditEntry[]> {
    return deepCopy(lastN(this.audit, limit));
  }

  async reset(): Promise<void> {
    this.processed = new Map();
    this.audit = [];
  }
}
