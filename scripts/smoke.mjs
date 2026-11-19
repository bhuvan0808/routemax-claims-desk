#!/usr/bin/env node
/**
 * Smoke test against a running Worker (local `wrangler dev` or the deployed URL).
 *   node scripts/smoke.mjs https://routemax-claims-desk.<subdomain>.workers.dev
 *   node scripts/smoke.mjs http://127.0.0.1:8787 --keep     (--keep: do not reset state afterwards)
 *
 * Checks: /health, POST one email, the same email again (idempotent), one request with
 * x-lookup-fail (must escalate, amount 0), and /results.csv. Exit code 1 on any failure.
 * Needs ALLOW_FAULT_INJECTION=1 on the Worker for the x-lookup-fail and reset steps.
 */
import { readFile } from "node:fs/promises";

const base = (process.argv[2] ?? "").replace(/\/+$/, "");
const keep = process.argv.includes("--keep");
if (!/^https?:\/\//.test(base)) {
  console.error("usage: node scripts/smoke.mjs <base-url> [--keep]");
  process.exit(2);
}

let failed = 0;
function check(name, ok, detail = "") {
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? `  - ${detail}` : ""}`);
  if (!ok) failed++;
}
async function call(method, path, { body, headers } = {}) {
  const res = await fetch(base + path, {
    method,
    headers: { ...(body ? { "content-type": "application/json" } : {}), ...headers },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  let json = null;
  try {
    json = JSON.parse(text);
  } catch {
    /* not json */
  }
  return { status: res.status, headers: res.headers, text, json };
}

const c01 = await readFile(new URL("../data/claim_emails/C01.txt", import.meta.url), "utf8");
const c10 = await readFile(new URL("../data/claim_emails/C10.txt", import.meta.url), "utf8");

console.log(`Smoke test: ${base}\n`);

const health = await call("GET", "/health");
check("GET /health", health.status === 200 && health.json?.ok === true,
  `llm_mode=${health.json?.llm_mode} model=${health.json?.model} fault_injection=${health.json?.fault_injection_allowed}`);
check("/health does not leak the key", !/gsk_[A-Za-z0-9]/.test(health.text));

const reset = await call("POST", "/admin/reset");
check("POST /admin/reset (clean slate)", reset.status === 200, `status ${reset.status}`);

const first = await call("POST", "/claims", { body: { email: c01, claim_id: "SMOKE-C01" } });
const r1 = first.json?.rows?.[0];
check("POST /claims (C01) -> approve 18000",
  first.status === 200 && r1?.decision === "approve" && r1?.approved_amount_inr === 18000 && first.json?.idempotent_replay === false,
  `decision=${r1?.decision} amount=${r1?.approved_amount_inr} replay=${first.json?.idempotent_replay}`);
check("draft reply present", typeof r1?.draft_reply === "string" && r1.draft_reply.length > 20);

const second = await call("POST", "/claims", { body: { email: c01, claim_id: "SMOKE-C01-AGAIN" } });
check("same email again -> idempotent_replay, same rows",
  second.status === 200 && second.json?.idempotent_replay === true &&
    JSON.stringify(second.json?.rows) === JSON.stringify(first.json?.rows),
  `replay=${second.json?.idempotent_replay} claim_id=${second.json?.claim_id}`);

const list = await call("GET", "/claims");
check("GET /claims -> exactly 1 row stored (no new rows from the repeat)", list.json?.rows?.length === 1,
  `rows=${list.json?.rows?.length}`);

const failing = await call("POST", "/claims", {
  body: { email: c10, claim_id: "SMOKE-C10-LOOKUPFAIL" },
  headers: { "x-lookup-fail": "error" },
});
const rf = failing.json?.rows?.[0];
check("x-lookup-fail: error -> escalate, amount 0, reason says lookup failed",
  failing.status === 200 && rf?.decision === "escalate" && rf?.approved_amount_inr === 0 && /lookup failed/i.test(rf?.reason ?? ""),
  `decision=${rf?.decision} amount=${rf?.approved_amount_inr} reason="${(rf?.reason ?? "").slice(0, 90)}"`);

const csv = await call("GET", "/results.csv");
check("GET /results.csv header",
  csv.status === 200 && csv.text.startsWith("claim_id,shipment_id,decision,approved_amount_inr,reason,draft_reply"),
  `content-type=${csv.headers.get("content-type")}`);

const ui = await call("GET", "/");
check("GET / serves the UI", ui.status === 200 && /<html/i.test(ui.text));

if (!keep) {
  const after = await call("POST", "/admin/reset");
  check("state reset after smoke test", after.status === 200);
}

console.log(`\n${failed === 0 ? "SMOKE PASSED" : `SMOKE FAILED (${failed} check(s))`}`);
process.exit(failed === 0 ? 0 : 1);
