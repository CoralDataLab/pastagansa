import "reflect-metadata";
import { InvoiceStatus } from "@prisma/client";
import { Decimal } from "@prisma/client/runtime/library";
import { AuditService } from "../audit/audit.service";
import { TenantContextService } from "../tenancy/tenant-context.service";
import { ReminderTemplate } from "./dto/payment-reminder.dto";
import { InvoiceEmailService } from "./invoice-email.service";
import { SmtpInvoiceMailer } from "./smtp-invoice-mailer.service";

function serviceFor(dueDate: Date | null, installments: Array<{ dueDate: Date; amount: Decimal; paidAmount: Decimal }>) {
  const db = {
    invoice: { findFirst: jest.fn().mockResolvedValue({
      id: "invoice-1", status: InvoiceStatus.ISSUED, fullNumber: "F2026-0001",
      customerEmail: "customer@example.com", customerLegalName: "Cliente Demo",
      issuerLegalName: "Emisor Demo", amountDue: new Decimal("121.00"),
      currency: "EUR", dueDate,
      installments: installments.map((item) => ({ ...item, creditedAmount: new Decimal(0) })),
      commercialEvents: [],
    }) },
    companyDocumentProfile: { findFirst: jest.fn().mockResolvedValue(null) },
    company: { findFirst: jest.fn().mockResolvedValue({ legalName: "Emisor Demo", timezone: "Europe/Madrid" }) },
  };
  const tenant = { required: { organizationId: "org-1", companyId: "company-1" }, db } as unknown as TenantContextService;
  return new InvoiceEmailService(tenant, {} as AuditService, { enabled: true } as SmtpInvoiceMailer);
}

describe("payment reminder due dates", () => {
  it("uses the earliest unpaid installment when the invoice due date is empty", async () => {
    const service = serviceFor(null, [
      { dueDate: new Date("2024-01-01T00:00:00Z"), amount: new Decimal("60.50"), paidAmount: new Decimal("60.50") },
      { dueDate: new Date("2024-02-01T00:00:00Z"), amount: new Decimal("60.50"), paidAmount: new Decimal("0") },
    ]);

    const preview = await service.previewPaymentReminder("invoice-1", ReminderTemplate.OVERDUE_FIRST);

    expect(preview.eligible).toBe(true);
    expect(preview.invoice.dueDate).toBe("2024-02-01");
    expect(preview.body).toContain("venció el 1/2/2024");
    expect(preview.body).not.toContain("sin fecha de vencimiento");
  });

  it("does not claim that an invoice with no due date has expired", async () => {
    const preview = await serviceFor(null, []).previewPaymentReminder("invoice-1", ReminderTemplate.OVERDUE_FIRST);

    expect(preview.eligible).toBe(false);
    expect(preview.reason).toBe("La factura no tiene fecha de vencimiento");
    expect(preview.body).toBeNull();
  });

  it("does not send an overdue notice before the due date", async () => {
    const future = new Date(Date.now() + 10 * 86_400_000);
    const preview = await serviceFor(future, []).previewPaymentReminder("invoice-1", ReminderTemplate.OVERDUE_FIRST);

    expect(preview.eligible).toBe(false);
    expect(preview.reason).toBe("La factura aún no ha vencido; elige próximo vencimiento");
  });
});
