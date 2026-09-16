import {
  ConflictException,
  Injectable,
  NotFoundException,
} from "@nestjs/common";
import {
  DocumentType,
  InvoiceStatus,
  Prisma,
  RectificationImpact,
  SifRecord,
  SifRecordType,
  SifMode,
} from "@prisma/client";
import { Decimal } from "@prisma/client/runtime/library";
import { AuditService } from "../audit/audit.service";
import { TenantContextService } from "../tenancy/tenant-context.service";
import {
  formatSifIssueDate,
  formatSifTimestamp,
  hashSifCancellation,
  hashSifRegistration,
  SIF_HASH_SPECIFICATION_VERSION,
} from "./sif-hash-v1";
import { verifySifChain } from "./sif-chain";
import { captureSifSoftwareSnapshot } from "./sif-software-profile";
import {
  renderSifAeatXml,
  type SifXmlPreviousRecord,
  type SifXmlRegistration,
  type SifXmlSoftware,
} from "./sif-xml";

@Injectable()
export class SifService {
  constructor(
    private readonly tenant: TenantContextService,
    private readonly audit: AuditService,
  ) {}

  async listForInvoice(invoiceId: string) {
    return (
      await this.tenant.db.sifRecord.findMany({
        where: { invoiceId, ...this.scope() },
        orderBy: { chainPosition: "asc" },
      })
    ).map(presentSifRecord);
  }

  async verifyChain() {
    const records = await this.tenant.db.sifRecord.findMany({
      where: this.scope(),
      orderBy: { chainPosition: "asc" },
    });
    return verifySifChain(records);
  }

  /**
   * Produces one unsigned AEAT XML batch for inspection/validation. It never
   * changes the chain and intentionally does not transmit it to AEAT.
   */
  async exportXml(recordId: string) {
    const record = await this.tenant.db.sifRecord.findFirst({
      where: { id: recordId, ...this.scope() },
      include: {
        previousRecord: {
          select: {
            issuerTaxId: true,
            invoiceNumber: true,
            invoiceIssueDate: true,
            recordHash: true,
          },
        },
        invoice: {
          select: {
            issuerLegalName: true,
            issuerTaxId: true,
            customerLegalName: true,
            customerTaxId: true,
            notes: true,
            sifInvoiceType: true,
            lines: { select: { description: true }, orderBy: { position: "asc" } },
            taxLines: {
              select: {
                taxableBase: true,
                taxRate: true,
                taxAmount: true,
                subject: true,
                exempt: true,
                reverseCharge: true,
                surchargeRate: true,
                surchargeAmount: true,
              },
            },
          },
        },
      },
    });
    if (!record) throw new NotFoundException("SIF record not found");

    const immutableXml = storedAeatXml(record.payload);
    if (immutableXml)
      return {
        filename: `sif-${record.chainPosition.toString()}-${record.recordType.toLowerCase()}.xml`,
        content: Buffer.from(immutableXml, "utf8"),
      };
    const snapshotUnavailable = storedXmlSnapshotUnavailable(record.payload);
    if (snapshotUnavailable) throw new ConflictException(snapshotUnavailable);

    const software = readSoftwareSnapshot(record.softwareSnapshot);
    const previousRecord: SifXmlPreviousRecord | null = record.previousRecord
      ? {
          issuerTaxId: record.previousRecord.issuerTaxId,
          invoiceNumber: record.previousRecord.invoiceNumber,
          issueDate: formatSifIssueDate(record.previousRecord.invoiceIssueDate),
          hash: record.previousRecord.recordHash,
        }
      : null;
    const common = {
      previousRecord,
      software,
      generatedAt: historicalTimestamp(record.payload),
      recordHash: record.recordHash,
    };
    const xml =
      record.recordType === SifRecordType.CANCELLATION
        ? renderSifAeatXml({
            header: {
              issuerLegalName: record.invoice.issuerLegalName,
              issuerTaxId: record.invoice.issuerTaxId,
            },
            record: {
              kind: "CANCELLATION",
              issuerTaxId: record.issuerTaxId,
              invoiceNumber: record.invoiceNumber,
              issueDate: formatSifIssueDate(record.invoiceIssueDate),
              ...common,
            },
          })
        : renderSifAeatXml({
            header: {
              issuerLegalName: record.invoice.issuerLegalName,
              issuerTaxId: record.invoice.issuerTaxId,
            },
            record: registrationXmlRecord(record.invoice, {
              issuerTaxId: record.issuerTaxId,
              invoiceNumber: record.invoiceNumber,
              issueDate: formatSifIssueDate(record.invoiceIssueDate),
              invoiceType: record.invoiceType,
              taxTotal: record.taxTotal.toFixed(2),
              total: record.total.toFixed(2),
              ...common,
            }),
          });

    return {
      filename: `sif-${record.chainPosition.toString()}-${record.recordType.toLowerCase()}.xml`,
      content: Buffer.from(xml, "utf8"),
    };
  }

  async createRegistration(invoiceId: string) {
    const scope = this.scope();
    await this.tenant.db.$executeRaw`
      SELECT pg_advisory_xact_lock(hashtextextended(${scope.companyId}, 0))
    `;
    const existing = await this.tenant.db.sifRecord.findFirst({
      where: {
        invoiceId,
        recordType: SifRecordType.REGISTRATION,
        ...scope,
      },
    });
    if (existing) return presentSifRecord(existing);

    const invoice = await this.tenant.db.invoice.findFirst({
      where: { id: invoiceId, ...scope },
      select: {
        id: true,
        documentType: true,
        sifInvoiceType: true,
        rectificationImpact: true,
        issuerTaxId: true,
        fullNumber: true,
        issueDate: true,
        taxTotal: true,
        total: true,
        status: true,
        sifMode: true,
        aeatEnvironment: true,
        issuerLegalName: true,
        customerLegalName: true,
        customerTaxId: true,
        notes: true,
        lines: { select: { description: true }, orderBy: { position: "asc" } },
        taxLines: {
          select: {
            taxableBase: true,
            taxRate: true,
            taxAmount: true,
            subject: true,
            exempt: true,
            reverseCharge: true,
            surchargeRate: true,
            surchargeAmount: true,
          },
        },
        company: {
          select: {
            timezone: true,
            sifSoftwareProducerName: true,
            sifSoftwareProducerTaxId: true,
            sifSoftwareName: true,
            sifSoftwareId: true,
            sifSoftwareVersion: true,
            sifInstallationNumber: true,
          },
        },
      },
    });
    if (
      !invoice ||
      invoice.status === InvoiceStatus.DRAFT ||
      !invoice.fullNumber
    )
      throw new ConflictException(
        "Only issued invoices can generate a SIF registration",
      );

    // DISABLED invoices are issued under the pre-adaptation workflow. Do not
    // append new records to the experimental SIF chain; existing records are
    // left untouched and remain readable through the idempotency check above.
    if (invoice.sifMode === SifMode.DISABLED) return null;
    if (invoice.sifMode === SifMode.VERIFACTU)
      throw new ConflictException(
        "VERI*FACTU cannot issue invoices until AEAT transmission is configured",
      );
    if (invoice.aeatEnvironment !== "TEST")
      throw new ConflictException(
        "NO VERI*FACTU is not production-ready; use the AEAT test environment only",
      );

    const softwareSnapshot = captureSifSoftwareSnapshot(invoice.company);
    if (invoice.sifMode === SifMode.NO_VERIFACTU && !softwareSnapshot.configured)
      throw new ConflictException(
        "Complete the SIF producer profile with a two-character software ID before issuing invoices in no VERI*FACTU mode",
      );

    const previous = await this.tenant.db.sifRecord.findFirst({
      where: scope,
      orderBy: { chainPosition: "desc" },
    });
    const generatedAt = new Date(Math.floor(Date.now() / 1_000) * 1_000);
    const sign =
      invoice.documentType === DocumentType.CREDIT_NOTE &&
      invoice.rectificationImpact === RectificationImpact.DECREASE
        ? new Decimal(-1)
        : new Decimal(1);
    const hashInput = {
      issuerTaxId: invoice.issuerTaxId,
      invoiceNumber: invoice.fullNumber,
      issueDate: formatSifIssueDate(invoice.issueDate),
      invoiceType: invoice.sifInvoiceType,
      taxTotal: invoice.taxTotal.mul(sign).toFixed(2),
      total: invoice.total.mul(sign).toFixed(2),
      previousHash: previous?.recordHash ?? "",
      generatedAt: formatSifTimestamp(generatedAt, invoice.company.timezone),
    };
    const recordHash = hashSifRegistration(hashInput);
    const previousRecord: SifXmlPreviousRecord | null = previous
      ? {
          issuerTaxId: previous.issuerTaxId,
          invoiceNumber: previous.invoiceNumber,
          issueDate: formatSifIssueDate(previous.invoiceIssueDate),
          hash: previous.recordHash,
        }
      : null;
    let aeatXml: string | null = null;
    let xmlSnapshotUnavailable: string | null = null;
    try {
      aeatXml = renderSifAeatXml({
        header: {
          issuerLegalName: invoice.issuerLegalName,
          issuerTaxId: invoice.issuerTaxId,
        },
        record: registrationXmlRecord(invoice, {
          issuerTaxId: hashInput.issuerTaxId,
          invoiceNumber: hashInput.invoiceNumber,
          issueDate: hashInput.issueDate,
          invoiceType: hashInput.invoiceType,
          taxTotal: hashInput.taxTotal,
          total: hashInput.total,
          previousRecord,
          software: readSoftwareSnapshot(softwareSnapshot),
          generatedAt: hashInput.generatedAt,
          recordHash,
        }),
      });
    } catch (error) {
      if (!(error instanceof ConflictException)) throw error;
      xmlSnapshotUnavailable = error.message;
    }
    const payload: Prisma.InputJsonObject = {
      hashInput,
      firstRecord: previous === null,
      previousRecord,
      ...(aeatXml ? { aeatXml } : { xmlSnapshotUnavailable }),
    };
    const record = await this.tenant.db.sifRecord.create({
      data: {
        ...scope,
        invoiceId: invoice.id,
        recordType: SifRecordType.REGISTRATION,
        chainPosition: (previous?.chainPosition ?? 0n) + 1n,
        issuerTaxId: hashInput.issuerTaxId,
        invoiceNumber: hashInput.invoiceNumber,
        invoiceIssueDate: invoice.issueDate,
        invoiceType: hashInput.invoiceType,
        taxTotal: hashInput.taxTotal,
        total: hashInput.total,
        generatedAt,
        previousRecordId: previous?.id,
        previousRecordHash: previous?.recordHash,
        recordHash,
        specificationVersion: SIF_HASH_SPECIFICATION_VERSION,
        payload,
        softwareSnapshot,
      },
    });
    await this.audit.record("sif_record.registered", "sif_record", record.id, {
      invoiceId: invoice.id,
      chainPosition: record.chainPosition.toString(),
      recordHash,
      specificationVersion: SIF_HASH_SPECIFICATION_VERSION,
    });
    return presentSifRecord(record);
  }

  /**
   * Appends, rather than replaces, the AEAT record that identifies a prior
   * registration as cancelled. This deliberately does not alter the invoice,
   * its accounting entry, or its tax ledger: those financial corrections use a
   * rectifying invoice and are a separate workflow.
   */
  async createCancellation(invoiceId: string) {
    const scope = this.scope();
    await this.tenant.db.$executeRaw`
      SELECT pg_advisory_xact_lock(hashtextextended(${scope.companyId}, 0))
    `;
    const existing = await this.tenant.db.sifRecord.findFirst({
      where: { invoiceId, recordType: SifRecordType.CANCELLATION, ...scope },
    });
    if (existing) return presentSifRecord(existing);

    const invoice = await this.tenant.db.invoice.findFirst({
      where: { id: invoiceId, ...scope },
      select: {
        id: true,
        status: true,
        issuerLegalName: true,
        issuerTaxId: true,
        company: { select: { timezone: true } },
      },
    });
    if (!invoice) throw new NotFoundException("Invoice not found");
    if (invoice.status === InvoiceStatus.DRAFT)
      throw new ConflictException(
        "Only an issued invoice can generate a SIF cancellation",
      );

    const registration = await this.tenant.db.sifRecord.findFirst({
      where: { invoiceId, recordType: SifRecordType.REGISTRATION, ...scope },
    });
    if (!registration)
      throw new ConflictException(
        "Only an invoice with a SIF registration can be cancelled",
      );

    const previous = await this.tenant.db.sifRecord.findFirst({
      where: scope,
      orderBy: { chainPosition: "desc" },
    });
    const generatedAt = new Date(Math.floor(Date.now() / 1_000) * 1_000);
    const hashInput = {
      issuerTaxId: registration.issuerTaxId,
      invoiceNumber: registration.invoiceNumber,
      issueDate: formatSifIssueDate(registration.invoiceIssueDate),
      previousHash: previous?.recordHash ?? "",
      generatedAt: formatSifTimestamp(generatedAt, invoice.company.timezone),
    };
    const recordHash = hashSifCancellation(hashInput);
    const previousRecord: SifXmlPreviousRecord | null = previous
      ? {
          issuerTaxId: previous.issuerTaxId,
          invoiceNumber: previous.invoiceNumber,
          issueDate: formatSifIssueDate(previous.invoiceIssueDate),
          hash: previous.recordHash,
        }
      : null;
    let aeatXml: string | null = null;
    let xmlSnapshotUnavailable: string | null = null;
    try {
      aeatXml = renderSifAeatXml({
        header: {
          issuerLegalName: invoice.issuerLegalName,
          issuerTaxId: invoice.issuerTaxId,
        },
        record: {
          kind: "CANCELLATION",
          issuerTaxId: hashInput.issuerTaxId,
          invoiceNumber: hashInput.invoiceNumber,
          issueDate: hashInput.issueDate,
          previousRecord,
          software: readSoftwareSnapshot(registration.softwareSnapshot),
          generatedAt: hashInput.generatedAt,
          recordHash,
        },
      });
    } catch (error) {
      if (!(error instanceof ConflictException)) throw error;
      xmlSnapshotUnavailable = error.message;
    }
    const payload: Prisma.InputJsonObject = {
      hashInput,
      cancellationOf: {
        registrationId: registration.id,
        registrationHash: registration.recordHash,
      },
      previousRecord,
      ...(aeatXml ? { aeatXml } : { xmlSnapshotUnavailable }),
    };
    const record = await this.tenant.db.sifRecord.create({
      data: {
        ...scope,
        invoiceId: registration.invoiceId,
        recordType: SifRecordType.CANCELLATION,
        chainPosition: (previous?.chainPosition ?? 0n) + 1n,
        issuerTaxId: registration.issuerTaxId,
        invoiceNumber: registration.invoiceNumber,
        invoiceIssueDate: registration.invoiceIssueDate,
        invoiceType: registration.invoiceType,
        taxTotal: registration.taxTotal,
        total: registration.total,
        generatedAt,
        previousRecordId: previous?.id,
        previousRecordHash: previous?.recordHash,
        recordHash,
        specificationVersion: SIF_HASH_SPECIFICATION_VERSION,
        payload,
        softwareSnapshot: registration.softwareSnapshot ?? undefined,
      },
    });
    await this.audit.record("sif_record.cancelled", "sif_record", record.id, {
      invoiceId: registration.invoiceId,
      registrationId: registration.id,
      chainPosition: record.chainPosition.toString(),
      recordHash,
      specificationVersion: SIF_HASH_SPECIFICATION_VERSION,
    });
    return presentSifRecord(record);
  }

  private scope() {
    const { organizationId, companyId } = this.tenant.required;
    if (!companyId) throw new Error("Company context is required");
    return { organizationId, companyId };
  }
}

function historicalTimestamp(payload: Prisma.JsonValue): string {
  const hashInput = payload && typeof payload === "object" && !Array.isArray(payload)
    ? payload.hashInput : null;
  const timestamp = hashInput && typeof hashInput === "object" && !Array.isArray(hashInput)
    ? hashInput.generatedAt : null;
  if (typeof timestamp !== "string" || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}[+-]\d{2}:\d{2}$/.test(timestamp))
    throw new ConflictException("Stored SIF hash timestamp is missing or invalid");
  return timestamp;
}

function presentSifRecord(record: SifRecord) {
  return { ...record, chainPosition: record.chainPosition.toString() };
}

function storedAeatXml(payload: Prisma.JsonValue): string | null {
  if (!payload || typeof payload !== "object" || Array.isArray(payload))
    return null;
  return typeof payload.aeatXml === "string" ? payload.aeatXml : null;
}

function storedXmlSnapshotUnavailable(payload: Prisma.JsonValue): string | null {
  if (!payload || typeof payload !== "object" || Array.isArray(payload))
    return null;
  return typeof payload.xmlSnapshotUnavailable === "string"
    ? payload.xmlSnapshotUnavailable
    : null;
}

type RegistrationInvoice = {
  issuerLegalName: string;
  sifInvoiceType: string;
  customerLegalName: string;
  customerTaxId: string | null;
  notes: string | null;
  lines: Array<{ description: string }>;
  taxLines: Parameters<typeof aggregateTaxLines>[0];
};

function registrationXmlRecord(
  invoice: RegistrationInvoice,
  meta: Omit<SifXmlRegistration, "kind" | "issuerLegalName" | "customer" | "description" | "taxLines">,
): SifXmlRegistration {
  if (invoice.sifInvoiceType !== "F1")
    throw new ConflictException(
      "SIF XML export for rectifying invoices requires the pending rectification mapping",
    );
  if (!invoice.customerTaxId)
    throw new ConflictException(
      "SIF XML export requires the customer's tax identifier",
    );
  const taxLines = aggregateTaxLines(invoice.taxLines);
  if (!taxLines.length || taxLines.length > 12)
    throw new ConflictException(
      "SIF XML export requires between one and twelve supported VAT breakdown lines",
    );
  const description = [
    ...invoice.lines.map((line) => line.description.trim()),
    invoice.notes?.trim(),
  ]
    .filter(Boolean)
    .join(" · ")
    .slice(0, 500);
  if (!description)
    throw new ConflictException(
      "SIF XML export requires an invoice operation description",
    );
  return {
    kind: "REGISTRATION",
    issuerLegalName: invoice.issuerLegalName,
    customer: { legalName: invoice.customerLegalName, taxId: invoice.customerTaxId },
    description,
    taxLines,
    ...meta,
  };
}

function readSoftwareSnapshot(value: Prisma.JsonValue): SifXmlSoftware {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new ConflictException("SIF XML export requires a complete software snapshot");
  const snapshot = value as Record<string, unknown>;
  const fields = [
    "producerName",
    "producerTaxId",
    "softwareName",
    "softwareId",
    "softwareVersion",
    "installationNumber",
  ] as const;
  const missing = fields.find(
    (field) => typeof snapshot[field] !== "string" || !snapshot[field],
  );
  if (missing)
    throw new ConflictException("SIF XML export requires a complete software snapshot");
  if (!/^[A-Z0-9]{2}$/.test(snapshot.softwareId as string))
    throw new ConflictException(
      "SIF XML export requires an AEAT software ID of two uppercase letters or digits",
    );
  return Object.fromEntries(fields.map((field) => [field, snapshot[field]])) as SifXmlSoftware;
}

function aggregateTaxLines(
  source: Array<{
    taxableBase: Decimal;
    taxRate: Decimal | null;
    taxAmount: Decimal;
    subject: boolean;
    exempt: boolean;
    reverseCharge: boolean;
    surchargeRate: Decimal | null;
    surchargeAmount: Decimal;
  }>,
) {
  const grouped = new Map<
    string,
    { taxableBase: Decimal; taxRate: Decimal; taxAmount: Decimal; reverseCharge: boolean }
  >();
  for (const line of source) {
    if (
      !line.subject ||
      line.exempt ||
      line.taxRate === null ||
      line.surchargeRate !== null ||
      !line.surchargeAmount.isZero()
    )
      throw new ConflictException(
        "SIF XML export does not yet support exempt, non-subject, or surcharge VAT lines",
      );
    const key = `${line.taxRate.toFixed(2)}:${line.reverseCharge}`;
    const existing = grouped.get(key);
    if (existing) {
      existing.taxableBase = existing.taxableBase.add(line.taxableBase);
      existing.taxAmount = existing.taxAmount.add(line.taxAmount);
    } else
      grouped.set(key, {
        taxableBase: new Decimal(line.taxableBase),
        taxRate: new Decimal(line.taxRate),
        taxAmount: new Decimal(line.taxAmount),
        reverseCharge: line.reverseCharge,
      });
  }
  return [...grouped.values()].map((line) => ({
    taxableBase: line.taxableBase.toFixed(2),
    taxRate: line.taxRate.toFixed(2),
    taxAmount: line.taxAmount.toFixed(2),
    reverseCharge: line.reverseCharge,
  }));
}
