import { Injectable, Logger, OnModuleDestroy, OnModuleInit } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { PrismaClient, SifAeatSubmissionStatus } from "@prisma/client";
import { createHash } from "node:crypto";
import { formatSifIssueDate } from "./sif-hash-v1";
import { AeatTestClient, AeatTestTransportError } from "./aeat-test.client";
import { parseAeatTestSoapResponse } from "./aeat-test-soap";

export function predecessorHasDefinitiveAeatResponse(submission: {
  status: SifAeatSubmissionStatus;
  recordStatus: string | null;
} | null): boolean {
  if (!submission) return false;
  if (submission.status === SifAeatSubmissionStatus.ACCEPTED ||
      submission.status === SifAeatSubmissionStatus.ACCEPTED_WITH_ERRORS)
    return true;
  // A rejected record remains the immediately previous record in the local SIF
  // chain. AEAT's line-level "Incorrecto" response is definitive, unlike a
  // transport failure or SOAP fault; later frozen records may now be sent.
  return submission.status === SifAeatSubmissionStatus.REJECTED &&
    submission.recordStatus === "Incorrecto";
}

@Injectable()
export class AeatTestWorker implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(AeatTestWorker.name);
  private readonly admin?: PrismaClient;
  private timer?: NodeJS.Timeout;
  private running = false;

  constructor(config: ConfigService, private readonly client: AeatTestClient) {
    const directUrl = config.get<string>("DIRECT_DATABASE_URL");
    if (client.enabled && directUrl)
      this.admin = new PrismaClient({ datasources: { db: { url: directUrl } } });
  }

  onModuleInit() {
    if (!this.admin) return;
    this.timer = setInterval(() => void this.tick(), 5_000);
    this.timer.unref();
    void this.tick();
  }

  async onModuleDestroy() {
    if (this.timer) clearInterval(this.timer);
    await this.admin?.$disconnect();
  }

  async processOne(): Promise<boolean> {
    if (!this.admin) return false;
    const stale = new Date(Date.now() - 120_000);
    await this.admin.sifAeatSubmission.updateMany({
      where: { status: SifAeatSubmissionStatus.SENDING, lockedAt: { lt: stale } },
      data: {
        status: SifAeatSubmissionStatus.UNKNOWN,
        lockedAt: null,
        lastError: "Worker lease expired; delivery may have reached AEAT. Reconcile before retrying.",
      },
    });
    const claim = await this.admin.$transaction(async (db) => {
      const [lock] = await db.$queryRaw<Array<{ acquired: boolean }>>`
        SELECT pg_try_advisory_xact_lock(91926017) AS acquired
      `;
      if (!lock?.acquired) return null;
      const now = new Date();
      const last = await db.sifAeatSubmission.findFirst({
        where: { lastAttemptAt: { not: null } },
        orderBy: { lastAttemptAt: "desc" },
        select: { lastAttemptAt: true, waitSeconds: true },
      });
      if (last?.lastAttemptAt &&
          now.getTime() < last.lastAttemptAt.getTime() + (last.waitSeconds ?? 60) * 1_000)
        return null;
      const candidates = await db.sifAeatSubmission.findMany({
        where: {
          status: { in: [SifAeatSubmissionStatus.PENDING, SifAeatSubmissionStatus.RETRY] },
          availableAt: { lte: now },
        },
        include: { record: { select: { previousRecordId: true, chainPosition: true } } },
        orderBy: [{ createdAt: "asc" }],
        take: 20,
      });
      for (const candidate of candidates) {
        if (candidate.record.previousRecordId) {
          const predecessor = await db.sifAeatSubmission.findFirst({
            where: {
              recordId: candidate.record.previousRecordId,
              companyId: candidate.companyId,
            },
            select: { status: true, recordStatus: true },
          });
          if (!predecessorHasDefinitiveAeatResponse(predecessor)) continue;
        }
        return db.sifAeatSubmission.update({
          where: { id: candidate.id },
          data: {
            status: SifAeatSubmissionStatus.SENDING,
            attempts: { increment: 1 },
            lockedAt: now,
            lastAttemptAt: now,
            waitSeconds: 60,
            lastError: null,
          },
          select: { id: true, attempts: true },
        });
      }
      return null;
    });
    if (!claim) return false;
    await this.deliver(claim.id, claim.attempts);
    return true;
  }

  private async tick() {
    if (this.running) return;
    this.running = true;
    try { await this.processOne(); }
    catch (error) { this.logger.error("AEAT test outbox failed", error); }
    finally { this.running = false; }
  }

  private async deliver(id: string, attempts: number) {
    if (!this.admin) return;
    let responseXml: string | null = null;
    let httpStatus: number | null = null;
    let transportAttempted = false;
    try {
      const submission = await this.admin.sifAeatSubmission.findUniqueOrThrow({
        where: { id },
        include: { record: { include: { invoice: { select: { aeatEnvironment: true, sifMode: true } } } } },
      });
      const payload = submission.record.payload;
      const xml = payload && typeof payload === "object" && !Array.isArray(payload)
        ? payload.aeatXml : null;
      if (submission.record.invoice.aeatEnvironment !== "TEST" ||
          submission.record.invoice.sifMode !== "VERIFACTU" ||
          typeof xml !== "string" ||
          createHash("sha256").update(xml).digest("hex") !== submission.requestSha256)
        throw new Error("AEAT test submission does not match a frozen VERI*FACTU test record");

      transportAttempted = true;
      const response = await this.client.send(xml);
      responseXml = response.responseXml;
      httpStatus = response.httpStatus;
      if (httpStatus === 503 || httpStatus === 429) {
        await this.retry(id, attempts, `AEAT returned HTTP ${httpStatus}`, responseXml, httpStatus);
        return;
      }
      const parsed = parseAeatTestSoapResponse(responseXml, {
        issuerTaxId: submission.record.issuerTaxId,
        invoiceNumber: submission.record.invoiceNumber,
        issueDate: formatSifIssueDate(submission.record.invoiceIssueDate),
      });
      if (parsed.kind === "FAULT") {
        if (parsed.faultCode.endsWith(":Server") || parsed.faultCode === "Server") {
          await this.retry(id, attempts, `AEAT SOAP Server fault: ${parsed.faultString}`, responseXml, httpStatus);
          return;
        }
        await this.finish(id, {
          status: SifAeatSubmissionStatus.REJECTED,
          httpStatus,
          responseXml,
          errorDescription: parsed.faultString.slice(0, 1500),
          lastError: `AEAT SOAP fault ${parsed.faultCode}`,
        });
        return;
      }
      await this.finish(id, {
        status: parsed.recordStatus === "Correcto"
          ? SifAeatSubmissionStatus.ACCEPTED
          : parsed.recordStatus === "AceptadoConErrores"
            ? SifAeatSubmissionStatus.ACCEPTED_WITH_ERRORS
            : SifAeatSubmissionStatus.REJECTED,
        httpStatus,
        responseXml,
        globalStatus: parsed.globalStatus,
        recordStatus: parsed.recordStatus,
        waitSeconds: parsed.waitSeconds,
        csv: parsed.csv,
        errorCode: parsed.errorCode,
        errorDescription: parsed.errorDescription,
        lastError: parsed.recordStatus ? null : "AEAT rejected the complete batch without a line response",
      });
    } catch (error) {
      const message = error instanceof Error ? error.message.slice(0, 1500) : "Unknown AEAT test failure";
      if (!transportAttempted) {
        await this.finish(id, {
          status: SifAeatSubmissionStatus.FAILED,
          lastError: message,
        });
      } else if (error instanceof AeatTestTransportError && !error.ambiguous) {
        await this.retry(id, attempts, message, responseXml, httpStatus);
      } else {
        await this.finish(id, {
          status: SifAeatSubmissionStatus.UNKNOWN,
          httpStatus,
          responseXml,
          lastError: message,
        });
      }
    }
  }

  private async retry(id: string, attempts: number, reason: string, responseXml: string | null, httpStatus: number | null) {
    if (!this.admin) return;
    const exhausted = attempts >= 5;
    await this.admin.sifAeatSubmission.updateMany({
      where: { id, status: SifAeatSubmissionStatus.SENDING },
      data: {
        status: exhausted ? SifAeatSubmissionStatus.FAILED : SifAeatSubmissionStatus.RETRY,
        availableAt: new Date(Date.now() + Math.min(60 * 2 ** attempts, 3_600) * 1_000),
        lockedAt: null,
        completedAt: exhausted ? new Date() : null,
        responseXml,
        httpStatus,
        lastError: reason.slice(0, 1500),
      },
    });
  }

  private async finish(id: string, data: Parameters<PrismaClient["sifAeatSubmission"]["updateMany"]>[0]["data"]) {
    await this.admin?.sifAeatSubmission.updateMany({
      where: { id, status: SifAeatSubmissionStatus.SENDING },
      data: { ...data, lockedAt: null, completedAt: new Date() },
    });
  }
}
