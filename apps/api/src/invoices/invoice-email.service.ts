import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
} from "@nestjs/common";
import { CommercialDocumentEventType, DeliveryDocumentType, DeliveryPurpose, InvoiceStatus, QuoteStatus } from "@prisma/client";
import { AuditService } from "../audit/audit.service";
import { captureIssuerSnapshot } from "../documents/issuer-snapshot";
import { TenantContextService } from "../tenancy/tenant-context.service";
import { SendDocumentEmailDto } from "./dto/send-invoice-email.dto";
import { ReminderTemplate } from "./dto/payment-reminder.dto";
import { SmtpInvoiceMailer } from "./smtp-invoice-mailer.service";

const DEFAULT_BODY = "{{company_name}} adjunta {{document_type}} {{document_number}}.";
const reminderTemplates: Record<ReminderTemplate, { version: string; subject: string; body: string }> = {
  DUE_SOON: {
    version: "payment-reminder-due-soon-v1",
    subject: "Aviso de vencimiento: factura {{document_number}}",
    body: "Hola {{customer_name}},\n\nte recordamos que la factura {{document_number}} vence el {{due_date}}. El saldo pendiente es {{amount_due}}.\n\n{{payment_instructions}}\n{{bank_iban}}\n\nGracias,\n{{company_name}}",
  },
  OVERDUE_FIRST: {
    version: "payment-reminder-overdue-first-v1",
    subject: "Recordatorio de pago: factura {{document_number}}",
    body: "Hola {{customer_name}},\n\nla factura {{document_number}} venció el {{due_date}} y mantiene un saldo pendiente de {{amount_due}}.\n\n{{payment_instructions}}\n{{bank_iban}}\n\nGracias,\n{{company_name}}",
  },
  OVERDUE_SECOND: {
    version: "payment-reminder-overdue-second-v1",
    subject: "Segundo aviso de pago: factura {{document_number}}",
    body: "Hola {{customer_name}},\n\nte enviamos un segundo recordatorio de la factura {{document_number}}, vencida el {{due_date}}. El saldo pendiente es {{amount_due}}.\n\n{{payment_instructions}}\n{{bank_iban}}\n\nGracias,\n{{company_name}}",
  },
};

@Injectable()
export class InvoiceEmailService {
  constructor(
    private readonly tenant: TenantContextService,
    private readonly audit: AuditService,
    private readonly mailer: SmtpInvoiceMailer,
  ) {}

  capability() {
    return { enabled: this.mailer.enabled };
  }

  enqueue(invoiceId: string, input: SendDocumentEmailDto, idempotencyKey: string) {
    return this.enqueueInvoice(invoiceId, input, idempotencyKey);
  }

  async enqueueInvoice(invoiceId: string, input: SendDocumentEmailDto, idempotencyKey: string) {
    const scope = this.scope();
    const invoice = await this.tenant.db.invoice.findFirst({
      where: { id: invoiceId, ...scope },
      select: { id: true, status: true, fullNumber: true, customerEmail: true, customerLegalName: true, issuerLegalName: true },
    });
    if (!invoice) throw new NotFoundException("Invoice not found");
    if (invoice.status === InvoiceStatus.DRAFT || !invoice.fullNumber)
      throw new ConflictException("Only issued invoices can be emailed");
    const profile = await this.profile();
    return this.createDelivery({
      type: DeliveryDocumentType.INVOICE,
      invoiceId,
      recipient: input.recipient ?? invoice.customerEmail,
      subject: input.subject,
      defaultSubject: profile?.invoiceEmailSubjectTemplate ?? "Factura {{document_number}}",
      bodyTemplate: profile?.emailBodyTemplate ?? DEFAULT_BODY,
      parameters: parametersFor("la factura", invoice.fullNumber, invoice.customerLegalName, invoice.issuerLegalName),
      idempotencyKey,
      auditAction: "invoice.email_queued",
      auditEntity: "invoice",
    });
  }

  async enqueueQuote(quoteId: string, input: SendDocumentEmailDto, idempotencyKey: string) {
    const scope = this.scope();
    await this.lockQuote(quoteId);
    const quote = await this.tenant.db.quote.findFirst({
      where: { id: quoteId, ...scope },
      select: { id: true, status: true, code: true, customerEmail: true, customerLegalName: true },
    });
    if (!quote) throw new NotFoundException("Quote not found");
    if (quote.status !== QuoteStatus.DRAFT && quote.status !== QuoteStatus.SENT)
      throw new ConflictException("Only draft or sent quotes can be emailed");
    if (quote.status === QuoteStatus.DRAFT) await this.freezeQuoteSnapshot(quoteId);
    const [profile, company] = await Promise.all([
      this.profile(),
      this.tenant.db.company.findFirst({ where: { id: scope.companyId, organizationId: scope.organizationId }, select: { legalName: true } }),
    ]);
    return this.createDelivery({
      type: DeliveryDocumentType.QUOTE,
      quoteId,
      recipient: input.recipient ?? quote.customerEmail,
      subject: input.subject,
      defaultSubject: profile?.quoteEmailSubjectTemplate ?? "Presupuesto {{document_number}}",
      bodyTemplate: profile?.emailBodyTemplate ?? DEFAULT_BODY,
      parameters: parametersFor("el presupuesto", quote.code, quote.customerLegalName, company?.legalName ?? ""),
      idempotencyKey,
      auditAction: "quote.email_queued",
      auditEntity: "quote",
    });
  }

  async previewPaymentReminder(invoiceId: string, template: ReminderTemplate, recipient?: string, excludeDisputed = false) {
    const reminder = await this.paymentReminder(invoiceId, template, recipient, excludeDisputed);
    return {
      ...reminder,
      subject: reminder.eligible ? renderTemplate(reminder.definition.subject, reminder.parameters) : null,
      body: reminder.eligible ? renderTemplate(reminder.definition.body, reminder.parameters) : null,
      templateVersion: reminder.definition.version,
    };
  }

  async enqueuePaymentReminder(invoiceId: string, template: ReminderTemplate, idempotencyKey: string, recipient?: string, excludeDisputed = false) {
    if (!this.mailer.enabled) throw new ConflictException("Email delivery is not configured");
    const reminder = await this.paymentReminder(invoiceId, template, recipient, excludeDisputed);
    if (!reminder.eligible)
      throw new ConflictException(reminder.reason ?? "This invoice is not eligible for a payment reminder");
    return this.createDelivery({
      type: DeliveryDocumentType.INVOICE,
      purpose: DeliveryPurpose.PAYMENT_REMINDER,
      invoiceId,
      recipient: reminder.recipient,
      subject: renderTemplate(reminder.definition.subject, reminder.parameters),
      defaultSubject: reminder.definition.subject,
      bodyTemplate: reminder.definition.body,
      parameters: reminder.parameters,
      templateVersion: reminder.definition.version,
      idempotencyKey,
      auditAction: "invoice.payment_reminder_queued",
      auditEntity: "invoice",
    });
  }

  async list(invoiceId: string) {
    const scope = this.scope();
    const exists = await this.tenant.db.invoice.findFirst({ where: { id: invoiceId, ...scope }, select: { id: true } });
    if (!exists) throw new NotFoundException("Invoice not found");
    return this.tenant.db.documentDelivery.findMany({ where: { invoiceId, ...scope }, orderBy: [{ createdAt: "desc" }, { id: "desc" }] });
  }

  async listQuote(quoteId: string) {
    const scope = this.scope();
    const exists = await this.tenant.db.quote.findFirst({ where: { id: quoteId, ...scope }, select: { id: true } });
    if (!exists) throw new NotFoundException("Quote not found");
    return this.tenant.db.documentDelivery.findMany({ where: { quoteId, ...scope }, orderBy: [{ createdAt: "desc" }, { id: "desc" }] });
  }

  private async createDelivery(input: {
    type: DeliveryDocumentType; invoiceId?: string; quoteId?: string; recipient?: string | null;
    subject?: string; defaultSubject: string; bodyTemplate: string; parameters: Record<string, string>;
    idempotencyKey: string; auditAction: string; auditEntity: string; purpose?: DeliveryPurpose; templateVersion?: string;
  }) {
    const scope = this.scope();
    const invoiceId = input.invoiceId ?? null;
    const quoteId = input.quoteId ?? null;
    if (!input.recipient) throw new BadRequestException("recipient is required because the document has no customer email snapshot");
    const subject = input.subject?.trim() || renderTemplate(input.defaultSubject, input.parameters);
    const existing = await this.tenant.db.documentDelivery.findFirst({ where: { companyId: scope.companyId, idempotencyKey: input.idempotencyKey } });
    if (existing) {
      if (existing.invoiceId === invoiceId && existing.quoteId === quoteId && existing.recipient === input.recipient && existing.subject === subject) return existing;
      throw new ConflictException("Idempotency-Key has already been used for another email request");
    }
    const [inserted] = await this.tenant.db.$queryRaw<Array<{ id: string }>>`
      INSERT INTO "document_deliveries" (
        "id", "organization_id", "company_id", "document_type", "invoice_id", "quote_id",
        "idempotency_key", "recipient", "subject", "body_template", "template_parameters", "purpose", "template_version"
      ) VALUES (
        gen_random_uuid(), CAST(${scope.organizationId} AS uuid), CAST(${scope.companyId} AS uuid),
        CAST(${input.type} AS "DeliveryDocumentType"), CAST(${invoiceId} AS uuid), CAST(${quoteId} AS uuid),
        ${input.idempotencyKey}, ${input.recipient}, ${subject}, ${input.bodyTemplate},
        CAST(${JSON.stringify(input.parameters)} AS jsonb),
        CAST(${input.purpose ?? DeliveryPurpose.DOCUMENT_DELIVERY} AS "DeliveryPurpose"), ${input.templateVersion ?? "v1"}
      ) ON CONFLICT ("company_id", "idempotency_key") DO NOTHING
      RETURNING "id"
    `;
    const delivery = await this.tenant.db.documentDelivery.findFirstOrThrow({
      where: { companyId: scope.companyId, idempotencyKey: input.idempotencyKey },
    });
    if (delivery.invoiceId !== invoiceId || delivery.quoteId !== quoteId || delivery.recipient !== input.recipient || delivery.subject !== subject)
      throw new ConflictException("Idempotency-Key has already been used for another email request");
    if (inserted) {
      const documentId = input.invoiceId ?? input.quoteId!;
      await this.audit.record(input.auditAction, input.auditEntity, documentId, { deliveryId: delivery.id });
    }
    return delivery;
  }

  private async freezeQuoteSnapshot(quoteId: string) {
    const scope = this.scope();
    const company = await this.tenant.db.company.findFirst({
      where: { id: scope.companyId, organizationId: scope.organizationId }, include: { documentProfile: true, documentLogo: true },
    });
    if (!company) throw new NotFoundException("Company not found");
    await this.tenant.db.quote.updateMany({ where: { id: quoteId, ...scope, status: QuoteStatus.DRAFT }, data: captureIssuerSnapshot(company) });
  }

  private async lockQuote(quoteId: string) {
    const scope = this.scope();
    await this.tenant.db.$queryRaw`
      SELECT "id" FROM "quotes"
      WHERE "id" = CAST(${quoteId} AS uuid)
        AND "organization_id" = CAST(${scope.organizationId} AS uuid)
        AND "company_id" = CAST(${scope.companyId} AS uuid)
      FOR UPDATE
    `;
  }

  private profile() {
    return this.tenant.db.companyDocumentProfile.findFirst({ where: this.scope() });
  }

  private async paymentReminder(invoiceId: string, template: ReminderTemplate, recipient?: string, excludeDisputed = false) {
    const scope = this.scope();
    const [invoice, profile, company] = await Promise.all([
      this.tenant.db.invoice.findFirst({
        where: { id: invoiceId, ...scope },
        select: {
          id: true, status: true, fullNumber: true, customerEmail: true, customerLegalName: true, issuerLegalName: true, amountDue: true, dueDate: true, currency: true,
          commercialEvents: {
            where: { type: { in: [CommercialDocumentEventType.SENT, CommercialDocumentEventType.DELIVERY_FAILED, CommercialDocumentEventType.DISPUTED, CommercialDocumentEventType.PAYMENT_PROMISED] } },
            select: { type: true }, orderBy: [{ effectiveAt: "desc" }, { id: "desc" }], take: 1,
          },
        },
      }),
      this.profile(),
      this.tenant.db.company.findFirst({ where: { id: scope.companyId, organizationId: scope.organizationId }, select: { legalName: true } }),
    ]);
    if (!invoice) throw new NotFoundException("Invoice not found");
    const disputed = invoice.commercialEvents[0]?.type === CommercialDocumentEventType.DISPUTED;
    const reminderStatuses: InvoiceStatus[] = [InvoiceStatus.ISSUED, InvoiceStatus.SENT, InvoiceStatus.PARTIALLY_PAID, InvoiceStatus.OVERDUE];
    const reason = !invoice.fullNumber || !reminderStatuses.includes(invoice.status)
      ? "Solo pueden recordarse facturas emitidas"
      : invoice.amountDue.lessThanOrEqualTo(0)
        ? "La factura no tiene saldo pendiente"
        : excludeDisputed && disputed
          ? "La factura está en disputa y se excluye del envío masivo"
        : !(recipient?.trim() || invoice.customerEmail)
          ? "La factura no tiene un email de facturación"
          : null;
    const definition = reminderTemplates[template];
    const parameters = {
      ...parametersFor("la factura", invoice.fullNumber ?? "", invoice.customerLegalName, company?.legalName ?? invoice.issuerLegalName),
      amount_due: formatMoney(invoice.amountDue.toString(), invoice.currency),
      due_date: invoice.dueDate ? formatDate(invoice.dueDate) : "sin fecha de vencimiento",
      payment_instructions: profile?.paymentInstructions ?? "",
      bank_iban: profile?.bankIban ? `IBAN: ${profile.bankIban}` : "",
    };
    return {
      eligible: !reason,
      reason,
      invoice: { id: invoice.id, number: invoice.fullNumber, amountDue: invoice.amountDue.toFixed(2), currency: invoice.currency, dueDate: invoice.dueDate?.toISOString().slice(0, 10) ?? null, disputed },
      recipient: recipient?.trim() || invoice.customerEmail || null,
      definition,
      parameters,
    };
  }

  private scope() {
    const { organizationId, companyId } = this.tenant.required;
    if (!companyId) throw new BadRequestException("x-company-id is required");
    return { organizationId, companyId };
  }
}

function parametersFor(documentType: string, documentNumber: string, customerName: string, companyName: string) {
  return { document_type: documentType, document_number: documentNumber, customer_name: customerName, company_name: companyName };
}

export function renderTemplate(template: string, parameters: Record<string, string>) {
  return template.replace(/\{\{(document_type|document_number|customer_name|company_name|amount_due|due_date|payment_instructions|bank_iban)\}\}/g, (_, key: string) => parameters[key] ?? "").replace(/\n{3,}/g, "\n\n").trim();
}

function formatMoney(value: string, currency: string) { return new Intl.NumberFormat("es-ES", { style: "currency", currency }).format(Number(value)); }
function formatDate(value: Date) { return new Intl.DateTimeFormat("es-ES", { timeZone: "UTC" }).format(value); }
