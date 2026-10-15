import {
  Body,
  Controller,
  HttpCode,
  Post,
  UploadedFile,
  UseInterceptors,
} from "@nestjs/common";
import { FileInterceptor } from "@nestjs/platform-express";
import { RequirePermissions } from "../authorization/permissions.decorator";
import { TenantProtected } from "../tenancy/tenant.decorator";
import {
  BankStatementsService,
  UploadedStatementFile,
} from "./bank-statements.service";
import {
  ImportNorma43Dto,
  ImportTableDto,
  InspectTableDto,
  PreviewNorma43Dto,
  PreviewTableDto,
} from "./dto/bank-statements.dto";
import { MAX_NORMA43_BYTES } from "./norma43";
import { MAX_TABLE_BYTES } from "./table-statement";

const norma43Upload = FileInterceptor("file", {
  limits: { fileSize: MAX_NORMA43_BYTES, files: 1 },
});
const tableUpload = FileInterceptor("file", {
  limits: { fileSize: MAX_TABLE_BYTES, files: 1 },
});

@Controller("banking/statements")
@TenantProtected()
export class BankStatementsController {
  constructor(private readonly statements: BankStatementsService) {}

  @Post("norma43/preview")
  @HttpCode(200)
  @RequirePermissions("bank_transaction.import")
  @UseInterceptors(norma43Upload)
  previewNorma43(
    @UploadedFile() file: UploadedStatementFile | undefined,
    @Body() input: PreviewNorma43Dto,
  ) {
    return this.statements.previewNorma43(file, input);
  }

  @Post("norma43/import")
  @RequirePermissions("bank_transaction.import")
  @UseInterceptors(norma43Upload)
  importNorma43(
    @UploadedFile() file: UploadedStatementFile | undefined,
    @Body() input: ImportNorma43Dto,
  ) {
    return this.statements.importNorma43(file, input);
  }

  @Post("table/inspect")
  @HttpCode(200)
  @RequirePermissions("bank_transaction.import")
  @UseInterceptors(tableUpload)
  inspectTable(
    @UploadedFile() file: UploadedStatementFile | undefined,
    @Body() input: InspectTableDto,
  ) {
    return this.statements.inspectTable(file, input);
  }

  @Post("table/preview")
  @HttpCode(200)
  @RequirePermissions("bank_transaction.import")
  @UseInterceptors(tableUpload)
  previewTable(
    @UploadedFile() file: UploadedStatementFile | undefined,
    @Body() input: PreviewTableDto,
  ) {
    return this.statements.previewTable(file, input);
  }

  @Post("table/import")
  @RequirePermissions("bank_transaction.import")
  @UseInterceptors(tableUpload)
  importTable(
    @UploadedFile() file: UploadedStatementFile | undefined,
    @Body() input: ImportTableDto,
  ) {
    return this.statements.importTable(file, input);
  }
}
