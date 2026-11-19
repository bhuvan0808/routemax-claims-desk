# Live build: RouteMax claims desk

You're the Trail FDE. Your customer is **Meera, Claims Manager at RouteMax Logistics** (your interviewer plays her).

> "We get about 40 damage and shortage claims a day by email. My team of 3 reads each one, checks our rules, decides, and replies. It's slow and every person decides differently. Here are today's claims and everything we have. Build me something that handles them."

## What's in this folder

- `claim_emails/`: today's 15 emails (C01–C15).  
- `claims_sop.md`: our written rules.  
- `shipments.csv`: shipment records, including proof-of-delivery (POD) notes.  
- `past_decisions_oct.csv`: what my team decided last month.

## What I need by the end

1. Something that **runs** on today's emails and produces `results.csv`. My team reviews in a sheet with these columns: `claim_id, shipment_id, decision, approved_amount_inr, reason, draft_reply`  
   - `decision` must be one of: `approve`, `reject`, `need_info`, `escalate`, `duplicate`, `not_a_claim`  
   - One row per claim. If an email has two claims, give it two rows with the same `claim_id`.  
2. A 5-minute walkthrough: what you built, what you'd do next, and anything you weren't sure about.

## Rules

- Use any tools you like: Claude, ChatGPT, Cursor, Python, a spreadsheet, anything. We expect you to use AI.  
- **Ask Meera anything, at any time.** She knows things that aren't written down.  
- Share your screen the whole time and think out loud.  
- You have **30** **minutes** to build.