import { Injectable, Logger, OnModuleDestroy, OnModuleInit } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { CommercialDocumentEventType, CommercialEventSource, DeliveryDocumentType, InvoiceEmailStatus, InvoiceStatus, Prisma, PrismaClient, QuoteStatus, SifMode } from "@prisma/client";
import { PrismaService } from "../prisma.service";
import { QuotePdfService } from "../quotes/quote-pdf.service";
import { InvoicePdfService } from "./invoice-pdf.service";
import { renderTemplate } from "./invoice-email.service";
import { SmtpInvoiceMailer } from "./smtp-invoice-mailer.service";

interface Candidate { organizationId: string }

@Injectable()
export class InvoiceEmailOutboxWorker implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(InvoiceEmailOutboxWorker.name);
  private readonly admin: PrismaClient | undefined;
  private timer: NodeJS.Timeout | undefined;
  private running = false;

  constructor(
    config: ConfigService,
    private readonly prisma: PrismaService,
    private readonly invoicePdf: InvoicePdfService,
    private readonly quotePdf: QuotePdfService,
    private readonly mailer: SmtpInvoiceMailer,
  ) {
    const directUrl = config.get<string>("DIRECT_DATABASE_URL");
    if (mailer.enabled && directUrl) this.admin = new PrismaClient({ datasources: { db: { url: directUrl } } });
  }

  onModuleInit() {
    if (!this.admin) return;
    this.timer = setInterval(() => void this.tick(), 5_000);
    this.timer.unref();
    void this.tick();
  }

  async onModuleDestroy() {
    if (this.timer) clearInterval(this.timer);
    await this.admin?.$disconnect();
  }

  async processBatch(limit = 20) {
    if (!this.admin || !this.mailer.enabled) return 0;
    await this.admin.$executeRaw`
      UPDATE "document_deliveries" SET "status" = 'FAILED', "locked_at" = NULL,
        "last_error" = 'Delivery worker lease expired after maximum attempts', "updated_at" = CURRENT_TIMESTAMP
      WHERE "status" = 'PROCESSING' AND "attempts" >= 5
        AND "locked_at" < CURRENT_TIMESTAMP - INTERVAL '15 minutes'
    `;
    const candidates = await this.admin.$queryRaw<Candidate[]>`
      SELECT DISTINCT "organization_id" AS "organizationId" FROM "document_deliveries"
      WHERE "attempts" < 5 AND (("status" = 'PENDING' AND "available_at" <= CURRENT_TIMESTAMP)
        OR ("status" = 'PROCESSING' AND "locked_at" < CURRENT_TIMESTAMP - INTERVAL '15 minutes'))
      LIMIT ${limit}
    `;
    let processed = 0;
    for (const candidate of candidates) {
      const id = await this.claim(candidate.organizationId);
      if (id) { await this.deliver(candidate.organizationId, id); processed += 1; }
    }
    return processed;
  }

  private async tick() {
    if (this.running) return;
    this.running = true;
    try { await this.processBatch(); }
    catch (error) { this.logger.error("Document email outbox batch failed", error); }
    finally { this.running = false; }
  }

  private async claim(organizationId: string) {
    return this.prisma.$transaction(async (db) => {
      await db.$queryRaw`SELECT set_config('app.organization_id', ${organizationId}, true)`;
      const [claimed] = await db.$queryRaw<Array<{ id: string }>>`
        UPDATE "document_deliveries" SET "status" = 'PROCESSING', "attempts" = "attempts" + 1,
          "locked_at" = CURRENT_TIMESTAMP, "updated_at" = CURRENT_TIMESTAMP
        WHERE "id" = (
          SELECT "id" FROM "document_deliveries" WHERE "attempts" < 5
            AND (("status" = 'PENDING' AND "available_at" <= CURRENT_TIMESTAMP)
              OR ("status" = 'PROCESSING' AND "locked_at" < CURRENT_TIMESTAMP - INTERVAL '15 minutes'))
          ORDER BY "available_at", "created_at" FOR UPDATE SKIP LOCKED LIMIT 1
        ) RETURNING "id"
      `;
      return claimed?.id ?? null;
    });
  }

  private async deliver(organizationId: string, deliveryId: string) {
    try {
      const delivery = await this.prisma.$transaction(async (db) => {
        await db.$queryRaw`SELECT set_config('app.organization_id', ${organizationId}, true)`;
        return db.documentDelivery.findUniqueOrThrow({
          where: { id: deliveryId },
          include: {
            invoice: { include: { lines: { orderBy: { position: "asc" } }, originalInvoice: { select: { id: true, fullNumber: true } } } },
            quote: { include: { lines: { orderBy: { position: "asc" } } } },
          },
        });
      });
      const parameters = jsonStrings(delivery.templateParameters);
      const text = renderTemplate(delivery.bodyTemplate ?? "{{company_name}} adjunta {{document_type}} {{document_number}}.", parameters);
      if (delivery.documentType === DeliveryDocumentType.INVOICE) {
        const invoice = delivery.invoice;
        if (!invoice?.fullNumber) throw new Error("Queued invoice does not have an issued number");
        if (invoice.status === InvoiceStatus.CANCELLED)
          throw new Error("Invoice was cancelled before delivery");
        const pdf = await this.invoicePdf.render({
          ...invoice,
          fullNumber: invoice.fullNumber,
          sifQr:
            invoice.sifMode !== SifMode.DISABLED
              ? { mode: invoice.sifMode, environment: invoice.aeatEnvironment }
              : undefined,
        });
        const result = await this.mailer.send({ recipient: delivery.recipient, subject: delivery.subject, text, documentNumber: invoice.fullNumber, documentLabel: "la factura", issuerLegalName: invoice.issuerLegalName, filename: `factura-${safeFilename(invoice.fullNumber)}.pdf`, pdf });
        await this.succeed(organizationId, deliveryId, result, { invoiceId: invoice.id, purpose: delivery.purpose });
      } else {
        const quote = delivery.quote;
        if (!quote) throw new Error("Queued quote no longer exists");
        const pdf = await this.quotePdf.render({ quote, issuerLogoMediaType: quote.issuerLogoMediaType, issuerLogoContent: quote.issuerLogoContent });
        const result = await this.mailer.send({ recipient: delivery.recipient, subject: delivery.subject, text, documentNumber: quote.code, documentLabel: "el presupuesto", issuerLegalName: parameters.company_name ?? "", filename: `presupuesto-${safeFilename(quote.code)}.pdf`, pdf });
        await this.succeed(organizationId, deliveryId, result, { quoteId: quote.id, purpose: delivery.purpose });
      }
    } catch (error) { await this.fail(organizationId, deliveryId, error); }
  }

  private async succeed(organizationId: string, deliveryId: string, result: { provider: string; messageId?: string }, document: { invoiceId?: string; quoteId?: string; purpose: string }) {
    const { purpose, ...documentReference } = document;
    await this.prisma.$transaction(async (db) => {
      await db.$queryRaw`SELECT set_config('app.organization_id', ${organizationId}, true)`;
      await db.documentDelivery.update({ where: { id: deliveryId }, data: { status: InvoiceEmailStatus.SENT, sentAt: new Date(), lockedAt: null, lastError: null, provider: result.provider, providerMessageId: result.messageId ?? null } });
      await db.commercialDocumentEvent.create({
        data: {
          organizationId,
          companyId: document.invoiceId
            ? (await db.invoice.findUniqueOrThrow({ where: { id: document.invoiceId }, select: { companyId: true } })).companyId
            : (await db.quote.findUniqueOrThrow({ where: { id: document.quoteId! }, select: { companyId: true } })).companyId,
          ...documentReference,
          type: CommercialDocumentEventType.SENT,
          source: CommercialEventSource.EMAIL,
          externalId: `delivery:${deliveryId}:sent`,
          effectiveAt: new Date(),
          payload: { schemaVersion: 1, deliveryId, purpose, provider: result.provider, providerMessageId: result.messageId ?? null },
        },
      });
      if (document.invoiceId) await db.invoice.updateMany({ where: { id: document.invoiceId, status: InvoiceStatus.ISSUED }, data: { status: InvoiceStatus.SENT } });
      if (document.quoteId) await db.quote.updateMany({ where: { id: document.quoteId, status: QuoteStatus.DRAFT }, data: { status: QuoteStatus.SENT } });
    });
  }

  private async fail(organizationId: string, deliveryId: string, error: unknown) {
    await this.prisma.$transaction(async (db) => {
      await db.$queryRaw`SELECT set_config('app.organization_id', ${organizationId}, true)`;
      const delivery = await db.documentDelivery.findUnique({ where: { id: deliveryId }, select: { attempts: true, companyId: true, invoiceId: true, quoteId: true, purpose: true } });
      if (!delivery) return;
      await db.documentDelivery.update({ where: { id: deliveryId }, data: { status: delivery.attempts >= 5 ? InvoiceEmailStatus.FAILED : InvoiceEmailStatus.PENDING, availableAt: new Date(Date.now() + retryDelay(delivery.attempts)), lockedAt: null, lastError: errorMessage(error) } });
      if (delivery.attempts >= 5) await db.commercialDocumentEvent.create({
        data: {
          organizationId, companyId: delivery.companyId, invoiceId: delivery.invoiceId, quoteId: delivery.quoteId,
          type: CommercialDocumentEventType.DELIVERY_FAILED, source: CommercialEventSource.EMAIL,
          externalId: `delivery:${deliveryId}:failed`, effectiveAt: new Date(),
          payload: { schemaVersion: 1, deliveryId, purpose: delivery.purpose, reason: errorMessage(error) },
        },
      });
    });
  }
}

function jsonStrings(value: Prisma.JsonValue): Record<string, string> {
  if (!value || Array.isArray(value) || typeof value !== "object") return {};
  return Object.fromEntries(Object.entries(value).filter((entry): entry is [string, string] => typeof entry[1] === "string"));
}
function retryDelay(attempts: number) { return Math.min(60 * 60_000, 30_000 * 2 ** Math.max(0, attempts - 1)); }
function errorMessage(error: unknown) { return (error instanceof Error ? error.message : "Unknown delivery error").replace(/[\r\n]+/g, " ").slice(0, 1000); }
function safeFilename(value: string) { return value.replace(/[^a-zA-Z0-9._-]+/g, "-"); }
