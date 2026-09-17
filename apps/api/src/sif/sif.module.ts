import { Module } from "@nestjs/common";
import { AuditModule } from "../audit/audit.module";
import { SifController } from "./sif.controller";
import { SifService } from "./sif.service";
import { AeatTestClient } from "./aeat-test.client";
import { AeatTestWorker } from "./aeat-test.worker";

@Module({
  imports: [AuditModule],
  controllers: [SifController],
  providers: [SifService, AeatTestClient, AeatTestWorker],
  exports: [SifService],
})
export class SifModule {}
