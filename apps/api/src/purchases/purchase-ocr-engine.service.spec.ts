import { createWorker } from "tesseract.js";
import { PurchaseOcrEngine } from "./purchase-ocr-engine.service";

jest.mock("tesseract.js", () => ({ createWorker: jest.fn(), OEM: { LSTM_ONLY: 1 } }));

describe("local OCR engine", () => {
  it("handles worker job failures so they reject instead of crashing the process", async () => {
    const recognize = jest.fn()
      .mockRejectedValueOnce("Error: Error attempting to read image.")
      .mockResolvedValueOnce({ data: { text: "ok", confidence: 80 } });
    (createWorker as jest.Mock).mockResolvedValueOnce({ recognize, terminate: jest.fn() });
    const engine = new PurchaseOcrEngine();
    await expect(engine.recognize(Buffer.from("1"))).rejects.toMatch("read image");
    await expect(engine.recognize(Buffer.from("2"))).resolves.toEqual({ text: "ok", confidence: 80 });
    expect(createWorker).toHaveBeenCalledWith("spa", 1, expect.objectContaining({ errorHandler: expect.any(Function) }));
    await engine.onModuleDestroy();
  });
});
