import { INestApplication, ValidationPipe } from "@nestjs/common";
import { Test } from "@nestjs/testing";
import { PrismaClient } from "@prisma/client";
import { createHash } from "node:crypto";
import request = require("supertest");
import type { Test as SupertestTest } from "supertest";
import { AppModule } from "../src/app.module";
import { SifNoSigningService } from "../src/sif/sif-no-signing.service";
import { norma43Statement, TestMovement } from "./support/norma43-statement";
import { createSifTestSigner } from "./support/sif-test-signer";

describe("Norma 43 bank statement import", () => {
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
    await admin.$executeRawUnsafe("GRANT USAGE ON SCHEMA public TO pastagansa_app");
    await admin.$executeRawUnsafe(
      "GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO pastagansa_app",
    );
    await admin.$executeRawUnsafe(
      "GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO pastagansa_app",
    );
    await admin.$executeRawUnsafe(
      'TRUNCATE TABLE "organizations", "users", "roles", "permissions" CASCADE',
    );
    const module = await Test.createTestingModule({ imports: [AppModule] })
      .overrideProvider(SifNoSigningService)
      .useValue(testSigner.signer)
      .compile();
    app = module.createNestApplication();
    app.setGlobalPrefix("v1");
    app.useGlobalPipes(
      new ValidationPipe({ transform: true, whitelist: true, forbidNonWhitelisted: true }),
    );
    await app.init();
  });

  afterAll(async () => {
    if (app) await app.close();
    testSigner.restore();
    await prisma.$disconnect();
    await admin.$disconnect();
  });

  it("previews, imports once and skips already imported movements", async () => {
    const email = "norma43@example.com";
    const registered = await request(app.getHttpServer())
      .post("/v1/identity/register")
      .send({
        email,
        password: "correct horse battery staple",
        organizationName: "Norma 43 Org",
        legalName: "Norma 43 SL",
        taxId: "B12345674",
      })
      .expect(201);
    const membership = await prisma.membership.findFirstOrThrow({
      where: { user: { email } },
    });
    const apply = <T extends SupertestTest>(call: T) =>
      call
        .set("authorization", `Bearer ${registered.body.accessToken}`)
        .set("x-organization-id", membership.organizationId)
        .set("x-company-id", membership.companyId!);
    const get = (path: string) => apply(request(app.getHttpServer()).get(path));
    const post = (path: string) => apply(request(app.getHttpServer()).post(path));
    const upload = (step: "preview" | "import", file: string, fields: Record<string, string> = {}) => {
      const call = post(`/v1/banking/statements/norma43/${step}`).attach(
        "file",
        Buffer.from(file, "latin1"),
        "extracto.n43",
      );
      for (const [name, value] of Object.entries(fields)) call.field(name, value);
      return call;
    };
    const sha256 = (file: string) =>
      createHash("sha256").update(Buffer.from(file, "latin1")).digest("hex");

    const ledger = await get("/v1/accounting/accounts").expect(200);
    const bankLedger = ledger.body.find(({ code }: { code: string }) => code === "572000");
    const bankAccount = await post("/v1/banking/accounts")
      .send({
        accountId: bankLedger.id,
        name: "Cuenta operativa",
        iban: "ES91 2100 0418 4502 0005 1332",
        currency: "EUR",
      })
      .expect(201);

    const collected: TestMovement = {
      cents: 12_100,
      date: "260903",
      reference2: "F2026-00001",
      concepts: ["TRANSFERENCIA DE CLIENTE A", "FACTURA F2026-00001"],
    };
    const fee: TestMovement = { cents: -4_550, commonConcept: "17", date: "260910" };
    const september = norma43Statement([
      { holder: "NORMA 43 SL", movements: [collected, fee, { cents: 0, date: "260911" }] },
    ]);

    const preview = await upload("preview", september).expect(200);
    expect(preview.body).toMatchObject({
      fileSha256: sha256(september),
      accounts: [
        {
          iban: "ES9121000418450200051332",
          holderName: "NORMA 43 SL",
          startDate: "2026-09-01",
          endDate: "2026-09-30",
          openingBalance: "1000.00",
          closingBalance: "1075.50",
          bankAccount: { id: bankAccount.body.id, name: "Cuenta operativa" },
          newCount: 2,
          duplicateCount: 0,
          skippedCount: 1,
        },
      ],
    });
    expect(preview.body.accounts[0].movements.map(({ status }: { status: string }) => status)).toEqual([
      "NEW",
      "NEW",
      "SKIPPED",
    ]);

    await upload("import", september, { fileSha256: "0".repeat(64) }).expect(409);
    const imported = await upload("import", september, { fileSha256: sha256(september) }).expect(201);
    expect(imported.body).toMatchObject({ imported: 2, duplicates: 0, skipped: 1 });

    const transactions = await get(
      `/v1/banking/transactions?bankAccountId=${bankAccount.body.id}&limit=100`,
    ).expect(200);
    expect(
      transactions.body.data.map(({ bookingDate, amount, description, reference, status }: Record<string, string>) => ({
        bookingDate: bookingDate.slice(0, 10),
        amount: Number(amount),
        description,
        reference,
        status,
      })),
    ).toEqual([
      {
        bookingDate: "2026-09-10",
        amount: -45.5,
        description: "Intereses - comisiones - custodia - gastos e impuestos",
        reference: null,
        status: "UNMATCHED",
      },
      {
        bookingDate: "2026-09-03",
        amount: 121,
        description: "TRANSFERENCIA DE CLIENTE A FACTURA F2026-00001",
        reference: "F2026-00001",
        status: "UNMATCHED",
      },
    ]);

    const again = await upload("import", september, { fileSha256: sha256(september) }).expect(201);
    expect(again.body).toMatchObject({ imported: 0, duplicates: 2, skipped: 1 });

    const october = norma43Statement([
      {
        end: "261031",
        movements: [collected, fee, { cents: 30_000, date: "261002" }],
      },
    ]);
    expect((await upload("preview", october).expect(200)).body.accounts[0]).toMatchObject({
      newCount: 1,
      duplicateCount: 2,
    });
    expect(
      (await upload("import", october, { fileSha256: sha256(october) }).expect(201)).body,
    ).toMatchObject({ imported: 1, duplicates: 2 });

    const audit = await admin.auditEvent.findMany({
      where: { action: "bank_statement.imported", entityId: bankAccount.body.id },
    });
    expect(audit).toHaveLength(3);

    const otherAccount = norma43Statement([{ account: "0200059999", movements: [{ cents: 100 }] }]);
    const unlinked = await upload("preview", otherAccount).expect(200);
    expect(unlinked.body.accounts[0]).toMatchObject({ bankAccount: null, newCount: 1 });
    const rejected = await upload("import", otherAccount, { fileSha256: sha256(otherAccount) }).expect(400);
    expect(rejected.body.message).toMatch(/is not linked to an active bank account/);
    await upload("preview", otherAccount, { bankAccountId: bankAccount.body.id }).expect(400);

    const malformed = await upload("preview", "11".padEnd(80)).expect(400);
    expect(malformed.body.message).toMatch(/^Invalid Norma 43 file\. Line 1:/);
    await post("/v1/banking/statements/norma43/preview").expect(400);
  });
});
