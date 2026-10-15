import {
  Body,
  Controller,
  Get,
  HttpCode,
  Param,
  ParseUUIDPipe,
  Post,
  Query,
} from "@nestjs/common";
import { RequirePermissions } from "../authorization/permissions.decorator";
import { TenantProtected } from "../tenancy/tenant.decorator";
import { BankingService } from "./banking.service";
import {
  CreateBankAccountDto,
  ImportBankTransactionsDto,
  ListBankTransactionsDto,
  ReconcileBankTransactionDto,
  SuggestReconciliationsDto,
} from "./dto/banking.dto";

@Controller("banking")
@TenantProtected()
export class BankingController {
  constructor(private readonly banking: BankingService) {}

  @Get("accounts")
  @RequirePermissions("bank_account.read")
  accounts() {
    return this.banking.listAccounts();
  }

  @Post("accounts")
  @RequirePermissions("bank_account.manage")
  createAccount(@Body() input: CreateBankAccountDto) {
    return this.banking.createAccount(input);
  }

  @Get("transactions")
  @RequirePermissions("bank_transaction.read")
  transactions(@Query() query: ListBankTransactionsDto) {
    return this.banking.listTransactions(query);
  }

  @Post("transactions/import")
  @RequirePermissions("bank_transaction.import")
  importTransactions(@Body() input: ImportBankTransactionsDto) {
    return this.banking.importTransactions(input);
  }

  @Get("transactions/:id/suggestions")
  @RequirePermissions("bank_transaction.read")
  suggestions(
    @Param("id", ParseUUIDPipe) id: string,
    @Query() query: SuggestReconciliationsDto,
  ) {
    return this.banking.suggestions(id, query);
  }

  @Post("transactions/:id/reconcile")
  @HttpCode(200)
  @RequirePermissions("bank_transaction.reconcile")
  reconcile(
    @Param("id", ParseUUIDPipe) id: string,
    @Body() input: ReconcileBankTransactionDto,
  ) {
    return this.banking.reconcile(id, input);
  }
}
