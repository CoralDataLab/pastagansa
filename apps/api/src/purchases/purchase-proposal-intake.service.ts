import { BadRequestException, Injectable, NotFoundException } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { validateCommandInput } from "../commands/validate-command-input";
import { CommandAuthorizationService } from "../commands/command-authorization.service";
import { TenantContextService } from "../tenancy/tenant-context.service";
import { TenantTransactionService } from "../tenancy/tenant-transaction.service";
import { PurchaseOcrEngine } from "./purchase-ocr-engine.service";
import { extractPurchaseFields } from "./purchase-ocr.parser";
import { validateOcrDimensions } from "./purchase-ocr-image";
import { UploadedPurchaseAttachment } from "./purchase-attachments.service";
import { PurchaseCommandProposalsService } from "./purchase-command-proposals.service";
import { PurchaseProposalDocumentsService, validateProposalDocument } from "./purchase-proposal-documents.service";
import { CreatePurchaseCommandProposalDto } from "./dto/purchase-command-proposal.dto";

@Injectable()
export class PurchaseProposalIntakeService {
  constructor(
    private readonly tenant: TenantContextService,
    private readonly transactions: TenantTransactionService,
    private readonly authorization: CommandAuthorizationService,
    private readonly engine: PurchaseOcrEngine,
    private readonly proposals: PurchaseCommandProposalsService,
    private readonly documents: PurchaseProposalDocumentsService,
    private readonly config: ConfigService,
  ) {}

  private run<T>(permissions: string[], work: () => Promise<T>, timeout = 15_000) {
    if (this.config.get<string>("AI_NATIVE_ENABLED") !== "true")
      throw new NotFoundException("Command proposal pilot is disabled");
    return this.transactions.run(this.tenant.required, async () => {
      await this.authorization.require(permissions);
      return work();
    }, timeout);
  }

  preview(file: UploadedPurchaseAttachment | undefined) {
    return this.run(["command_proposal.create", "command_proposal.read", "purchase_invoice.ocr"], async () => {
      const document = validateProposalDocument(file);
      if (!["image/png", "image/jpeg"].includes(document.mediaType))
        throw new BadRequestException("Local OCR intake supports PNG/JPEG only; PDF is not supported yet");
      validateOcrDimensions(file!.buffer, document.mediaType);
      const result = await this.engine.recognize(file!.buffer);
      const confidence = Math.max(0, Math.min(100, result.confidence));
      const text = result.text.slice(0, 100_000);
      return {
        sha256: document.sha256,
        originalName: document.originalName,
        engine: "tesseract-spa-local",
        rawText: text,
        confidence,
        fields: extractPurchaseFields(text, confidence),
      };
    }, 120_000);
  }

  create(input: CreatePurchaseCommandProposalDto, file: UploadedPurchaseAttachment | undefined) {
    return this.run(["command_proposal.create", "command_proposal.read"], async () => {
      const document = validateProposalDocument(file);
      const normalized = await validateCommandInput(CreatePurchaseCommandProposalDto, input);
      const proposal = await this.proposals.create({
        ...normalized,
        evidence: [...normalized.evidence, {
          reference: `intake-document:${document.sha256}`,
          sha256: document.sha256,
          description: document.originalName,
        }],
      });
      await this.documents.upload(proposal.id, file);
      return this.proposals.get(proposal.id);
    });
  }
}
