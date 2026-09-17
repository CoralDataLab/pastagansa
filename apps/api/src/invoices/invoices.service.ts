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
  Prisma,
  RectificationImpact,
  RectificationKind,
  SifMode,
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
    if (input.kind !== RectificationKind.TOTAL && !input.lines?.length)
      throw new BadRequestException(
        "Partial and difference rectifications require at least one line",
      );

    const rules = input.lines
      ? await this.tax.resolveRules(input.lines, input.issueDate)
      : [];
    const lines: BuiltInvoiceLine[] = input.lines
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

  private async validateRectificationForIssue(invoice: {
    id: string;
    originalInvoiceId: string | null;
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
      select: { status: true, documentType: true, total: true },
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

function zeroTotals() {
  return {
    subtotal: new Decimal(0),
    discountTotal: new Decimal(0),
    taxTotal: new Decimal(0),
    total: new Decimal(0),
  };
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
