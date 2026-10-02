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
import { PurchaseCommandProposalEventsService } from "./purchase-command-proposal-events.service";
import {
  OCR_PREVIEW_MAX_AGE_MS,
  ocrPreviewKey,
  signOcrPreview,
  SignedOcrPreviewContent,
  verifyOcrPreview,
} from "./purchase-ocr-preview-signature";

@Injectable()
export class PurchaseProposalIntakeService {
  constructor(
    private readonly tenant: TenantContextService,
    private readonly transactions: TenantTransactionService,
    private readonly authorization: CommandAuthorizationService,
    private readonly engine: PurchaseOcrEngine,
    private readonly proposals: PurchaseCommandProposalsService,
    private readonly documents: PurchaseProposalDocumentsService,
    private readonly events: PurchaseCommandProposalEventsService,
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
      // Rounded to the stored NUMERIC(5,2) precision so signature, row and event agree.
      const confidence = Math.round(Math.max(0, Math.min(100, result.confidence)) * 100) / 100;
      const text = result.text.slice(0, 100_000);
      const fields = extractPurchaseFields(text, confidence);
      const content: SignedOcrPreviewContent = {
        sha256: document.sha256,
        engine: "tesseract-spa-local",
        engineVersion: "1",
        rawText: text,
        confidence,
        fields,
        issuedAt: new Date().toISOString(),
      };
      return {
        ...content,
        fields,
        originalName: document.originalName,
        signature: signOcrPreview(this.previewKey(), this.tenant.required, content),
      };
    }, 120_000);
  }

  create(
    input: CreatePurchaseCommandProposalDto,
    file: UploadedPurchaseAttachment | undefined,
    rawOcrPreview?: string,
  ) {
    return this.run(["command_proposal.create", "command_proposal.read"], async () => {
      const document = validateProposalDocument(file);
      const normalized = await validateCommandInput(CreatePurchaseCommandProposalDto, input);
      const ocrPreview = this.verifiedOcrPreview(rawOcrPreview, document.sha256);
      const proposal = await this.proposals.create({
        ...normalized,
        evidence: [...normalized.evidence, {
          reference: `intake-document:${document.sha256}`,
          sha256: document.sha256,
          description: document.originalName,
        }],
      });
      const storedDocument = await this.documents.upload(proposal.id, file);
      if (ocrPreview) await this.storeOcrExtraction(proposal.id, storedDocument.id, ocrPreview);
      return this.proposals.get(proposal.id);
    });
  }

  private previewKey() {
    const secret = this.config.get<string>("JWT_SECRET");
    if (!secret) throw new Error("JWT_SECRET is required to sign OCR previews");
    return ocrPreviewKey(secret);
  }

  private verifiedOcrPreview(raw: string | undefined, expectedSha256: string) {
    const preview = parseOcrPreview(raw, expectedSha256);
    if (!preview) return null;
    if (!verifyOcrPreview(this.previewKey(), this.tenant.required, preview.content, preview.signature))
      throw new BadRequestException("OCR preview signature is invalid; read the document again");
    const age = Date.now() - Date.parse(preview.content.issuedAt);
    if (!(age >= -60_000 && age <= OCR_PREVIEW_MAX_AGE_MS))
      throw new BadRequestException("OCR preview has expired; read the document again");
    return preview.content;
  }

  private async storeOcrExtraction(
    proposalId: string,
    documentId: string,
    extraction: SignedOcrPreviewContent,
  ) {
    const { organizationId, companyId, userId } = this.tenant.required;
    const rows = await this.tenant.db.$queryRaw<Array<{ id: string }>>`
      INSERT INTO "purchase_proposal_ocr_extractions" (
        "organization_id", "company_id", "proposal_id", "document_id", "document_sha256",
        "engine", "engine_version", "confidence", "raw_text", "fields", "created_by_id"
      ) VALUES (
        CAST(${organizationId} AS uuid), CAST(${companyId} AS uuid), CAST(${proposalId} AS uuid),
        CAST(${documentId} AS uuid), ${extraction.sha256}, ${extraction.engine}, ${extraction.engineVersion},
        ${extraction.confidence}, ${extraction.rawText}, CAST(${JSON.stringify(extraction.fields)} AS jsonb),
        CAST(${userId} AS uuid)
      )
      ON CONFLICT ("document_id") DO NOTHING
      RETURNING "id"
    `;
    if (!rows.length) return;
    await this.events.record(proposalId, "command_proposal.ocr_extraction_stored", {
      extractionId: rows[0].id,
      documentId,
      sha256: extraction.sha256,
      engine: extraction.engine,
      engineVersion: extraction.engineVersion,
      confidence: extraction.confidence,
    });
  }
}

function parseOcrPreview(
  raw: string | undefined,
  expectedSha256: string,
): { content: SignedOcrPreviewContent; signature: string } | null {
  if (!raw) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new BadRequestException("OCR preview evidence must be valid JSON");
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed))
    throw new BadRequestException("OCR preview evidence must be an object");
  const value = parsed as Record<string, unknown>;
  if (value.sha256 !== expectedSha256)
    throw new BadRequestException("OCR preview does not match the uploaded document");
  if (typeof value.signature !== "string")
    throw new BadRequestException("OCR preview signature is required");
  const engine = stringField(value.engine, "OCR engine", 120);
  const engineVersion = stringField(value.engineVersion, "OCR engine version", 120);
  const rawText = stringField(value.rawText, "OCR raw text", 100_000, true);
  const issuedAt = stringField(value.issuedAt, "OCR preview issue time", 40);
  const confidence = value.confidence;
  if (typeof confidence !== "number" || !Number.isFinite(confidence) || confidence < 0 || confidence > 100)
    throw new BadRequestException("OCR confidence must be between 0 and 100");
  if (!value.fields || typeof value.fields !== "object" || Array.isArray(value.fields))
    throw new BadRequestException("OCR fields must be an object");
  const fields = value.fields as Record<string, unknown>;
  return {
    content: { sha256: expectedSha256, engine, engineVersion, confidence, rawText, fields, issuedAt },
    signature: value.signature,
  };
}

function stringField(value: unknown, label: string, max: number, allowEmpty = false) {
  if (typeof value !== "string") throw new BadRequestException(`${label} must be text`);
  const trimmed = value.trim();
  if (!allowEmpty && !trimmed) throw new BadRequestException(`${label} is required`);
  if (value.length > max) throw new BadRequestException(`${label} is too long`);
  return value;
}
