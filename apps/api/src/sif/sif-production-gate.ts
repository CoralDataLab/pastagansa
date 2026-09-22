import { ConfigService } from "@nestjs/config";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";

/** Explicit, company-bound release gate for a reviewed declaration artifact. */
export function sifProductionReleaseMatches(config: ConfigService, companyId: string): boolean {
  if (config.get<string>("SIF_PRODUCTION_RELEASE_ENABLED") !== "true" ||
      config.get<string>("SIF_PRODUCTION_RELEASE_COMPANY_ID") !== companyId)
    return false;
  const path = config.get<string>("SIF_PRODUCTION_DECLARATION_PATH");
  const expected = config.get<string>("SIF_PRODUCTION_DECLARATION_SHA256")?.toLowerCase();
  if (!path || !expected || !/^[0-9a-f]{64}$/.test(expected)) return false;
  try {
    return createHash("sha256").update(readFileSync(path)).digest("hex") === expected;
  } catch {
    return false;
  }
}
