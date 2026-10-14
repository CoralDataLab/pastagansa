import {
  Body,
  Controller,
  Get,
  HttpCode,
  Param,
  ParseUUIDPipe,
  Post,
  Query,
  UploadedFile,
  UseInterceptors,
} from "@nestjs/common";
import { FileInterceptor } from "@nestjs/platform-express";
import { RequirePermissions } from "../authorization/permissions.decorator";
import { TenantProtected } from "../tenancy/tenant.decorator";
import { BankingService, UploadedStatementFile } from "./banking.service";
import {
  CreateBankAccountDto,
  ImportBankTransactionsDto,
  ImportNorma43Dto,
  ListBankTransactionsDto,
  PreviewNorma43Dto,
  ReconcileBankTransactionDto,
  SuggestReconciliationsDto,
} from "./dto/banking.dto";
import { MAX_NORMA43_BYTES } from "./norma43";

const norma43Upload = FileInterceptor("file", {
  limits: { fileSize: MAX_NORMA43_BYTES, files: 1 },
});

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

  @Post("statements/norma43/preview")
  @HttpCode(200)
  @RequirePermissions("bank_transaction.import")
  @UseInterceptors(norma43Upload)
  previewNorma43(
    @UploadedFile() file: UploadedStatementFile | undefined,
    @Body() input: PreviewNorma43Dto,
  ) {
    return this.banking.previewNorma43(file, input);
  }

  @Post("statements/norma43/import")
  @RequirePermissions("bank_transaction.import")
  @UseInterceptors(norma43Upload)
  importNorma43(
    @UploadedFile() file: UploadedStatementFile | undefined,
    @Body() input: ImportNorma43Dto,
  ) {
    return this.banking.importNorma43(file, input);
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
