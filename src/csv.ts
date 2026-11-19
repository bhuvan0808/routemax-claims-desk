/**
 * Minimal RFC 4180 CSV reader/writer. Shared by loaders, CLI, Worker and evals.
 * Pure: works in Node and in Workers.
 */
import { RESULT_COLUMNS, type ResultRow } from "./types";

/** Quote a field if it contains a comma, quote, CR or LF. Quotes are doubled. */
export function csvEscape(value: unknown): string {
  const s = value === null || value === undefined ? "" : String(value);
  return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

export function toCsv(header: readonly string[], rows: ReadonlyArray<Record<string, unknown>>): string {
  const lines = [header.map(csvEscape).join(",")];
  for (const row of rows) lines.push(header.map((h) => csvEscape(row[h])).join(","));
  return lines.join("\r\n") + "\r\n";
}

/** results.csv: exactly the six required columns, in order. */
export function resultsToCsv(rows: ReadonlyArray<ResultRow>): string {
  return toCsv(RESULT_COLUMNS, rows as ReadonlyArray<Record<string, unknown>>);
}

/** Parse CSV text into rows of fields. Handles quoted fields, escaped quotes, embedded newlines, CRLF. */
export function parseCsvRows(text: string): string[][] {
  const rows: string[][] = [];
  let field = "";
  let row: string[] = [];
  let inQuotes = false;
  const src = text.replace(/^﻿/, "");
  for (let i = 0; i < src.length; i++) {
    const ch = src[i];
    if (inQuotes) {
      if (ch === '"') {
        if (src[i + 1] === '"') {
          field += '"';
          i++;
        } else {
          inQuotes = false;
        }
      } else {
        field += ch;
      }
      continue;
    }
    if (ch === '"') {
      inQuotes = true;
    } else if (ch === ",") {
      row.push(field);
      field = "";
    } else if (ch === "\n" || ch === "\r") {
      if (ch === "\r" && src[i + 1] === "\n") i++;
      row.push(field);
      field = "";
      rows.push(row);
      row = [];
    } else {
      field += ch;
    }
  }
  if (field !== "" || row.length > 0) {
    row.push(field);
    rows.push(row);
  }
  return rows.filter((r) => !(r.length === 1 && r[0].trim() === ""));
}

/** Parse CSV text with a header row into objects keyed by (trimmed) header name. */
export function parseCsv(text: string): Record<string, string>[] {
  const rows = parseCsvRows(text);
  if (rows.length === 0) return [];
  const header = rows[0].map((h) => h.trim());
  return rows.slice(1).map((r) => {
    const obj: Record<string, string> = {};
    header.forEach((h, i) => {
      obj[h] = (r[i] ?? "").trim();
    });
    return obj;
  });
}
