import {
  Body,
  Controller,
  Get,
  HttpCode,
  Param,
  ParseUUIDPipe,
  Post,
  Query,
  StreamableFile,
  UploadedFile,
  UseInterceptors,
} from "@nestjs/common";
import { FileInterceptor } from "@nestjs/platform-express";
import { ConfigService } from "@nestjs/config";
import { RequirePermissions } from "../authorization/permissions.decorator";
import { TenantProtected } from "../tenancy/tenant.decorator";
import {
  AssignPurchaseCommandProposalDto,
  CreatePurchaseCommandProposalDto,
  ExecutePurchaseCommandProposalDto,
  ListPurchaseCommandProposalsDto,
  RejectPurchaseCommandProposalDto,
} from "./dto/purchase-command-proposal.dto";
import { PurchaseCommandProposalsService } from "./purchase-command-proposals.service";
import {
  MAX_PURCHASE_ATTACHMENT_BYTES,
  UploadedPurchaseAttachment,
} from "./purchase-attachments.service";
import { PurchaseProposalDocumentsService } from "./purchase-proposal-documents.service";

@Controller("purchase-command-proposals")
@TenantProtected()
export class PurchaseCommandProposalsController {
  constructor(
    private readonly proposals: PurchaseCommandProposalsService,
    private readonly documents: PurchaseProposalDocumentsService,
    private readonly config: ConfigService,
  ) {}

  @Get("capabilities")
  @RequirePermissions("command_proposal.read")
  capabilities() {
    return { enabled: this.config.get<string>("AI_NATIVE_ENABLED") === "true" };
  }

  @Post()
  @RequirePermissions("command_proposal.create")
  create(@Body() input: CreatePurchaseCommandProposalDto) {
    return this.proposals.create(input);
  }

  @Get()
  @RequirePermissions("command_proposal.read")
  list(@Query() query: ListPurchaseCommandProposalsDto) {
    return this.proposals.list(query);
  }

  @Get("assignees")
  @RequirePermissions("command_proposal.review")
  assignees() {
    return this.proposals.assignees();
  }

  @Get(":id/projection")
  @RequirePermissions("command_proposal.read")
  projection(@Param("id", ParseUUIDPipe) id: string) {
    return this.proposals.projection(id);
  }

  @Get(":id")
  @RequirePermissions("command_proposal.read")
  get(@Param("id", ParseUUIDPipe) id: string) {
    return this.proposals.get(id);
  }

  @Post(":id/documents")
  @UseInterceptors(
    FileInterceptor("file", {
      limits: { fileSize: MAX_PURCHASE_ATTACHMENT_BYTES, files: 1 },
    }),
  )
  @RequirePermissions("command_proposal.create", "command_proposal.read")
  uploadDocument(
    @Param("id", ParseUUIDPipe) id: string,
    @UploadedFile() file: UploadedPurchaseAttachment | undefined,
  ) {
    return this.documents.upload(id, file);
  }

  @Get(":id/documents/:documentId/download")
  @RequirePermissions("command_proposal.read")
  async downloadDocument(
    @Param("id", ParseUUIDPipe) id: string,
    @Param("documentId", ParseUUIDPipe) documentId: string,
  ) {
    const document = await this.documents.download(id, documentId);
    return new StreamableFile(Buffer.from(document.content), {
      type: document.mediaType,
      disposition: contentDisposition(document.originalName),
      length: document.content.length,
    });
  }

  @Post(":id/assign")
  @HttpCode(200)
  @RequirePermissions("command_proposal.review")
  assign(
    @Param("id", ParseUUIDPipe) id: string,
    @Body() input: AssignPurchaseCommandProposalDto,
  ) {
    return this.proposals.assign(id, input);
  }

  @Post(":id/execute")
  @HttpCode(200)
  @RequirePermissions("command_proposal.review", "purchase_invoice.create")
  execute(
    @Param("id", ParseUUIDPipe) id: string,
    @Body() input: ExecutePurchaseCommandProposalDto,
  ) {
    return this.proposals.execute(id, input);
  }

  @Post(":id/reject")
  @HttpCode(200)
  @RequirePermissions("command_proposal.review")
  reject(
    @Param("id", ParseUUIDPipe) id: string,
    @Body() input: RejectPurchaseCommandProposalDto,
  ) {
    return this.proposals.reject(id, input);
  }
}

function contentDisposition(filename: string) {
  const ascii = filename
    .normalize("NFKD")
    .replace(/[^\x20-\x7e]/g, "")
    .replace(/["\\]/g, "_")
    .trim();
  return `attachment; filename="${ascii || "document"}"`;
}
