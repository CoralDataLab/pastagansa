import { createHmac, timingSafeEqual } from "node:crypto";
import { canonicalJson } from "../commands/command-json";

// Signed previews let the client carry server-produced OCR output back to
// proposal creation without being able to alter it.
export const OCR_PREVIEW_MAX_AGE_MS = 24 * 60 * 60 * 1000;

export type OcrPreviewSubject = {
  organizationId: string;
  companyId?: string;
  userId: string;
};

export type SignedOcrPreviewContent = {
  sha256: string;
  engine: string;
  engineVersion: string;
  confidence: number;
  rawText: string;
  fields: Record<string, unknown>;
  issuedAt: string;
};

export function ocrPreviewKey(secret: string) {
  return createHmac("sha256", secret).update("purchase-ocr-preview:v1").digest();
}

export function signOcrPreview(key: Buffer, subject: OcrPreviewSubject, content: SignedOcrPreviewContent) {
  return createHmac("sha256", key)
    .update(canonicalJson({
      organizationId: subject.organizationId,
      companyId: subject.companyId ?? null,
      userId: subject.userId,
      sha256: content.sha256,
      engine: content.engine,
      engineVersion: content.engineVersion,
      confidence: content.confidence,
      rawText: content.rawText,
      fields: content.fields,
      issuedAt: content.issuedAt,
    }))
    .digest("hex");
}

export function verifyOcrPreview(
  key: Buffer,
  subject: OcrPreviewSubject,
  content: SignedOcrPreviewContent,
  signature: string,
) {
  if (!/^[0-9a-f]{64}$/.test(signature)) return false;
  const expected = Buffer.from(signOcrPreview(key, subject, content), "hex");
  return timingSafeEqual(expected, Buffer.from(signature, "hex"));
}
