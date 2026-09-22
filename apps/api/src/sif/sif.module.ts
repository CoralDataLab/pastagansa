import { Module } from "@nestjs/common";
import { AuditModule } from "../audit/audit.module";
import { SifController } from "./sif.controller";
import { SifService } from "./sif.service";
import { AeatTestClient } from "./aeat-test.client";
import { AeatTestWorker } from "./aeat-test.worker";
import { SifNoSigningService } from "./sif-no-signing.service";
import { SifNoEventService } from "./sif-no-event.service";
import { SifEventController } from "./sif-event.controller";

@Module({
  imports: [AuditModule],
  controllers: [SifController, SifEventController],
  providers: [SifService, AeatTestClient, AeatTestWorker, SifNoSigningService, SifNoEventService],
  exports: [SifService, SifNoEventService],
})
export class SifModule {}
