import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
} from "@nestjs/common";
import {
  InstallmentStatus,
  Prisma,
  PurchaseInvoiceStatus,
} from "@prisma/client";
import { Decimal } from "@prisma/client/runtime/library";
import { AccountingService } from "../accounting/accounting.service";
import { AuditService } from "../audit/audit.service";
import { TenantContextService } from "../tenancy/tenant-context.service";
import { RecordSupplierPaymentDto } from "./dto/record-supplier-payment.dto";
import { allocateProfessionalWithholding } from "./professional-withholding";
import {
  PurchasePaymentScheduleQueryDto,
  SetPurchasePaymentScheduleDto,
} from "./dto/purchase-payment-schedule.dto";

@Injectable()
export class SupplierPaymentsService {
  constructor(
    private readonly tenant: TenantContextService,
    private readonly audit: AuditService,
    private readonly accounting: AccountingService,
  ) {}

  async withholdingSummary(year: number) {
    if (!Number.isInteger(year) || year < 2000 || year > 2100)
      throw new BadRequestException("A valid fiscal year is required");
    const payments = await this.tenant.db.supplierPayment.findMany({
      where: {
        ...this.scope(),
        paidAt: { gte: new Date(`${year}-01-01T00:00:00.000Z`), lt: new Date(`${year + 1}-01-01T00:00:00.000Z`) },
        withholdingAmount: { gt: 0 },
      },
      include: { purchaseInvoice: { select: {
        supplierTaxId: true, supplierLegalName: true, supplierInvoiceNumber: true,
        withholdingRate: true,
      } } },
      orderBy: { paidAt: "asc" },
    });
    const entries = payments.map((payment) => ({
      paymentId: payment.id,
      paidAt: payment.paidAt,
      supplierTaxId: payment.purchaseInvoice.supplierTaxId,
      supplierLegalName: payment.purchaseInvoice.supplierLegalName,
      supplierInvoiceNumber: payment.purchaseInvoice.supplierInvoiceNumber,
      rate: payment.purchaseInvoice.withholdingRate,
      base: payment.withholdingBase,
      withheld: payment.withholdingAmount,
      quarter: Math.floor(payment.paidAt.getUTCMonth() / 3) + 1,
    }));
    const quarters = [1, 2, 3, 4].map((quarter) => {
      const rows = entries.filter((entry) => entry.quarter === quarter);
      return {
        quarter,
        payments: rows.length,
        base: rows.reduce((sum, row) => sum.plus(row.base), new Decimal(0)).toFixed(2),
        withheld: rows.reduce((sum, row) => sum.plus(row.withheld), new Decimal(0)).toFixed(2),
      };
    });
    const supplierIds = [...new Set(entries.map((entry) => entry.supplierTaxId))];
    return {
      year,
      basis: "paidAt",
      quarters,
      annualBySupplier: supplierIds.map((supplierTaxId) => {
        const rows = entries.filter((entry) => entry.supplierTaxId === supplierTaxId);
        return {
          supplierTaxId,
          supplierLegalName: rows[0].supplierLegalName,
          payments: rows.length,
          base: rows.reduce((sum, row) => sum.plus(row.base), new Decimal(0)).toFixed(2),
          withheld: rows.reduce((sum, row) => sum.plus(row.withheld), new Decimal(0)).toFixed(2),
        };
      }),
      payments: entries,
    };
  }

  async getSchedule(
    purchaseInvoiceId: string,
    query: PurchasePaymentScheduleQueryDto,
  ) {
    await this.requirePurchase(purchaseInvoiceId);
    const asOf = new Date(query.asOf ?? new Date()).toISOString().slice(0, 10);
    const installments =
      await this.tenant.db.purchaseInvoiceInstallment.findMany({
        where: { purchaseInvoiceId, ...this.scope() },
        orderBy: { position: "asc" },
      });
    return {
      asOf,
      installments: installments.map((installment) => ({
        ...installment,
        overdue:
          installment.status !== InstallmentStatus.PAID &&
          installment.dueDate.toISOString().slice(0, 10) < asOf,
      })),
    };
  }

  async setSchedule(
    purchaseInvoiceId: string,
    input: SetPurchasePaymentScheduleDto,
  ) {
    const scope = this.scope();
    await this.lockPurchase(purchaseInvoiceId);
    const purchase = await this.requirePurchase(purchaseInvoiceId);
    if (purchase.status !== PurchaseInvoiceStatus.DRAFT)
      throw new ConflictException(
        "Payment schedules can only be changed on purchase invoice drafts",
      );
    const issueDate = purchase.issueDate.toISOString().slice(0, 10);
    if (input.installments.some(({ dueDate }) => dueDate < issueDate))
      throw new BadRequestException(
        "Installment due dates cannot precede the purchase invoice issue date",
      );
    const amounts = input.installments.map(({ amount }) => new Decimal(amount));
    const scheduled = amounts.reduce(
      (sum, amount) => sum.plus(amount),
      new Decimal(0),
    );
    if (!scheduled.equals(purchase.total.minus(purchase.withholdingAmount)))
      throw new BadRequestException(
        "Payment schedule total must equal the net supplier payable",
      );
    await this.tenant.db.purchaseInvoiceInstallment.deleteMany({
      where: { purchaseInvoiceId, ...scope },
    });
    await this.tenant.db.purchaseInvoiceInstallment.createMany({
      data: input.installments.map((installment, index) => ({
        ...scope,
        purchaseInvoiceId,
        position: index + 1,
        dueDate: new Date(installment.dueDate),
        amount: amounts[index],
      })),
    });
    const dueDate = input.installments
      .map((installment) => installment.dueDate)
      .reduce((latest, item) => (item > latest ? item : latest));
    await this.tenant.db.purchaseInvoice.update({
      where: { id: purchaseInvoiceId },
      data: { dueDate: new Date(dueDate) },
    });
    await this.audit.record(
      "purchase_invoice.payment_schedule_updated",
      "purchase_invoice",
      purchaseInvoiceId,
      { installments: input.installments.length },
    );
    return this.getSchedule(purchaseInvoiceId, {});
  }

  async list(purchaseInvoiceId: string) {
    await this.requirePurchase(purchaseInvoiceId);
    return this.tenant.db.supplierPayment.findMany({
      where: { purchaseInvoiceId, ...this.scope() },
      include: { allocations: { orderBy: { createdAt: "asc" } } },
      orderBy: [{ paidAt: "desc" }, { id: "desc" }],
    });
  }

  async record(
    purchaseInvoiceId: string,
    input: RecordSupplierPaymentDto,
    idempotencyKey: string,
  ) {
    if (input.paidByShareholder && (input.method !== "OTHER" || !input.reference?.trim()))
      throw new BadRequestException("La aportación no reintegrable del socio requiere método Otro y una referencia documental");
    const scope = this.scope();
    await this.lockPurchase(purchaseInvoiceId);
    const purchase = await this.requirePurchase(purchaseInvoiceId);
    const existing = await this.tenant.db.supplierPayment.findFirst({
      where: { ...scope, idempotencyKey },
      include: { allocations: true },
    });
    if (existing) {
      if (this.matches(existing, purchaseInvoiceId, input)) {
        await this.accounting.postSupplierPayment(existing.id);
        return existing;
      }
      throw new ConflictException(
        "Idempotency-Key has already been used for another supplier payment",
      );
    }
    if (
      purchase.status !== PurchaseInvoiceStatus.APPROVED ||
      purchase.amountDue.lessThanOrEqualTo(0)
    )
      throw new ConflictException(
        "Purchase invoice is not eligible for a payment",
      );
    const amount = new Decimal(input.amount);
    if (amount.greaterThan(purchase.amountDue))
      throw new BadRequestException(
        "Payment amount cannot exceed the purchase invoice amount due",
      );
    const previousPayments = await this.tenant.db.supplierPayment.findMany({
      where: { purchaseInvoiceId, ...scope },
      select: { withholdingAmount: true, withholdingBase: true },
    });
    const retained = previousPayments.reduce((sum, item) => sum.plus(item.withholdingAmount), new Decimal(0));
    const retainedBase = previousPayments.reduce((sum, item) => sum.plus(item.withholdingBase), new Decimal(0));
    const netTotal = purchase.total.minus(purchase.withholdingAmount);
    const purchaseLines = await this.tenant.db.purchaseInvoiceLine.findMany({
      where: { purchaseInvoiceId, ...scope }, select: { netAmount: true, isDisbursement: true },
    });
    const grossBase = purchaseLines.reduce((sum, line) =>
      line.isDisbursement ? sum : sum.plus(line.netAmount), new Decimal(0));
    const { withholdingAmount, withholdingBase } = allocateProfessionalWithholding({
      netPayment: amount,
      netDue: purchase.amountDue,
      netTotal,
      grossBase,
      totalWithholding: purchase.withholdingAmount,
      baseAlreadyReported: retainedBase,
      withholdingAlreadyReported: retained,
    });
    const installments =
      await this.tenant.db.purchaseInvoiceInstallment.findMany({
        where: { purchaseInvoiceId, ...scope },
        orderBy: [{ dueDate: "asc" }, { position: "asc" }],
      });
    if (!installments.length)
      throw new ConflictException(
        "Purchase invoice has no payable installment",
      );
    try {
      const payment = await this.tenant.db.supplierPayment.create({
        data: {
          ...scope,
          purchaseInvoiceId,
          idempotencyKey,
          amount,
          withholdingAmount,
          withholdingBase,
          currency: purchase.currency,
          paidAt: new Date(input.paidAt),
          method: input.method,
          paidByShareholder: input.paidByShareholder ?? false,
          reference: input.reference?.trim() || null,
          notes: input.notes?.trim() || null,
        },
      });
      let remaining = amount;
      for (const installment of installments) {
        if (remaining.isZero()) break;
        const open = installment.amount.minus(installment.paidAmount);
        if (open.lessThanOrEqualTo(0)) continue;
        const allocated = Decimal.min(open, remaining);
        const paidAmount = installment.paidAmount.plus(allocated);
        await this.tenant.db.supplierPaymentAllocation.create({
          data: {
            ...scope,
            supplierPaymentId: payment.id,
            purchaseInvoiceId,
            installmentId: installment.id,
            amount: allocated,
          },
        });
        await this.tenant.db.purchaseInvoiceInstallment.update({
          where: { id: installment.id },
          data: {
            paidAmount,
            status: paidAmount.equals(installment.amount)
              ? InstallmentStatus.PAID
              : InstallmentStatus.PARTIALLY_PAID,
          },
        });
        remaining = remaining.minus(allocated);
      }
      if (!remaining.isZero())
        throw new ConflictException(
          "Payment schedule does not have enough open balance",
        );
      await this.tenant.db.purchaseInvoice.update({
        where: { id: purchase.id },
        data: {
          amountPaid: purchase.amountPaid.plus(amount),
          amountDue: purchase.amountDue.minus(amount),
        },
      });
      await this.accounting.postSupplierPayment(payment.id);
      await this.audit.record(
        "supplier_payment.created",
        "supplier_payment",
        payment.id,
        {
          purchaseInvoiceId,
          amount: amount.toFixed(2),
          currency: purchase.currency,
          method: input.method,
          idempotencyKey,
        },
      );
      return this.tenant.db.supplierPayment.findUniqueOrThrow({
        where: { id: payment.id },
        include: { allocations: { orderBy: { createdAt: "asc" } } },
      });
    } catch (error) {
      if (
        error instanceof Prisma.PrismaClientKnownRequestError &&
        error.code === "P2002"
      )
        throw new ConflictException(
          "Idempotency-Key was used by another supplier payment concurrently",
        );
      throw error;
    }
  }

  private matches(
    payment: {
      purchaseInvoiceId: string;
      amount: Decimal;
      paidAt: Date;
      method: string;
      paidByShareholder: boolean;
      reference: string | null;
      notes: string | null;
    },
    purchaseInvoiceId: string,
    input: RecordSupplierPaymentDto,
  ) {
    return (
      payment.purchaseInvoiceId === purchaseInvoiceId &&
      payment.amount.equals(new Decimal(input.amount)) &&
      payment.paidAt.getTime() === new Date(input.paidAt).getTime() &&
      payment.method === input.method &&
      payment.paidByShareholder === (input.paidByShareholder ?? false) &&
      payment.reference === (input.reference?.trim() || null) &&
      payment.notes === (input.notes?.trim() || null)
    );
  }

  private async lockPurchase(purchaseInvoiceId: string) {
    const scope = this.scope();
    const locked = await this.tenant.db.$queryRaw<Array<{ id: string }>>`
      SELECT "id" FROM "purchase_invoices"
      WHERE "id" = CAST(${purchaseInvoiceId} AS uuid)
        AND "organization_id" = CAST(${scope.organizationId} AS uuid)
        AND "company_id" = CAST(${scope.companyId} AS uuid)
      FOR UPDATE
    `;
    if (!locked.length)
      throw new NotFoundException("Purchase invoice not found");
  }

  private async requirePurchase(id: string) {
    const purchase = await this.tenant.db.purchaseInvoice.findFirst({
      where: { id, ...this.scope() },
    });
    if (!purchase) throw new NotFoundException("Purchase invoice not found");
    return purchase;
  }

  private scope() {
    const { organizationId, companyId } = this.tenant.required;
    if (!companyId) throw new BadRequestException("x-company-id is required");
    return { organizationId, companyId };
  }
}
