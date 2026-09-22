import { Controller, Get } from "@nestjs/common";
import { RequirePermissions } from "../authorization/permissions.decorator";
import { TenantProtected } from "../tenancy/tenant.decorator";
import { SifNoEventService } from "./sif-no-event.service";

@Controller("sif/events")
@TenantProtected()
export class SifEventController {
  constructor(private readonly events: SifNoEventService) {}

  @Get("verification")
  @RequirePermissions("sif_record.read")
  verification() {
    return this.events.verifyChain();
  }
}
