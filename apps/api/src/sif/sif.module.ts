import { Module } from "@nestjs/common";
import { AuditModule } from "../audit/audit.module";
import { SifController } from "./sif.controller";
import { SifService } from "./sif.service";
import { AeatTestClient, AeatProductionClient } from "./aeat-test.client";
import { AeatTestWorker, AeatProductionWorker } from "./aeat-test.worker";
import { SifNoSigningService } from "./sif-no-signing.service";
import { SifNoEventService } from "./sif-no-event.service";
import { SifEventController } from "./sif-event.controller";
import { SifNoEventRuntime } from "./sif-no-event.runtime";

@Module({
  imports: [AuditModule],
  controllers: [SifController, SifEventController],
  providers: [SifService, AeatTestClient, AeatTestWorker,
    AeatProductionClient, AeatProductionWorker, SifNoSigningService,
    SifNoEventService, SifNoEventRuntime],
  exports: [SifService, SifNoEventService],
})
export class SifModule {}
