import { Body, Controller, Get, HttpCode, Param, ParseUUIDPipe, Post, Query, StreamableFile } from "@nestjs/common";
import { RequirePermissions } from "../authorization/permissions.decorator";
import { TenantProtected } from "../tenancy/tenant.decorator";
import { LongTenantTransaction } from "../tenancy/long-tenant-transaction.decorator";
import { ListSifRecordsDto } from "./dto/list-sif-records.dto";
import { ExportSifPeriodDto } from "./dto/export-sif-period.dto";
import { RecoverRejectedRegistrationDto } from "./dto/recover-rejected-registration.dto";
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

  @Post(":invoiceId/rejected-registration-recovery")
  @HttpCode(200)
  @RequirePermissions("invoice.issue")
  rejectedRegistrationRecovery(
    @Param("invoiceId", ParseUUIDPipe) invoiceId: string,
    @Body() body: RecoverRejectedRegistrationDto,
  ) {
    return this.sif.recoverRejectedRegistration(invoiceId, body);
  }

  @Get("transition-audit")
  @RequirePermissions("sif_record.read")
  transitionAudit() {
    return this.sif.transitionAudit();
  }

  @Get("test-submissions/overview")
  @RequirePermissions("sif_record.read")
  testSubmissionOverview() {
    return this.sif.testSubmissionOverview();
  }

  @Get("submissions/overview")
  @RequirePermissions("sif_record.read")
  submissionOverview() {
    return this.sif.testSubmissionOverview();
  }

  @Get("submissions/incident")
  @RequirePermissions("invoice.read")
  remittanceIncident() {
    return this.sif.remittanceIncident();
  }

  @Get("verification")
  @LongTenantTransaction()
  @RequirePermissions("sif_record.read")
  verification() {
    return this.sif.verifyChain();
  }

  @Get("period-export")
  @LongTenantTransaction()
  @RequirePermissions("sif_record.read")
  async exportPeriod(@Query() query: ExportSifPeriodDto) {
    const file = await this.sif.exportPeriod(query.from, query.to);
    return new StreamableFile(file.content, {
      type: "application/zip",
      disposition: `attachment; filename="${file.filename}"`,
      length: file.content.length,
    });
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

  @Get(":recordId/submissions")
  @RequirePermissions("sif_record.read")
  submissions(@Param("recordId", ParseUUIDPipe) recordId: string) {
    return this.sif.testSubmissions(recordId);
  }

  @Get(":recordId/test-submissions/:submissionId/evidence")
  @RequirePermissions("sif_record.read")
  async exportTestSubmissionEvidence(
    @Param("recordId", ParseUUIDPipe) recordId: string,
    @Param("submissionId", ParseUUIDPipe) submissionId: string,
  ) {
    const file = await this.sif.exportTestSubmissionEvidence(recordId, submissionId);
    return new StreamableFile(file.content, {
      type: "application/json; charset=utf-8",
      disposition: `attachment; filename="${file.filename}"`,
      length: file.content.length,
    });
  }

  @Get(":recordId/submissions/:submissionId/evidence")
  @RequirePermissions("sif_record.read")
  async exportSubmissionEvidence(
    @Param("recordId", ParseUUIDPipe) recordId: string,
    @Param("submissionId", ParseUUIDPipe) submissionId: string,
  ) {
    return this.exportTestSubmissionEvidence(recordId, submissionId);
  }

  @Get()
  @RequirePermissions("sif_record.read")
  list(@Query() query: ListSifRecordsDto) {
    return this.sif.listForInvoice(query.invoiceId);
  }
}
