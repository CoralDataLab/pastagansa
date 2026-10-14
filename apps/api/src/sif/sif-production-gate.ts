import { ConfigService } from "@nestjs/config";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";

/** Signed declaration bytes of the deployed version, only when they match the pinned SHA-256. */
export function verifiedProductionDeclaration(config: ConfigService): Buffer | undefined {
  if (config.get<string>("SIF_PRODUCTION_RELEASE_ENABLED") !== "true") return undefined;
  const path = config.get<string>("SIF_PRODUCTION_DECLARATION_PATH");
  const expected = config.get<string>("SIF_PRODUCTION_DECLARATION_SHA256")?.toLowerCase();
  if (!path || !expected || !/^[0-9a-f]{64}$/.test(expected)) return undefined;
  try {
    const content = readFileSync(path);
    return createHash("sha256").update(content).digest("hex") === expected ? content : undefined;
  } catch {
    return undefined;
  }
}

/** Explicit, company-bound release gate for a reviewed declaration artifact. */
export function sifProductionReleaseMatches(config: ConfigService, companyId: string): boolean {
  return config.get<string>("SIF_PRODUCTION_RELEASE_COMPANY_ID") === companyId &&
    verifiedProductionDeclaration(config) !== undefined;
}
