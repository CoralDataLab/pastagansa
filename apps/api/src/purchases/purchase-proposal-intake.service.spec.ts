import { BadRequestException } from "@nestjs/common";
import { createHash } from "node:crypto";
import { PurchaseProposalIntakeService } from "./purchase-proposal-intake.service";

const tenantUser = { userId: "user", organizationId: "org", companyId: "company" };

function setup(enabled = "true", required = tenantUser) {
  const transactions = { run: jest.fn(async (_context, work) => work()) };
  const authorization = { require: jest.fn().mockResolvedValue(undefined) };
  const engine = { recognize: jest.fn().mockResolvedValue({ text: "FACTURA: F-123\nBASE IMPONIBLE: 100,00 EUR", confidence: 90 }) };
  const proposals = { create: jest.fn().mockResolvedValue({ id: "proposal" }), get: jest.fn().mockResolvedValue({ id: "proposal", documents: [{}] }) };
  const documents = { upload: jest.fn().mockResolvedValue({ id: "document" }) };
  const db = { $queryRaw: jest.fn().mockResolvedValue([{ id: "extraction" }]) };
  const events = { record: jest.fn().mockResolvedValue(undefined) };
  const service = new PurchaseProposalIntakeService(
    { required, db } as never,
    transactions as never, authorization as never, engine as never,
    proposals as never, documents as never, events as never,
    { get: (key: string) => key === "JWT_SECRET" ? "test-secret-with-at-least-32-characters" : enabled } as never,
  );
  const buffer = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aEXcAAAAASUVORK5CYII=", "base64");
  const file = { buffer, size: buffer.length, mimetype: "image/png", originalname: "test.png" };
  return { service, authorization, engine, transactions, proposals, documents, db, events, file };
}
const input = {
  commandId: "test-command",
  payload: {
    supplierId: "11111111-1111-4111-8111-111111111111",
    supplierInvoiceNumber: "F-123", issueDate: "2026-10-01", receivedDate: "2026-10-01",
    lines: [{ description: "Service", quantity: 1, unitPrice: 100, deductiblePct: 100 }],
  },
  evidence: [], provenance: { channel: "UPLOAD" },
};

describe("local OCR proposal intake", () => {
  it("returns local suggestions without creating a proposal or purchase", async () => {
    const { service, file, engine, proposals, authorization } = setup();
    const result = await service.preview(file);
    expect(result.engine).toBe("tesseract-spa-local");
    expect(result.fields.taxableBase?.value).toBe("100.00");
    expect(engine.recognize).toHaveBeenCalledWith(file.buffer);
    expect(proposals.create).not.toHaveBeenCalled();
    expect(authorization.require).toHaveBeenCalledWith(["command_proposal.create", "command_proposal.read", "purchase_invoice.ocr"]);
  });
  it("does not run OCR when the pilot or permissions prohibit it", async () => {
    const disabled = setup("false");
    expect(() => disabled.service.preview(disabled.file)).toThrow("disabled");
    expect(disabled.engine.recognize).not.toHaveBeenCalled();
    const denied = setup();
    denied.authorization.require.mockRejectedValueOnce(new Error("denied"));
    await expect(denied.service.preview(denied.file)).rejects.toThrow("denied");
    expect(denied.engine.recognize).not.toHaveBeenCalled();
  });
  it("rejects excessive decoded image sizes before OCR", async () => {
    const { service, file, engine } = setup();
    const buffer = Buffer.from(file.buffer);
    buffer.writeUInt32BE(10000, 16);
    await expect(service.preview({ ...file, buffer })).rejects.toThrow("megapixels");
    expect(engine.recognize).not.toHaveBeenCalled();
  });
  it("rejects PDF before OCR", async () => {
    const { service, file, engine } = setup();
    const buffer = Buffer.from("%PDF-1.4 test");
    await expect(service.preview({ ...file, buffer, size: buffer.length, mimetype: "application/pdf" })).rejects.toBeInstanceOf(BadRequestException);
    expect(engine.recognize).not.toHaveBeenCalled();
  });
  it("creates a proposal and attaches the original inside the same transaction boundary", async () => {
    const { service, file, proposals, documents, transactions } = setup();
    await service.create(input as never, file);
    expect(transactions.run).toHaveBeenCalledTimes(1);
    expect(proposals.create).toHaveBeenCalledWith(expect.objectContaining({
      evidence: [expect.objectContaining({ reference: expect.stringMatching(/^intake-document:/), sha256: expect.stringMatching(/^[a-f0-9]{64}$/) })],
    }));
    expect(documents.upload).toHaveBeenCalledWith("proposal", file);
    expect(proposals.get).toHaveBeenCalledWith("proposal");
  });
  it("signs the preview it produces", async () => {
    const { service, file } = setup();
    const result = await service.preview(file);
    expect(result.signature).toMatch(/^[0-9a-f]{64}$/);
    expect(Date.parse(result.issuedAt)).not.toBeNaN();
  });
  it("persists a signed OCR preview produced for the same user and document", async () => {
    const { service, file, db, events, proposals, documents } = setup();
    const preview = await service.preview(file);
    await service.create(input as never, file, JSON.stringify(preview));
    expect(proposals.create).toHaveBeenCalled();
    expect(documents.upload).toHaveBeenCalledWith("proposal", file);
    expect(db.$queryRaw).toHaveBeenCalledTimes(1);
    expect(events.record).toHaveBeenCalledWith("proposal", "command_proposal.ocr_extraction_stored", expect.objectContaining({
      extractionId: "extraction",
      documentId: "document",
      sha256: createHash("sha256").update(file.buffer).digest("hex"),
      engine: "tesseract-spa-local",
      confidence: preview.confidence,
    }));
  });
  it.each([
    ["raw text", { rawText: "FACTURA F-999" }],
    ["confidence", { confidence: 99 }],
    ["fields", { fields: { invoiceNumber: { value: "F-999", confidence: 99, evidence: "F-999" } } }],
    ["engine", { engine: "other-engine" }],
    ["issue time", { issuedAt: new Date(Date.now() + 1000).toISOString() }],
  ])("rejects a preview whose %s was altered", async (_label, change) => {
    const { service, file, proposals, db, events } = setup();
    const preview = await service.preview(file);
    await expect(service.create(input as never, file, JSON.stringify({ ...preview, ...change })))
      .rejects.toThrow("signature is invalid");
    expect(proposals.create).not.toHaveBeenCalled();
    expect(db.$queryRaw).not.toHaveBeenCalled();
    expect(events.record).not.toHaveBeenCalled();
  });
  it("rejects an unsigned or forged preview before creating a proposal", async () => {
    const { service, file, proposals } = setup();
    const preview = await service.preview(file);
    const { signature: _signature, ...unsigned } = preview;
    await expect(service.create(input as never, file, JSON.stringify(unsigned))).rejects.toThrow("signature is required");
    await expect(service.create(input as never, file, JSON.stringify({ ...preview, signature: "0".repeat(64) })))
      .rejects.toThrow("signature is invalid");
    expect(proposals.create).not.toHaveBeenCalled();
  });
  it.each([
    ["user", { ...tenantUser, userId: "other-user" }],
    ["company", { ...tenantUser, companyId: "other-company" }],
  ])("rejects a preview signed for another %s", async (_label, required) => {
    const issuer = setup();
    const preview = await issuer.service.preview(issuer.file);
    const replay = setup("true", required);
    await expect(replay.service.create(input as never, replay.file, JSON.stringify(preview))).rejects.toThrow("signature is invalid");
    expect(replay.proposals.create).not.toHaveBeenCalled();
  });
  it("rejects an expired preview", async () => {
    const { service, file, proposals } = setup();
    const preview = await service.preview(file);
    jest.useFakeTimers({ now: Date.now() + 25 * 60 * 60 * 1000 });
    try {
      await expect(service.create(input as never, file, JSON.stringify(preview))).rejects.toThrow("expired");
    } finally {
      jest.useRealTimers();
    }
    expect(proposals.create).not.toHaveBeenCalled();
  });
  it("rejects OCR evidence for a different document before creating a proposal", async () => {
    const { service, file, proposals, documents, db, events } = setup();
    await expect(service.create(input as never, file, JSON.stringify({
      sha256: "0".repeat(64),
      engine: "tesseract-spa-local",
      confidence: 88.5,
      rawText: "FACTURA F-123",
      fields: {},
    }))).rejects.toThrow("does not match");
    expect(proposals.create).not.toHaveBeenCalled();
    expect(documents.upload).not.toHaveBeenCalled();
    expect(db.$queryRaw).not.toHaveBeenCalled();
    expect(events.record).not.toHaveBeenCalled();
  });
  it("propagates upload errors so the transaction owner can roll back", async () => {
    const { service, file, documents } = setup();
    documents.upload.mockRejectedValueOnce(new Error("upload failed"));
    await expect(service.create(input as never, file)).rejects.toThrow("upload failed");
  });
  it("rejects invalid input before creating a proposal", async () => {
    const { service, file, proposals } = setup();
    await expect(service.create({ ...input, actorUserId: "other" } as never, file)).rejects.toThrow();
    expect(proposals.create).not.toHaveBeenCalled();
  });
});
