import {
  ConflictException,
  Injectable,
  NotFoundException,
  Optional,
} from "@nestjs/common";
import {
  DocumentType,
  InvoiceStatus,
  Prisma,
  RectificationImpact,
  SifRecord,
  SifAeatSubmissionStatus,
  SifRecordType,
  SifMode,
} from "@prisma/client";
import { Decimal } from "@prisma/client/runtime/library";
import { createHash } from "node:crypto";
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
import { AeatTestClient } from "./aeat-test.client";
import { captureSifSoftwareSnapshot } from "./sif-software-profile";
import { RecoverRejectedRegistrationDto } from "./dto/recover-rejected-registration.dto";
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
    @Optional() private readonly aeatTest?: AeatTestClient,
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

  /** Inventory only: it never declares a historical chain suitable for regulated use. */
  async transitionAudit() {
    const scope = this.scope();
    const groups = await this.tenant.db.$queryRaw<Array<{
      sifMode: string;
      aeatEnvironment: string;
      recordType: string;
      softwareId: string | null;
      records: number;
      frozenXmlRecords: number;
      unavailableXmlRecords: number;
      legacyXmlRecords: number;
      firstPosition: string;
      lastPosition: string;
    }>>`
      SELECT i.sif_mode::text AS "sifMode",
             i.aeat_environment::text AS "aeatEnvironment",
             r.record_type::text AS "recordType",
             r.software_snapshot->>'softwareId' AS "softwareId",
             COUNT(*)::int AS "records",
             COUNT(*) FILTER (WHERE r.payload ? 'aeatXml')::int AS "frozenXmlRecords",
             COUNT(*) FILTER (WHERE r.payload ? 'xmlSnapshotUnavailable')::int AS "unavailableXmlRecords",
             COUNT(*) FILTER (WHERE NOT (r.payload ? 'aeatXml')
                               AND NOT (r.payload ? 'xmlSnapshotUnavailable'))::int AS "legacyXmlRecords",
             MIN(r.chain_position)::text AS "firstPosition",
             MAX(r.chain_position)::text AS "lastPosition"
      FROM sif_records r
      JOIN invoices i ON i.id = r.invoice_id
        AND i.organization_id = r.organization_id
        AND i.company_id = r.company_id
      WHERE r.organization_id = CAST(${scope.organizationId} AS uuid)
        AND r.company_id = CAST(${scope.companyId} AS uuid)
      GROUP BY i.sif_mode, i.aeat_environment, r.record_type,
               r.software_snapshot->>'softwareId'
      ORDER BY MIN(r.chain_position), r.record_type
    `;
    const totalRecords = groups.reduce((sum, group) => sum + group.records, 0);
    return {
      companyId: scope.companyId,
      totalRecords,
      historicalChainReviewRequired: totalRecords > 0,
      groups: groups.map((group) => ({
        ...group,
        softwareIdValid: group.softwareId !== null && /^[A-Z0-9]{2}$/.test(group.softwareId),
      })),
      note: "This is a read-only historical inventory, not a compliance decision or authorization to reuse, discard, or restart a SIF chain.",
    };
  }

  /** Read-only, tenant-scoped view of the AEAT test outbox. */
  async testSubmissionOverview() {
    const scope = this.scope();
    const [groups, attention, review] = await Promise.all([
      this.tenant.db.sifAeatSubmission.groupBy({
        by: ["status"],
        where: scope,
        _count: { _all: true },
      }),
      this.tenant.db.sifAeatSubmission.findMany({
        where: {
          ...scope,
          status: { in: [
            SifAeatSubmissionStatus.UNKNOWN,
            SifAeatSubmissionStatus.FAILED,
            SifAeatSubmissionStatus.RETRY,
          ] },
        },
        orderBy: { updatedAt: "desc" },
        take: 20,
        select: {
          id: true, status: true, attempts: true, availableAt: true,
          lastAttemptAt: true, lastError: true,
          record: { select: {
            chainPosition: true,
            invoice: { select: { id: true, fullNumber: true } },
          } },
        },
      }),
      this.tenant.db.sifAeatSubmission.findMany({
        where: {
          ...scope,
          status: { in: [
            SifAeatSubmissionStatus.ACCEPTED_WITH_ERRORS,
            SifAeatSubmissionStatus.REJECTED,
          ] },
        },
        orderBy: { updatedAt: "desc" },
        take: 20,
        select: {
          id: true, status: true, recordStatus: true, errorCode: true,
          errorDescription: true, lastError: true, csv: true,
          record: { select: {
            id: true, recordType: true, chainPosition: true,
            invoice: { select: {
              id: true, fullNumber: true,
              sifRecords: {
                where: { recordType: { in: [SifRecordType.SUBSANATION, SifRecordType.CANCELLATION] } },
                orderBy: { chainPosition: "asc" },
                select: {
                  recordType: true, chainPosition: true, payload: true,
                  aeatSubmissions: { take: 1, select: { status: true } },
                },
              },
            } },
          } },
        },
      }),
    ]);
    const counts = Object.fromEntries(
      Object.values(SifAeatSubmissionStatus).map((status) => [status, 0]),
    ) as Record<SifAeatSubmissionStatus, number>;
    for (const group of groups) counts[group.status] = group._count._all;
    return {
      companyId: scope.companyId,
      counts,
      attention: attention.map((item) => ({
        id: item.id,
        status: item.status,
        attempts: item.attempts,
        availableAt: item.availableAt,
        lastAttemptAt: item.lastAttemptAt,
        lastError: item.lastError,
        chainPosition: item.record.chainPosition.toString(),
        invoiceId: item.record.invoice.id,
        invoiceNumber: item.record.invoice.fullNumber ?? "Sin número",
      })),
      review: review.map((item) => {
        const followUps = item.record.recordType === SifRecordType.REGISTRATION
          ? item.record.invoice.sifRecords
              .filter((record) => followUpSourceId(record.payload) === item.record.id)
              .map((record) => ({
                recordType: record.recordType,
                chainPosition: record.chainPosition.toString(),
                status: record.aeatSubmissions[0]?.status ?? null,
                resolutionNote: recoveryResolutionNote(record.payload),
              }))
          : [];
        const timestampCandidate =
          item.record.recordType === SifRecordType.REGISTRATION &&
          item.status === SifAeatSubmissionStatus.ACCEPTED_WITH_ERRORS &&
          item.recordStatus === "AceptadoConErrores" &&
          item.errorDescription?.includes("FechaHoraHusoGenRegistro") === true;
        return {
          id: item.id,
          status: item.status,
          recordStatus: item.recordStatus,
          errorCode: item.errorCode,
          errorDescription: item.errorDescription,
          lastError: item.lastError,
          csv: item.csv,
          recordType: item.record.recordType,
          chainPosition: item.record.chainPosition.toString(),
          invoiceId: item.record.invoice.id,
          invoiceNumber: item.record.invoice.fullNumber ?? "Sin número",
          followUps,
          reviewKind: item.status === SifAeatSubmissionStatus.REJECTED &&
              item.recordStatus !== "Incorrecto"
            ? "GLOBAL_REJECTION_REVIEW"
            : followUps.length > 0
              ? "FOLLOW_UP_RECORDED"
              : timestampCandidate
                ? "TIMESTAMP_SUBSANATION_CANDIDATE"
                : item.record.recordType === SifRecordType.REGISTRATION &&
                    item.status === SifAeatSubmissionStatus.REJECTED &&
                    item.recordStatus === "Incorrecto"
                  ? "REJECTED_REGISTRATION_REVIEW"
                : "MANUAL_REVIEW",
        };
      }),
    };
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
            issueDate: true,
            operationDate: true,
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
    if (record.recordType === SifRecordType.SUBSANATION)
      throw new ConflictException("Subsanation XML requires its original immutable snapshot");
    if (record.recordType === SifRecordType.REGISTRATION && record.invoiceType !== "F1")
      throw new ConflictException(
        "Historical rectification XML cannot be reconstructed without its original immutable snapshot",
      );

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
        operationDate: true,
        taxTotal: true,
        total: true,
        status: true,
        sifMode: true,
        aeatEnvironment: true,
        issuerLegalName: true,
        customerLegalName: true,
        customerTaxId: true,
        notes: true,
        originalInvoice: {
          select: { issuerTaxId: true, fullNumber: true, issueDate: true, operationDate: true },
        },
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
    if (invoice.sifMode === SifMode.VERIFACTU && !this.aeatTest?.enabled)
      throw new ConflictException(
        "VERI*FACTU test issuance requires the AEAT test sender to be configured",
      );
    if (invoice.aeatEnvironment !== "TEST")
      throw new ConflictException(
        "SIF test issuance requires the AEAT test environment; production is not enabled",
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
    if (invoice.sifMode === SifMode.VERIFACTU && !aeatXml)
      throw new ConflictException(xmlSnapshotUnavailable ?? "VERI*FACTU test issuance requires exportable XML");
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
    if (invoice.sifMode === SifMode.VERIFACTU)
      await this.enqueueAeatTest(record.id, aeatXml!);
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
   * its accounting entry, or its tax ledger. The invoice-issued-in-error flow
   * composes this operation with append-only financial reversals.
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
        sifMode: true,
        aeatEnvironment: true,
        company: { select: { timezone: true } },
      },
    });
    if (!invoice) throw new NotFoundException("Invoice not found");
    if (invoice.status === InvoiceStatus.DRAFT)
      throw new ConflictException(
        "Only an issued invoice can generate a SIF cancellation",
      );
    if (invoice.sifMode === SifMode.VERIFACTU &&
        (invoice.aeatEnvironment !== "TEST" || !this.aeatTest?.enabled))
      throw new ConflictException("VERI*FACTU cancellation requires the AEAT test sender");

    const registration = await this.tenant.db.sifRecord.findFirst({
      where: { invoiceId, recordType: SifRecordType.REGISTRATION, ...scope },
    });
    if (!registration)
      throw new ConflictException(
        "Only an invoice with a SIF registration can be cancelled",
      );

    let sinRegistroPrevio: "S" | undefined;
    if (invoice.sifMode === SifMode.VERIFACTU) {
      const submission = await this.tenant.db.sifAeatSubmission.findFirst({
        where: { recordId: registration.id, ...scope },
      });
      if (submission?.status === SifAeatSubmissionStatus.REJECTED &&
          submission.recordStatus === "Incorrecto")
        sinRegistroPrevio = "S";
      else if (submission?.status !== SifAeatSubmissionStatus.ACCEPTED &&
               submission?.status !== SifAeatSubmissionStatus.ACCEPTED_WITH_ERRORS)
        throw new ConflictException(
          "Confirm the registration's definitive AEAT response before cancelling its SIF record",
        );
    }

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
          sinRegistroPrevio,
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
    if (invoice.sifMode === SifMode.VERIFACTU && !aeatXml)
      throw new ConflictException(xmlSnapshotUnavailable ?? "VERI*FACTU cancellation requires exportable XML");
    const payload: Prisma.InputJsonObject = {
      hashInput,
      cancellationOf: {
        registrationId: registration.id,
        registrationHash: registration.recordHash,
      },
      ...(sinRegistroPrevio ? { sinRegistroPrevio } : {}),
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
    if (invoice.sifMode === SifMode.VERIFACTU)
      await this.enqueueAeatTest(record.id, aeatXml!);
    await this.audit.record("sif_record.cancelled", "sif_record", record.id, {
      invoiceId: registration.invoiceId,
      registrationId: registration.id,
      chainPosition: record.chainPosition.toString(),
      recordHash,
      specificationVersion: SIF_HASH_SPECIFICATION_VERSION,
    });
    return presentSifRecord(record);
  }

  /** Appends a new alta for a timestamp warning without changing the accepted record. */
  async createTimestampSubsanation(invoiceId: string) {
    return this.createRegistrationSubsanation(invoiceId, "TIMESTAMP_WARNING");
  }

  /** Re-submits unchanged invoice data after an externally resolved AEAT rejection. */
  async recoverRejectedRegistration(invoiceId: string, input: RecoverRejectedRegistrationDto) {
    if (input.invoiceDataConfirmed !== true ||
        typeof input.resolutionNote !== "string" ||
        input.resolutionNote.trim().length < 20)
      throw new ConflictException("Confirm unchanged invoice data and describe how the rejection was resolved");
    return this.createRegistrationSubsanation(invoiceId, "REJECTED_UNCHANGED", input.resolutionNote.trim());
  }

  private async createRegistrationSubsanation(
    invoiceId: string,
    kind: "TIMESTAMP_WARNING" | "REJECTED_UNCHANGED",
    resolutionNote?: string,
  ) {
    const scope = this.scope();
    await this.tenant.db.$executeRaw`
      SELECT pg_advisory_xact_lock(hashtextextended(${scope.companyId}, 0))
    `;
    const existing = await this.tenant.db.sifRecord.findFirst({
      where: { invoiceId, recordType: SifRecordType.SUBSANATION, ...scope },
    });
    if (existing) return presentSifRecord(existing);

    const source = await this.tenant.db.sifRecord.findFirst({
      where: { invoiceId, recordType: SifRecordType.REGISTRATION, ...scope },
    });
    if (!source) throw new NotFoundException("SIF registration not found");
    const submission = await this.tenant.db.sifAeatSubmission.findFirst({
      where: { recordId: source.id, ...scope },
    });
    const eligible = kind === "TIMESTAMP_WARNING"
      ? submission?.status === SifAeatSubmissionStatus.ACCEPTED_WITH_ERRORS &&
        submission.recordStatus === "AceptadoConErrores" &&
        submission.errorDescription?.includes("FechaHoraHusoGenRegistro")
      : submission?.status === SifAeatSubmissionStatus.REJECTED &&
        submission.recordStatus === "Incorrecto";
    if (!eligible)
      throw new ConflictException(
        kind === "TIMESTAMP_WARNING"
          ? "This subsanation is available only for a confirmed AEAT generation-time warning"
          : "Recovery requires a definitive AEAT line-level rejection",
      );
    if (!storedAeatXml(source.payload))
      throw new ConflictException("The original immutable AEAT XML is unavailable");
    const invoice = await this.tenant.db.invoice.findFirst({
      where: { id: invoiceId, ...scope },
      include: {
        originalInvoice: true,
        lines: { orderBy: { position: "asc" } },
        taxLines: true,
        company: true,
      },
    });
    if (!invoice || invoice.sifMode !== SifMode.VERIFACTU ||
        invoice.aeatEnvironment !== "TEST" || !this.aeatTest?.enabled)
      throw new ConflictException("AEAT test subsanation requires the enabled test sender");
    const cancelled = await this.tenant.db.sifRecord.findFirst({
      where: { invoiceId, recordType: SifRecordType.CANCELLATION, ...scope },
    });
    if (cancelled)
      throw new ConflictException("A cancelled registration cannot be subsanated");

    const previous = await this.tenant.db.sifRecord.findFirst({
      where: scope,
      orderBy: { chainPosition: "desc" },
    });
    const generatedAt = new Date(Math.floor(Date.now() / 1_000) * 1_000);
    const hashInput = {
      issuerTaxId: source.issuerTaxId,
      invoiceNumber: source.invoiceNumber,
      issueDate: formatSifIssueDate(source.invoiceIssueDate),
      invoiceType: source.invoiceType,
      taxTotal: source.taxTotal.toFixed(2),
      total: source.total.toFixed(2),
      previousHash: previous?.recordHash ?? "",
      generatedAt: formatSifTimestamp(generatedAt, invoice.company.timezone),
    };
    const recordHash = hashSifRegistration(hashInput);
    const previousRecord: SifXmlPreviousRecord | null = previous ? {
      issuerTaxId: previous.issuerTaxId,
      invoiceNumber: previous.invoiceNumber,
      issueDate: formatSifIssueDate(previous.invoiceIssueDate),
      hash: previous.recordHash,
    } : null;
    const aeatXml = renderSifAeatXml({
      header: { issuerLegalName: invoice.issuerLegalName, issuerTaxId: invoice.issuerTaxId },
      record: registrationXmlRecord(invoice, {
        ...hashInput,
        previousRecord,
        software: readSoftwareSnapshot(source.softwareSnapshot),
        recordHash,
        subsanacion: "S",
        ...(kind === "REJECTED_UNCHANGED" ? { rechazoPrevio: "X" as const } : {}),
      }),
    });
    const record = await this.tenant.db.sifRecord.create({
      data: {
        ...scope,
        invoiceId,
        recordType: SifRecordType.SUBSANATION,
        chainPosition: (previous?.chainPosition ?? 0n) + 1n,
        issuerTaxId: source.issuerTaxId,
        invoiceNumber: source.invoiceNumber,
        invoiceIssueDate: source.invoiceIssueDate,
        invoiceType: source.invoiceType,
        taxTotal: source.taxTotal,
        total: source.total,
        generatedAt,
        previousRecordId: previous?.id,
        previousRecordHash: previous?.recordHash,
        recordHash,
        specificationVersion: SIF_HASH_SPECIFICATION_VERSION,
        payload: {
          hashInput,
          subsanationOf: { recordId: source.id, recordHash: source.recordHash },
          correctionKind: kind,
          ...(resolutionNote ? { resolutionNote } : {}),
          previousRecord,
          aeatXml,
        },
        softwareSnapshot: source.softwareSnapshot ?? undefined,
      },
    });
    await this.enqueueAeatTest(record.id, aeatXml);
    await this.audit.record("sif_record.subsanated", "sif_record", record.id, {
      invoiceId, sourceRecordId: source.id,
      chainPosition: record.chainPosition.toString(), recordHash, kind,
      ...(resolutionNote ? { resolutionNote } : {}),
    });
    return presentSifRecord(record);
  }

  async testSubmissions(recordId: string) {
    const scope = this.scope();
    const record = await this.tenant.db.sifRecord.findFirst({ where: { id: recordId, ...scope } });
    if (!record) throw new NotFoundException("SIF record not found");
    return this.tenant.db.sifAeatSubmission.findMany({
      where: { recordId, ...scope },
      orderBy: { createdAt: "desc" },
      select: {
        id: true, status: true, attempts: true, createdAt: true, updatedAt: true,
        completedAt: true, lastAttemptAt: true, globalStatus: true, recordStatus: true,
        csv: true, errorCode: true, errorDescription: true, waitSeconds: true,
        lastError: true, requestSha256: true,
      },
    });
  }

  /** Sensitive, tenant-scoped evidence for an AEAT test exchange. */
  async exportTestSubmissionEvidence(recordId: string, submissionId: string) {
    const submission = await this.tenant.db.sifAeatSubmission.findFirst({
      where: { id: submissionId, recordId, ...this.scope() },
      include: { record: { select: {
        chainPosition: true, issuerTaxId: true, invoiceNumber: true,
        invoiceIssueDate: true, recordHash: true,
      } } },
    });
    if (!submission) throw new NotFoundException("AEAT test submission not found");
    const responseXml = submission.responseXml;
    const reconciliationXml = submission.reconciliationXml;
    const sha256 = (value: string) => createHash("sha256").update(value, "utf8").digest("hex");
    const evidence = {
      schemaVersion: 1,
      environment: "AEAT_TEST",
      submissionId: submission.id,
      recordId,
      chainPosition: submission.record.chainPosition.toString(),
      invoiceIdentity: {
        issuerTaxId: submission.record.issuerTaxId,
        invoiceNumber: submission.record.invoiceNumber,
        issueDate: formatSifIssueDate(submission.record.invoiceIssueDate),
      },
      recordHash: submission.record.recordHash,
      requestSha256: submission.requestSha256,
      status: submission.status,
      httpStatus: submission.httpStatus,
      globalStatus: submission.globalStatus,
      recordStatus: submission.recordStatus,
      csv: submission.csv,
      errorCode: submission.errorCode,
      errorDescription: submission.errorDescription,
      lastAttemptAt: submission.lastAttemptAt,
      completedAt: submission.completedAt,
      responseSha256: responseXml ? sha256(responseXml) : null,
      responseXml,
      reconciliationSha256: reconciliationXml ? sha256(reconciliationXml) : null,
      reconciliationXml,
    };
    const content = Buffer.from(JSON.stringify(evidence, null, 2) + "\n", "utf8");
    return { filename: `aeat-test-${submission.id}-evidence.json`, content };
  }

  private async enqueueAeatTest(recordId: string, xml: string) {
    await this.tenant.db.sifAeatSubmission.create({
      data: {
        ...this.scope(),
        recordId,
        requestSha256: createHash("sha256").update(xml).digest("hex"),
      },
    });
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

function followUpSourceId(payload: Prisma.JsonValue): string | null {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) return null;
  const link = payload.subsanationOf ?? payload.cancellationOf;
  if (!link || typeof link !== "object" || Array.isArray(link)) return null;
  const id = "recordId" in link ? link.recordId : link.registrationId;
  return typeof id === "string" ? id : null;
}

function recoveryResolutionNote(payload: Prisma.JsonValue): string | null {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) return null;
  return typeof payload.resolutionNote === "string" ? payload.resolutionNote : null;
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
  issuerTaxId: string;
  sifInvoiceType: string;
  issueDate: Date;
  operationDate?: Date | null;
  rectificationImpact?: RectificationImpact | null;
  originalInvoice?: {
    issuerTaxId: string;
    fullNumber: string | null;
    issueDate: Date;
    operationDate: Date | null;
  } | null;
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
  if (invoice.sifInvoiceType !== "F1" && invoice.sifInvoiceType !== "R1" && invoice.sifInvoiceType !== "R4")
    throw new ConflictException(
      "SIF XML export supports F1, R1 and R4 difference rectifications only",
    );
  const rectification = invoice.sifInvoiceType === "R1" || invoice.sifInvoiceType === "R4"
    ? differenceRectification(invoice)
    : undefined;
  if (invoice.sifInvoiceType === "R1" && !invoice.originalInvoice?.operationDate)
    throw new ConflictException("R1 SIF XML requires the original operation date");
  const operationDate = invoice.sifInvoiceType === "R1"
    ? invoice.originalInvoice!.operationDate
    : invoice.sifInvoiceType === "F1" && invoice.operationDate && invoice.operationDate.getTime() !== invoice.issueDate.getTime()
      ? invoice.operationDate
      : null;
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
    ...(rectification ? { rectification } : {}),
    ...(operationDate ? { operationDate: formatSifIssueDate(operationDate) } : {}),
    customer: { legalName: invoice.customerLegalName, taxId: invoice.customerTaxId },
    description,
    taxLines: rectification && invoice.rectificationImpact === RectificationImpact.DECREASE
      ? taxLines.map((line) => ({
          ...line,
          taxableBase: new Decimal(line.taxableBase).negated().toFixed(2),
          taxAmount: new Decimal(line.taxAmount).negated().toFixed(2),
        }))
      : taxLines,
    ...meta,
  };
}

function differenceRectification(invoice: RegistrationInvoice): NonNullable<SifXmlRegistration["rectification"]> {
  if (!invoice.rectificationImpact || !invoice.originalInvoice?.fullNumber)
    throw new ConflictException(
      "SIF XML export requires the rectification impact and original invoice identity",
    );
  if (invoice.originalInvoice.issuerTaxId !== invoice.issuerTaxId)
    throw new ConflictException(
      "SIF XML export cannot link a rectification to an invoice with a different issuer tax ID",
    );
  return {
    type: "I",
    original: {
      issuerTaxId: invoice.originalInvoice.issuerTaxId,
      invoiceNumber: invoice.originalInvoice.fullNumber,
      issueDate: formatSifIssueDate(invoice.originalInvoice.issueDate),
    },
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
    { taxableBase: Decimal; taxRate: Decimal; taxAmount: Decimal }
  >();
  for (const line of source) {
    if (
      !line.subject ||
      line.exempt ||
      line.reverseCharge ||
      line.taxRate === null ||
      line.surchargeRate !== null ||
      !line.surchargeAmount.isZero()
    )
      throw new ConflictException(
        "SIF XML export does not yet support exempt, non-subject, reverse-charge, or surcharge VAT lines",
      );
    const taxRate = line.taxRate;
    if (![0, 4, 10, 21].some((rate) => taxRate.eq(rate)))
      throw new ConflictException(
        "SIF XML export supports only current standard VAT rates (0, 4, 10, 21); historical rates require date-aware AEAT validation",
      );
    const key = line.taxRate.toFixed(2);
    const existing = grouped.get(key);
    if (existing) {
      existing.taxableBase = existing.taxableBase.add(line.taxableBase);
      existing.taxAmount = existing.taxAmount.add(line.taxAmount);
    } else
      grouped.set(key, {
        taxableBase: new Decimal(line.taxableBase),
        taxRate: new Decimal(line.taxRate),
        taxAmount: new Decimal(line.taxAmount),
      });
  }
  return [...grouped.values()].map((line) => ({
    taxableBase: line.taxableBase.toFixed(2),
    taxRate: line.taxRate.toFixed(2),
    taxAmount: line.taxAmount.toFixed(2),
    reverseCharge: false as const,
  }));
}
