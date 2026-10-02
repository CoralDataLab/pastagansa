import { beforeEach, describe, expect, it, vi } from "vitest";
vi.mock("server-only", () => ({}));
vi.mock("./server-purchase-proposals", () => ({ forwardPurchaseProposal: vi.fn(async () => new Response("{}", { status: 201 })) }));
import { forwardPurchaseProposal } from "./server-purchase-proposals";
import { forwardProposalIntake } from "./server-purchase-proposal-intake";

function request(file?: File, input?: unknown, ocrPreview?: string) {
  const form = new FormData();
  if (file) form.set("file", file);
  if (input) form.set("proposal", JSON.stringify(input));
  if (ocrPreview !== undefined) form.set("ocrPreview", ocrPreview);
  return new Request("http://localhost/api/purchase-proposals/ocr-preview", { method: "POST", body: form });
}
const file = () => new File(["image"], "invoice.png", { type: "image/png" });
const input = {
  commandId: "intake-123", payload: {
    supplierId: "11111111-1111-4111-8111-111111111111", supplierInvoiceNumber: "F-123",
    issueDate: "2026-10-01", receivedDate: "2026-10-01",
    lines: [{ description: "Service", quantity: 1, unitPrice: 100 }],
  }, evidence: [], provenance: { channel: "UPLOAD" },
};
describe("proposal intake BFF", () => {
  beforeEach(() => vi.clearAllMocks());
  it("rejects missing files before forwarding", async () => {
    expect((await forwardProposalIntake(request(), "ocr-preview")).status).toBe(400);
    expect(forwardPurchaseProposal).not.toHaveBeenCalled();
  });
  it("forwards a multipart image without JSON headers", async () => {
    await forwardProposalIntake(request(file()), "ocr-preview");
    expect(forwardPurchaseProposal).toHaveBeenCalledWith("/ocr-preview", expect.objectContaining({ method: "POST", body: expect.any(FormData) }));
    const body = vi.mocked(forwardPurchaseProposal).mock.calls[0][1]!.body as FormData;
    expect((body.get("file") as File).name).toBe("invoice.png");
  });
  it("rejects malformed or incomplete proposal data", async () => {
    expect((await forwardProposalIntake(request(file(), { commandId: "x" }), "from-document")).status).toBe(400);
    expect(forwardPurchaseProposal).not.toHaveBeenCalled();
  });
  it("forwards validated proposal data with the original image", async () => {
    expect((await forwardProposalIntake(request(file(), input), "from-document")).status).toBe(201);
    expect(forwardPurchaseProposal).toHaveBeenCalledWith("/from-document", expect.objectContaining({ body: expect.any(FormData) }));
  });
  it("forwards the signed OCR preview byte for byte", async () => {
    const preview = JSON.stringify({ sha256: "a".repeat(64), rawText: "FACTURA ñ", signature: "b".repeat(64) });
    expect((await forwardProposalIntake(request(file(), input, preview), "from-document")).status).toBe(201);
    const body = vi.mocked(forwardPurchaseProposal).mock.calls[0][1]!.body as FormData;
    expect(body.get("ocrPreview")).toBe(preview);
  });
  it("rejects an oversized OCR preview instead of silently dropping it", async () => {
    const response = await forwardProposalIntake(request(file(), input, "x".repeat(1024 * 1024 + 1)), "from-document");
    expect(response.status).toBe(400);
    expect(forwardPurchaseProposal).not.toHaveBeenCalled();
  });
});
