/**
 * State for the Worker: one SQLite-backed Durable Object.
 *  - ClaimsStoreDO: the object itself. Public methods are RPC and mirror ClaimsStore exactly.
 *  - DurableObjectStore: thin ClaimsStore adapter over the DO stub, used by the pipeline.
 *
 * A Durable Object is single-threaded and its SQL API is synchronous, so the
 * "check then insert" in saveProcessed cannot interleave with another request:
 * the first writer for an email hash wins and every later caller gets that record.
 */
import { DurableObject } from "cloudflare:workers";
import type { AuditEntry, ClaimsStore, PriorClaim, ProcessedEmail } from "../types";

const DO_INSTANCE_NAME = "claims-desk";

type Row = Record<string, SqlStorageValue>;

export class ClaimsStoreDO extends DurableObject<Env> implements ClaimsStore {
  private readonly sql: SqlStorage;

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    this.sql = ctx.storage.sql;
    this.sql.exec(`
      CREATE TABLE IF NOT EXISTS processed_emails (
        seq INTEGER PRIMARY KEY AUTOINCREMENT,
        email_hash TEXT UNIQUE,
        claim_id TEXT,
        processed_at TEXT,
        record_json TEXT
      );
      CREATE TABLE IF NOT EXISTS decisions (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        email_hash TEXT,
        claim_id TEXT,
        shipment_id TEXT,
        decision TEXT,
        approved_amount_inr INTEGER,
        reason TEXT,
        draft_reply TEXT,
        rule_ids TEXT,
        processed_at TEXT
      );
      CREATE INDEX IF NOT EXISTS idx_decisions_shipment ON decisions (shipment_id);
      CREATE TABLE IF NOT EXISTS audit_log (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        ts TEXT,
        event TEXT,
        email_hash TEXT,
        claim_id TEXT,
        shipment_id TEXT,
        entry_json TEXT
      );
    `);
  }

  private readByHash(hash: string): ProcessedEmail | null {
    const rows = this.sql
      .exec<Row>("SELECT record_json FROM processed_emails WHERE email_hash = ? LIMIT 1", hash)
      .toArray();
    return rows.length > 0 ? (JSON.parse(String(rows[0].record_json)) as ProcessedEmail) : null;
  }

  async getByEmailHash(hash: string): Promise<ProcessedEmail | null> {
    return this.readByHash(hash);
  }

  /** Insert-if-absent keyed by email_hash; returns the canonical stored record. */
  async saveProcessed(record: ProcessedEmail): Promise<ProcessedEmail> {
    const existing = this.readByHash(record.email_hash);
    if (existing) return existing;

    this.ctx.storage.transactionSync(() => {
      this.sql.exec(
        "INSERT INTO processed_emails (email_hash, claim_id, processed_at, record_json) VALUES (?, ?, ?, ?)",
        record.email_hash,
        record.claim_id,
        record.processed_at,
        JSON.stringify(record),
      );
      record.rows.forEach((row, i) => {
        this.sql.exec(
          `INSERT INTO decisions
             (email_hash, claim_id, shipment_id, decision, approved_amount_inr, reason, draft_reply, rule_ids, processed_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          record.email_hash,
          row.claim_id,
          row.shipment_id,
          row.decision,
          Math.round(row.approved_amount_inr),
          row.reason,
          row.draft_reply,
          JSON.stringify(record.details[i]?.rule_ids ?? []),
          record.processed_at,
        );
      });
    });
    return this.readByHash(record.email_hash) ?? record;
  }

  async listProcessed(): Promise<ProcessedEmail[]> {
    return this.sql
      .exec<Row>("SELECT record_json FROM processed_emails ORDER BY seq ASC")
      .toArray()
      .map((r) => JSON.parse(String(r.record_json)) as ProcessedEmail);
  }

  /** Decided (approve | reject | escalate) claims already in state for this shipment. need_info is not "decided". */
  async findDecidedByShipment(shipmentId: string): Promise<PriorClaim[]> {
    const rows = this.sql
      .exec<Row>(
        `SELECT claim_id, shipment_id, decision, approved_amount_inr, processed_at
           FROM decisions
          WHERE UPPER(shipment_id) = UPPER(?)
            AND decision IN ('approve', 'reject', 'escalate')
          ORDER BY id ASC`,
        shipmentId.trim(),
      )
      .toArray();
    return rows.map((r) => ({
      source: "state" as const,
      claim_id: String(r.claim_id),
      shipment_id: String(r.shipment_id),
      decision: String(r.decision) as PriorClaim["decision"],
      approved_amount_inr: Number(r.approved_amount_inr ?? 0),
      decided_date: r.processed_at ? String(r.processed_at).slice(0, 10) : null,
      payment_ref: null,
      paid_date: null,
      notes: null,
    }));
  }

  async appendAudit(entry: AuditEntry): Promise<void> {
    this.sql.exec(
      "INSERT INTO audit_log (ts, event, email_hash, claim_id, shipment_id, entry_json) VALUES (?, ?, ?, ?, ?, ?)",
      entry.ts,
      entry.event,
      entry.email_hash,
      entry.claim_id,
      entry.shipment_id,
      JSON.stringify(entry),
    );
  }

  /** Newest last. limit = last N entries (all when omitted). */
  async listAudit(limit?: number): Promise<AuditEntry[]> {
    const hasLimit = typeof limit === "number" && Number.isFinite(limit) && limit > 0;
    const rows = hasLimit
      ? this.sql
          .exec<Row>(
            "SELECT entry_json FROM (SELECT id, entry_json FROM audit_log ORDER BY id DESC LIMIT ?) ORDER BY id ASC",
            Math.floor(limit as number),
          )
          .toArray()
      : this.sql.exec<Row>("SELECT entry_json FROM audit_log ORDER BY id ASC").toArray();
    return rows.map((r) => JSON.parse(String(r.entry_json)) as AuditEntry);
  }

  async reset(): Promise<void> {
    this.ctx.storage.transactionSync(() => {
      this.sql.exec("DELETE FROM processed_emails");
      this.sql.exec("DELETE FROM decisions");
      this.sql.exec("DELETE FROM audit_log");
    });
  }
}

/** ClaimsStore over Durable Object RPC. Every call is forwarded to the single "claims-desk" object. */
export class DurableObjectStore implements ClaimsStore {
  private readonly stub: ClaimsStore;

  constructor(env: Env) {
    // The RPC stub exposes the DO's public methods; all payloads are plain JSON data.
    this.stub = env.CLAIMS_DO.get(env.CLAIMS_DO.idFromName(DO_INSTANCE_NAME)) as unknown as ClaimsStore;
  }

  async getByEmailHash(hash: string): Promise<ProcessedEmail | null> {
    return await this.stub.getByEmailHash(hash);
  }
  async saveProcessed(record: ProcessedEmail): Promise<ProcessedEmail> {
    return await this.stub.saveProcessed(record);
  }
  async listProcessed(): Promise<ProcessedEmail[]> {
    return await this.stub.listProcessed();
  }
  async findDecidedByShipment(shipmentId: string): Promise<PriorClaim[]> {
    return await this.stub.findDecidedByShipment(shipmentId);
  }
  async appendAudit(entry: AuditEntry): Promise<void> {
    await this.stub.appendAudit(entry);
  }
  async listAudit(limit?: number): Promise<AuditEntry[]> {
    return await this.stub.listAudit(limit);
  }
  async reset(): Promise<void> {
    await this.stub.reset();
  }
}
