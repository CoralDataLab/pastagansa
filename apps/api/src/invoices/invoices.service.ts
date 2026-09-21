import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
} from "@nestjs/common";
import {
  CatalogItemStatus,
  ContactStatus,
  DocumentType,
  InvoiceStatus,
  InvoiceEmailStatus,
  Prisma,
  RectificationImpact,
  RectificationKind,
  SifMode,
  SifAeatSubmissionStatus,
  SifInvoiceType,
  TaxRule,
} from "@prisma/client";
import { Decimal } from "@prisma/client/runtime/library";
import { AuditService } from "../audit/audit.service";
import { decodeCursor, encodeCursor } from "../common/cursor";
import { captureIssuerSnapshot } from "../documents/issuer-snapshot";
import { TenantContextService } from "../tenancy/tenant-context.service";
import { TaxService } from "../tax/tax.service";
import { AccountingService } from "../accounting/accounting.service";
import { SifService } from "../sif/sif.service";
import {
  CreateInvoiceDto,
  InvoiceLineDto,
  UpdateInvoiceDto,
} from "./dto/invoice.dto";
import { CreateRectificationDto } from "./dto/create-rectification.dto";
import { ListInvoicesDto } from "./dto/list-invoices.dto";
import { IssueInvoiceDto } from "./dto/issue-invoice.dto";
import { CancelIssuedInErrorDto } from "./dto/cancel-issued-in-error.dto";
import { InvoicePdfService } from "./invoice-pdf.service";

@Injectable()
export class InvoicesService {
  constructor(
    private readonly tenant: TenantContextService,
    private readonly audit: AuditService,
    private readonly pdf: InvoicePdfService,
    private readonly tax: TaxService,
    private readonly accounting: AccountingService,
    private readonly sif: SifService,
  ) {}

  async list(query: ListInvoicesDto) {
    const filter = `${query.status ?? ""}:${query.documentType ?? ""}`;
    const cursor = query.cursor
      ? decodeCursor(query.cursor, filter)
      : undefined;
    if (cursor) {
      const exists = await this.tenant.db.invoice.findFirst({
        where: {
          id: cursor.id,
          createdAt: new Date(cursor.sort),
          ...this.scope(),
          ...(query.status ? { status: query.status } : {}),
          ...(query.documentType ? { documentType: query.documentType } : {}),
        },
        select: { id: true },
      });
      if (!exists)
        throw new BadRequestException(
          "Cursor is stale or does not belong to the selected company",
        );
    }
    const invoices = await this.tenant.db.invoice.findMany({
      where: {
        ...this.scope(),
        ...(query.status ? { status: query.status } : {}),
        ...(query.documentType ? { documentType: query.documentType } : {}),
      },
      omit: { issuerLogoContent: true },
      orderBy: [{ createdAt: "desc" }, { id: "desc" }],
      ...(cursor ? { cursor: { id: cursor.id }, skip: 1 } : {}),
      take: query.limit + 1,
    });
    const hasMore = invoices.length > query.limit;
    const page = hasMore ? invoices.slice(0, -1) : invoices;
    const data = page.map(presentInvoice);
    const last = page.at(-1);
    return {
      data,
      nextCursor:
        hasMore && last
          ? encodeCursor(last.id, last.createdAt.toISOString(), filter)
          : null,
    };
  }

  async get(id: string) {
    const invoice = await this.tenant.db.invoice.findFirst({
      where: { id, ...this.scope() },
      omit: { issuerLogoContent: true },
      include: {
        lines: {
          orderBy: { position: "asc" },
          include: { taxLines: true },
        },
        installments: { orderBy: { position: "asc" } },
        originalInvoice: { select: { id: true, fullNumber: true } },
        sourceQuote: { select: { id: true, code: true } },
      },
    });
    if (!invoice) throw new NotFoundException("Invoice not found");
    return presentInvoice(invoice);
  }

  async downloadPdf(id: string) {
    const invoice = await this.get(id);
    if (invoice.status === InvoiceStatus.DRAFT || !invoice.fullNumber)
      throw new ConflictException("Only issued invoices have an official PDF");
    const asset = await this.tenant.db.invoice.findFirst({
      where: { id, ...this.scope() },
      select: { issuerLogoMediaType: true, issuerLogoContent: true },
    });
    return {
      filename: `factura-${safeFilename(invoice.fullNumber)}.pdf`,
      content: await this.pdf.render({
        ...invoice,
        fullNumber: invoice.fullNumber,
        issuerLogoMediaType: asset?.issuerLogoMediaType ?? null,
        issuerLogoContent: asset?.issuerLogoContent ?? null,
        sifQr:
          invoice.sifMode !== SifMode.DISABLED
            ? { mode: invoice.sifMode, environment: invoice.aeatEnvironment }
            : undefined,
      }),
    };
  }

  async create(input: CreateInvoiceDto) {
    const scope = this.scope();
    const data = await this.build(input);
    const invoice = await this.tenant.db.invoice.create({
      data: {
        ...scope,
        ...data.document,
      },
    });
    await this.createInvoiceLines(invoice.id, data.lines);
    await this.audit.record("invoice.draft_created", "invoice", invoice.id);
    return this.get(invoice.id);
  }

  async createRectification(
    originalInvoiceId: string,
    input: CreateRectificationDto,
  ) {
    const scope = this.scope();
    const locked = await this.tenant.db.$queryRaw<Array<{ id: string }>>`
      SELECT "id" FROM "invoices"
      WHERE "id" = CAST(${originalInvoiceId} AS uuid)
        AND "organization_id" = CAST(${scope.organizationId} AS uuid)
        AND "company_id" = CAST(${scope.companyId} AS uuid)
      FOR UPDATE
    `;
    if (!locked.length) throw new NotFoundException("Invoice not found");
    const original = await this.tenant.db.invoice.findFirstOrThrow({
      where: { id: originalInvoiceId, ...scope },
      include: {
        lines: {
          orderBy: { position: "asc" },
          include: { taxLines: true },
        },
      },
    });
    if (
      original.documentType !== DocumentType.INVOICE ||
      original.status === InvoiceStatus.DRAFT ||
      original.status === InvoiceStatus.CANCELLED
    )
      throw new ConflictException(
        "Only an issued standard invoice can be rectified",
      );
    if (original.status === InvoiceStatus.RECTIFIED)
      throw new ConflictException("Invoice has already been fully rectified");
    if (input.issueDate < original.issueDate.toISOString().slice(0, 10))
      throw new BadRequestException(
        "Rectification issueDate cannot precede the original invoice issueDate",
      );
    if (input.dueDate && input.dueDate < input.issueDate)
      throw new BadRequestException("dueDate cannot precede issueDate");
    if (input.sifInvoiceType === SifInvoiceType.F1)
      throw new BadRequestException(
        "A rectification requires a SIF invoice type from R1 to R5",
      );
    if (input.sifInvoiceType === SifInvoiceType.R5)
      throw new BadRequestException(
        "R5 can only rectify a simplified invoice, which is not supported yet",
      );
    const vatOnly = isVatOnlyRectificationType(input.sifInvoiceType);
    if (
      requiresOriginalOperationDate(input.sifInvoiceType) &&
      !original.operationDate
    )
      throw new ConflictException(
        `${input.sifInvoiceType} requires the original invoice operation date recorded before issuance; historical invoices without that date cannot be inferred`,
      );
    if (
      vatOnly &&
      (input.kind !== RectificationKind.DIFFERENCE ||
        input.impact !== RectificationImpact.DECREASE ||
        input.lines)
    )
      throw new BadRequestException(
        "R2/R3 drafts require DIFFERENCE, DECREASE and no manual lines",
      );
    if (
      input.kind === RectificationKind.TOTAL &&
      input.impact !== RectificationImpact.DECREASE
    )
      throw new BadRequestException(
        "A total rectification must decrease the original invoice",
      );
    if (input.kind === RectificationKind.TOTAL && input.lines)
      throw new BadRequestException(
        "A total rectification copies the original lines; lines must be omitted",
      );
    if (
      !vatOnly &&
      input.kind !== RectificationKind.TOTAL &&
      !input.lines?.length
    )
      throw new BadRequestException(
        "Partial and difference rectifications require at least one line",
      );

    let vatOnlyLine: BuiltInvoiceLine | null = null;
    if (vatOnly) {
      const prior = await this.tenant.db.invoice.findFirst({
        where: {
          ...scope,
          originalInvoiceId,
          documentType: DocumentType.CREDIT_NOTE,
        },
        select: { id: true },
      });
      if (prior)
        throw new ConflictException(
          "R2/R3 draft requires an original invoice without earlier rectifications",
        );
      vatOnlyLine = buildVatOnlyRectificationLine(original);
    }

    const rules = input.lines
      ? await this.tax.resolveRules(input.lines, input.issueDate)
      : [];
    const lines: BuiltInvoiceLine[] = vatOnlyLine ? [vatOnlyLine] : input.lines
      ? input.lines.map((line, index) => {
          const calculation = calculateInvoiceLine(
            { ...line, taxRate: Number(rules[index].rate ?? 0) },
            index + 1,
          );
          return {
            ...calculation,
            tax: buildTaxLine(rules[index], calculation, line.exemptionReason),
          };
        })
      : original.lines.map((line) => {
          if (line.taxLines.length !== 1)
            throw new ConflictException(
              "Original invoice fiscal breakdown is incomplete",
            );
          return {
            gross: line.quantity.mul(line.unitPrice).toDecimalPlaces(2),
            discount: line.quantity
              .mul(line.unitPrice)
              .toDecimalPlaces(2)
              .minus(line.netAmount),
            persisted: {
              position: line.position,
              catalogItemId: line.catalogItemId ?? undefined,
              description: line.description,
              quantity: line.quantity,
              unitPrice: line.unitPrice,
              discountPct: line.discountPct,
              taxRate: line.taxRate,
              netAmount: line.netAmount,
              taxAmount: line.taxAmount,
              totalAmount: line.totalAmount,
            },
            tax: copyTaxLine(line.taxLines[0]),
          };
        });
    if (input.lines) await this.validateCatalogItems(input.lines);
    const totals = sumInvoiceLines(lines);
    const issuer = await this.currentIssuerSnapshot();

    try {
      const rectification = await this.tenant.db.invoice.create({
        data: {
          ...scope,
          contactId: original.contactId,
          originalInvoiceId: original.id,
          documentType: DocumentType.CREDIT_NOTE,
          sifInvoiceType: input.sifInvoiceType,
          rectificationKind: input.kind,
          rectificationImpact: input.impact,
          rectificationReason: input.reason.trim(),
          issuerLegalName: issuer.legalName,
          issuerTaxId: issuer.taxId,
          ...issuer.snapshot,
          customerLegalName: original.customerLegalName,
          customerTaxId: original.customerTaxId,
          customerEmail: original.customerEmail,
          billingAddress: original.billingAddress ?? Prisma.JsonNull,
          issueDate: new Date(input.issueDate),
          operationDate: original.operationDate,
          dueDate: input.dueDate ? new Date(input.dueDate) : null,
          currency: original.currency,
          notes: input.notes?.trim() || null,
          ...totals,
          amountDue: new Decimal(0),
        },
      });
      await this.createInvoiceLines(rectification.id, lines);
      await this.audit.record(
        "invoice.rectification_draft_created",
        "invoice",
        rectification.id,
        {
          originalInvoiceId: original.id,
          kind: input.kind,
          impact: input.impact,
          sifInvoiceType: input.sifInvoiceType,
          ...(vatOnly
            ? {
                calculation: "VAT_ONLY",
                originalTaxLineId: original.lines[0].taxLines[0].id,
                originalTaxAmount: original.taxTotal.toFixed(2),
              }
            : {}),
        },
      );
      return this.get(rectification.id);
    } catch (error) {
      if (
        error instanceof Prisma.PrismaClientKnownRequestError &&
        error.code === "P2002" &&
        input.kind === RectificationKind.TOTAL
      )
        throw new ConflictException(
          "A total rectification already exists for this invoice",
        );
      throw error;
    }
  }

  async update(id: string, input: UpdateInvoiceDto) {
    const scope = this.scope();
    const data = await this.build(input);
    const changed = await this.tenant.db.invoice.updateMany({
      where: {
        id,
        ...scope,
        status: InvoiceStatus.DRAFT,
        documentType: DocumentType.INVOICE,
      },
      data: data.document,
    });
    if (changed.count !== 1)
      throw new ConflictException(
        "Invoice no longer exists or is no longer a draft",
      );
    await this.tenant.db.invoiceInstallment.deleteMany({
      where: { invoiceId: id, ...scope },
    });
    await this.tenant.db.invoiceLine.deleteMany({
      where: { invoiceId: id, ...scope },
    });
    await this.createInvoiceLines(id, data.lines);
    await this.audit.record("invoice.draft_updated", "invoice", id);
    return this.get(id);
  }

  async delete(id: string) {
    const scope = this.scope();
    const invoice = await this.tenant.db.invoice.findFirst({
      where: { id, ...scope },
      select: { status: true },
    });
    if (!invoice || invoice.status !== InvoiceStatus.DRAFT)
      throw new ConflictException(
        "Invoice no longer exists or is no longer a draft",
      );
    await this.tenant.db.invoiceInstallment.deleteMany({
      where: { invoiceId: id, ...scope },
    });
    const changed = await this.tenant.db.invoice.deleteMany({
      where: { id, ...scope, status: InvoiceStatus.DRAFT },
    });
    if (changed.count !== 1)
      throw new ConflictException("Invoice was changed concurrently");
    await this.audit.record("invoice.draft_deleted", "invoice", id);
  }

  async issue(id: string, input: IssueInvoiceDto, idempotencyKey: string) {
    const scope = this.scope();
    const locked = await this.tenant.db.$queryRaw<Array<{ id: string }>>`
      SELECT "id" FROM "invoices"
      WHERE "id" = CAST(${id} AS uuid)
        AND "organization_id" = CAST(${scope.organizationId} AS uuid)
        AND "company_id" = CAST(${scope.companyId} AS uuid)
      FOR UPDATE
    `;
    if (!locked.length) throw new NotFoundException("Invoice not found");
    const invoice = await this.tenant.db.invoice.findFirstOrThrow({
      where: { id, ...scope },
      include: {
        lines: {
          orderBy: { position: "asc" },
          include: { taxLines: true },
        },
      },
    });
    if (invoice.status !== InvoiceStatus.DRAFT) {
      if (invoice.issuanceKey === idempotencyKey)
        return presentInvoice(invoice);
      throw new ConflictException("Invoice has already been issued");
    }
    if (!invoice.lines.length)
      throw new BadRequestException("Invoice must contain at least one line");
    if (invoice.lines.some((line) => line.taxLines.length !== 1))
      throw new BadRequestException(
        "Every invoice line must have exactly one fiscal breakdown",
      );
    const reusedKey = await this.tenant.db.invoice.findFirst({
      where: {
        ...scope,
        issuanceKey: idempotencyKey,
        id: { not: invoice.id },
      },
      select: { id: true },
    });
    if (reusedKey)
      throw new ConflictException(
        "Idempotency-Key has already been used for another invoice",
      );
    if (invoice.documentType === DocumentType.CREDIT_NOTE)
      await this.validateRectificationForIssue(invoice);
    const sequence = await this.tenant.db.documentSequence.findFirst({
      where: {
        id: input.sequenceId,
        ...scope,
        documentType: invoice.documentType,
        active: true,
      },
    });
    if (!sequence)
      throw new BadRequestException(
        `An active ${invoice.documentType} sequence from this company is required`,
      );
    if (invoice.documentType === DocumentType.INVOICE) {
      const installments = await this.tenant.db.invoiceInstallment.count({
        where: { invoiceId: id, ...scope },
      });
      if (!installments && invoice.total.greaterThan(0))
        await this.tenant.db.invoiceInstallment.create({
          data: {
            ...scope,
            invoiceId: id,
            position: 1,
            dueDate: invoice.dueDate ?? invoice.issueDate,
            amount: invoice.total,
          },
        });
    }
    const [allocated] = await this.tenant.db.$queryRaw<
      Array<{ number: bigint }>
    >`
      UPDATE "document_sequences"
      SET "next_number" = "next_number" + 1,
          "updated_at" = CURRENT_TIMESTAMP
      WHERE "id" = CAST(${sequence.id} AS uuid)
        AND "organization_id" = CAST(${scope.organizationId} AS uuid)
        AND "company_id" = CAST(${scope.companyId} AS uuid)
        AND "active" = true
      RETURNING "next_number" - 1 AS "number"
    `;
    if (!allocated)
      throw new ConflictException("Document sequence is no longer active");
    const fullNumber = formatInvoiceNumber(
      sequence.series,
      allocated.number,
      sequence.padding,
    );
    const issuer = await this.currentIssuerSnapshot();
    try {
      const changed = await this.tenant.db.invoice.updateMany({
        where: { id, ...scope, status: InvoiceStatus.DRAFT },
        data: {
          sequenceId: sequence.id,
          series: sequence.series,
          number: allocated.number,
          fullNumber,
          issuanceKey: idempotencyKey,
          issuedAt: new Date(),
          status: InvoiceStatus.ISSUED,
          issuerLegalName: issuer.legalName,
          issuerTaxId: issuer.taxId,
          sifMode: issuer.sifMode,
          aeatEnvironment: issuer.aeatEnvironment,
          ...issuer.snapshot,
        },
      });
      if (changed.count !== 1)
        throw new ConflictException("Invoice was issued concurrently");
    } catch (error) {
      if (
        error instanceof Prisma.PrismaClientKnownRequestError &&
        error.code === "P2002"
      )
        throw new ConflictException(
          "Invoice number or Idempotency-Key was allocated concurrently",
        );
      throw error;
    }
    await this.audit.record("invoice.issued", "invoice", id, {
      sequenceId: sequence.id,
      series: sequence.series,
      number: allocated.number.toString(),
      fullNumber,
      idempotencyKey,
    });
    await this.tax.postInvoice(id);
    await this.accounting.postSalesInvoice(id);
    await this.sif.createRegistration(id);
    if (
      invoice.documentType === DocumentType.CREDIT_NOTE &&
      invoice.rectificationKind === RectificationKind.TOTAL &&
      invoice.originalInvoiceId
    ) {
      await this.tenant.db.invoice.updateMany({
        where: {
          id: invoice.originalInvoiceId,
          ...scope,
          status: { notIn: [InvoiceStatus.DRAFT, InvoiceStatus.CANCELLED] },
        },
        data: {
          status: InvoiceStatus.RECTIFIED,
          amountDue: new Decimal(0),
        },
      });
      await this.audit.record(
        "invoice.rectified",
        "invoice",
        invoice.originalInvoiceId,
        { rectificationInvoiceId: id, kind: invoice.rectificationKind },
      );
    }
    return this.get(id);
  }

  async cancelIssuedInError(id: string, input: CancelIssuedInErrorDto) {
    const scope = this.scope();
    const locked = await this.tenant.db.$queryRaw<Array<{ id: string }>>`
      SELECT "id" FROM "invoices"
      WHERE "id" = CAST(${id} AS uuid)
        AND "organization_id" = CAST(${scope.organizationId} AS uuid)
        AND "company_id" = CAST(${scope.companyId} AS uuid)
      FOR UPDATE
    `;
    if (!locked.length) throw new NotFoundException("Invoice not found");
    const invoice = await this.tenant.db.invoice.findFirstOrThrow({
      where: { id, ...scope },
      include: { company: { select: { timezone: true } } },
    });
    if (invoice.status === InvoiceStatus.CANCELLED) return this.get(id);
    if (
      invoice.documentType !== DocumentType.INVOICE ||
      (invoice.status !== InvoiceStatus.ISSUED &&
        invoice.status !== InvoiceStatus.SENT &&
        invoice.status !== InvoiceStatus.OVERDUE)
    )
      throw new ConflictException(
        "Only an issued ordinary invoice can be cancelled as issued in error",
      );
    if (
      !input.operationDidNotExist ||
      !input.reason.trim() ||
      input.reason.trim().length < 20
    )
      throw new BadRequestException(
        "Confirm the nonexistent operation and explain the error",
      );
    if (
      !invoice.amountPaid.isZero() ||
      (await this.tenant.db.paymentAllocation.count({
        where: { invoiceId: id, ...scope },
      }))
    )
      throw new ConflictException(
        "An invoice with payments requires a separate reviewed correction",
      );
    if (
      await this.tenant.db.invoice.count({
        where: { originalInvoiceId: id, ...scope },
      })
    )
      throw new ConflictException(
        "An invoice with rectifications cannot use error cancellation",
      );
    await this.tenant.db.$queryRaw`
      SELECT "id" FROM "document_deliveries"
      WHERE "invoice_id" = CAST(${id} AS uuid)
        AND "organization_id" = CAST(${scope.organizationId} AS uuid)
        AND "company_id" = CAST(${scope.companyId} AS uuid)
        AND "status" IN ('PENDING', 'PROCESSING')
      FOR UPDATE
    `;
    if (
      await this.tenant.db.documentDelivery.count({
        where: { invoiceId: id, status: InvoiceEmailStatus.PROCESSING, ...scope },
      })
    )
      throw new ConflictException(
        "An email for this invoice is being delivered; retry after it finishes",
      );
    const date = new Date(
      new Intl.DateTimeFormat("en-CA", {
        timeZone: invoice.company.timezone,
        year: "numeric",
        month: "2-digit",
        day: "2-digit",
      }).format(new Date()),
    );
    if (date < invoice.issueDate)
      throw new ConflictException(
        "Cancellation cannot precede invoice issue date",
      );
    const taxEntry = await this.tenant.db.taxLedgerEntry.findFirst({
      where: { invoiceId: id, ...scope },
      select: { id: true },
    });
    const journalEntry = await this.tenant.db.journalEntry.findFirst({
      where: { sourceType: "SALES_INVOICE", sourceId: id, ...scope },
      select: { id: true },
    });
    if (!taxEntry || !journalEntry)
      throw new ConflictException(
        "Invoice posting is incomplete; review before cancellation",
      );
    const sifRecord =
      invoice.sifMode === SifMode.DISABLED
        ? null
        : await this.sif.createCancellation(id);
    if (invoice.sifMode === SifMode.VERIFACTU && sifRecord) {
      const submission = await this.tenant.db.sifAeatSubmission.findFirst({
        where: { recordId: sifRecord.id, ...scope },
        select: { status: true },
      });
      if (
        submission &&
        (submission.status === SifAeatSubmissionStatus.REJECTED ||
          submission.status === SifAeatSubmissionStatus.FAILED ||
          submission.status === SifAeatSubmissionStatus.UNKNOWN)
      )
        throw new ConflictException(
          "AEAT cancellation needs review before financial reversal",
        );
    }
    const taxCancellation = await this.tax.cancelInvoice(id, date);
    const journalReversal = await this.accounting.reverseSalesInvoice(
      id,
      date,
      input.reason.trim(),
    );
    await this.tenant.db.documentDelivery.updateMany({
      where: { invoiceId: id, status: InvoiceEmailStatus.PENDING, ...scope },
      data: {
        status: InvoiceEmailStatus.FAILED,
        lastError: "Invoice cancelled before delivery",
      },
    });
    await this.tenant.db.invoice.update({
      where: { id },
      data: {
        status: InvoiceStatus.CANCELLED,
        amountDue: new Decimal(0),
        cancelledAt: new Date(),
        cancellationReason: input.reason.trim(),
      },
    });
    await this.audit.record(
      "invoice.cancelled_issued_in_error",
      "invoice",
      id,
      {
        reason: input.reason.trim(),
        operationDidNotExist: true,
        taxCancellationId: taxCancellation.id,
        journalReversalId: journalReversal.id,
        sifCancellationId: sifRecord?.id ?? null,
      },
    );
    return this.get(id);
  }

  private async validateRectificationForIssue(invoice: {
    id: string;
    originalInvoiceId: string | null;
    sifInvoiceType: SifInvoiceType;
    rectificationKind: RectificationKind | null;
    rectificationImpact: RectificationImpact | null;
    total: Decimal;
  }) {
    if (
      !invoice.originalInvoiceId ||
      !invoice.rectificationKind ||
      !invoice.rectificationImpact
    )
      throw new ConflictException("Rectification metadata is incomplete");
    if (isVatOnlyRectificationType(invoice.sifInvoiceType))
      throw new ConflictException(
        "R2/R3 issuance remains blocked pending tax, accounting, payment, PDF and SIF validation",
      );
    const scope = this.scope();
    const locked = await this.tenant.db.$queryRaw<Array<{ id: string }>>`
      SELECT "id" FROM "invoices"
      WHERE "id" = CAST(${invoice.originalInvoiceId} AS uuid)
        AND "organization_id" = CAST(${scope.organizationId} AS uuid)
        AND "company_id" = CAST(${scope.companyId} AS uuid)
      FOR UPDATE
    `;
    if (!locked.length)
      throw new ConflictException("Original invoice no longer exists");
    const original = await this.tenant.db.invoice.findFirstOrThrow({
      where: { id: invoice.originalInvoiceId, ...scope },
      select: { status: true, documentType: true, total: true, operationDate: true },
    });
    if (
      original.documentType !== DocumentType.INVOICE ||
      original.status === InvoiceStatus.DRAFT ||
      original.status === InvoiceStatus.CANCELLED ||
      original.status === InvoiceStatus.RECTIFIED
    )
      throw new ConflictException(
        "Original invoice is not eligible for rectification",
      );
    if (
      requiresOriginalOperationDate(invoice.sifInvoiceType) &&
      !original.operationDate
    )
      throw new ConflictException(
        `${invoice.sifInvoiceType} requires the original invoice operation date recorded before issuance; historical invoices without that date cannot be inferred`,
      );
    const prior = await this.tenant.db.invoice.findMany({
      where: {
        ...scope,
        originalInvoiceId: invoice.originalInvoiceId,
        id: { not: invoice.id },
        documentType: DocumentType.CREDIT_NOTE,
        status: { not: InvoiceStatus.DRAFT },
      },
      select: {
        rectificationKind: true,
        rectificationImpact: true,
        total: true,
      },
    });
    if (
      invoice.rectificationKind === RectificationKind.TOTAL &&
      prior.length > 0
    )
      throw new ConflictException(
        "A total rectification cannot follow another issued rectification",
      );
    if (
      invoice.rectificationImpact === RectificationImpact.DECREASE &&
      invoice.rectificationKind !== RectificationKind.TOTAL
    ) {
      const correctedBalance = prior.reduce(
        (balance, item) =>
          item.rectificationImpact === RectificationImpact.INCREASE
            ? balance.plus(item.total)
            : balance.minus(item.total),
        original.total,
      );
      if (invoice.total.greaterThan(correctedBalance))
        throw new ConflictException(
          "Rectifications cannot decrease more than the original invoice total",
        );
    }
  }

  private async build(input: CreateInvoiceDto) {
    if (input.operationDate && input.operationDate > input.issueDate)
      throw new BadRequestException("operationDate cannot follow issueDate");
    if (input.dueDate && input.dueDate < input.issueDate)
      throw new BadRequestException("dueDate cannot precede issueDate");
    const scope = this.scope();
    const [issuer, contact] = await Promise.all([
      this.currentIssuerSnapshot(),
      this.tenant.db.contact.findFirst({
        where: {
          id: input.contactId,
          ...scope,
          isCustomer: true,
          status: ContactStatus.ACTIVE,
        },
        include: {
          addresses: {
            where: { type: "BILLING", archivedAt: null },
            orderBy: [{ isDefault: "desc" }, { createdAt: "asc" }],
            take: 1,
          },
        },
      }),
    ]);
    if (!contact)
      throw new BadRequestException(
        "Invoice contact must be an active customer in this company",
      );
    await this.validateCatalogItems(input.lines);
    const rules = await this.tax.resolveRules(input.lines, input.issueDate);
    const lines: BuiltInvoiceLine[] = input.lines.map((line, index) => {
      const calculation = calculateInvoiceLine(
        { ...line, taxRate: Number(rules[index].rate ?? 0) },
        index + 1,
      );
      return {
        ...calculation,
        tax: buildTaxLine(rules[index], calculation, line.exemptionReason),
      };
    });
    const totals = sumInvoiceLines(lines);
    const address = contact.addresses[0];
    return {
      document: {
        contactId: input.contactId,
        issuerLegalName: issuer.legalName,
        issuerTaxId: issuer.taxId,
        ...issuer.snapshot,
        customerLegalName: contact.legalName,
        customerTaxId: contact.taxId,
        customerEmail: contact.email,
        billingAddress: address
          ? {
              type: address.type,
              label: address.label,
              line1: address.line1,
              line2: address.line2,
              postalCode: address.postalCode,
              city: address.city,
              province: address.province,
              country: address.country,
            }
          : Prisma.JsonNull,
        issueDate: new Date(input.issueDate),
        operationDate: new Date(input.operationDate ?? input.issueDate),
        dueDate: input.dueDate ? new Date(input.dueDate) : null,
        currency: input.currency ?? "EUR",
        notes: input.notes?.trim() || null,
        ...totals,
        amountPaid: new Decimal(0),
        amountDue: totals.total,
      },
      lines,
    };
  }

  private async createInvoiceLines(
    invoiceId: string,
    lines: BuiltInvoiceLine[],
  ) {
    const scope = this.scope();
    for (const line of lines) {
      const created = await this.tenant.db.invoiceLine.create({
        data: { invoiceId, ...scope, ...line.persisted },
      });
      await this.tenant.db.invoiceTaxLine.create({
        data: {
          invoiceId,
          invoiceLineId: created.id,
          ...scope,
          ...line.tax,
        },
      });
    }
  }

  private async currentIssuerSnapshot() {
    const scope = this.scope();
    const company = await this.tenant.db.company.findFirst({
      where: { id: scope.companyId, organizationId: scope.organizationId },
      include: { documentProfile: true, documentLogo: true },
    });
    if (!company) throw new NotFoundException("Company not found");
    const snapshot = captureIssuerSnapshot(company);
    return {
      legalName: company.legalName,
      taxId: company.taxId,
      sifMode: company.sifMode,
      aeatEnvironment: company.aeatEnvironment,
      snapshot,
    };
  }

  private async validateCatalogItems(lines: InvoiceLineDto[]) {
    const scope = this.scope();
    const catalogIds = [
      ...new Set(
        lines.flatMap(({ catalogItemId }) =>
          catalogItemId ? [catalogItemId] : [],
        ),
      ),
    ];
    if (catalogIds.length) {
      const count = await this.tenant.db.catalogItem.count({
        where: {
          id: { in: catalogIds },
          ...scope,
          status: CatalogItemStatus.ACTIVE,
        },
      });
      if (count !== catalogIds.length)
        throw new BadRequestException(
          "Every catalog item must be active and belong to the selected company",
        );
    }
  }

  private scope() {
    const { organizationId, companyId } = this.tenant.required;
    if (!companyId) throw new BadRequestException("x-company-id is required");
    return { organizationId, companyId };
  }
}

export function calculateInvoiceLine(input: InvoiceLineDto, position: number) {
  const quantity = new Decimal(input.quantity);
  const unitPrice = new Decimal(input.unitPrice);
  const gross = quantity.mul(unitPrice).toDecimalPlaces(2);
  const discount = gross
    .mul(input.discountPct ?? 0)
    .div(100)
    .toDecimalPlaces(2);
  const netAmount = gross.minus(discount);
  const taxAmount = netAmount
    .mul(input.taxRate ?? 0)
    .div(100)
    .toDecimalPlaces(2);
  return {
    gross,
    discount,
    persisted: {
      position,
      catalogItemId: input.catalogItemId,
      description: input.description.trim(),
      quantity,
      unitPrice,
      discountPct: new Decimal(input.discountPct ?? 0),
      taxRate: new Decimal(input.taxRate ?? 0),
      netAmount,
      taxAmount,
      totalAmount: netAmount.plus(taxAmount),
    },
  };
}

type InvoiceLineCalculation = ReturnType<typeof calculateInvoiceLine>;

interface BuiltInvoiceLine extends InvoiceLineCalculation {
  tax: {
    taxRuleId: string;
    taxCode: string;
    taxableBase: Decimal;
    taxRate: Decimal | null;
    taxAmount: Decimal;
    surchargeRate: Decimal | null;
    surchargeAmount: Decimal;
    subject: boolean;
    exempt: boolean;
    exemptionReason: string | null;
    reverseCharge: boolean;
  };
}

function buildTaxLine(
  rule: TaxRule,
  calculation: InvoiceLineCalculation,
  exemptionReason?: string,
): BuiltInvoiceLine["tax"] {
  return {
    taxRuleId: rule.id,
    taxCode: rule.code,
    taxableBase: calculation.persisted.netAmount,
    taxRate: rule.rate,
    taxAmount: calculation.persisted.taxAmount,
    surchargeRate: rule.surchargeRate,
    surchargeAmount: new Decimal(0),
    subject: rule.subject,
    exempt: rule.exempt,
    exemptionReason: exemptionReason?.trim() || null,
    reverseCharge: rule.reverseCharge,
  };
}

function copyTaxLine(line: {
  taxRuleId: string;
  taxCode: string;
  taxableBase: Decimal;
  taxRate: Decimal | null;
  taxAmount: Decimal;
  surchargeRate: Decimal | null;
  surchargeAmount: Decimal;
  subject: boolean;
  exempt: boolean;
  exemptionReason: string | null;
  reverseCharge: boolean;
}): BuiltInvoiceLine["tax"] {
  return {
    taxRuleId: line.taxRuleId,
    taxCode: line.taxCode,
    taxableBase: line.taxableBase,
    taxRate: line.taxRate,
    taxAmount: line.taxAmount,
    surchargeRate: line.surchargeRate,
    surchargeAmount: line.surchargeAmount,
    subject: line.subject,
    exempt: line.exempt,
    exemptionReason: line.exemptionReason,
    reverseCharge: line.reverseCharge,
  };
}

export function buildVatOnlyRectificationLine(
  original: {
    sifInvoiceType: SifInvoiceType;
    currency: string;
    customerTaxId: string | null;
    fullNumber: string | null;
    amountPaid: Decimal;
    amountDue: Decimal;
    total: Decimal;
    taxTotal: Decimal;
    lines: Array<{
      netAmount: Decimal;
      taxAmount: Decimal;
      totalAmount: Decimal;
      taxRate: Decimal;
      taxLines: Array<Parameters<typeof copyTaxLine>[0]>;
    }>;
  },
): BuiltInvoiceLine {
  if (
    original.sifInvoiceType !== SifInvoiceType.F1 ||
    original.currency !== "EUR" ||
    !original.customerTaxId ||
    !original.fullNumber
  )
    throw new ConflictException(
      "R2/R3 draft requires a complete EUR F1 invoice with a customer tax identifier",
    );
  if (
    !original.amountPaid.isZero() ||
    !original.amountDue.equals(original.total)
  )
    throw new ConflictException(
      "R2/R3 draft does not yet support paid or partially paid invoices",
    );
  if (original.lines.length !== 1 || original.lines[0].taxLines.length !== 1)
    throw new ConflictException(
      "R2/R3 draft currently requires exactly one ordinary VAT line",
    );
  const line = original.lines[0];
  const tax = line.taxLines[0];
  if (
    !tax.subject ||
    tax.exempt ||
    tax.reverseCharge ||
    tax.exemptionReason ||
    !tax.surchargeAmount.isZero() ||
    (tax.surchargeRate && !tax.surchargeRate.isZero()) ||
    !tax.taxRate ||
    !["4", "10", "21"].includes(tax.taxRate.toString()) ||
    !tax.taxableBase.greaterThan(0) ||
    !tax.taxAmount.greaterThan(0) ||
    !tax.taxableBase.equals(line.netAmount) ||
    !line.taxRate.equals(tax.taxRate) ||
    !tax.taxAmount.equals(line.taxAmount) ||
    !tax.taxAmount.equals(original.taxTotal) ||
    !line.totalAmount.equals(line.netAmount.plus(line.taxAmount)) ||
    !original.total.equals(line.totalAmount)
  )
    throw new ConflictException(
      "R2/R3 draft requires a consistent ordinary VAT breakdown",
    );
  const zero = new Decimal(0);
  const amount = tax.taxAmount;
  return {
    gross: zero,
    discount: zero,
    persisted: {
      position: 1,
      catalogItemId: undefined,
      description: `Ajuste de cuota IVA por impago de ${original.fullNumber}`,
      quantity: new Decimal(1),
      unitPrice: zero,
      discountPct: zero,
      taxRate: tax.taxRate,
      netAmount: zero,
      taxAmount: amount,
      totalAmount: amount,
    },
    tax: { ...copyTaxLine(tax), taxableBase: zero, taxAmount: amount },
  };
}

function zeroTotals() {
  return {
    subtotal: new Decimal(0),
    discountTotal: new Decimal(0),
    taxTotal: new Decimal(0),
    total: new Decimal(0),
  };
}

function requiresOriginalOperationDate(type: SifInvoiceType) {
  return type === SifInvoiceType.R1 ||
    type === SifInvoiceType.R2 ||
    type === SifInvoiceType.R3;
}

function isVatOnlyRectificationType(type: SifInvoiceType) {
  return type === SifInvoiceType.R2 || type === SifInvoiceType.R3;
}

function sumInvoiceLines(
  lines: Array<ReturnType<typeof calculateInvoiceLine>>,
) {
  return lines.reduce(
    (sum, line) => ({
      subtotal: sum.subtotal.plus(line.gross),
      discountTotal: sum.discountTotal.plus(line.discount),
      taxTotal: sum.taxTotal.plus(line.persisted.taxAmount),
      total: sum.total.plus(line.persisted.totalAmount),
    }),
    zeroTotals(),
  );
}

function presentInvoice<
  T extends { number: bigint | null; issuerLogoContent?: unknown },
>(invoice: T) {
  const { issuerLogoContent: _issuerLogoContent, ...visible } = invoice;
  return { ...visible, number: invoice.number?.toString() ?? null };
}

export function formatInvoiceNumber(
  series: string,
  number: bigint,
  padding: number,
) {
  return `${series}-${number.toString().padStart(padding, "0")}`;
}

function safeFilename(value: string) {
  return value.replace(/[^a-zA-Z0-9._-]+/g, "-");
}
