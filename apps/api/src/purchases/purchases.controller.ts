import {
  BadRequestException,
  Body,
  Controller,
  Delete,
  Get,
  Headers,
  HttpCode,
  Param,
  ParseUUIDPipe,
  Patch,
  Post,
  Put,
  Query,
  StreamableFile,
  UploadedFile,
  UseInterceptors,
} from "@nestjs/common";
import { FileInterceptor } from "@nestjs/platform-express";
import { RequirePermissions } from "../authorization/permissions.decorator";
import { TenantProtected } from "../tenancy/tenant.decorator";
import { ApprovePurchaseInvoiceDto } from "./dto/approve-purchase-invoice.dto";
import { RejectPurchaseInvoiceDto } from "./dto/purchase-approval.dto";
import { ListPurchaseInvoicesDto } from "./dto/list-purchase-invoices.dto";
import { RecordSupplierPaymentDto } from "./dto/record-supplier-payment.dto";
import {
  PurchasePaymentScheduleQueryDto,
  SetPurchasePaymentScheduleDto,
} from "./dto/purchase-payment-schedule.dto";
import {
  CreatePurchaseInvoiceDto,
  UpdatePurchaseInvoiceDto,
} from "./dto/purchase-invoice.dto";
import { PurchasesService } from "./purchases.service";
import { SupplierPaymentsService } from "./supplier-payments.service";
import {
  MAX_PURCHASE_ATTACHMENT_BYTES,
  PurchaseAttachmentsService,
  UploadedPurchaseAttachment,
} from "./purchase-attachments.service";

@Controller("purchase-invoices")
@TenantProtected()
export class PurchasesController {
  constructor(
    private readonly purchases: PurchasesService,
    private readonly supplierPayments: SupplierPaymentsService,
    private readonly attachments: PurchaseAttachmentsService,
  ) {}

  @Get()
  @RequirePermissions("purchase_invoice.read")
  list(@Query() query: ListPurchaseInvoicesDto) {
    return this.purchases.list(query);
  }

  @Get("withholdings")
  @RequirePermissions("supplier_payment.read")
  withholdings(@Query("year") year: string) {
    return this.supplierPayments.withholdingSummary(Number(year));
  }

  @Get(":id")
  @RequirePermissions("purchase_invoice.read")
  get(@Param("id", ParseUUIDPipe) id: string) {
    return this.purchases.get(id);
  }

  @Post()
  @RequirePermissions("purchase_invoice.create")
  create(@Body() input: CreatePurchaseInvoiceDto) {
    return this.purchases.create(input);
  }

  @Patch(":id")
  @RequirePermissions("purchase_invoice.update")
  update(
    @Param("id", ParseUUIDPipe) id: string,
    @Body() input: UpdatePurchaseInvoiceDto,
  ) {
    return this.purchases.update(id, input);
  }

  @Post(":id/approve")
  @HttpCode(200)
  @RequirePermissions("purchase_invoice.approve")
  approve(
    @Param("id", ParseUUIDPipe) id: string,
    @Headers("idempotency-key") idempotencyKey: string | undefined,
    @Body() input: ApprovePurchaseInvoiceDto,
  ) {
    return this.purchases.approve(
      id,
      input,
      requireIdempotencyKey(idempotencyKey),
    );
  }

  @Post(":id/reject")
  @HttpCode(200)
  @RequirePermissions("purchase_invoice.approve")
  reject(
    @Param("id", ParseUUIDPipe) id: string,
    @Body() input: RejectPurchaseInvoiceDto,
  ) {
    return this.purchases.reject(id, input);
  }

  @Get(":id/payment-schedule")
  @RequirePermissions("purchase_invoice.read")
  paymentSchedule(
    @Param("id", ParseUUIDPipe) id: string,
    @Query() query: PurchasePaymentScheduleQueryDto,
  ) {
    return this.supplierPayments.getSchedule(id, query);
  }

  @Put(":id/payment-schedule")
  @RequirePermissions("purchase_invoice.update")
  setPaymentSchedule(
    @Param("id", ParseUUIDPipe) id: string,
    @Body() input: SetPurchasePaymentScheduleDto,
  ) {
    return this.supplierPayments.setSchedule(id, input);
  }

  @Get(":id/payments")
  @RequirePermissions("supplier_payment.read")
  payments(@Param("id", ParseUUIDPipe) id: string) {
    return this.supplierPayments.list(id);
  }

  @Post(":id/payments")
  @RequirePermissions("supplier_payment.create")
  recordPayment(
    @Param("id", ParseUUIDPipe) id: string,
    @Headers("idempotency-key") idempotencyKey: string | undefined,
    @Body() input: RecordSupplierPaymentDto,
  ) {
    return this.supplierPayments.record(
      id,
      input,
      requireIdempotencyKey(idempotencyKey),
    );
  }

  @Get(":id/attachments")
  @RequirePermissions("purchase_invoice.read")
  listAttachments(@Param("id", ParseUUIDPipe) id: string) {
    return this.attachments.list(id);
  }

  @Post(":id/attachments")
  @UseInterceptors(
    FileInterceptor("file", {
      limits: { fileSize: MAX_PURCHASE_ATTACHMENT_BYTES, files: 1 },
    }),
  )
  @RequirePermissions("purchase_invoice.update")
  uploadAttachment(
    @Param("id", ParseUUIDPipe) id: string,
    @UploadedFile() file: UploadedPurchaseAttachment | undefined,
  ) {
    return this.attachments.upload(id, file);
  }

  @Get(":id/attachments/:attachmentId/download")
  @RequirePermissions("purchase_invoice.read")
  async downloadAttachment(
    @Param("id", ParseUUIDPipe) id: string,
    @Param("attachmentId", ParseUUIDPipe) attachmentId: string,
  ) {
    const attachment = await this.attachments.download(id, attachmentId);
    return new StreamableFile(Buffer.from(attachment.content), {
      type: attachment.mediaType,
      disposition: contentDisposition(attachment.originalName),
      length: attachment.content.length,
    });
  }

  @Delete(":id/attachments/:attachmentId")
  @HttpCode(204)
  @RequirePermissions("purchase_invoice.update")
  deleteAttachment(
    @Param("id", ParseUUIDPipe) id: string,
    @Param("attachmentId", ParseUUIDPipe) attachmentId: string,
  ) {
    return this.attachments.delete(id, attachmentId);
  }

  @Delete(":id")
  @HttpCode(204)
  @RequirePermissions("purchase_invoice.delete")
  delete(@Param("id", ParseUUIDPipe) id: string) {
    return this.purchases.delete(id);
  }
}

function contentDisposition(filename: string) {
  const ascii = filename
    .normalize("NFKD")
    .replace(/[^\x20-\x7e]/g, "")
    .replace(/["\\]/g, "_")
    .trim();
  return `attachment; filename="${ascii || "attachment"}"`;
}

function requireIdempotencyKey(value: string | undefined) {
  const key = value?.trim();
  if (!key || key.length > 128 || /[\u0000-\u001f\u007f]/.test(key))
    throw new BadRequestException(
      "Idempotency-Key must contain between 1 and 128 printable characters",
    );
  return key;
}
