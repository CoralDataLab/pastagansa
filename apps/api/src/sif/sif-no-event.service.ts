import { ConflictException, Injectable } from "@nestjs/common";
import { Company, Prisma, SifRecord, SifRecordType } from "@prisma/client";
import { Decimal } from "@prisma/client/runtime/library";
import { createHash } from "node:crypto";
import { TenantContextService } from "../tenancy/tenant-context.service";
import { type SifEventHashInput } from "./sif-event-hash";
import { verifySifEventChain, verifySifEventTail } from "./sif-event-chain";
import { renderSifBasicEventXml, type SifBasicEventInput,
  type SifEventDetail, type SifEventReference, type SifInvoiceReference } from "./sif-event-xml";
import { formatSifIssueDate, formatSifTimestamp } from "./sif-hash-v1";
import { SifNoSigningService } from "./sif-no-signing.service";
import { captureSifSoftwareSnapshot } from "./sif-software-profile";
import { verifySifRecordSignature } from "./sif-xades";
import { verifySifChain } from "./sif-chain";

@Injectable()
export class SifNoEventService {
  constructor(
    private readonly tenant: TenantContextService,
    private readonly signer: SifNoSigningService,
  ) {}

  async verifyChain() {
    const scope = this.tenant.required;
    if (!scope.companyId) throw new ConflictException("A company is required for SIF event verification");
    const events = await this.tenant.db.sifEventRecord.findMany({
      where: { organizationId: scope.organizationId, companyId: scope.companyId },
      orderBy: { chainPosition: "asc" },
    });
    return verifySifEventChain(events);
  }

  async alarms() {
    const scope = this.tenant.required;
    if (!scope.companyId) throw new ConflictException("A company is required for SIF alarms");
    const where = { organizationId: scope.organizationId, companyId: scope.companyId,
      resolvedAt: null };
    const openCount = await this.tenant.db.sifIntegrityAlarm.count({ where });
    const alarms = await this.tenant.db.sifIntegrityAlarm.findMany({
      where,
      orderBy: { lastDetectedAt: "desc" }, take: 100,
    });
    return { companyId: scope.companyId, openCount,
      alarms: alarms.map((alarm) => ({
        id: alarm.id, source: alarm.source,
        chainPosition: alarm.chainPosition?.toString() ?? null,
        reason: alarm.reason, firstDetectedAt: alarm.firstDetectedAt,
        lastDetectedAt: alarm.lastDetectedAt,
      })) };
  }

  async checkIntegrity() {
    const scope = this.tenant.required;
    if (!scope.companyId) throw new ConflictException("A company is required for SIF checking");
    const company = await this.tenant.db.company.findFirst({
      where: { id: scope.companyId, organizationId: scope.organizationId },
    });
    if (!company) throw new ConflictException("Company not found");
    return this.checkForCompany(this.tenant.db, company);
  }

  /** Checks both chains and signed XML, records check/anomaly events and persists alarms. */
  async checkForCompany(db: Prisma.TransactionClient, company: Company) {
    if (!this.signer.matches(company.id, company.taxId))
      throw new ConflictException("NO VERI*FACTU checker requires the company's signer");
    const records = await db.sifRecord.findMany({
      where: { organizationId: company.organizationId, companyId: company.id },
      include: { invoice: { select: { sifMode: true } } },
      orderBy: { chainPosition: "asc" },
    });
    const invoiceChain = verifySifChain(records);
    let invoiceInvalid = invoiceChain.firstInvalid;
    if (!invoiceInvalid) for (const record of records) {
      if (record.invoice.sifMode !== "NO_VERIFACTU") continue;
      const payload = record.payload;
      const xml = payload && typeof payload === "object" && !Array.isArray(payload)
        ? payload.aeatXml : null;
      if (typeof xml !== "string" || !await verifySifRecordSignature(xml)) {
        invoiceInvalid = { id: record.id, chainPosition: record.chainPosition.toString(),
          reason: "Signed invoice XML or policy is invalid" };
        break;
      }
    }
    const events = await db.sifEventRecord.findMany({
      where: { organizationId: company.organizationId, companyId: company.id },
      orderBy: { chainPosition: "asc" },
    });
    const eventChain = await verifySifEventChain(events);
    const eventInvalid = eventChain.firstInvalid;
    if (invoiceInvalid) await recordAlarm(db, company, "INVOICE", invoiceInvalid);
    if (eventInvalid) await recordAlarm(db, company, "EVENT", eventInvalid);
    // An invalid tail cannot be signed onto safely. The durable alarm remains visible.
    const tail = events.at(-1);
    const prior = events.at(-2) ?? null;
    const tailValid = !tail || (await verifySifEventTail(tail, prior)).valid;
    if (tailValid) {
      await this.appendForCompany(db, company, "03", {
        kind: "03", recordsChecked: records.length,
      });
      if (invoiceInvalid) await this.appendForCompany(db, company, "04", {
        kind: "04", anomalyType: anomalyType(invoiceInvalid.reason),
        description: invoiceInvalid.reason.slice(0, 100),
      });
      await this.appendForCompany(db, company, "05", {
        kind: "05", recordsChecked: events.length,
      });
      if (eventInvalid) await this.appendForCompany(db, company, "06", {
        kind: "06", anomalyType: anomalyType(eventInvalid.reason),
        description: eventInvalid.reason.slice(0, 100),
      });
    }
    return { invoice: { valid: !invoiceInvalid, recordsChecked: records.length,
      firstInvalid: invoiceInvalid },
      events: eventChain, alarmsPersisted: Number(!!invoiceInvalid) + Number(!!eventInvalid),
      checkEventsRecorded: tailValid };
  }

  /** Appends a signed start/stop event in the caller's tenant transaction. */
  async appendBasic(company: Company, eventType: "01" | "02") {
    const scope = this.tenant.required;
    if (scope.organizationId !== company.organizationId || scope.companyId !== company.id)
      throw new ConflictException("NO VERI*FACTU event signer does not match this company");
    return this.appendForCompany(this.tenant.db, company, eventType);
  }

  async appendForCompany(db: Prisma.TransactionClient, company: Company,
    eventType: SifBasicEventInput["eventType"], detail?: SifEventDetail) {
    if (!this.signer.matches(company.id, company.taxId))
      throw new ConflictException("NO VERI*FACTU event signer does not match this company");
    const software = captureSifSoftwareSnapshot(company);
    if (!software.configured)
      throw new ConflictException("NO VERI*FACTU event requires a complete software profile");
    await db.$executeRaw`
      SELECT pg_advisory_xact_lock(hashtextextended(${company.id}, 1))
    `;
    const tail = await db.sifEventRecord.findMany({
      where: { organizationId: company.organizationId, companyId: company.id },
      orderBy: { chainPosition: "desc" }, take: 2,
    });
    const previous = tail[0];
    if (previous) {
      const verification = await verifySifEventTail(previous, tail[1] ?? null);
      if (!verification.valid)
        throw new ConflictException(`NO VERI*FACTU event chain failed at position ${verification.firstInvalid?.chainPosition}`);
    }
    const generatedAt = new Date();
    if (previous && previous.generatedAt > generatedAt)
      throw new ConflictException("System clock precedes the latest NO VERI*FACTU event");
    const formatted = formatSifTimestamp(generatedAt, company.timezone);
    const hashInput: SifEventHashInput = {
      producerTaxId: software.producerTaxId!,
      softwareId: software.softwareId!,
      softwareVersion: software.softwareVersion!,
      installationNumber: software.installationNumber!,
      issuerTaxId: company.taxId,
      eventType,
      previousHash: previous?.eventHash ?? null,
      generatedAt: formatted,
    };
    const event = renderSifBasicEventXml({
      ...hashInput,
      eventType,
      producerName: software.producerName!,
      softwareName: software.softwareName!,
      issuerName: company.legalName,
      detail,
      previous: previous ? {
        eventType: previous.eventType,
        generatedAt: (previous.hashInput as SifEventHashInput).generatedAt,
        hash: previous.eventHash,
      } : null,
    });
    const signedXml = await this.signer.sign(event.xml);
    return db.sifEventRecord.create({
      data: {
        organizationId: company.organizationId,
        companyId: company.id,
        eventType,
        chainPosition: (previous?.chainPosition ?? 0n) + 1n,
        generatedAt,
        previousEventId: previous?.id ?? null,
        previousEventHash: previous?.eventHash ?? null,
        eventHash: event.hash,
        hashInput: hashInput as Prisma.InputJsonObject,
        signedXml,
        signedXmlSha256: createHash("sha256").update(signedXml).digest("hex"),
        softwareSnapshot: software as Prisma.InputJsonObject,
      },
    });
  }

  /** Each summary covers events and invoice records since the previous summary. */
  async appendSummary(db: Prisma.TransactionClient, company: Company) {
    await db.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${company.id}, 1))`;
    const previousSummary = await db.sifEventRecord.findFirst({
      where: { companyId: company.id, eventType: "10" }, orderBy: { chainPosition: "desc" },
    });
    const events = await db.sifEventRecord.findMany({
      where: { companyId: company.id,
        ...(previousSummary ? { chainPosition: { gt: previousSummary.chainPosition } } : {}) },
      orderBy: { chainPosition: "asc" },
    });
    const records = await db.sifRecord.findMany({
      where: { companyId: company.id,
        ...(previousSummary ? { generatedAt: { gt: previousSummary.generatedAt } } : {}) },
      orderBy: { chainPosition: "asc" },
    });
    const countByType = new Map<string, number>();
    for (const event of events)
      countByType.set(event.eventType, (countByType.get(event.eventType) ?? 0) + 1);
    // XSD requires at least one row even when the period had no other event.
    const counts = countByType.size
      ? [...countByType].map(([eventType, count]) => ({ eventType, count }))
      : [{ eventType: "10", count: 0 }];
    const registrations = records.filter((record) =>
      record.recordType === SifRecordType.REGISTRATION || record.recordType === SifRecordType.SUBSANATION);
    const totals = sumRegistrations(registrations);
    return this.appendForCompany(db, company, "10", {
      kind: "10", counts,
      ...(records[0] ? { firstInvoice: invoiceReference(records[0]) } : {}),
      ...(records.at(-1) ? { lastInvoice: invoiceReference(records.at(-1)!) } : {}),
      registrations: registrations.length, ...totals,
      cancellations: records.filter((record) => record.recordType === SifRecordType.CANCELLATION).length,
    });
  }

  /** Snapshot existing signed events and record both export operations in the event chain. */
  async exportSnapshot(from: string, to: string, records: SifRecord[]) {
    const scope = this.tenant.required;
    if (!scope.companyId) throw new ConflictException("A company is required for SIF event export");
    const company = await this.tenant.db.company.findFirst({
      where: { id: scope.companyId, organizationId: scope.organizationId },
    });
    if (!company) return null;
    const canRecordExport = this.signer.matches(company.id, company.taxId);
    const all = await this.tenant.db.sifEventRecord.findMany({
      where: { organizationId: scope.organizationId, companyId: company.id },
      orderBy: { chainPosition: "asc" },
    });
    if (!all.length) {
      if (company.sifMode === "NO_VERIFACTU")
        throw new ConflictException("NO VERI*FACTU event chain is unavailable for export");
      return null;
    }
    const checked = await verifySifEventChain(all);
    if (!checked.valid)
      throw new ConflictException(`SIF event chain failed at position ${checked.firstInvalid?.chainPosition}`);
    for (const record of records) {
      const payload = record.payload;
      const xml = payload && typeof payload === "object" && !Array.isArray(payload)
        ? payload.aeatXml : null;
      if (typeof xml !== "string" || !await verifySifRecordSignature(xml))
        throw new ConflictException(`Signed SIF XML failed at position ${record.chainPosition}`);
    }
    const start = new Date(`${from}T00:00:00.000Z`);
    const end = new Date(new Date(`${to}T00:00:00.000Z`).getTime() + 86_400_000);
    const selected = all.filter((event) => event.generatedAt >= start && event.generatedAt < end);
    const fromTime = start.toISOString();
    const toTime = new Date(end.getTime() - 1_000).toISOString();
    if (canRecordExport && records.length) {
      const registrations = records.filter((record) =>
        record.recordType === SifRecordType.REGISTRATION || record.recordType === SifRecordType.SUBSANATION);
      await this.appendForCompany(this.tenant.db, company, "08", {
        kind: "08", from: fromTime, to: toTime,
        first: invoiceReference(records[0]), last: invoiceReference(records.at(-1)!),
        registrations: registrations.length, ...sumRegistrations(registrations),
        cancellations: records.filter((record) => record.recordType === SifRecordType.CANCELLATION).length,
      });
    }
    if (canRecordExport && selected.length) await this.appendForCompany(this.tenant.db, company, "09", {
      kind: "09", from: fromTime, to: toTime,
      first: eventReference(selected[0]), last: eventReference(selected.at(-1)!),
      count: selected.length,
    });
    return {
      recordsChecked: checked.recordsChecked,
      exportEventsRecorded: canRecordExport && (records.length > 0 || selected.length > 0),
      files: selected.map((event) => {
        const name = `events/${event.chainPosition.toString().padStart(12, "0")}-${event.eventType}.xml`;
        const content = Buffer.from(event.signedXml, "utf8");
        return { name, content, manifest: {
          name, eventId: event.id, chainPosition: event.chainPosition.toString(),
          eventType: event.eventType, generatedAt: event.generatedAt.toISOString(),
          eventHash: event.eventHash, sha256: event.signedXmlSha256,
        } };
      }),
    };
  }
}

function invoiceReference(record: SifRecord): SifInvoiceReference {
  return {
    issuerTaxId: record.issuerTaxId, invoiceNumber: record.invoiceNumber,
    issueDate: formatSifIssueDate(record.invoiceIssueDate), hash: record.recordHash,
  };
}

function eventReference(record: { eventType: string; hashInput: Prisma.JsonValue;
  eventHash: string }): SifEventReference {
  const input = record.hashInput as { generatedAt: string };
  return { eventType: record.eventType, generatedAt: input.generatedAt, hash: record.eventHash };
}

function sumRegistrations(records: SifRecord[]) {
  let tax = new Decimal(0);
  let total = new Decimal(0);
  for (const record of records) {
    const payload = record.payload as { hashInput?: { taxTotal?: string; total?: string } };
    tax = tax.plus(payload.hashInput?.taxTotal ?? record.taxTotal);
    total = total.plus(payload.hashInput?.total ?? record.total);
  }
  return { taxTotal: tax.toFixed(2), invoiceTotal: total.toFixed(2) };
}

function anomalyType(reason: string): string {
  if (/signature|policy/i.test(reason)) return "02";
  if (/hash|huella/i.test(reason)) return "01";
  if (/position|reference|chain|cadena/i.test(reason)) return "06";
  if (/time|fecha/i.test(reason)) return "14";
  return "90";
}

async function recordAlarm(db: Prisma.TransactionClient, company: Company,
  source: "INVOICE" | "EVENT", invalid: { id: string; chainPosition: string; reason: string }) {
  const fingerprint = createHash("sha256")
    .update(`${source}\0${invalid.id}\0${invalid.reason}`).digest("hex");
  await db.sifIntegrityAlarm.upsert({
    where: { companyId_fingerprint: { companyId: company.id, fingerprint } },
    create: { organizationId: company.organizationId, companyId: company.id,
      fingerprint, source, chainPosition: BigInt(invalid.chainPosition),
      reason: invalid.reason.slice(0, 300) },
    update: { lastDetectedAt: new Date(), resolvedAt: null },
  });
}
