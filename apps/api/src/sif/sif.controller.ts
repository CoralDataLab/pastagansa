import { Controller, Get, HttpCode, Param, ParseUUIDPipe, Post, Query, StreamableFile } from "@nestjs/common";
import { RequirePermissions } from "../authorization/permissions.decorator";
import { TenantProtected } from "../tenancy/tenant.decorator";
import { ListSifRecordsDto } from "./dto/list-sif-records.dto";
import { SifService } from "./sif.service";

@Controller("sif/records")
@TenantProtected()
export class SifController {
  constructor(private readonly sif: SifService) {}

  @Post(":invoiceId/cancellation")
  @HttpCode(200)
  @RequirePermissions("invoice.issue")
  cancellation(@Param("invoiceId", ParseUUIDPipe) invoiceId: string) {
    return this.sif.createCancellation(invoiceId);
  }

  @Post(":invoiceId/timestamp-subsanation")
  @HttpCode(200)
  @RequirePermissions("invoice.issue")
  timestampSubsanation(@Param("invoiceId", ParseUUIDPipe) invoiceId: string) {
    return this.sif.createTimestampSubsanation(invoiceId);
  }

  @Get("transition-audit")
  @RequirePermissions("sif_record.read")
  transitionAudit() {
    return this.sif.transitionAudit();
  }

  @Get("verification")
  @RequirePermissions("sif_record.read")
  verification() {
    return this.sif.verifyChain();
  }

  @Get(":recordId/xml")
  @RequirePermissions("sif_record.read")
  async exportXml(@Param("recordId", ParseUUIDPipe) recordId: string) {
    const file = await this.sif.exportXml(recordId);
    return new StreamableFile(file.content, {
      type: "application/xml; charset=utf-8",
      disposition: `attachment; filename="${file.filename}"`,
      length: file.content.length,
    });
  }

  @Get(":recordId/test-submissions")
  @RequirePermissions("sif_record.read")
  testSubmissions(@Param("recordId", ParseUUIDPipe) recordId: string) {
    return this.sif.testSubmissions(recordId);
  }

  @Get()
  @RequirePermissions("sif_record.read")
  list(@Query() query: ListSifRecordsDto) {
    return this.sif.listForInvoice(query.invoiceId);
  }
}
