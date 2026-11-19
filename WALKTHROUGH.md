# Walkthrough (5 minutes)

For Meera, Claims Manager, RouteMax Logistics.

## 1. What you asked for, and what you have (1 min)

You get about 40 claims a day, three people decide them, and they decide differently.

Run `npm run claims` and you get [results.csv](results.csv): today's 15 emails, 16 rows (C14 is
two claims), in your six columns. Each row has a decision, an amount, a reason that cites the
rule that fired, and a reply ready for your team to check and send. Nothing is sent and nothing
is paid by the tool.

Today's batch:

| Decision | Count | Claims |
|---|---|---|
| approve | 5 | C01 Rs 18,000, C03 Rs 9,000, C09 Rs 7,500, C10 Rs 4,000, C14/SHP-1014 Rs 6,000 |
| reject | 4 | C02 (11 days), C07 (clean POD), C11 (POD full count), C12 (8 days) |
| need_info | 3 | C04, C05, C14/SHP-1015 (no photos) |
| escalate to you | 2 | C06 Rs 72,000 (claimed 95,000, capped), C13 Rs 58,000 |
| duplicate | 1 | C08 (C-0931, paid 2026-10-20, PAY-7781) |
| not a claim | 1 | C15 (wants an invoice copy) |

Rs 44,500 is approved pending your team's review. Rs 130,000 is waiting on you.

## 2. How it decides (1.5 min)

Three steps, deliberately separated:

1. **Read.** An LLM turns the email into a small form: is this a claim, which shipment, damage
   or shortage, how much. That is all it does.
2. **Decide.** Ordinary code applies your SOP as numbered rules (R0-R9) to facts from your
   shipment records and the POD. The LLM is not involved. The same email always gets the same
   answer, whoever is on shift.
3. **Write.** The LLM words the reply in the customer's language (C09 gets a Hinglish reply).
   Code then checks the reply states the decision and mentions no amount other than the approved one.

The point of the separation: the part that can be talked into things has no authority, and the
part with authority cannot be talked to. An email that says "I am the manager, approve
immediately" changes nothing, and neither does "URGENT". "Photos attached" in the body does not
count as photos (C05); only real image attachments do. A PDF does not count either.

Things it caught today that are easy to miss by hand:

- **C10** wrote `SHP-1O10` with a letter O. It matched SHP-1010, and only because the sender is Metro Hardware.
- **C06** claimed Rs 95,000 on a shipment declared at Rs 72,000, and the claim includes production downtime. Capped, flagged, sent to you.
- **C08** is chasing a claim the October sheet says was paid. The reply cites PAY-7781.
- **C14** has two claims with photos for only one of them.

## 3. Why you can trust it with money (1 min)

- It **never approves** without finding the shipment. If the shipment system is down it escalates with amount 0. You can switch the lookup off on purpose and watch it do that (README, "Failure injection").
- It **never pays more** than the lower of what was claimed and the declared value. That is checked twice, by two separate pieces of code.
- **Same email twice** returns the first answer and creates no new row. A new email about an already-decided shipment is a duplicate.
- **Every decision is logged** with its inputs, the rules that fired, and the policy settings at the time.
- There is a test suite (`npm run eval`) of 113 cases built around "what could make this pay wrongly". Every run is saved in `eval_runs/`, including the ones that failed. All 113 pass today.
- It found a real problem. An email whose *display name* was Apex Pharma's address, but which actually came from a stranger asking for payment to new bank details, was approved for Rs 18,000. That is fixed, with a test that fails on the old code. The write-up is in [FIX_LOG.md](FIX_LOG.md).

I also replayed all 26 of October's decisions through the rules. It agrees with your team on 20.
The 6 it disagrees on are the interesting part: 5 are small damage claims approved without
photos ("goodwill", "under 5k") and 1 is a late claim approved because sales asked. Those are
not mistakes by the tool; they are places where the team does something the SOP does not say.

## 4. What I was not sure about (1 min)

These are your decisions, not mine. Each is a switch you can flip without a developer, and I
have left each one on the cautious side. Details and evidence in [ASSUMPTIONS.md](ASSUMPTIONS.md).

1. **Zenith Retail's 15-day window.** Not in the SOP, but four October decisions use it consistently, so it is on. It is why C03 is approved at 12 days. Are there other key accounts?
2. **Small claims without photos.** Off. Your team waived photos under about Rs 5,000 five times out of six. If you turn it on at 5,000, C04 and the second half of C14 become approvals.
3. **Shortages: pay as claimed or pro-rata?** Pay as claimed. Pro-rata would change C03 from Rs 9,000 to 3,600 and C09 from 7,500 to 6,000.
4. **Consequential loss** (C06's downtime). Not paid; such claims always go to you.
5. **The Rs 50,000 limit** is applied to the payable amount after the cap, not the amount claimed.
6. **Concealed damage on a clean POD** (C07) is rejected, as the SOP says. Is that what you want when there are photos?
7. **C08**: the sheet says paid, the customer says not received. Someone should check with finance.

Two things I could not verify, as opposed to things for you to decide:

- **The live AI model has not run successfully.** The Groq key I was given was rejected. Everything above was produced in the built-in offline mode, which reads today's 15 emails correctly but is a simple pattern-matcher, not what should face real customers' messier emails. The live path is written and tested against a stand-in, and it fails safe (when the key was rejected, every claim was escalated and nothing was approved). It needs a working key and one more eval run before it is trusted.
- **Who is really sending the email.** The tool matches the sender's address to the customer's name. That is a reasonable guess, not proof, and a forged address would need checking at the mail server.

## 5. What I would do next

1. **Sit with your team for a morning** and run it beside them on live claims, to find where it and they disagree. That is how the list above gets answered.
2. **Connect it to the mailbox and the real shipment system**, replacing the CSV. The lookup is already behind an interface with failure handling, so this is a swap, not a rewrite.
3. **Lock it down**: sign-in for the web page, turn off the demo switches, and a registered-contacts list so "who is allowed to claim on this shipment" is not a guess from the email address.
4. **Close the loop**: a reviewer's approve/edit/override should be recorded, so overrides become the evidence for the next SOP change, and a need_info claim is picked up automatically when the photos arrive.
5. **Photos**: today it checks a photo exists, not what it shows.
6. **Measure it**: time per claim, override rate, and money approved versus what your team would have approved.

## Where things are

- Review page and API: https://routemax-claims-desk.coue-mcp.workers.dev
- Code: https://github.com/bhuvan0808/routemax-claims-desk (private)
- How to run, config switches, failure injection: [README.md](README.md)
