import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
} from "@nestjs/common";
import {
  DocumentType,
  InstallmentStatus,
  InvoiceStatus,
  Prisma,
} from "@prisma/client";
import { Decimal } from "@prisma/client/runtime/library";
import { AccountingService } from "../accounting/accounting.service";
import { AuditService } from "../audit/audit.service";
import { TenantContextService } from "../tenancy/tenant-context.service";
import { RecordPaymentDto } from "./dto/record-payment.dto";
import { SetPaymentScheduleDto } from "./dto/set-payment-schedule.dto";
import { CommercialEventsService } from "../commercial-events/commercial-events.service";
import { installmentOpenAmount } from "./receivable-credit";

@Injectable()
export class PaymentsService {
  constructor(
    private readonly tenant: TenantContextService,
    private readonly audit: AuditService,
    private readonly accounting: AccountingService,
    private readonly commercialEvents: CommercialEventsService,
  ) {}

  async getSchedule(invoiceId: string) {
    await this.requireInvoice(invoiceId);
    return this.tenant.db.invoiceInstallment.findMany({
      where: { invoiceId, ...this.scope() },
      orderBy: { position: "asc" },
    });
  }

  async setSchedule(invoiceId: string, input: SetPaymentScheduleDto) {
    const scope = this.scope();
    await this.lockInvoice(invoiceId);
    const invoice = await this.requireInvoice(invoiceId);
    if (
      invoice.documentType !== DocumentType.INVOICE ||
      invoice.status !== InvoiceStatus.DRAFT
    )
      throw new ConflictException(
        "Payment schedules can only be changed on standard invoice drafts",
      );
    const issueDate = invoice.issueDate.toISOString().slice(0, 10);
    if (input.installments.some(({ dueDate }) => dueDate < issueDate))
      throw new BadRequestException(
        "Installment due dates cannot precede the invoice issue date",
      );
    const amounts = input.installments.map(({ amount }) => new Decimal(amount));
    const scheduled = amounts.reduce(
      (sum, amount) => sum.plus(amount),
      new Decimal(0),
    );
    if (!scheduled.equals(invoice.total))
      throw new BadRequestException(
        "Payment schedule total must equal the invoice total",
      );
    await this.tenant.db.invoiceInstallment.deleteMany({
      where: { invoiceId, ...scope },
    });
    await this.tenant.db.invoiceInstallment.createMany({
      data: input.installments.map((installment, index) => ({
        ...scope,
        invoiceId,
        position: index + 1,
        dueDate: new Date(installment.dueDate),
        amount: amounts[index],
      })),
    });
    const dueDate = input.installments
      .map(({ dueDate }) => dueDate)
      .reduce((latest, item) => (item > latest ? item : latest));
    await this.tenant.db.invoice.update({
      where: { id: invoiceId },
      data: { dueDate: new Date(dueDate) },
    });
    await this.audit.record(
      "invoice.payment_schedule_updated",
      "invoice",
      invoiceId,
      { installments: input.installments.length },
    );
    return this.getSchedule(invoiceId);
  }

  async list(invoiceId: string) {
    await this.requireInvoice(invoiceId);
    const scope = this.scope();
    return this.tenant.db.payment.findMany({
      where: {
        ...scope,
        allocations: { some: { invoiceId, ...scope } },
      },
      include: {
        allocations: {
          where: { invoiceId, ...scope },
          orderBy: { createdAt: "asc" },
        },
      },
      orderBy: [{ paidAt: "desc" }, { id: "desc" }],
    });
  }

  async record(
    invoiceId: string,
    input: RecordPaymentDto,
    idempotencyKey: string,
  ) {
    const scope = this.scope();
    await this.lockInvoice(invoiceId);
    const invoice = await this.requireInvoice(invoiceId);
    const existing = await this.tenant.db.payment.findFirst({
      where: { ...scope, idempotencyKey },
      include: { allocations: true },
    });
    if (existing) {
      if (this.matches(existing, invoiceId, input)) {
        await this.accounting.postPayment(existing.id);
        return existing;
      }
      throw new ConflictException(
        "Idempotency-Key has already been used for another payment",
      );
    }
    if (
      invoice.documentType !== DocumentType.INVOICE ||
      new Set<InvoiceStatus>([
        InvoiceStatus.DRAFT,
        InvoiceStatus.PAID,
        InvoiceStatus.SETTLED,
        InvoiceStatus.RECTIFIED,
        InvoiceStatus.CANCELLED,
      ]).has(invoice.status)
    )
      throw new ConflictException("Invoice is not eligible for a payment");
    const amount = new Decimal(input.amount);
    if (amount.greaterThan(invoice.amountDue))
      throw new BadRequestException(
        "Payment amount cannot exceed the invoice amount due",
      );
    const installments = await this.tenant.db.invoiceInstallment.findMany({
      where: { invoiceId, ...scope },
      orderBy: [{ dueDate: "asc" }, { position: "asc" }],
    });
    if (!installments.length)
      throw new ConflictException("Invoice has no payable installment");
    try {
      const payment = await this.tenant.db.payment.create({
        data: {
          ...scope,
          idempotencyKey,
          amount,
          currency: invoice.currency,
          paidAt: new Date(input.paidAt),
          method: input.method,
          reference: input.reference?.trim() || null,
          notes: input.notes?.trim() || null,
        },
      });
      let remaining = amount;
      for (const installment of installments) {
        if (remaining.isZero()) break;
        const open = installmentOpenAmount(installment);
        if (open.lessThanOrEqualTo(0)) continue;
        const allocated = Decimal.min(open, remaining);
        const paidAmount = installment.paidAmount.plus(allocated);
        await this.tenant.db.paymentAllocation.create({
          data: {
            ...scope,
            paymentId: payment.id,
            invoiceId,
            installmentId: installment.id,
            amount: allocated,
          },
        });
        await this.tenant.db.invoiceInstallment.update({
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
      const amountPaid = invoice.amountPaid.plus(amount);
      const amountDue = invoice.amountDue.minus(amount);
      await this.tenant.db.invoice.update({
        where: { id: invoiceId },
        data: {
          amountPaid,
          amountDue,
          status: amountDue.isZero()
            ? invoice.creditedAmount.greaterThan(0)
              ? InvoiceStatus.SETTLED
              : InvoiceStatus.PAID
            : InvoiceStatus.PARTIALLY_PAID,
        },
      });
      await this.accounting.postPayment(payment.id);
      await this.commercialEvents.recordPayment({
        invoiceId,
        paymentId: payment.id,
        paidAt: payment.paidAt,
        amount: amount.toFixed(2),
        currency: invoice.currency,
        fullyPaid: amountDue.isZero(),
      });
      await this.audit.record("payment.created", "payment", payment.id, {
        invoiceId,
        amount: amount.toFixed(2),
        currency: invoice.currency,
        method: input.method,
        idempotencyKey,
      });
      return this.tenant.db.payment.findUniqueOrThrow({
        where: { id: payment.id },
        include: { allocations: { orderBy: { createdAt: "asc" } } },
      });
    } catch (error) {
      if (
        error instanceof Prisma.PrismaClientKnownRequestError &&
        error.code === "P2002"
      )
        throw new ConflictException(
          "Idempotency-Key was used by another payment concurrently",
        );
      throw error;
    }
  }

  private matches(
    payment: {
      amount: Decimal;
      paidAt: Date;
      method: string;
      reference: string | null;
      notes: string | null;
      allocations: Array<{ invoiceId: string }>;
    },
    invoiceId: string,
    input: RecordPaymentDto,
  ) {
    return (
      payment.amount.equals(new Decimal(input.amount)) &&
      payment.paidAt.getTime() === new Date(input.paidAt).getTime() &&
      payment.method === input.method &&
      payment.reference === (input.reference?.trim() || null) &&
      payment.notes === (input.notes?.trim() || null) &&
      payment.allocations.length > 0 &&
      payment.allocations.every((item) => item.invoiceId === invoiceId)
    );
  }

  private async lockInvoice(invoiceId: string) {
    const scope = this.scope();
    const locked = await this.tenant.db.$queryRaw<Array<{ id: string }>>`
      SELECT "id" FROM "invoices"
      WHERE "id" = CAST(${invoiceId} AS uuid)
        AND "organization_id" = CAST(${scope.organizationId} AS uuid)
        AND "company_id" = CAST(${scope.companyId} AS uuid)
      FOR UPDATE
    `;
    if (!locked.length) throw new NotFoundException("Invoice not found");
  }

  private async requireInvoice(invoiceId: string) {
    const invoice = await this.tenant.db.invoice.findFirst({
      where: { id: invoiceId, ...this.scope() },
    });
    if (!invoice) throw new NotFoundException("Invoice not found");
    return invoice;
  }

  private scope() {
    const { organizationId, companyId } = this.tenant.required;
    if (!companyId) throw new BadRequestException("x-company-id is required");
    return { organizationId, companyId };
  }
}
