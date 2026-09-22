import { ConflictException, Injectable } from "@nestjs/common";
import { Company, Prisma } from "@prisma/client";
import { createHash } from "node:crypto";
import { TenantContextService } from "../tenancy/tenant-context.service";
import { type SifEventHashInput } from "./sif-event-hash";
import { verifySifEventChain, verifySifEventTail } from "./sif-event-chain";
import { renderSifBasicEventXml } from "./sif-event-xml";
import { formatSifTimestamp } from "./sif-hash-v1";
import { SifNoSigningService } from "./sif-no-signing.service";
import { captureSifSoftwareSnapshot } from "./sif-software-profile";

@Injectable()
export class SifNoEventService {
  constructor(
    private readonly tenant: TenantContextService,
    private readonly signer: SifNoSigningService,
  ) {}

  async verifyChain() {
    const scope = this.tenant.required;
    if (!scope.companyId) throw new ConflictException("A company is required for SIF event verification");
    const events = await this.tenant.db.sifEventRecord.findMany({
      where: { organizationId: scope.organizationId, companyId: scope.companyId },
      orderBy: { chainPosition: "asc" },
    });
    return verifySifEventChain(events);
  }

  /** Appends a signed start/stop event in the caller's tenant transaction. */
  async appendBasic(company: Company, eventType: "01" | "02") {
    const scope = this.tenant.required;
    if (scope.organizationId !== company.organizationId || scope.companyId !== company.id ||
        !this.signer.matches(company.id, company.taxId))
      throw new ConflictException("NO VERI*FACTU event signer does not match this company");
    const software = captureSifSoftwareSnapshot(company);
    if (!software.configured)
      throw new ConflictException("NO VERI*FACTU event requires a complete software profile");
    await this.tenant.db.$executeRaw`
      SELECT pg_advisory_xact_lock(hashtextextended(${company.id}, 1))
    `;
    const tail = await this.tenant.db.sifEventRecord.findMany({
      where: { organizationId: scope.organizationId, companyId: company.id },
      orderBy: { chainPosition: "desc" }, take: 2,
    });
    const previous = tail[0];
    if (previous) {
      const verification = await verifySifEventTail(previous, tail[1] ?? null);
      if (!verification.valid)
        throw new ConflictException(`NO VERI*FACTU event chain failed at position ${verification.firstInvalid?.chainPosition}`);
    }
    const generatedAt = new Date();
    if (previous && previous.generatedAt > generatedAt)
      throw new ConflictException("System clock precedes the latest NO VERI*FACTU event");
    const formatted = formatSifTimestamp(generatedAt, company.timezone);
    const hashInput: SifEventHashInput = {
      producerTaxId: software.producerTaxId!,
      softwareId: software.softwareId!,
      softwareVersion: software.softwareVersion!,
      installationNumber: software.installationNumber!,
      issuerTaxId: company.taxId,
      eventType,
      previousHash: previous?.eventHash ?? null,
      generatedAt: formatted,
    };
    const event = renderSifBasicEventXml({
      ...hashInput,
      eventType,
      producerName: software.producerName!,
      softwareName: software.softwareName!,
      issuerName: company.legalName,
      previous: previous ? {
        eventType: previous.eventType,
        generatedAt: (previous.hashInput as SifEventHashInput).generatedAt,
        hash: previous.eventHash,
      } : null,
    });
    const signedXml = await this.signer.sign(event.xml);
    return this.tenant.db.sifEventRecord.create({
      data: {
        organizationId: scope.organizationId,
        companyId: company.id,
        eventType,
        chainPosition: (previous?.chainPosition ?? 0n) + 1n,
        generatedAt,
        previousEventId: previous?.id ?? null,
        previousEventHash: previous?.eventHash ?? null,
        eventHash: event.hash,
        hashInput: hashInput as Prisma.InputJsonObject,
        signedXml,
        signedXmlSha256: createHash("sha256").update(signedXml).digest("hex"),
        softwareSnapshot: software as Prisma.InputJsonObject,
      },
    });
  }
}
