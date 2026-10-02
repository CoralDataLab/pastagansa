import { BadRequestException, Injectable, OnModuleDestroy, ServiceUnavailableException } from "@nestjs/common";
import { dirname, join } from "node:path";
import { createWorker, OEM, Worker } from "tesseract.js";

@Injectable()
export class PurchaseOcrEngine implements OnModuleDestroy {
  private worker: Promise<Worker> | undefined;
  private pending: Promise<unknown> = Promise.resolve();
  private queued = 0;

  recognize(content: Buffer) {
    if (this.queued >= 3)
      return Promise.reject(new ServiceUnavailableException("Local OCR is busy; retry later"));
    this.queued++;
    const job = this.pending.then(async () => {
      const worker = await (this.worker ??= this.create().catch(error => {
        this.worker = undefined;
        throw error;
      }));
      const result = await worker.recognize(content).catch((error: unknown) => {
        // Tesseract rejects undecodable images (e.g. too small for Leptonica) with this message.
        if (String(error).includes("Error attempting to read image"))
          throw new BadRequestException("The image could not be read by OCR");
        throw error;
      });
      return { text: result.data.text, confidence: result.data.confidence };
    });
    const tracked = job.finally(() => { this.queued--; });
    this.pending = tracked.catch(() => undefined);
    return tracked;
  }

  async onModuleDestroy() {
    await this.pending;
    if (this.worker) await (await this.worker).terminate();
  }

  private create() {
    const packageRoot = dirname(
      require.resolve("@tesseract.js-data/spa/package.json"),
    );
    return createWorker("spa", OEM.LSTM_ONLY, {
      langPath: join(packageRoot, "4.0.0"),
      cacheMethod: "none",
      // Without a handler tesseract.js rethrows failed jobs from its message
      // listener, crashing the process; the job promise already rejects.
      errorHandler: () => undefined,
    });
  }
}
