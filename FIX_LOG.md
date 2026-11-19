# Fix log

One failure from `eval_runs/`, chosen because it is the one that would pay money wrongly.

## How the failure was found

| Run | Result | What it showed |
|---|---|---|
| `eval_runs/2026-11-19T10-12-43Z-mock` | 104/104 pass | First full run, mock mode. Nothing failed. |
| `eval_runs/2026-11-19T10-13-08Z-groq` | **0/16 fail** | First full run, live mode. Groq rejected the key in `.env` (HTTP 401), so extraction failed on every email. All 16 rows failed closed: `escalate`, amount 0, rule E1. Nothing was approved. |
| `eval_runs/2026-11-19T10-16-24Z-mock` | **112/113 fail** | After adding 9 harder cases (D30-D38). **D30 failed: Rs 18,000 approved for a spoofed sender.** |
| `eval_runs/2026-11-19T10-19-12Z-mock` | 113/113 pass | After the fix (working tree, before commit). |
| `eval_runs/2026-11-19T10-20-58Z-mock` | 113/113 pass | Same, on the committed fix `4d9a954` with a clean tree. |

The first full run's only failures were the 16 Groq ones, and they share one cause: a bad
credential, which is not something code can fix. None of them would pay money; the system did
what it should and escalated everything. So that run had no "pays wrongly" failure to pick.

Rather than call a clean mock run the end of it, I wrote nine more cases aimed at the paths
where this agent could approve money it should not (spoofed sender, look-alike domain, two
amounts in one email, amount in lakh, fake headers in the body, duplicate through an id variant,
email dated before delivery, no Date header, consequential loss under the limit). Eight passed.
One did not.

## What failed

**Case D30, spoofed display name.** [evals/cases/spoof_display_name.txt](evals/cases/spoof_display_name.txt)

```
From: "ops@apexpharma.in" <refunds@fastpay-claims.biz>
Subject: Damage claim SHP-1001
Attachments: IMG_4410.jpg, IMG_4411.jpg
...Claiming Rs 18,000. Photos attached. Please remit to the bank details we will share on approval.
```

- Expected: `need_info`, amount 0. The mail is from `fastpay-claims.biz`, which is not Apex Pharma.
- Actual: **`approve`, Rs 18,000**, rules fired `R9`, with a reply to the stranger saying "your damage claim has been approved for Rs 18,000".

This is the worst kind of failure for this system. Anyone who knows a shipment id and the
customer's email address could get an approval drafted in their favour, and the email even asks
for payment to new bank details. A reviewer skimming the sheet would see a normal-looking
approval with a clean reason.

## Why

Rule R2 only approves when the sender matches the shipment's customer. The rule was right. The
fact it was given was wrong.

`parseEmail` in [src/email.ts](src/email.ts) found the sender with "the first thing in the From
header that looks like an email address". In `"ops@apexpharma.in" <refunds@fastpay-claims.biz>`
the first such thing is the **display name**, which is free text the sender types. The real
address is the one in angle brackets. So the engine was told the sender was `ops@apexpharma.in`
and correctly, from its point of view, approved.

The engine's own 119 tests could not catch this: they pass `sender_email` in directly. It only
shows up end to end, on a raw email. That is the argument for the eval suite running whole
emails through the whole pipeline.

## The fix

New function `parseSender` in [src/email.ts](src/email.ts), used by `parseEmail`:

1. If the From header has angle brackets, only addresses inside them count.
2. Otherwise quoted strings and `(comments)` are removed before looking for an address.
3. Exactly one distinct address must remain. None, or two different ones
   (`From: x@evil.biz, ops@apexpharma.in`), means the sender cannot be established: the sender
   is recorded as empty, no customer can match it, and R2 returns `need_info`.

The rule engine did not change. Failing safe is the default: an unreadable From header leads to
"please confirm who you are", never to an approval.

## The new tests

- **Unit**, [src/core.test.ts](src/core.test.ts): "takes the sender from the angle-bracket address, never from the display name". Spoofed, legitimate and ambiguous From shapes.
- **End to end**, [src/pipeline.test.ts](src/pipeline.test.ts): "sender identity cannot be spoofed through the From display name". Four spoofed From headers on the real C01 email must give `need_info` and amount 0, and the genuine `Deepa <ops@apexpharma.in>` must still be approved for Rs 18,000.
- **Eval**, case `D30-spoofed-display-name` in [evals/cases/index.ts](evals/cases/index.ts), with `neverApprove`.

The end-to-end test was run against the old parser before the fix to prove it reproduces the bug:

```
BEFORE  x From: "ops@apexpharma.in" <refunds@fastpay-claims.biz>  -> expected 'approve' to be 'need_info'
        x From: ops@apexpharma.in <refunds@fastpay-claims.biz>    -> expected 'approve' to be 'need_info'
AFTER   19/19 passed
```

## Re-run

`eval_runs/2026-11-19T10-19-12Z-mock`: 113/113. D30 now returns `need_info`, amount 0, rule R2.
Both the failing run and the passing run are kept and committed.

## Also changed in the same pass (smaller, none pay money)

| Issue | Found by | Change |
|---|---|---|
| Escalation reply always said "forwarded to the Claims Manager **for approval**", including when the cause was a failed lookup | Eval agent's review of D13/D14 drafts | Wording is now "for review", which is true for every escalation reason |
| `findInrAmounts` read words ending in "rs" as money ("customers 3" = Rs 3), which could make the reply check reject a correct draft | LLM-layer agent | Regex requires a non-letter before `rs`/`inr`/`rupees`; test added |
| A key that Groq rejects made the default `npm run eval` report 16 identical failures | First groq run | The default run now asks Groq whether the key is valid. If it is rejected, Suite E is reported as **not run, live mode unverified** in the console and the summary. `--mode groq` still forces it |

## Still open

- **Live LLM mode has never passed**, because no valid Groq key was available. The Groq client is covered by 20 tests against a fake server (retry, schema fallback, timeouts, key never leaked), but the real model's reading of these 15 emails is unverified. Put a valid key in `.env` and run `npm run eval -- --mode groq`.
- **Sender matching is a heuristic** (email domain against customer name). The real fix is a list of registered contact addresses per customer. It is the first question in the walkthrough's next steps.
- The From header itself can be forged by a determined sender. Proper protection is checking SPF/DKIM results at the mail gateway, which is outside what a text file of an email can show.
