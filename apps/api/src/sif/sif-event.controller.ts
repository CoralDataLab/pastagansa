import { Controller, Get, HttpCode, Post } from "@nestjs/common";
import { RequirePermissions } from "../authorization/permissions.decorator";
import { TenantProtected } from "../tenancy/tenant.decorator";
import { LongTenantTransaction } from "../tenancy/long-tenant-transaction.decorator";
import { SifNoEventService } from "./sif-no-event.service";

@Controller("sif/events")
@TenantProtected()
export class SifEventController {
  constructor(private readonly events: SifNoEventService) {}

  @Get("verification")
  @LongTenantTransaction()
  @RequirePermissions("sif_record.read")
  verification() {
    return this.events.verifyChain();
  }

  @Get("alarms")
  @RequirePermissions("sif_record.read")
  alarms() {
    return this.events.alarms();
  }

  @Post("integrity-check")
  @LongTenantTransaction()
  @HttpCode(200)
  @RequirePermissions("sif_record.read")
  integrityCheck() {
    return this.events.checkIntegrity();
  }
}
