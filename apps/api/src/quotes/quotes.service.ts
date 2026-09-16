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
  Prisma,
  QuoteStatus,
} from "@prisma/client";
import { Decimal } from "@prisma/client/runtime/library";
import { AuditService } from "../audit/audit.service";
import { TenantContextService } from "../tenancy/tenant-context.service";
import { captureIssuerSnapshot } from "../documents/issuer-snapshot";
import { CreateQuoteDto, QuoteLineDto, UpdateQuoteDto } from "./dto/quote.dto";
import { ListQuotesDto } from "./dto/list-quotes.dto";
import { decodeCursor, encodeCursor } from "../common/cursor";
import { QuotePdfService } from "./quote-pdf.service";
import {
  formatInvoiceNumber,
  InvoicesService,
} from "../invoices/invoices.service";
import { ConvertQuoteDto } from "./dto/convert-quote.dto";

@Injectable()
export class QuotesService {
  constructor(
    private readonly tenant: TenantContextService,
    private readonly audit: AuditService,
    private readonly quotePdf: QuotePdfService,
    private readonly invoices: InvoicesService,
  ) {}

  async list(query: ListQuotesDto) {
    const filter = query.status ?? "";
    const cursor = query.cursor
      ? decodeCursor(query.cursor, filter)
      : undefined;
    if (cursor) {
      const exists = await this.tenant.db.quote.findFirst({
        where: {
          id: cursor.id,
          createdAt: new Date(cursor.sort),
          ...this.scope(),
        },
        select: { id: true },
      });
      if (!exists)
        throw new BadRequestException(
          "Cursor is stale or does not belong to the selected company",
        );
    }
    const quotes = await this.tenant.db.quote.findMany({
      where: {
        ...this.scope(),
        ...(query.status ? { status: query.status } : {}),
      },
      omit: { issuerLogoContent: true },
      include: { contact: { select: { legalName: true } } },
      orderBy: [{ createdAt: "desc" }, { id: "desc" }],
      ...(cursor ? { cursor: { id: cursor.id }, skip: 1 } : {}),
      take: query.limit + 1,
    });
    const hasMore = quotes.length > query.limit;
    const data = hasMore ? quotes.slice(0, -1) : quotes;
    const last = data.at(-1);
    return {
      data: data.map(presentQuote),
      nextCursor:
        hasMore && last
          ? encodeCursor(last.id, last.createdAt.toISOString(), filter)
          : null,
    };
  }

  async get(id: string) {
    const quote = await this.tenant.db.quote.findFirst({
      where: { id, ...this.scope() },
      omit: { issuerLogoContent: true },
      include: {
        lines: { orderBy: { position: "asc" } },
        convertedInvoice: { select: { id: true, draftCode: true, status: true } },
      },
    });
    if (!quote) throw new NotFoundException("Quote not found");
    return presentQuote(quote);
  }

  async downloadPdf(id: string) {
    const quote = await this.get(id);
    const asset = await this.tenant.db.quote.findFirst({
      where: { id, ...this.scope() },
      select: { issuerLogoMediaType: true, issuerLogoContent: true },
    });
    return {
      content: await this.quotePdf.render({
        quote,
        issuerLogoMediaType: asset?.issuerLogoMediaType ?? null,
        issuerLogoContent: asset?.issuerLogoContent ?? null,
      }),
      filename: `presupuesto-${safeFilename(quote.code)}.pdf`,
    };
  }

  async create(input: CreateQuoteDto) {
    const scope = this.scope();
    const data = await this.build(input);
    const sequence = await this.tenant.db.documentSequence.findFirst({
      where: {
        id: input.sequenceId,
        ...scope,
        documentType: DocumentType.QUOTE,
        active: true,
      },
    });
    if (!sequence)
      throw new BadRequestException(
        "An active QUOTE sequence from this company is required",
      );
    const [allocated] = await this.tenant.db.$queryRaw<
      Array<{ number: bigint }>
    >`
      UPDATE "document_sequences"
      SET "next_number" = "next_number" + 1,
          "updated_at" = CURRENT_TIMESTAMP
      WHERE "id" = CAST(${sequence.id} AS uuid)
        AND "organization_id" = CAST(${scope.organizationId} AS uuid)
        AND "company_id" = CAST(${scope.companyId} AS uuid)
        AND "document_type" = 'QUOTE'
        AND "active" = true
      RETURNING "next_number" - 1 AS "number"
    `;
    if (!allocated)
      throw new ConflictException("Document sequence is no longer active");
    const code = formatInvoiceNumber(
      sequence.series,
      allocated.number,
      sequence.padding,
    );
    const quote = await this.tenant.db.quote.create({
      data: {
        ...scope,
        ...data.document,
        sequenceId: sequence.id,
        series: sequence.series,
        number: allocated.number,
        code,
        lines: {
          create: data.lines.map((item) => ({ ...item.persisted, ...scope })),
        },
      },
      include: { lines: true },
    });
    await this.audit.record("quote.created", "quote", quote.id, {
      sequenceId: sequence.id,
      series: sequence.series,
      number: allocated.number.toString(),
      code,
    });
    return presentQuote(quote);
  }

  async update(id: string, input: UpdateQuoteDto) {
    const data = await this.build(input);
    const scope = this.scope();
    await this.lockQuote(id);
    const pendingDelivery = await this.tenant.db.documentDelivery.findFirst({
      where: { quoteId: id, ...scope, status: { in: ["PENDING", "PROCESSING"] } },
      select: { id: true },
    });
    if (pendingDelivery)
      throw new ConflictException("Quote cannot be edited while an email delivery is pending");
    const changed = await this.tenant.db.quote.updateMany({
      where: { id, ...scope, status: QuoteStatus.DRAFT },
      data: data.document,
    });
    if (changed.count !== 1)
      throw new ConflictException(
        "Quote no longer exists or is no longer a draft",
      );
    await this.tenant.db.quoteLine.deleteMany({
      where: { quoteId: id, ...scope },
    });
    await this.tenant.db.quoteLine.createMany({
      data: data.lines.map((item) => ({
        quoteId: id,
        ...scope,
        ...item.persisted,
      })),
    });
    await this.audit.record("quote.updated", "quote", id);
    return this.get(id);
  }

  async changeStatus(
    id: string,
    status: QuoteStatus,
    expectedStatus: QuoteStatus,
  ) {
    const transitions: Partial<Record<QuoteStatus, QuoteStatus[]>> = {
      [QuoteStatus.SENT]: [QuoteStatus.DRAFT],
      [QuoteStatus.CANCELLED]: [QuoteStatus.DRAFT, QuoteStatus.SENT],
      [QuoteStatus.ACCEPTED]: [QuoteStatus.SENT],
      [QuoteStatus.REJECTED]: [QuoteStatus.SENT],
      [QuoteStatus.EXPIRED]: [QuoteStatus.SENT],
    };
    const allowedFrom = transitions[status];
    if (!allowedFrom || !allowedFrom.includes(expectedStatus))
      throw new BadRequestException(`Cannot transition a quote to ${status}`);
    await this.lockQuote(id);
    const pendingDelivery = await this.tenant.db.documentDelivery.findFirst({
      where: { quoteId: id, ...this.scope(), status: { in: ["PENDING", "PROCESSING"] } },
      select: { id: true },
    });
    if (pendingDelivery)
      throw new ConflictException("Quote status cannot change while an email delivery is pending");
    const issuer = status === QuoteStatus.SENT
      ? await this.currentIssuerSnapshot()
      : undefined;
    const changed = await this.tenant.db.quote.updateMany({
      where: { id, ...this.scope(), status: expectedStatus },
      data: { status, ...(issuer?.snapshot ?? {}) },
    });
    if (changed.count !== 1)
      throw new ConflictException("Quote status changed concurrently");
    await this.audit.record("quote.status_changed", "quote", id, {
      from: expectedStatus,
      to: status,
    });
    return this.get(id);
  }

  async convertToInvoice(id: string, input: ConvertQuoteDto) {
    if (input.dueDate && input.dueDate < input.issueDate)
      throw new BadRequestException("dueDate cannot precede issueDate");
    const scope = this.scope();
    const locked = await this.tenant.db.$queryRaw<Array<{ id: string }>>`
      SELECT "id" FROM "quotes"
      WHERE "id" = CAST(${id} AS uuid)
        AND "organization_id" = CAST(${scope.organizationId} AS uuid)
        AND "company_id" = CAST(${scope.companyId} AS uuid)
      FOR UPDATE
    `;
    if (!locked.length) throw new NotFoundException("Quote not found");
    const quote = await this.tenant.db.quote.findFirstOrThrow({
      where: { id, ...scope },
      include: { lines: { orderBy: { position: "asc" } } },
    });
    if (quote.convertedInvoiceId)
      return this.invoices.get(quote.convertedInvoiceId);
    if (quote.status !== QuoteStatus.ACCEPTED)
      throw new ConflictException("Only an accepted quote can be converted");

    const invoice = await this.invoices.create({
      contactId: quote.contactId,
      issueDate: input.issueDate,
      dueDate: input.dueDate,
      currency: quote.currency,
      notes: quote.notes ?? undefined,
      lines: quote.lines.map((line) => ({
        catalogItemId: line.catalogItemId ?? undefined,
        description: line.description,
        quantity: Number(line.quantity),
        unitPrice: Number(line.unitPrice),
        discountPct: Number(line.discountPct),
        taxRate: Number(line.taxRate),
      })),
    });
    await this.tenant.db.quote.update({
      where: { id },
      data: { convertedInvoiceId: invoice.id, status: QuoteStatus.CONVERTED },
    });
    await this.audit.record("quote.converted_to_invoice", "quote", id, {
      invoiceId: invoice.id,
    });
    return invoice;
  }

  private async lockQuote(id: string) {
    const scope = this.scope();
    await this.tenant.db.$queryRaw`
      SELECT "id" FROM "quotes"
      WHERE "id" = CAST(${id} AS uuid)
        AND "organization_id" = CAST(${scope.organizationId} AS uuid)
        AND "company_id" = CAST(${scope.companyId} AS uuid)
      FOR UPDATE
    `;
  }

  private async build(input: CreateQuoteDto | UpdateQuoteDto) {
    if (input.validUntil && input.validUntil < input.issueDate)
      throw new BadRequestException("validUntil cannot precede issueDate");
    const scope = this.scope();
    const contact = await this.tenant.db.contact.findFirst({
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
    });
    if (!contact)
      throw new BadRequestException(
        "Quote contact must be an active customer in this company",
      );
    const catalogIds = [
      ...new Set(
        input.lines.flatMap(({ catalogItemId }) =>
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
    const lines = input.lines.map((item, index) =>
      calculateQuoteLine(item, index + 1),
    );
    const totals = lines.reduce(
      (sum, item) => ({
        subtotal: sum.subtotal.plus(item.gross),
        discountTotal: sum.discountTotal.plus(item.discount),
        taxTotal: sum.taxTotal.plus(item.persisted.taxAmount),
        total: sum.total.plus(item.persisted.totalAmount),
      }),
      zeroTotals(),
    );
    const address = contact.addresses[0];
    const issuer = await this.currentIssuerSnapshot();
    const billingAddress = address
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
      : Prisma.JsonNull;
    return {
      document: {
        contactId: input.contactId,
        customerLegalName: contact.legalName,
        customerTaxId: contact.taxId,
        customerEmail: contact.email,
        billingAddress,
        ...issuer.snapshot,
        issueDate: new Date(input.issueDate),
        validUntil: input.validUntil ? new Date(input.validUntil) : null,
        currency: input.currency ?? "EUR",
        notes: input.notes?.trim() || null,
        ...totals,
      },
      lines,
    };
  }

  private scope() {
    const { organizationId, companyId } = this.tenant.required;
    if (!companyId) throw new BadRequestException("x-company-id is required");
    return { organizationId, companyId };
  }

  private async currentIssuerSnapshot() {
    const scope = this.scope();
    const company = await this.tenant.db.company.findFirst({
      where: { id: scope.companyId, organizationId: scope.organizationId },
      include: { documentProfile: true, documentLogo: true },
    });
    if (!company) throw new NotFoundException("Company not found");
    return { snapshot: captureIssuerSnapshot(company) };
  }
}

export function calculateQuoteLine(input: QuoteLineDto, position: number) {
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

function presentQuote<
  T extends { number: bigint | null; issuerLogoContent?: unknown },
>(quote: T) {
  const { issuerLogoContent: _issuerLogoContent, ...visible } = quote;
  return {
    ...visible,
    number: quote.number?.toString() ?? null,
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

function safeFilename(value: string) {
  return (
    value.replace(/[^a-zA-Z0-9._-]+/g, "-").replace(/^-+|-+$/g, "") ||
    "sin-codigo"
  );
}
