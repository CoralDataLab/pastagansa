import { Injectable, Logger, OnModuleDestroy, OnModuleInit } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { AeatEnvironment, Prisma, PrismaClient, SifAeatSubmissionStatus,
  SifMode } from "@prisma/client";
import { createHash } from "node:crypto";
import { formatSifIssueDate } from "./sif-hash-v1";
import { AeatTestClient, AeatProductionClient, AeatTransportClient,
  AeatTestTransportError } from "./aeat-test.client";
import { parseAeatTestSoapResponse } from "./aeat-test-soap";
import { queryConfirmsDuplicate } from "./aeat-test-query";
import { sifProductionReleaseMatches } from "./sif-production-gate";

const LEASE_MS = 120_000;
const RETRY_CAP_SECONDS = 3_600;

export function aeatRetryDelaySeconds(attempts: number): number {
  return Math.min(60 * 2 ** Math.min(attempts, 6), RETRY_CAP_SECONDS);
}

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

export class AeatWorkerCore implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(AeatWorkerCore.name);
  private readonly admin?: PrismaClient;
  private timer?: NodeJS.Timeout;
  private running = false;

  constructor(private readonly config: ConfigService, private readonly client: AeatTransportClient) {
    const directUrl = config.get<string>("DIRECT_DATABASE_URL");
    if (client.enabled && directUrl)
      this.admin = new PrismaClient({ datasources: { db: { url: directUrl } } });
  }

  onModuleInit() {
    if (!this.admin) return;
    if (this.client.environment === "PRODUCTION" &&
        !sifProductionReleaseMatches(this.config, this.client.companyId!))
      throw new Error("AEAT production sender requires the reviewed declaration artifact");
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
    if (this.client.environment === "PRODUCTION" &&
        !sifProductionReleaseMatches(this.config, this.client.companyId!)) return false;
    const source: Prisma.SifAeatSubmissionWhereInput = {
      companyId: this.client.companyId!, record: { invoice: {
        aeatEnvironment: this.client.environment === "PRODUCTION"
          ? AeatEnvironment.PRODUCTION : AeatEnvironment.TEST,
        sifMode: SifMode.VERIFACTU,
      } },
    };
    const stale = new Date(Date.now() - LEASE_MS);
    await this.admin.sifAeatSubmission.updateMany({
      where: { ...source, status: SifAeatSubmissionStatus.SENDING, lockedAt: { lt: stale } },
      data: {
        status: SifAeatSubmissionStatus.UNKNOWN,
        lockedAt: null,
        availableAt: new Date(Date.now() + 60_000),
        completedAt: null,
        lastError: "Worker lease expired; delivery may have reached AEAT. Frozen XML will be retried.",
      },
    });
    const claim = await this.admin.$transaction(async (db) => {
      const [lock] = await db.$queryRaw<Array<{ acquired: boolean }>>`
        SELECT pg_try_advisory_xact_lock(91926017) AS acquired
      `;
      if (!lock?.acquired) return null;
      const now = new Date();
      const last = await db.sifAeatSubmission.findFirst({
        where: { ...source, lastAttemptAt: { not: null } },
        orderBy: { lastAttemptAt: "desc" },
        select: { lastAttemptAt: true, waitSeconds: true },
      });
      if (last?.lastAttemptAt &&
          now.getTime() < last.lastAttemptAt.getTime() + (last.waitSeconds ?? 60) * 1_000)
        return null;
      const candidates = await db.sifAeatSubmission.findMany({
        where: {
          ...source,
          status: { in: [SifAeatSubmissionStatus.PENDING, SifAeatSubmissionStatus.RETRY, SifAeatSubmissionStatus.UNKNOWN] },
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
            completedAt: null,
            waitSeconds: 60,
          },
          select: { id: true, attempts: true, lockedAt: true },
        });
      }
      return null;
    });
    if (!claim) return false;
    await this.deliver(claim.id, claim.attempts, claim.lockedAt!);
    return true;
  }

  private async tick() {
    if (this.running) return;
    this.running = true;
    try { await this.processOne(); }
    catch (error) { this.logger.error(`AEAT ${this.client.environment} outbox failed`, error); }
    finally { this.running = false; }
  }

  private async deliver(id: string, attempts: number, lockedAt: Date) {
    if (!this.admin) return;
    let responseXml: string | null = null;
    let reconciliationXml: string | null = null;
    let httpStatus: number | null = null;
    let transportAttempted = false;
    try {
      const submission = await this.admin.sifAeatSubmission.findUniqueOrThrow({
        where: { id },
        include: { record: { include: { invoice: { select: {
          aeatEnvironment: true, sifMode: true, issuerLegalName: true, operationDate: true,
        } } } } },
      });
      const payload = submission.record.payload;
      const xml = payload && typeof payload === "object" && !Array.isArray(payload)
        ? payload.aeatXml : null;
      if (submission.record.invoice.aeatEnvironment !== (this.client.environment ?? "TEST") ||
          submission.record.invoice.sifMode !== "VERIFACTU" ||
          submission.companyId !== this.client.companyId ||
          submission.record.issuerTaxId !== this.client.issuerTaxId ||
          typeof xml !== "string" ||
          createHash("sha256").update(xml).digest("hex") !== submission.requestSha256)
        throw new Error("AEAT submission does not match this sender's frozen VERI*FACTU record");

      if (this.client.environment === "PRODUCTION" &&
          !sifProductionReleaseMatches(this.config, this.client.companyId!)) {
        await this.retry(id, attempts, lockedAt,
          "AEAT production release was revoked before transport", null, null);
        return;
      }

      transportAttempted = true;
      const response = await this.client.send(xml);
      responseXml = response.responseXml;
      httpStatus = response.httpStatus;
      if (httpStatus === 503 || httpStatus === 429) {
        await this.retry(id, attempts, lockedAt, `AEAT returned HTTP ${httpStatus}`, responseXml, httpStatus);
        return;
      }
      const parsed = parseAeatTestSoapResponse(responseXml, {
        issuerTaxId: submission.record.issuerTaxId,
        invoiceNumber: submission.record.invoiceNumber,
        issueDate: formatSifIssueDate(submission.record.invoiceIssueDate),
      });
      if (parsed.kind === "FAULT") {
        if (parsed.faultCode.endsWith(":Server") || parsed.faultCode === "Server") {
          await this.retry(id, attempts, lockedAt, `AEAT SOAP Server fault: ${parsed.faultString}`, responseXml, httpStatus);
          return;
        }
        await this.finish(id, lockedAt, {
          status: SifAeatSubmissionStatus.REJECTED,
          httpStatus,
          responseXml,
          errorDescription: parsed.faultString.slice(0, 1500),
          lastError: `AEAT SOAP fault ${parsed.faultCode}`,
        });
        return;
      }
      if (parsed.recordStatus === "Incorrecto" &&
          (parsed.duplicate || /duplicad/i.test(parsed.errorDescription ?? ""))) {
        const duplicate = parsed.duplicate;
        // A duplicate invoice number alone does not prove that our frozen record
        // arrived. Verify both its SIF hash and AEAT's original request ID.
        if (duplicate && submission.record.recordType !== "CANCELLATION" &&
            ["Correcta", "AceptadaConErrores"].includes(duplicate.status)) {
          const identity = {
            issuerName: submission.record.invoice.issuerLegalName,
            issuerTaxId: submission.record.issuerTaxId,
            invoiceNumber: submission.record.invoiceNumber,
            issueDate: formatSifIssueDate(submission.record.invoiceIssueDate),
            operationDate: submission.record.invoice.operationDate ?? submission.record.invoiceIssueDate,
          };
          const consultation = await this.client.query(identity);
          reconciliationXml = consultation.responseXml;
          if (consultation.httpStatus === 200 && queryConfirmsDuplicate(
            consultation.responseXml, identity, submission.record.recordHash,
            duplicate.requestId, duplicate.status as "Correcta" | "AceptadaConErrores",
          )) {
            await this.finish(id, lockedAt, {
              status: duplicate.status === "Correcta"
                ? SifAeatSubmissionStatus.ACCEPTED : SifAeatSubmissionStatus.ACCEPTED_WITH_ERRORS,
              httpStatus, responseXml, reconciliationXml,
              globalStatus: parsed.globalStatus,
              recordStatus: duplicate.status === "Correcta" ? "Correcto" : "AceptadoConErrores",
              waitSeconds: parsed.waitSeconds,
              csv: null,
              errorCode: duplicate.errorCode,
              errorDescription: [
                "Registro previo confirmado por consulta AEAT (huella e IdPeticion); CSV original no recuperable.",
                duplicate.errorDescription,
              ].filter(Boolean).join(" ").slice(0, 1500),
              lastError: null,
            });
            return;
          }
        }
        await this.unknown(id, attempts, lockedAt,
          "AEAT reports a duplicate, but its identity and hash could not be verified",
          responseXml, httpStatus, parsed.waitSeconds, reconciliationXml);
        return;
      }
      await this.finish(id, lockedAt, {
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
        await this.finish(id, lockedAt, {
          status: SifAeatSubmissionStatus.FAILED,
          lastError: message,
        });
      } else if (error instanceof AeatTestTransportError && !error.ambiguous) {
        await this.retry(id, attempts, lockedAt, message, responseXml, httpStatus);
      } else {
        await this.unknown(id, attempts, lockedAt, message, responseXml, httpStatus,
          undefined, reconciliationXml);
      }
    }
  }

  private async retry(id: string, attempts: number, lockedAt: Date, reason: string, responseXml: string | null, httpStatus: number | null) {
    if (!this.admin) return;
    await this.admin.sifAeatSubmission.updateMany({
      where: { id, status: SifAeatSubmissionStatus.SENDING, lockedAt },
      data: {
        status: SifAeatSubmissionStatus.RETRY,
        availableAt: new Date(Date.now() + aeatRetryDelaySeconds(attempts) * 1_000),
        lockedAt: null,
        completedAt: null,
        responseXml,
        httpStatus,
        globalStatus: null,
        recordStatus: null,
        csv: null,
        errorCode: null,
        errorDescription: null,
        lastError: reason.slice(0, 1500),
      },
    });
  }

  private async unknown(id: string, attempts: number, lockedAt: Date, reason: string, responseXml: string | null, httpStatus: number | null, waitSeconds?: number, reconciliationXml?: string | null) {
    await this.admin?.sifAeatSubmission.updateMany({
      where: { id, status: SifAeatSubmissionStatus.SENDING, lockedAt },
      data: {
        status: SifAeatSubmissionStatus.UNKNOWN,
        availableAt: new Date(Date.now() + aeatRetryDelaySeconds(attempts) * 1_000),
        lockedAt: null,
        completedAt: null,
        httpStatus,
        responseXml,
        ...(reconciliationXml ? { reconciliationXml } : {}),
        ...(waitSeconds === undefined ? {} : { waitSeconds }),
        globalStatus: null,
        recordStatus: null,
        csv: null,
        errorCode: null,
        errorDescription: null,
        lastError: reason.slice(0, 1500),
      },
    });
  }

  private async finish(id: string, lockedAt: Date, data: Parameters<PrismaClient["sifAeatSubmission"]["updateMany"]>[0]["data"]) {
    await this.admin?.sifAeatSubmission.updateMany({
      where: { id, status: SifAeatSubmissionStatus.SENDING, lockedAt },
      data: { ...data, lockedAt: null, completedAt: new Date() },
    });
  }
}

@Injectable()
export class AeatTestWorker extends AeatWorkerCore {
  constructor(config: ConfigService, client: AeatTestClient) { super(config, client); }
}

@Injectable()
export class AeatProductionWorker extends AeatWorkerCore {
  constructor(config: ConfigService, client: AeatProductionClient) { super(config, client); }
}
