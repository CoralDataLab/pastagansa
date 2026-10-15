import {
  BadRequestException,
  ConflictException,
  Injectable,
} from "@nestjs/common";
import { BankAccount, Prisma } from "@prisma/client";
import { Decimal } from "@prisma/client/runtime/library";
import { plainToInstance } from "class-transformer";
import { validateSync } from "class-validator";
import { createHash } from "crypto";
import { AuditService } from "../audit/audit.service";
import { TenantContextService } from "../tenancy/tenant-context.service";
import {
  ImportNorma43Dto,
  ImportTableDto,
  InspectTableDto,
  PreviewNorma43Dto,
  PreviewTableDto,
  TableMappingDto,
} from "./dto/bank-statements.dto";
import { Norma43FormatError, parseNorma43 } from "./norma43";
import { centsToAmount, movementStatus, StatementMovement } from "./statement";
import {
  columnNames,
  INSPECT_ROWS,
  readMovements,
  readTable,
  suggestMapping,
  Table,
  TableFormatError,
  TableMapping,
} from "./table-statement";

export type UploadedStatementFile = { buffer: Buffer; size?: number };

/** One account of a statement file, ready to compare with already imported transactions. */
type StatementAccount = {
  iban: string | null;
  holderName: string;
  currency: string;
  startDate: string | null;
  endDate: string | null;
  openingBalanceCents: number | null;
  closingBalanceCents: number | null;
  movements: StatementMovement[];
};
type LinkedAccount = {
  account: StatementAccount;
  bankAccount: BankAccount | null;
  existing: Set<string>;
};
type ImportSummary = {
  bankAccountId: string;
  iban: string | null;
  imported: number;
  duplicates: number;
  skipped: number;
};

@Injectable()
export class BankStatementsService {
  constructor(
    private readonly tenant: TenantContextService,
    private readonly audit: AuditService,
  ) {}

  async previewNorma43(
    file: UploadedStatementFile | undefined,
    input: PreviewNorma43Dto,
  ) {
    const statement = await this.analyzeNorma43(file, input.bankAccountId);
    return {
      fileSha256: statement.fileSha256,
      accounts: statement.accounts.map(accountPreview),
    };
  }

  /** Imports only movements not yet imported, all statement accounts at once. */
  async importNorma43(
    file: UploadedStatementFile | undefined,
    input: ImportNorma43Dto,
  ) {
    const statement = await this.analyzeNorma43(file, input.bankAccountId);
    requireSameFile(statement.fileSha256, input.fileSha256);
    const unlinked = statement.accounts.find(({ bankAccount }) => !bankAccount);
    if (unlinked)
      throw new BadRequestException(
        `Statement account ${unlinked.account.iban ?? "without IBAN"} is not linked to an active bank account`,
      );
    const accounts: ImportSummary[] = [];
    for (const linked of statement.accounts)
      accounts.push(await this.insert(linked, "NORMA43", statement.fileSha256));
    return importResult(statement.fileSha256, accounts);
  }

  /** Reads the first rows so the user can confirm the header row and the columns. */
  async inspectTable(
    file: UploadedStatementFile | undefined,
    input: InspectTableDto,
  ) {
    const content = requireFile(file);
    const bankAccount = await this.requireBankAccount(input.bankAccountId);
    const table = tableOrFail(() => readTable(content, input.delimiter));
    const saved = savedMapping(bankAccount.statementMapping, table);
    return {
      fileSha256: sha256(content),
      format: table.format,
      delimiter: table.delimiter,
      rows: table.rows.slice(0, INSPECT_ROWS).map((row) => row.map(String)),
      mapping: saved ?? suggestMapping(table),
      savedMapping: Boolean(saved),
    };
  }

  async previewTable(
    file: UploadedStatementFile | undefined,
    input: PreviewTableDto,
  ) {
    const statement = await this.analyzeTable(file, input);
    return {
      fileSha256: statement.fileSha256,
      format: statement.format,
      accounts: [accountPreview(statement.linked)],
      errors: statement.errors,
      errorCount: statement.errorCount,
      ignoredCount: statement.ignored,
    };
  }

  /** Imports the new movements and remembers the mapping for the next statement of this account. */
  async importTable(
    file: UploadedStatementFile | undefined,
    input: ImportTableDto,
  ) {
    const statement = await this.analyzeTable(file, input);
    requireSameFile(statement.fileSha256, input.fileSha256);
    if (statement.errorCount)
      throw new BadRequestException(
        `The statement has ${statement.errorCount} rows with errors`,
      );
    const summary = await this.insert(
      statement.linked,
      statement.format,
      statement.fileSha256,
    );
    await this.tenant.db.bankAccount.update({
      where: { id: summary.bankAccountId },
      data: {
        statementMapping: JSON.parse(
          JSON.stringify(statement.mapping),
        ) as Prisma.InputJsonObject,
      },
    });
    return importResult(statement.fileSha256, [summary]);
  }

  /** Parses the statement, links each account by IBAN and flags already imported movements. */
  private async analyzeNorma43(
    file: UploadedStatementFile | undefined,
    bankAccountId?: string,
  ) {
    const content = requireFile(file);
    let accounts: StatementAccount[];
    try {
      accounts = parseNorma43(content);
    } catch (error) {
      if (error instanceof Norma43FormatError)
        throw new BadRequestException(`Invalid Norma 43 file. ${error.message}`);
      throw error;
    }
    const bankAccounts = await this.tenant.db.bankAccount.findMany({
      where: { ...this.scope(), active: true },
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
    const linked: LinkedAccount[] = [];
    for (const account of accounts) {
      const bankAccount =
        target ??
        bankAccounts.find(({ iban }) => iban !== null && iban === account.iban) ??
        null;
      linked.push(await this.link(account, bankAccount));
    }
    return { fileSha256: sha256(content), accounts: linked };
  }

  private async analyzeTable(
    file: UploadedStatementFile | undefined,
    input: PreviewTableDto,
  ) {
    const content = requireFile(file);
    const bankAccount = await this.requireBankAccount(input.bankAccountId);
    const table = tableOrFail(() => readTable(content, input.mapping.delimiter));
    const mapping: TableMapping = {
      ...input.mapping,
      delimiter: table.delimiter ?? undefined,
    };
    const { movements, errors, errorCount, ignored } = tableOrFail(() =>
      readMovements(table, mapping),
    );
    const dates = movements.map(({ operationDate }) => operationDate).sort();
    const account: StatementAccount = {
      iban: bankAccount.iban,
      holderName: "",
      currency: bankAccount.currency,
      startDate: dates[0] ?? null,
      endDate: dates.at(-1) ?? null,
      openingBalanceCents: null,
      closingBalanceCents: null,
      movements,
    };
    return {
      fileSha256: sha256(content),
      format: table.format,
      mapping,
      linked: await this.link(account, bankAccount),
      errors,
      errorCount,
      ignored,
    };
  }

  private async link(account: StatementAccount, bankAccount: BankAccount | null) {
    if (bankAccount && bankAccount.currency !== account.currency)
      throw new BadRequestException(
        `Statement currency ${account.currency} does not match bank account ${bankAccount.name}`,
      );
    const existing = bankAccount
      ? await this.tenant.db.bankTransaction.findMany({
          where: {
            ...this.scope(),
            bankAccountId: bankAccount.id,
            externalId: {
              in: account.movements.map(({ externalId }) => externalId),
            },
          },
          select: { externalId: true },
        })
      : [];
    return {
      account,
      bankAccount,
      existing: new Set(existing.map(({ externalId }) => externalId)),
    };
  }

  private async insert(
    { account, bankAccount, existing }: LinkedAccount,
    format: string,
    fileSha256: string,
  ): Promise<ImportSummary> {
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
          ...this.scope(),
          bankAccountId: linked.id,
          externalId: movement.externalId,
          bookingDate: new Date(movement.operationDate),
          valueDate: movement.valueDate ? new Date(movement.valueDate) : null,
          amount: new Decimal(centsToAmount(movement.amountCents)),
          currency: linked.currency,
          description: movement.description,
          counterpartyName: movement.counterpartyName ?? null,
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
    await this.audit.record("bank_statement.imported", "bank_account", linked.id, {
      format,
      fileSha256,
      startDate: account.startDate,
      endDate: account.endDate,
      openingBalance: optionalAmount(account.openingBalanceCents),
      closingBalance: optionalAmount(account.closingBalanceCents),
      imported: summary.imported,
      duplicates: summary.duplicates,
      skipped: summary.skipped,
    });
    return summary;
  }

  private async requireBankAccount(id: string) {
    const bankAccount = await this.tenant.db.bankAccount.findFirst({
      where: { id, ...this.scope(), active: true },
    });
    if (!bankAccount) throw new BadRequestException("Active bank account not found");
    return bankAccount;
  }

  private scope() {
    const { organizationId, companyId } = this.tenant.required;
    if (!companyId) throw new BadRequestException("x-company-id is required");
    return { organizationId, companyId };
  }
}

function requireFile(file: UploadedStatementFile | undefined) {
  if (!file?.buffer?.length)
    throw new BadRequestException("A statement file is required");
  if (file.size !== undefined && file.size !== file.buffer.length)
    throw new BadRequestException("The statement upload is incomplete");
  return file.buffer;
}

function requireSameFile(actual: string, previewed: string) {
  if (actual !== previewed.toLowerCase())
    throw new ConflictException("The statement file differs from the previewed one");
}

function tableOrFail<T>(read: () => T) {
  try {
    return read();
  } catch (error) {
    if (error instanceof TableFormatError)
      throw new BadRequestException(`Invalid statement file. ${error.message}`);
    throw error;
  }
}

/** The account's remembered mapping, if it is still valid and its columns exist in this file. */
function savedMapping(stored: Prisma.JsonValue | null, table: Table) {
  if (!stored || typeof stored !== "object" || Array.isArray(stored)) return null;
  const mapping = plainToInstance(TableMappingDto, stored);
  if (validateSync(mapping, { whitelist: true, forbidNonWhitelisted: true }).length)
    return null;
  if (table.format === "CSV" && mapping.delimiter !== table.delimiter) return null;
  const columns = columnNames(table.rows[mapping.headerRow]);
  const used = [
    mapping.dateColumn,
    mapping.valueDateColumn,
    mapping.amountMode === "SIGNED" ? mapping.amountColumn : mapping.debitColumn,
    mapping.amountMode === "SPLIT" ? mapping.creditColumn : undefined,
    mapping.referenceColumn,
    mapping.counterpartyColumn,
    ...mapping.descriptionColumns,
  ].filter((name): name is string => name !== undefined);
  if (!used.every((name) => columns.includes(name))) return null;
  return { ...mapping, delimiter: table.delimiter ?? undefined } as TableMapping;
}

function accountPreview({ account, bankAccount, existing }: LinkedAccount) {
  const movements = account.movements.map((movement) => ({
    externalId: movement.externalId,
    bookingDate: movement.operationDate,
    valueDate: movement.valueDate,
    amount: centsToAmount(movement.amountCents),
    description: movement.description,
    reference: movement.reference,
    counterpartyName: movement.counterpartyName ?? null,
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
    openingBalance: optionalAmount(account.openingBalanceCents),
    closingBalance: optionalAmount(account.closingBalanceCents),
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
}

function importResult(fileSha256: string, accounts: ImportSummary[]) {
  const sum = (field: "imported" | "duplicates" | "skipped") =>
    accounts.reduce((total, summary) => total + summary[field], 0);
  return {
    fileSha256,
    imported: sum("imported"),
    duplicates: sum("duplicates"),
    skipped: sum("skipped"),
    accounts,
  };
}

function optionalAmount(cents: number | null) {
  return cents === null ? null : centsToAmount(cents);
}

function sha256(content: Buffer) {
  return createHash("sha256").update(content).digest("hex");
}
