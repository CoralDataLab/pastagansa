import { SifAeatSubmissionStatus as Status } from "@prisma/client";
import { ConfigService } from "@nestjs/config";
import { createHash } from "node:crypto";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AeatTestClient, AeatProductionClient, AeatTestTransportError } from "./aeat-test.client";
import { AeatTestWorker, AeatProductionWorker, aeatRetryDelaySeconds, predecessorHasDefinitiveAeatResponse } from "./aeat-test.worker";

const soap = "http://schemas.xmlsoap.org/soap/envelope/";
const response = "https://www2.agenciatributaria.gob.es/static_files/common/internet/dep/aplicaciones/es/aeat/tike/cont/ws/RespuestaSuministro.xsd";
const info = "https://www2.agenciatributaria.gob.es/static_files/common/internet/dep/aplicaciones/es/aeat/tike/cont/ws/SuministroInformacion.xsd";

function acceptedResponse() {
  return `<e:Envelope xmlns:e="${soap}" xmlns:r="${response}" xmlns:s="${info}"><e:Body>` +
    `<r:RespuestaRegFactuSistemaFacturacion><r:CSV>TEST-CSV</r:CSV>` +
    `<r:TiempoEsperaEnvio>60</r:TiempoEsperaEnvio><r:EstadoEnvio>Correcto</r:EstadoEnvio>` +
    `<r:RespuestaLinea><r:IDFactura><s:IDEmisorFactura>B12345674</s:IDEmisorFactura>` +
    `<s:NumSerieFactura>F2026-0001</s:NumSerieFactura>` +
    `<s:FechaExpedicionFactura>18-09-2026</s:FechaExpedicionFactura></r:IDFactura>` +
    `<r:EstadoRegistro>Correcto</r:EstadoRegistro></r:RespuestaLinea>` +
    `</r:RespuestaRegFactuSistemaFacturacion></e:Body></e:Envelope>`;
}

function duplicateResponse() {
  return acceptedResponse()
    .replace("<r:EstadoEnvio>Correcto</r:EstadoEnvio>", "<r:EstadoEnvio>Incorrecto</r:EstadoEnvio>")
    .replace("<r:EstadoRegistro>Correcto</r:EstadoRegistro></r:RespuestaLinea>",
      "<r:EstadoRegistro>Incorrecto</r:EstadoRegistro>" +
      "<r:RegistroDuplicado><s:IdPeticionRegistroDuplicado>ORIGINAL</s:IdPeticionRegistroDuplicado>" +
      "<s:EstadoRegistroDuplicado>Correcta</s:EstadoRegistroDuplicado></r:RegistroDuplicado></r:RespuestaLinea>");
}

function consultationResponse(hash: string) {
  const namespace = "https://www2.agenciatributaria.gob.es/static_files/common/internet/dep/aplicaciones/es/aeat/tike/cont/ws/RespuestaConsultaLR.xsd";
  return `<e:Envelope xmlns:e="${soap}" xmlns:r="${namespace}" xmlns:s="${info}"><e:Body>` +
    `<r:RespuestaConsultaFactuSistemaFacturacion><r:ResultadoConsulta>ConDatos</r:ResultadoConsulta>` +
    `<r:RegistroRespuestaConsultaFactuSistemaFacturacion>` +
    `<r:IDFactura><s:IDEmisorFactura>B12345674</s:IDEmisorFactura>` +
    `<s:NumSerieFactura>F2026-0001</s:NumSerieFactura>` +
    `<s:FechaExpedicionFactura>18-09-2026</s:FechaExpedicionFactura></r:IDFactura>` +
    `<r:DatosRegistroFacturacion><r:Huella>${hash}</r:Huella></r:DatosRegistroFacturacion>` +
    `<r:DatosPresentacion><s:IdPeticion>ORIGINAL</s:IdPeticion></r:DatosPresentacion>` +
    `<r:EstadoRegistro><r:EstadoRegistro>Correcto</r:EstadoRegistro></r:EstadoRegistro>` +
    `</r:RegistroRespuestaConsultaFactuSistemaFacturacion></r:RespuestaConsultaFactuSistemaFacturacion>` +
    `</e:Body></e:Envelope>`;
}

describe("AEAT test submission ordering", () => {
  it("sends after a definitive line-level rejection in the local chain", () => {
    expect(predecessorHasDefinitiveAeatResponse({
      status: Status.REJECTED,
      recordStatus: "Incorrecto",
    })).toBe(true);
  });

  it("waits when delivery or rejection is not a definitive line-level response", () => {
    expect(predecessorHasDefinitiveAeatResponse(null)).toBe(false);
    for (const status of [Status.PENDING, Status.SENDING, Status.RETRY, Status.FAILED, Status.UNKNOWN]) {
      expect(predecessorHasDefinitiveAeatResponse({ status, recordStatus: null })).toBe(false);
    }
    expect(predecessorHasDefinitiveAeatResponse({ status: Status.REJECTED, recordStatus: null })).toBe(false);
  });

  it("continues after accepted records", () => {
    expect(predecessorHasDefinitiveAeatResponse({
      status: Status.ACCEPTED,
      recordStatus: "Correcto",
    })).toBe(true);
    expect(predecessorHasDefinitiveAeatResponse({
      status: Status.ACCEPTED_WITH_ERRORS,
      recordStatus: "AceptadoConErrores",
    })).toBe(true);
  });
});

describe("AEAT production outbox isolation", () => {
  it("does not claim work if the declaration release is absent", async () => {
    const worker = new AeatProductionWorker(new ConfigService({}), {
      enabled: false, environment: "PRODUCTION", companyId: "company-a", issuerTaxId: "B12345674",
    } as AeatProductionClient);
    const updateMany = jest.fn();
    (worker as unknown as { admin: unknown }).admin = { sifAeatSubmission: { updateMany } };
    expect(await worker.processOne()).toBe(false);
    expect(updateMany).not.toHaveBeenCalled();
  });

  it("only queries submissions for the bound production issuer", async () => {
    const directory = mkdtempSync(join(tmpdir(), "aeat-release-"));
    const declaration = join(directory, "declaration.pdf");
    const bytes = Buffer.from("reviewed declaration");
    try {
      writeFileSync(declaration, bytes);
      const companyId = "22222222-2222-4222-8222-222222222222";
      const config = new ConfigService({
        SIF_PRODUCTION_RELEASE_ENABLED: "true",
        SIF_PRODUCTION_RELEASE_COMPANY_ID: companyId,
        SIF_PRODUCTION_DECLARATION_PATH: declaration,
        SIF_PRODUCTION_DECLARATION_SHA256: createHash("sha256").update(bytes).digest("hex"),
      });
      const worker = new AeatProductionWorker(config, {
        enabled: false, environment: "PRODUCTION", companyId, issuerTaxId: "B12345674",
      } as AeatProductionClient);
      const findMany = jest.fn().mockResolvedValue([]);
      const db = {
        $queryRaw: jest.fn().mockResolvedValue([{ acquired: true }]),
        sifAeatSubmission: { findFirst: jest.fn().mockResolvedValue(null), findMany },
      };
      (worker as unknown as { admin: unknown }).admin = {
        sifAeatSubmission: { updateMany: jest.fn().mockResolvedValue({ count: 0 }) },
        $transaction: (fn: (transaction: typeof db) => Promise<unknown>) => fn(db),
      };
      expect(await worker.processOne()).toBe(false);
      expect(findMany).toHaveBeenCalledWith(expect.objectContaining({
        where: expect.objectContaining({
          companyId,
          record: { invoice: { aeatEnvironment: "PRODUCTION", sifMode: "VERIFACTU" } },
        }),
      }));
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });
});

describe("AEAT uncertain delivery recovery", () => {
  afterEach(() => jest.useRealTimers());

  it("refuses to transmit a record belonging to another issuing company", async () => {
    const xml = "<frozen/>";
    const updateMany = jest.fn().mockResolvedValue({ count: 1 });
    const send = jest.fn();
    const worker = new AeatTestWorker({ get: () => undefined } as unknown as ConfigService,
      { enabled: false, companyId: "company-a", issuerTaxId: "B12345674", send } as unknown as AeatTestClient);
    (worker as unknown as { admin: unknown }).admin = { sifAeatSubmission: {
      findUniqueOrThrow: jest.fn().mockResolvedValue({
        companyId: "company-b", requestSha256: createHash("sha256").update(xml).digest("hex"),
        record: { issuerTaxId: "B12345674", payload: { aeatXml: xml },
          invoice: { aeatEnvironment: "TEST", sifMode: "VERIFACTU" } },
      }),
      updateMany,
    } };
    await (worker as unknown as { deliver: (id: string, attempts: number, lockedAt: Date) => Promise<void> })
      .deliver("submission", 1, new Date("2026-09-18T10:00:00.000Z"));
    expect(send).not.toHaveBeenCalled();
    expect(updateMany).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({ status: Status.FAILED }),
    }));
  });

  it("marks an incident on retry without changing the frozen billing record", async () => {
    jest.useFakeTimers().setSystemTime(new Date("2026-09-18T10:00:00.000Z"));
    const frozenXml = "<sfLR:RegFactuSistemaFacturacion>\n  <sfLR:Cabecera>\n  </sfLR:Cabecera>\n" +
      "  <sfLR:RegistroFactura>frozen</sfLR:RegistroFactura></sfLR:RegFactuSistemaFacturacion>";
    const lease: { status: Status; attempts: number; availableAt: Date; lockedAt: Date | null;
      lastAttemptAt: Date | null; incident: boolean } = {
      status: Status.PENDING, attempts: 0, availableAt: new Date("2026-09-18T09:00:00.000Z"),
      lockedAt: null as Date | null, lastAttemptAt: null as Date | null, incident: false };
    const submission = {
      companyId: "company",
      requestSha256: createHash("sha256").update(frozenXml).digest("hex"),
      record: {
        payload: { aeatXml: frozenXml }, issuerTaxId: "B12345674", invoiceNumber: "F2026-0001",
        invoiceIssueDate: new Date("2026-09-18T00:00:00.000Z"), previousRecordId: null,
        recordType: "REGISTRATION", recordHash: "A".repeat(64),
        invoice: { aeatEnvironment: "TEST", sifMode: "VERIFACTU", issuerLegalName: "Test", operationDate: null },
      },
    };
    const db = {
      $queryRaw: jest.fn().mockResolvedValue([{ acquired: true }]),
      sifAeatSubmission: {
        findFirst: jest.fn(async () => lease.lastAttemptAt ? {
          lastAttemptAt: lease.lastAttemptAt, waitSeconds: 60,
        } : null),
        findMany: jest.fn(async () => lease.availableAt <= new Date() &&
          ([Status.PENDING, Status.RETRY, Status.UNKNOWN] as Status[]).includes(lease.status)
          ? [{ id: "submission", companyId: "company", record: { previousRecordId: null } }] : []),
        findUniqueOrThrow: jest.fn(async () => ({ ...submission, incident: lease.incident })),
        update: jest.fn(async ({ data }: { data: { lockedAt: Date } }) => {
          lease.status = Status.SENDING; lease.attempts++; lease.lockedAt = data.lockedAt;
          lease.lastAttemptAt = data.lockedAt;
          return { id: "submission", attempts: lease.attempts, lockedAt: lease.lockedAt };
        }),
        updateMany: jest.fn(async ({ where, data }: { where: { lockedAt?: Date | { lt: Date } }; data: {
          status?: Status; availableAt?: Date; lockedAt?: null; incident?: boolean;
        } }) => {
          if (where.lockedAt && "lt" in where.lockedAt) {
            if (lease.status !== Status.SENDING || !lease.lockedAt || lease.lockedAt >= where.lockedAt.lt)
              return { count: 0 };
          } else if (where.lockedAt && where.lockedAt.getTime() !== lease.lockedAt?.getTime())
            return { count: 0 };
          if (data.status) lease.status = data.status;
          if (data.incident !== undefined) lease.incident = data.incident;
          if (data.availableAt) lease.availableAt = data.availableAt;
          if (data.lockedAt === null) lease.lockedAt = null;
          return { count: 1 };
        }),
      },
    };
    const client = {
      enabled: false,
      companyId: "company", issuerTaxId: "B12345674",
      send: jest.fn().mockRejectedValueOnce(new AeatTestTransportError("timeout", true))
        .mockResolvedValueOnce({ httpStatus: 200, responseXml: acceptedResponse() }),
    };
    const worker = new AeatTestWorker({ get: () => undefined } as unknown as ConfigService,
      client as unknown as AeatTestClient);
    (worker as unknown as { admin: unknown }).admin = { ...db, $transaction: (fn: (tx: typeof db) => Promise<unknown>) => fn(db) };

    expect(await worker.processOne()).toBe(true);
    expect(lease.status).toBe(Status.UNKNOWN);
    expect(lease.incident).toBe(true);
    expect(predecessorHasDefinitiveAeatResponse({ status: lease.status, recordStatus: null })).toBe(false);
    expect(lease.availableAt.getTime()).toBeGreaterThan(Date.now());
    jest.setSystemTime(new Date("2026-09-18T10:03:00.000Z"));
    expect(await worker.processOne()).toBe(true);
    expect(lease.status).toBe(Status.ACCEPTED);
    expect(client.send).toHaveBeenCalledTimes(2);
    expect(client.send.mock.calls[0][0]).toBe(frozenXml);
    expect(client.send.mock.calls[1][0]).toContain("<sf:Incidencia>S</sf:Incidencia>");
    expect(client.send.mock.calls[1][0]).toContain("<sfLR:RegistroFactura>frozen</sfLR:RegistroFactura>");
    expect(submission.record.payload.aeatXml).toBe(frozenXml);
    expect(db.sifAeatSubmission.findUniqueOrThrow).toHaveBeenCalledTimes(2);
  });

  it.each([
    ["before recovery", "2026-09-18T10:05:00.000Z", true],
    ["after recovery", "2026-09-18T09:55:00.000Z", false],
  ])("marks a queued successor created %s of its predecessor", async (_label, completedAt, affected) => {
    const frozenXml = "<sfLR:RegFactuSistemaFacturacion>\n  <sfLR:Cabecera>\n" +
      "  </sfLR:Cabecera>\n  <sfLR:RegistroFactura>next</sfLR:RegistroFactura>" +
      "</sfLR:RegFactuSistemaFacturacion>";
    const updateMany = jest.fn().mockResolvedValue({ count: 1 });
    const findFirst = jest.fn().mockResolvedValue({ incident: true, completedAt: new Date(completedAt) });
    const admin = { sifAeatSubmission: {
      findFirst,
      findUniqueOrThrow: jest.fn().mockResolvedValue({
        companyId: "company", createdAt: new Date("2026-09-18T10:00:00.000Z"), incident: false,
        requestSha256: createHash("sha256").update(frozenXml).digest("hex"),
        record: {
          payload: { aeatXml: frozenXml }, previousRecordId: "previous", recordType: "REGISTRATION",
          recordHash: "B".repeat(64), issuerTaxId: "B12345674", invoiceNumber: "F2026-0002",
          invoiceIssueDate: new Date("2026-09-18T00:00:00.000Z"),
          invoice: { aeatEnvironment: "TEST", sifMode: "VERIFACTU", issuerLegalName: "Test", operationDate: null },
        },
      }),
      updateMany,
    } };
    const client = { enabled: false, companyId: "company", issuerTaxId: "B12345674",
      send: jest.fn().mockResolvedValue({ httpStatus: 200, responseXml: acceptedResponse() }),
    };
    const worker = new AeatTestWorker({ get: () => undefined } as unknown as ConfigService,
      client as unknown as AeatTestClient);
    (worker as unknown as { admin: unknown }).admin = admin;
    await (worker as unknown as { deliver: (id: string, attempts: number, lockedAt: Date) => Promise<void> })
      .deliver("successor", 1, new Date("2026-09-18T10:06:00.000Z"));
    expect(findFirst).toHaveBeenCalledWith(expect.objectContaining({
      where: { companyId: "company", recordId: "previous" },
    }));
    expect(client.send.mock.calls[0][0].includes("<sf:Incidencia>S</sf:Incidencia>")).toBe(affected);
    expect(updateMany.mock.calls[0][0].data.incident).toBe(affected ? true : undefined);
  });

  it("caps the backoff without exhausting uncertain deliveries", () => {
    expect(aeatRetryDelaySeconds(1)).toBe(120);
    expect(aeatRetryDelaySeconds(100)).toBe(3_600);
  });

  it("recovers an expired sending lease after restart without immediate double-send", async () => {
    jest.useFakeTimers().setSystemTime(new Date("2026-09-18T10:00:00.000Z"));
    const row = { status: Status.SENDING as Status,
      lockedAt: new Date("2026-09-18T09:55:00.000Z"), availableAt: new Date("2026-09-18T09:55:00.000Z") };
    const db = {
      $queryRaw: jest.fn().mockResolvedValue([{ acquired: true }]),
      sifAeatSubmission: {
        findFirst: jest.fn().mockResolvedValue(null),
        findMany: jest.fn(async () => row.status === Status.UNKNOWN && row.availableAt <= new Date()
          ? [{ id: "submission", companyId: "company", record: { previousRecordId: null } }] : []),
        update: jest.fn(async ({ data }: { data: { lockedAt: Date } }) => {
          row.status = Status.SENDING; row.lockedAt = data.lockedAt;
          return { id: "submission", attempts: 2, lockedAt: row.lockedAt };
        }),
        updateMany: jest.fn(async ({ where, data }: {
          where: { status: Status; lockedAt: { lt: Date } };
          data: { status: Status; availableAt: Date; lockedAt: null };
        }) => {
          if (row.status === where.status && row.lockedAt < where.lockedAt.lt) {
            row.status = data.status; row.availableAt = data.availableAt;
            return { count: 1 };
          }
          return { count: 0 };
        }),
      },
    };
    const worker = new AeatTestWorker({ get: () => undefined } as unknown as ConfigService,
      { enabled: false } as AeatTestClient);
    (worker as unknown as { admin: unknown }).admin = { ...db, $transaction: (fn: (tx: typeof db) => Promise<unknown>) => fn(db) };
    const deliver = jest.spyOn(worker as never, "deliver" as never).mockResolvedValue(undefined as never);
    expect(await worker.processOne()).toBe(false);
    expect(row.status).toBe(Status.UNKNOWN);
    expect(deliver).not.toHaveBeenCalled();
    jest.setSystemTime(new Date("2026-09-18T10:01:01.000Z"));
    expect(await worker.processOne()).toBe(true);
    expect(deliver).toHaveBeenCalledWith("submission", 2, row.lockedAt);
  });

  it.each([
    ["matching frozen hash", "A".repeat(64), Status.ACCEPTED],
    ["different frozen hash", "B".repeat(64), Status.UNKNOWN],
  ])("reconciles a duplicate only with %s and the original request ID", async (_name, queryHash, expectedStatus) => {
    const frozenXml = "<sfLR:RegFactuSistemaFacturacion>frozen</sfLR:RegFactuSistemaFacturacion>";
    const updateMany = jest.fn().mockResolvedValue({ count: 1 });
    const admin = { sifAeatSubmission: {
      findUniqueOrThrow: jest.fn().mockResolvedValue({
        companyId: "company",
        requestSha256: createHash("sha256").update(frozenXml).digest("hex"),
        record: {
          payload: { aeatXml: frozenXml }, recordType: "REGISTRATION", recordHash: "A".repeat(64),
          issuerTaxId: "B12345674", invoiceNumber: "F2026-0001",
          invoiceIssueDate: new Date("2026-09-18T00:00:00.000Z"),
          invoice: { aeatEnvironment: "TEST", sifMode: "VERIFACTU", issuerLegalName: "Test", operationDate: null },
        },
      }),
      updateMany,
    } };
    const client = { enabled: false, companyId: "company", issuerTaxId: "B12345674",
      send: jest.fn().mockResolvedValue({ httpStatus: 200, responseXml: duplicateResponse() }),
      query: jest.fn().mockResolvedValue({ httpStatus: 200, responseXml: consultationResponse(queryHash) }),
    };
    const worker = new AeatTestWorker({ get: () => undefined } as unknown as ConfigService,
      client as unknown as AeatTestClient);
    (worker as unknown as { admin: unknown }).admin = admin;
    const lease = new Date("2026-09-18T10:00:00.000Z");
    await (worker as unknown as { deliver: (id: string, attempts: number, lockedAt: Date) => Promise<void> })
      .deliver("submission", 2, lease);
    expect(client.query).toHaveBeenCalledTimes(1);
    expect(updateMany).toHaveBeenCalledWith(expect.objectContaining({
      where: { id: "submission", status: Status.SENDING, lockedAt: lease },
      data: expect.objectContaining({ status: expectedStatus }),
    }));
    const completion = updateMany.mock.calls.find(([input]) => input.data.status === expectedStatus)?.[0].data;
    if (expectedStatus === Status.ACCEPTED)
      expect(completion).toMatchObject({ csv: null, reconciliationXml: consultationResponse(queryHash) });
    else
      expect(completion).toMatchObject({ reconciliationXml: consultationResponse(queryHash) });
  });
});
