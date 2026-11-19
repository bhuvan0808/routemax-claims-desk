/**
 * Eval harness: `npm run eval` = `tsx evals/run.ts [--mode mock|groq|both] [--suite A,B,C,D,E]`
 *
 *   A  golden set: the 15 real emails, default policy, one shared store
 *   B  config variants: photo waiver 5000, shortage pro-rata
 *   C  regression vs data/past_decisions_oct.csv through decide() (no LLM)
 *   D  risk cases: evals/cases/*.txt + evals/cases/index.ts
 *   E  suite A again in groq mode (own run file), only when GROQ_API_KEY is set
 *
 * Every run (passing or failing) writes eval_runs/<timestamp>-<mode>.json + .summary.md and never
 * overwrites an earlier run. Exit code is 1 if any case failed.
 */
import { execSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { parseCsv } from "../src/csv";
import { findInrAmounts } from "../src/format";
import { defaultPolicy, resolvePolicy } from "../src/policy.config";
import type {
  ClaimDetail,
  ClaimType,
  Decision,
  DraftInput,
  EngineInput,
  Language,
  LlmMode,
  LookupFailMode,
  PipelineDeps,
  PolicyConfig,
  ProcessResult,
  ResultRow,
  Shipment,
} from "../src/types";
import { riskCases, type ExpectedRow, type RiskCase } from "./cases/index";

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const CASES_DIR = join(ROOT, "evals", "cases");
const RUNS_DIR = join(ROOT, "eval_runs");
const GOLDEN_DIR = join(ROOT, "data", "claim_emails");

/* ------------------------------------------------------------ module loading */
// Loaded dynamically so that a broken/missing module fails the cases that need it (and the run is
// still written) instead of crashing the harness before anything is recorded.

type PipelineMod = typeof import("../src/pipeline");
type LocalMod = typeof import("../src/runtime/local");
type EngineMod = typeof import("../src/engine");
type LlmMod = typeof import("../src/llm");

interface Mods {
  pipeline?: PipelineMod;
  local?: LocalMod;
  engine?: EngineMod;
  llm?: LlmMod;
  errors: Record<string, string>;
}

function errText(e: unknown): string {
  if (e instanceof Error) return (e.stack ?? e.message).split("\n").slice(0, 4).join(" | ");
  return String(e);
}

async function loadMods(): Promise<Mods> {
  const mods: Mods = { errors: {} };
  try {
    mods.pipeline = await import("../src/pipeline");
  } catch (e) {
    mods.errors.pipeline = errText(e);
  }
  try {
    mods.local = await import("../src/runtime/local");
  } catch (e) {
    mods.errors.local = errText(e);
  }
  try {
    mods.engine = await import("../src/engine");
  } catch (e) {
    mods.errors.engine = errText(e);
  }
  try {
    mods.llm = await import("../src/llm");
  } catch (e) {
    mods.errors.llm = errText(e);
  }
  return mods;
}

function need<K extends "pipeline" | "local" | "engine" | "llm">(mods: Mods, key: K): NonNullable<Mods[K]> {
  const m = mods[key];
  if (!m) throw new Error(`module src/${key} could not be loaded: ${mods.errors[key] ?? "unknown error"}`);
  return m as NonNullable<Mods[K]>;
}

/* ------------------------------------------------------------------- results */

interface CaseResult {
  id: string;
  suite: string;
  description: string;
  expected: unknown;
  actual: unknown;
  pass: boolean;
  failures: string[];
  rules_fired: string[];
  /** The policy used for this case. */
  config: PolicyConfig;
  fail_mode: LookupFailMode;
  notes: string;
  /** Suite C only: disagreement with the humans that is documented in KNOWN_DEVIATIONS. */
  known_deviation?: boolean;
}

interface SuiteResult {
  suite: string;
  title: string;
  passed: number;
  failed: number;
  cases: CaseResult[];
  /** Suite C only. */
  agreement?: { rows: number; agree: number; known_deviations: number; unexpected: number; rate_pct: number };
}

interface ActualRow {
  claim_id: string;
  shipment_id: string;
  decision: Decision;
  approved_amount_inr: number;
  reason: string;
  draft_reply: string;
  rule_ids: string[];
}

let seenModel: Partial<Record<LlmMode, string>> = {};

function logCase(c: CaseResult): void {
  const tag = c.pass ? "PASS" : "FAIL";
  const extra = c.known_deviation ? "  [known deviation]" : "";
  console.log(`${tag}  ${c.suite}/${c.id}  ${c.description}${extra}`);
  if (!c.pass) for (const f of c.failures) console.log(`        - ${f}`);
}

function withTimeout<T>(p: Promise<T>, ms: number, what: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const t = setTimeout(() => reject(new Error(`${what} did not finish within ${ms} ms`)), ms);
    t.unref?.();
    p.then(
      (v) => {
        clearTimeout(t);
        resolve(v);
      },
      (e) => {
        clearTimeout(t);
        reject(e);
      },
    );
  });
}

/* -------------------------------------------------------------------- checks */

function actualRows(result: ProcessResult): ActualRow[] {
  return result.rows.map((r, i) => ({
    claim_id: r.claim_id,
    shipment_id: r.shipment_id,
    decision: r.decision,
    approved_amount_inr: r.approved_amount_inr,
    reason: r.reason,
    draft_reply: r.draft_reply,
    rule_ids: result.details?.[i]?.rule_ids ?? [],
  }));
}

function rulesFired(result: ProcessResult): string[] {
  const out: string[] = [];
  for (const d of result.details ?? []) for (const r of d.rule_ids ?? []) if (!out.includes(r)) out.push(r);
  return out;
}

/** Global invariants on a row: money can only exist on approve / escalate. */
function invariantFailures(row: ResultRow, label: string): string[] {
  const f: string[] = [];
  const a = row.approved_amount_inr;
  if (!Number.isInteger(a) || a < 0) f.push(`${label}: amount ${a} is not a non-negative integer`);
  if (["reject", "need_info", "duplicate", "not_a_claim"].includes(row.decision) && a !== 0)
    f.push(`${label}: ${row.decision} must have amount 0, got ${a}`);
  if (row.decision === "approve" && !(a > 0)) f.push(`${label}: approve must have amount > 0, got ${a}`);
  return f;
}

/** Reply check: non-empty, states decision + reason (validateDraft), and no rupee amount other than the approved one. */
function replyFailures(
  row: ResultRow,
  detail: ClaimDetail | undefined,
  mods: Mods,
  language: Language,
  label: string,
): string[] {
  const f: string[] = [];
  const draft = row.draft_reply ?? "";
  if (draft.trim() === "") {
    f.push(`${label}: draft reply is empty`);
    return f;
  }
  if (!detail) {
    f.push(`${label}: no ClaimDetail for this row, cannot rebuild the draft input`);
  } else {
    const input: DraftInput = {
      claim_id: row.claim_id,
      shipment_id: row.shipment_id,
      decision: row.decision,
      approved_amount_inr: row.approved_amount_inr,
      customer_reason: detail.customer_reason,
      required_reply_tokens: row.shipment_id ? [row.shipment_id] : [],
      missing_info: [],
      language,
      customer_name: null,
      claim_type: detail.extracted_claim?.claim_type ?? null,
      prior_claim: null,
    };
    try {
      const v = need(mods, "llm").validateDraft(draft, input);
      if (!v.ok) f.push(`${label}: validateDraft failed: ${v.problems.join("; ")}`);
    } catch (e) {
      f.push(`${label}: validateDraft threw: ${errText(e)}`);
    }
  }
  const amounts = findInrAmounts(draft);
  if (row.decision === "approve") {
    if (!amounts.includes(row.approved_amount_inr))
      f.push(`${label}: draft of an approve does not state the approved amount ${row.approved_amount_inr} (found: ${JSON.stringify(amounts)})`);
    const others = amounts.filter((a) => a !== row.approved_amount_inr);
    if (others.length) f.push(`${label}: draft contains rupee amounts other than the approved one: ${JSON.stringify(others)}`);
  } else if (amounts.length) {
    f.push(`${label}: draft of a ${row.decision} contains rupee amounts ${JSON.stringify(amounts)}`);
  }
  return f;
}

const has = (hay: string, needle: string) => hay.toLowerCase().includes(needle.toLowerCase());

/** Compare a ProcessResult to the expected rows + invariants + reply check. Returns failure messages. */
function checkResult(result: ProcessResult, expected: ExpectedRow[], mods: Mods, language: Language): string[] {
  const f: string[] = [];
  const rows = result.rows ?? [];
  if (rows.length !== expected.length) f.push(`expected ${expected.length} row(s), got ${rows.length}`);

  // Match expected rows to actual rows by shipment id when possible, else by position.
  const used = new Set<number>();
  expected.forEach((exp, i) => {
    let idx = -1;
    if (exp.shipment_id !== undefined) idx = rows.findIndex((r, j) => !used.has(j) && r.shipment_id === exp.shipment_id);
    if (idx < 0 && i < rows.length && !used.has(i)) idx = i;
    if (idx < 0) {
      f.push(`row ${i + 1}: missing (expected ${exp.shipment_id ?? "?"} ${exp.decision} ${exp.amount})`);
      return;
    }
    used.add(idx);
    const row = rows[idx];
    const label = `row ${i + 1}${exp.shipment_id ? ` (${exp.shipment_id})` : ""}`;
    if (exp.shipment_id !== undefined && row.shipment_id !== exp.shipment_id)
      f.push(`${label}: shipment_id expected ${exp.shipment_id}, got "${row.shipment_id}"`);
    if (row.decision !== exp.decision) f.push(`${label}: decision expected ${exp.decision}, got ${row.decision}`);
    if (row.approved_amount_inr !== exp.amount)
      f.push(`${label}: amount expected ${exp.amount}, got ${row.approved_amount_inr}`);
    for (const s of exp.reasonIncludes ?? [])
      if (!has(row.reason ?? "", s)) f.push(`${label}: reason does not mention "${s}" (reason: ${row.reason})`);
    for (const src of exp.reasonMatches ?? [])
      if (!new RegExp(src, "i").test(row.reason ?? "")) f.push(`${label}: reason does not match /${src}/i (reason: ${row.reason})`);
    for (const s of exp.draftIncludes ?? [])
      if (!has(row.draft_reply ?? "", s)) f.push(`${label}: draft does not mention "${s}"`);
    for (const s of exp.draftExcludes ?? [])
      if (has(row.draft_reply ?? "", s)) f.push(`${label}: draft must not contain "${s}"`);
  });

  rows.forEach((row, j) => {
    const label = `row ${j + 1} (${row.shipment_id || "no shipment"})`;
    if (row.claim_id !== result.claim_id) f.push(`${label}: claim_id "${row.claim_id}" differs from the email's claim_id "${result.claim_id}"`);
    f.push(...invariantFailures(row, label));
    f.push(...replyFailures(row, result.details?.[j], mods, language, label));
  });
  return f;
}

async function makeDeps(
  mods: Mods,
  mode: LlmMode,
  opts: { policyOverrides?: Partial<PolicyConfig>; failMode?: LookupFailMode; extraShipments?: Shipment[] } = {},
): Promise<PipelineDeps> {
  const failMode = opts.failMode ?? "none";
  const deps = await need(mods, "local").createLocalDeps({
    llmMode: mode,
    policyOverrides: opts.policyOverrides,
    failMode,
    extraShipments: opts.extraShipments,
    // Only shorten the timeout where a timeout is the point of the case.
    ...(failMode === "timeout" ? { lookupTimeoutMs: 50 } : {}),
  });
  seenModel[mode] = deps.extractor.model;
  return deps;
}

/* ---------------------------------------------------- suites A, B, E: golden */

const GOLDEN: Record<string, ExpectedRow[]> = {
  C01: [{ shipment_id: "SHP-1001", decision: "approve", amount: 18000 }],
  C02: [{ shipment_id: "SHP-1002", decision: "reject", amount: 0, reasonMatches: ["\\b11\\s+(?:calendar\\s+)?days?\\b"] }],
  C03: [{ shipment_id: "SHP-1003", decision: "approve", amount: 9000 }],
  C04: [{ shipment_id: "SHP-1004", decision: "need_info", amount: 0 }],
  C05: [{ shipment_id: "SHP-1005", decision: "need_info", amount: 0 }],
  C06: [{ shipment_id: "SHP-1006", decision: "escalate", amount: 72000 }],
  C07: [{ shipment_id: "SHP-1007", decision: "reject", amount: 0 }],
  C08: [
    {
      shipment_id: "SHP-0987",
      decision: "duplicate",
      amount: 0,
      reasonIncludes: ["C-0931", "PAY-7781"],
      draftIncludes: ["C-0931", "PAY-7781"],
    },
  ],
  C09: [{ shipment_id: "SHP-1009", decision: "approve", amount: 7500 }],
  C10: [{ shipment_id: "SHP-1010", decision: "approve", amount: 4000 }],
  C11: [{ shipment_id: "SHP-1011", decision: "reject", amount: 0 }],
  C12: [{ shipment_id: "SHP-1012", decision: "reject", amount: 0, reasonMatches: ["\\b8\\s+(?:calendar\\s+)?days?\\b"] }],
  C13: [{ shipment_id: "SHP-1013", decision: "escalate", amount: 58000 }],
  C14: [
    { shipment_id: "SHP-1014", decision: "approve", amount: 6000 },
    { shipment_id: "SHP-1015", decision: "need_info", amount: 0 },
  ],
  C15: [{ decision: "not_a_claim", amount: 0 }],
};
const GOLDEN_LANGUAGE: Record<string, Language> = { C09: "hinglish" };
const GOLDEN_TOTAL_ROWS = 16;

const GOLDEN_DESC: Record<string, string> = {
  C01: "SHP-1001 approve 18000",
  C02: "SHP-1002 reject 0 (11 days)",
  C03: "SHP-1003 approve 9000 (key account, POD 37/40)",
  C04: "SHP-1004 need_info 0 (no photos)",
  C05: "SHP-1005 need_info 0 (says photos attached, none)",
  C06: "SHP-1006 escalate 72000 (capped, above limit)",
  C07: "SHP-1007 reject 0 (clean POD)",
  C08: "SHP-0987 duplicate 0 (C-0931 / PAY-7781)",
  C09: "SHP-1009 approve 7500 (Hinglish shortage)",
  C10: "SHP-1010 approve 4000 (email wrote SHP-1O10)",
  C11: "SHP-1011 reject 0 (POD full count)",
  C12: "SHP-1012 reject 0 (8 days)",
  C13: "SHP-1013 escalate 58000",
  C14: "SHP-1014 approve 6000 + SHP-1015 need_info 0",
  C15: "not_a_claim 0 (invoice copy request)",
};

function describeExpected(exp: ExpectedRow[]): string {
  return exp.map((e) => `${e.shipment_id ? e.shipment_id + " " : ""}${e.decision} ${e.amount}`).join(" + ");
}

/** Runs the 15 real emails in filename order through ONE shared store, as the batch run does. */
async function runGolden(
  suite: string,
  idPrefix: string,
  mode: LlmMode,
  overrides: Partial<PolicyConfig> | undefined,
  expectedMap: Record<string, ExpectedRow[]>,
  mods: Mods,
  variantNote: string,
): Promise<CaseResult[]> {
  const out: CaseResult[] = [];
  const config = resolvePolicy(overrides);
  const files = readdirSync(GOLDEN_DIR)
    .filter((f) => /^C\d+\.txt$/i.test(f))
    .sort();
  let deps: PipelineDeps | null = null;
  let depsError = "";
  try {
    deps = await makeDeps(mods, mode, { policyOverrides: overrides });
  } catch (e) {
    depsError = errText(e);
  }
  const perEmailTimeout = mode === "groq" ? 180000 : 20000;
  let totalRows = 0;
  let crashed = 0;

  for (const file of files) {
    const id = file.replace(/\.txt$/i, "");
    const expected = expectedMap[id] ?? [];
    const changed = JSON.stringify(expected) !== JSON.stringify(GOLDEN[id] ?? []);
    const c: CaseResult = {
      id: idPrefix + id,
      suite,
      description: changed ? `${describeExpected(expected)} (${variantNote})` : (GOLDEN_DESC[id] ?? describeExpected(expected)),
      expected,
      actual: null,
      pass: false,
      failures: [],
      rules_fired: [],
      config: deps?.policy ?? config,
      fail_mode: "none",
      notes: `${file}, ${mode} mode${variantNote ? `, ${variantNote}` : ""}${changed ? " - expectation differs from default config" : ""}`,
    };
    try {
      if (!deps) throw new Error(`createLocalDeps failed: ${depsError}`);
      if (!expectedMap[id]) c.failures.push(`no golden expectation for ${id}`);
      const raw = readFileSync(join(GOLDEN_DIR, file), "utf8");
      const result = await withTimeout(need(mods, "pipeline").processEmail({ raw, claimId: id }, deps), perEmailTimeout, id);
      c.actual = { claim_id: result.claim_id, idempotent_replay: result.idempotent_replay, rows: actualRows(result) };
      c.rules_fired = rulesFired(result);
      totalRows += result.rows.length;
      if (result.claim_id !== id) c.failures.push(`claim_id expected ${id}, got ${result.claim_id}`);
      if (result.idempotent_replay) c.failures.push("unexpected idempotent_replay=true on first processing");
      c.failures.push(...checkResult(result, expected, mods, GOLDEN_LANGUAGE[id] ?? "en"));
    } catch (e) {
      crashed++;
      c.failures.push(`crash: ${errText(e)}`);
    }
    c.pass = c.failures.length === 0;
    logCase(c);
    out.push(c);
  }

  const total: CaseResult = {
    id: idPrefix + "total-rows",
    suite,
    description: `exactly ${GOLDEN_TOTAL_ROWS} result rows across the ${files.length} emails`,
    expected: { emails: 15, rows: GOLDEN_TOTAL_ROWS },
    actual: { emails: files.length, rows: totalRows, emails_crashed: crashed },
    pass: false,
    failures: [],
    rules_fired: [],
    config: deps?.policy ?? config,
    fail_mode: "none",
    notes: "C14 carries two claims, so 15 emails => 16 rows.",
  };
  if (files.length !== 15) total.failures.push(`expected 15 golden emails, found ${files.length}`);
  if (totalRows !== GOLDEN_TOTAL_ROWS) total.failures.push(`expected ${GOLDEN_TOTAL_ROWS} rows, got ${totalRows}`);
  total.pass = total.failures.length === 0;
  logCase(total);
  out.push(total);
  return out;
}

function goldenWith(patch: Record<string, ExpectedRow[]>): Record<string, ExpectedRow[]> {
  return { ...structuredClone(GOLDEN), ...patch };
}

async function suiteB(mods: Mods): Promise<CaseResult[]> {
  const waiver = goldenWith({
    C04: [{ shipment_id: "SHP-1004", decision: "approve", amount: 3200 }],
    C14: [
      { shipment_id: "SHP-1014", decision: "approve", amount: 6000 },
      { shipment_id: "SHP-1015", decision: "approve", amount: 4500 },
    ],
  });
  const proRata = goldenWith({
    // 3 of 40 missing x declared 48000 = 3600; 5 of 25 missing x declared 30000 = 6000
    C03: [{ shipment_id: "SHP-1003", decision: "approve", amount: 3600 }],
    C09: [{ shipment_id: "SHP-1009", decision: "approve", amount: 6000 }],
  });
  return [
    ...(await runGolden("B", "waiver5000/", "mock", { smallClaimPhotoWaiverInr: 5000 }, waiver, mods, "smallClaimPhotoWaiverInr=5000")),
    ...(await runGolden("B", "prorata/", "mock", { shortageProRata: true }, proRata, mods, "shortageProRata=true")),
  ];
}

/* ------------------------------------------------- suite C: October regression */

interface KnownDeviation {
  /** What the engine is expected to say instead of the human decision. */
  engine: { decision: Decision; amount: number };
  why: string;
}

const NO_PHOTO_GOODWILL =
  "No-photo damage claim under Rs 5,000 that the team approved; engine says need_info because SOP rule 2 requires photos and smallClaimPhotoWaiverInr=0. Humans were inconsistent: C-0920 (Rs 4,200, no photo) was sent back for photos.";

/** Human October decisions the default policy deliberately does NOT reproduce. Keep this list honest. */
const KNOWN_DEVIATIONS: Record<string, KnownDeviation> = {
  "C-0901": { engine: { decision: "need_info", amount: 0 }, why: `Rs 2,400 'small claim - goodwill'. ${NO_PHOTO_GOODWILL}` },
  "C-0906": { engine: { decision: "need_info", amount: 0 }, why: `Rs 3,100 'small one, approved'. ${NO_PHOTO_GOODWILL}` },
  "C-0909": { engine: { decision: "need_info", amount: 0 }, why: `Rs 4,800 'goodwill'. ${NO_PHOTO_GOODWILL}` },
  "C-0913": { engine: { decision: "need_info", amount: 0 }, why: `Rs 1,900, no note. ${NO_PHOTO_GOODWILL}` },
  "C-0918": { engine: { decision: "need_info", amount: 0 }, why: `Rs 3,800 'under 5k'. ${NO_PHOTO_GOODWILL}` },
  "C-0910": {
    engine: { decision: "reject", amount: 0 },
    why: "Filed on day 9 (delivered 2026-09-30, filed 2026-10-09) and approved as 'exception - sales asked'. Engine rejects as late (SOP rule 1, 7-day window); exceptions are a human call.",
  },
};

const PAST_DECISION_MAP: Record<string, Decision> = {
  approved: "approve",
  approve: "approve",
  rejected: "reject",
  reject: "reject",
  escalated: "escalate",
  escalate: "escalate",
  need_info: "need_info",
};

async function suiteC(mods: Mods): Promise<{ cases: CaseResult[]; agreement: SuiteResult["agreement"] }> {
  const cases: CaseResult[] = [];
  const rows = parseCsv(readFileSync(join(ROOT, "data", "past_decisions_oct.csv"), "utf8"));
  let agree = 0;
  let known = 0;
  let unexpected = 0;
  const seen = new Set<string>();

  for (const r of rows) {
    seen.add(r.claim_id);
    const claimType = r.claim_type as ClaimType;
    const claimed = Number(r.claim_amount_inr);
    const humanDecision = PAST_DECISION_MAP[r.decision.toLowerCase()];
    const humanAmount = Number(r.approved_amount_inr);
    const photo = /^(yes|y|true|1)$/i.test(r.photo_attached);
    const notes = r.notes ?? "";

    // Reconstruct the shipment: October shipments are not in shipments.csv.
    const PIECES = 100;
    let pod_status = "Signed with remarks";
    let pod_remarks = "";
    let podAssumed = false;
    const short = /POD:\s*(\d+)\s*short/i.exec(notes);
    if (/POD clean|no remarks/i.test(notes)) {
      pod_status = "Signed - received in good condition";
      pod_remarks = "";
    } else if (/full count/i.test(notes)) {
      pod_status = "Signed - received in good condition";
      pod_remarks = `${PIECES} pieces received`;
    } else if (short) {
      pod_remarks = `${PIECES - Number(short[1])} pieces received`;
    } else {
      podAssumed = true;
      pod_remarks = claimType === "shortage" ? "95 pieces received" : "damage noted";
    }
    const shipment: Shipment = {
      shipment_id: r.shipment_id,
      customer: r.customer,
      delivered_date: r.delivered_date,
      pieces_shipped: PIECES,
      declared_value_inr: /capped at declared value/i.test(notes) ? humanAmount : claimed,
      pod_status,
      pod_remarks,
    };
    const domain = `${r.customer.toLowerCase().replace(/[^a-z0-9]/g, "")}.example`;
    const input: EngineInput = {
      is_claim: true,
      email: {
        date: r.filed_date,
        sender_email: `claims@${domain}`,
        sender_domain: domain,
        image_attachments: photo ? ["photo.jpg"] : [],
      },
      claim: {
        shipment_id_raw: r.shipment_id,
        claim_type: claimType,
        claimed_amount_inr: claimed,
        pieces_claimed_missing: null,
        summary: `${claimType} claim on ${r.shipment_id} for Rs ${claimed}`,
        customer_states_no_photos: false,
        consequential_loss_mentioned: false,
      },
      shipment_id_normalised: r.shipment_id,
      shipment_id_corrected: false,
      lookup: { status: "found", shipment },
      prior_claims: { status: "ok", claims: [] },
      policy: defaultPolicy,
    };

    const dev = KNOWN_DEVIATIONS[r.claim_id];
    const c: CaseResult = {
      id: r.claim_id,
      suite: "C",
      description: `${r.shipment_id} ${r.customer} ${claimType} Rs ${claimed}: humans ${humanDecision} ${humanAmount} (${r.decided_by}${notes ? `: ${notes}` : ""})`,
      expected: { decision: humanDecision, approved_amount_inr: humanAmount, decided_by: r.decided_by, notes },
      actual: null,
      pass: false,
      failures: [],
      rules_fired: [],
      config: defaultPolicy,
      fail_mode: "none",
      notes: `pod_assumed:${podAssumed}; reconstructed shipment: declared ${shipment.declared_value_inr}, pieces ${PIECES}, POD "${pod_status}" / "${pod_remarks}"`,
    };
    try {
      if (!humanDecision) throw new Error(`unrecognised past decision "${r.decision}"`);
      const d = need(mods, "engine").decide(input);
      c.actual = { decision: d.decision, approved_amount_inr: d.approved_amount_inr, rule_ids: d.rule_ids, reason: d.reason };
      c.rules_fired = d.rule_ids ?? [];
      const agrees = d.decision === humanDecision && d.approved_amount_inr === humanAmount;
      if (agrees) {
        agree++;
        if (dev) c.failures.push(`listed in KNOWN_DEVIATIONS but the engine now agrees with the humans: remove it from the list (${dev.why})`);
      } else if (dev) {
        if (d.decision === dev.engine.decision && d.approved_amount_inr === dev.engine.amount) {
          known++;
          c.known_deviation = true;
          c.notes += `; KNOWN DEVIATION: ${dev.why}`;
        } else {
          unexpected++;
          c.failures.push(
            `known deviation changed shape: documented engine outcome ${dev.engine.decision} ${dev.engine.amount}, got ${d.decision} ${d.approved_amount_inr}`,
          );
        }
      } else {
        unexpected++;
        c.failures.push(
          `disagrees with the human decision and is not a known deviation: humans ${humanDecision} ${humanAmount}, engine ${d.decision} ${d.approved_amount_inr} (${d.reason})`,
        );
      }
    } catch (e) {
      unexpected++;
      c.failures.push(`crash: ${errText(e)}`);
    }
    c.pass = c.failures.length === 0;
    logCase(c);
    cases.push(c);
  }

  // The deviation list must not name claims that do not exist, and the file must still have 26 rows.
  const meta: CaseResult = {
    id: "regression-set",
    suite: "C",
    description: "26 October rows replayed; every KNOWN_DEVIATIONS id exists in the file",
    expected: { rows: 26, known_deviation_ids: Object.keys(KNOWN_DEVIATIONS) },
    actual: { rows: rows.length, agree, known_deviations: known, unexpected },
    pass: false,
    failures: [],
    rules_fired: [],
    config: defaultPolicy,
    fail_mode: "none",
    notes: "Expected with default policy: 20 agree, 6 known deviations.",
  };
  if (rows.length !== 26) meta.failures.push(`expected 26 rows in past_decisions_oct.csv, found ${rows.length}`);
  for (const id of Object.keys(KNOWN_DEVIATIONS)) if (!seen.has(id)) meta.failures.push(`KNOWN_DEVIATIONS lists ${id}, which is not in the file`);
  meta.pass = meta.failures.length === 0;
  logCase(meta);
  cases.push(meta);

  const n = rows.length;
  return {
    cases,
    agreement: { rows: n, agree, known_deviations: known, unexpected, rate_pct: n ? Math.round((agree / n) * 1000) / 10 : 0 },
  };
}

/* ------------------------------------------------------------ suite D: risk */

async function suiteD(mods: Mods): Promise<CaseResult[]> {
  const out: CaseResult[] = [];
  const outcomes = new Map<string, { decision: Decision; amount: number }[]>();

  for (const rc of riskCases as RiskCase[]) {
    const failMode = rc.setup?.failMode ?? "none";
    const c: CaseResult = {
      id: rc.id,
      suite: "D",
      description: rc.description,
      expected: {
        rows: rc.expected,
        ...(rc.replay ? { replay: "second call idempotent_replay=true, identical rows, listProcessed unchanged" } : {}),
        ...(rc.neverApprove ? { never_approve: true } : {}),
        ...(rc.sameOutcomeAs ? { same_outcome_as: rc.sameOutcomeAs } : {}),
      },
      actual: null,
      pass: false,
      failures: [],
      rules_fired: [],
      config: resolvePolicy(rc.setup?.policyOverrides),
      fail_mode: failMode,
      notes: `${rc.file}${rc.setup?.before?.length ? ` (after ${rc.setup.before.map((b) => `${b.file} as ${b.claimId}`).join(", ")})` : ""}. ${rc.notes}`,
    };
    try {
      const deps = await makeDeps(mods, "mock", {
        policyOverrides: rc.setup?.policyOverrides,
        failMode,
        extraShipments: rc.setup?.extraShipments,
      });
      c.config = deps.policy;
      const processEmail = need(mods, "pipeline").processEmail;
      const before: unknown[] = [];
      for (const b of rc.setup?.before ?? []) {
        const rawB = readFileSync(join(CASES_DIR, b.file), "utf8");
        const rb = await withTimeout(processEmail({ raw: rawB, claimId: b.claimId }, deps), 20000, `${rc.id} setup ${b.file}`);
        before.push({ claim_id: rb.claim_id, rows: actualRows(rb) });
      }
      const raw = readFileSync(join(CASES_DIR, rc.file), "utf8");
      const result = await withTimeout(processEmail({ raw, claimId: rc.id }, deps), 20000, rc.id);
      const actual: Record<string, unknown> = {
        claim_id: result.claim_id,
        idempotent_replay: result.idempotent_replay,
        rows: actualRows(result),
      };
      if (before.length) actual.before = before;
      c.actual = actual;
      c.rules_fired = rulesFired(result);
      outcomes.set(rc.id, result.rows.map((r) => ({ decision: r.decision, amount: r.approved_amount_inr })));

      if (result.idempotent_replay) c.failures.push("unexpected idempotent_replay=true on first processing");
      c.failures.push(...checkResult(result, rc.expected, mods, rc.language ?? "en"));

      if (rc.neverApprove) {
        for (const r of result.rows) {
          if (r.decision === "approve") c.failures.push(`lookup fail mode ${failMode} produced an approve on ${r.shipment_id}`);
          if (r.approved_amount_inr > 0) c.failures.push(`lookup fail mode ${failMode} produced amount ${r.approved_amount_inr} > 0`);
        }
      }

      if (rc.sameOutcomeAs) {
        const base = outcomes.get(rc.sameOutcomeAs);
        const mine = outcomes.get(rc.id);
        if (!base) c.failures.push(`baseline case ${rc.sameOutcomeAs} has no recorded outcome (it must run first)`);
        else if (JSON.stringify(base) !== JSON.stringify(mine))
          c.failures.push(`outcome differs from ${rc.sameOutcomeAs}: baseline ${JSON.stringify(base)}, this ${JSON.stringify(mine)}`);
      }

      if (rc.replay) {
        const stored1 = (await deps.store.listProcessed()).length;
        const again = await withTimeout(processEmail({ raw, claimId: rc.id }, deps), 20000, `${rc.id} replay`);
        const stored2 = (await deps.store.listProcessed()).length;
        actual.replay = { idempotent_replay: again.idempotent_replay, rows: actualRows(again), stored_before: stored1, stored_after: stored2 };
        if (again.idempotent_replay !== true) c.failures.push("second call: idempotent_replay expected true");
        if (JSON.stringify(again.rows) !== JSON.stringify(result.rows)) c.failures.push("second call: rows differ from the first call");
        if (again.email_hash !== result.email_hash) c.failures.push("second call: email_hash differs");
        if (again.claim_id !== result.claim_id) c.failures.push("second call: claim_id differs");
        if (stored1 !== 1) c.failures.push(`after first call: expected 1 stored email, got ${stored1}`);
        if (stored2 !== stored1) c.failures.push(`second call changed store.listProcessed() length: ${stored1} -> ${stored2}`);
      }
    } catch (e) {
      c.failures.push(`crash: ${errText(e)}`);
    }
    c.pass = c.failures.length === 0;
    logCase(c);
    out.push(c);
  }
  return out;
}

/* -------------------------------------------------------------------- output */

interface RunFile {
  run_id: string;
  timestamp: string;
  mode: LlmMode;
  model: string;
  git_sha: string;
  git_dirty: boolean | null;
  node: string;
  config: PolicyConfig;
  totals: { cases: number; passed: number; failed: number; known_deviations: number };
  suites: SuiteResult[];
}

function gitInfo(): { sha: string; dirty: boolean | null } {
  const run = (cmd: string) => execSync(cmd, { cwd: ROOT, stdio: ["ignore", "pipe", "ignore"] }).toString().trim();
  let sha = "unknown";
  let dirty: boolean | null = null;
  try {
    sha = run("git rev-parse --short HEAD") || "unknown";
  } catch {
    sha = "unknown";
  }
  try {
    if (sha !== "unknown") dirty = run("git status --porcelain").length > 0;
  } catch {
    dirty = null;
  }
  return { sha, dirty };
}

function mkSuite(suite: string, title: string, cases: CaseResult[], agreement?: SuiteResult["agreement"]): SuiteResult {
  const passed = cases.filter((c) => c.pass).length;
  return { suite, title, passed, failed: cases.length - passed, cases, ...(agreement ? { agreement } : {}) };
}

const cell = (s: unknown) => String(s).replace(/\|/g, "\\|").replace(/\r?\n/g, " ");

function compactRows(x: unknown): string {
  // Drafts are long: keep expected/actual readable in the summary.
  return JSON.stringify(x, (k, v) => (k === "draft_reply" && typeof v === "string" && v.length > 160 ? v.slice(0, 160) + "..." : v));
}

function summaryMd(run: RunFile, skipped: string[]): string {
  const L: string[] = [];
  const verdict = run.totals.failed === 0 ? "PASS" : "FAIL";
  L.push(`# Eval run ${run.run_id}: ${verdict}`);
  L.push("");
  L.push(`- Mode: \`${run.mode}\`  Model: \`${run.model}\``);
  L.push(`- Git: \`${run.git_sha}\`${run.git_dirty === null ? "" : run.git_dirty ? " (dirty)" : " (clean)"}  Node: \`${run.node}\``);
  L.push(`- Timestamp (UTC): ${run.timestamp}`);
  L.push(`- Default policy: \`${JSON.stringify(run.config)}\``);
  L.push("");
  L.push("## Totals");
  L.push("");
  L.push(`| cases | passed | failed | known deviations (suite C, counted as passed) |`);
  L.push(`|---|---|---|---|`);
  L.push(`| ${run.totals.cases} | ${run.totals.passed} | ${run.totals.failed} | ${run.totals.known_deviations} |`);
  L.push("");
  L.push("## Suites");
  L.push("");
  L.push("| suite | title | cases | passed | failed |");
  L.push("|---|---|---|---|---|");
  for (const s of run.suites) L.push(`| ${s.suite} | ${cell(s.title)} | ${s.cases.length} | ${s.passed} | ${s.failed} |`);
  for (const s of skipped) L.push(`| - | ${cell(s)} | 0 | 0 | 0 |`);
  L.push("");

  const failing = run.suites.flatMap((s) => s.cases.filter((c) => !c.pass));
  L.push(`## Failing cases (${failing.length})`);
  L.push("");
  if (failing.length === 0) L.push("None.", "");
  for (const c of failing) {
    L.push(`### ${c.suite}/${c.id}: ${c.description}`);
    L.push("");
    for (const f of c.failures) L.push(`- ${f}`);
    L.push("");
    L.push(`- Expected: \`${compactRows(c.expected)}\``);
    L.push(`- Actual: \`${compactRows(c.actual)}\``);
    L.push(`- Rules fired: ${c.rules_fired.join(", ") || "-"}  Fail mode: ${c.fail_mode}`);
    L.push(`- Config: \`${JSON.stringify(c.config)}\``);
    L.push(`- Notes: ${c.notes}`);
    L.push("");
  }

  const sc = run.suites.find((s) => s.suite === "C");
  if (sc?.agreement) {
    const a = sc.agreement;
    L.push("## Suite C: agreement with October human decisions");
    L.push("");
    L.push(
      `Engine agrees with the humans on **${a.agree} of ${a.rows} rows (${a.rate_pct}%)** on decision + amount. ` +
        `${a.known_deviations} documented deviation(s), ${a.unexpected} unexpected disagreement(s).`,
    );
    L.push("");
    L.push("Shipments are reconstructed from each row (October shipments are not in shipments.csv); rows whose POD was assumed are flagged `pod_assumed:true` in the case notes.");
    L.push("");
    L.push("| claim | humans decided | engine says | why we deviate |");
    L.push("|---|---|---|---|");
    for (const c of sc.cases.filter((x) => x.known_deviation)) {
      const e = c.expected as { decision: string; approved_amount_inr: number };
      const act = c.actual as { decision: string; approved_amount_inr: number };
      L.push(`| ${c.id} | ${e.decision} ${e.approved_amount_inr} | ${act.decision} ${act.approved_amount_inr} | ${cell(KNOWN_DEVIATIONS[c.id]?.why ?? "")} |`);
    }
    L.push("");
  }
  return L.join("\n") + "\n";
}

function writeRun(timestamp: string, mode: LlmMode, suites: SuiteResult[], skipped: string[]): RunFile {
  mkdirSync(RUNS_DIR, { recursive: true });
  // Never overwrite an earlier run.
  let runId = `${timestamp}-${mode}`;
  for (let n = 2; existsSync(join(RUNS_DIR, `${runId}.json`)) || existsSync(join(RUNS_DIR, `${runId}.summary.md`)); n++) {
    runId = `${timestamp}-${mode}-${n}`;
  }
  const all = suites.flatMap((s) => s.cases);
  const git = gitInfo();
  const run: RunFile = {
    run_id: runId,
    timestamp,
    mode,
    model: seenModel[mode] ?? "unknown",
    git_sha: git.sha,
    git_dirty: git.dirty,
    node: process.version,
    config: defaultPolicy,
    totals: {
      cases: all.length,
      passed: all.filter((c) => c.pass).length,
      failed: all.filter((c) => !c.pass).length,
      known_deviations: all.filter((c) => c.known_deviation).length,
    },
    suites,
  };
  const jsonPath = join(RUNS_DIR, `${runId}.json`);
  const mdPath = join(RUNS_DIR, `${runId}.summary.md`);
  writeFileSync(jsonPath, JSON.stringify(run, null, 2) + "\n", { encoding: "utf8", flag: "wx" });
  writeFileSync(mdPath, summaryMd(run, skipped), { encoding: "utf8", flag: "wx" });
  console.log("");
  console.log(`[${mode}] ${run.totals.passed}/${run.totals.cases} passed, ${run.totals.failed} failed, ${run.totals.known_deviations} known deviation(s)`);
  console.log(`[${mode}] wrote ${jsonPath}`);
  console.log(`[${mode}] wrote ${mdPath}`);
  return run;
}

/* ---------------------------------------------------------------------- main */

function parseArgs(argv: string[]): { mode?: "mock" | "groq" | "both"; suites: Set<string> } {
  let mode: "mock" | "groq" | "both" | undefined;
  let suites = new Set(["A", "B", "C", "D", "E"]);
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const val = (name: string): string | undefined => {
      if (a === name) return argv[++i];
      if (a.startsWith(name + "=")) return a.slice(name.length + 1);
      return undefined;
    };
    const m = val("--mode");
    if (m !== undefined) {
      if (m !== "mock" && m !== "groq" && m !== "both") throw new Error(`--mode must be mock, groq or both (got "${m}")`);
      mode = m;
      continue;
    }
    const s = val("--suite") ?? val("--suites");
    if (s !== undefined) {
      suites = new Set(s.split(",").map((x) => x.trim().toUpperCase()).filter(Boolean));
      for (const x of suites) if (!["A", "B", "C", "D", "E"].includes(x)) throw new Error(`unknown suite "${x}" (use A,B,C,D,E)`);
      continue;
    }
    throw new Error(`unknown argument "${a}". Usage: tsx evals/run.ts [--mode mock|groq|both] [--suite A,B,C,D,E]`);
  }
  return { mode, suites };
}

/**
 * Asks Groq whether it accepts the key (GET /models: no tokens used, nothing about the claims is sent).
 * Returns a short reason if the key is rejected (401/403), "" if accepted or if Groq is unreachable
 * (an outage must not hide Suite E: in that case it runs and fails honestly).
 */
async function groqKeyRejected(key: string): Promise<string> {
  try {
    const res = await fetch("https://api.groq.com/openai/v1/models", {
      headers: { authorization: `Bearer ${key}` },
      signal: AbortSignal.timeout(10000),
    });
    return res.status === 401 || res.status === 403 ? `HTTP ${res.status} invalid API key` : "";
  } catch {
    return "";
  }
}

async function main(): Promise<void> {
  process.chdir(ROOT); // createLocalDeps reads ./data
  const args = parseArgs(process.argv.slice(2));
  const mods = await loadMods();
  for (const [k, v] of Object.entries(mods.errors)) console.log(`WARN  could not load src/${k}: ${v}`);
  try {
    mods.local?.loadDotEnv();
  } catch {
    /* no .env */
  }
  // Evals must be hermetic: the shell's policy / fail-mode / llm-mode must not leak into the cases.
  for (const k of ["POLICY_OVERRIDES", "LOOKUP_FAIL_MODE", "LLM_MODE"]) {
    if (process.env[k]) {
      console.log(`NOTE  ignoring env ${k} for the eval run`);
      delete process.env[k];
    }
  }
  const hasKey = (process.env.GROQ_API_KEY ?? "").trim() !== "";

  const runMock = args.mode !== "groq";
  const wantGroq = args.mode === "groq" || args.mode === "both" || (args.mode === undefined && args.suites.has("E"));
  const timestamp = new Date().toISOString().replace(/\.\d+Z$/, "Z").replace(/:/g, "-");
  let failed = 0;
  let ran = 0;

  let skipE = "";
  if (!args.suites.has("E")) skipE = "not selected (--suite)";
  else if (args.mode === "mock") skipE = "--mode mock";
  else if (!hasKey) skipE = "GROQ_API_KEY is not set (add it to .env to run the golden set against the real model)";
  else if (args.mode === undefined) {
    // Default run only: a key that Groq itself rejects is a credentials problem, not a product
    // result, so Suite E is reported as NOT RUN (loudly) instead of 16 identical failures.
    // `--mode groq` / `--mode both` skip this preflight and always run Suite E for real.
    const rejected = await groqKeyRejected((process.env.GROQ_API_KEY ?? "").trim());
    if (rejected)
      skipE = `GROQ_API_KEY was REJECTED by Groq (${rejected}) - live-LLM mode is UNVERIFIED. Fix the key in .env and re-run, or force it with --mode groq`;
  }

  if (runMock) {
    const suites: SuiteResult[] = [];
    if (args.suites.has("A")) {
      console.log("\n== Suite A: golden set (15 real emails, default policy, mock LLM) ==");
      suites.push(mkSuite("A", "Golden set: 15 real emails, default policy", await runGolden("A", "", "mock", undefined, GOLDEN, mods, "")));
    }
    if (args.suites.has("B")) {
      console.log("\n== Suite B: config variants ==");
      suites.push(mkSuite("B", "Config variants: photo waiver 5000, shortage pro-rata", await suiteB(mods)));
    }
    if (args.suites.has("C")) {
      console.log("\n== Suite C: regression vs October human decisions (rules engine only) ==");
      const c = await suiteC(mods);
      suites.push(mkSuite("C", "Regression vs past_decisions_oct.csv (decide() only)", c.cases, c.agreement));
      const a = c.agreement!;
      console.log(`      agreement: ${a.agree}/${a.rows} (${a.rate_pct}%), ${a.known_deviations} known deviation(s), ${a.unexpected} unexpected`);
    }
    if (args.suites.has("D")) {
      console.log(`\n== Suite D: risk cases (${riskCases.length}) ==`);
      suites.push(mkSuite("D", "Risk cases: injection, boundaries, lookups, duplicates, evidence, tone", await suiteD(mods)));
    }
    if (suites.length) {
      const run = writeRun(timestamp, "mock", suites, skipE ? [`Suite E (golden set in groq mode) skipped: ${skipE}`] : []);
      failed += run.totals.failed;
      ran += run.totals.cases;
    }
  }

  if (skipE) {
    console.log(`\nSKIP  E  golden set in groq mode skipped: ${skipE}`);
  } else if (wantGroq) {
    console.log("\n== Suite E: golden set again in groq mode ==");
    const cases = await runGolden("E", "", "groq", undefined, GOLDEN, mods, "");
    const run = writeRun(timestamp, "groq", [mkSuite("E", "Golden set in groq mode (real LLM extract + draft)", cases)], []);
    failed += run.totals.failed;
    ran += run.totals.cases;
  }

  console.log("");
  console.log(`TOTAL  ${ran - failed}/${ran} passed, ${failed} failed`);
  if (ran === 0) console.log("No cases were run (check --mode / --suite).");
  if (failed > 0) process.exitCode = 1;
}

main().catch((e) => {
  // Argument errors and harness bugs: still a non-zero exit.
  console.error(`eval harness error: ${errText(e)}`);
  process.exitCode = 1;
});
