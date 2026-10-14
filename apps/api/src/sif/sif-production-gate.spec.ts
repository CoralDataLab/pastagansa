import { ConfigService } from "@nestjs/config";
import { createHash } from "node:crypto";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  sifProductionReleaseMatches,
  verifiedProductionDeclaration,
} from "./sif-production-gate";

describe("SIF production release gate", () => {
  it("binds the reviewed artifact bytes to one company", () => {
    const directory = mkdtempSync(join(tmpdir(), "sif-release-"));
    const path = join(directory, "declaration.pdf");
    const original = Buffer.from("reviewed declaration");
    try {
      writeFileSync(path, original);
      const config = new ConfigService({
        SIF_PRODUCTION_RELEASE_ENABLED: "true",
        SIF_PRODUCTION_RELEASE_COMPANY_ID: "22222222-2222-4222-8222-222222222222",
        SIF_PRODUCTION_DECLARATION_PATH: path,
        SIF_PRODUCTION_DECLARATION_SHA256: createHash("sha256").update(original).digest("hex"),
      });
      expect(sifProductionReleaseMatches(config, "22222222-2222-4222-8222-222222222222")).toBe(true);
      expect(sifProductionReleaseMatches(config, "33333333-3333-4333-8333-333333333333")).toBe(false);
      writeFileSync(path, "altered declaration");
      expect(sifProductionReleaseMatches(config, "22222222-2222-4222-8222-222222222222")).toBe(false);
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it("returns the signed declaration only while its bytes match the pinned hash", () => {
    const directory = mkdtempSync(join(tmpdir(), "sif-release-"));
    const path = join(directory, "declaration.pdf");
    const original = Buffer.from("signed declaration");
    const values = {
      SIF_PRODUCTION_RELEASE_ENABLED: "true",
      SIF_PRODUCTION_DECLARATION_PATH: path,
      SIF_PRODUCTION_DECLARATION_SHA256: createHash("sha256").update(original).digest("hex").toUpperCase(),
    };
    try {
      expect(verifiedProductionDeclaration(new ConfigService(values))).toBeUndefined();
      writeFileSync(path, original);
      expect(verifiedProductionDeclaration(new ConfigService(values))).toEqual(original);
      expect(verifiedProductionDeclaration(new ConfigService({
        ...values,
        SIF_PRODUCTION_RELEASE_ENABLED: "false",
      }))).toBeUndefined();
      writeFileSync(path, "altered declaration");
      expect(verifiedProductionDeclaration(new ConfigService(values))).toBeUndefined();
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });
});
