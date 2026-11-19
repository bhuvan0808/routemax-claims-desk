/**
 * Pure helpers for the rules engine: shipment id normalisation, sender/customer matching,
 * POD remark parsing. No I/O, no clock, no randomness.
 */

/* ------------------------------------------------------------ shipment id */

const NO_ID = { id: null, corrected: false } as const;

/**
 * "SHP-1O10" -> { id: "SHP-1010", corrected: true }   (letter O typed for zero: a fuzzy match)
 * "shp 1010" -> { id: "SHP-1010", corrected: false }  (case / spacing / dash only)
 * `corrected` is true ONLY when a character was substituted (O->0, I/L->1).
 */
export function normaliseShipmentId(raw: string | null | undefined): {
  id: string | null;
  corrected: boolean;
} {
  if (typeof raw !== "string") return { ...NO_ID };
  const s = raw
    .toUpperCase()
    .replace(/[\s_\-‐-―−]+/g, "") // whitespace, underscores, ASCII + unicode dashes
    .replace(/^[^A-Z0-9]+|[^A-Z0-9]+$/g, ""); // stray quotes / trailing full stop
  if (!s.startsWith("SHP")) return { ...NO_ID };
  const rest = s.slice(3).replace(/^[#:.]+/, "");
  const digits = rest.replace(/O/g, "0").replace(/[IL]/g, "1");
  if (!/^\d{3,6}$/.test(digits)) return { ...NO_ID };
  return { id: `SHP-${digits}`, corrected: digits !== rest };
}

/* ------------------------------------------------------- sender identity */

const FREE_MAIL = new Set([
  "gmail.com",
  "outlook.com",
  "hotmail.com",
  "rediffmail.com",
  "icloud.com",
  "live.com",
  "protonmail.com",
]);
const TLD_ISH = new Set(["com", "co", "in", "net", "org", "io", "biz"]);

function alnum(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9]/g, "");
}

function candidateMatches(s: string, customerKey: string): boolean {
  if (!s || !customerKey) return false;
  if (s === customerKey) return true;
  if (s.length < 4 || customerKey.length < 4) return false;
  return s.includes(customerKey) || (s.length >= 6 && customerKey.startsWith(s));
}

/**
 * Does the From address plausibly belong to the shipment's customer?
 * Free-mail senders are matched on the mailbox name, everyone else on the registrable
 * domain label (the label left of the TLD: "orbitauto" in purchase@orbitauto.in).
 * Sub-domains are deliberately NOT matched, so ops@apexpharma.attacker.com is not Apex Pharma.
 */
export function senderMatchesCustomer(senderEmail: string, customer: string): boolean {
  const email = (senderEmail ?? "").trim().toLowerCase();
  const at = email.lastIndexOf("@");
  if (at <= 0 || at === email.length - 1) return false;
  const local = email.slice(0, at);
  const domain = email.slice(at + 1);
  const customerKey = alnum(customer ?? "");
  if (!customerKey) return false;

  if (FREE_MAIL.has(domain) || domain.startsWith("yahoo.")) {
    return candidateMatches(alnum(local), customerKey);
  }
  const labels = domain.split(".").filter((l) => l.length > 0);
  if (labels.length < 2) return false;
  labels.pop(); // the TLD itself
  while (labels.length > 1 && TLD_ISH.has(labels[labels.length - 1])) labels.pop(); // "co" in .co.in
  return candidateMatches(alnum(labels[labels.length - 1]), customerKey);
}

/* ------------------------------------------------------------ POD remarks */

const UNIT = String.raw`(?:pieces?|pcs?|nos?|units?|items?|qty)\.?`;
const RECEIVED = String.raw`(?:received|recd|rcvd)`;
const NOT_PIECES = String.raw`(?:box(?:es)?|cartons?|ctns?|rolls?|pallets?|bags?|cases?|packs?|packets?|drums?|bundles?|crates?)`;
const DAMAGE = String.raw`(?:damaged?|broken|wet|crushed|dented|torn|stained|open(?:ed)?|leaking|leaked|bad|poor|scratched|bent)`;

/** Piece-count statements. Each has the count in group 1. */
const RECEIVED_PATTERNS = [
  // "37 of 40 received", "37/40 pcs received"
  String.raw`\b(\d+)\s*(?:\/|of|out\s+of)\s*\d+\s*(?:${UNIT}\s*)?(?:were\s+|was\s+)?${RECEIVED}\b`,
  // "37 pieces received", "20 received", "only 20 pcs recd" (but not "2 units received damaged")
  String.raw`\b(\d+)\s*(?:${UNIT}\s*)?(?:were\s+|was\s+)?${RECEIVED}\b(?!\s+(?:in\s+)?${DAMAGE}\b)`,
  // "received 20", "received: 20 pcs" (but not "received 2 cartons dented" / "received 2 damaged")
  String.raw`\b${RECEIVED}\s*[:\-]?\s*(?:only\s+)?(\d+)\b(?!\s*(?:${UNIT}\s*)?(?:${NOT_PIECES}|${DAMAGE})\b)(?:\s*(?:\/|of|out\s+of)\s*\d+)?(?:\s*${UNIT})?`,
];
const SHORT_PATTERNS = [
  // "3 short", "3 pieces short", "3 pcs missing"
  String.raw`\b(\d+)\s*(?:${UNIT}\s*)?(?:short|missing)\b`,
  // "short by 3", "shortage of 3"
  String.raw`\bshort(?:age)?\s*(?:by|of|:)?\s*(\d+)\b(?!\s*${NOT_PIECES}\b)(?:\s*${UNIT})?`,
];

function firstCount(text: string, patterns: string[]): number | null {
  for (const p of patterns) {
    const m = new RegExp(p, "i").exec(text);
    if (m) return Number(m[1]);
  }
  return null;
}

/**
 * Pieces received according to the POD remarks, or null when the remarks give no piece count.
 * "37 pieces received" -> 37, "20 received" -> 20, "3 short" / "short by 3" -> piecesShipped - 3.
 * "1 box crushed", "2 cartons dented", "cartons wet", "" -> null (damage notes, not counts).
 * Contradictory remarks ("37 received, 5 short" of 40) -> null, so a human checks.
 */
export function parsePodReceivedCount(remarks: string, piecesShipped: number): number | null {
  const text = (remarks ?? "").trim();
  if (!text) return null;
  const received = firstCount(text, RECEIVED_PATTERNS);
  const short = firstCount(text, SHORT_PATTERNS);
  const fromShort =
    short !== null && Number.isInteger(piecesShipped) && piecesShipped - short >= 0
      ? piecesShipped - short
      : null;
  if (short !== null && fromShort === null) return null;
  if (received !== null && fromShort !== null) return received === fromShort ? received : null;
  return received ?? fromShort;
}

const NEUTRAL_REMARK = new RegExp(
  String.raw`\b(?:(?:all\s+)?(?:${RECEIVED}\s+)?(?:in\s+)?good\s+(?:condition|order)|no\s+(?:damages?|remarks?|shortage)|only|all|total|ok(?:ay)?|nil|none|n\/a|and|${UNIT})\b`,
  "gi",
);

/**
 * True when the POD remarks say something beyond a bare piece count / "ok".
 * "1 box crushed" -> true. "", "12 pieces received", "ok" -> false.
 */
export function hasSubstantiveRemark(remarks: string): boolean {
  let text = (remarks ?? "").toLowerCase();
  if (!text.trim()) return false;
  for (const p of [...RECEIVED_PATTERNS, ...SHORT_PATTERNS]) text = text.replace(new RegExp(p, "gi"), " ");
  text = text.replace(NEUTRAL_REMARK, " ");
  return /[a-z0-9]/.test(text);
}

export function podSignedGoodCondition(podStatus: string): boolean {
  return /good\s+condition/i.test(podStatus ?? "");
}
