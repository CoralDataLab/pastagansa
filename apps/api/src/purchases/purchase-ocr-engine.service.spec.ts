import { BadRequestException } from "@nestjs/common";
import { createWorker } from "tesseract.js";
import { PurchaseOcrEngine } from "./purchase-ocr-engine.service";

jest.mock("tesseract.js", () => ({ createWorker: jest.fn(), OEM: { LSTM_ONLY: 1 } }));

describe("local OCR engine", () => {
  it("serializes work and bounds the queue", async () => {
    let release: (() => void) | undefined;
    let active = 0;
    let maxActive = 0;
    const recognize = jest.fn(async () => {
      active++; maxActive = Math.max(maxActive, active);
      if (recognize.mock.calls.length === 1) await new Promise<void>(resolve => { release = resolve; });
      active--;
      return { data: { text: "text", confidence: 90 } };
    });
    const terminate = jest.fn();
    (createWorker as jest.Mock).mockResolvedValue({ recognize, terminate });
    const engine = new PurchaseOcrEngine();
    const first = engine.recognize(Buffer.from("1"));
    const second = engine.recognize(Buffer.from("2"));
    const third = engine.recognize(Buffer.from("3"));
    await expect(engine.recognize(Buffer.from("4"))).rejects.toThrow("busy");
    await new Promise(resolve => setImmediate(resolve));
    expect(recognize).toHaveBeenCalledTimes(1);
    release!();
    await Promise.all([first, second, third]);
    expect(maxActive).toBe(1);
    await engine.onModuleDestroy();
    expect(terminate).toHaveBeenCalledTimes(1);
  });

  it("can recover after initialization fails", async () => {
    (createWorker as jest.Mock).mockRejectedValueOnce(new Error("failed"));
    const engine = new PurchaseOcrEngine();
    await expect(engine.recognize(Buffer.from("1"))).rejects.toThrow("failed");
    (createWorker as jest.Mock).mockResolvedValueOnce({ recognize: jest.fn().mockResolvedValue({ data: { text: "ok", confidence: 80 } }), terminate: jest.fn() });
    await expect(engine.recognize(Buffer.from("2"))).resolves.toEqual({ text: "ok", confidence: 80 });
    await engine.onModuleDestroy();
  });

  it("reports unreadable images as client errors and keeps the worker usable", async () => {
    const recognize = jest.fn()
      .mockRejectedValueOnce("Error: Error attempting to read image.")
      .mockRejectedValueOnce(new Error("worker crashed"))
      .mockResolvedValueOnce({ data: { text: "ok", confidence: 80 } });
    (createWorker as jest.Mock).mockResolvedValueOnce({ recognize, terminate: jest.fn() });
    const engine = new PurchaseOcrEngine();
    await expect(engine.recognize(Buffer.from("1"))).rejects.toBeInstanceOf(BadRequestException);
    await expect(engine.recognize(Buffer.from("2"))).rejects.toThrow("worker crashed");
    await expect(engine.recognize(Buffer.from("3"))).resolves.toEqual({ text: "ok", confidence: 80 });
    expect(createWorker).toHaveBeenLastCalledWith("spa", 1, expect.objectContaining({ errorHandler: expect.any(Function) }));
    await engine.onModuleDestroy();
  });
});
