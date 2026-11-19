# Assumptions and decisions

Nobody was asked a question during the build. Every place the brief, the SOP or the data left
room for interpretation, a decision was made and is recorded here. Anything that changes who
gets paid is in **Questions for Meera** first, because those are hers to decide, not mine.

---

## Questions for Meera

Each row is a policy switch in [src/policy.config.ts](src/policy.config.ts). The default is what
runs today. Changing one is a config change (`POLICY_OVERRIDES` env var or `--policy` flag), not
a code change, and the eval suite shows exactly which of today's claims flip.

| # | Question | Default today | Evidence | What flips if you change it |
|---|---|---|---|---|
| 1 | **Do key accounts get a longer claim window?** The SOP says 7 days for everyone. | `keyAccountWindows: { "Zenith Retail": 15 }` | 4 consistent October decisions: C-0904, C-0911, C-0933 approved at 12-13 days with notes "key account - 15 day window"; C-0914 rejected at 17 days "outside 15 day window". Nobody else got this. | Without it, **C03 (Rs 9,000, 12 days)** becomes a reject. Are there other key accounts? |
| 2 | **Can small damage claims be approved without photos?** The SOP says photos are required. | `smallClaimPhotoWaiverInr: 0` (off, follow the SOP) | 5 no-photo damage claims under Rs 5,000 were approved in October (C-0901, C-0906, C-0909, C-0913, C-0918: "goodwill", "under 5k") but C-0920 (Rs 4,200, no photo) was sent back for photos. 5 of 6, so it is a habit, not a rule. | At 5000: **C04 (Rs 3,200)** and **C14/SHP-1015 (Rs 4,500)** become approvals. |
| 3 | **Is a shortage paid as claimed, or pro-rata by pieces?** | `shortageProRata: false` (pay as claimed, capped at declared value) | SOP only says "approve". October shortage approvals (C-0904, C-0916, C-0932) were paid as claimed. | If true: **C03 Rs 9,000 -> 3,600** (3/40 of 48,000) and **C09 Rs 7,500 -> 6,000** (5/25 of 30,000). |
| 4 | **Do we ever pay consequential loss** (production downtime, lost sales)? | `payConsequentialLoss: false` | Not in the SOP. C06 claims Rs 95,000 "including our production downtime". | While false, any claim that mentions consequential loss is **escalated, never auto-approved**, even under Rs 50,000, because the email does not split goods value from downtime. C06 escalates anyway (over the limit). |
| 5 | **Approval limit: is it the amount claimed or the amount payable?** | `approvalLimitInr: 50000`, applied to the **payable** (capped) amount, strictly greater than. | SOP rule 6 says "claims above Rs 50,000". October: C-0907 claimed 88,000, capped to 64,000, escalated. No October case had claim > 50k but payable <= 50k. | Rs 50,000 exactly is approved; Rs 50,001 escalates. A Rs 95,000 claim on a Rs 40,000 shipment would auto-approve Rs 40,000 today. Do you want to see those? |
| 6 | **Claim window: 7 days** | `defaultWindowDays: 7`; day 7 is in time, day 8 is late. | SOP rule 1 "within 7 days of delivery". October: C-0903 and C-0917 rejected at 9 days. | Days are counted from the email's Date header to the delivery date, calendar days. |

Other things only Meera knows:

7. **"Exception - sales asked" (C-0910).** A late claim (9 days) was approved because sales asked. The agent rejects it. Should there be an exception path, and who can authorise one? Today the answer is: a human overrides the draft.
8. **Who is allowed to claim?** The agent only approves when the sender's email address matches the shipment's customer (domain, or mailbox name for Gmail-type addresses). Do you hold a list of registered contact emails per customer? That would replace this heuristic.
9. **Is a clean POD the end of the story?** SOP rule 3 rejects damage claims on a clean POD. Concealed damage found on unpacking (C07, C-0905) is rejected today. Is that intended even with photos?
10. **What counts as "decided" for a duplicate?** Today: an earlier approve, reject or escalate on the same shipment. An earlier "need_info" is not a decision, so the customer's follow-up with photos is processed normally.
11. **C08** chases an unpaid claim that the October sheet says was paid (PAY-7781 on 2026-10-20). The agent replies with that reference. Someone in finance should confirm the payment actually reached Apex Pharma.

---

## Decisions made where the brief and reality differed

| Topic | Decision | Why |
|---|---|---|
| Input location | The data arrived in the repo root. Moved to `data/` as the brief describes. The original brief is kept as [BRIEF.md](BRIEF.md). | Brief says "Input data is in ./data". |
| `gh` CLI | Not installed on this machine. `scripts/ship.mjs` creates the private repo through the GitHub REST API with `GITHUB_TOKEN` from `.env` and pushes with a one-off auth header (token never stored in git config). | Equivalent to `gh repo create --private --source=. --push`. |
| `.env` | Created with empty placeholders, gitignored (`.env`, `.env.*`, `.dev.vars`), with `.env.example` and `.dev.vars.example` committed. Scripts never print it. | User request. |
| `LOOKUP_FAIL_MODE=not_found` | Returns **need_info, amount 0**, not escalate. `error` and `timeout` return **escalate, amount 0, "lookup failed"**. | Section 6 says failures escalate; R2 says an unknown shipment is need_info. The engine cannot tell an injected "not found" from a customer's wrong id, and asking the customer to confirm the id is the right next step in both. No fail mode can approve or produce an amount. Tested for all three. |
| Photo evidence in a multi-claim email | Image attachments in the header count for every claim in the email, unless the customer says a specific claim has no photo (C14 item 2: "No photo, the box was thrown away"). | The header does not say which photo belongs to which claim. Using the customer's own "no photo" can only make the outcome stricter. |
| Photo waiver threshold | `claimed amount <= smallClaimPhotoWaiverInr` (inclusive). | "Under 5k" in the notes; inclusive is the reading that matches C-0918 style approvals at round numbers. |
| Shortage with an unclear POD | POD shows fewer pieces -> approve. POD confirms the full count -> reject. POD signed clean with no remarks -> reject (nothing noted at delivery). POD has remarks but no piece count -> **escalate, amount 0**. | SOP rules 3-4 cover the first two; the others need a rule and I chose never to pay on a shortage the POD does not show. |
| Pro-rata uses the POD, not the email | missing pieces = pieces shipped - pieces on the POD. | "Facts come from the data, never from the customer's wording." |
| Sender does not match the shipment's customer | **need_info**, for exact and fuzzy id matches alike. The reply does not reveal whose shipment it is. | Brief requires this for fuzzy matches; paying a claim to someone we cannot tie to the shipment is the same risk on an exact match. |
| Missing claim amount | need_info asking for the amount. If photos are missing too, one reply asks for both. | Cannot cap an amount that was not stated. |
| Email with no usable Date header | **escalate, amount 0**. | R3 cannot be evaluated and the system clock must never be used. |
| Duplicate reply | Cites the earlier claim id, decision, paid date and payment reference. It does **not** restate the earlier amount. | Reply check: no rupee amount other than the approved one (which is 0 for a duplicate). |
| Escalation reply | Says the claim is with the Claims Manager. States **no amount** even though `approved_amount_inr` carries the recommended figure for the reviewer. | "Must not promise anything the engine did not decide." The engine recommended; Meera decides. |
| LLM output is grounded | An extracted amount or shipment id that does not literally appear in the email is discarded before the engine runs (amount -> "not stated"; id -> "no id"). If the model "fixes" SHP-1O10 to SHP-1010, the original spelling is recovered from the text so the fuzzy-match rule still applies. | "The LLM never chooses the amount." Also blunts prompt injection and hallucination. |
| Extraction failure | The row is `escalate`, amount 0, reason E1. It is audited but **not stored** as processed, so resubmitting the email retries it. | A Groq outage should not permanently mark an email as handled. |
| Final safety net | After the engine, the pipeline re-checks: approve needs a successful lookup; amount is a non-negative integer and never above min(claimed, declared). A violation becomes escalate/0 (rule E3). | Independent of the engine, so an engine bug cannot pay money. |
| `npm run claims` state | Starts from a clean state file each run (`.state/claims-store.json`); `--resume` keeps earlier state. | Makes the batch reproducible and reflects the current config. Idempotency is exercised through the API and evals. |
| Idempotency key | sha256 of the email with line endings, trailing spaces and blank-line runs normalised. Case is kept. | Same email twice -> stored result, no new rows, one `idempotent_replay` audit line. |
| not_a_claim rows | `shipment_id` is the shipment mentioned in the email (C15 -> SHP-1016), found by regex, for the reviewer's convenience. | No lookup is done and no decision depends on it. |
| State backend | Durable Object with SQLite in the Worker; JSON file store for the CLI; in-memory store for tests and evals. One `ClaimsStore` interface. | Brief. D1 was not needed. |
| Demo mode on the live Worker | `ALLOW_FAULT_INJECTION=1` is set in `wrangler.jsonc`, enabling the `x-lookup-fail` header and `POST /admin/reset`. The API has no auth. | Needed for the live smoke test. **Turn it off and put the Worker behind Cloudflare Access before real use.** |
| Mock mode | A regex/heuristic extractor and template replies. Deterministic, no key, no network. It is the default (`LLM_MODE=mock`). | Brief. It reads today's 15 emails correctly; it is a test double, not a replacement for the LLM on messy real email. |
| Groq key rejected | The `GROQ_API_KEY` placed in `.env` is not accepted by Groq (HTTP 401; it is 32 characters and does not start with `gsk_`). The Worker was deployed **without** the secret, so it runs in mock mode. Live mode is unverified. | Setting a known-bad secret would switch the Worker to live mode and make every claim escalate with E1. Mock mode is the working, honest state until there is a valid key. |
| Sender identity | Taken only from the angle-bracket address in the From header. Display names are ignored. No address, or two different ones, means "unknown sender" and no approval. | Found by eval case D30: a spoofed display name was approved for Rs 18,000. See [FIX_LOG.md](FIX_LOG.md). |
| Timestamps | `processed_at` / audit `ts` use the wall clock. They are metadata only; no rule reads them. | R3 uses only the email Date header and the delivery date. |

## Groq model

See the "LLM" section of the [README](README.md) for the model in `src/config.ts` and why it was chosen.
