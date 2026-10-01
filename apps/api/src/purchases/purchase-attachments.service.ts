import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
} from "@nestjs/common";
import { Prisma, PurchaseInvoiceStatus } from "@prisma/client";
import { createHash } from "node:crypto";
import { AuditService } from "../audit/audit.service";
import { TenantContextService } from "../tenancy/tenant-context.service";

export const MAX_PURCHASE_ATTACHMENT_BYTES = 10 * 1024 * 1024;
const MAX_ATTACHMENTS_PER_INVOICE = 20;

export interface UploadedPurchaseAttachment {
  buffer: Buffer;
  originalname: string;
  mimetype: string;
  size: number;
}

const attachmentMetadata = {
  id: true,
  purchaseInvoiceId: true,
  originalName: true,
  mediaType: true,
  sizeBytes: true,
  sha256: true,
  createdById: true,
  createdAt: true,
} satisfies Prisma.PurchaseInvoiceAttachmentSelect;

@Injectable()
export class PurchaseAttachmentsService {
  constructor(
    private readonly tenant: TenantContextService,
    private readonly audit: AuditService,
  ) {}

  async list(purchaseInvoiceId: string) {
    await this.requirePurchase(purchaseInvoiceId);
    return this.tenant.db.purchaseInvoiceAttachment.findMany({
      where: { purchaseInvoiceId, ...this.scope() },
      select: attachmentMetadata,
      orderBy: [{ createdAt: "asc" }, { id: "asc" }],
    });
  }

  async upload(
    purchaseInvoiceId: string,
    file: UploadedPurchaseAttachment | undefined,
  ) {
    if (!file?.buffer?.length)
      throw new BadRequestException("A non-empty attachment is required");
    if (file.size !== file.buffer.length)
      throw new BadRequestException("Attachment size is invalid");
    if (file.size > MAX_PURCHASE_ATTACHMENT_BYTES)
      throw new BadRequestException("Attachment exceeds the 10 MiB limit");

    const mediaType = detectMediaType(file.buffer);
    if (!mediaType)
      throw new BadRequestException(
        "Only PDF, PNG, and JPEG files are allowed",
      );
    if (normalizeMediaType(file.mimetype) !== mediaType)
      throw new BadRequestException(
        "Attachment content does not match its declared media type",
      );

    const scope = this.scope();
    await this.lockPurchase(purchaseInvoiceId);
    const purchase = await this.requirePurchase(purchaseInvoiceId);
    this.requireDraft(purchase.status);
    const count = await this.tenant.db.purchaseInvoiceAttachment.count({
      where: { purchaseInvoiceId, ...scope },
    });
    if (count >= MAX_ATTACHMENTS_PER_INVOICE)
      throw new ConflictException(
        `A purchase invoice can have at most ${MAX_ATTACHMENTS_PER_INVOICE} attachments`,
      );

    const sha256 = createHash("sha256").update(file.buffer).digest("hex");
    try {
      const attachment = await this.tenant.db.purchaseInvoiceAttachment.create({
        data: {
          ...scope,
          purchaseInvoiceId,
          originalName: sanitizeFilename(file.originalname),
          mediaType,
          sizeBytes: file.size,
          sha256,
          content: file.buffer,
          createdById: this.tenant.required.userId,
        },
        select: attachmentMetadata,
      });
      await this.audit.record(
        "purchase_invoice.attachment_uploaded",
        "purchase_invoice_attachment",
        attachment.id,
        { purchaseInvoiceId, mediaType, sizeBytes: file.size, sha256 },
      );
      return attachment;
    } catch (error) {
      if (
        error instanceof Prisma.PrismaClientKnownRequestError &&
        error.code === "P2002"
      )
        throw new ConflictException(
          "This file is already attached to the purchase invoice",
        );
      throw error;
    }
  }

  async download(purchaseInvoiceId: string, attachmentId: string) {
    await this.requirePurchase(purchaseInvoiceId);
    const attachment = await this.tenant.db.purchaseInvoiceAttachment.findFirst(
      {
        where: {
          id: attachmentId,
          purchaseInvoiceId,
          ...this.scope(),
        },
        select: { originalName: true, mediaType: true, content: true },
      },
    );
    if (!attachment) throw new NotFoundException("Attachment not found");
    return attachment;
  }

  async delete(purchaseInvoiceId: string, attachmentId: string) {
    const scope = this.scope();
    await this.lockPurchase(purchaseInvoiceId);
    const purchase = await this.requirePurchase(purchaseInvoiceId);
    this.requireDraft(purchase.status);
    const result = await this.tenant.db.purchaseInvoiceAttachment.deleteMany({
      where: { id: attachmentId, purchaseInvoiceId, ...scope },
    });
    if (!result.count) throw new NotFoundException("Attachment not found");
    await this.audit.record(
      "purchase_invoice.attachment_deleted",
      "purchase_invoice_attachment",
      attachmentId,
      { purchaseInvoiceId },
    );
  }

  private requireDraft(status: PurchaseInvoiceStatus) {
    if (status !== PurchaseInvoiceStatus.DRAFT)
      throw new ConflictException(
        "Attachments can only be changed on purchase invoice drafts",
      );
  }

  private async lockPurchase(purchaseInvoiceId: string) {
    const scope = this.scope();
    const locked = await this.tenant.db.$queryRaw<Array<{ id: string }>>`
      SELECT "id" FROM "purchase_invoices"
      WHERE "id" = CAST(${purchaseInvoiceId} AS uuid)
        AND "organization_id" = CAST(${scope.organizationId} AS uuid)
        AND "company_id" = CAST(${scope.companyId} AS uuid)
      FOR UPDATE
    `;
    if (!locked.length)
      throw new NotFoundException("Purchase invoice not found");
  }

  private async requirePurchase(id: string) {
    const purchase = await this.tenant.db.purchaseInvoice.findFirst({
      where: { id, ...this.scope() },
      select: { status: true },
    });
    if (!purchase) throw new NotFoundException("Purchase invoice not found");
    return purchase;
  }

  private scope() {
    const { organizationId, companyId } = this.tenant.required;
    if (!companyId) throw new BadRequestException("x-company-id is required");
    return { organizationId, companyId };
  }
}

export function detectMediaType(content: Buffer) {
  if (content.subarray(0, 5).equals(Buffer.from("%PDF-")))
    return "application/pdf";
  if (
    content
      .subarray(0, 8)
      .equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))
  )
    return "image/png";
  if (
    content.length >= 5 &&
    content[0] === 0xff &&
    content[1] === 0xd8 &&
    content[2] === 0xff &&
    content.at(-2) === 0xff &&
    content.at(-1) === 0xd9
  )
    return "image/jpeg";
  return undefined;
}

export function normalizeMediaType(mediaType: string) {
  return mediaType.toLowerCase() === "image/jpg"
    ? "image/jpeg"
    : mediaType.toLowerCase();
}

export function sanitizeFilename(value: string) {
  const basename = value.split(/[\\/]/).at(-1) ?? "";
  const sanitized = basename
    .replace(/[\u0000-\u001f\u007f]/g, "")
    .trim()
    .replace(/^\.+/, "")
    .slice(0, 240);
  return sanitized || "attachment";
}
