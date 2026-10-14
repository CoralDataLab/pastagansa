import { ConfigService } from "@nestjs/config";
import { createHash } from "node:crypto";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AuditService } from "../audit/audit.service";
import { SifDeclarationPdfService } from "../sif/sif-declaration-pdf.service";
import { SifNoEventService } from "../sif/sif-no-event.service";
import { TenantContextService } from "../tenancy/tenant-context.service";
import { CompaniesService } from "./companies.service";

const companyId = "22222222-2222-4222-8222-222222222222";
const draft = Buffer.from("generated draft");

function service(config: Record<string, string>) {
  const company = { id: companyId, organizationId: "11111111-1111-4111-8111-111111111111", sifSoftwareId: "PG" };
  const tenant = {
    required: { companyId, organizationId: company.organizationId },
    db: { company: { findFirst: async () => company } },
  } as unknown as TenantContextService;
  const declaration = { render: async () => draft } as unknown as SifDeclarationPdfService;
  return new CompaniesService(
    tenant,
    {} as AuditService,
    declaration,
    new ConfigService(config),
    {} as SifNoEventService,
  );
}

describe("CompaniesService SIF declaration", () => {
  it("offers the generated draft while no signed declaration is installed", async () => {
    const companies = service({});
    await expect(companies.downloadSifDeclaration()).resolves.toEqual({
      filename: "borrador-declaracion-responsable-sif-PG.pdf",
      content: draft,
    });
    await expect(companies.settings()).resolves.toMatchObject({ sifDeclarationSigned: false });
  });

  it("offers the verified signed declaration of the deployed version", async () => {
    const directory = mkdtempSync(join(tmpdir(), "sif-declaration-"));
    const path = join(directory, "declaration.pdf");
    const signed = Buffer.from("%PDF- signed declaration");
    try {
      writeFileSync(path, signed);
      const companies = service({
        SIF_PRODUCTION_RELEASE_ENABLED: "true",
        // Another company holds the remission gate; the declaration still covers this installation.
        SIF_PRODUCTION_RELEASE_COMPANY_ID: "33333333-3333-4333-8333-333333333333",
        SIF_PRODUCTION_DECLARATION_PATH: path,
        SIF_PRODUCTION_DECLARATION_SHA256: createHash("sha256").update(signed).digest("hex"),
      });
      await expect(companies.downloadSifDeclaration()).resolves.toEqual({
        filename: "declaracion-responsable-sif-PG.pdf",
        content: signed,
      });
      await expect(companies.settings()).resolves.toMatchObject({ sifDeclarationSigned: true });
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });
});
