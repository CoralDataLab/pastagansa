import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
} from "@nestjs/common";
import {
  AccountingRole,
  BankAccount,
  BankTransactionStatus,
  JournalEntryStatus,
  Prisma,
} from "@prisma/client";
import { Decimal } from "@prisma/client/runtime/library";
import { createHash } from "crypto";
import { AuditService } from "../audit/audit.service";
import { decodeCursor, encodeCursor } from "../common/cursor";
import { isValidIban, normalizeIban } from "../common/iban";
import { TenantContextService } from "../tenancy/tenant-context.service";
import {
  CreateBankAccountDto,
  ImportBankTransactionsDto,
  ImportNorma43Dto,
  ListBankTransactionsDto,
  PreviewNorma43Dto,
  ReconcileBankTransactionDto,
  SuggestReconciliationsDto,
} from "./dto/banking.dto";
import {
  Norma43Account,
  Norma43FormatError,
  Norma43Movement,
  parseNorma43,
} from "./norma43";

export type UploadedStatementFile = { buffer: Buffer; size?: number };

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

  async previewNorma43(
    file: UploadedStatementFile | undefined,
    input: PreviewNorma43Dto,
  ) {
    const statement = await this.analyzeNorma43(file, input.bankAccountId);
    return {
      fileSha256: statement.fileSha256,
      accounts: statement.accounts.map(({ account, bankAccount, existing }) => {
        const movements = account.movements.map((movement) => ({
          externalId: movement.externalId,
          bookingDate: movement.operationDate,
          valueDate: movement.valueDate,
          amount: centsToAmount(movement.amountCents),
          description: movement.description,
          reference: movement.reference,
          status: movementStatus(movement, existing),
        }));
        const total = (status: string) =>
          movements.filter((movement) => movement.status === status).length;
        return {
          iban: account.iban,
          holderName: account.holderName,
          currency: account.currency,
          startDate: account.startDate,
          endDate: account.endDate,
          openingBalance: centsToAmount(account.openingBalanceCents),
          closingBalance: centsToAmount(account.closingBalanceCents),
          bankAccount: bankAccount && {
            id: bankAccount.id,
            name: bankAccount.name,
            iban: bankAccount.iban,
          },
          newCount: total("NEW"),
          duplicateCount: total("DUPLICATE"),
          skippedCount: total("SKIPPED"),
          movements,
        };
      }),
    };
  }

  /** Imports only movements not yet imported, all statement accounts at once. */
  async importNorma43(
    file: UploadedStatementFile | undefined,
    input: ImportNorma43Dto,
  ) {
    const statement = await this.analyzeNorma43(file, input.bankAccountId);
    if (statement.fileSha256 !== input.fileSha256.toLowerCase())
      throw new ConflictException(
        "The statement file differs from the previewed one",
      );
    const unlinked = statement.accounts.find(({ bankAccount }) => !bankAccount);
    if (unlinked)
      throw new BadRequestException(
        `Statement account ${unlinked.account.iban ?? unlinked.account.accountNumber} is not linked to an active bank account`,
      );
    const scope = this.scope();
    const accounts: Array<{
      bankAccountId: string;
      iban: string | null;
      imported: number;
      duplicates: number;
      skipped: number;
    }> = [];
    for (const { account, bankAccount, existing } of statement.accounts) {
      const linked = bankAccount!;
      const statuses = account.movements.map((movement) =>
        movementStatus(movement, existing),
      );
      const fresh = account.movements.filter(
        (_, index) => statuses[index] === "NEW",
      );
      try {
        await this.tenant.db.bankTransaction.createMany({
          data: fresh.map((movement) => ({
            ...scope,
            bankAccountId: linked.id,
            externalId: movement.externalId,
            bookingDate: new Date(movement.operationDate),
            valueDate: new Date(movement.valueDate),
            amount: new Decimal(centsToAmount(movement.amountCents)),
            currency: linked.currency,
            description: movement.description,
            reference: movement.reference,
          })),
        });
      } catch (error) {
        if (
          error instanceof Prisma.PrismaClientKnownRequestError &&
          error.code === "P2002"
        )
          throw new ConflictException(
            "Bank transactions were imported concurrently; preview the statement again",
          );
        throw error;
      }
      const summary = {
        bankAccountId: linked.id,
        iban: account.iban,
        imported: fresh.length,
        duplicates: statuses.filter((status) => status === "DUPLICATE").length,
        skipped: statuses.filter((status) => status === "SKIPPED").length,
      };
      await this.audit.record(
        "bank_statement.imported",
        "bank_account",
        linked.id,
        {
          format: "NORMA43",
          fileSha256: statement.fileSha256,
          startDate: account.startDate,
          endDate: account.endDate,
          openingBalance: centsToAmount(account.openingBalanceCents),
          closingBalance: centsToAmount(account.closingBalanceCents),
          imported: summary.imported,
          duplicates: summary.duplicates,
          skipped: summary.skipped,
        },
      );
      accounts.push(summary);
    }
    const sum = (field: "imported" | "duplicates" | "skipped") =>
      accounts.reduce((total, summary) => total + summary[field], 0);
    return {
      fileSha256: statement.fileSha256,
      imported: sum("imported"),
      duplicates: sum("duplicates"),
      skipped: sum("skipped"),
      accounts,
    };
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

  /** Parses the statement, links each account by IBAN and flags already imported movements. */
  private async analyzeNorma43(
    file: UploadedStatementFile | undefined,
    bankAccountId?: string,
  ) {
    if (!file?.buffer?.length)
      throw new BadRequestException("A Norma 43 file is required");
    if (file.size !== undefined && file.size !== file.buffer.length)
      throw new BadRequestException("The Norma 43 upload is incomplete");
    let accounts: Norma43Account[];
    try {
      accounts = parseNorma43(file.buffer);
    } catch (error) {
      if (error instanceof Norma43FormatError)
        throw new BadRequestException(`Invalid Norma 43 file. ${error.message}`);
      throw error;
    }
    const scope = this.scope();
    const bankAccounts = await this.tenant.db.bankAccount.findMany({
      where: { ...scope, active: true },
    });
    let target: BankAccount | undefined;
    if (bankAccountId) {
      if (accounts.length !== 1)
        throw new BadRequestException(
          "A target bank account can only be chosen for a single-account statement",
        );
      target = bankAccounts.find(({ id }) => id === bankAccountId);
      if (!target) throw new BadRequestException("Active bank account not found");
      if (target.iban && target.iban !== accounts[0].iban)
        throw new BadRequestException(
          "The chosen bank account has a different IBAN than the statement",
        );
    }
    const analyzed = [];
    for (const account of accounts) {
      const bankAccount =
        target ??
        bankAccounts.find(({ iban }) => iban !== null && iban === account.iban) ??
        null;
      if (bankAccount && bankAccount.currency !== account.currency)
        throw new BadRequestException(
          `Statement currency ${account.currency} does not match bank account ${bankAccount.name}`,
        );
      const existing = bankAccount
        ? await this.tenant.db.bankTransaction.findMany({
            where: {
              ...scope,
              bankAccountId: bankAccount.id,
              externalId: {
                in: account.movements.map(({ externalId }) => externalId),
              },
            },
            select: { externalId: true },
          })
        : [];
      analyzed.push({
        account,
        bankAccount,
        existing: new Set(existing.map(({ externalId }) => externalId)),
      });
    }
    return {
      fileSha256: createHash("sha256").update(file.buffer).digest("hex"),
      accounts: analyzed,
    };
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

function centsToAmount(cents: number) {
  const absolute = Math.abs(cents);
  return `${cents < 0 ? "-" : ""}${Math.floor(absolute / 100)}.${String(absolute % 100).padStart(2, "0")}`;
}

function movementStatus(movement: Norma43Movement, existing: Set<string>) {
  if (movement.amountCents === 0) return "SKIPPED" as const;
  return existing.has(movement.externalId)
    ? ("DUPLICATE" as const)
    : ("NEW" as const);
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
