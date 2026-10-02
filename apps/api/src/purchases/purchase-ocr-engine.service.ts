import { Injectable, OnModuleDestroy } from "@nestjs/common";
import { dirname, join } from "node:path";
import { createWorker, OEM, Worker } from "tesseract.js";

@Injectable()
export class PurchaseOcrEngine implements OnModuleDestroy {
  private worker: Promise<Worker> | undefined;

  async recognize(content: Buffer) {
    const worker = await (this.worker ??= this.create());
    const result = await worker.recognize(content);
    return {
      text: result.data.text,
      confidence: result.data.confidence,
    };
  }

  async onModuleDestroy() {
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
