import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
} from "@nestjs/common";
import {
  AccountingRole,
  BankTransactionStatus,
  JournalEntryStatus,
  Prisma,
} from "@prisma/client";
import { Decimal } from "@prisma/client/runtime/library";
import { AuditService } from "../audit/audit.service";
import { decodeCursor, encodeCursor } from "../common/cursor";
import { isValidIban, normalizeIban } from "../common/iban";
import { TenantContextService } from "../tenancy/tenant-context.service";
import {
  CreateBankAccountDto,
  ImportBankTransactionsDto,
  ListBankTransactionsDto,
  ReconcileBankTransactionDto,
  SuggestReconciliationsDto,
} from "./dto/banking.dto";

@Injectable()
export class BankingService {
  constructor(
    private readonly tenant: TenantContextService,
    private readonly audit: AuditService,
  ) {}

  async listAccounts() {
    return this.tenant.db.bankAccount.findMany({
      where: this.scope(),
      include: { account: true },
      orderBy: { name: "asc" },
    });
  }

  async createAccount(input: CreateBankAccountDto) {
    const scope = this.scope();
    const account = await this.tenant.db.account.findFirst({
      where: {
        id: input.accountId,
        ...scope,
        active: true,
        isReconcilable: true,
        OR: [
          { systemRole: AccountingRole.BANK },
          { systemRole: null },
        ],
      },
    });
    if (!account)
      throw new BadRequestException(
        "Bank account requires an active reconcilable accounting account",
      );
    const company = await this.tenant.db.company.findFirstOrThrow({
      where: { id: scope.companyId, organizationId: scope.organizationId },
      select: { baseCurrency: true },
    });
    if (input.currency !== company.baseCurrency)
      throw new BadRequestException(
        "Bank account currency must equal company base currency until foreign-exchange accounting is configured",
      );
    const iban = normalizeIban(input.iban);
    if (iban && !isValidIban(iban))
      throw new BadRequestException("Bank account IBAN checksum is invalid");
    try {
      const created = await this.tenant.db.bankAccount.create({
        data: {
          ...scope,
          accountId: account.id,
          name: input.name.trim(),
          iban,
          currency: input.currency,
        },
        include: { account: true },
      });
      await this.audit.record(
        "bank_account.created",
        "bank_account",
        created.id,
      );
      return created;
    } catch (error) {
      if (
        error instanceof Prisma.PrismaClientKnownRequestError &&
        error.code === "P2002"
      )
        throw new ConflictException(
          "Accounting account or IBAN is already linked to a bank account",
        );
      throw error;
    }
  }

  async importTransactions(input: ImportBankTransactionsDto) {
    const scope = this.scope();
    const account = await this.tenant.db.bankAccount.findFirst({
      where: { id: input.bankAccountId, ...scope, active: true },
    });
    if (!account) throw new BadRequestException("Active bank account not found");
    const externalIds = input.transactions.map(({ externalId }) =>
      externalId.trim(),
    );
    if (new Set(externalIds).size !== externalIds.length)
      throw new BadRequestException(
        "Imported transactions contain duplicate external IDs",
      );
    if (input.transactions.some(({ amount }) => new Decimal(amount).isZero()))
      throw new BadRequestException("Bank transaction amount cannot be zero");
    const existing = await this.tenant.db.bankTransaction.findFirst({
      where: {
        bankAccountId: account.id,
        externalId: { in: externalIds },
        ...scope,
      },
      select: { externalId: true },
    });
    if (existing)
      throw new ConflictException(
        `Bank transaction ${existing.externalId} has already been imported`,
      );
    try {
      await this.tenant.db.bankTransaction.createMany({
        data: input.transactions.map((transaction, index) => ({
          ...scope,
          bankAccountId: account.id,
          externalId: externalIds[index],
          bookingDate: new Date(transaction.bookingDate),
          valueDate: transaction.valueDate
            ? new Date(transaction.valueDate)
            : null,
          amount: new Decimal(transaction.amount),
          currency: account.currency,
          description: transaction.description.trim(),
          counterpartyName: transaction.counterpartyName?.trim() || null,
          counterpartyIban: normalizeIban(transaction.counterpartyIban),
          reference: transaction.reference?.trim() || null,
        })),
      });
    } catch (error) {
      if (
        error instanceof Prisma.PrismaClientKnownRequestError &&
        error.code === "P2002"
      )
        throw new ConflictException(
          "One or more bank transactions were imported concurrently",
        );
      throw error;
    }
    const imported = await this.tenant.db.bankTransaction.findMany({
      where: {
        bankAccountId: account.id,
        externalId: { in: externalIds },
        ...scope,
      },
      orderBy: [{ bookingDate: "asc" }, { id: "asc" }],
    });
    await this.audit.record(
      "bank_transactions.imported",
      "bank_account",
      account.id,
      { count: imported.length },
    );
    return imported;
  }

  async listTransactions(query: ListBankTransactionsDto) {
    const filter = `${query.bankAccountId ?? ""}:${query.status ?? ""}`;
    const cursor = query.cursor
      ? decodeCursor(query.cursor, filter)
      : undefined;
    const where: Prisma.BankTransactionWhereInput = {
      ...this.scope(),
      ...(query.bankAccountId ? { bankAccountId: query.bankAccountId } : {}),
      ...(query.status ? { status: query.status } : {}),
    };
    if (cursor) {
      const exists = await this.tenant.db.bankTransaction.findFirst({
        where: { id: cursor.id, bookingDate: new Date(cursor.sort), ...where },
      });
      if (!exists)
        throw new BadRequestException(
          "Cursor is stale or does not belong to the selected company",
        );
    }
    const transactions = await this.tenant.db.bankTransaction.findMany({
      where,
      include: { bankAccount: true, reconciliation: true },
      orderBy: [{ bookingDate: "desc" }, { id: "desc" }],
      ...(cursor ? { cursor: { id: cursor.id }, skip: 1 } : {}),
      take: query.limit + 1,
    });
    const hasMore = transactions.length > query.limit;
    const page = hasMore ? transactions.slice(0, -1) : transactions;
    const last = page.at(-1);
    return {
      data: page,
      nextCursor:
        hasMore && last
          ? encodeCursor(last.id, last.bookingDate.toISOString(), filter)
          : null,
    };
  }

  async suggestions(id: string, query: SuggestReconciliationsDto) {
    const transaction = await this.requireTransaction(id);
    if (transaction.status === BankTransactionStatus.RECONCILED) return [];
    const amount = transaction.amount.abs();
    const startDate = shiftDays(transaction.bookingDate, -query.windowDays);
    const endDate = shiftDays(transaction.bookingDate, query.windowDays);
    const lines = await this.tenant.db.journalLine.findMany({
      where: {
        ...this.scope(),
        accountId: transaction.bankAccount.accountId,
        reconciliation: null,
        entry: {
          status: JournalEntryStatus.POSTED,
          entryDate: { gte: startDate, lte: endDate },
        },
        ...(transaction.amount.greaterThan(0)
          ? { debit: amount, credit: new Decimal(0) }
          : { credit: amount, debit: new Decimal(0) }),
      },
      include: { account: true, entry: true },
      orderBy: { entry: { entryDate: "desc" } },
      take: 20,
    });
    return lines
      .map((line) => ({
        journalLineId: line.id,
        score: reconciliationScore(transaction, line.entry),
        account: { id: line.account.id, code: line.account.code },
        entry: {
          id: line.entry.id,
          entryNumber: line.entry.entryNumber.toString(),
          entryDate: line.entry.entryDate,
          description: line.entry.description,
          sourceType: line.entry.sourceType,
          sourceId: line.entry.sourceId,
        },
        debit: line.debit,
        credit: line.credit,
      }))
      .sort((a, b) => b.score - a.score);
  }

  async reconcile(id: string, input: ReconcileBankTransactionDto) {
    const scope = this.scope();
    const locked = await this.tenant.db.$queryRaw<Array<{ id: string }>>`
      SELECT "id" FROM "bank_transactions"
      WHERE "id" = CAST(${id} AS uuid)
        AND "organization_id" = CAST(${scope.organizationId} AS uuid)
        AND "company_id" = CAST(${scope.companyId} AS uuid)
      FOR UPDATE
    `;
    if (!locked.length) throw new NotFoundException("Bank transaction not found");
    const transaction = await this.requireTransaction(id);
    if (transaction.reconciliation) {
      if (transaction.reconciliation.journalLineId === input.journalLineId)
        return transaction.reconciliation;
      throw new ConflictException("Bank transaction is already reconciled");
    }
    await this.tenant.db.$queryRaw<Array<{ id: string }>>`
      SELECT "id" FROM "journal_lines"
      WHERE "id" = CAST(${input.journalLineId} AS uuid)
        AND "organization_id" = CAST(${scope.organizationId} AS uuid)
        AND "company_id" = CAST(${scope.companyId} AS uuid)
      FOR UPDATE
    `;
    const line = await this.tenant.db.journalLine.findFirst({
      where: {
        id: input.journalLineId,
        ...scope,
        accountId: transaction.bankAccount.accountId,
        reconciliation: null,
        entry: { status: JournalEntryStatus.POSTED },
      },
    });
    if (!line || !matchesAmount(transaction.amount, line.debit, line.credit))
      throw new ConflictException(
        "Journal line is unavailable or does not match this bank transaction",
      );
    const reconciliation = await this.tenant.db.bankReconciliation.create({
      data: {
        ...scope,
        bankTransactionId: transaction.id,
        journalLineId: line.id,
        reconciledById: this.tenant.required.userId,
      },
    });
    await this.tenant.db.bankTransaction.update({
      where: { id: transaction.id },
      data: { status: BankTransactionStatus.RECONCILED },
    });
    await this.audit.record(
      "banking.reconcile",
      "bank_reconciliation",
      reconciliation.id,
      { bankTransactionId: transaction.id, journalLineId: line.id },
    );
    return reconciliation;
  }

  private async requireTransaction(id: string) {
    const transaction = await this.tenant.db.bankTransaction.findFirst({
      where: { id, ...this.scope() },
      include: { bankAccount: true, reconciliation: true },
    });
    if (!transaction) throw new NotFoundException("Bank transaction not found");
    return transaction;
  }

  private scope() {
    const { organizationId, companyId } = this.tenant.required;
    if (!companyId) throw new BadRequestException("x-company-id is required");
    return { organizationId, companyId };
  }
}

function shiftDays(date: Date, days: number) {
  return new Date(date.getTime() + days * 86_400_000);
}

function matchesAmount(amount: Decimal, debit: Decimal, credit: Decimal) {
  return amount.greaterThan(0)
    ? debit.equals(amount) && credit.isZero()
    : credit.equals(amount.abs()) && debit.isZero();
}

function reconciliationScore(
  transaction: { bookingDate: Date; reference: string | null },
  entry: { entryDate: Date; description: string },
) {
  const days = Math.abs(
    Math.round(
      (transaction.bookingDate.getTime() - entry.entryDate.getTime()) /
        86_400_000,
    ),
  );
  const dateScore = Math.max(0, 15 - days * 2);
  const reference = transaction.reference?.trim().toLowerCase();
  const referenceScore =
    reference && entry.description.toLowerCase().includes(reference) ? 5 : 0;
  return Math.min(100, 80 + dateScore + referenceScore);
}
