import { Module } from "@nestjs/common";
import { AuditModule } from "../audit/audit.module";
import { BankStatementsController } from "./bank-statements.controller";
import { BankStatementsService } from "./bank-statements.service";
import { BankingController } from "./banking.controller";
import { BankingService } from "./banking.service";

@Module({
  imports: [AuditModule],
  controllers: [BankingController, BankStatementsController],
  providers: [BankingService, BankStatementsService],
})
export class BankingModule {}
