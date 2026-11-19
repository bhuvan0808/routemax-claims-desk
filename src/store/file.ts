/**
 * NODE ONLY: ClaimsStore persisted to a single JSON file (CLI runs). Never import this from Worker
 * code (and it is deliberately not re-exported from ./index).
 *
 * - Loaded lazily on first use, then served from memory.
 * - Every mutation is written atomically (temp file + rename) BEFORE memory is updated, so memory
 *   never gets ahead of disk.
 * - Mutations are serialised through one promise chain, so concurrent saveProcessed() calls in this
 *   process cannot both "win". (Single-process store: two processes sharing a file are not coordinated.)
 */
import { mkdir, readFile, rename, unlink, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { z } from "zod";
import {
  AuditEntrySchema,
  ProcessedEmailSchema,
  type AuditEntry,
  type ClaimsStore,
  type PriorClaim,
  type ProcessedEmail,
} from "../types";
import { deepCopy, lastN, priorClaimsFromProcessed } from "./index";

interface FileState {
  version: 1;
  processed: ProcessedEmail[];
  audit: AuditEntry[];
}

const FileStateSchema = z.object({
  version: z.literal(1),
  processed: z.array(ProcessedEmailSchema),
  audit: z.array(AuditEntrySchema),
});

function emptyState(): FileState {
  return { version: 1, processed: [], audit: [] };
}

function errorCode(err: unknown): string | undefined {
  return typeof err === "object" && err !== null ? (err as { code?: string }).code : undefined;
}

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

let tempCounter = 0;

export class FileStore implements ClaimsStore {
  private state: FileState | null = null;
  private queue: Promise<unknown> = Promise.resolve();

  constructor(private readonly filePath: string) {}

  /** Run `task` after every previously queued task has finished (success or failure). */
  private enqueue<T>(task: () => Promise<T>): Promise<T> {
    const run = this.queue.then(task, task);
    this.queue = run.catch(() => undefined);
    return run;
  }

  private async load(): Promise<FileState> {
    if (this.state) return this.state;
    let text: string;
    try {
      text = await readFile(this.filePath, "utf8");
    } catch (err) {
      if (errorCode(err) === "ENOENT") {
        this.state = emptyState();
        return this.state;
      }
      throw new Error(`FileStore: cannot read ${this.filePath}: ${err instanceof Error ? err.message : String(err)}`);
    }
    // A corrupt state file must fail loudly: silently starting empty would forget which emails
    // were already processed and let a claim be decided twice.
    let json: unknown;
    try {
      json = JSON.parse(text);
    } catch {
      throw new Error(`FileStore: ${this.filePath} is not valid JSON. Fix or delete it (or call reset()).`);
    }
    const parsed = FileStateSchema.safeParse(json);
    if (!parsed.success) {
      const issue = parsed.error.issues[0];
      const where = issue ? `${issue.path.map(String).join(".")}: ${issue.message}` : "unknown shape";
      throw new Error(`FileStore: ${this.filePath} has an unexpected shape (${where}). Fix or delete it (or call reset()).`);
    }
    // Keep the raw JSON (not Zod's stripped output) so nothing stored is dropped on reload.
    this.state = json as FileState;
    return this.state;
  }

  /** Write `next` atomically, then make it the in-memory state. */
  private async commit(next: FileState): Promise<void> {
    await mkdir(dirname(this.filePath), { recursive: true });
    const tmp = `${this.filePath}.${process.pid}.${tempCounter++}.tmp`;
    try {
      await writeFile(tmp, JSON.stringify(next, null, 2), "utf8");
      // On Windows a rename over a file briefly held open (antivirus, indexer) fails transiently.
      for (let attempt = 0; ; attempt++) {
        try {
          await rename(tmp, this.filePath);
          break;
        } catch (err) {
          const code = errorCode(err);
          if (attempt >= 5 || (code !== "EPERM" && code !== "EBUSY" && code !== "EACCES")) throw err;
          await sleep(20 * (attempt + 1));
        }
      }
    } catch (err) {
      await unlink(tmp).catch(() => undefined);
      throw new Error(`FileStore: cannot write ${this.filePath}: ${err instanceof Error ? err.message : String(err)}`);
    }
    this.state = next;
  }

  getByEmailHash(hash: string): Promise<ProcessedEmail | null> {
    return this.enqueue(async () => {
      const state = await this.load();
      const found = state.processed.find((r) => r.email_hash === hash);
      return found ? deepCopy(found) : null;
    });
  }

  saveProcessed(record: ProcessedEmail): Promise<ProcessedEmail> {
    return this.enqueue(async () => {
      const state = await this.load();
      const existing = state.processed.find((r) => r.email_hash === record.email_hash);
      if (existing) return deepCopy(existing);
      const stored = deepCopy(record);
      await this.commit({ ...state, processed: [...state.processed, stored] });
      return deepCopy(stored);
    });
  }

  listProcessed(): Promise<ProcessedEmail[]> {
    return this.enqueue(async () => deepCopy((await this.load()).processed));
  }

  findDecidedByShipment(shipmentId: string): Promise<PriorClaim[]> {
    return this.enqueue(async () => priorClaimsFromProcessed((await this.load()).processed, shipmentId));
  }

  appendAudit(entry: AuditEntry): Promise<void> {
    return this.enqueue(async () => {
      const state = await this.load();
      await this.commit({ ...state, audit: [...state.audit, deepCopy(entry)] });
    });
  }

  listAudit(limit?: number): Promise<AuditEntry[]> {
    return this.enqueue(async () => deepCopy(lastN((await this.load()).audit, limit)));
  }

  /** Empties the store. Does not read the old file, so it also recovers from a corrupt one. */
  reset(): Promise<void> {
    return this.enqueue(() => this.commit(emptyState()));
  }
}
