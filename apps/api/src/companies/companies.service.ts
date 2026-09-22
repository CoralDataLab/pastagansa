import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
} from "@nestjs/common";
import { SifMode } from "@prisma/client";
import { ConfigService } from "@nestjs/config";
import { createHash } from "crypto";
import { AuditService } from "../audit/audit.service";
import { isValidIban, normalizeIban } from "../common/iban";
import { TenantContextService } from "../tenancy/tenant-context.service";
import {
  UpdateCompanyDocumentProfileDto,
  UpdateCompanyDto,
} from "./dto/update-company.dto";
import {
  inspectCompanyLogo,
  normalizedLogoMediaType,
} from "./company-logo";
import { SifDeclarationPdfService } from "../sif/sif-declaration-pdf.service";

export type UploadedCompanyLogo = {
  buffer: Buffer;
  mimetype?: string;
  size?: number;
};

@Injectable()
export class CompaniesService {
  constructor(
    private readonly tenant: TenantContextService,
    private readonly audit: AuditService,
    private readonly sifDeclaration: SifDeclarationPdfService,
    private readonly config: ConfigService,
  ) {}

  async current() {
    const context = this.tenant.required;
    if (!context.companyId) throw new NotFoundException("x-company-id is required");
    const company = await this.tenant.db.company.findFirst({
      where: { id: context.companyId, organizationId: context.organizationId },
      include: {
        documentProfile: true,
        documentLogo: {
          select: {
            id: true,
            mediaType: true,
            sizeBytes: true,
            width: true,
            height: true,
            sha256: true,
            updatedAt: true,
          },
        },
      },
    });
    if (!company) throw new NotFoundException("Company not found");
    return company;
  }

  async update(input: UpdateCompanyDto) {
    const company = await this.current();
    const targetMode = input.sifMode ?? company.sifMode;
    const targetEnvironment = input.aeatEnvironment ?? company.aeatEnvironment;
    if (targetMode !== company.sifMode &&
        (targetMode === SifMode.VERIFACTU || company.sifMode === SifMode.VERIFACTU) &&
        await this.tenant.db.sifRecord.count({
          where: { organizationId: company.organizationId, companyId: company.id },
        }))
      throw new ConflictException("Review the existing SIF chain before changing VERI*FACTU mode");
    if (targetMode === SifMode.VERIFACTU) {
      if (targetEnvironment !== "TEST")
        throw new ConflictException("VERI*FACTU is available only in the AEAT TEST environment");
      if (company.sifMode !== SifMode.VERIFACTU && this.config.get<string>("AEAT_TEST_ENABLED") !== "true")
        throw new ConflictException("VERI*FACTU requires the configured AEAT test sender");
      if (this.config.get<string>("AEAT_TEST_COMPANY_ID") !== company.id ||
          this.config.get<string>("AEAT_TEST_ISSUER_TAX_ID") !== company.taxId)
        throw new ConflictException("The AEAT test certificate is not bound to this issuing company");
      if (company.country !== "ES")
        throw new ConflictException("AEAT test mode requires a Spanish company");
    }
    if (
      (input.sifMode ?? company.sifMode) === SifMode.NO_VERIFACTU &&
      (input.aeatEnvironment ?? company.aeatEnvironment) === "PRODUCTION"
    )
      throw new ConflictException(
        "NO VERI*FACTU is not production-ready; use the AEAT test environment only",
      );
    if (targetMode === SifMode.NO_VERIFACTU && targetEnvironment === "TEST" &&
        (this.config.get<string>("SIF_NO_SIGNING_ENABLED") !== "true" ||
         this.config.get<string>("SIF_NO_COMPANY_ID") !== company.id ||
         this.config.get<string>("SIF_NO_ISSUER_TAX_ID") !== company.taxId))
      throw new ConflictException("NO VERI*FACTU test mode requires a signing certificate bound to this company");
    if (input.sifMode === SifMode.NO_VERIFACTU && company.country !== "ES")
      throw new ConflictException("El QR fiscal AEAT solo está disponible para empresas españolas");
    const { documentProfile, ...companyInput } = input;
    const companyData = Object.fromEntries(
      Object.entries(companyInput).filter(([, value]) => value !== undefined),
    );
    const profileData = documentProfile
      ? normalizeProfile(documentProfile)
      : undefined;
    if (Object.keys(companyData).length)
      await this.tenant.db.company.update({
        where: { id: company.id },
        data: companyData,
      });
    if (profileData && Object.keys(profileData).length) {
      const scope = this.scope();
      await this.tenant.db.companyDocumentProfile.upsert({
        where: { companyId: company.id },
        create: { ...scope, companyId: company.id, ...profileData },
        update: profileData,
      });
    }
    await this.audit.record("company.updated", "company", company.id, {
      changedFields: [
        ...Object.keys(companyData),
        ...(profileData ? Object.keys(profileData).map((key) => `documentProfile.${key}`) : []),
      ],
    });
    return this.current();
  }

  async downloadSifDeclaration() {
    const company = await this.current();
    return {
      filename: `borrador-declaracion-responsable-sif-${safeFilename(company.sifSoftwareId ?? company.id)}.pdf`,
      content: await this.sifDeclaration.render({ company }),
    };
  }

  async uploadLogo(file: UploadedCompanyLogo | undefined) {
    if (!file?.buffer?.length) throw new BadRequestException("Company logo is required");
    if (file.size !== undefined && file.size !== file.buffer.length)
      throw new BadRequestException("Company logo upload is incomplete");
    const details = inspectCompanyLogo(file.buffer);
    if (normalizedLogoMediaType(file.mimetype) !== details.mediaType)
      throw new BadRequestException("Company logo media type does not match its contents");
    const company = await this.current();
    const scope = this.scope();
    const logo = await this.tenant.db.companyDocumentLogo.upsert({
      where: { companyId: company.id },
      create: {
        ...scope,
        companyId: company.id,
        ...details,
        sizeBytes: file.buffer.length,
        sha256: createHash("sha256").update(file.buffer).digest("hex"),
        content: file.buffer,
      },
      update: {
        ...details,
        sizeBytes: file.buffer.length,
        sha256: createHash("sha256").update(file.buffer).digest("hex"),
        content: file.buffer,
      },
      select: {
        id: true,
        mediaType: true,
        sizeBytes: true,
        width: true,
        height: true,
        sha256: true,
        updatedAt: true,
      },
    });
    await this.audit.record("company.logo_uploaded", "company_document_logo", logo.id, {
      mediaType: logo.mediaType,
      sizeBytes: logo.sizeBytes,
      width: logo.width,
      height: logo.height,
      sha256: logo.sha256,
    });
    return logo;
  }

  async downloadLogo() {
    const logo = await this.tenant.db.companyDocumentLogo.findFirst({
      where: this.scope(),
      select: { mediaType: true, content: true },
    });
    if (!logo) throw new NotFoundException("Company logo not found");
    return logo;
  }

  async deleteLogo() {
    const company = await this.current();
    const result = await this.tenant.db.companyDocumentLogo.deleteMany({
      where: { ...this.scope(), companyId: company.id },
    });
    if (!result.count) throw new NotFoundException("Company logo not found");
    await this.audit.record("company.logo_deleted", "company", company.id);
  }

  private scope() {
    const { organizationId, companyId } = this.tenant.required;
    if (!companyId) throw new NotFoundException("x-company-id is required");
    return { organizationId, companyId };
  }
}

function safeFilename(value: string) {
  return value.replace(/[^a-zA-Z0-9._-]+/g, "-");
}

function normalizeProfile(input: UpdateCompanyDocumentProfileDto) {
  const profile = Object.fromEntries(
    Object.entries(input)
      .filter(([, value]) => value !== undefined)
      .map(([key, value]) => [key, normalizeOptionalText(value)]),
  ) as Record<string, string | null>;
  if (profile.addressCountry) profile.addressCountry = profile.addressCountry.toUpperCase();
  if (profile.email) profile.email = profile.email.toLowerCase();
  if (profile.primaryColor) profile.primaryColor = profile.primaryColor.toUpperCase();
  if ("bankIban" in profile) {
    profile.bankIban = normalizeIban(profile.bankIban);
    if (profile.bankIban && !isValidIban(profile.bankIban))
      throw new BadRequestException("Company IBAN checksum is invalid");
  }
  return profile;
}

function normalizeOptionalText(value: unknown) {
  if (value === null) return null;
  if (typeof value !== "string") return value as string;
  const trimmed = value.trim();
  return trimmed || null;
}
