import { Module } from "@nestjs/common";
import { AuditModule } from "../audit/audit.module";
import { CompaniesController } from "./companies.controller";
import { CompaniesService } from "./companies.service";
import { SifDeclarationPdfService } from "../sif/sif-declaration-pdf.service";
import { SifModule } from "../sif/sif.module";

@Module({
  imports: [AuditModule, SifModule],
  controllers: [CompaniesController],
  providers: [CompaniesService, SifDeclarationPdfService],
})
export class CompaniesModule {}
