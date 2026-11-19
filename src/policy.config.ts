/**
 * Policy switches. Every value here changes money outcomes, so each default and its
 * evidence is recorded in ASSUMPTIONS.md under "Questions for Meera".
 *
 * Switchable WITHOUT code changes:
 *   - env var POLICY_OVERRIDES = JSON, e.g. {"smallClaimPhotoWaiverInr":5000}
 *     (CLI: .env or shell; Worker: wrangler var / dashboard)
 *   - CLI flag:  npm run claims -- --policy '{"shortageProRata":true}'
 */
import { PolicyConfigSchema, type PolicyConfig } from "./types";

export const defaultPolicy: PolicyConfig = {
  /** SOP rule 1: "Claims must be filed within 7 days of delivery." */
  defaultWindowDays: 7,
  /**
   * Not in the SOP. Evidence: 4 consistent October decisions for Zenith Retail
   * (C-0904, C-0911, C-0933 approved at 12-13 days citing "key account - 15 day window";
   *  C-0914 rejected at 17 days citing "outside 15 day window").
   */
  keyAccountWindows: { "Zenith Retail": 15 },
  /**
   * 0 = off (SOP rule 2 says photos are required). October shows 5 small no-photo damage
   * claims approved (C-0901, C-0906, C-0909, C-0913, C-0918, all < Rs 5,000) but C-0920
   * (Rs 4,200, no photo) was sent back for photos. Inconsistent, so default follows the SOP.
   */
  smallClaimPhotoWaiverInr: 0,
  /** If true, shortage payable is also capped at (missing / shipped) * declared value. */
  shortageProRata: false,
  /** If false, claims mentioning downtime / lost sales are never auto-approved (escalated). */
  payConsequentialLoss: false,
  /** SOP rule 6: "Claims above Rs 50,000 must be approved by the Claims Manager." */
  approvalLimitInr: 50000,
};

/**
 * Merge overrides onto the defaults and validate.
 * Accepts a partial object, a JSON string (env POLICY_OVERRIDES), or nothing.
 * Throws on invalid config: a bad policy must never be silently ignored.
 */
export function resolvePolicy(
  overrides?: Partial<PolicyConfig> | string | null,
  base: PolicyConfig = defaultPolicy,
): PolicyConfig {
  let patch: Partial<PolicyConfig> = {};
  if (typeof overrides === "string") {
    const trimmed = overrides.trim();
    if (trimmed) patch = JSON.parse(trimmed) as Partial<PolicyConfig>;
  } else if (overrides) {
    patch = overrides;
  }
  return PolicyConfigSchema.parse({ ...base, ...patch });
}
