import { Injectable, Logger, OnModuleDestroy, OnModuleInit } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { Company, PrismaClient } from "@prisma/client";
import { SifNoEventService } from "./sif-no-event.service";
import { SifNoSigningService } from "./sif-no-signing.service";
import { sifProductionReleaseMatches } from "./sif-production-gate";

const SUMMARY_INTERVAL_MS = 5 * 60 * 60 * 1_000 + 55 * 60 * 1_000;

/** Runs only for the one issuer whose NO VERI*FACTU certificate is mounted. */
@Injectable()
export class SifNoEventRuntime implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(SifNoEventRuntime.name);
  private readonly admin?: PrismaClient;
  private readonly companyId?: string;
  private timer?: NodeJS.Timeout;
  private running = false;
  private readonly config: ConfigService;

  constructor(config: ConfigService, private readonly events: SifNoEventService,
    private readonly signer: SifNoSigningService) {
    this.config = config;
    if (config.get<string>("SIF_NO_SIGNING_ENABLED") === "true") {
      this.companyId = config.getOrThrow<string>("SIF_NO_COMPANY_ID");
      this.admin = new PrismaClient({ datasources: { db: {
        url: config.getOrThrow<string>("DIRECT_DATABASE_URL"),
      } } });
    }
  }

  async onModuleInit() {
    if (!this.admin || !this.companyId) return;
    const company = await this.loadCompany();
    if (company && this.isEnabled(company)) {
      await this.admin.$transaction(async (db) => {
        await this.events.appendForCompany(db, company, "01");
      }, { timeout: 120_000 });
      await this.admin.$transaction(async (db) => {
        await this.events.checkForCompany(db, company);
      }, { timeout: 120_000 });
    }
    this.timer = setInterval(() => void this.tick(), 30_000);
    this.timer.unref();
  }

  async onModuleDestroy() {
    if (this.timer) clearInterval(this.timer);
    if (!this.admin) return;
    try {
      const company = await this.loadCompany();
      if (company && this.isEnabled(company))
        await this.admin.$transaction(async (db) => {
          await this.events.appendSummary(db, company);
          await this.events.appendForCompany(db, company, "02");
        }, { timeout: 120_000 });
    } finally {
      await this.admin.$disconnect();
    }
  }

  private async loadCompany(): Promise<Company | null> {
    const company = await this.admin!.company.findUnique({ where: { id: this.companyId } });
    if (company && !this.signer.matches(company.id, company.taxId))
      throw new Error("NO VERI*FACTU runtime company does not match certificate configuration");
    return company;
  }

  private isEnabled(company: Company): boolean {
    return company.sifMode === "NO_VERIFACTU" &&
      (company.aeatEnvironment === "TEST" ||
        sifProductionReleaseMatches(this.config, company.id));
  }

  private async tick() {
    if (this.running || !this.admin) return;
    this.running = true;
    try {
      const company = await this.loadCompany();
      if (!company || !this.isEnabled(company))
        return;
      const due = await this.admin.$transaction(async (db) => {
        await db.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${company.id}, 1))`;
        const entries = await db.sifEventRecord.findMany({
          where: { companyId: company.id, eventType: { in: ["01", "02", "10"] } },
          orderBy: { chainPosition: "asc" },
          select: { eventType: true, generatedAt: true },
        });
        if (operationalTimeSinceSummary(entries, new Date()) < SUMMARY_INTERVAL_MS) return false;
        await this.events.appendSummary(db, company);
        return true;
      }, { timeout: 120_000 });
      if (due) await this.admin.$transaction(async (db) => {
        await this.events.checkForCompany(db, company);
      }, { timeout: 120_000 });
    } catch (error) {
      this.logger.error("NO VERI*FACTU summary or integrity check failed", error);
    } finally {
      this.running = false;
    }
  }
}

export function operationalTimeSinceSummary(
  entries: readonly { eventType: string; generatedAt: Date }[], now: Date,
): number {
  let elapsed = 0;
  let activeSince: number | null = null;
  for (const entry of entries) {
    const at = entry.generatedAt.getTime();
    if (entry.eventType === "01" && activeSince === null) activeSince = at;
    if (entry.eventType === "02" && activeSince !== null) {
      elapsed += Math.max(0, at - activeSince);
      activeSince = null;
    }
    if (entry.eventType === "10") {
      elapsed = 0;
      if (activeSince !== null) activeSince = at;
    }
  }
  if (activeSince !== null) elapsed += Math.max(0, now.getTime() - activeSince);
  return elapsed;
}
