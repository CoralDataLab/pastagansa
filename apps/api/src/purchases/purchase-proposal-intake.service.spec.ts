import { BadRequestException } from "@nestjs/common";
import { PurchaseProposalIntakeService } from "./purchase-proposal-intake.service";

function setup(enabled = "true") {
  const transactions = { run: jest.fn(async (_context, work) => work()) };
  const authorization = { require: jest.fn().mockResolvedValue(undefined) };
  const engine = { recognize: jest.fn().mockResolvedValue({ text: "FACTURA: F-123\nBASE IMPONIBLE: 100,00 EUR", confidence: 90 }) };
  const proposals = { create: jest.fn().mockResolvedValue({ id: "proposal" }), get: jest.fn().mockResolvedValue({ id: "proposal", documents: [{}] }) };
  const documents = { upload: jest.fn().mockResolvedValue({ id: "document" }) };
  const service = new PurchaseProposalIntakeService(
    { required: { userId: "user", organizationId: "org", companyId: "company" } } as never,
    transactions as never, authorization as never, engine as never,
    proposals as never, documents as never, { get: () => enabled } as never,
  );
  const buffer = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aEXcAAAAASUVORK5CYII=", "base64");
  const file = { buffer, size: buffer.length, mimetype: "image/png", originalname: "test.png" };
  return { service, authorization, engine, transactions, proposals, documents, file };
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
