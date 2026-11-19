/**
 * Deterministic, offline heuristic extractor (LLM_MODE=mock) plus the text detectors that are also
 * applied on top of real LLM output (they can only make an outcome stricter).
 * Pure: no I/O, no clock, no randomness. Workers-compatible.
 */
import type { ClaimType, ExtractedClaim, Extraction, Language, ParsedEmail } from "../types";

/* ------------------------------------------------------------ shipment ids */

const SHIPMENT_SRC = String.raw`\bSHP[\s-]*[0-9OoIl]{3,6}\b`;

export interface ShipmentMention {
  /** Exactly as written by the customer. */
  raw: string;
  /** Comparison key only (O->0, I/l->1). The engine does the real normalisation. */
  key: string;
  index: number;
}

export function shipmentKey(raw: string): string {
  const tail = raw
    .trim()
    .replace(/^shp[\s-]*/i, "")
    .replace(/[Oo]/g, "0")
    .replace(/[Il]/g, "1");
  return `SHP-${tail}`;
}

export function findShipmentMentions(text: string): ShipmentMention[] {
  const out: ShipmentMention[] = [];
  for (const m of text.matchAll(new RegExp(SHIPMENT_SRC, "gi"))) {
    const raw = m[0];
    if (!/\d/.test(raw.replace(/^shp[\s-]*/i, ""))) continue; // "SHP oil" is not an id
    out.push({ raw, key: shipmentKey(raw), index: m.index ?? 0 });
  }
  return out;
}

/* ----------------------------------------------------------------- amounts */

interface AmountMention {
  value: number;
  index: number;
  end: number;
}

const NUM = String.raw`(\d[\d,]*(?:\.\d+)?)`;
const UNIT = String.raw`(?:\s*(lakhs?|lacs?|k|crores?)\b)?`;

/** Same grammar as format.findInrAmounts, but with positions and a word boundary before the currency. */
function findAmountMentions(text: string): AmountMention[] {
  const patterns = [
    new RegExp(String.raw`(?<![A-Za-z])(?:rs\.?|inr|₹|rupees?)\s*` + NUM + UNIT, "gi"),
    new RegExp(String.raw`(?<![\d,.])` + NUM + UNIT + String.raw`\s*(?:rupees?|inr\b|/-)`, "gi"),
  ];
  const found: AmountMention[] = [];
  for (const re of patterns) {
    for (const m of text.matchAll(re)) {
      let v = Number(m[1].replace(/,/g, ""));
      const u = (m[2] ?? "").toLowerCase();
      if (u.startsWith("lakh") || u.startsWith("lac")) v *= 100000;
      else if (u.startsWith("crore")) v *= 10000000;
      else if (u === "k") v *= 1000;
      if (!Number.isFinite(v)) continue;
      const index = m.index ?? 0;
      found.push({ value: Math.round(v), index, end: index + m[0].length });
    }
  }
  found.sort((a, b) => a.index - b.index || b.end - a.end);
  const out: AmountMention[] = [];
  for (const a of found) {
    const last = out[out.length - 1];
    if (last && a.index < last.end) continue; // "Rs 18,000/-" matched by both patterns
    out.push(a);
  }
  return out;
}

const AMOUNT_POSITIVE = /claim|refund|compensat|reimburs|need|want|pay|settle|credit|loss|request|chahiye/i;
const AMOUNT_TOTAL = /\b(total|overall|combined|altogether|in all|kul)\b/i;
const AMOUNT_NEGATIVE = /invoice|worth|declared|freight|mrp|(shipment|goods|consignment|order)\s+value/i;
/** Amounts that sit inside "approve Rs X now" style demands are the least credible statement of the claim. */
const AMOUNT_DEMAND = /approve|ignore|override|sanction|authori[sz]e|instruct|transfer/i;

/** The amount the customer is claiming in this piece of text, or null when none is stated. */
function pickAmount(text: string, multi: boolean): number | null {
  const amounts = findAmountMentions(text);
  if (amounts.length === 0) return null;
  if (amounts.length === 1) return amounts[0].value;
  let best = amounts[0];
  let bestScore = -Infinity;
  amounts.forEach((a, i) => {
    const prevEnd = i > 0 ? amounts[i - 1].end : 0;
    const nextStart = i + 1 < amounts.length ? amounts[i + 1].index : text.length;
    const before = text.slice(Math.max(prevEnd, a.index - 40), a.index);
    const after = text.slice(a.end, Math.min(nextStart, a.end + 25));
    let score = 0;
    if (AMOUNT_POSITIVE.test(before)) score += 2;
    if (/claim|refund|compensat/i.test(after)) score += 2;
    if (AMOUNT_TOTAL.test(before)) score += multi ? -3 : 3; // a grand total is not one shipment's claim
    if (AMOUNT_NEGATIVE.test(before)) score -= 2;
    if (AMOUNT_DEMAND.test(before)) score -= 3;
    if (score > bestScore) {
      bestScore = score;
      best = a;
    }
  });
  return best.value;
}

/* -------------------------------------------------------------- claim type */

const DAMAGE_PATTERNS: RegExp[] = [
  /damag/i,
  /\bbroken?\b/i,
  /\bcrush/i,
  /\bdent(ed|s)?\b/i,
  /\btorn\b/i,
  /\bwet\b/i,
  /\bstain/i,
  /\bscratch/i,
  /\bleak/i,
  /\bspoil/i,
  /\bcrack/i,
  /\bbent\b/i,
  /\brust(ed|ing|y)?\b/i,
  /\bkharab\b/i,
  /\b(toot|toota|tooti|toote|tuta|tuti|tute|phata|phati|phate)\b/i,
  /\bsmash/i,
  /\bshatter/i,
  /\bsoak/i,
];

const SHORTAGE_STRONG: RegExp[] = [
  /\bshort(age|ages|fall)?\b/i,
  /\bshort[- ]?(delivered|delivery|received|supplied)\b/i,
  /\bmissing\b/i,
  /\bkam\b/i,
  /\bonly\s+\d+\s+(?:of|out\s+of)\s+\d+/i,
  /\b(nahi|nahin)\s+mil[ae]\b/i,
  /\bhi\s+mile\b/i,
];

const SHORTAGE_WEAK: RegExp[] = [/\bless\b/i, /\bnot\s+received\b/i];

function countMatches(patterns: RegExp[], text: string): number {
  let n = 0;
  for (const p of patterns) if (p.test(text)) n++;
  return n;
}

function scoreType(text: string): { damage: number; shortage: number; strongShortage: number } {
  const damage = countMatches(DAMAGE_PATTERNS, text);
  const strongShortage = countMatches(SHORTAGE_STRONG, text);
  return {
    damage: damage * 2,
    shortage: strongShortage * 2 + countMatches(SHORTAGE_WEAK, text),
    strongShortage,
  };
}

function classifyType(segment: string, full: string): ClaimType {
  for (const text of [segment, full]) {
    const s = scoreType(text);
    if (s.damage === 0 && s.shortage === 0) continue;
    return s.shortage > s.damage ? "shortage" : "damage";
  }
  return "damage";
}

/* ----------------------------------------------------------- pieces missing */

function stripIdsAndAmounts(text: string): string {
  let out = text.replace(new RegExp(SHIPMENT_SRC, "gi"), " ");
  const amounts = findAmountMentions(out);
  for (let i = amounts.length - 1; i >= 0; i--) {
    out = out.slice(0, amounts[i].index) + " " + out.slice(amounts[i].end);
  }
  return out;
}

function piecesMissing(segment: string): number | null {
  const text = stripIdsAndAmounts(segment);
  const n = String.raw`(?<![\d,.])(\d{1,5})(?![\d,.]*\d)`;
  const direct =
    new RegExp(n + String.raw`\s+(?:[a-z]+\s+){0,2}?(?:missing|short|kam)\b`, "i").exec(text) ??
    new RegExp(String.raw`\b(?:missing|short\s+by|shortage\s+of|short\s+of)\s+` + n, "i").exec(text);
  if (direct) return Number(direct[1]);
  const ofTotal = /(\d{1,5})\s+(?:out\s+of|of)\s+(?:the\s+)?(\d{1,5})\b/i.exec(text);
  if (ofTotal && Number(ofTotal[2]) > Number(ofTotal[1])) return Number(ofTotal[2]) - Number(ofTotal[1]);
  const hinglish = /(\d{1,5})\s+\w*\s*bhej[ae]\b[^.]*?(\d{1,5})\s+(?:hi\s+)?mil[ae]\b/i.exec(text);
  if (hinglish && Number(hinglish[1]) > Number(hinglish[2])) return Number(hinglish[1]) - Number(hinglish[2]);
  return null;
}

/* ---------------------------------------------------------------- detectors */

const NO_PHOTO_PATTERNS: RegExp[] = [
  /\bno\s+(?:photo|photos|photograph|photographs|picture|pictures|pic|pics|image|images|snap|snaps)\b/i,
  /\b(?:photo|picture|pic|image)s?\s+(?:are\s+|is\s+|were\s+)?(?:not\s+available|unavailable|nahi|nahin|not\s+taken|not\s+clicked)/i,
  /\b(?:don'?t|do\s+not|didn'?t|did\s+not|couldn'?t|could\s+not|can'?t|cannot|unable\s+to)\s+(?:have|take|click|provide|share|send|get)\s+(?:any\s+|the\s+)?(?:photo|picture|pic|image)/i,
  /\bwithout\s+(?:any\s+)?(?:photo|picture|image)/i,
];

/** True when the customer says there is no photo ("No photo, the box was thrown away"). */
export function detectNoPhotos(text: string): boolean {
  return NO_PHOTO_PATTERNS.some((p) => p.test(text));
}

const CONSEQUENTIAL_PATTERNS: RegExp[] = [
  /\bdown\s?-?time\b/i,
  /\bproduction\s+(?:loss|losses|stoppage|halt|delay|stopped|line\s+(?:stopped|down))/i,
  /\b(?:loss|stoppage|halt)\s+(?:of|in)\s+production\b/i,
  /\bline\s+(?:stoppage|stopped|down|shutdown)\b/i,
  /\blost\s+(?:sales?|business|revenue|orders?|profits?|customers?|income|production)\b/i,
  /\bloss\s+of\s+(?:profits?|business|sales?|revenue|income|earnings|orders?|production|goodwill|reputation)\b/i,
  /\b(?:business|revenue|profit|sales|opportunity)\s+loss(?:es)?\b/i,
  /\bpenalt(?:y|ies)\b/i,
  /\bconsequential\b/i,
  /\bliquidated\s+damages\b/i,
  /\bdemurrage\b/i,
  /\bopportunity\s+cost\b/i,
  /\bidle\s+(?:labou?r|time|workers|manpower)\b/i,
];

/** Downtime, production loss, lost sales/business, penalties, loss of profit... */
export function detectConsequentialLoss(text: string): boolean {
  return CONSEQUENTIAL_PATTERNS.some((p) => p.test(text));
}

/* ---------------------------------------------------------------- language */

/** Romanised-Hindi marker words. Deliberately excludes anything that is also common English ("the", "to", "hi", "me"). */
const HINGLISH_MARKERS = new Set([
  "bhai", "hain", "hai", "mein", "nahi", "nahin", "karo", "kare", "karein", "karna", "kijiye", "jaldi",
  "mile", "mila", "aaye", "aaya", "bheje", "bheja", "bhej", "kripya", "aap", "aapka", "aapki", "aapke",
  "hum", "humne", "humein", "humara", "hamara", "paisa", "paise", "kharab", "maal", "kam", "tha", "thi",
  "hua", "hui", "gaya", "gayi", "gaye", "kya", "kyun", "abhi", "bahut", "chahiye", "wala", "toota",
  "dabba", "saman", "samaan", "dijiye", "wapas", "namaste", "ji", "aur", "lekin", "yeh", "woh", "isliye",
  "liye", "dhanyavaad", "shukriya", "pehle", "koi", "ho", "ko", "ka", "ki", "ke",
]);

export function countHinglishMarkers(text: string): number {
  const seen = new Set<string>();
  for (const w of text.toLowerCase().match(/[a-z]+/g) ?? []) {
    if (HINGLISH_MARKERS.has(w)) seen.add(w);
  }
  return seen.size;
}

export function detectLanguage(text: string): Language {
  if ((text.match(/[ऀ-ॿ]/g) ?? []).length >= 5) return "hi";
  return countHinglishMarkers(text) >= 2 ? "hinglish" : "en";
}

/* ----------------------------------------------------------- customer name */

const SIGN_OFF =
  /^(?:best\s+|warm\s+|kind\s+)?(?:regards|thanks|thank\s+you|thanks\s*(?:and|&)\s*regards|sincerely|cheers|dhanyavaad|dhanyawad|shukriya|yours\s+(?:truly|faithfully|sincerely))[,.!]*$/i;
const NOT_A_NAME =
  /\b(please|claim|photo|photos|attached|urgent|asap|process|refund|thanks|regards|ignore|approve|rules?|manager|system|instructions?|immediately|karo|jaldi|kripya)\b/i;

function guessCustomerName(email: ParsedEmail): string | null {
  const lines = email.body
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => l.length > 0);
  if (lines.length >= 2) {
    const last = lines[lines.length - 1];
    const ok =
      !SIGN_OFF.test(last) &&
      last.length >= 2 &&
      last.length <= 60 &&
      last.split(/\s+/).length <= 6 &&
      /^[A-Z][A-Za-z .&'-]*(?:,\s*[A-Za-z][A-Za-z .&'-]*)?$/.test(last) &&
      !/[.?!:]$/.test(last) &&
      !NOT_A_NAME.test(last);
    if (ok) {
      const name = last.split(",")[0].trim();
      if (name) return name;
    }
  }
  const display = /^\s*"?([^"<@]+?)"?\s*</.exec(email.from);
  if (display) {
    const name = display[1].trim();
    if (name && name.length <= 60 && !NOT_A_NAME.test(name)) return name;
  }
  return null;
}

/* ------------------------------------------------------------ claim intent */

const CLAIM_INTENT = /\bclaim(?:s|ing|ed)?\b|\brefund|\bcompensat|\breimburs|\bcredit\s+note\b/i;
const DOC_REQUEST =
  /\b(invoice|pod|proof\s+of\s+delivery|statement|ledger|e-?way\s*bill|lr\s+copy|receipt|tracking|delivery\s+status)\b/i;
const THANKS = /\b(thank\s*you|thanks|thank\s+u|dhanyavaad|dhanyawad|shukriya)\b/i;
const RESOLVED =
  /\b(received|got|credited)\b[^.]{0,20}\b(payment|amount|money|refund|credit)\b|\b(payment|amount|money|refund)\b[^.]{0,20}\b(received|credited)\b|\b(settl|resolv)(ed|ing)\b/i;
const NEGATION = /\b(not|never|still|yet\s+to|pending|haven'?t|hasn'?t|didn'?t|nahi|nahin)\b/i;

function looksLikeClaim(full: string): boolean {
  const s = scoreType(full);
  const incident = s.damage > 0 || s.strongShortage > 0;
  const intent = CLAIM_INTENT.test(full);
  if (!incident && !intent) return false;
  // "Thanks, payment for our claim received" is not a new claim.
  if (!incident && THANKS.test(full) && RESOLVED.test(full) && !NEGATION.test(full)) return false;
  // Invoice / POD / statement copy request with nothing actually claimed.
  if (DOC_REQUEST.test(full) && !intent && findAmountMentions(full).length === 0) return false;
  return true;
}

/* ------------------------------------------------------------ segmentation */

function splitUnits(body: string): string[] {
  return body
    .split(/\n+/)
    .flatMap((line) => line.split(/(?<![Rr]s\.)(?<=[.!?])\s+/))
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}

/** One text segment per distinct shipment id: each sentence belongs to the id it (or the sentence before it) names. */
function segmentByShipment(body: string, keys: string[]): Map<string, string> {
  const parts = new Map<string, string[]>(keys.map((k) => [k, []]));
  let current: string | null = null;
  for (const unit of splitUnits(body)) {
    const distinct = [...new Set(findShipmentMentions(unit).map((m) => m.key))];
    if (distinct.length === 0) {
      if (current) parts.get(current)?.push(unit);
      continue;
    }
    if (distinct.length === 1) {
      current = distinct[0];
      parts.get(current)?.push(unit);
      continue;
    }
    // Several ids in one sentence: assign clause by clause.
    let local: string | null = null;
    let carry: string[] = [];
    for (const clause of unit.split(/,(?!\d)|;|&|\band\b|\baur\b/i)) {
      const mention = findShipmentMentions(clause)[0];
      if (mention) {
        local = mention.key;
        parts.get(local)?.push(...carry, clause);
        carry = [];
      } else if (local) {
        parts.get(local)?.push(clause);
      } else {
        carry.push(clause);
      }
    }
    if (local) current = local;
  }
  const out = new Map<string, string>();
  for (const [k, v] of parts) out.set(k, v.join(" ").trim());
  return out;
}

/* ------------------------------------------------------------------ public */

function buildClaim(raw: string | null, segment: string, full: string, multi: boolean): ExtractedClaim {
  const claim_type = classifyType(segment, full);
  const claimed_amount_inr = pickAmount(segment, multi);
  const pieces = claim_type === "shortage" ? piecesMissing(segment) : null;
  const what = claim_type === "damage" ? "Damage" : "Shortage";
  const summary =
    `${what} claim` +
    (raw ? ` for shipment ${raw}` : " with no shipment id given") +
    (claimed_amount_inr !== null ? `, amount claimed INR ${claimed_amount_inr}` : ", amount not stated") +
    (pieces !== null ? `, ${pieces} piece(s) reported missing` : "") +
    ".";
  return {
    shipment_id_raw: raw,
    claim_type,
    claimed_amount_inr,
    pieces_claimed_missing: pieces,
    summary,
    customer_states_no_photos: detectNoPhotos(segment),
    consequential_loss_mentioned: detectConsequentialLoss(segment),
  };
}

/**
 * Deterministic heuristic extraction. Only structures what the customer wrote: instructions,
 * urgency and tone in the email have no effect on any field.
 */
export function mockExtract(email: ParsedEmail): Extraction {
  const full = `${email.subject}\n${email.body}`;
  const language = detectLanguage(full);
  const customer_name = guessCustomerName(email);
  if (!looksLikeClaim(full)) return { is_claim: false, claims: [], language, customer_name };

  const order: string[] = [];
  const rawByKey = new Map<string, string>();
  for (const m of findShipmentMentions(full)) {
    if (rawByKey.has(m.key)) continue;
    rawByKey.set(m.key, m.raw);
    order.push(m.key);
  }

  let claims: ExtractedClaim[];
  if (order.length <= 1) {
    claims = [buildClaim(order.length === 1 ? (rawByKey.get(order[0]) ?? null) : null, full, full, false)];
  } else {
    const segments = segmentByShipment(email.body, order);
    claims = order.map((k) => buildClaim(rawByKey.get(k) ?? null, segments.get(k) || full, full, true));
  }
  return { is_claim: true, claims, language, customer_name };
}
