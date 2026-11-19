/**
 * NODE ONLY: reads the seed CSVs from disk. Never import this from Worker code
 * (and it is deliberately not re-exported from ./index).
 */
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { parsePastDecisionsCsv, parseShipmentsCsv, type SeedData } from "./index";

async function readText(path: string): Promise<string> {
  try {
    return await readFile(path, "utf8");
  } catch (err) {
    throw new Error(`cannot read seed data file ${path}: ${err instanceof Error ? err.message : String(err)}`);
  }
}

/** Reads and validates <dataDir>/shipments.csv and <dataDir>/past_decisions_oct.csv. Throws on any bad row. */
export async function loadSeedData(dataDir: string): Promise<SeedData> {
  const [shipmentsText, pastText] = await Promise.all([
    readText(join(dataDir, "shipments.csv")),
    readText(join(dataDir, "past_decisions_oct.csv")),
  ]);
  return {
    shipments: parseShipmentsCsv(shipmentsText),
    pastDecisions: parsePastDecisionsCsv(pastText),
  };
}
