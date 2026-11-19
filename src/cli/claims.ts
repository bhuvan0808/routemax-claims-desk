/**
 * npm run claims
 *   Processes every email in data/claim_emails/ (filename order) and writes results.csv.
 *
 * Flags:
 *   --mode mock|groq        LLM mode (default: env LLM_MODE, else mock)
 *   --in <dir>              input folder (default data/claim_emails)
 *   --out <file>            output CSV (default results.csv)
 *   --policy '<json>'       policy overrides, e.g. '{"smallClaimPhotoWaiverInr":5000}'
 *   --fail-mode <mode>      none|error|timeout|not_found (default: env LOOKUP_FAIL_MODE)
 *   --resume                keep state from earlier runs (.state/claims-store.json) instead of starting fresh
 */
import { readdir, readFile, writeFile } from "node:fs/promises";
import { basename, extname, join } from "node:path";
import { parseFailMode, parseLlmMode } from "../config";
import { resultsToCsv } from "../csv";
import { formatInr } from "../format";
import { processEmail } from "../pipeline";
import { createLocalDeps, loadDotEnv } from "../runtime/local";
import { FileStore } from "../store/file";
import type { PolicyConfig, ResultRow } from "../types";

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : undefined;
}
const flag = (name: string) => process.argv.includes(`--${name}`);

async function main(): Promise<void> {
  loadDotEnv();
  const inDir = arg("in") ?? join("data", "claim_emails");
  const outFile = arg("out") ?? "results.csv";
  const mode = arg("mode") ? parseLlmMode(arg("mode")) : undefined;
  const failMode = arg("fail-mode") ? parseFailMode(arg("fail-mode")) : undefined;
  const policyOverrides = arg("policy") ? (JSON.parse(arg("policy")!) as Partial<PolicyConfig>) : undefined;

  const store = new FileStore(join(".state", "claims-store.json"));
  if (!flag("resume")) await store.reset(); // a batch run is reproducible by default

  const deps = await createLocalDeps({ llmMode: mode, failMode, policyOverrides, store });
  const files = (await readdir(inDir)).filter((f) => extname(f).toLowerCase() === ".txt").sort();
  if (files.length === 0) throw new Error(`No .txt emails found in ${inDir}`);

  console.log(
    `RouteMax Claims Desk - ${files.length} emails from ${inDir} | LLM mode: ${deps.extractor.mode} (${deps.extractor.model})`,
  );
  const rows: ResultRow[] = [];
  for (const file of files) {
    const raw = await readFile(join(inDir, file), "utf8");
    const result = await processEmail({ raw, claimId: basename(file, extname(file)) }, deps);
    for (const r of result.rows) {
      rows.push(r);
      const amount = r.approved_amount_inr > 0 ? formatInr(r.approved_amount_inr) : "-";
      console.log(
        `  ${r.claim_id.padEnd(5)} ${(r.shipment_id || "-").padEnd(9)} ${r.decision.padEnd(12)} ${amount.padStart(10)}${result.idempotent_replay ? "  (already processed)" : ""}`,
      );
    }
  }

  await writeFile(outFile, resultsToCsv(rows), "utf8");
  const counts = rows.reduce<Record<string, number>>((acc, r) => {
    acc[r.decision] = (acc[r.decision] ?? 0) + 1;
    return acc;
  }, {});
  const autoApproved = rows.filter((r) => r.decision === "approve").reduce((s, r) => s + r.approved_amount_inr, 0);
  console.log(`\nWrote ${rows.length} rows to ${outFile}`);
  console.log(
    `  ${Object.entries(counts)
      .map(([k, v]) => `${k}: ${v}`)
      .join(" | ")}`,
  );
  console.log(`  Approved (pending human review): ${formatInr(autoApproved)}. Drafts only - nothing was sent or paid.`);
}

main().catch((err) => {
  console.error(`claims run failed: ${err instanceof Error ? err.message : String(err)}`);
  process.exitCode = 1;
});
