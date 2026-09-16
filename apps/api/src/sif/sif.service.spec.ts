import { SifMode, SifRecordType } from "@prisma/client";
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
});

describe("SifService registration profile", () => {
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
