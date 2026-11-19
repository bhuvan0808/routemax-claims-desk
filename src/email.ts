/**
 * Deterministic email parsing + idempotency hashing. No LLM, no clock.
 * Headers (From, Date, Subject, Attachments) are the only trusted part of an email.
 * Pure: works in Node and in Workers (WebCrypto).
 */
import type { ParsedEmail } from "./types";

const IMAGE_EXTENSIONS = new Set([
  "jpg",
  "jpeg",
  "png",
  "heic",
  "heif",
  "gif",
  "webp",
  "bmp",
  "tif",
  "tiff",
]);

const KNOWN_HEADERS = new Set(["from", "date", "subject", "attachments", "to", "cc"]);

export function isImageFile(name: string): boolean {
  const m = /\.([a-z0-9]+)$/i.exec(name.trim());
  return !!m && IMAGE_EXTENSIONS.has(m[1].toLowerCase());
}

/** "2026-11-10 09:12" | "2026-11-10T09:12:00Z" | "10 Nov 2026 09:12" -> "2026-11-10". Never falls back to "now". */
export function parseHeaderDate(value: string): string | null {
  const v = value.trim();
  if (!v) return null;
  const iso = /^(\d{4})-(\d{2})-(\d{2})(?:\b|T|\s|$)/.exec(v);
  if (iso) {
    const [, y, m, d] = iso;
    return isValidYmd(+y, +m, +d) ? `${y}-${m}-${d}` : null;
  }
  // RFC 2822-ish: "Tue, 10 Nov 2026 09:12:00 +0530" -> use the date as WRITTEN (sender's calendar day).
  const rfc = /(\d{1,2})\s+([A-Za-z]{3})[a-z]*\.?,?\s+(\d{4})/.exec(v);
  if (rfc) {
    const months = ["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"];
    const mi = months.indexOf(rfc[2].toLowerCase());
    const d = +rfc[1];
    const y = +rfc[3];
    if (mi >= 0 && isValidYmd(y, mi + 1, d)) return `${y}-${pad2(mi + 1)}-${pad2(d)}`;
  }
  return null;
}

function pad2(n: number): string {
  return String(n).padStart(2, "0");
}

function isValidYmd(y: number, m: number, d: number): boolean {
  if (m < 1 || m > 12 || d < 1 || d > 31) return false;
  const dt = new Date(Date.UTC(y, m - 1, d));
  return dt.getUTCFullYear() === y && dt.getUTCMonth() === m - 1 && dt.getUTCDate() === d;
}

/** Whole calendar days from `fromYmd` to `toYmd` (both YYYY-MM-DD). Pure date arithmetic, no timezones. */
export function calendarDaysBetween(fromYmd: string, toYmd: string): number {
  const a = /^(\d{4})-(\d{2})-(\d{2})$/.exec(fromYmd);
  const b = /^(\d{4})-(\d{2})-(\d{2})$/.exec(toYmd);
  if (!a || !b) return NaN;
  const ua = Date.UTC(+a[1], +a[2] - 1, +a[3]);
  const ub = Date.UTC(+b[1], +b[2] - 1, +b[3]);
  return Math.round((ub - ua) / 86400000);
}

export function parseAttachments(value: string): string[] {
  const v = value.trim();
  if (!v || /^(none|nil|n\/a|na|no|-|0)$/i.test(v)) return [];
  return v
    .split(/[,;]/)
    .map((s) => s.trim())
    .filter((s) => s.length > 0 && !/^(none|nil|n\/a)$/i.test(s));
}

/**
 * The address that actually sent the mail, from a From header.
 *
 * The display name is free text the sender types, so it proves nothing:
 *   From: "ops@apexpharma.in" <refunds@fastpay-claims.biz>
 * is mail from fastpay-claims.biz. Rules:
 *   - if there are angle brackets, ONLY addresses inside them count (RFC 5322 addr-spec);
 *   - otherwise quoted strings and (comments) are stripped before looking for an address;
 *   - exactly one distinct address must remain. None, or several different ones, means the
 *     sender cannot be established: return "" so no customer can ever match (-> need_info).
 */
export function parseSender(from: string): { sender_email: string; sender_domain: string } {
  const unknown = { sender_email: "", sender_domain: "" };
  const ADDRESS = /([A-Za-z0-9._%+-]+)@([A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)*\.[A-Za-z]{2,})/g;
  const angled = [...from.matchAll(/<([^<>]*)>/g)].map((m) => m[1]);
  const searchIn =
    angled.length > 0
      ? angled.join(" ")
      : from.replace(/"(?:[^"\\]|\\.)*"/g, " ").replace(/\([^()]*\)/g, " ");
  const found = [...searchIn.matchAll(ADDRESS)].map((m) => ({
    email: `${m[1]}@${m[2]}`.toLowerCase(),
    domain: m[2].toLowerCase(),
  }));
  const distinct = new Set(found.map((f) => f.email));
  if (distinct.size !== 1) return unknown;
  return { sender_email: found[0].email, sender_domain: found[0].domain };
}

export function parseEmail(raw: string): ParsedEmail {
  const text = raw.replace(/^﻿/, "").replace(/\r\n?/g, "\n");
  const lines = text.split("\n");
  const headers: Record<string, string> = {};
  let i = 0;
  // Leading blank lines are tolerated; headers end at the first blank line or first non-header line.
  while (i < lines.length && lines[i].trim() === "") i++;
  for (; i < lines.length; i++) {
    const line = lines[i];
    if (line.trim() === "") {
      i++;
      break;
    }
    const m = /^([A-Za-z-]+):\s?(.*)$/.exec(line);
    if (!m || !KNOWN_HEADERS.has(m[1].toLowerCase())) break;
    const key = m[1].toLowerCase();
    if (!(key in headers)) headers[key] = m[2].trim(); // first occurrence wins: a body cannot override a header
  }
  const body = lines.slice(i).join("\n").trim();

  const from = headers["from"] ?? "";
  const { sender_email, sender_domain } = parseSender(from);
  const date_raw = headers["date"] ?? "";
  const attachments = parseAttachments(headers["attachments"] ?? "");

  return {
    from,
    sender_email,
    sender_domain,
    date_raw,
    date: parseHeaderDate(date_raw),
    subject: headers["subject"] ?? "",
    attachments,
    image_attachments: attachments.filter(isImageFile),
    body,
    raw,
  };
}

/** Normalise for idempotency: line endings, trailing space, runs of blank lines, outer whitespace. Case is kept. */
export function normaliseEmailText(raw: string): string {
  return raw
    .replace(/^﻿/, "")
    .replace(/\r\n?/g, "\n")
    .split("\n")
    .map((l) => l.replace(/[ \t]+/g, " ").trim())
    .join("\n")
    .replace(/\n{2,}/g, "\n\n")
    .trim();
}

/** sha256 hex of the normalised email. Idempotency key. */
export async function hashEmail(raw: string): Promise<string> {
  const data = new TextEncoder().encode(normaliseEmailText(raw));
  const digest = await crypto.subtle.digest("SHA-256", data);
  return Array.from(new Uint8Array(digest))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

/** First shipment-looking id in free text, as written. Used only to label not_a_claim rows. */
export function findShipmentIdMention(text: string): string | null {
  const m = /\bSHP[\s-]*[0-9OoIl]{3,6}\b/i.exec(text);
  return m ? m[0] : null;
}
