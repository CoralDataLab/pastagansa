import { BadRequestException, ConflictException, Injectable, NotFoundException } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { Prisma } from "@prisma/client";
import { createHash } from "node:crypto";
import { AuditService } from "../audit/audit.service";
import { CommandAuthorizationService } from "../commands/command-authorization.service";
import { TenantContextService } from "../tenancy/tenant-context.service";
import { TenantTransactionService } from "../tenancy/tenant-transaction.service";
import { detectMediaType, normalizeMediaType, sanitizeFilename, MAX_PURCHASE_ATTACHMENT_BYTES, type UploadedPurchaseAttachment } from "./purchase-attachments.service";
import { PurchaseCommandProposalEventsService } from "./purchase-command-proposal-events.service";

export const proposalDocumentMetadata = {
  id: true, proposalId: true, originalName: true, mediaType: true, sizeBytes: true,
  sha256: true, createdById: true, createdAt: true,
} satisfies Prisma.PurchaseProposalDocumentSelect;
export function proposalDocumentEvidence(documents: Array<{ id: string; sha256: string; originalName: string }> = []) {
  return documents.map((document) => ({
    reference: `purchase-proposal-document:${document.id}`,
    sha256: document.sha256,
    description: document.originalName,
  }));
}
export function validateProposalDocument(file: UploadedPurchaseAttachment | undefined) {
  if (!file?.buffer?.length || file.size !== file.buffer.length) throw new BadRequestException("A non-empty file with a valid size is required");
  if (file.size > MAX_PURCHASE_ATTACHMENT_BYTES) throw new BadRequestException("Document exceeds the 10 MiB limit");
  const mediaType = detectMediaType(file.buffer);
  if (!mediaType || normalizeMediaType(file.mimetype) !== mediaType) throw new BadRequestException("Only matching PDF, PNG or JPEG content is allowed");
  return { mediaType, sha256: createHash("sha256").update(file.buffer).digest("hex"), originalName: sanitizeFilename(file.originalname) };
}
@Injectable()
export class PurchaseProposalDocumentsService {
  constructor(private readonly tenant: TenantContextService, private readonly transactions: TenantTransactionService,
    private readonly authorization: CommandAuthorizationService, private readonly events: PurchaseCommandProposalEventsService,
    private readonly audit: AuditService, private readonly config: ConfigService) {}
  private run<T>(permissions: string[], work: () => Promise<T>) {
    if (this.config.get<string>("AI_NATIVE_ENABLED") !== "true") throw new NotFoundException("Command proposal pilot is disabled");
    return this.transactions.run(this.tenant.required, async () => { await this.authorization.require(permissions); return work(); });
  }
  private scope() {
    const { organizationId, companyId } = this.tenant.required;
    if (!companyId) throw new BadRequestException("Company context required");
    return { organizationId, companyId };
  }
  private async proposal(id: string) {
    const proposal = await this.tenant.db.commandProposal.findFirst({ where: { id, ...this.scope(), name: "registrar_factura_recibida" }, select: { status: true } });
    if (!proposal) throw new NotFoundException("Proposal not found");
    return proposal;
  }
  upload(proposalId: string, file: UploadedPurchaseAttachment | undefined) {
    return this.run(["command_proposal.create", "command_proposal.read"], async () => {
      const validated = validateProposalDocument(file);
      const scope = this.scope();
      await this.tenant.db.$queryRaw`SELECT "id" FROM "command_proposals" WHERE "id" = CAST(${proposalId} AS uuid) AND "organization_id" = CAST(${scope.organizationId} AS uuid) AND "company_id" = CAST(${scope.companyId} AS uuid) FOR UPDATE`;
      const proposal = await this.proposal(proposalId);
      const existing = await this.tenant.db.purchaseProposalDocument.findFirst({ where: { proposalId, ...scope, sha256: validated.sha256 }, select: proposalDocumentMetadata });
      // An identical retry may retrieve the original receipt after the decision; never add new data.
      if (existing) return existing;
      if (proposal.status !== "PENDING_REVIEW") throw new ConflictException("Documents cannot be added after a final decision");
      if (await this.tenant.db.purchaseProposalDocument.count({ where: { proposalId, ...scope } }) >= 20) throw new ConflictException("At most 20 documents per proposal");
      const document = await this.tenant.db.purchaseProposalDocument.create({ data: {
        ...scope, proposalId, ...validated, sizeBytes: file!.size, content: file!.buffer, createdById: this.tenant.required.userId,
      }, select: proposalDocumentMetadata });
      await this.events.record(proposalId, "command_proposal.document_uploaded", {
        documentId: document.id,
        sha256: validated.sha256,
        mediaType: validated.mediaType,
        sizeBytes: file!.size,
      });
      await this.audit.record("command_proposal.document_uploaded", "purchase_proposal_document", document.id,
        { proposalId, sha256: validated.sha256, mediaType: validated.mediaType, sizeBytes: file!.size });
      return document;
    });
  }
  download(proposalId: string, documentId: string) {
    return this.run(["command_proposal.read"], async () => {
      await this.proposal(proposalId);
      const document = await this.tenant.db.purchaseProposalDocument.findFirst({ where: { id: documentId, proposalId, ...this.scope() }, select: { ...proposalDocumentMetadata, content: true } });
      if (!document) throw new NotFoundException("Document not found");
      if (createHash("sha256").update(document.content).digest("hex") !== document.sha256) throw new ConflictException("Document integrity check failed");
      return document;
    });
  }
}
