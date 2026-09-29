import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
} from "@nestjs/common";
import {
  DocumentType,
  InvoiceStatus,
  Prisma,
  PurchaseInvoiceStatus,
  RectificationImpact,
  TaxBookType,
  TaxLedgerAmount,
  TaxLedgerDirection,
  TaxLedgerEntry,
  TaxRule,
} from "@prisma/client";
import { Decimal } from "@prisma/client/runtime/library";
import { AuditService } from "../audit/audit.service";
import { decodeCursor, encodeCursor } from "../common/cursor";
import { TenantContextService } from "../tenancy/tenant-context.service";
import { ListTaxLedgerDto } from "./dto/list-tax-ledger.dto";
import { ListTaxRulesDto } from "./dto/list-tax-rules.dto";

@Injectable()
export class TaxService {
  constructor(
    private readonly tenant: TenantContextService,
    private readonly audit: AuditService,
  ) {}

  async listRules(query: ListTaxRulesDto) {
    const effectiveOn = new Date(query.effectiveOn);
    return this.tenant.db.taxRule.findMany({
      where: {
        jurisdiction: query.jurisdiction.toUpperCase(),
        effectiveFrom: { lte: effectiveOn },
        OR: [{ effectiveTo: null }, { effectiveTo: { gte: effectiveOn } }],
      },
      orderBy: [{ taxFamily: "asc" }, { rate: "desc" }, { code: "asc" }],
    });
  }

  async resolveRules(lines: TaxRuleInput[], effectiveOnValue: string) {
    const effectiveOn = new Date(effectiveOnValue);
    const ids = [
      ...new Set(
        lines.flatMap(({ taxRuleId }) => (taxRuleId ? [taxRuleId] : [])),
      ),
    ];
    const rules = await this.tenant.db.taxRule.findMany({
      where: {
        effectiveFrom: { lte: effectiveOn },
        OR: [{ effectiveTo: null }, { effectiveTo: { gte: effectiveOn } }],
        ...(ids.length ? { id: { in: ids } } : {}),
      },
    });
    const byId = new Map(rules.map((rule) => [rule.id, rule]));
    const rateCodes = new Map([
      [21, "ES_VAT_GENERAL_21"],
      [10, "ES_VAT_REDUCED_10"],
      [4, "ES_VAT_SUPER_REDUCED_4"],
    ]);
    const missingCodes = [
      ...new Set(
        lines.flatMap((line) => {
          if (line.taxRuleId || line.taxRate === undefined) return [];
          const code = rateCodes.get(line.taxRate);
          return code ? [code] : [];
        }),
      ),
    ];
    const fallbackRules = missingCodes.length
      ? await this.tenant.db.taxRule.findMany({
          where: {
            code: { in: missingCodes },
            effectiveFrom: { lte: effectiveOn },
            OR: [{ effectiveTo: null }, { effectiveTo: { gte: effectiveOn } }],
          },
        })
      : [];
    const byCode = new Map(fallbackRules.map((rule) => [rule.code, rule]));
    return lines.map((line) => {
      const rule = line.taxRuleId
        ? byId.get(line.taxRuleId)
        : byCode.get(rateCodes.get(line.taxRate ?? -1) ?? "");
      if (!rule)
        throw new BadRequestException(
          line.taxRate === 0
            ? "taxRuleId is required for zero-rated, exempt, or non-subject lines"
            : "An effective taxRuleId or a supported 21, 10, or 4 taxRate is required for every line",
        );
      this.validateRuleSelection(rule, line);
      return rule;
    });
  }

  async listLedger(query: ListTaxLedgerDto) {
    if (query.from && query.to && query.from > query.to)
      throw new BadRequestException("from cannot be after to");
    const filter = JSON.stringify({
      invoiceId: query.invoiceId ?? null,
      purchaseInvoiceId: query.purchaseInvoiceId ?? null,
      direction: query.direction ?? null,
      bookType: query.bookType ?? null,
      from: query.from ?? null,
      to: query.to ?? null,
    });
    const cursor = query.cursor
      ? decodeCursor(query.cursor, filter)
      : undefined;
    const scope = this.scope();
    if (cursor) {
      const exists = await this.tenant.db.taxLedgerEntry.findFirst({
        where: {
          id: cursor.id,
          taxPointDate: new Date(cursor.sort),
          ...scope,
          ...this.ledgerFilters(query),
        },
        select: { id: true },
      });
      if (!exists)
        throw new BadRequestException(
          "Cursor is stale or does not belong to the selected company",
        );
    }
    const entries = await this.tenant.db.taxLedgerEntry.findMany({
      where: { ...scope, ...this.ledgerFilters(query) },
      include: { amounts: { orderBy: { createdAt: "asc" } } },
      orderBy: [{ taxPointDate: "desc" }, { id: "desc" }],
      ...(cursor ? { cursor: { id: cursor.id }, skip: 1 } : {}),
      take: query.limit + 1,
    });
    const hasMore = entries.length > query.limit;
    const data = hasMore ? entries.slice(0, -1) : entries;
    const last = data.at(-1);
    return {
      data,
      nextCursor:
        hasMore && last
          ? encodeCursor(last.id, last.taxPointDate.toISOString(), filter)
          : null,
    };
  }

  async getLedgerEntry(id: string) {
    const entry = await this.tenant.db.taxLedgerEntry.findFirst({
      where: { id, ...this.scope() },
      include: {
        amounts: { orderBy: { createdAt: "asc" } },
        correctionOf: { select: { id: true, documentNumber: true } },
      },
    });
    if (!entry) throw new NotFoundException("Tax ledger entry not found");
    return entry;
  }

  async postInvoice(
    invoiceId: string,
  ): Promise<TaxLedgerEntry & { amounts: TaxLedgerAmount[] }> {
    const scope = this.scope();
    const existing = await this.tenant.db.taxLedgerEntry.findFirst({
      where: { invoiceId, ...scope },
      include: { amounts: true },
    });
    if (existing) return existing;
    const invoice = await this.tenant.db.invoice.findFirst({
      where: { id: invoiceId, ...scope },
      include: {
        lines: { include: { taxLines: true } },
        originalInvoice: {
          select: { id: true, taxLedgerEntry: { select: { id: true } } },
        },
      },
    });
    if (
      !invoice ||
      invoice.status === InvoiceStatus.DRAFT ||
      !invoice.fullNumber
    )
      throw new ConflictException("Only issued invoices can enter Tax Ledger");
    if (
      invoice.lines.length === 0 ||
      invoice.lines.some((line) => line.taxLines.length !== 1)
    )
      throw new ConflictException(
        "Every invoice line must have exactly one fiscal breakdown",
      );
    let correctionOfId = invoice.originalInvoice?.taxLedgerEntry?.id ?? null;
    if (invoice.originalInvoice && !correctionOfId) {
      correctionOfId = (await this.postInvoice(invoice.originalInvoice.id)).id;
    }
    const sign =
      invoice.documentType === DocumentType.CREDIT_NOTE &&
      invoice.rectificationImpact === RectificationImpact.DECREASE
        ? new Decimal(-1)
        : new Decimal(1);
    const taxLines = invoice.lines.map((line) => line.taxLines[0]);
    const entry = await this.tenant.db.taxLedgerEntry.create({
      data: {
        ...scope,
        invoiceId: invoice.id,
        direction: TaxLedgerDirection.SALES,
        bookType: TaxBookType.ISSUED_INVOICES,
        issueDate: invoice.issueDate,
        operationDate: invoice.operationDate ?? invoice.issueDate,
        taxPointDate: invoice.issueDate,
        counterpartyId: invoice.contactId,
        counterpartyTaxId: invoice.customerTaxId,
        counterpartyCountry: countryFrom(invoice.billingAddress),
        documentNumber: invoice.fullNumber,
        correctionOfId,
        rectificationImpact: invoice.rectificationImpact,
      },
    });
    await this.tenant.db.taxLedgerAmount.createMany({
      data: taxLines.map((line) => ({
        ...scope,
        taxLedgerEntryId: entry.id,
        invoiceTaxLineId: line.id,
        taxRuleId: line.taxRuleId,
        taxableBase: line.taxableBase.mul(sign),
        rate: line.taxRate,
        taxAmount: line.taxAmount.mul(sign),
        surchargeRate: line.surchargeRate,
        surchargeAmount: line.surchargeAmount.mul(sign),
      })),
    });
    await this.audit.record("tax_ledger.posted", "tax_ledger", entry.id, {
      invoiceId: invoice.id,
      documentNumber: invoice.fullNumber,
      correctionOfId,
    });
    return this.tenant.db.taxLedgerEntry.findUniqueOrThrow({
      where: { id: entry.id },
      include: { amounts: true },
    });
  }

  async cancelInvoice(invoiceId: string, cancellationDate: Date) {
    const scope = this.scope();
    const original = await this.tenant.db.taxLedgerEntry.findFirst({
      where: { invoiceId, ...scope },
      include: { amounts: true, cancelledBy: true },
    });
    if (!original)
      throw new ConflictException("Original invoice tax posting is missing");
    if (original.cancelledBy) return original.cancelledBy;
    if (original.correctionOfId)
      throw new ConflictException(
        "Rectifying entries cannot be cancelled as an ordinary invoice",
      );
    const entry = await this.tenant.db.taxLedgerEntry.create({
      data: {
        ...scope,
        cancellationOfId: original.id,
        direction: original.direction,
        bookType: original.bookType,
        issueDate: cancellationDate,
        operationDate: original.operationDate,
        taxPointDate: cancellationDate,
        counterpartyId: original.counterpartyId,
        counterpartyTaxId: original.counterpartyTaxId,
        counterpartyCountry: original.counterpartyCountry,
        documentNumber: original.documentNumber,
      },
    });
    await this.tenant.db.taxLedgerAmount.createMany({
      data: original.amounts.map((amount) => ({
        ...scope,
        taxLedgerEntryId: entry.id,
        invoiceTaxLineId: amount.invoiceTaxLineId,
        taxRuleId: amount.taxRuleId,
        taxableBase: amount.taxableBase.negated(),
        rate: amount.rate,
        taxAmount: amount.taxAmount.negated(),
        surchargeRate: amount.surchargeRate,
        surchargeAmount: amount.surchargeAmount.negated(),
      })),
    });
    await this.audit.record(
      "tax_ledger.invoice_cancelled",
      "tax_ledger",
      entry.id,
      {
        invoiceId,
        cancellationOfId: original.id,
      },
    );
    return entry;
  }

  async postPurchaseInvoice(purchaseInvoiceId: string) {
    const scope = this.scope();
    const existing = await this.tenant.db.taxLedgerEntry.findFirst({
      where: { purchaseInvoiceId, ...scope },
      include: { amounts: true },
    });
    if (existing) return existing;
    const purchase = await this.tenant.db.purchaseInvoice.findFirst({
      where: { id: purchaseInvoiceId, ...scope },
      include: { lines: { include: { taxLines: true } } },
    });
    if (
      !purchase ||
      purchase.status !== PurchaseInvoiceStatus.APPROVED ||
      !purchase.receptionFullNumber
    )
      throw new ConflictException(
        "Only approved purchase invoices can enter Tax Ledger",
      );
    if (
      purchase.lines.length === 0 ||
      purchase.lines.some((line) => line.taxLines.length !== 1)
    )
      throw new ConflictException(
        "Every purchase invoice line must have exactly one fiscal breakdown",
      );
    // Suplidos son pagos por cuenta del cliente, no base de IVA soportado.
    const taxLines = purchase.lines.filter((line) => !line.isDisbursement).map((line) => line.taxLines[0]);
    const entry = await this.tenant.db.taxLedgerEntry.create({
      data: {
        ...scope,
        purchaseInvoiceId: purchase.id,
        direction: TaxLedgerDirection.PURCHASES,
        bookType: TaxBookType.RECEIVED_INVOICES,
        issueDate: purchase.issueDate,
        operationDate: purchase.operationDate,
        taxPointDate: purchase.deductionDate,
        receivedDate: purchase.receivedDate,
        counterpartyId: purchase.supplierId,
        counterpartyTaxId: purchase.supplierTaxId,
        counterpartyCountry: purchase.supplierTaxCountry,
        documentNumber: purchase.supplierInvoiceNumber,
        registrationNumber: purchase.receptionFullNumber,
      },
    });
    await this.tenant.db.taxLedgerAmount.createMany({
      data: taxLines.map((line) => ({
        ...scope,
        taxLedgerEntryId: entry.id,
        purchaseTaxLineId: line.id,
        taxRuleId: line.taxRuleId,
        taxableBase: line.taxableBase,
        rate: line.taxRate,
        taxAmount: line.taxAmount,
        surchargeAmount: new Decimal(0),
        deductibleAmount: line.deductibleAmount,
      })),
    });
    await this.audit.record("tax_ledger.posted", "tax_ledger", entry.id, {
      purchaseInvoiceId: purchase.id,
      supplierInvoiceNumber: purchase.supplierInvoiceNumber,
      deductibleTaxTotal: purchase.deductibleTaxTotal.toString(),
    });
    return this.tenant.db.taxLedgerEntry.findUniqueOrThrow({
      where: { id: entry.id },
      include: { amounts: true },
    });
  }

  private ledgerFilters(query: ListTaxLedgerDto) {
    return {
      ...(query.invoiceId
        ? {
            OR: [
              { invoiceId: query.invoiceId },
              { cancellationOf: { invoiceId: query.invoiceId } },
            ],
          }
        : {}),
      ...(query.purchaseInvoiceId
        ? { purchaseInvoiceId: query.purchaseInvoiceId }
        : {}),
      ...(query.direction ? { direction: query.direction } : {}),
      ...(query.bookType ? { bookType: query.bookType } : {}),
      ...(query.from || query.to
        ? {
            taxPointDate: {
              ...(query.from ? { gte: new Date(query.from) } : {}),
              ...(query.to ? { lte: new Date(query.to) } : {}),
            },
          }
        : {}),
    };
  }

  private scope() {
    const { organizationId, companyId } = this.tenant.required;
    if (!companyId) throw new BadRequestException("x-company-id is required");
    return { organizationId, companyId };
  }

  private validateRuleSelection(rule: TaxRule, line: TaxRuleInput) {
    if (
      line.taxRate !== undefined &&
      !new Decimal(line.taxRate).equals(rule.rate ?? 0)
    )
      throw new BadRequestException(
        "taxRate does not match the selected tax rule",
      );
    if (rule.exempt && !line.exemptionReason?.trim())
      throw new BadRequestException(
        "exemptionReason is required for exempt lines",
      );
    if (!rule.exempt && line.exemptionReason)
      throw new BadRequestException(
        "exemptionReason is only valid for exempt lines",
      );
    if (rule.surchargeRate?.greaterThan(0))
      throw new BadRequestException(
        "Equivalence surcharge rules are not supported in this fiscal slice",
      );
  }
}

export interface TaxRuleInput {
  taxRuleId?: string;
  taxRate?: number;
  exemptionReason?: string;
}

function countryFrom(value: Prisma.JsonValue | null) {
  if (value && typeof value === "object" && !Array.isArray(value)) {
    const country = value.country;
    if (typeof country === "string" && /^[A-Za-z]{2}$/.test(country))
      return country.toUpperCase();
  }
  return "ES";
}
