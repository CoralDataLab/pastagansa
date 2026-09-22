import {
  ConflictException,
  INestApplication,
  ValidationPipe,
} from "@nestjs/common";
import { Test } from "@nestjs/testing";
import { PrismaClient } from "@prisma/client";
import { randomUUID } from "node:crypto";
import request = require("supertest");
import { AppModule } from "../src/app.module";
import { InvoicesService } from "../src/invoices/invoices.service";
import { SifNoSigningService } from "../src/sif/sif-no-signing.service";
import { TenantContextService } from "../src/tenancy/tenant-context.service";
import { createSifTestSigner } from "./support/sif-test-signer";

jest.setTimeout(180_000);

describe("invoice issuance concurrency", () => {
  let app: INestApplication;
  const testSigner = createSifTestSigner("B12345674");
  const prisma = new PrismaClient();
  const admin = new PrismaClient({
    datasources: { db: { url: process.env.DIRECT_DATABASE_URL } },
  });

  beforeAll(async () => {
    await admin.$executeRawUnsafe(
      "DO $$ BEGIN IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'pastagansa_app') THEN CREATE ROLE pastagansa_app LOGIN PASSWORD 'pastagansa_app' NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT; END IF; END $$",
    );
    await admin.$executeRawUnsafe(
      "GRANT USAGE ON SCHEMA public TO pastagansa_app",
    );
    await admin.$executeRawUnsafe(
      "GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO pastagansa_app",
    );
    await admin.$executeRawUnsafe(
      "GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO pastagansa_app",
    );
    await admin.$executeRawUnsafe(
      'TRUNCATE TABLE "organizations", "users", "roles", "permissions" CASCADE',
    );
    const module = await Test.createTestingModule({
      imports: [AppModule],
    }).overrideProvider(SifNoSigningService).useValue(testSigner.signer).compile();
    app = module.createNestApplication();
    app.setGlobalPrefix("v1");
    app.useGlobalPipes(
      new ValidationPipe({
        transform: true,
        whitelist: true,
        forbidNonWhitelisted: true,
      }),
    );
    await app.init();
  });

  afterAll(async () => {
    if (app) await app.close();
    testSigner.restore();
    await prisma.$disconnect();
    await admin.$disconnect();
  });

  it("allocates 100 unique numbers and rolls back a losing idempotency race", async () => {
    const account = await request(app.getHttpServer())
      .post("/v1/identity/register")
      .send({
        email: "issuer@example.com",
        password: "correct horse battery staple",
        organizationName: "Issuance Org",
        legalName: "Issuance Company",
        taxId: "B12345674",
      })
      .expect(201);
    const membership = await prisma.membership.findFirstOrThrow({
      where: { user: { email: "issuer@example.com" } },
    });
    const tenant = {
      organizationId: membership.organizationId,
      companyId: membership.companyId!,
      userId: membership.userId,
    };
    testSigner.bind(app, tenant.companyId);
    await tenantRequest(account.body.accessToken, tenant)
      .patch("/v1/companies/current")
      .send({
        sifMode: "NO_VERIFACTU",
        aeatEnvironment: "TEST",
        sifSoftwareProducerName: "Issuance Org",
        sifSoftwareProducerTaxId: "B12345674",
        sifSoftwareName: "PastaGansa",
        sifSoftwareId: "PG",
        sifSoftwareVersion: "0.1.0",
        sifInstallationNumber: "concurrency-test",
      })
      .expect(200);
    const contact = await tenantRequest(account.body.accessToken, tenant)
      .post("/v1/contacts")
      .send({
        legalName: "Concurrency Customer",
        taxId: "B76543214",
        isCustomer: true,
        isSupplier: false,
      })
      .expect(201);
    const sequence = await tenantRequest(account.body.accessToken, tenant)
      .post("/v1/document-sequences")
      .send({ documentType: "INVOICE", series: "FC", padding: 4 })
      .expect(201);

    const draftCodes = Array.from({ length: 102 }, () => randomUUID());
    const drafts = await prisma.$transaction(async (db) => {
      await db.$queryRaw`SELECT set_config('app.organization_id', ${tenant.organizationId}, true)`;
      await db.invoice.createMany({
        data: draftCodes.map((draftCode) => ({
          organizationId: tenant.organizationId,
          companyId: tenant.companyId,
          contactId: contact.body.id,
          draftCode,
          issuerLegalName: "Issuance Company",
          issuerTaxId: "B12345674",
          customerLegalName: "Concurrency Customer",
          customerTaxId: "B76543214",
          issueDate: new Date("2026-09-08"),
          currency: "EUR",
          subtotal: "100",
          discountTotal: "0",
          taxTotal: "21",
          total: "121",
          amountDue: "121",
        })),
      });
      const created = await db.invoice.findMany({
        where: { companyId: tenant.companyId, draftCode: { in: draftCodes } },
        select: { id: true, draftCode: true },
      });
      await db.invoiceLine.createMany({
        data: created.map(({ id }) => ({
          invoiceId: id,
          organizationId: tenant.organizationId,
          companyId: tenant.companyId,
          position: 1,
          description: "Concurrent issuance test",
          quantity: "1",
          unitPrice: "100",
          discountPct: "0",
          taxRate: "21",
          netAmount: "100",
          taxAmount: "21",
          totalAmount: "121",
        })),
      });
      const taxRule = await db.taxRule.findFirstOrThrow({
        where: { code: "ES_VAT_GENERAL_21" },
      });
      const invoiceLines = await db.invoiceLine.findMany({
        where: { invoiceId: { in: created.map(({ id }) => id) } },
      });
      await db.invoiceTaxLine.createMany({
        data: invoiceLines.map((line) => ({
          organizationId: tenant.organizationId,
          companyId: tenant.companyId,
          invoiceId: line.invoiceId,
          invoiceLineId: line.id,
          taxRuleId: taxRule.id,
          taxCode: taxRule.code,
          taxableBase: line.netAmount,
          taxRate: taxRule.rate,
          taxAmount: line.taxAmount,
          subject: taxRule.subject,
          exempt: taxRule.exempt,
          reverseCharge: taxRule.reverseCharge,
        })),
      });
      return draftCodes.map(
        (code) => created.find(({ draftCode }) => draftCode === code)!.id,
      );
    });

    const invoices = app.get(InvoicesService);
    const tenantContext = app.get(TenantContextService);
    const issue = (invoiceId: string, key: string) =>
      prisma.$transaction(
        async (db) => {
          await db.$queryRaw`SELECT set_config('app.organization_id', ${tenant.organizationId}, true)`;
          return tenantContext.run(
            {
              ...tenant,
              roleCodes: ["organization.owner"],
              db,
            },
            () =>
              invoices.issue(invoiceId, { sequenceId: sequence.body.id }, key),
          );
        },
        { maxWait: 60_000, timeout: 60_000 },
      );

    const issued: Array<Awaited<ReturnType<typeof issue>>> = [];
    // CI's Prisma pool has three connections. Keep real contention without
    // leaving dozens of transactions waiting for a pool slot.
    for (let start = 0; start < 100; start += 3) {
      const batch = drafts.slice(start, Math.min(start + 3, 100));
      issued.push(...await Promise.all(
        batch.map((id, offset) => issue(id, `bulk-${start + offset}`)),
      ));
    }
    const numbers = issued
      .map(({ number }) => Number(number))
      .sort((left, right) => left - right);
    expect(numbers).toEqual(
      Array.from({ length: 100 }, (_, index) => index + 1),
    );
    const retry = await issue(drafts[0], "bulk-0");
    expect(retry.fullNumber).toBe(issued[0].fullNumber);

    const collision = await Promise.allSettled([
      issue(drafts[100], "collision-key"),
      issue(drafts[101], "collision-key"),
    ]);
    expect(
      collision.filter(({ status }) => status === "fulfilled"),
    ).toHaveLength(1);
    const rejected = collision.find(({ status }) => status === "rejected");
    expect(rejected).toMatchObject({ reason: expect.any(ConflictException) });

    await prisma.$transaction(async (db) => {
      await db.$queryRaw`SELECT set_config('app.organization_id', ${tenant.organizationId}, true)`;
      const current = await db.documentSequence.findUniqueOrThrow({
        where: { id: sequence.body.id },
      });
      expect(current.nextNumber).toBe(102n);
      expect(
        await db.invoice.count({
          where: { companyId: tenant.companyId, status: "ISSUED" },
        }),
      ).toBe(101);
      const sifRecords = await db.sifRecord.findMany({
        where: { companyId: tenant.companyId },
        orderBy: { chainPosition: "asc" },
      });
      expect(sifRecords).toHaveLength(101);
      sifRecords.forEach((record, index) => {
        expect(record.chainPosition).toBe(BigInt(index + 1));
        expect(record.recordHash).toMatch(/^[0-9A-F]{64}$/);
        expect(record.previousRecordId).toBe(
          index === 0 ? null : sifRecords[index - 1].id,
        );
        expect(record.previousRecordHash).toBe(
          index === 0 ? null : sifRecords[index - 1].recordHash,
        );
      });
    });
    await tenantRequest(account.body.accessToken, tenant)
      .patch("/v1/companies/current")
      .send({ sifMode: "DISABLED" })
      .expect(200);
    const losingCollisionIndex = collision.findIndex(({ status }) => status === "rejected");
    const disabledInvoiceId = drafts[100 + losingCollisionIndex];
    const disabledInvoice = await issue(disabledInvoiceId, "disabled-invoice");
    expect(disabledInvoice.sifMode).toBe("DISABLED");
    expect(await admin.sifRecord.count({ where: { invoiceId: disabledInvoiceId } })).toBe(0);
    expect(await admin.sifRecord.count({ where: { companyId: tenant.companyId } })).toBe(101);
    await expect(
      admin.invoice.update({
        where: { id: drafts[0] },
        data: { total: "999" },
      }),
    ).rejects.toThrow(/issued invoice contents are immutable/);
    await expect(
      admin.invoice.delete({ where: { id: drafts[0] } }),
    ).rejects.toThrow(/issued invoices cannot be deleted/);
    const issuedLine = await admin.invoiceLine.findFirstOrThrow({
      where: { invoiceId: drafts[0] },
    });
    await expect(
      admin.invoiceLine.update({
        where: { id: issuedLine.id },
        data: { description: "Tampered" },
      }),
    ).rejects.toThrow(/issued invoice lines are immutable/);
    await expect(
      admin.invoiceLine.delete({ where: { id: issuedLine.id } }),
    ).rejects.toThrow(/issued invoice lines are immutable/);
    const sifRecord = await admin.sifRecord.findFirstOrThrow({
      where: { invoiceId: drafts[0] },
    });
    await expect(
      admin.sifRecord.update({
        where: { id: sifRecord.id },
        data: { payload: { tampered: true } },
      }),
    ).rejects.toThrow(/SIF records are append-only/);
    await expect(
      admin.sifRecord.delete({ where: { id: sifRecord.id } }),
    ).rejects.toThrow(/SIF records are append-only/);
  });

  function tenantRequest(
    token: string,
    tenant: { organizationId: string; companyId: string },
  ) {
    const apply = (call: request.Test) =>
      call
        .set("authorization", `Bearer ${token}`)
        .set("x-organization-id", tenant.organizationId)
        .set("x-company-id", tenant.companyId);
    return {
      post: (path: string) => apply(request(app.getHttpServer()).post(path)),
      patch: (path: string) => apply(request(app.getHttpServer()).patch(path)),
    };
  }
});
