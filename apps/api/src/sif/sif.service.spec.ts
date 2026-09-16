import { RectificationImpact, SifMode, SifRecordType } from "@prisma/client";
import { Decimal } from "@prisma/client/runtime/library";
import { SifService } from "./sif.service";

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

  it("stores supported registration XML with the immutable SIF record", async () => {
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
    expect(data.payload.aeatXml).toContain("<sf:RegistroAlta>");
    expect(data.payload.aeatXml).toContain(`<sf:Huella>${data.recordHash}</sf:Huella>`);
    expect(data.payload.aeatXml).toContain("<sf:NumSerieFactura>F2026-0009</sf:NumSerieFactura>");
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
      .rejects.toThrow("not production-ready");
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
