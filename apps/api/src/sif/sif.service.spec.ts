import { RectificationImpact, SifAeatSubmissionStatus as SubmissionStatus, SifMode, SifRecordType } from "@prisma/client";
import { Decimal } from "@prisma/client/runtime/library";
import { createHash } from "node:crypto";
import { SifService } from "./sif.service";

describe("SifService transition audit", () => {
  it("flags an experimental legacy group without changing its records", async () => {
    const queryRaw = jest.fn().mockResolvedValue([{
      sifMode: "DISABLED", aeatEnvironment: "PRODUCTION",
      recordType: "REGISTRATION", softwareId: "PASTAGANSA",
      records: 4, frozenXmlRecords: 0, unavailableXmlRecords: 0,
      legacyXmlRecords: 4, firstPosition: "1", lastPosition: "4",
    }]);
    const service = new SifService({
      required: {
        organizationId: "11111111-1111-4111-8111-111111111111",
        companyId: "22222222-2222-4222-8222-222222222222",
      },
      db: { $queryRaw: queryRaw },
    } as never, {} as never);

    await expect(service.transitionAudit()).resolves.toMatchObject({
      totalRecords: 4,
      historicalChainReviewRequired: true,
      groups: [{
        sifMode: "DISABLED", softwareId: "PASTAGANSA",
        softwareIdValid: false, legacyXmlRecords: 4,
      }],
    });
    expect(queryRaw).toHaveBeenCalledTimes(1);
  });
});

describe("SifService AEAT test overview", () => {
  it("separates delivery problems from definitive AEAT responses within the tenant", async () => {
    const organizationId = "11111111-1111-4111-8111-111111111111";
    const companyId = "22222222-2222-4222-8222-222222222222";
    const groupBy = jest.fn().mockResolvedValue([
      { status: SubmissionStatus.ACCEPTED, _count: { _all: 6 } },
      { status: SubmissionStatus.UNKNOWN, _count: { _all: 1 } },
    ]);
    const findMany = jest.fn()
      .mockResolvedValueOnce([{
        id: "submission", status: SubmissionStatus.UNKNOWN, attempts: 2,
        availableAt: new Date("2026-09-18T12:00:00.000Z"),
        lastAttemptAt: new Date("2026-09-18T11:58:00.000Z"),
        lastError: "Timeout", responseXml: "private SOAP response",
        record: { chainPosition: 9n, invoice: { id: "invoice", fullNumber: "F2026-0005" } },
      }])
      .mockResolvedValueOnce([
        {
          id: "warning", status: SubmissionStatus.ACCEPTED_WITH_ERRORS,
          recordStatus: "AceptadoConErrores", errorCode: "2000",
          errorDescription: "FechaHoraHusoGenRegistro fuera de margen", csv: "CSV-1",
          record: {
            recordType: SifRecordType.REGISTRATION, chainPosition: 2n,
            invoice: { id: "invoice-2", fullNumber: "F2026-0002", sifRecords: [{
              recordType: SifRecordType.SUBSANATION, chainPosition: 4n,
              aeatSubmissions: [{ status: SubmissionStatus.ACCEPTED }],
            }] },
          },
        },
        {
          id: "rejection", status: SubmissionStatus.REJECTED,
          recordStatus: "Incorrecto", errorCode: "4112",
          errorDescription: "Destinatario no identificado", csv: null,
          record: {
            recordType: SifRecordType.REGISTRATION, chainPosition: 1n,
            invoice: { id: "invoice-1", fullNumber: "F2026-0001", sifRecords: [] },
          },
        },
        {
          id: "warning-pending", status: SubmissionStatus.ACCEPTED_WITH_ERRORS,
          recordStatus: "AceptadoConErrores", errorCode: "2000",
          errorDescription: "FechaHoraHusoGenRegistro fuera de margen", csv: "CSV-2",
          record: {
            recordType: SifRecordType.REGISTRATION, chainPosition: 7n,
            invoice: { id: "invoice-7", fullNumber: "F2026-0007", sifRecords: [] },
          },
        },
        {
          id: "global-fault", status: SubmissionStatus.REJECTED,
          recordStatus: null, errorCode: null, errorDescription: "SOAP client fault",
          lastError: "AEAT SOAP fault env:Client", csv: null,
          record: {
            recordType: SifRecordType.REGISTRATION, chainPosition: 8n,
            invoice: { id: "invoice-8", fullNumber: "F2026-0008", sifRecords: [] },
          },
        },
      ]);
    const service = new SifService({
      required: { organizationId, companyId },
      db: { sifAeatSubmission: { groupBy, findMany } },
    } as never, {} as never);

    const result = await service.testSubmissionOverview();
    expect(result).toMatchObject({
      companyId,
      counts: { ACCEPTED: 6, UNKNOWN: 1, FAILED: 0, RETRY: 0 },
      attention: [{ status: "UNKNOWN", chainPosition: "9", invoiceNumber: "F2026-0005" }],
      review: [
        { reviewKind: "FOLLOW_UP_RECORDED", followUps: [{ chainPosition: "4", status: "ACCEPTED" }] },
        { reviewKind: "MANUAL_REVIEW", errorCode: "4112", invoiceNumber: "F2026-0001" },
        { reviewKind: "TIMESTAMP_SUBSANATION_CANDIDATE", invoiceNumber: "F2026-0007" },
        { reviewKind: "GLOBAL_REJECTION_REVIEW", invoiceNumber: "F2026-0008" },
      ],
    });
    expect(JSON.stringify(result)).not.toContain("private SOAP response");
    expect(groupBy).toHaveBeenCalledWith(expect.objectContaining({ where: { organizationId, companyId } }));
    expect(findMany).toHaveBeenCalledWith(expect.objectContaining({
      where: expect.objectContaining({ organizationId, companyId }), take: 20,
    }));
    expect(findMany).toHaveBeenCalledTimes(2);
    expect(findMany.mock.calls[1][0].select).not.toHaveProperty("responseXml");
  });
});

describe("SifService AEAT evidence export", () => {
  it("exports the stored SOAP response with its digest and scopes the lookup", async () => {
    const organizationId = "11111111-1111-4111-8111-111111111111";
    const companyId = "22222222-2222-4222-8222-222222222222";
    const findFirst = jest.fn().mockResolvedValue({
      id: "44444444-4444-4444-8444-444444444444", status: SubmissionStatus.ACCEPTED,
      requestSha256: "a".repeat(64), responseXml: "<soap>accepted</soap>",
      reconciliationXml: null, csv: "CSV-1", record: {
        chainPosition: 3n, issuerTaxId: "B12345674", invoiceNumber: "F2026-0003",
        invoiceIssueDate: new Date("2026-09-18T00:00:00.000Z"), recordHash: "b".repeat(64),
      },
    });
    const service = new SifService({
      required: { organizationId, companyId },
      db: { sifAeatSubmission: { findFirst } },
    } as never, {} as never);
    const file = await service.exportTestSubmissionEvidence(
      "33333333-3333-4333-8333-333333333333", "44444444-4444-4444-8444-444444444444",
    );
    const evidence = JSON.parse(file.content.toString("utf8"));
    expect(evidence).toMatchObject({ environment: "AEAT_TEST", chainPosition: "3", csv: "CSV-1" });
    expect(evidence.responseSha256).toBe(createHash("sha256").update(evidence.responseXml).digest("hex"));
    expect(findFirst).toHaveBeenCalledWith(expect.objectContaining({ where: {
      id: "44444444-4444-4444-8444-444444444444",
      recordId: "33333333-3333-4333-8333-333333333333", organizationId, companyId,
    } }));
  });
});

describe("SifService XML export", () => {
  const findFirst = jest.fn();
  const service = new SifService(
    {
      required: {
        organizationId: "11111111-1111-4111-8111-111111111111",
        companyId: "22222222-2222-4222-8222-222222222222",
      },
      db: { sifRecord: { findFirst } },
    } as never,
    {} as never,
  );

  beforeEach(() => {
    findFirst.mockReset();
  });

  it("exports a standard F1 registration without changing the record", async () => {
    findFirst.mockResolvedValue(record());

    const file = await service.exportXml("33333333-3333-4333-8333-333333333333");

    expect(file.filename).toBe("sif-1-registration.xml");
    expect(file.content.toString("utf8")).toContain("<sf:RegistroAlta>");
    expect(file.content.toString("utf8")).toContain("<sf:TipoFactura>F1</sf:TipoFactura>");
    expect(file.content.toString("utf8")).toContain("<sf:TipoImpositivo>21.00</sf:TipoImpositivo>");
    expect(findFirst).toHaveBeenCalledTimes(1);
  });

  it("blocks an export when the historical software ID cannot meet the AEAT schema", async () => {
    findFirst.mockResolvedValue(record({ softwareId: "PASTAGANSA" }));

    await expect(service.exportXml("33333333-3333-4333-8333-333333333333")).rejects.toThrow(
      "two uppercase letters or digits",
    );
  });

  it("keeps the hashed timestamp after the company timezone changes", async () => {
    findFirst.mockResolvedValue(record());
    const file = await service.exportXml("33333333-3333-4333-8333-333333333333");
    expect(file.content.toString("utf8")).toContain("2026-09-16T12:00:00+02:00");
    expect(file.content.toString("utf8")).not.toContain("2026-09-16T06:00:00-04:00");
  });

  it("exports the XML frozen at issuance instead of rebuilding it", async () => {
    findFirst.mockResolvedValue({
      ...(record() as Record<string, unknown>),
      payload: { aeatXml: "<?xml version=\"1.0\"?><frozen/>\n" },
      invoice: { issuerLegalName: "Changed elsewhere" },
    });

    const file = await service.exportXml("33333333-3333-4333-8333-333333333333");

    expect(file.content.toString("utf8")).toBe("<?xml version=\"1.0\"?><frozen/>\n");
  });

  it("does not reinterpret a new unsupported record at export time", async () => {
    findFirst.mockResolvedValue({
      ...(record() as Record<string, unknown>),
      payload: { xmlSnapshotUnavailable: "SIF XML export requires the customer's tax identifier" },
      invoice: { customerTaxId: "B76543210" },
    });

    await expect(service.exportXml("33333333-3333-4333-8333-333333333333"))
      .rejects.toThrow("customer's tax identifier");
  });

  it("does not reconstruct a historical rectification from mutable invoice data", async () => {
    findFirst.mockResolvedValue({ ...(record() as Record<string, unknown>), invoiceType: "R4" });

    await expect(service.exportXml("33333333-3333-4333-8333-333333333333"))
      .rejects.toThrow("original immutable snapshot");
  });
});

describe("SifService registration profile", () => {
  it.each([
    [RectificationImpact.DECREASE, "-100.00", "-21.00", "-121.00"],
    [RectificationImpact.INCREASE, "100.00", "21.00", "121.00"],
  ])("freezes an R4 difference XML with %s impact", async (impact, base, tax, total) => {
    const create = jest.fn().mockImplementation(({ data }) =>
      Promise.resolve({ ...data, chainPosition: 1n }),
    );
    const service = new SifService({
      required: {
        organizationId: "11111111-1111-4111-8111-111111111111",
        companyId: "22222222-2222-4222-8222-222222222222",
      },
      db: {
        $executeRaw: jest.fn(),
        sifRecord: { findFirst: jest.fn().mockResolvedValue(null), create },
        invoice: { findFirst: jest.fn().mockResolvedValue({
          id: "33333333-3333-4333-8333-333333333333",
          status: "ISSUED", fullNumber: "R2026-0001", sifMode: SifMode.NO_VERIFACTU,
          aeatEnvironment: "TEST", documentType: "CREDIT_NOTE", rectificationImpact: impact,
          issuerLegalName: "Coral Data Lab", issuerTaxId: "B12345674",
          customerLegalName: "Client S.L.", customerTaxId: "B76543210",
          sifInvoiceType: "R4", notes: null,
          originalInvoice: {
            issuerTaxId: "B12345674", fullNumber: "F2026-0009",
            issueDate: new Date("2026-09-15T00:00:00.000Z"),
          },
          issueDate: new Date("2026-09-16T00:00:00.000Z"),
          taxTotal: new Decimal("21.00"), total: new Decimal("121.00"),
          lines: [{ description: "Price correction" }],
          taxLines: [{
            taxableBase: new Decimal("100.00"), taxRate: new Decimal("21"),
            taxAmount: new Decimal("21.00"), subject: true, exempt: false,
            reverseCharge: false, surchargeRate: null, surchargeAmount: new Decimal("0"),
          }],
          company: {
            timezone: "Europe/Madrid",
            sifSoftwareProducerName: "Coral Data Lab", sifSoftwareProducerTaxId: "B12345674",
            sifSoftwareName: "PastaGansa", sifSoftwareId: "PG",
            sifSoftwareVersion: "0.1.0", sifInstallationNumber: "test-1",
          },
        }) },
      },
    } as never, { record: jest.fn() } as never);

    await service.createRegistration("33333333-3333-4333-8333-333333333333");

    const data = create.mock.calls[0][0].data;
    expect(data.payload.aeatXml).toContain("<sf:TipoRectificativa>I</sf:TipoRectificativa>");
    expect(data.payload.aeatXml).toContain("<sf:NumSerieFactura>F2026-0009</sf:NumSerieFactura>");
    expect(data.payload.aeatXml).toContain(`<sf:BaseImponibleOimporteNoSujeto>${base}</sf:BaseImponibleOimporteNoSujeto>`);
    expect(data.payload.aeatXml).toContain(`<sf:CuotaRepercutida>${tax}</sf:CuotaRepercutida>`);
    expect(data.payload.aeatXml).toContain(`<sf:ImporteTotal>${total}</sf:ImporteTotal>`);
    expect(data.total).toBe(total);
  });

  it.each([SifMode.NO_VERIFACTU, SifMode.VERIFACTU])
  ("freezes the %s registration and queues only test VERI*FACTU", async (mode) => {
    const create = jest.fn().mockImplementation(({ data }) =>
      Promise.resolve({ ...data, id: "44444444-4444-4444-8444-444444444444", chainPosition: 1n }),
    );
    const submissionCreate = jest.fn().mockResolvedValue({});
    const service = new SifService({
      required: {
        organizationId: "11111111-1111-4111-8111-111111111111",
        companyId: "22222222-2222-4222-8222-222222222222",
      },
      db: {
        $executeRaw: jest.fn(),
        sifRecord: { findFirst: jest.fn().mockResolvedValue(null), create },
        sifAeatSubmission: { create: submissionCreate },
        invoice: { findFirst: jest.fn().mockResolvedValue({
          id: "33333333-3333-4333-8333-333333333333",
          status: "ISSUED", fullNumber: "F2026-0009", sifMode: mode,
          aeatEnvironment: "TEST", documentType: "INVOICE", rectificationImpact: null,
          issuerLegalName: "Coral Data Lab", issuerTaxId: "B12345674",
          customerLegalName: "Client S.L.", customerTaxId: "B76543210",
          sifInvoiceType: "F1", notes: null,
          issueDate: new Date("2026-09-16T00:00:00.000Z"),
          taxTotal: new Decimal("21.00"), total: new Decimal("121.00"),
          lines: [{ description: "Consulting" }],
          taxLines: [{
            taxableBase: new Decimal("100.00"), taxRate: new Decimal("21"),
            taxAmount: new Decimal("21.00"), subject: true, exempt: false,
            reverseCharge: false, surchargeRate: null, surchargeAmount: new Decimal("0"),
          }],
          company: {
            timezone: "Europe/Madrid",
            sifSoftwareProducerName: "Coral Data Lab", sifSoftwareProducerTaxId: "B12345674",
            sifSoftwareName: "PastaGansa", sifSoftwareId: "PG",
            sifSoftwareVersion: "0.1.0", sifInstallationNumber: "test-1",
          },
        }) },
      },
    } as never, { record: jest.fn() } as never, { enabled: true } as never);

    await service.createRegistration("33333333-3333-4333-8333-333333333333");

    const data = create.mock.calls[0][0].data;
    expect(data.payload.aeatXml).toContain("<sf:RegistroAlta>");
    expect(data.payload.aeatXml).toContain(`<sf:Huella>${data.recordHash}</sf:Huella>`);
    expect(data.payload.aeatXml).toContain("<sf:NumSerieFactura>F2026-0009</sf:NumSerieFactura>");
    if (mode === SifMode.VERIFACTU) {
      expect(submissionCreate).toHaveBeenCalledWith({ data: {
        organizationId: "11111111-1111-4111-8111-111111111111",
        companyId: "22222222-2222-4222-8222-222222222222",
        recordId: "44444444-4444-4444-8444-444444444444",
        requestSha256: createHash("sha256").update(data.payload.aeatXml).digest("hex"),
      } });
    } else {
      expect(submissionCreate).not.toHaveBeenCalled();
    }
  });

  it.each([
    ["reverse charge", new Decimal("21"), true, "reverse-charge"],
    ["unsupported VAT rate", new Decimal("13"), false, "standard VAT rates"],
  ])("keeps the SIF record but withholds invalid AEAT XML for %s", async (_case, taxRate, reverseCharge, reason) => {
    const create = jest.fn().mockImplementation(({ data }) =>
      Promise.resolve({ ...data, chainPosition: 1n }),
    );
    const service = new SifService({
      required: {
        organizationId: "11111111-1111-4111-8111-111111111111",
        companyId: "22222222-2222-4222-8222-222222222222",
      },
      db: {
        $executeRaw: jest.fn(),
        sifRecord: { findFirst: jest.fn().mockResolvedValue(null), create },
        invoice: { findFirst: jest.fn().mockResolvedValue({
          id: "33333333-3333-4333-8333-333333333333",
          status: "ISSUED", fullNumber: "F2026-0009", sifMode: SifMode.NO_VERIFACTU,
          aeatEnvironment: "TEST", documentType: "INVOICE", rectificationImpact: null,
          issuerLegalName: "Coral Data Lab", issuerTaxId: "B12345674",
          customerLegalName: "Client S.L.", customerTaxId: "B76543210",
          sifInvoiceType: "F1", notes: null,
          issueDate: new Date("2026-09-16T00:00:00.000Z"),
          taxTotal: new Decimal("21.00"), total: new Decimal("121.00"),
          lines: [{ description: "Consulting" }],
          taxLines: [{
            taxableBase: new Decimal("100.00"), taxRate,
            taxAmount: new Decimal("21.00"), subject: true, exempt: false,
            reverseCharge, surchargeRate: null, surchargeAmount: new Decimal("0"),
          }],
          company: {
            timezone: "Europe/Madrid",
            sifSoftwareProducerName: "Coral Data Lab", sifSoftwareProducerTaxId: "B12345674",
            sifSoftwareName: "PastaGansa", sifSoftwareId: "PG",
            sifSoftwareVersion: "0.1.0", sifInstallationNumber: "test-1",
          },
        }) },
      },
    } as never, { record: jest.fn() } as never);

    await service.createRegistration("33333333-3333-4333-8333-333333333333");

    const data = create.mock.calls[0][0].data;
    expect(data.payload.aeatXml).toBeUndefined();
    expect(data.payload.xmlSnapshotUnavailable).toContain(reason);
  });

  it("does not create a SIF record for a newly issued DISABLED invoice", async () => {
    const create = jest.fn();
    const service = new SifService({
      required: {
        organizationId: "11111111-1111-4111-8111-111111111111",
        companyId: "22222222-2222-4222-8222-222222222222",
      },
      db: {
        $executeRaw: jest.fn(),
        sifRecord: { findFirst: jest.fn().mockResolvedValue(null), create },
        invoice: { findFirst: jest.fn().mockResolvedValue({
          status: "ISSUED", fullNumber: "F2026-0009", sifMode: SifMode.DISABLED,
        }) },
      },
    } as never, {} as never);

    await expect(service.createRegistration("33333333-3333-4333-8333-333333333333"))
      .resolves.toBeNull();
    expect(create).not.toHaveBeenCalled();
  });

  it("preserves an existing DISABLED-era record on an idempotent retry", async () => {
    const legacy = record();
    const create = jest.fn();
    const invoiceFindFirst = jest.fn();
    const service = new SifService({
      required: {
        organizationId: "11111111-1111-4111-8111-111111111111",
        companyId: "22222222-2222-4222-8222-222222222222",
      },
      db: {
        $executeRaw: jest.fn(),
        sifRecord: { findFirst: jest.fn().mockResolvedValue(legacy), create },
        invoice: { findFirst: invoiceFindFirst },
      },
    } as never, {} as never);

    await expect(service.createRegistration("33333333-3333-4333-8333-333333333333"))
      .resolves.toMatchObject({ recordHash: "A".repeat(64) });
    expect(invoiceFindFirst).not.toHaveBeenCalled();
    expect(create).not.toHaveBeenCalled();
  });

  it("rejects a no VERI*FACTU production invoice before creating a record", async () => {
    const create = jest.fn();
    const service = new SifService({
      required: {
        organizationId: "11111111-1111-4111-8111-111111111111",
        companyId: "22222222-2222-4222-8222-222222222222",
      },
      db: {
        $executeRaw: jest.fn(),
        sifRecord: { findFirst: jest.fn().mockResolvedValue(null), create },
        invoice: { findFirst: jest.fn().mockResolvedValue({
          status: "ISSUED", fullNumber: "F2026-0009", sifMode: SifMode.NO_VERIFACTU,
          aeatEnvironment: "PRODUCTION",
        }) },
      },
    } as never, {} as never);

    await expect(service.createRegistration("33333333-3333-4333-8333-333333333333"))
      .rejects.toThrow("production is not enabled");
    expect(create).not.toHaveBeenCalled();
  });

  it("rejects a legacy software ID before adding a no VERI*FACTU record", async () => {
    const create = jest.fn();
    const service = new SifService({
      required: {
        organizationId: "11111111-1111-4111-8111-111111111111",
        companyId: "22222222-2222-4222-8222-222222222222",
      },
      db: {
        $executeRaw: jest.fn(),
        sifRecord: { findFirst: jest.fn().mockResolvedValue(null), create },
        invoice: { findFirst: jest.fn().mockResolvedValue({
          status: "ISSUED", fullNumber: "F2026-0009", sifMode: SifMode.NO_VERIFACTU,
          aeatEnvironment: "TEST",
          company: {
            sifSoftwareProducerName: "Coral Data Lab", sifSoftwareProducerTaxId: "B12345674",
            sifSoftwareName: "Pastagansa", sifSoftwareId: "PASTAGANSA",
            sifSoftwareVersion: "0.1.0", sifInstallationNumber: "staging-1",
          },
        }) },
      },
    } as never, {} as never);

    await expect(service.createRegistration("33333333-3333-4333-8333-333333333333")).rejects.toThrow(
      "two-character software ID",
    );
    expect(create).not.toHaveBeenCalled();
  });
});

describe("SifService cancellation snapshot", () => {
  it("stores the cancellation XML with the immutable record", async () => {
    const registration = {
      ...(record() as Record<string, unknown>),
      id: "44444444-4444-4444-8444-444444444444",
      invoiceId: "33333333-3333-4333-8333-333333333333",
      recordHash: "A".repeat(64),
    };
    const create = jest.fn().mockImplementation(({ data }) =>
      Promise.resolve({ ...data, chainPosition: 2n }),
    );
    const service = new SifService({
      required: {
        organizationId: "11111111-1111-4111-8111-111111111111",
        companyId: "22222222-2222-4222-8222-222222222222",
      },
      db: {
        $executeRaw: jest.fn(),
        sifRecord: { findFirst: jest.fn()
          .mockResolvedValueOnce(null)
          .mockResolvedValueOnce(registration)
          .mockResolvedValueOnce(registration), create },
        invoice: { findFirst: jest.fn().mockResolvedValue({
          status: "ISSUED", issuerLegalName: "Coral Data Lab",
          issuerTaxId: "B12345674", company: { timezone: "Europe/Madrid" },
        }) },
      },
    } as never, { record: jest.fn() } as never);

    await service.createCancellation("33333333-3333-4333-8333-333333333333");

    const data = create.mock.calls[0][0].data;
    expect(data.payload.aeatXml).toContain("<sf:RegistroAnulacion>");
    expect(data.payload.aeatXml).toContain(`<sf:Huella>${data.recordHash}</sf:Huella>`);
    expect(data.payload.aeatXml).toContain(`<sf:Huella>${registration.recordHash}</sf:Huella>`);
  });
});

describe("SifService AEAT recovery", () => {
  const invoiceId = "33333333-3333-4333-8333-333333333333";
  const source = {
    ...(record() as Record<string, unknown>),
    id: "44444444-4444-4444-8444-444444444444",
    invoiceId,
    recordHash: "A".repeat(64),
    payload: { aeatXml: "<original/>" },
  };
  const context = {
    organizationId: "11111111-1111-4111-8111-111111111111",
    companyId: "22222222-2222-4222-8222-222222222222",
  };

  it("uses SinRegistroPrevio only after a confirmed line-level rejection", async () => {
    const create = jest.fn().mockImplementation(({ data }) => Promise.resolve(data));
    const service = new SifService({
      required: context,
      db: {
        $executeRaw: jest.fn(),
        sifRecord: { findFirst: jest.fn()
          .mockResolvedValueOnce(null).mockResolvedValueOnce(source)
          .mockResolvedValueOnce(source), create },
        sifAeatSubmission: {
          findFirst: jest.fn().mockResolvedValue({ status: "REJECTED", recordStatus: "Incorrecto" }),
          create: jest.fn(),
        },
        invoice: { findFirst: jest.fn().mockResolvedValue({
          status: "ISSUED", sifMode: "VERIFACTU", aeatEnvironment: "TEST",
          issuerLegalName: "Coral Data Lab", issuerTaxId: "B12345674",
          company: { timezone: "Europe/Madrid" },
        }) },
      },
    } as never, { record: jest.fn() } as never, { enabled: true } as never);

    await service.createCancellation(invoiceId);
    const payload = create.mock.calls[0][0].data.payload;
    expect(payload.sinRegistroPrevio).toBe("S");
    expect(payload.aeatXml).toContain("<sf:SinRegistroPrevio>S</sf:SinRegistroPrevio>");
  });

  it("does not cancel when AEAT has not given a definitive line response", async () => {
    const create = jest.fn();
    const service = new SifService({
      required: context,
      db: {
        $executeRaw: jest.fn(),
        sifRecord: { findFirst: jest.fn().mockResolvedValueOnce(null).mockResolvedValueOnce(source), create },
        sifAeatSubmission: { findFirst: jest.fn().mockResolvedValue({ status: "REJECTED", recordStatus: null }) },
        invoice: { findFirst: jest.fn().mockResolvedValue({
          status: "ISSUED", sifMode: "VERIFACTU", aeatEnvironment: "TEST",
        }) },
      },
    } as never, {} as never, { enabled: true } as never);
    await expect(service.createCancellation(invoiceId)).rejects.toThrow("definitive AEAT response");
    expect(create).not.toHaveBeenCalled();
  });

  it("appends a frozen alta subsanation for the confirmed time warning", async () => {
    const create = jest.fn().mockImplementation(({ data }) => Promise.resolve(data));
    const enqueue = jest.fn();
    const service = new SifService({
      required: context,
      db: {
        $executeRaw: jest.fn(),
        sifRecord: { findFirst: jest.fn()
          .mockResolvedValueOnce(null).mockResolvedValueOnce(source)
          .mockResolvedValueOnce(null).mockResolvedValueOnce(source), create },
        sifAeatSubmission: {
          findFirst: jest.fn().mockResolvedValue({
            status: "ACCEPTED_WITH_ERRORS", recordStatus: "AceptadoConErrores",
            errorDescription: "El valor del campo FechaHoraHusoGenRegistro debe ser la fecha actual",
          }),
          create: enqueue,
        },
        invoice: { findFirst: jest.fn().mockResolvedValue({
          ...((source as Record<string, unknown>).invoice as Record<string, unknown>),
          id: invoiceId, status: "ISSUED", sifMode: "VERIFACTU", aeatEnvironment: "TEST",
          issuerLegalName: "Acme S.L.", issuerTaxId: "B12345674",
          sifInvoiceType: "F1", company: { timezone: "Europe/Madrid" },
        }) },
      },
    } as never, { record: jest.fn() } as never, { enabled: true } as never);

    await service.createTimestampSubsanation(invoiceId);
    const data = create.mock.calls[0][0].data;
    expect(data.recordType).toBe(SifRecordType.SUBSANATION);
    expect(data.chainPosition).toBe(2n);
    expect(data.payload.subsanationOf).toEqual({ recordId: source.id, recordHash: source.recordHash });
    expect(data.payload.aeatXml).toContain("<sf:Subsanacion>S</sf:Subsanacion>");
    expect(data.payload.aeatXml).not.toContain("<sf:RechazoPrevio>");
    expect(enqueue).toHaveBeenCalledTimes(1);
  });
});

function record(profile: { softwareId?: string } = {}) {
  return {
    recordType: SifRecordType.REGISTRATION,
    chainPosition: 1n,
    issuerTaxId: "B12345674",
    invoiceNumber: "F2026-0001",
    invoiceIssueDate: new Date("2026-09-16T00:00:00.000Z"),
    invoiceType: "F1",
    taxTotal: new Decimal("21.00"),
    total: new Decimal("121.00"),
    generatedAt: new Date("2026-09-16T10:00:00.000Z"),
    payload: { hashInput: { generatedAt: "2026-09-16T12:00:00+02:00" } },
    recordHash: "A".repeat(64),
    softwareSnapshot: {
      producerName: "Coral Data Lab, S.L.",
      producerTaxId: "B12345674",
      softwareName: "PastaGansa",
      softwareId: profile.softwareId ?? "PG",
      softwareVersion: "0.1.0",
      installationNumber: "test-1",
    },
    previousRecord: null,
    invoice: {
      issuerLegalName: "Acme S.L.",
      issuerTaxId: "B12345674",
      customerLegalName: "Client S.L.",
      customerTaxId: "B76543210",
      notes: null,
      sifInvoiceType: "F1",
      company: { timezone: "America/New_York" },
      lines: [{ description: "Consulting" }],
      taxLines: [
        {
          taxableBase: new Decimal("100.00"),
          taxRate: new Decimal("21"),
          taxAmount: new Decimal("21.00"),
          subject: true,
          exempt: false,
          reverseCharge: false,
          surchargeRate: null,
          surchargeAmount: new Decimal("0"),
        },
      ],
    },
  } as never;
}
