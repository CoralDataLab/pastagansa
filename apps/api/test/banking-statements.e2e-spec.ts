import { INestApplication, ValidationPipe } from "@nestjs/common";
import { Test } from "@nestjs/testing";
import { PrismaClient } from "@prisma/client";
import { createHash } from "node:crypto";
import request = require("supertest");
import type { Test as SupertestTest } from "supertest";
import * as XLSX from "xlsx";
import { AppModule } from "../src/app.module";
import { SifNoSigningService } from "../src/sif/sif-no-signing.service";
import { norma43Statement, TestMovement } from "./support/norma43-statement";
import { createSifTestSigner } from "./support/sif-test-signer";

describe("bank statement import", () => {
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

  /** Registers a company with one bank account and returns request helpers for it. */
  async function companyWithBankAccount(email: string) {
    const registered = await request(app.getHttpServer())
      .post("/v1/identity/register")
      .send({
        email,
        password: "correct horse battery staple",
        organizationName: `${email} org`,
        legalName: "Extractos SL",
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
    const upload = (path: string, file: Buffer, fields: Record<string, string> = {}) => {
      const call = post(`/v1/banking/statements/${path}`).attach("file", file, "extracto");
      for (const [name, value] of Object.entries(fields)) call.field(name, value);
      return call;
    };
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
    return { get, upload, bankAccountId: bankAccount.body.id as string };
  }

  const sha256 = (file: Buffer) => createHash("sha256").update(file).digest("hex");

  it("previews, imports once and skips already imported Norma 43 movements", async () => {
    const { get, upload, bankAccountId } = await companyWithBankAccount("norma43@example.com");
    const collected: TestMovement = {
      cents: 12_100,
      date: "260903",
      reference2: "F2026-00001",
      concepts: ["TRANSFERENCIA DE CLIENTE A", "FACTURA F2026-00001"],
    };
    const fee: TestMovement = { cents: -4_550, commonConcept: "17", date: "260910" };
    const september = Buffer.from(
      norma43Statement([
        { holder: "NORMA 43 SL", movements: [collected, fee, { cents: 0, date: "260911" }] },
      ]),
      "latin1",
    );

    const preview = await upload("norma43/preview", september).expect(200);
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
          bankAccount: { id: bankAccountId, name: "Cuenta operativa" },
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

    await upload("norma43/import", september, { fileSha256: "0".repeat(64) }).expect(409);
    const imported = await upload("norma43/import", september, { fileSha256: sha256(september) }).expect(201);
    expect(imported.body).toMatchObject({ imported: 2, duplicates: 0, skipped: 1 });

    const transactions = await get(
      `/v1/banking/transactions?bankAccountId=${bankAccountId}&limit=100`,
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

    const again = await upload("norma43/import", september, { fileSha256: sha256(september) }).expect(201);
    expect(again.body).toMatchObject({ imported: 0, duplicates: 2, skipped: 1 });

    const october = Buffer.from(
      norma43Statement([
        { end: "261031", movements: [collected, fee, { cents: 30_000, date: "261002" }] },
      ]),
      "latin1",
    );
    expect((await upload("norma43/preview", october).expect(200)).body.accounts[0]).toMatchObject({
      newCount: 1,
      duplicateCount: 2,
    });
    expect(
      (await upload("norma43/import", october, { fileSha256: sha256(october) }).expect(201)).body,
    ).toMatchObject({ imported: 1, duplicates: 2 });

    const audit = await admin.auditEvent.findMany({
      where: { action: "bank_statement.imported", entityId: bankAccountId },
    });
    expect(audit).toHaveLength(3);

    const otherAccount = Buffer.from(
      norma43Statement([{ account: "0200059999", movements: [{ cents: 100 }] }]),
      "latin1",
    );
    const unlinked = await upload("norma43/preview", otherAccount).expect(200);
    expect(unlinked.body.accounts[0]).toMatchObject({ bankAccount: null, newCount: 1 });
    const rejected = await upload("norma43/import", otherAccount, { fileSha256: sha256(otherAccount) }).expect(400);
    expect(rejected.body.message).toMatch(/is not linked to an active bank account/);
    await upload("norma43/preview", otherAccount, { bankAccountId }).expect(400);

    const malformed = await upload("norma43/preview", Buffer.from("11".padEnd(80))).expect(400);
    expect(malformed.body.message).toMatch(/^Invalid Norma 43 file\. Line 1:/);
    await upload("norma43/preview", Buffer.alloc(0)).expect(400);
  });

  it("imports CSV and Excel statements with a remembered column mapping", async () => {
    const { get, upload, bankAccountId } = await companyWithBankAccount("tabla@example.com");
    const csv = Buffer.from(
      [
        "Cuenta;ES91 2100 0418 4502 0005 1332",
        "",
        "Fecha operación;Fecha valor;Concepto;Beneficiario;Importe;Saldo",
        "03/09/2026;03/09/2026;TRANSFERENCIA RECIBIDA;CLIENTE A SL;1.210,00;2.210,00",
        "10/09/2026;10/09/2026;COMISION MANTENIMIENTO;;-45,50;2.164,50",
        ";;Saldo final;;;2.164,50",
      ].join("\r\n"),
      "latin1",
    );

    const inspected = await upload("table/inspect", csv, { bankAccountId }).expect(200);
    expect(inspected.body).toMatchObject({
      fileSha256: sha256(csv),
      format: "CSV",
      delimiter: ";",
      savedMapping: false,
      mapping: {
        headerRow: 2,
        dateColumn: "Fecha operación",
        valueDateColumn: "Fecha valor",
        amountMode: "SIGNED",
        amountColumn: "Importe",
        decimalSeparator: ",",
        descriptionColumns: ["Concepto"],
        counterpartyColumn: "Beneficiario",
      },
    });
    expect(inspected.body.rows[2]).toEqual([
      "Fecha operación",
      "Fecha valor",
      "Concepto",
      "Beneficiario",
      "Importe",
      "Saldo",
    ]);
    const mapping = JSON.stringify(inspected.body.mapping);

    const preview = await upload("table/preview", csv, { bankAccountId, mapping }).expect(200);
    expect(preview.body).toMatchObject({
      format: "CSV",
      errors: [],
      errorCount: 0,
      ignoredCount: 1,
      accounts: [
        {
          iban: "ES9121000418450200051332",
          startDate: "2026-09-03",
          endDate: "2026-09-10",
          openingBalance: null,
          bankAccount: { id: bankAccountId },
          newCount: 2,
          duplicateCount: 0,
        },
      ],
    });

    await upload("table/import", csv, { bankAccountId, mapping, fileSha256: "0".repeat(64) }).expect(409);
    expect(
      (await upload("table/import", csv, { bankAccountId, mapping, fileSha256: sha256(csv) }).expect(201)).body,
    ).toMatchObject({ imported: 2, duplicates: 0 });
    const transactions = await get(`/v1/banking/transactions?bankAccountId=${bankAccountId}`).expect(200);
    expect(
      transactions.body.data.map(({ amount, description, counterpartyName }: Record<string, string>) => [
        Number(amount),
        description,
        counterpartyName,
      ]),
    ).toEqual([
      [-45.5, "COMISION MANTENIMIENTO", null],
      [1210, "TRANSFERENCIA RECIBIDA", "CLIENTE A SL"],
    ]);

    const remembered = await upload("table/inspect", csv, { bankAccountId }).expect(200);
    expect(remembered.body).toMatchObject({ savedMapping: true, mapping: inspected.body.mapping });
    expect(
      (await upload("table/import", csv, { bankAccountId, mapping, fileSha256: sha256(csv) }).expect(201)).body,
    ).toMatchObject({ imported: 0, duplicates: 2 });

    const withErrors = Buffer.from(
      "Fecha operación;Fecha valor;Concepto;Beneficiario;Importe;Saldo\n31/02/2026;;Fecha imposible;;10,00;\n",
    );
    const errorMapping = JSON.stringify({ ...inspected.body.mapping, headerRow: 0 });
    const invalid = await upload("table/preview", withErrors, { bankAccountId, mapping: errorMapping }).expect(200);
    expect(invalid.body).toMatchObject({
      errorCount: 1,
      errors: [{ row: 2, message: 'The date "31/02/2026" is not a valid DD/MM/YYYY or YYYY-MM-DD date' }],
    });
    const blocked = await upload("table/import", withErrors, {
      bankAccountId,
      mapping: errorMapping,
      fileSha256: sha256(withErrors),
    }).expect(400);
    expect(blocked.body.message).toBe("The statement has 1 rows with errors");

    const sheet = XLSX.utils.aoa_to_sheet([
      ["Fecha", "Concepto", "Importe"],
      [new Date(2026, 9, 2), "NOMINA OCTUBRE", -1500],
    ]);
    const book = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(book, sheet, "Movimientos");
    const xlsx = XLSX.write(book, { type: "buffer", bookType: "xlsx" }) as Buffer;
    const excel = await upload("table/inspect", xlsx, { bankAccountId }).expect(200);
    expect(excel.body).toMatchObject({ format: "XLSX", delimiter: null, savedMapping: false });
    expect(excel.body.rows[1]).toEqual(["2026-10-02", "NOMINA OCTUBRE", "-1500"]);
    const excelPreview = await upload("table/preview", xlsx, {
      bankAccountId,
      mapping: JSON.stringify(excel.body.mapping),
    }).expect(200);
    expect(excelPreview.body.accounts[0]).toMatchObject({ newCount: 1, startDate: "2026-10-02" });

    const missingColumn = await upload("table/preview", xlsx, { bankAccountId, mapping: errorMapping }).expect(400);
    expect(missingColumn.body.message).toBe('Invalid statement file. Column "Fecha operación" is not in the header row');
    await upload("table/preview", csv, { bankAccountId, mapping: "{" }).expect(400);
    await upload("table/preview", csv, { bankAccountId, mapping: `[${mapping}]` }).expect(400);
  });
});
