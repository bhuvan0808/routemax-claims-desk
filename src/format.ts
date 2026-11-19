/**
 * Shared money formatting/parsing so the engine, the drafter and the reply validator
 * all agree on what "Rs 1,20,000" means. Pure, no Intl dependency.
 */

/** 120000 -> "1,20,000" (Indian digit grouping). */
export function groupInr(amount: number): string {
  const n = Math.trunc(Math.abs(amount));
  const s = String(n);
  if (s.length <= 3) return (amount < 0 ? "-" : "") + s;
  const last3 = s.slice(-3);
  const rest = s.slice(0, -3).replace(/\B(?=(\d{2})+(?!\d))/g, ",");
  return (amount < 0 ? "-" : "") + rest + "," + last3;
}

/** 18000 -> "Rs 18,000" */
export function formatInr(amount: number): string {
  return `Rs ${groupInr(amount)}`;
}

/**
 * Every rupee amount mentioned in a text, as numbers.
 * Recognises: "Rs 18,000", "Rs. 18000", "INR 18,000", "₹18,000", "18,000 rupees", "18000/-", "Rs 1.2 lakh".
 */
export function findInrAmounts(text: string): number[] {
  const out: number[] = [];
  const num = String.raw`(\d[\d,]*(?:\.\d+)?)`;
  const unit = String.raw`(?:\s*(lakhs?|lacs?|k|crores?)\b)?`;
  const patterns = [
    new RegExp(String.raw`(?:rs\.?|inr|₹|rupees?)\s*` + num + unit, "gi"),
    new RegExp(num + unit + String.raw`\s*(?:rupees?|inr\b|/-)`, "gi"),
  ];
  const seen = new Set<string>();
  for (const re of patterns) {
    for (const m of text.matchAll(re)) {
      const key = `${m.index}:${m[0]}`;
      if (seen.has(key)) continue;
      seen.add(key);
      let v = Number(m[1].replace(/,/g, ""));
      const u = (m[2] ?? "").toLowerCase();
      if (u.startsWith("lakh") || u.startsWith("lac")) v *= 100000;
      else if (u.startsWith("crore")) v *= 10000000;
      else if (u === "k") v *= 1000;
      if (Number.isFinite(v)) out.push(Math.round(v));
    }
  }
  return out;
}
