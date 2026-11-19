/**
 * Deterministic grounding checks on LLM extraction output.
 * The LLM structures what the customer wrote; it must not invent it. Anything the extractor
 * returns that cannot be found in the email text is discarded BEFORE the rules engine runs,
 * so a hallucinated (or injected) amount / shipment id can never reach a decision.
 * Pure: no I/O.
 */
import { findInrAmounts } from "./format";

/** Every number written in the text (commas removed), plus rupee amounts with units ("1.2 lakh"). */
export function numbersInText(text: string): number[] {
  const out = new Set<number>();
  for (const m of text.matchAll(/\d[\d,]*(?:\.\d+)?/g)) {
    const v = Number(m[0].replace(/,/g, ""));
    if (Number.isFinite(v)) out.add(Math.round(v));
  }
  for (const v of findInrAmounts(text)) out.add(v);
  return [...out];
}

/** The extracted amount is kept only if that number is actually written in the email. */
export function groundAmount(
  amount: number | null,
  text: string,
): { amount: number | null; grounded: boolean } {
  if (amount === null) return { amount: null, grounded: true };
  if (!Number.isFinite(amount) || amount < 0) return { amount: null, grounded: false };
  const rounded = Math.round(amount);
  return numbersInText(text).includes(rounded)
    ? { amount: rounded, grounded: true }
    : { amount: null, grounded: false };
}

const SHIPMENT_MENTION = /\bSHP[\s_-]*[0-9OoIiLl]{3,6}\b/gi;

/** All shipment-id-looking strings in the text, exactly as written. */
export function shipmentMentions(text: string): string[] {
  return [...text.matchAll(SHIPMENT_MENTION)].map((m) => m[0]);
}

/**
 * Re-ground the extracted shipment id on the text as the customer actually wrote it.
 * If the LLM "helpfully" corrected SHP-1O10 to SHP-1010 we recover the original spelling,
 * so the engine still knows it was a fuzzy match. Returns null if no mention in the email
 * normalises to the same id (i.e. the extractor made it up).
 */
export function groundShipmentId(
  raw: string | null,
  text: string,
  normalise: (raw: string | null) => { id: string | null; corrected: boolean },
): { raw: string | null; grounded: boolean } {
  if (raw === null || raw.trim() === "") return { raw: null, grounded: true };
  const target = normalise(raw).id;
  const mentions = shipmentMentions(text);
  const compact = (s: string) => s.replace(/[\s_-]+/g, "").toUpperCase();
  // 1) exactly as written
  const exact = mentions.find((m) => compact(m) === compact(raw));
  if (exact) return { raw: exact, grounded: true };
  // 2) a mention that normalises to the same canonical id
  if (target) {
    const same = mentions.find((m) => normalise(m).id === target);
    if (same) return { raw: same, grounded: true };
  }
  // 3) ids that are not SHP-shaped at all: accept only if the literal string is in the email
  if (text.toUpperCase().includes(raw.trim().toUpperCase())) return { raw: raw.trim(), grounded: true };
  return { raw: null, grounded: false };
}
