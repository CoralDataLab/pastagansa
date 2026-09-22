import { ConflictException } from "@nestjs/common";
import { SifRecordType } from "@prisma/client";
import { Decimal } from "@prisma/client/runtime/library";
import { createHash } from "node:crypto";
import { hashSifRegistration } from "./sif-hash-v1";
import { SifService } from "./sif.service";

function zipEntries(buffer: Buffer) {
  const entries = new Map<string, Buffer>();
  let offset = 0;
  while (buffer.readUInt32LE(offset) === 0x04034b50) {
    const size = buffer.readUInt32LE(offset + 18);
    const nameLength = buffer.readUInt16LE(offset + 26);
    const name = buffer.subarray(offset + 30, offset + 30 + nameLength).toString("utf8");
    const contentStart = offset + 30 + nameLength;
    entries.set(name, buffer.subarray(contentStart, contentStart + size));
    offset = contentStart + size;
  }
  expect(buffer.readUInt32LE(offset)).toBe(0x02014b50);
  return entries;
}

describe("SIF period export", () => {
  const organizationId = "11111111-1111-4111-8111-111111111111";
  const companyId = "22222222-2222-4222-8222-222222222222";
  const hashInput = {
    issuerTaxId: "B12345674", invoiceNumber: "F2026-0001", issueDate: "21-09-2026",
    invoiceType: "F1", taxTotal: "21.00", total: "121.00", previousHash: "",
    generatedAt: "2026-09-22T09:00:00+02:00",
  };
  const record = {
    id: "33333333-3333-4333-8333-333333333333",
    invoiceId: "44444444-4444-4444-8444-444444444444",
    recordType: SifRecordType.REGISTRATION,
    chainPosition: 1n,
    issuerTaxId: hashInput.issuerTaxId,
    invoiceNumber: hashInput.invoiceNumber,
    invoiceIssueDate: new Date("2026-09-21T00:00:00.000Z"),
    invoiceType: "F1",
    taxTotal: new Decimal("21.00"), total: new Decimal("121.00"),
    generatedAt: new Date("2026-09-22T07:00:00.000Z"),
    previousRecordId: null, previousRecordHash: null,
    recordHash: hashSifRegistration(hashInput),
    payload: { hashInput, aeatXml: "<?xml version=\"1.0\"?><record>á</record>\n" },
  };

  function setup(records: unknown[]) {
    const findMany = jest.fn().mockResolvedValue(records);
    const auditRecord = jest.fn().mockResolvedValue({});
    const service = new SifService({
      required: { organizationId, companyId },
      db: { sifRecord: { findMany } },
    } as never, { record: auditRecord } as never);
    return { service, findMany, auditRecord };
  }

  it("exports exact XML bytes with a scoped, hashed manifest", async () => {
    const { service, findMany, auditRecord } = setup([record]);
    const result = await service.exportPeriod("2026-09-22", "2026-09-22");
    const entries = zipEntries(result.content);
    const xml = entries.get("records/000000000001-registration.xml");
    expect(xml?.toString("utf8")).toBe(record.payload.aeatXml);
    const manifest = JSON.parse(entries.get("manifest.json")!.toString("utf8"));
    expect(manifest).toMatchObject({ companyId, recordCount: 1, totalChainRecordsChecked: 1 });
    expect(manifest.records[0].sha256).toBe(createHash("sha256").update(xml!).digest("hex"));
    expect(findMany).toHaveBeenCalledWith({
      where: { organizationId, companyId }, orderBy: { chainPosition: "asc" },
    });
    expect(auditRecord).toHaveBeenCalledWith(
      "sif_record.period_exported", "company", companyId,
      expect.objectContaining({ recordCount: 1, archiveSha256: expect.any(String) }),
    );
  });

  it("fails the entire export if a selected frozen XML is missing", async () => {
    const { service, auditRecord } = setup([{ ...record, payload: { hashInput } }]);
    await expect(service.exportPeriod("2026-09-22", "2026-09-22"))
      .rejects.toBeInstanceOf(ConflictException);
    expect(auditRecord).not.toHaveBeenCalled();
  });

  it("rejects invalid ranges and corrupted chains", async () => {
    const { service } = setup([{ ...record, recordHash: "0".repeat(64) }]);
    await expect(service.exportPeriod("2026-09-22", "2026-09-21")).rejects.toThrow();
    await expect(service.exportPeriod("2026-02-30", "2026-03-01")).rejects.toThrow();
    await expect(service.exportPeriod("2026-09-22", "2026-09-22"))
      .rejects.toBeInstanceOf(ConflictException);
  });
});
