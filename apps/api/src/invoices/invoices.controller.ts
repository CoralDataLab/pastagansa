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
  Query,
  StreamableFile,
} from "@nestjs/common";
import { RequirePermissions } from "../authorization/permissions.decorator";
import { TenantProtected } from "../tenancy/tenant.decorator";
import { CreateRectificationDto } from "./dto/create-rectification.dto";
import { CancelIssuedInErrorDto } from "./dto/cancel-issued-in-error.dto";
import { CreateInvoiceDto, UpdateInvoiceDto } from "./dto/invoice.dto";
import { ListInvoicesDto } from "./dto/list-invoices.dto";
import { IssueInvoiceDto } from "./dto/issue-invoice.dto";
import { SendInvoiceEmailDto } from "./dto/send-invoice-email.dto";
import { PaymentReminderPreviewDto } from "./dto/payment-reminder.dto";
import { InvoiceEmailService } from "./invoice-email.service";
import { InvoicesService } from "./invoices.service";
import { CommercialEventsService } from "../commercial-events/commercial-events.service";
import { CreateCommercialEventDto } from "../commercial-events/dto/create-commercial-event.dto";
import { ListCommercialEventsDto } from "../commercial-events/dto/list-commercial-events.dto";

@Controller("invoices")
@TenantProtected()
export class InvoicesController {
  constructor(
    private readonly invoices: InvoicesService,
    private readonly emails: InvoiceEmailService,
    private readonly commercialEvents: CommercialEventsService,
  ) {}

  @Get()
  @RequirePermissions("invoice.read")
  list(@Query() query: ListInvoicesDto) {
    return this.invoices.list(query);
  }

  @Get("email-capability")
  @RequirePermissions("invoice.read")
  emailCapability() {
    return this.emails.capability();
  }

  @Get(":id")
  @RequirePermissions("invoice.read")
  get(@Param("id", ParseUUIDPipe) id: string) {
    return this.invoices.get(id);
  }

  @Get(":id/pdf")
  @RequirePermissions("invoice.read")
  async pdf(@Param("id", ParseUUIDPipe) id: string) {
    const file = await this.invoices.downloadPdf(id);
    return new StreamableFile(file.content, {
      type: "application/pdf",
      disposition: `attachment; filename="${file.filename}"`,
      length: file.content.length,
    });
  }

  @Get(":id/email-deliveries")
  @RequirePermissions("invoice.read")
  deliveries(@Param("id", ParseUUIDPipe) id: string) {
    return this.emails.list(id);
  }

  @Get(":id/commercial-events")
  @RequirePermissions("invoice.read", "collections.read")
  commercialEventsList(
    @Param("id", ParseUUIDPipe) id: string,
    @Query() query: ListCommercialEventsDto,
  ) {
    return this.commercialEvents.listInvoice(id, query);
  }

  @Post()
  @RequirePermissions("invoice.create")
  create(@Body() input: CreateInvoiceDto) {
    return this.invoices.create(input);
  }

  @Post(":id/rectifications")
  @RequirePermissions("invoice.create")
  createRectification(
    @Param("id", ParseUUIDPipe) id: string,
    @Body() input: CreateRectificationDto,
  ) {
    return this.invoices.createRectification(id, input);
  }

  @Patch(":id")
  @RequirePermissions("invoice.update")
  update(
    @Param("id", ParseUUIDPipe) id: string,
    @Body() input: UpdateInvoiceDto,
  ) {
    return this.invoices.update(id, input);
  }

  @Post(":id/issue")
  @HttpCode(200)
  @RequirePermissions("invoice.issue")
  issue(
    @Param("id", ParseUUIDPipe) id: string,
    @Headers("idempotency-key") idempotencyKey: string | undefined,
    @Body() input: IssueInvoiceDto,
  ) {
    return this.invoices.issue(
      id,
      input,
      requireIdempotencyKey(idempotencyKey),
    );
  }

  @Post(":id/cancel-issued-in-error")
  @HttpCode(200)
  @RequirePermissions("invoice.issue")
  cancelIssuedInError(
    @Param("id", ParseUUIDPipe) id: string,
    @Body() input: CancelIssuedInErrorDto,
  ) {
    return this.invoices.cancelIssuedInError(id, input);
  }

  @Post(":id/email")
  @HttpCode(202)
  @RequirePermissions("document.send")
  email(
    @Param("id", ParseUUIDPipe) id: string,
    @Headers("idempotency-key") idempotencyKey: string | undefined,
    @Body() input: SendInvoiceEmailDto,
  ) {
    return this.emails.enqueue(
      id,
      input,
      requireIdempotencyKey(idempotencyKey),
    );
  }

  @Post(":id/payment-reminder/preview")
  @RequirePermissions("invoice.read", "collections.manage")
  previewPaymentReminder(
    @Param("id", ParseUUIDPipe) id: string,
    @Body() input: PaymentReminderPreviewDto,
  ) {
    return this.emails.previewPaymentReminder(
      id,
      input.template,
      input.recipient,
    );
  }

  @Post(":id/payment-reminder")
  @HttpCode(202)
  @RequirePermissions("invoice.read", "collections.manage")
  paymentReminder(
    @Param("id", ParseUUIDPipe) id: string,
    @Headers("idempotency-key") idempotencyKey: string | undefined,
    @Body() input: PaymentReminderPreviewDto,
  ) {
    return this.emails.enqueuePaymentReminder(
      id,
      input.template,
      requireIdempotencyKey(idempotencyKey),
      input.recipient,
    );
  }

  @Post(":id/commercial-events")
  @HttpCode(201)
  @RequirePermissions("invoice.read", "collections.manage")
  commercialEvent(
    @Param("id", ParseUUIDPipe) id: string,
    @Body() input: CreateCommercialEventDto,
  ) {
    return this.commercialEvents.recordInvoice(id, input);
  }

  @Delete(":id")
  @HttpCode(204)
  @RequirePermissions("invoice.delete")
  delete(@Param("id", ParseUUIDPipe) id: string) {
    return this.invoices.delete(id);
  }
}

function requireIdempotencyKey(value: string | undefined) {
  const key = value?.trim();
  if (!key || key.length > 128 || /[\u0000-\u001f\u007f]/.test(key))
    throw new BadRequestException(
      "Idempotency-Key must contain between 1 and 128 printable characters",
    );
  return key;
}
