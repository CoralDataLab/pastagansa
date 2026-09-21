import { BadRequestException, Injectable } from "@nestjs/common";
import { DocumentType, InvoiceStatus, Prisma } from "@prisma/client";
import { Decimal } from "@prisma/client/runtime/library";
import { AuditService } from "../audit/audit.service";
import { decodeCursor, encodeCursor } from "../common/cursor";
import { TenantContextService } from "../tenancy/tenant-context.service";
import { CollectionBucket, CollectionsQueryDto } from "./dto/collections-query.dto";
import { installmentOpenAmount } from "../payments/receivable-credit";

const payableStatuses = [InvoiceStatus.ISSUED, InvoiceStatus.SENT, InvoiceStatus.PARTIALLY_PAID, InvoiceStatus.OVERDUE];
const buckets: CollectionBucket[] = ["DUE_THIS_WEEK", "OVERDUE_1_7", "OVERDUE_8_30", "OVERDUE_31_60", "OVERDUE_61_90", "OVERDUE_90_PLUS"];

@Injectable()
export class CollectionsService {
  constructor(private readonly tenant: TenantContextService, private readonly audit: AuditService) {}

  async summary(query: Pick<CollectionsQueryDto, "asOf" | "contactId" | "text" | "status">) {
    const asOf = await this.asOf(query.asOf);
    const summary = emptySummary();
    const operational = { open: new Decimal(0), promised: new Decimal(0), disputed: new Decimal(0) };
    const byCustomer = new Map<string, { contactId: string; customer: string; amount: Decimal; count: number }>();
    const forecast = { days30: new Decimal(0), days60: new Decimal(0), days90: new Decimal(0) };
    for await (const row of this.scan({ ...query, asOf })) {
      if (!matches(row, query)) continue;
      summary.total = summary.total.plus(row.amountDue);
      summary.count += 1;
      if (row.bucket) summary[row.bucket] = summary[row.bucket].plus(row.amountDue);
      if (row.operationalStatus === "DISPUTED") operational.disputed = operational.disputed.plus(row.amountDue);
      else if (row.operationalStatus === "PROMISED") operational.promised = operational.promised.plus(row.amountDue);
      else operational.open = operational.open.plus(row.amountDue);
      const customer = byCustomer.get(row.contactId) ?? { contactId: row.contactId, customer: row.customerLegalName, amount: new Decimal(0), count: 0 };
      customer.amount = customer.amount.plus(row.amountDue); customer.count += 1; byCustomer.set(row.contactId, customer);
      for (const installment of row.openInstallments) {
        const days = daysBetween(asOf, isoDate(installment.dueDate));
        if (days >= 0 && days <= 30) forecast.days30 = forecast.days30.plus(installment.open);
        if (days >= 0 && days <= 60) forecast.days60 = forecast.days60.plus(installment.open);
        if (days >= 0 && days <= 90) forecast.days90 = forecast.days90.plus(installment.open);
      }
    }
    return {
      asOf,
      currency: "EUR",
      total: summary.total.toFixed(2), count: summary.count,
      buckets: Object.fromEntries(buckets.map((bucket) => [bucket, summary[bucket].toFixed(2)])),
      operational: Object.fromEntries(Object.entries(operational).map(([key, value]) => [key, value.toFixed(2)])),
      forecast: Object.fromEntries(Object.entries(forecast).map(([key, value]) => [key, value.toFixed(2)])),
      customers: [...byCustomer.values()].sort((a, b) => b.amount.comparedTo(a.amount)).map((item) => ({ ...item, amount: item.amount.toFixed(2) })),
    };
  }

  async invoices(query: CollectionsQueryDto) {
    const asOf = await this.asOf(query.asOf);
    const cursor = query.cursor ? decodeCursor(query.cursor, this.cursorQuery(query, asOf)) : undefined;
    const filtered: CollectionRow[] = [];
    for await (const row of this.scan({ ...query, asOf }, cursor?.id)) {
      if (!matches(row, query)) continue;
      filtered.push(row);
      if (filtered.length > query.limit) break;
    }
    const hasMore = filtered.length > query.limit;
    const data = hasMore ? filtered.slice(0, query.limit) : filtered;
    const last = data.at(-1);
    return {
      asOf,
      data: data.map(presentRow),
      nextCursor: hasMore && last ? encodeCursor(last.id, last.dueDate ?? "", this.cursorQuery(query, asOf)) : null,
    };
  }

  async csv(query: CollectionsQueryDto) {
    const asOf = await this.asOf(query.asOf);
    const csvRows = [["Cliente", "Factura", "Vencimiento", "Días vencida", "Saldo", "Tramo", "Estado operativo", "Último evento", "Próxima acción"]];
    let count = 0;
    for await (const row of this.scan({ ...query, asOf })) {
      if (!matches(row, query)) continue;
      count += 1;
      csvRows.push([row.customerLegalName, row.fullNumber ?? row.draftCode, row.dueDate ?? "", row.daysOverdue > 0 ? String(row.daysOverdue) : "0", row.amountDue.toFixed(2), row.bucket ?? "", row.operationalStatus, row.lastEvent?.type ?? "", row.nextAction ?? ""]);
    }
    await this.audit.record("collections.exported", "collections", undefined, { asOf, count, filters: { contactId: query.contactId ?? null, bucket: query.bucket ?? null, status: query.status ?? null, text: query.text ?? null } });
    const content = renderCsv(csvRows);
    return { filename: `cartera-${asOf}.csv`, content: Buffer.from(content, "utf8") };
  }

  private async *scan(input: Pick<CollectionsQueryDto, "contactId" | "text" | "bucket" | "status"> & { asOf: string }, cursorId?: string): AsyncGenerator<CollectionRow> {
    let nextCursor = cursorId;
    while (true) {
      const batch = await this.rows({ ...input, limit: 500, cursorId: nextCursor });
      for (const row of batch) yield row;
      if (batch.length < 500) return;
      nextCursor = batch[batch.length - 1].id;
    }
  }

  private async rows(input: Pick<CollectionsQueryDto, "contactId" | "text"> & { asOf: string; limit: number; cursorId?: string }) {
    const scope = this.scope();
    const where: Prisma.InvoiceWhereInput = {
      ...scope, documentType: DocumentType.INVOICE, amountDue: { gt: 0 }, status: { in: payableStatuses },
      ...(input.contactId ? { contactId: input.contactId } : {}),
      ...(input.text ? { OR: [{ customerLegalName: { contains: input.text.trim(), mode: "insensitive" } }, { fullNumber: { contains: input.text.trim(), mode: "insensitive" } }] } : {}),
    };
    const invoices = await this.tenant.db.invoice.findMany({
      where,
      select: {
        id: true, contactId: true, customerLegalName: true, fullNumber: true, draftCode: true, currency: true, amountDue: true, dueDate: true,
        installments: { select: { dueDate: true, amount: true, paidAmount: true, creditedAmount: true }, orderBy: [{ dueDate: "asc" }, { position: "asc" }] },
        commercialEvents: { where: { type: { in: ["SENT", "DELIVERY_FAILED", "DISPUTED", "PAYMENT_PROMISED"] } }, select: { type: true, source: true, effectiveAt: true, comment: true }, orderBy: [{ effectiveAt: "desc" }, { id: "desc" }], take: 1 },
      },
      orderBy: [{ dueDate: "asc" }, { id: "asc" }],
      ...(input.cursorId ? { cursor: { id: input.cursorId }, skip: 1 } : {}), take: input.limit,
    });
    return invoices.map((invoice) => {
      const openInstallments = invoice.installments.map((installment) => ({ dueDate: installment.dueDate, open: installmentOpenAmount(installment) })).filter((installment) => installment.open.greaterThan(0));
      const dueDate = openInstallments[0]?.dueDate ? isoDate(openInstallments[0].dueDate) : invoice.dueDate ? isoDate(invoice.dueDate) : null;
      const daysOverdue = dueDate ? Math.max(0, daysBetween(dueDate, input.asOf)) : 0;
      const bucket = classifyBucket(dueDate, input.asOf);
      const lastEvent = invoice.commercialEvents[0] ?? null;
      const operationalStatus = lastEvent?.type === "DISPUTED" ? "DISPUTED" : lastEvent?.type === "PAYMENT_PROMISED" ? "PROMISED" : "OPEN";
      return { ...invoice, dueDate, daysOverdue, bucket, operationalStatus, lastEvent, nextAction: nextAction(lastEvent, dueDate, input.asOf), openInstallments };
    });
  }

  private async asOf(value?: string) {
    if (value) return value;
    const { companyId, organizationId } = this.scope();
    const company = await this.tenant.db.company.findFirstOrThrow({ where: { id: companyId, organizationId }, select: { timezone: true } });
    return new Intl.DateTimeFormat("en-CA", { timeZone: company.timezone, year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date());
  }
  private cursorQuery(query: CollectionsQueryDto, asOf: string) { return JSON.stringify({ asOf, contactId: query.contactId ?? null, bucket: query.bucket ?? null, status: query.status ?? null, text: query.text?.trim().toLowerCase() ?? null }); }
  private scope() { const { organizationId, companyId } = this.tenant.required; if (!companyId) throw new BadRequestException("x-company-id is required"); return { organizationId, companyId }; }
}

function emptySummary() { return { total: new Decimal(0), count: 0, DUE_THIS_WEEK: new Decimal(0), OVERDUE_1_7: new Decimal(0), OVERDUE_8_30: new Decimal(0), OVERDUE_31_60: new Decimal(0), OVERDUE_61_90: new Decimal(0), OVERDUE_90_PLUS: new Decimal(0) }; }
type CollectionRow = Awaited<ReturnType<CollectionsService["rows"]>>[number];
function matches(row: CollectionRow, query: Pick<CollectionsQueryDto, "bucket" | "status">) { return (!query.bucket || row.bucket === query.bucket) && (!query.status || row.operationalStatus === query.status); }
function isoDate(value: Date) { return value.toISOString().slice(0, 10); }
export function daysBetween(start: string, end: string) { return Math.round((Date.parse(`${end}T12:00:00Z`) - Date.parse(`${start}T12:00:00Z`)) / 86_400_000); }
export function classifyBucket(dueDate: string | null, asOf: string): CollectionBucket | null { if (!dueDate) return null; const days = daysBetween(dueDate, asOf); if (days < -7) return null; if (days <= 0) return "DUE_THIS_WEEK"; if (days <= 7) return "OVERDUE_1_7"; if (days <= 30) return "OVERDUE_8_30"; if (days <= 60) return "OVERDUE_31_60"; if (days <= 90) return "OVERDUE_61_90"; return "OVERDUE_90_PLUS"; }
function nextAction(event: { type: string; effectiveAt: Date; comment: string | null } | null, dueDate: string | null, asOf: string) { if (event?.type === "DISPUTED") return "Revisar disputa"; if (event?.type === "PAYMENT_PROMISED") return `Confirmar promesa (${isoDate(event.effectiveAt)})`; if (dueDate && dueDate < asOf) return "Preparar recordatorio"; return dueDate ? `Esperar vencimiento (${dueDate})` : null; }
function presentRow(row: Awaited<ReturnType<CollectionsService["rows"]>>[number]) { const { openInstallments: _openInstallments, amountDue, ...visible } = row; return { ...visible, amountDue: amountDue.toFixed(2) }; }
function renderCsv(rows: string[][]) { return `\uFEFF${rows.map((row) => row.map((value) => csvCell(value)).join(";")).join("\r\n")}\r\n`; }
function csvCell(value: string) { const safe = /^[=+\-@]/.test(value) ? `'${value}` : value; return /[;"\r\n]/.test(safe) ? `"${safe.replaceAll('"', '""')}"` : safe; }
