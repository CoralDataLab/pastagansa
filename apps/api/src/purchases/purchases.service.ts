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
  PurchaseInvoiceStatus,
  TaxRule,
} from "@prisma/client";
import { Decimal } from "@prisma/client/runtime/library";
import { AuditService } from "../audit/audit.service";
import { AccountingService } from "../accounting/accounting.service";
import { decodeCursor, encodeCursor } from "../common/cursor";
import { calculateInvoiceLine } from "../invoices/invoices.service";
import { TaxService } from "../tax/tax.service";
import { TenantContextService } from "../tenancy/tenant-context.service";
import { ApprovePurchaseInvoiceDto } from "./dto/approve-purchase-invoice.dto";
import { RejectPurchaseInvoiceDto } from "./dto/purchase-approval.dto";
import { ListPurchaseInvoicesDto } from "./dto/list-purchase-invoices.dto";
import {
  CreatePurchaseInvoiceDto,
  PurchaseInvoiceLineDto,
  UpdatePurchaseInvoiceDto,
} from "./dto/purchase-invoice.dto";

@Injectable()
export class PurchasesService {
  constructor(
    private readonly tenant: TenantContextService,
    private readonly audit: AuditService,
    private readonly tax: TaxService,
    private readonly accounting: AccountingService,
  ) {}

  async list(query: ListPurchaseInvoicesDto) {
    const filter = `${query.status ?? ""}:${query.search ?? ""}`;
    const cursor = query.cursor
      ? decodeCursor(query.cursor, filter)
      : undefined;
    const scope = this.scope();
    const where: Prisma.PurchaseInvoiceWhereInput = {
      ...scope,
      ...(query.status ? { status: query.status } : {}),
      ...(query.search
        ? {
            OR: [
              {
                supplierInvoiceNumber: {
                  contains: query.search,
                  mode: "insensitive",
                },
              },
              {
                supplierLegalName: {
                  contains: query.search,
                  mode: "insensitive",
                },
              },
            ],
          }
        : {}),
    };
    if (cursor) {
      const exists = await this.tenant.db.purchaseInvoice.findFirst({
        where: { id: cursor.id, receivedDate: new Date(cursor.sort), ...where },
        select: { id: true },
      });
      if (!exists)
        throw new BadRequestException(
          "Cursor is stale or does not belong to the selected company",
        );
    }
    const records = await this.tenant.db.purchaseInvoice.findMany({
      where,
      orderBy: [{ receivedDate: "desc" }, { id: "desc" }],
      ...(cursor ? { cursor: { id: cursor.id }, skip: 1 } : {}),
      take: query.limit + 1,
    });
    const hasMore = records.length > query.limit;
    const page = hasMore ? records.slice(0, -1) : records;
    const last = page.at(-1);
    return {
      data: page.map(presentPurchaseInvoice),
      nextCursor:
        hasMore && last
          ? encodeCursor(last.id, last.receivedDate.toISOString(), filter)
          : null,
    };
  }

  async get(id: string) {
    const purchase = await this.tenant.db.purchaseInvoice.findFirst({
      where: { id, ...this.scope() },
      include: {
        lines: {
          orderBy: { position: "asc" },
          include: { taxLines: true },
        },
        installments: { orderBy: { position: "asc" } },
        approvals: {
          orderBy: { position: "asc" },
          select: {
            id: true,
            position: true,
            approvedAt: true,
            approvedBy: { select: { id: true, email: true } },
          },
        },
      },
    });
    if (!purchase) throw new NotFoundException("Purchase invoice not found");
    return presentPurchaseInvoice(purchase);
  }

  async create(input: CreatePurchaseInvoiceDto) {
    const scope = this.scope();
    const built = await this.build(input);
    try {
      const purchase = await this.tenant.db.purchaseInvoice.create({
        data: { ...scope, ...built.document },
      });
      await this.createLines(purchase.id, built.lines);
      await this.audit.record(
        "purchase_invoice.draft_created",
        "purchase_invoice",
        purchase.id,
      );
      return this.get(purchase.id);
    } catch (error) {
      this.rethrowDuplicate(error);
    }
  }

  async update(id: string, input: UpdatePurchaseInvoiceDto) {
    const scope = this.scope();
    const current = await this.tenant.db.purchaseInvoice.findFirst({
      where: { id, ...scope },
      select: { status: true },
    });
    if (!current) throw new NotFoundException("Purchase invoice not found");
    if (current.status !== PurchaseInvoiceStatus.DRAFT)
      throw new ConflictException("Only draft purchase invoices can be edited");
    const built = await this.build(input);
    try {
      await this.tenant.db.purchaseInvoice.update({
        where: { id },
        data: built.document,
      });
      await this.tenant.db.purchaseInvoiceLine.deleteMany({
        where: { purchaseInvoiceId: id, ...scope },
      });
      await this.createLines(id, built.lines);
      await this.audit.record(
        "purchase_invoice.draft_updated",
        "purchase_invoice",
        id,
      );
      return this.get(id);
    } catch (error) {
      this.rethrowDuplicate(error);
    }
  }

  async approve(
    id: string,
    input: ApprovePurchaseInvoiceDto,
    idempotencyKey: string,
  ) {
    const scope = this.scope();
    const locked = await this.tenant.db.$queryRaw<Array<{ id: string }>>`
      SELECT "id" FROM "purchase_invoices"
      WHERE "id" = CAST(${id} AS uuid)
        AND "organization_id" = CAST(${scope.organizationId} AS uuid)
        AND "company_id" = CAST(${scope.companyId} AS uuid)
      FOR UPDATE
    `;
    if (!locked.length)
      throw new NotFoundException("Purchase invoice not found");
    const purchase = await this.tenant.db.purchaseInvoice.findFirstOrThrow({
      where: { id, ...scope },
      include: { lines: { include: { taxLines: true } } },
    });
    const existingApproval =
      await this.tenant.db.purchaseInvoiceApproval.findFirst({
        where: { companyId: scope.companyId, idempotencyKey },
      });
    if (existingApproval) {
      if (
        existingApproval.purchaseInvoiceId === id &&
        existingApproval.approvedById === this.tenant.required.userId
      )
        return this.get(id);
      throw new ConflictException(
        "Idempotency-Key was already used for another purchase approval",
      );
    }
    if (
      purchase.status !== PurchaseInvoiceStatus.DRAFT &&
      purchase.status !== PurchaseInvoiceStatus.PENDING_APPROVAL
    )
      throw new ConflictException("Purchase invoice is already approved");
    const actorApproval =
      await this.tenant.db.purchaseInvoiceApproval.findFirst({
        where: {
          purchaseInvoiceId: id,
          approvedById: this.tenant.required.userId,
          ...scope,
        },
        select: { id: true },
      });
    if (actorApproval)
      throw new ConflictException(
        "Each approval level requires a different approver",
      );
    if (
      !purchase.lines.length ||
      purchase.lines.some((line) => line.taxLines.length !== 1)
    )
      throw new ConflictException(
        "Every purchase invoice line must have one fiscal breakdown",
      );
    const unreviewedOcrJobs = await this.tenant.db.purchaseInvoiceOcrJob.count({
      where: {
        purchaseInvoiceId: id,
        ...scope,
        status: { not: "REVIEWED" },
      },
    });
    if (unreviewedOcrJobs)
      throw new ConflictException(
        "Every requested OCR extraction must be reviewed before approval",
      );
    const requestedSequenceId =
      purchase.status === PurchaseInvoiceStatus.PENDING_APPROVAL
        ? purchase.requestedSequenceId
        : input.sequenceId;
    if (
      purchase.status === PurchaseInvoiceStatus.PENDING_APPROVAL &&
      input.sequenceId !== requestedSequenceId
    )
      throw new ConflictException(
        "The reception sequence is frozen while approval is pending",
      );
    await this.requirePurchaseSequence(requestedSequenceId!, {
      active: purchase.status === PurchaseInvoiceStatus.DRAFT,
      lock: false,
    });
    if (purchase.status === PurchaseInvoiceStatus.DRAFT)
      await this.ensurePaymentSchedule(purchase);
    const requiredApprovals =
      purchase.status === PurchaseInvoiceStatus.DRAFT
        ? await this.resolveRequiredApprovals(purchase.total)
        : purchase.requiredApprovals;
    const approvalCount = purchase.approvalCount + 1;
    try {
      await this.tenant.db.purchaseInvoiceApproval.create({
        data: {
          ...scope,
          purchaseInvoiceId: id,
          position: approvalCount,
          approvedById: this.tenant.required.userId,
          idempotencyKey,
        },
      });
    } catch (error) {
      if (
        error instanceof Prisma.PrismaClientKnownRequestError &&
        error.code === "P2002"
      )
        throw new ConflictException(
          "Approval was already recorded concurrently",
        );
      throw error;
    }
    await this.audit.record(
      "purchase_invoice.approval_recorded",
      "purchase_invoice",
      id,
      { position: approvalCount, requiredApprovals },
    );
    if (approvalCount < requiredApprovals) {
      await this.tenant.db.purchaseInvoice.update({
        where: { id },
        data: {
          status: PurchaseInvoiceStatus.PENDING_APPROVAL,
          requestedSequenceId,
          requiredApprovals,
          approvalCount,
        },
      });
      return this.get(id);
    }
    const receptionFullNumber = await this.finalizeApproval(
      purchase,
      requestedSequenceId!,
      idempotencyKey,
      requiredApprovals,
      approvalCount,
    );
    await this.audit.record(
      "purchase_invoice.approved",
      "purchase_invoice",
      id,
      { receptionFullNumber },
    );
    return this.get(id);
  }

  async reject(id: string, input: RejectPurchaseInvoiceDto) {
    const scope = this.scope();
    await this.lockPurchase(id);
    const purchase = await this.tenant.db.purchaseInvoice.findFirst({
      where: { id, ...scope },
      select: { status: true },
    });
    if (!purchase) throw new NotFoundException("Purchase invoice not found");
    if (purchase.status !== PurchaseInvoiceStatus.PENDING_APPROVAL)
      throw new ConflictException(
        "Only a pending purchase invoice can be rejected",
      );
    await this.tenant.db.purchaseInvoiceApproval.deleteMany({
      where: { purchaseInvoiceId: id, ...scope },
    });
    await this.tenant.db.purchaseInvoice.update({
      where: { id },
      data: {
        status: PurchaseInvoiceStatus.DRAFT,
        requestedSequenceId: null,
        requiredApprovals: 1,
        approvalCount: 0,
      },
    });
    await this.audit.record(
      "purchase_invoice.approval_rejected",
      "purchase_invoice",
      id,
      { reason: input.reason.trim() },
    );
    return this.get(id);
  }

  private async lockPurchase(id: string) {
    const scope = this.scope();
    const locked = await this.tenant.db.$queryRaw<Array<{ id: string }>>`
      SELECT "id" FROM "purchase_invoices"
      WHERE "id" = CAST(${id} AS uuid)
        AND "organization_id" = CAST(${scope.organizationId} AS uuid)
        AND "company_id" = CAST(${scope.companyId} AS uuid)
      FOR UPDATE
    `;
    if (!locked.length)
      throw new NotFoundException("Purchase invoice not found");
  }

  private async requirePurchaseSequence(
    id: string,
    options: { active: boolean; lock: boolean },
  ) {
    const scope = this.scope();
    if (options.lock) {
      const locked = await this.tenant.db.$queryRaw<Array<{ id: string }>>`
        SELECT "id" FROM "document_sequences"
        WHERE "id" = CAST(${id} AS uuid)
          AND "organization_id" = CAST(${scope.organizationId} AS uuid)
          AND "company_id" = CAST(${scope.companyId} AS uuid)
        FOR UPDATE
      `;
      if (!locked.length)
        throw new BadRequestException("Document sequence not found");
    }
    const sequence = await this.tenant.db.documentSequence.findFirst({
      where: {
        id,
        ...scope,
        documentType: DocumentType.PURCHASE_INVOICE,
        ...(options.active ? { active: true } : {}),
      },
    });
    if (!sequence)
      throw new BadRequestException(
        options.active
          ? "An active PURCHASE_INVOICE sequence is required"
          : "Submitted PURCHASE_INVOICE sequence was not found",
      );
    return sequence;
  }

  private async ensurePaymentSchedule(purchase: PurchaseForApproval) {
    const scope = this.scope();
    const installments =
      await this.tenant.db.purchaseInvoiceInstallment.findMany({
        where: { purchaseInvoiceId: purchase.id, ...scope },
        select: { amount: true },
      });
    const payable = purchase.total.minus(purchase.withholdingAmount);
    if (!installments.length && payable.greaterThan(0))
      await this.tenant.db.purchaseInvoiceInstallment.create({
        data: {
          ...scope,
          purchaseInvoiceId: purchase.id,
          position: 1,
          dueDate: purchase.dueDate ?? purchase.issueDate,
          amount: payable,
        },
      });
    else if (
      !installments
        .reduce(
          (sum, installment) => sum.plus(installment.amount),
          new Decimal(0),
        )
        .equals(payable)
    )
      throw new ConflictException(
        "Payment schedule total must equal the purchase invoice total",
      );
  }

  private async resolveRequiredApprovals(total: Decimal) {
    const tier = await this.tenant.db.purchaseApprovalTier.findFirst({
      where: { ...this.scope(), minimumAmount: { lte: total } },
      orderBy: { minimumAmount: "desc" },
      select: { requiredApprovals: true },
    });
    return tier?.requiredApprovals ?? 1;
  }

  private async finalizeApproval(
    purchase: PurchaseForApproval,
    sequenceId: string,
    idempotencyKey: string,
    requiredApprovals: number,
    approvalCount: number,
  ) {
    const sequence = await this.requirePurchaseSequence(sequenceId, {
      active: false,
      lock: true,
    });
    const receptionNumber = sequence.nextNumber;
    const receptionFullNumber = `${sequence.series}-${receptionNumber
      .toString()
      .padStart(sequence.padding, "0")}`;
    await this.tenant.db.documentSequence.update({
      where: { id: sequence.id },
      data: { nextNumber: { increment: 1 } },
    });
    await this.tenant.db.purchaseInvoice.update({
      where: { id: purchase.id },
      data: {
        requestedSequenceId: null,
        sequenceId: sequence.id,
        receptionSeries: sequence.series,
        receptionNumber,
        receptionFullNumber,
        approvalKey: idempotencyKey,
        requiredApprovals,
        approvalCount,
        status: PurchaseInvoiceStatus.APPROVED,
        amountDue: purchase.total.minus(purchase.withholdingAmount),
        approvedAt: new Date(),
      },
    });
    await this.tax.postPurchaseInvoice(purchase.id);
    await this.accounting.postPurchaseInvoice(purchase.id);
    return receptionFullNumber;
  }

  async delete(id: string) {
    const deleted = await this.tenant.db.purchaseInvoice.deleteMany({
      where: { id, ...this.scope(), status: PurchaseInvoiceStatus.DRAFT },
    });
    if (deleted.count !== 1)
      throw new ConflictException(
        "Purchase invoice was not found or is no longer a draft",
      );
    await this.audit.record(
      "purchase_invoice.draft_deleted",
      "purchase_invoice",
      id,
    );
  }

  private async build(input: CreatePurchaseInvoiceDto) {
    const operationDate = input.operationDate ?? input.issueDate;
    const deductionDate = input.deductionDate ?? input.receivedDate;
    if (operationDate > input.issueDate)
      throw new BadRequestException("operationDate cannot follow issueDate");
    if (input.receivedDate < input.issueDate)
      throw new BadRequestException("receivedDate cannot precede issueDate");
    if (deductionDate < input.receivedDate)
      throw new BadRequestException(
        "deductionDate cannot precede receivedDate",
      );
    if (input.dueDate && input.dueDate < input.issueDate)
      throw new BadRequestException("dueDate cannot precede issueDate");
    const scope = this.scope();
    const supplier = await this.tenant.db.contact.findFirst({
      where: {
        id: input.supplierId,
        ...scope,
        isSupplier: true,
        status: ContactStatus.ACTIVE,
      },
    });
    if (!supplier)
      throw new BadRequestException(
        "Purchase invoice supplier must be active in this company",
      );
    await this.validateCatalogItems(input.lines);
    const rules = await this.tax.resolveRules(input.lines, operationDate);
    const lines = input.lines.map((line, index) =>
      buildLine(line, rules[index], index + 1),
    );
    const totals = lines.reduce(
      (sum, line) => ({
        subtotal: sum.subtotal.plus(line.gross),
        discountTotal: sum.discountTotal.plus(line.discount),
        taxTotal: sum.taxTotal.plus(line.tax.taxAmount),
        deductibleTaxTotal: sum.deductibleTaxTotal.plus(
          line.tax.deductibleAmount,
        ),
        total: sum.total.plus(line.persisted.totalAmount),
      }),
      {
        subtotal: new Decimal(0),
        discountTotal: new Decimal(0),
        taxTotal: new Decimal(0),
        deductibleTaxTotal: new Decimal(0),
        total: new Decimal(0),
      },
    );
    const withholdingRate = new Decimal(input.withholdingRate ?? 0);
    const withholdingBase = totals.subtotal.minus(totals.discountTotal);
    const withholdingAmount = withholdingBase.mul(withholdingRate).div(100).toDecimalPlaces(2);
    if (withholdingAmount.greaterThanOrEqualTo(totals.total))
      throw new BadRequestException("Withholding must be less than the invoice total");
    if (withholdingRate.greaterThan(0) &&
        !/^[0-9XYZ][0-9A-Z]{8}$/i.test(supplier.taxId ?? ""))
      throw new BadRequestException("Professional IRPF withholding requires a supplier with a Spanish personal NIF or NIE");
    return {
      document: {
        supplierId: supplier.id,
        supplierInvoiceNumber: input.supplierInvoiceNumber.trim(),
        supplierLegalName: supplier.legalName,
        supplierTaxId: supplier.taxId,
        issueDate: new Date(input.issueDate),
        operationDate: new Date(operationDate),
        receivedDate: new Date(input.receivedDate),
        deductionDate: new Date(deductionDate),
        dueDate: input.dueDate ? new Date(input.dueDate) : null,
        currency: input.currency ?? "EUR",
        notes: input.notes?.trim() || null,
        ...totals,
        withholdingRate,
        withholdingAmount,
      },
      lines,
    };
  }

  private async createLines(purchaseInvoiceId: string, lines: BuiltLine[]) {
    const scope = this.scope();
    for (const line of lines) {
      const created = await this.tenant.db.purchaseInvoiceLine.create({
        data: { purchaseInvoiceId, ...scope, ...line.persisted },
      });
      await this.tenant.db.purchaseTaxLine.create({
        data: {
          purchaseInvoiceId,
          purchaseInvoiceLineId: created.id,
          ...scope,
          ...line.tax,
        },
      });
    }
  }

  private async validateCatalogItems(lines: PurchaseInvoiceLineDto[]) {
    const scope = this.scope();
    const ids = [
      ...new Set(
        lines.flatMap(({ catalogItemId }) =>
          catalogItemId ? [catalogItemId] : [],
        ),
      ),
    ];
    if (!ids.length) return;
    const count = await this.tenant.db.catalogItem.count({
      where: { id: { in: ids }, ...scope, status: CatalogItemStatus.ACTIVE },
    });
    if (count !== ids.length)
      throw new BadRequestException(
        "All catalog items must be active in this company",
      );
  }

  private scope() {
    const { organizationId, companyId } = this.tenant.required;
    if (!companyId) throw new BadRequestException("x-company-id is required");
    return { organizationId, companyId };
  }

  private rethrowDuplicate(error: unknown): never {
    if (
      error instanceof Prisma.PrismaClientKnownRequestError &&
      error.code === "P2002"
    )
      throw new ConflictException(
        "Supplier invoice number already exists for this supplier",
      );
    throw error;
  }
}

function buildLine(
  input: PurchaseInvoiceLineDto,
  rule: TaxRule,
  position: number,
): BuiltLine {
  if (!rule.deductionRight && input.deductiblePct > 0)
    throw new BadRequestException(
      "This tax rule does not allow input VAT deduction",
    );
  const calculation = calculateInvoiceLine(
    { ...input, taxRate: Number(rule.rate ?? 0) },
    position,
  );
  const deductibleAmount = calculation.persisted.taxAmount
    .mul(input.deductiblePct)
    .div(100)
    .toDecimalPlaces(2);
  return {
    gross: calculation.gross,
    discount: calculation.discount,
    persisted: {
      position,
      catalogItemId: input.catalogItemId,
      description: calculation.persisted.description,
      quantity: calculation.persisted.quantity,
      unitPrice: calculation.persisted.unitPrice,
      discountPct: calculation.persisted.discountPct,
      netAmount: calculation.persisted.netAmount,
      taxAmount: calculation.persisted.taxAmount,
      totalAmount: calculation.persisted.totalAmount,
    },
    tax: {
      taxRuleId: rule.id,
      taxCode: rule.code,
      taxableBase: calculation.persisted.netAmount,
      taxRate: rule.rate,
      taxAmount: calculation.persisted.taxAmount,
      deductiblePct: new Decimal(input.deductiblePct),
      deductibleAmount,
      subject: rule.subject,
      exempt: rule.exempt,
      exemptionReason: input.exemptionReason?.trim() || null,
      reverseCharge: rule.reverseCharge,
    },
  };
}

interface BuiltLine {
  gross: Decimal;
  discount: Decimal;
  persisted: {
    position: number;
    catalogItemId?: string;
    description: string;
    quantity: Decimal;
    unitPrice: Decimal;
    discountPct: Decimal;
    netAmount: Decimal;
    taxAmount: Decimal;
    totalAmount: Decimal;
  };
  tax: {
    taxRuleId: string;
    taxCode: string;
    taxableBase: Decimal;
    taxRate: Decimal | null;
    taxAmount: Decimal;
    deductiblePct: Decimal;
    deductibleAmount: Decimal;
    subject: boolean;
    exempt: boolean;
    exemptionReason: string | null;
    reverseCharge: boolean;
  };
}

type PurchaseForApproval = Prisma.PurchaseInvoiceGetPayload<{
  include: { lines: { include: { taxLines: true } } };
}>;

function presentPurchaseInvoice<T extends { receptionNumber: bigint | null }>(
  purchase: T,
) {
  return {
    ...purchase,
    receptionNumber: purchase.receptionNumber?.toString() ?? null,
  };
}
