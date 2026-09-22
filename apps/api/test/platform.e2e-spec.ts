import { INestApplication, ValidationPipe } from "@nestjs/common";
import { Test } from "@nestjs/testing";
import { PrismaClient } from "@prisma/client";
import * as argon2 from "argon2";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { join } from "node:path";
import request = require("supertest");
import type { Test as SupertestTest } from "supertest";
import { AppModule } from "../src/app.module";
import { IdentityService } from "../src/identity/identity.service";
import { SifNoSigningService } from "../src/sif/sif-no-signing.service";
import { createSifTestSigner } from "./support/sif-test-signer";

describe("platform integrity", () => {
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

  it("stores an isolated company document profile and validated logo", async () => {
    const email = "company-profile@example.com";
    const account = await register(
      email,
      "Company Profile Org",
      "Company Profile SL",
      "B12345674",
    );
    const tenant = await tenantFor(email);
    await authed(account.accessToken, tenant)
      .patch("/v1/companies/current")
      .send({ sifMode: "NO_VERIFACTU" })
      .expect(409);
    const updated = await authed(account.accessToken, tenant)
      .patch("/v1/companies/current")
      .send({
        documentProfile: {
          tradeName: "Company Profile",
          addressLine1: "Calle Ejemplo 123",
          city: "Madrid",
          addressCountry: "es",
          email: "Facturacion@Example.com",
          bankIban: "ES91 2100 0418 4502 0005 1332",
          primaryColor: "#f71950",
        },
      })
      .expect(200);
    expect(updated.body.documentProfile).toMatchObject({
      tradeName: "Company Profile",
      addressCountry: "ES",
      email: "facturacion@example.com",
      bankIban: "ES9121000418450200051332",
      primaryColor: "#F71950",
    });

    const logo = pngLogo(80, 40);
    await authed(account.accessToken, tenant)
      .put("/v1/companies/current/logo")
      .attach("file", logo, { filename: "logo.png", contentType: "image/png" })
      .expect(200)
      .expect(({ body }) => {
        expect(body).toMatchObject({
          mediaType: "image/png",
          sizeBytes: logo.length,
          width: 80,
          height: 40,
        });
      });
    await authed(account.accessToken, tenant)
      .get("/v1/companies/current/logo")
      .expect("content-type", /image\/png/)
      .expect(200);
    await authed(account.accessToken, tenant)
      .delete("/v1/companies/current/logo")
      .expect(204);
    await authed(account.accessToken, tenant)
      .get("/v1/companies/current/logo")
      .expect(404);
  });

  it("resets a password once and revokes every existing session", async () => {
    const email = "password-recovery@example.com";
    const original = await register(
      email,
      "Recovery Org",
      "Recovery Company",
      "Q5000001G",
    );
    const user = await prisma.user.findUniqueOrThrow({ where: { email } });
    const expiredToken = "expired-password-recovery-token-000000000000";
    await prisma.passwordResetToken.create({
      data: {
        userId: user.id,
        tokenHash: hashRecoveryToken(expiredToken),
        expiresAt: new Date(Date.now() - 60_000),
      },
    });
    await request(app.getHttpServer())
      .post("/v1/identity/password-reset")
      .send({ token: expiredToken, password: "new secure password value" })
      .expect(400);

    const token = "valid-password-recovery-token-00000000000000";
    await prisma.passwordResetToken.create({
      data: {
        userId: user.id,
        tokenHash: hashRecoveryToken(token),
        expiresAt: new Date(Date.now() + 30 * 60_000),
      },
    });
    const attempts = await Promise.all([
      request(app.getHttpServer())
        .post("/v1/identity/password-reset")
        .send({ token, password: "new secure password value" }),
      request(app.getHttpServer())
        .post("/v1/identity/password-reset")
        .send({ token, password: "different secure password" }),
    ]);
    expect(attempts.map(({ status }) => status).sort()).toEqual([204, 400]);

    await request(app.getHttpServer())
      .post("/v1/identity/login")
      .send({ email, password: "correct horse battery staple" })
      .expect(401);
    const acceptedPassword =
      attempts[0].status === 204
        ? "new secure password value"
        : "different secure password";
    await request(app.getHttpServer())
      .post("/v1/identity/login")
      .send({ email, password: acceptedPassword })
      .expect(200);
    await request(app.getHttpServer())
      .get("/v1/identity/context")
      .set("authorization", `Bearer ${original.accessToken}`)
      .expect(401);
  });

  it("changes the password and lets the user close another session", async () => {
    const email = "security-settings@example.com";
    const current = await register(
      email,
      "Security Org",
      "Security Company",
      "R5000001G",
    );
    const other = await request(app.getHttpServer())
      .post("/v1/identity/login")
      .send({ email, password: "correct horse battery staple" })
      .expect(200);

    const listed = await request(app.getHttpServer())
      .get("/v1/identity/sessions")
      .set("authorization", `Bearer ${current.accessToken}`)
      .expect(200);
    expect(listed.body).toHaveLength(2);
    expect(
      listed.body.filter(({ isCurrent }: { isCurrent: boolean }) => isCurrent),
    ).toHaveLength(1);
    const otherSession = listed.body.find(
      ({ isCurrent }: { isCurrent: boolean }) => !isCurrent,
    );
    await request(app.getHttpServer())
      .delete(`/v1/identity/sessions/${otherSession.id}`)
      .set("authorization", `Bearer ${current.accessToken}`)
      .expect(204);
    await request(app.getHttpServer())
      .get("/v1/identity/context")
      .set("authorization", `Bearer ${other.body.accessToken}`)
      .expect(401);

    const additional = await request(app.getHttpServer())
      .post("/v1/identity/login")
      .send({ email, password: "correct horse battery staple" })
      .expect(200);
    await request(app.getHttpServer())
      .put("/v1/identity/password")
      .set("authorization", `Bearer ${current.accessToken}`)
      .send({
        currentPassword: "incorrect password",
        newPassword: "new account password value",
      })
      .expect(401);
    await request(app.getHttpServer())
      .put("/v1/identity/password")
      .set("authorization", `Bearer ${current.accessToken}`)
      .send({
        currentPassword: "correct horse battery staple",
        newPassword: "new account password value",
      })
      .expect(204);
    await request(app.getHttpServer())
      .get("/v1/identity/context")
      .set("authorization", `Bearer ${additional.body.accessToken}`)
      .expect(401);
    await request(app.getHttpServer())
      .get("/v1/identity/context")
      .set("authorization", `Bearer ${current.accessToken}`)
      .expect(200);
    const user = await prisma.user.findUniqueOrThrow({ where: { email } });
    expect(
      await argon2.verify(user.passwordHash!, "new account password value"),
    ).toBe(true);
  });

  it("enforces tenant boundaries, quote integrity, refresh CAS, and revocation", async () => {
    const accountA = await register(
      "owner-a@example.com",
      "Org A",
      "A Company",
      "B12345674",
    );
    const accountB = await register(
      "owner-b@example.com",
      "Org B",
      "B Company",
      "A58818501",
    );
    const tenantA = await tenantFor("owner-a@example.com");
    const tenantB = await tenantFor("owner-b@example.com");
    testSigner.bind(app, tenantA.companyId);

    const identityContext = await request(app.getHttpServer())
      .get("/v1/identity/context")
      .set("authorization", `Bearer ${accountA.accessToken}`)
      .expect(200);
    expect(identityContext.body).toMatchObject({
      email: "owner-a@example.com",
      memberships: [
        {
          organization: { id: tenantA.organizationId, name: "Org A" },
          company: {
            id: tenantA.companyId,
            legalName: "A Company",
            taxId: "B12345674",
          },
          role: { code: "organization.owner" },
        },
      ],
    });
    expect(identityContext.body.memberships[0].role.permissions).toContain(
      "invoice.issue",
    );
    expect(identityContext.body.memberships[0].role.permissions).toContain(
      "collections.read",
    );
    expect(identityContext.body.memberships[0].role.permissions).toContain(
      "collections.manage",
    );
    expect(JSON.stringify(identityContext.body)).not.toContain("passwordHash");

    const taxRules = await authed(accountA.accessToken, tenantA)
      .get("/v1/tax-rules?effectiveOn=2026-09-08")
      .expect(200);
    expect(taxRules.body).toHaveLength(6);
    expect(taxRules.body.map(({ code }: { code: string }) => code)).toContain(
      "ES_VAT_GENERAL_21",
    );
    const generalTaxRule = taxRules.body.find(
      ({ code }: { code: string }) => code === "ES_VAT_GENERAL_21",
    );
    expect(generalTaxRule).toBeDefined();

    const contactA = await authed(accountA.accessToken, tenantA)
      .post("/v1/contacts")
      .send({
        legalName: "Customer A",
        taxId: "B76543210",
        email: "billing-a@example.com",
        isCustomer: true,
        isSupplier: false,
        paymentTermsDays: 30,
        paymentMethod: "BANK_TRANSFER",
      })
      .expect(201);
    expect(contactA.body.paymentTermsDays).toBe(30);
    await authed(accountA.accessToken, tenantA)
      .post("/v1/contacts")
      .send({
        legalName: "Tax ID owner",
        taxId: "12345678Z",
        isCustomer: true,
        isSupplier: false,
      })
      .expect(201);
    await authed(accountA.accessToken, tenantA)
      .post("/v1/contacts")
      .send({
        legalName: "Duplicate tax ID",
        taxId: "12345678Z",
        isCustomer: true,
        isSupplier: false,
      })
      .expect(409);
    const contactB = await authed(accountB.accessToken, tenantB)
      .post("/v1/contacts")
      .send({ legalName: "Customer B", isCustomer: true, isSupplier: false })
      .expect(201);
    const supplierA = await authed(accountA.accessToken, tenantA)
      .post("/v1/contacts")
      .send({
        legalName: "Supplier A",
        taxId: "A58818501",
        isCustomer: false,
        isSupplier: true,
      })
      .expect(201);
    const customerContacts = await authed(accountA.accessToken, tenantA)
      .get("/v1/contacts?kind=CUSTOMER")
      .expect(200);
    expect(
      customerContacts.body.data.some(
        ({ id }: { id: string }) => id === supplierA.body.id,
      ),
    ).toBe(false);
    const itemB = await authed(accountB.accessToken, tenantB)
      .post("/v1/catalog-items")
      .send({
        type: "SERVICE",
        sku: "B-SVC",
        name: "B service",
        salesPrice: 10,
        currency: "EUR",
      })
      .expect(201);
    await authed(accountA.accessToken, tenantA)
      .patch("/v1/companies/current")
      .send({
        sifMode: "NO_VERIFACTU",
        aeatEnvironment: "TEST",
        sifSoftwareProducerName: "Test Producer",
        sifSoftwareProducerTaxId: "B12345674",
        sifSoftwareName: "PastaGansa",
        sifSoftwareId: "PG",
        sifSoftwareVersion: "0.1.0",
        sifInstallationNumber: "platform-test",
        documentProfile: {
          tradeName: "Profile A",
          addressLine1: "Calle Snapshot 1",
          city: "Madrid",
          email: "facturas@profile-a.example",
          bankIban: "ES91 2100 0418 4502 0005 1332",
          paymentInstructions: "Transferencia bancaria",
          paymentTerms: "Pago a 30 días",
          defaultNotes: "Gracias por su confianza.",
          documentFooter: "Profile A · B12345674",
          primaryColor: "#123456",
        },
      })
      .expect(200);
    const quoteSequence = await authed(accountA.accessToken, tenantA)
      .post("/v1/document-sequences")
      .send({ documentType: "QUOTE", series: "P2026", padding: 5 })
      .expect(201);

    await authed(accountA.accessToken, tenantB).get("/v1/contacts").expect(403);
    await authed(accountA.accessToken, tenantA)
      .post("/v1/quotes")
      .send(quote(contactA.body.id, quoteSequence.body.id, itemB.body.id))
      .expect(400);
    const createdQuote = await authed(accountA.accessToken, tenantA)
      .post("/v1/quotes")
      .send(quote(contactA.body.id, quoteSequence.body.id))
      .expect(201);
    expect(createdQuote.body).toMatchObject({
      code: "P2026-00001",
      series: "P2026",
      number: "1",
      sequenceId: quoteSequence.body.id,
    });
    expect(createdQuote.body.customerLegalName).toBe("Customer A");
    expect(createdQuote.body.lines[0].totalAmount).toBe("121");
    expect(createdQuote.body.issuerSnapshot).toMatchObject({
      source: "company_profile",
      addressLine1: "Calle Snapshot 1",
      bankIban: "ES9121000418450200051332",
      primaryColor: "#123456",
    });
    const quotePdf = await authed(accountA.accessToken, tenantA)
      .get(`/v1/quotes/${createdQuote.body.id}/pdf`)
      .expect("content-type", /application\/pdf/)
      .expect(
        "content-disposition",
        /attachment; filename="presupuesto-.+\.pdf"/,
      )
      .expect(200);
    expect(Buffer.isBuffer(quotePdf.body)).toBe(true);
    expect(quotePdf.body.subarray(0, 5).toString()).toBe("%PDF-");

    const concurrentQuotes = await Promise.all(
      Array.from({ length: 2 }, () =>
        authed(accountA.accessToken, tenantA)
          .post("/v1/quotes")
          .send(quote(contactA.body.id, quoteSequence.body.id)),
      ),
    );
    expect(concurrentQuotes.map(({ status }) => status)).toEqual([201, 201]);
    expect(new Set(concurrentQuotes.map(({ body }) => body.code)).size).toBe(2);
    expect(concurrentQuotes.every(({ body }) => body.series === "P2026")).toBe(
      true,
    );

    const acceptedQuote = await authed(accountA.accessToken, tenantA)
      .post("/v1/quotes")
      .send(quote(contactA.body.id, quoteSequence.body.id))
      .expect(201);
    await authed(accountA.accessToken, tenantA)
      .post(`/v1/quotes/${acceptedQuote.body.id}/status`)
      .send({ expectedStatus: "DRAFT", status: "SENT" })
      .expect(200);
    await authed(accountA.accessToken, tenantA)
      .post(`/v1/quotes/${acceptedQuote.body.id}/status`)
      .send({ expectedStatus: "SENT", status: "ACCEPTED" })
      .expect(200);
    const conversions = await Promise.all(
      Array.from({ length: 2 }, () =>
        authed(accountA.accessToken, tenantA)
          .post(`/v1/quotes/${acceptedQuote.body.id}/convert-to-invoice`)
          .send({ issueDate: "2026-09-09", dueDate: "2026-10-09" }),
      ),
    );
    expect(conversions.map(({ status }) => status)).toEqual([200, 200]);
    expect(conversions[0].body.id).toBe(conversions[1].body.id);
    expect(conversions[0].body).toMatchObject({
      status: "DRAFT",
      customerLegalName: "Customer A",
      total: "121",
    });
    const convertedQuote = await authed(accountA.accessToken, tenantA)
      .get(`/v1/quotes/${acceptedQuote.body.id}`)
      .expect(200);
    expect(convertedQuote.body.convertedInvoice.id).toBe(
      conversions[0].body.id,
    );
    expect(convertedQuote.body.status).toBe("CONVERTED");
    await authed(accountA.accessToken, tenantB)
      .post(`/v1/quotes/${acceptedQuote.body.id}/convert-to-invoice`)
      .send({ issueDate: "2026-09-09" })
      .expect(403);

    const sequence = await authed(accountA.accessToken, tenantA)
      .post("/v1/document-sequences")
      .send({ documentType: "INVOICE", series: "F2026", padding: 5 })
      .expect(201);
    expect(sequence.body.nextNumber).toBe("1");
    await authed(accountA.accessToken, tenantA)
      .post("/v1/document-sequences")
      .send({ documentType: "INVOICE", series: "F2026" })
      .expect(409);
    const creditSequence = await authed(accountA.accessToken, tenantA)
      .post("/v1/document-sequences")
      .send({ documentType: "CREDIT_NOTE", series: "R2026", padding: 5 })
      .expect(201);
    const purchaseSequence = await authed(accountA.accessToken, tenantA)
      .post("/v1/document-sequences")
      .send({
        documentType: "PURCHASE_INVOICE",
        series: "REC2026",
        padding: 5,
      })
      .expect(201);

    const invoiceDraft = await authed(accountA.accessToken, tenantA)
      .post("/v1/invoices")
      .send(invoice(contactA.body.id))
      .expect(201);
    expect(invoiceDraft.body.status).toBe("DRAFT");
    expect(invoiceDraft.body.number).toBeNull();
    expect(invoiceDraft.body.customerEmail).toBe("billing-a@example.com");
    expect(invoiceDraft.body.total).toBe("121");
    expect(invoiceDraft.body.lines[0].taxLines[0]).toMatchObject({
      taxCode: "ES_VAT_GENERAL_21",
      taxableBase: "100",
      taxRate: "21",
      taxAmount: "21",
      subject: true,
      exempt: false,
    });
    await authed(accountA.accessToken, tenantA)
      .post("/v1/invoices")
      .send({
        ...invoice(contactA.body.id),
        lines: [
          {
            description: "Ambiguous zero-rate operation",
            quantity: 1,
            unitPrice: 100,
            taxRate: 0,
          },
        ],
      })
      .expect(400);
    await authed(accountB.accessToken, tenantB)
      .get(`/v1/invoices/${invoiceDraft.body.id}`)
      .expect(404);
    const updatedInvoice = await authed(accountA.accessToken, tenantA)
      .patch(`/v1/invoices/${invoiceDraft.body.id}`)
      .send({ ...invoice(contactA.body.id), notes: "Updated draft" })
      .expect(200);
    expect(updatedInvoice.body.notes).toBe("Updated draft");
    await authed(accountA.accessToken, tenantA)
      .put(`/v1/invoices/${invoiceDraft.body.id}/payment-schedule`)
      .send({
        installments: [
          { dueDate: "2026-09-30", amount: 60 },
          { dueDate: "2026-10-31", amount: 60 },
        ],
      })
      .expect(400);
    const paymentSchedule = await authed(accountA.accessToken, tenantA)
      .put(`/v1/invoices/${invoiceDraft.body.id}/payment-schedule`)
      .send({
        installments: [
          { dueDate: "2026-09-30", amount: 60.5 },
          { dueDate: "2026-10-31", amount: 60.5 },
        ],
      })
      .expect(200);
    expect(paymentSchedule.body).toHaveLength(2);
    expect(paymentSchedule.body[1]).toMatchObject({
      position: 2,
      amount: "60.5",
      paidAmount: "0",
      status: "PENDING",
    });
    await authed(accountA.accessToken, tenantA)
      .get(`/v1/invoices/${invoiceDraft.body.id}/pdf`)
      .expect(409);
    await authed(accountA.accessToken, tenantA)
      .post(`/v1/invoices/${invoiceDraft.body.id}/issue`)
      .send({ sequenceId: sequence.body.id })
      .expect(400);
    const issuedInvoice = await authed(accountA.accessToken, tenantA)
      .post(`/v1/invoices/${invoiceDraft.body.id}/issue`)
      .set("idempotency-key", "issue-invoice-a")
      .send({ sequenceId: sequence.body.id })
      .expect(200);
    expect(issuedInvoice.body.status).toBe("ISSUED");
    expect(issuedInvoice.body.fullNumber).toBe("F2026-00001");
    expect(issuedInvoice.body.issuerSnapshot).toMatchObject({
      addressLine1: "Calle Snapshot 1",
      documentFooter: "Profile A · B12345674",
    });
    await authed(accountA.accessToken, tenantA)
      .patch("/v1/companies/current")
      .send({
        documentProfile: {
          addressLine1: "Calle Nueva 99",
          city: "Valencia",
          primaryColor: "#654321",
        },
      })
      .expect(200);
    const frozenInvoice = await authed(accountA.accessToken, tenantA)
      .get(`/v1/invoices/${invoiceDraft.body.id}`)
      .expect(200);
    expect(frozenInvoice.body.issuerSnapshot).toMatchObject({
      addressLine1: "Calle Snapshot 1",
      primaryColor: "#123456",
    });
    const retriedIssue = await authed(accountA.accessToken, tenantA)
      .post(`/v1/invoices/${invoiceDraft.body.id}/issue`)
      .set("idempotency-key", "issue-invoice-a")
      .send({ sequenceId: sequence.body.id })
      .expect(200);
    expect(retriedIssue.body.fullNumber).toBe(issuedInvoice.body.fullNumber);
    await authed(accountB.accessToken, tenantB)
      .post(`/v1/sif/records/${invoiceDraft.body.id}/cancellation`)
      .expect(404);
    const sifCancellation = await authed(accountA.accessToken, tenantA)
      .post(`/v1/sif/records/${invoiceDraft.body.id}/cancellation`)
      .expect(200);
    expect(sifCancellation.body).toMatchObject({
      invoiceId: invoiceDraft.body.id,
      recordType: "CANCELLATION",
      chainPosition: "2",
      invoiceNumber: "F2026-00001",
      invoiceType: "F1",
    });
    const retriedSifCancellation = await authed(accountA.accessToken, tenantA)
      .post(`/v1/sif/records/${invoiceDraft.body.id}/cancellation`)
      .expect(200);
    expect(retriedSifCancellation.body.id).toBe(sifCancellation.body.id);
    const cancelledInvoiceSif = await authed(accountA.accessToken, tenantA)
      .get(`/v1/sif/records?invoiceId=${invoiceDraft.body.id}`)
      .expect(200);
    expect(cancelledInvoiceSif.body).toHaveLength(2);
    expect(
      cancelledInvoiceSif.body.map(
        ({ recordType }: { recordType: string }) => recordType,
      ),
    ).toEqual(["REGISTRATION", "CANCELLATION"]);
    await authed(accountA.accessToken, tenantA)
      .get("/v1/sif/records/verification")
      .expect(200)
      .expect(({ body }) =>
        expect(body).toMatchObject({ valid: true, recordsChecked: 2 }),
      );
    const transitionAudit = await authed(accountA.accessToken, tenantA)
      .get("/v1/sif/records/transition-audit")
      .expect(200);
    expect(transitionAudit.body).toMatchObject({
      companyId: tenantA.companyId,
      totalRecords: 2,
      historicalChainReviewRequired: true,
      groups: [
        {
          sifMode: "NO_VERIFACTU",
          aeatEnvironment: "TEST",
          recordType: "REGISTRATION",
          softwareId: "PG",
          softwareIdValid: true,
          records: 1,
          frozenXmlRecords: 1,
          unavailableXmlRecords: 0,
          legacyXmlRecords: 0,
          firstPosition: "1",
          lastPosition: "1",
        },
        {
          sifMode: "NO_VERIFACTU",
          aeatEnvironment: "TEST",
          recordType: "CANCELLATION",
          softwareId: "PG",
          softwareIdValid: true,
          records: 1,
          frozenXmlRecords: 1,
          unavailableXmlRecords: 0,
          legacyXmlRecords: 0,
          firstPosition: "2",
          lastPosition: "2",
        },
      ],
    });
    await authed(accountB.accessToken, tenantB)
      .get("/v1/sif/records/transition-audit")
      .expect(200)
      .expect(({ body }) =>
        expect(body).toMatchObject({
          companyId: tenantB.companyId,
          totalRecords: 0,
          historicalChainReviewRequired: false,
          groups: [],
        }),
      );
    const originalLedger = await authed(accountA.accessToken, tenantA)
      .get("/v1/tax-ledger")
      .expect(200);
    expect(originalLedger.body.data).toHaveLength(1);
    expect(originalLedger.body.data[0]).toMatchObject({
      invoiceId: invoiceDraft.body.id,
      direction: "SALES",
      bookType: "ISSUED_INVOICES",
      documentNumber: "F2026-00001",
      correctionOfId: null,
    });
    expect(originalLedger.body.data[0].amounts[0]).toMatchObject({
      taxableBase: "100",
      rate: "21",
      taxAmount: "21",
    });
    const salesEntries = await authed(accountA.accessToken, tenantA)
      .get("/v1/accounting/journal-entries?sourceType=SALES_INVOICE")
      .expect(200);
    expect(salesEntries.body.data).toHaveLength(1);
    const originalSalesEntry = salesEntries.body.data[0];
    expect(originalSalesEntry).toMatchObject({
      status: "POSTED",
      sourceId: invoiceDraft.body.id,
      entryNumber: "1",
    });
    expect(accountingAmounts(originalSalesEntry)).toEqual({
      "430000": { debit: "121", credit: "0" },
      "477000": { debit: "0", credit: "21" },
      "700000": { debit: "0", credit: "100" },
    });
    await authed(accountB.accessToken, tenantB)
      .get(`/v1/accounting/journal-entries/${originalSalesEntry.id}`)
      .expect(404);
    await expect(
      admin.taxRule.update({
        where: { id: taxRules.body[0].id },
        data: { legalReference: "Tampered" },
      }),
    ).rejects.toThrow(/tax rules are immutable/);
    await expect(
      admin.invoiceTaxLine.update({
        where: { id: issuedInvoice.body.lines[0].taxLines[0].id },
        data: { taxAmount: "999" },
      }),
    ).rejects.toThrow(/issued invoice tax lines are immutable/);
    await expect(
      admin.taxLedgerEntry.update({
        where: { id: originalLedger.body.data[0].id },
        data: { documentNumber: "TAMPERED" },
      }),
    ).rejects.toThrow(/tax ledger is append-only/);
    await expect(
      admin.taxLedgerAmount.delete({
        where: { id: originalLedger.body.data[0].amounts[0].id },
      }),
    ).rejects.toThrow(/tax ledger is append-only/);
    await expect(
      admin.journalEntry.update({
        where: { id: originalSalesEntry.id },
        data: { description: "Tampered" },
      }),
    ).rejects.toThrow(/posted journal entries are immutable/);
    await expect(
      admin.journalLine.update({
        where: { id: originalSalesEntry.lines[0].id },
        data: { debit: "999" },
      }),
    ).rejects.toThrow(/posted journal lines are immutable/);
    await authed(accountB.accessToken, tenantB)
      .get(`/v1/tax-ledger/${originalLedger.body.data[0].id}`)
      .expect(404);
    const issuedSchedule = await authed(accountA.accessToken, tenantA)
      .get(`/v1/invoices/${invoiceDraft.body.id}/payment-schedule`)
      .expect(200);
    expect(issuedSchedule.body).toHaveLength(2);
    await authed(accountA.accessToken, tenantA)
      .put(`/v1/invoices/${invoiceDraft.body.id}/payment-schedule`)
      .send({ installments: [{ dueDate: "2026-10-31", amount: 121 }] })
      .expect(409);
    const invoicePdf = await authed(accountA.accessToken, tenantA)
      .get(`/v1/invoices/${invoiceDraft.body.id}/pdf`)
      .expect("content-type", /application\/pdf/)
      .expect(
        "content-disposition",
        'attachment; filename="factura-F2026-00001.pdf"',
      )
      .expect(200);
    expect(invoicePdf.body.subarray(0, 5).toString()).toBe("%PDF-");
    await authed(accountA.accessToken, tenantA)
      .get("/v1/invoices/email-capability")
      .expect(200, { enabled: false });
    await authed(accountA.accessToken, tenantA)
      .post(`/v1/invoices/${invoiceDraft.body.id}/email`)
      .send({})
      .expect(400);
    const queuedEmails = await Promise.all([
      authed(accountA.accessToken, tenantA)
        .post(`/v1/invoices/${invoiceDraft.body.id}/email`)
        .set("idempotency-key", "email-invoice-a")
        .send({})
        .expect(202),
      authed(accountA.accessToken, tenantA)
        .post(`/v1/invoices/${invoiceDraft.body.id}/email`)
        .set("idempotency-key", "email-invoice-a")
        .send({})
        .expect(202),
    ]);
    const [queuedEmail, retriedEmail] = queuedEmails;
    expect(queuedEmail.body).toMatchObject({
      invoiceId: invoiceDraft.body.id,
      recipient: "billing-a@example.com",
      status: "PENDING",
      attempts: 0,
    });
    expect(retriedEmail.body.id).toBe(queuedEmail.body.id);
    const deliveries = await authed(accountA.accessToken, tenantA)
      .get(`/v1/invoices/${invoiceDraft.body.id}/email-deliveries`)
      .expect(200);
    expect(deliveries.body).toHaveLength(1);
    await authed(accountB.accessToken, tenantB)
      .get(`/v1/invoices/${invoiceDraft.body.id}/email-deliveries`)
      .expect(404);
    const firstPaymentInput = {
      amount: 60.5,
      paidAt: "2026-09-15T10:00:00.000Z",
      method: "BANK_TRANSFER",
      reference: "TRANSFER-001",
    };
    await authed(accountA.accessToken, tenantA)
      .post(`/v1/invoices/${invoiceDraft.body.id}/payments`)
      .send(firstPaymentInput)
      .expect(400);
    const firstPayment = await authed(accountA.accessToken, tenantA)
      .post(`/v1/invoices/${invoiceDraft.body.id}/payments`)
      .set("idempotency-key", "payment-invoice-a-1")
      .send(firstPaymentInput)
      .expect(201);
    expect(firstPayment.body.allocations).toHaveLength(1);
    expect(firstPayment.body.allocations[0].amount).toBe("60.5");
    let paymentEntries = await authed(accountA.accessToken, tenantA)
      .get("/v1/accounting/journal-entries?sourceType=PAYMENT")
      .expect(200);
    expect(paymentEntries.body.data).toHaveLength(1);
    expect(paymentEntries.body.data[0]).toMatchObject({
      sourceId: firstPayment.body.id,
      status: "POSTED",
      entryNumber: "2",
    });
    expect(accountingAmounts(paymentEntries.body.data[0])).toEqual({
      "430000": { debit: "0", credit: "60.5" },
      "572000": { debit: "60.5", credit: "0" },
    });
    await expect(
      admin.payment.update({
        where: { id: firstPayment.body.id },
        data: { reference: "TAMPERED" },
      }),
    ).rejects.toThrow(/recorded payments and allocations are immutable/);
    await expect(
      admin.paymentAllocation.update({
        where: { id: firstPayment.body.allocations[0].id },
        data: { amount: "1" },
      }),
    ).rejects.toThrow(/recorded payments and allocations are immutable/);
    const retriedPayment = await authed(accountA.accessToken, tenantA)
      .post(`/v1/invoices/${invoiceDraft.body.id}/payments`)
      .set("idempotency-key", "payment-invoice-a-1")
      .send(firstPaymentInput)
      .expect(201);
    expect(retriedPayment.body.id).toBe(firstPayment.body.id);
    paymentEntries = await authed(accountA.accessToken, tenantA)
      .get("/v1/accounting/journal-entries?sourceType=PAYMENT")
      .expect(200);
    expect(paymentEntries.body.data).toHaveLength(1);
    const partlyPaidInvoice = await authed(accountA.accessToken, tenantA)
      .get(`/v1/invoices/${invoiceDraft.body.id}`)
      .expect(200);
    expect(partlyPaidInvoice.body).toMatchObject({
      status: "PARTIALLY_PAID",
      amountPaid: "60.5",
      amountDue: "60.5",
    });
    await authed(accountA.accessToken, tenantA)
      .post(`/v1/invoices/${invoiceDraft.body.id}/payments`)
      .set("idempotency-key", "payment-invoice-a-overpay")
      .send({ ...firstPaymentInput, amount: 61 })
      .expect(400);
    await authed(accountB.accessToken, tenantB)
      .get(`/v1/invoices/${invoiceDraft.body.id}/payments`)
      .expect(404);
    const finalPaymentAttempts = await Promise.all([
      authed(accountA.accessToken, tenantA)
        .post(`/v1/invoices/${invoiceDraft.body.id}/payments`)
        .set("idempotency-key", "payment-invoice-a-2")
        .send({
          ...firstPaymentInput,
          paidAt: "2026-10-15T10:00:00.000Z",
          reference: "TRANSFER-002",
        }),
      authed(accountA.accessToken, tenantA)
        .post(`/v1/invoices/${invoiceDraft.body.id}/payments`)
        .set("idempotency-key", "payment-invoice-a-competing")
        .send({
          ...firstPaymentInput,
          paidAt: "2026-10-15T10:01:00.000Z",
          reference: "TRANSFER-COMPETING",
        }),
    ]);
    expect(finalPaymentAttempts.map(({ status }) => status).sort()).toEqual([
      201, 409,
    ]);
    const payments = await authed(accountA.accessToken, tenantA)
      .get(`/v1/invoices/${invoiceDraft.body.id}/payments`)
      .expect(200);
    expect(payments.body).toHaveLength(2);
    paymentEntries = await authed(accountA.accessToken, tenantA)
      .get("/v1/accounting/journal-entries?sourceType=PAYMENT")
      .expect(200);
    expect(paymentEntries.body.data).toHaveLength(2);
    const finalPayment = payments.body.find(
      ({ id }: { id: string }) => id !== firstPayment.body.id,
    );
    const finalPaymentEntry = paymentEntries.body.data.find(
      ({ sourceId }: { sourceId: string }) => sourceId === finalPayment.id,
    );
    expect(accountingAmounts(finalPaymentEntry)).toEqual({
      "430000": { debit: "0", credit: "60.5" },
      "572000": { debit: "60.5", credit: "0" },
    });
    const paidInvoice = await authed(accountA.accessToken, tenantA)
      .get(`/v1/invoices/${invoiceDraft.body.id}`)
      .expect(200);
    expect(paidInvoice.body).toMatchObject({
      status: "PAID",
      amountPaid: "121",
      amountDue: "0",
    });
    const defaultAccountingRules = await authed(accountA.accessToken, tenantA)
      .get("/v1/accounting/rules")
      .expect(200);
    expect(defaultAccountingRules.body).toHaveLength(11);
    expect(defaultAccountingRules.body).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          sourceType: "SALES_INVOICE",
          accountingRole: "SALES_REVENUE",
          account: expect.objectContaining({ code: "700000" }),
        }),
      ]),
    );
    const alternateRevenueAccount = await authed(accountA.accessToken, tenantA)
      .post("/v1/accounting/accounts")
      .send({
        code: "701000",
        name: "Ventas alternativas",
        accountClass: "INCOME",
      })
      .expect(201);
    await authed(accountA.accessToken, tenantA)
      .put("/v1/accounting/rules/PAYMENT/SALES_REVENUE")
      .send({ accountId: alternateRevenueAccount.body.id })
      .expect(400);
    await authed(accountB.accessToken, tenantB)
      .put("/v1/accounting/rules/SALES_INVOICE/SALES_REVENUE")
      .send({ accountId: alternateRevenueAccount.body.id })
      .expect(400);
    const updatedRevenueRule = await authed(accountA.accessToken, tenantA)
      .put("/v1/accounting/rules/SALES_INVOICE/SALES_REVENUE")
      .send({ accountId: alternateRevenueAccount.body.id })
      .expect(200);
    expect(updatedRevenueRule.body).toMatchObject({
      sourceType: "SALES_INVOICE",
      accountingRole: "SALES_REVENUE",
      account: { id: alternateRevenueAccount.body.id, code: "701000" },
    });
    const bankRule = defaultAccountingRules.body.find(
      ({ sourceType, accountingRole }: Record<string, string>) =>
        sourceType === "PAYMENT" && accountingRole === "BANK",
    );
    await expect(
      admin.accountingRule.update({
        where: { id: updatedRevenueRule.body.id },
        data: { accountId: bankRule.account.id },
      }),
    ).rejects.toThrow(
      /accounting rule requires an active account of the expected class/,
    );
    await authed(accountA.accessToken, tenantA)
      .post(`/v1/invoices/${invoiceDraft.body.id}/rectifications`)
      .send({
        sifInvoiceType: "R5",
        kind: "TOTAL",
        impact: "DECREASE",
        reason: "Simplified invoice correction",
        issueDate: "2026-09-09",
      })
      .expect(400);
    await authed(accountB.accessToken, tenantB)
      .post(`/v1/invoices/${invoiceDraft.body.id}/rectifications`)
      .send({
        sifInvoiceType: "R1",
        kind: "TOTAL",
        impact: "DECREASE",
        reason: "Incorrect customer operation",
        issueDate: "2026-09-09",
      })
      .expect(404);
    const rectification = await authed(accountA.accessToken, tenantA)
      .post(`/v1/invoices/${invoiceDraft.body.id}/rectifications`)
      .send({
        sifInvoiceType: "R1",
        kind: "TOTAL",
        impact: "DECREASE",
        reason: "Incorrect customer operation",
        issueDate: "2026-09-09",
      })
      .expect(201);
    expect(rectification.body).toMatchObject({
      documentType: "CREDIT_NOTE",
      sifInvoiceType: "R1",
      rectificationKind: "TOTAL",
      rectificationImpact: "DECREASE",
      originalInvoiceId: invoiceDraft.body.id,
      total: "121",
      status: "DRAFT",
    });
    expect(rectification.body.originalInvoice.fullNumber).toBe("F2026-00001");
    await authed(accountA.accessToken, tenantA)
      .post(`/v1/invoices/${rectification.body.id}/issue`)
      .set("idempotency-key", "issue-rectification-a")
      .send({ sequenceId: sequence.body.id })
      .expect(400);
    const issuedRectification = await authed(accountA.accessToken, tenantA)
      .post(`/v1/invoices/${rectification.body.id}/issue`)
      .set("idempotency-key", "issue-rectification-a")
      .send({ sequenceId: creditSequence.body.id })
      .expect(200);
    expect(issuedRectification.body.fullNumber).toBe("R2026-00001");
    const rectificationSif = await authed(accountA.accessToken, tenantA)
      .get(`/v1/sif/records?invoiceId=${rectification.body.id}`)
      .expect(200);
    expect(rectificationSif.body).toHaveLength(1);
    expect(rectificationSif.body[0]).toMatchObject({
      invoiceType: "R1",
      taxTotal: "-21",
      total: "-121",
    });
    const rectificationLedger = await authed(accountA.accessToken, tenantA)
      .get("/v1/tax-ledger")
      .expect(200);
    expect(rectificationLedger.body.data).toHaveLength(2);
    expect(rectificationLedger.body.data[0]).toMatchObject({
      invoiceId: rectification.body.id,
      documentNumber: "R2026-00001",
      correctionOfId: originalLedger.body.data[0].id,
      rectificationImpact: "DECREASE",
    });
    expect(rectificationLedger.body.data[0].amounts[0]).toMatchObject({
      taxableBase: "-100",
      rate: "21",
      taxAmount: "-21",
    });
    const rectificationEntries = await authed(accountA.accessToken, tenantA)
      .get("/v1/accounting/journal-entries?sourceType=SALES_INVOICE")
      .expect(200);
    expect(rectificationEntries.body.data).toHaveLength(2);
    const rectificationEntry = rectificationEntries.body.data.find(
      ({ sourceId }: { sourceId: string }) =>
        sourceId === rectification.body.id,
    );
    expect(accountingAmounts(rectificationEntry)).toEqual({
      "430000": { debit: "0", credit: "121" },
      "477000": { debit: "21", credit: "0" },
      "701000": { debit: "100", credit: "0" },
    });
    await authed(accountA.accessToken, tenantA)
      .get(`/v1/invoices/${rectification.body.id}/pdf`)
      .expect("content-type", /application\/pdf/)
      .expect(200);
    const rectifiedOriginal = await authed(accountA.accessToken, tenantA)
      .get(`/v1/invoices/${invoiceDraft.body.id}`)
      .expect(200);
    expect(rectifiedOriginal.body).toMatchObject({
      status: "RECTIFIED", amountPaid: "121", creditedAmount: "0", amountDue: "0",
    });
    await authed(accountA.accessToken, tenantA)
      .post(`/v1/invoices/${invoiceDraft.body.id}/rectifications`)
      .send({
        sifInvoiceType: "R4",
        kind: "PARTIAL",
        impact: "DECREASE",
        reason: "Second correction is not allowed",
        issueDate: "2026-09-10",
        lines: invoice(contactA.body.id).lines,
      })
      .expect(409);
    await authed(accountA.accessToken, tenantA)
      .patch(`/v1/invoices/${invoiceDraft.body.id}`)
      .send(invoice(contactA.body.id))
      .expect(409);
    await authed(accountA.accessToken, tenantA)
      .delete(`/v1/invoices/${invoiceDraft.body.id}`)
      .expect(409);

    const purchaseInput = {
      supplierId: supplierA.body.id,
      supplierInvoiceNumber: "PROV-2026-0042",
      issueDate: "2026-09-01",
      operationDate: "2026-08-31",
      receivedDate: "2026-09-05",
      deductionDate: "2026-10-01",
      dueDate: "2026-10-31",
      currency: "EUR",
      lines: [
        {
          description: "Professional services",
          quantity: 1,
          unitPrice: 200,
          taxRuleId: generalTaxRule.id,
          taxRate: 21,
          deductiblePct: 50,
        },
      ],
    };
    const purchaseDraft = await authed(accountA.accessToken, tenantA)
      .post("/v1/purchase-invoices")
      .send(purchaseInput)
      .expect(201);
    expect(purchaseDraft.body).toMatchObject({
      status: "DRAFT",
      supplierInvoiceNumber: "PROV-2026-0042",
      supplierLegalName: "Supplier A",
      subtotal: "200",
      taxTotal: "42",
      deductibleTaxTotal: "21",
      total: "242",
      dueDate: "2026-10-31T00:00:00.000Z",
    });
    expect(purchaseDraft.body.lines[0].taxLines[0]).toMatchObject({
      taxCode: "ES_VAT_GENERAL_21",
      deductiblePct: "50",
      deductibleAmount: "21",
    });
    await authed(accountB.accessToken, tenantB)
      .get(`/v1/purchase-invoices/${purchaseDraft.body.id}`)
      .expect(404);
    const purchasePdf = Buffer.from(
      "%PDF-1.4\n1 0 obj<</Type/Catalog>>endobj\n%%EOF",
    );
    await authed(accountA.accessToken, tenantA)
      .post(`/v1/purchase-invoices/${purchaseDraft.body.id}/attachments`)
      .attach("file", Buffer.from("not a pdf"), {
        filename: "fake.pdf",
        contentType: "application/pdf",
      })
      .expect(400);
    const purchaseAttachment = await authed(accountA.accessToken, tenantA)
      .post(`/v1/purchase-invoices/${purchaseDraft.body.id}/attachments`)
      .attach("file", purchasePdf, {
        filename: "../supplier-invoice.pdf",
        contentType: "application/pdf",
      })
      .expect(201);
    expect(purchaseAttachment.body).toMatchObject({
      purchaseInvoiceId: purchaseDraft.body.id,
      originalName: "supplier-invoice.pdf",
      mediaType: "application/pdf",
      sizeBytes: purchasePdf.length,
    });
    expect(purchaseAttachment.body.sha256).toMatch(/^[0-9a-f]{64}$/);
    expect(purchaseAttachment.body).not.toHaveProperty("content");
    await authed(accountA.accessToken, tenantA)
      .post(`/v1/purchase-invoices/${purchaseDraft.body.id}/attachments`)
      .attach("file", purchasePdf, {
        filename: "duplicate.pdf",
        contentType: "application/pdf",
      })
      .expect(409);
    await authed(accountB.accessToken, tenantB)
      .get(`/v1/purchase-invoices/${purchaseDraft.body.id}/attachments`)
      .expect(404);
    await authed(accountB.accessToken, tenantB)
      .get(
        `/v1/purchase-invoices/${purchaseDraft.body.id}/attachments/${purchaseAttachment.body.id}/download`,
      )
      .expect(404);
    const purchaseAttachments = await authed(accountA.accessToken, tenantA)
      .get(`/v1/purchase-invoices/${purchaseDraft.body.id}/attachments`)
      .expect(200);
    expect(purchaseAttachments.body).toHaveLength(1);
    expect(purchaseAttachments.body[0]).not.toHaveProperty("content");
    const downloadedPurchaseAttachment = await authed(
      accountA.accessToken,
      tenantA,
    )
      .get(
        `/v1/purchase-invoices/${purchaseDraft.body.id}/attachments/${purchaseAttachment.body.id}/download`,
      )
      .expect("content-type", /application\/pdf/)
      .expect(
        "content-disposition",
        'attachment; filename="supplier-invoice.pdf"',
      )
      .expect(200);
    expect(downloadedPurchaseAttachment.body).toEqual(purchasePdf);
    const temporaryAttachment = await authed(accountA.accessToken, tenantA)
      .post(`/v1/purchase-invoices/${purchaseDraft.body.id}/attachments`)
      .attach(
        "file",
        Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
        { filename: "temporary.png", contentType: "image/png" },
      )
      .expect(201);
    await authed(accountA.accessToken, tenantA)
      .delete(
        `/v1/purchase-invoices/${purchaseDraft.body.id}/attachments/${temporaryAttachment.body.id}`,
      )
      .expect(204);
    await authed(accountA.accessToken, tenantA)
      .get(
        `/v1/purchase-invoices/${purchaseDraft.body.id}/attachments/${temporaryAttachment.body.id}/download`,
      )
      .expect(404);
    await authed(accountA.accessToken, tenantA)
      .post(
        `/v1/purchase-invoices/${purchaseDraft.body.id}/ocr/attachments/${purchaseAttachment.body.id}`,
      )
      .expect(400);
    const ocrAttachment = await authed(accountA.accessToken, tenantA)
      .post(`/v1/purchase-invoices/${purchaseDraft.body.id}/attachments`)
      .attach(
        "file",
        Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x01]),
        { filename: "invoice-scan.png", contentType: "image/png" },
      )
      .expect(201);
    const ocrJob = await authed(accountA.accessToken, tenantA)
      .post(
        `/v1/purchase-invoices/${purchaseDraft.body.id}/ocr/attachments/${ocrAttachment.body.id}`,
      )
      .expect(201);
    expect(ocrJob.body).toMatchObject({
      status: "PENDING",
      engine: "tesseract.js",
      engineVersion: "7.0.0",
      attempts: 0,
    });
    await authed(accountA.accessToken, tenantA)
      .post(
        `/v1/purchase-invoices/${purchaseDraft.body.id}/ocr/attachments/${ocrAttachment.body.id}`,
      )
      .expect(409);
    await authed(accountB.accessToken, tenantB)
      .get(
        `/v1/purchase-invoices/${purchaseDraft.body.id}/ocr/${ocrJob.body.id}`,
      )
      .expect(404);
    await authed(accountA.accessToken, tenantA)
      .post(`/v1/purchase-invoices/${purchaseDraft.body.id}/approve`)
      .set("idempotency-key", "approve-before-ocr-review")
      .send({ sequenceId: purchaseSequence.body.id })
      .expect(409);
    await admin.purchaseInvoiceOcrJob.update({
      where: { id: ocrJob.body.id },
      data: {
        status: "REVIEW_REQUIRED",
        attempts: 1,
        rawText: "FACTURA: PROV-2026-0042\nTOTAL: 242,00 EUR",
        extractedFields: {
          invoiceNumber: {
            value: "PROV-2026-0042",
            confidence: 91.25,
            evidence: "FACTURA: PROV-2026-0042",
          },
          total: {
            value: "242.00",
            confidence: 91.25,
            evidence: "TOTAL: 242,00 EUR",
          },
        },
        overallConfidence: 91.25,
      },
    });
    const extractedOcr = await authed(accountA.accessToken, tenantA)
      .get(
        `/v1/purchase-invoices/${purchaseDraft.body.id}/ocr/${ocrJob.body.id}`,
      )
      .expect(200);
    expect(extractedOcr.body).toMatchObject({
      status: "REVIEW_REQUIRED",
      overallConfidence: "91.25",
      rawText: "FACTURA: PROV-2026-0042\nTOTAL: 242,00 EUR",
    });
    await authed(accountA.accessToken, tenantA)
      .post(
        `/v1/purchase-invoices/${purchaseDraft.body.id}/ocr/${ocrJob.body.id}/review`,
      )
      .send({ fields: { executable: "no" }, notes: "Invalid field" })
      .expect(400);
    const reviewedOcr = await authed(accountA.accessToken, tenantA)
      .post(
        `/v1/purchase-invoices/${purchaseDraft.body.id}/ocr/${ocrJob.body.id}/review`,
      )
      .send({
        fields: { invoiceNumber: "PROV-2026-0042", total: "242.00" },
        notes: "Compared with the original document",
      })
      .expect(201);
    expect(reviewedOcr.body).toMatchObject({
      status: "REVIEWED",
      reviewFields: {
        fields: { invoiceNumber: "PROV-2026-0042", total: "242.00" },
        notes: "Compared with the original document",
      },
    });
    await expect(
      admin.purchaseInvoiceOcrJob.update({
        where: { id: ocrJob.body.id },
        data: { overallConfidence: 100 },
      }),
    ).rejects.toThrow(/reviewed OCR records are immutable/);
    await authed(accountA.accessToken, tenantA)
      .post("/v1/purchase-invoices")
      .send(purchaseInput)
      .expect(409);
    await authed(accountA.accessToken, tenantA)
      .put(`/v1/purchase-invoices/${purchaseDraft.body.id}/payment-schedule`)
      .send({
        installments: [
          { dueDate: "2026-09-30", amount: 100 },
          { dueDate: "2026-10-31", amount: 100 },
        ],
      })
      .expect(400);
    const purchaseSchedule = await authed(accountA.accessToken, tenantA)
      .put(`/v1/purchase-invoices/${purchaseDraft.body.id}/payment-schedule`)
      .send({
        installments: [
          { dueDate: "2026-09-30", amount: 100 },
          { dueDate: "2026-10-31", amount: 142 },
        ],
      })
      .expect(200);
    expect(purchaseSchedule.body.installments).toHaveLength(2);
    expect(purchaseSchedule.body.installments[1]).toMatchObject({
      position: 2,
      amount: "142",
      paidAmount: "0",
      status: "PENDING",
    });
    await authed(accountA.accessToken, tenantA)
      .post(`/v1/purchase-invoices/${purchaseDraft.body.id}/approve`)
      .set("idempotency-key", "approve-purchase-a")
      .send({ sequenceId: sequence.body.id })
      .expect(400);
    const approvedPurchase = await authed(accountA.accessToken, tenantA)
      .post(`/v1/purchase-invoices/${purchaseDraft.body.id}/approve`)
      .set("idempotency-key", "approve-purchase-a")
      .send({ sequenceId: purchaseSequence.body.id })
      .expect(200);
    expect(approvedPurchase.body).toMatchObject({
      status: "APPROVED",
      receptionNumber: "1",
      receptionFullNumber: "REC2026-00001",
      amountPaid: "0",
      amountDue: "242",
    });
    expect(approvedPurchase.body.installments).toHaveLength(2);
    await authed(accountA.accessToken, tenantA)
      .post(`/v1/purchase-invoices/${purchaseDraft.body.id}/attachments`)
      .attach("file", Buffer.from("%PDF-1.4\nsecond\n%%EOF"), {
        filename: "second.pdf",
        contentType: "application/pdf",
      })
      .expect(409);
    await authed(accountA.accessToken, tenantA)
      .delete(
        `/v1/purchase-invoices/${purchaseDraft.body.id}/attachments/${purchaseAttachment.body.id}`,
      )
      .expect(409);
    await authed(accountA.accessToken, tenantA)
      .get(
        `/v1/purchase-invoices/${purchaseDraft.body.id}/attachments/${purchaseAttachment.body.id}/download`,
      )
      .expect(200);
    await expect(
      admin.purchaseInvoiceAttachment.update({
        where: { id: purchaseAttachment.body.id },
        data: { originalName: "tampered.pdf" },
      }),
    ).rejects.toThrow(/purchase invoice attachments are immutable/);
    await authed(accountA.accessToken, tenantA)
      .put(`/v1/purchase-invoices/${purchaseDraft.body.id}/payment-schedule`)
      .send({ installments: [{ dueDate: "2026-10-31", amount: 242 }] })
      .expect(409);
    await authed(accountB.accessToken, tenantB)
      .get(
        `/v1/purchase-invoices/${purchaseDraft.body.id}/payment-schedule?asOf=2026-10-15`,
      )
      .expect(404);
    const overduePurchaseSchedule = await authed(accountA.accessToken, tenantA)
      .get(
        `/v1/purchase-invoices/${purchaseDraft.body.id}/payment-schedule?asOf=2026-10-15`,
      )
      .expect(200);
    expect(overduePurchaseSchedule.body.asOf).toBe("2026-10-15");
    expect(
      overduePurchaseSchedule.body.installments.map(
        ({ overdue }: { overdue: boolean }) => overdue,
      ),
    ).toEqual([true, false]);
    await expect(
      admin.purchaseInvoiceInstallment.update({
        where: { id: approvedPurchase.body.installments[0].id },
        data: { dueDate: new Date("2026-12-31") },
      }),
    ).rejects.toThrow(
      /approved purchase invoice payment schedules are immutable/,
    );
    const retriedPurchaseApproval = await authed(accountA.accessToken, tenantA)
      .post(`/v1/purchase-invoices/${purchaseDraft.body.id}/approve`)
      .set("idempotency-key", "approve-purchase-a")
      .send({ sequenceId: purchaseSequence.body.id })
      .expect(200);
    expect(retriedPurchaseApproval.body.receptionFullNumber).toBe(
      "REC2026-00001",
    );
    const purchaseLedger = await authed(accountA.accessToken, tenantA)
      .get("/v1/tax-ledger?direction=PURCHASES")
      .expect(200);
    expect(purchaseLedger.body.data).toHaveLength(1);
    expect(purchaseLedger.body.data[0]).toMatchObject({
      purchaseInvoiceId: purchaseDraft.body.id,
      invoiceId: null,
      direction: "PURCHASES",
      bookType: "RECEIVED_INVOICES",
      documentNumber: "PROV-2026-0042",
      registrationNumber: "REC2026-00001",
      receivedDate: "2026-09-05T00:00:00.000Z",
      taxPointDate: "2026-10-01T00:00:00.000Z",
    });
    expect(purchaseLedger.body.data[0].amounts[0]).toMatchObject({
      taxableBase: "200",
      rate: "21",
      taxAmount: "42",
      deductibleAmount: "21",
    });
    const purchaseEntries = await authed(accountA.accessToken, tenantA)
      .get("/v1/accounting/journal-entries?sourceType=PURCHASE_INVOICE")
      .expect(200);
    expect(purchaseEntries.body.data).toHaveLength(1);
    expect(purchaseEntries.body.data[0]).toMatchObject({
      status: "POSTED",
      sourceId: purchaseDraft.body.id,
      entryNumber: "5",
    });
    expect(accountingAmounts(purchaseEntries.body.data[0])).toEqual({
      "400000": { debit: "0", credit: "242" },
      "472000": { debit: "21", credit: "0" },
      "600000": { debit: "221", credit: "0" },
    });
    const supplierPaymentInput = {
      amount: 100,
      paidAt: "2026-10-10T10:00:00.000Z",
      method: "BANK_TRANSFER",
      reference: "SUPPLIER-TRANSFER-001",
    };
    await authed(accountA.accessToken, tenantA)
      .post(`/v1/purchase-invoices/${purchaseDraft.body.id}/payments`)
      .send(supplierPaymentInput)
      .expect(400);
    await authed(accountB.accessToken, tenantB)
      .get(`/v1/purchase-invoices/${purchaseDraft.body.id}/payments`)
      .expect(404);
    const firstSupplierPayment = await authed(accountA.accessToken, tenantA)
      .post(`/v1/purchase-invoices/${purchaseDraft.body.id}/payments`)
      .set("idempotency-key", "supplier-payment-a-1")
      .send(supplierPaymentInput)
      .expect(201);
    expect(firstSupplierPayment.body).toMatchObject({
      purchaseInvoiceId: purchaseDraft.body.id,
      amount: "100",
      currency: "EUR",
    });
    expect(firstSupplierPayment.body.allocations).toHaveLength(1);
    expect(firstSupplierPayment.body.allocations[0].amount).toBe("100");
    const partlyPaidPurchaseSchedule = await authed(
      accountA.accessToken,
      tenantA,
    )
      .get(
        `/v1/purchase-invoices/${purchaseDraft.body.id}/payment-schedule?asOf=2026-10-15`,
      )
      .expect(200);
    expect(partlyPaidPurchaseSchedule.body.installments).toEqual([
      expect.objectContaining({
        status: "PAID",
        paidAmount: "100",
        overdue: false,
      }),
      expect.objectContaining({
        status: "PENDING",
        paidAmount: "0",
        overdue: false,
      }),
    ]);
    let supplierPaymentEntries = await authed(accountA.accessToken, tenantA)
      .get("/v1/accounting/journal-entries?sourceType=SUPPLIER_PAYMENT")
      .expect(200);
    expect(supplierPaymentEntries.body.data).toHaveLength(1);
    expect(supplierPaymentEntries.body.data[0]).toMatchObject({
      sourceId: firstSupplierPayment.body.id,
      status: "POSTED",
      entryNumber: "6",
    });
    expect(accountingAmounts(supplierPaymentEntries.body.data[0])).toEqual({
      "400000": { debit: "100", credit: "0" },
      "572000": { debit: "0", credit: "100" },
    });
    await expect(
      admin.supplierPayment.update({
        where: { id: firstSupplierPayment.body.id },
        data: { reference: "TAMPERED" },
      }),
    ).rejects.toThrow(/recorded supplier payments are immutable/);
    await expect(
      admin.supplierPaymentAllocation.update({
        where: { id: firstSupplierPayment.body.allocations[0].id },
        data: { amount: "1" },
      }),
    ).rejects.toThrow(/recorded supplier payment allocations are immutable/);
    const retriedSupplierPayment = await authed(accountA.accessToken, tenantA)
      .post(`/v1/purchase-invoices/${purchaseDraft.body.id}/payments`)
      .set("idempotency-key", "supplier-payment-a-1")
      .send(supplierPaymentInput)
      .expect(201);
    expect(retriedSupplierPayment.body.id).toBe(firstSupplierPayment.body.id);
    supplierPaymentEntries = await authed(accountA.accessToken, tenantA)
      .get("/v1/accounting/journal-entries?sourceType=SUPPLIER_PAYMENT")
      .expect(200);
    expect(supplierPaymentEntries.body.data).toHaveLength(1);
    await authed(accountA.accessToken, tenantA)
      .post(`/v1/purchase-invoices/${purchaseDraft.body.id}/payments`)
      .set("idempotency-key", "supplier-payment-a-overpay")
      .send({ ...supplierPaymentInput, amount: 143 })
      .expect(400);
    const finalSupplierAttempts = await Promise.all([
      authed(accountA.accessToken, tenantA)
        .post(`/v1/purchase-invoices/${purchaseDraft.body.id}/payments`)
        .set("idempotency-key", "supplier-payment-a-2")
        .send({
          ...supplierPaymentInput,
          amount: 142,
          reference: "SUPPLIER-TRANSFER-002",
        }),
      authed(accountA.accessToken, tenantA)
        .post(`/v1/purchase-invoices/${purchaseDraft.body.id}/payments`)
        .set("idempotency-key", "supplier-payment-a-competing")
        .send({
          ...supplierPaymentInput,
          amount: 142,
          reference: "SUPPLIER-TRANSFER-COMPETING",
        }),
    ]);
    expect(finalSupplierAttempts.map(({ status }) => status).sort()).toEqual([
      201, 409,
    ]);
    const supplierPayments = await authed(accountA.accessToken, tenantA)
      .get(`/v1/purchase-invoices/${purchaseDraft.body.id}/payments`)
      .expect(200);
    expect(supplierPayments.body).toHaveLength(2);
    const paidPurchase = await authed(accountA.accessToken, tenantA)
      .get(`/v1/purchase-invoices/${purchaseDraft.body.id}`)
      .expect(200);
    expect(paidPurchase.body).toMatchObject({
      status: "APPROVED",
      amountPaid: "242",
      amountDue: "0",
    });
    const paidPurchaseSchedule = await authed(accountA.accessToken, tenantA)
      .get(
        `/v1/purchase-invoices/${purchaseDraft.body.id}/payment-schedule?asOf=2026-12-31`,
      )
      .expect(200);
    expect(paidPurchaseSchedule.body.installments).toEqual([
      expect.objectContaining({
        status: "PAID",
        paidAmount: "100",
        overdue: false,
      }),
      expect.objectContaining({
        status: "PAID",
        paidAmount: "142",
        overdue: false,
      }),
    ]);
    supplierPaymentEntries = await authed(accountA.accessToken, tenantA)
      .get("/v1/accounting/journal-entries?sourceType=SUPPLIER_PAYMENT")
      .expect(200);
    expect(supplierPaymentEntries.body.data).toHaveLength(2);
    const finalSupplierPayment = supplierPayments.body.find(
      ({ id }: { id: string }) => id !== firstSupplierPayment.body.id,
    );
    const finalSupplierEntry = supplierPaymentEntries.body.data.find(
      ({ sourceId }: { sourceId: string }) =>
        sourceId === finalSupplierPayment.id,
    );
    expect(accountingAmounts(finalSupplierEntry)).toEqual({
      "400000": { debit: "142", credit: "0" },
      "572000": { debit: "0", credit: "142" },
    });

    const accountingAccounts = await authed(accountA.accessToken, tenantA)
      .get("/v1/accounting/accounts")
      .expect(200);
    const bankAccountingAccount = accountingAccounts.body.find(
      ({ code }: { code: string }) => code === "572000",
    );
    const customerAccountingAccount = accountingAccounts.body.find(
      ({ code }: { code: string }) => code === "430000",
    );
    await authed(accountA.accessToken, tenantA)
      .post("/v1/banking/accounts")
      .send({
        accountId: customerAccountingAccount.id,
        name: "Invalid bank ledger",
        currency: "EUR",
      })
      .expect(400);
    await authed(accountA.accessToken, tenantA)
      .post("/v1/banking/accounts")
      .send({
        accountId: bankAccountingAccount.id,
        name: "Invalid IBAN",
        iban: "ES00 2100 0418 4502 0005 1332",
        currency: "EUR",
      })
      .expect(400);
    const createdBankAccount = await authed(accountA.accessToken, tenantA)
      .post("/v1/banking/accounts")
      .send({
        accountId: bankAccountingAccount.id,
        name: "Operating account",
        iban: "ES91 2100 0418 4502 0005 1332",
        currency: "EUR",
      })
      .expect(201);
    expect(createdBankAccount.body).toMatchObject({
      accountId: bankAccountingAccount.id,
      iban: "ES9121000418450200051332",
      currency: "EUR",
    });
    await expect(
      admin.bankAccount.update({
        where: { id: createdBankAccount.body.id },
        data: { accountId: customerAccountingAccount.id },
      }),
    ).rejects.toThrow(/bank account ledger mapping and currency are immutable/);
    await authed(accountA.accessToken, tenantA)
      .post("/v1/banking/accounts")
      .send({
        accountId: bankAccountingAccount.id,
        name: "Duplicate operating account",
      })
      .expect(409);
    const bankImport = {
      bankAccountId: createdBankAccount.body.id,
      transactions: [
        {
          externalId: "BANK-CUSTOMER-001",
          bookingDate: "2026-09-15",
          valueDate: "2026-09-15",
          amount: 60.5,
          description: "Incoming transfer F2026-00001",
          counterpartyName: "Customer A",
          reference: "F2026-00001",
        },
        {
          externalId: "BANK-SUPPLIER-001",
          bookingDate: "2026-10-10",
          amount: -100,
          description: "Outgoing transfer PROV-2026-0042",
          counterpartyName: "Supplier A",
          reference: "PROV-2026-0042",
        },
      ],
    };
    const importedBankTransactions = await authed(accountA.accessToken, tenantA)
      .post("/v1/banking/transactions/import")
      .send(bankImport)
      .expect(201);
    expect(importedBankTransactions.body).toHaveLength(2);
    expect(
      importedBankTransactions.body.map(
        ({ status }: { status: string }) => status,
      ),
    ).toEqual(["UNMATCHED", "UNMATCHED"]);
    await authed(accountA.accessToken, tenantA)
      .post("/v1/banking/transactions/import")
      .send(bankImport)
      .expect(409);
    const customerBankTransaction = importedBankTransactions.body.find(
      ({ externalId }: { externalId: string }) =>
        externalId === "BANK-CUSTOMER-001",
    );
    const supplierBankTransaction = importedBankTransactions.body.find(
      ({ externalId }: { externalId: string }) =>
        externalId === "BANK-SUPPLIER-001",
    );
    await authed(accountB.accessToken, tenantB)
      .get(`/v1/banking/transactions/${customerBankTransaction.id}/suggestions`)
      .expect(404);
    const customerSuggestions = await authed(accountA.accessToken, tenantA)
      .get(`/v1/banking/transactions/${customerBankTransaction.id}/suggestions`)
      .expect(200);
    const firstCustomerEntry = paymentEntries.body.data.find(
      ({ sourceId }: { sourceId: string }) => sourceId === firstPayment.body.id,
    );
    const customerBankLine = firstCustomerEntry.lines.find(
      ({ account }: { account: { code: string } }) => account.code === "572000",
    );
    expect(customerSuggestions.body[0]).toMatchObject({
      journalLineId: customerBankLine.id,
      score: 100,
      debit: "60.5",
      credit: "0",
    });
    const customerReconciliation = await authed(accountA.accessToken, tenantA)
      .post(`/v1/banking/transactions/${customerBankTransaction.id}/reconcile`)
      .send({ journalLineId: customerBankLine.id })
      .expect(200);
    const retriedReconciliation = await authed(accountA.accessToken, tenantA)
      .post(`/v1/banking/transactions/${customerBankTransaction.id}/reconcile`)
      .send({ journalLineId: customerBankLine.id })
      .expect(200);
    expect(retriedReconciliation.body.id).toBe(customerReconciliation.body.id);
    await expect(
      admin.bankReconciliation.update({
        where: { id: customerReconciliation.body.id },
        data: { reconciledAt: new Date() },
      }),
    ).rejects.toThrow(/bank reconciliations are append-only/);
    await expect(
      admin.bankTransaction.update({
        where: { id: customerBankTransaction.id },
        data: { description: "TAMPERED" },
      }),
    ).rejects.toThrow(/imported bank transaction contents are immutable/);
    await expect(
      admin.bankReconciliation.create({
        data: {
          organizationId: tenantA.organizationId,
          companyId: tenantA.companyId,
          bankTransactionId: supplierBankTransaction.id,
          journalLineId: customerBankLine.id,
          reconciledById: tenantA.userId,
        },
      }),
    ).rejects.toThrow(
      /bank reconciliation must match an unreconciled transaction to an equal posted bank line/,
    );
    await authed(accountA.accessToken, tenantA)
      .post(`/v1/banking/transactions/${supplierBankTransaction.id}/reconcile`)
      .send({ journalLineId: customerBankLine.id })
      .expect(409);
    const supplierSuggestions = await authed(accountA.accessToken, tenantA)
      .get(`/v1/banking/transactions/${supplierBankTransaction.id}/suggestions`)
      .expect(200);
    const firstSupplierEntry = supplierPaymentEntries.body.data.find(
      ({ sourceId }: { sourceId: string }) =>
        sourceId === firstSupplierPayment.body.id,
    );
    const supplierBankLine = firstSupplierEntry.lines.find(
      ({ account }: { account: { code: string } }) => account.code === "572000",
    );
    expect(supplierSuggestions.body[0]).toMatchObject({
      journalLineId: supplierBankLine.id,
      score: 100,
      debit: "0",
      credit: "100",
    });
    await authed(accountA.accessToken, tenantA)
      .post(`/v1/banking/transactions/${supplierBankTransaction.id}/reconcile`)
      .send({ journalLineId: supplierBankLine.id })
      .expect(200);
    const reconciledTransactions = await authed(accountA.accessToken, tenantA)
      .get("/v1/banking/transactions?status=RECONCILED")
      .expect(200);
    expect(reconciledTransactions.body.data).toHaveLength(2);
    await expect(
      admin.purchaseInvoice.update({
        where: { id: purchaseDraft.body.id },
        data: { supplierInvoiceNumber: "TAMPERED" },
      }),
    ).rejects.toThrow(/approved purchase invoices are immutable/);
    await authed(accountA.accessToken, tenantA)
      .delete(`/v1/purchase-invoices/${purchaseDraft.body.id}`)
      .expect(409);
    const disposablePurchase = await authed(accountA.accessToken, tenantA)
      .post("/v1/purchase-invoices")
      .send({ ...purchaseInput, supplierInvoiceNumber: "PROV-2026-0043" })
      .expect(201);
    const updatedPurchase = await authed(accountA.accessToken, tenantA)
      .patch(`/v1/purchase-invoices/${disposablePurchase.body.id}`)
      .send({
        ...purchaseInput,
        supplierInvoiceNumber: "PROV-2026-0044",
        notes: "Reviewed before approval",
      })
      .expect(200);
    expect(updatedPurchase.body.notes).toBe("Reviewed before approval");
    const searchedPurchases = await authed(accountA.accessToken, tenantA)
      .get("/v1/purchase-invoices?search=0044")
      .expect(200);
    expect(searchedPurchases.body.data).toHaveLength(1);
    await authed(accountA.accessToken, tenantA)
      .delete(`/v1/purchase-invoices/${disposablePurchase.body.id}`)
      .expect(204);
    await authed(accountA.accessToken, tenantA)
      .get(`/v1/purchase-invoices/${disposablePurchase.body.id}`)
      .expect(404);

    const accounts = await authed(accountA.accessToken, tenantA)
      .get("/v1/accounting/accounts")
      .expect(200);
    expect(accounts.body).toHaveLength(9);
    const bankAccount = accounts.body.find(
      ({ code }: { code: string }) => code === "572000",
    );
    const customerAccount = accounts.body.find(
      ({ code }: { code: string }) => code === "430000",
    );
    const manualInput = {
      entryDate: "2026-11-05",
      description: '=Manual; "bank" adjustment',
      lines: [
        { accountId: bankAccount.id, debit: 10 },
        { accountId: customerAccount.id, credit: 10 },
      ],
    };
    await authed(accountA.accessToken, tenantA)
      .post("/v1/accounting/journal-entries")
      .set("idempotency-key", "manual-unbalanced-a")
      .send({
        ...manualInput,
        lines: [
          { accountId: bankAccount.id, debit: 10 },
          { accountId: customerAccount.id, credit: 9 },
        ],
      })
      .expect(400);
    const manualEntry = await authed(accountA.accessToken, tenantA)
      .post("/v1/accounting/journal-entries")
      .set("idempotency-key", "manual-balanced-a")
      .send(manualInput)
      .expect(201);
    const retriedManual = await authed(accountA.accessToken, tenantA)
      .post("/v1/accounting/journal-entries")
      .set("idempotency-key", "manual-balanced-a")
      .send(manualInput)
      .expect(201);
    expect(retriedManual.body.id).toBe(manualEntry.body.id);
    const reversal = await authed(accountA.accessToken, tenantA)
      .post(`/v1/accounting/journal-entries/${manualEntry.body.id}/reverse`)
      .set("idempotency-key", "reverse-manual-a")
      .send({ entryDate: "2026-11-06", reason: "Acceptance test" })
      .expect(201);
    expect(reversal.body.reversalOfId).toBe(manualEntry.body.id);
    expect(accountingAmounts(reversal.body)).toEqual({
      "430000": { debit: "10", credit: "0" },
      "572000": { debit: "0", credit: "10" },
    });
    const journalReport = await authed(accountA.accessToken, tenantA)
      .get("/v1/accounting/reports/journal?from=2026-01-01&to=2026-12-31")
      .expect(200);
    expect(journalReport.body).toMatchObject({
      from: "2026-01-01",
      to: "2026-12-31",
      totalDebit: "867",
      totalCredit: "867",
    });
    expect(journalReport.body.lines).toHaveLength(21);
    const paymentJournalReport = await authed(accountA.accessToken, tenantA)
      .get(
        "/v1/accounting/reports/journal?from=2026-09-01&to=2026-10-31&sourceType=PAYMENT",
      )
      .expect(200);
    expect(paymentJournalReport.body).toMatchObject({
      sourceType: "PAYMENT",
      totalDebit: "121",
      totalCredit: "121",
    });
    expect(paymentJournalReport.body.lines).toHaveLength(4);
    await authed(accountA.accessToken, tenantA)
      .get("/v1/accounting/reports/journal?from=2026-12-31&to=2026-01-01")
      .expect(400);
    await authed(accountA.accessToken, tenantA)
      .get("/v1/accounting/reports/journal?from=2025-01-01&to=2026-12-31")
      .expect(400);
    const journalCsv = await authed(accountA.accessToken, tenantA)
      .get("/v1/accounting/reports/journal.csv?from=2026-01-01&to=2026-12-31")
      .expect("content-type", /text\/csv/)
      .expect(
        "content-disposition",
        'attachment; filename="journal-2026-01-01-2026-12-31.csv"',
      )
      .expect(200);
    expect(journalCsv.text).toContain(`"'=Manual; ""bank"" adjustment"`);
    const bankLedger = await authed(accountA.accessToken, tenantA)
      .get(
        `/v1/accounting/reports/general-ledger?accountId=${bankAccount.id}&from=2026-01-01&to=2026-12-31`,
      )
      .expect(200);
    expect(bankLedger.body).toMatchObject({
      account: { id: bankAccount.id, code: "572000" },
      openingBalance: "0",
      totalDebit: "131",
      totalCredit: "252",
      closingBalance: "-121",
    });
    expect(bankLedger.body.lines).toHaveLength(6);
    expect(bankLedger.body.lines.at(-1).runningBalance).toBe("-121");
    await authed(accountB.accessToken, tenantB)
      .get(
        `/v1/accounting/reports/general-ledger?accountId=${bankAccount.id}&from=2026-01-01&to=2026-12-31`,
      )
      .expect(404);
    const ledgerCsv = await authed(accountA.accessToken, tenantA)
      .get(
        `/v1/accounting/reports/general-ledger.csv?accountId=${bankAccount.id}&from=2026-01-01&to=2026-12-31`,
      )
      .expect("content-type", /text\/csv/)
      .expect(
        "content-disposition",
        'attachment; filename="general-ledger-572000-2026-01-01-2026-12-31.csv"',
      )
      .expect(200);
    expect(ledgerCsv.text).toContain(
      "TOTAL;;2026-12-31;Closing balance 572000;;131;252;-121",
    );
    const trialBalance = await authed(accountA.accessToken, tenantA)
      .get("/v1/accounting/trial-balance?from=2026-01-01&to=2026-12-31")
      .expect(200);
    expect(
      trialBalance.body.reduce(
        (sum: number, row: { balance: string }) => sum + Number(row.balance),
        0,
      ),
    ).toBe(0);
    const fiscalYears = await authed(accountA.accessToken, tenantA)
      .get("/v1/accounting/fiscal-years")
      .expect(200);
    const lockedPaymentDraft = await authed(accountA.accessToken, tenantA)
      .post("/v1/invoices")
      .send(invoice(contactA.body.id))
      .expect(201);
    await authed(accountA.accessToken, tenantA)
      .post(`/v1/invoices/${lockedPaymentDraft.body.id}/issue`)
      .set("idempotency-key", "issue-locked-payment-a")
      .send({ sequenceId: sequence.body.id })
      .expect(200);
    const november = fiscalYears.body[0].periods.find(
      ({ code }: { code: string }) => code === "2026-11",
    );
    await authed(accountA.accessToken, tenantA)
      .post(`/v1/accounting/periods/${november.id}/lock`)
      .expect(200);
    await authed(accountA.accessToken, tenantA)
      .post("/v1/accounting/journal-entries")
      .set("idempotency-key", "manual-locked-a")
      .send({ ...manualInput, entryDate: "2026-11-07" })
      .expect(409);
    await authed(accountA.accessToken, tenantA)
      .post(`/v1/invoices/${lockedPaymentDraft.body.id}/payments`)
      .set("idempotency-key", "payment-locked-period-a")
      .send({
        amount: 121,
        paidAt: "2026-11-07T10:00:00.000Z",
        method: "BANK_TRANSFER",
      })
      .expect(409);
    const paymentRolledBack = await authed(accountA.accessToken, tenantA)
      .get(`/v1/invoices/${lockedPaymentDraft.body.id}`)
      .expect(200);
    expect(paymentRolledBack.body).toMatchObject({
      status: "ISSUED",
      amountPaid: "0",
      amountDue: "121",
    });
    const rolledBackPayments = await authed(accountA.accessToken, tenantA)
      .get(`/v1/invoices/${lockedPaymentDraft.body.id}/payments`)
      .expect(200);
    expect(rolledBackPayments.body).toHaveLength(0);

    const disposableInvoice = await authed(accountA.accessToken, tenantA)
      .post("/v1/invoices")
      .send(invoice(contactA.body.id))
      .expect(201);
    await authed(accountA.accessToken, tenantA)
      .delete(`/v1/invoices/${disposableInvoice.body.id}`)
      .expect(204);

    const transitions = await Promise.all([
      authed(accountA.accessToken, tenantA)
        .post(`/v1/quotes/${createdQuote.body.id}/status`)
        .send({ expectedStatus: "DRAFT", status: "SENT" }),
      authed(accountA.accessToken, tenantA)
        .post(`/v1/quotes/${createdQuote.body.id}/status`)
        .send({ expectedStatus: "DRAFT", status: "CANCELLED" }),
    ]);
    expect(transitions.map(({ status }) => status).sort()).toEqual([200, 409]);

    const defaultPurchaseApprovalPolicy = await authed(
      accountA.accessToken,
      tenantA,
    )
      .get("/v1/purchase-approval-policy")
      .expect(200);
    expect(defaultPurchaseApprovalPolicy.body).toEqual([
      { minimumAmount: "0", requiredApprovals: 1 },
    ]);
    await authed(accountA.accessToken, tenantA)
      .put("/v1/purchase-approval-policy")
      .send({
        tiers: [
          { minimumAmount: 0, requiredApprovals: 2 },
          { minimumAmount: 1000, requiredApprovals: 1 },
        ],
      })
      .expect(400);
    const twoLevelPolicy = await authed(accountA.accessToken, tenantA)
      .put("/v1/purchase-approval-policy")
      .send({ tiers: [{ minimumAmount: 0, requiredApprovals: 2 }] })
      .expect(200);
    expect(twoLevelPolicy.body[0]).toMatchObject({ requiredApprovals: 2 });
    const multiLevelDraft = await authed(accountA.accessToken, tenantA)
      .post("/v1/purchase-invoices")
      .send({
        ...purchaseInput,
        supplierInvoiceNumber: "PROV-2026-0050",
      })
      .expect(201);
    const firstApproval = await authed(accountA.accessToken, tenantA)
      .post(`/v1/purchase-invoices/${multiLevelDraft.body.id}/approve`)
      .set("idempotency-key", "multi-approval-a-1")
      .send({ sequenceId: purchaseSequence.body.id })
      .expect(200);
    expect(firstApproval.body).toMatchObject({
      status: "PENDING_APPROVAL",
      requiredApprovals: 2,
      approvalCount: 1,
      receptionFullNumber: null,
    });
    expect(firstApproval.body.approvals).toHaveLength(1);
    await authed(accountA.accessToken, tenantA)
      .patch(`/v1/purchase-invoices/${multiLevelDraft.body.id}`)
      .send(purchaseInput)
      .expect(409);
    const ownerRole = await admin.role.findUniqueOrThrow({
      where: { code: "organization.owner" },
    });
    await admin.membership.create({
      data: {
        organizationId: tenantA.organizationId,
        companyId: tenantA.companyId,
        userId: tenantB.userId,
        roleId: ownerRole.id,
      },
    });
    const rejectedPurchase = await authed(accountB.accessToken, tenantA)
      .post(`/v1/purchase-invoices/${multiLevelDraft.body.id}/reject`)
      .send({ reason: "Supplier evidence needs correction" })
      .expect(200);
    expect(rejectedPurchase.body).toMatchObject({
      status: "DRAFT",
      requiredApprovals: 1,
      approvalCount: 0,
    });
    expect(rejectedPurchase.body.approvals).toHaveLength(0);
    await authed(accountA.accessToken, tenantA)
      .patch(`/v1/purchase-invoices/${multiLevelDraft.body.id}`)
      .send({
        ...purchaseInput,
        supplierInvoiceNumber: "PROV-2026-0050",
        notes: "Evidence corrected",
      })
      .expect(200);
    const resubmittedPurchase = await authed(accountA.accessToken, tenantA)
      .post(`/v1/purchase-invoices/${multiLevelDraft.body.id}/approve`)
      .set("idempotency-key", "multi-approval-a-2")
      .send({ sequenceId: purchaseSequence.body.id })
      .expect(200);
    expect(resubmittedPurchase.body.status).toBe("PENDING_APPROVAL");
    await authed(accountA.accessToken, tenantA)
      .post(`/v1/purchase-invoices/${multiLevelDraft.body.id}/approve`)
      .set("idempotency-key", "multi-approval-a-2")
      .send({ sequenceId: purchaseSequence.body.id })
      .expect(200);
    await authed(accountA.accessToken, tenantA)
      .post(`/v1/purchase-invoices/${multiLevelDraft.body.id}/approve`)
      .set("idempotency-key", "multi-approval-a-3")
      .send({ sequenceId: purchaseSequence.body.id })
      .expect(409);
    const completedMultiLevelPurchase = await authed(
      accountB.accessToken,
      tenantA,
    )
      .post(`/v1/purchase-invoices/${multiLevelDraft.body.id}/approve`)
      .set("idempotency-key", "multi-approval-b-1")
      .send({ sequenceId: purchaseSequence.body.id })
      .expect(200);
    expect(completedMultiLevelPurchase.body).toMatchObject({
      status: "APPROVED",
      requiredApprovals: 2,
      approvalCount: 2,
      receptionFullNumber: "REC2026-00002",
    });
    expect(completedMultiLevelPurchase.body.approvals).toHaveLength(2);
    expect(
      new Set(
        completedMultiLevelPurchase.body.approvals.map(
          ({ approvedBy }: { approvedBy: { id: string } }) => approvedBy.id,
        ),
      ).size,
    ).toBe(2);
    await expect(
      admin.purchaseInvoiceApproval.update({
        where: { id: completedMultiLevelPurchase.body.approvals[0].id },
        data: { position: 2 },
      }),
    ).rejects.toThrow(/purchase approvals are immutable/);
    await expect(
      admin.$transaction(async (db) => {
        await db.purchaseInvoice.update({
          where: { id: multiLevelDraft.body.id },
          data: { requiredApprovals: 1, approvalCount: 1 },
        });
      }),
    ).rejects.toThrow(
      /purchase invoice approval count does not match its decisions/,
    );

    const r4Customer = await authed(accountA.accessToken, tenantA)
      .post("/v1/contacts")
      .send({
        legalName: "R4 XML Customer",
        taxId: "00000000T",
        isCustomer: true,
        isSupplier: false,
      })
      .expect(201);
    const r4Original = await authed(accountA.accessToken, tenantA)
      .post("/v1/invoices")
      .send(invoice(r4Customer.body.id))
      .expect(201);
    const r4IssuedOriginal = await authed(accountA.accessToken, tenantA)
      .post(`/v1/invoices/${r4Original.body.id}/issue`)
      .set("idempotency-key", "issue-r4-original-a")
      .send({ sequenceId: sequence.body.id })
      .expect(200);
    const r4Draft = await authed(accountA.accessToken, tenantA)
      .post(`/v1/invoices/${r4Original.body.id}/rectifications`)
      .send({
        sifInvoiceType: "R4",
        kind: "PARTIAL",
        impact: "DECREASE",
        reason: "Correction of the agreed service price",
        issueDate: "2026-09-16",
        lines: [
          {
            description: "Price correction",
            quantity: 1,
            unitPrice: 20,
            taxRate: 21,
          },
        ],
      })
      .expect(201);
    await authed(accountA.accessToken, tenantA)
      .post(`/v1/invoices/${r4Draft.body.id}/issue`)
      .set("idempotency-key", "issue-r4-difference-a")
      .send({ sequenceId: creditSequence.body.id })
      .expect(200);
    const creditedR4Original = await authed(accountA.accessToken, tenantA)
      .get(`/v1/invoices/${r4Original.body.id}`)
      .expect(200);
    expect(creditedR4Original.body).toMatchObject({
      total: "121", amountPaid: "0", creditedAmount: "24.2", amountDue: "96.8",
    });
    expect(creditedR4Original.body.installments[0]).toMatchObject({
      amount: "121", paidAmount: "0", creditedAmount: "24.2",
    });
    await expect(admin.invoice.update({
      where: { id: r4Original.body.id },
      data: { creditedAmount: "25.2" },
    })).rejects.toThrow(/invoices_payment_balance_check/);
    await authed(accountA.accessToken, tenantA)
      .post(`/v1/invoices/${r4Original.body.id}/payments`)
      .set("idempotency-key", "r4-overpayment-a")
      .send({ amount: 97, paidAt: "2026-09-17T10:00:00.000Z", method: "BANK_TRANSFER" })
      .expect(400);
    await authed(accountA.accessToken, tenantA)
      .post(`/v1/invoices/${r4Original.body.id}/payments`)
      .set("idempotency-key", "r4-settlement-a")
      .send({ amount: 96.8, paidAt: "2026-09-17T10:00:00.000Z", method: "BANK_TRANSFER" })
      .expect(201);
    const settledR4Original = await authed(accountA.accessToken, tenantA)
      .get(`/v1/invoices/${r4Original.body.id}`)
      .expect(200);
    expect(settledR4Original.body).toMatchObject({
      status: "SETTLED", amountPaid: "96.8", creditedAmount: "24.2", amountDue: "0",
    });
    expect(settledR4Original.body.installments[0]).toMatchObject({
      amount: "121", paidAmount: "96.8", creditedAmount: "24.2",
    });
    const r4Records = await authed(accountA.accessToken, tenantA)
      .get(`/v1/sif/records?invoiceId=${r4Draft.body.id}`)
      .expect(200);
    expect(r4Records.body).toHaveLength(1);
    const r4XmlResponse = await authed(accountA.accessToken, tenantA)
      .get(`/v1/sif/records/${r4Records.body[0].id}/xml`)
      .expect("content-type", /application\/xml/)
      .expect(200);
    const r4Xml = r4XmlResponse.text ?? r4XmlResponse.body.toString("utf8");
    expect(r4Xml).toContain("<sf:TipoFactura>R4</sf:TipoFactura>");
    expect(r4Xml).toContain("<sf:TipoRectificativa>I</sf:TipoRectificativa>");
    expect(r4Xml).toContain(
      `<sf:NumSerieFactura>${r4IssuedOriginal.body.fullNumber}</sf:NumSerieFactura>`,
    );
    expect(r4Xml).toContain(
      "<sf:BaseImponibleOimporteNoSujeto>-20.00</sf:BaseImponibleOimporteNoSujeto>",
    );
    expect(r4Xml).toContain("<sf:CuotaRepercutida>-4.20</sf:CuotaRepercutida>");
    expect(r4Xml).toContain("<sf:ImporteTotal>-24.20</sf:ImporteTotal>");
    const r4SchemaCheck = spawnSync(
      "xmllint",
      [
        "--noout",
        "--schema",
        join(__dirname, "../src/sif/xsd/SuministroLR.xsd"),
        "-",
      ],
      { input: r4Xml, encoding: "utf8" },
    );
    expect(r4SchemaCheck.error).toBeUndefined();
    expect(r4SchemaCheck.status).toBe(0);

    const r1Original = await authed(accountA.accessToken, tenantA)
      .post("/v1/invoices")
      .send({ ...invoice(r4Customer.body.id), operationDate: "2026-09-07" })
      .expect(201);
    expect(r1Original.body.operationDate).toMatch(/^2026-09-07/);
    const r1IssuedOriginal = await authed(accountA.accessToken, tenantA)
      .post(`/v1/invoices/${r1Original.body.id}/issue`)
      .set("idempotency-key", "issue-r1-original-a")
      .send({ sequenceId: sequence.body.id })
      .expect(200);
    const r1OriginalLedger = await authed(accountA.accessToken, tenantA)
      .get(`/v1/tax-ledger?invoiceId=${r1Original.body.id}`)
      .expect(200);
    expect(r1OriginalLedger.body.data[0].operationDate).toMatch(/^2026-09-07/);
    const r1OriginalRecords = await authed(accountA.accessToken, tenantA)
      .get(`/v1/sif/records?invoiceId=${r1Original.body.id}`)
      .expect(200);
    const r1OriginalXmlResponse = await authed(accountA.accessToken, tenantA)
      .get(`/v1/sif/records/${r1OriginalRecords.body[0].id}/xml`)
      .expect(200);
    const r1OriginalXml = r1OriginalXmlResponse.text ?? r1OriginalXmlResponse.body.toString("utf8");
    expect(r1OriginalXml).toContain("<sf:TipoFactura>F1</sf:TipoFactura>");
    expect(r1OriginalXml).toContain("<sf:FechaOperacion>07-09-2026</sf:FechaOperacion>");
    const r1OriginalSchemaCheck = spawnSync("xmllint", [
      "--noout", "--schema", join(__dirname, "../src/sif/xsd/SuministroLR.xsd"), "-",
    ], { input: r1OriginalXml, encoding: "utf8" });
    expect(r1OriginalSchemaCheck.error).toBeUndefined();
    expect(r1OriginalSchemaCheck.status).toBe(0);
    const r1Draft = await authed(accountA.accessToken, tenantA)
      .post(`/v1/invoices/${r1Original.body.id}/rectifications`)
      .send({
        sifInvoiceType: "R1", kind: "TOTAL", impact: "DECREASE",
        reason: "Returned goods after delivery", issueDate: "2026-09-16",
      })
      .expect(201);
    expect(r1Draft.body.operationDate).toMatch(/^2026-09-07/);
    await authed(accountA.accessToken, tenantA)
      .post(`/v1/invoices/${r1Draft.body.id}/issue`)
      .set("idempotency-key", "issue-r1-difference-a")
      .send({ sequenceId: creditSequence.body.id })
      .expect(200);
    const creditedR1Original = await authed(accountA.accessToken, tenantA)
      .get(`/v1/invoices/${r1Original.body.id}`)
      .expect(200);
    expect(creditedR1Original.body).toMatchObject({
      status: "RECTIFIED", amountPaid: "0", creditedAmount: "121", amountDue: "0",
    });
    expect(creditedR1Original.body.installments[0].creditedAmount).toBe("121");
    const r1Ledger = await authed(accountA.accessToken, tenantA)
      .get(`/v1/tax-ledger?invoiceId=${r1Draft.body.id}`)
      .expect(200);
    expect(r1Ledger.body.data[0].operationDate).toMatch(/^2026-09-07/);
    const r1Records = await authed(accountA.accessToken, tenantA)
      .get(`/v1/sif/records?invoiceId=${r1Draft.body.id}`)
      .expect(200);
    expect(r1Records.body).toHaveLength(1);
    const r1XmlResponse = await authed(accountA.accessToken, tenantA)
      .get(`/v1/sif/records/${r1Records.body[0].id}/xml`)
      .expect("content-type", /application\/xml/)
      .expect(200);
    const r1Xml = r1XmlResponse.text ?? r1XmlResponse.body.toString("utf8");
    expect(r1Xml).toContain("<sf:TipoFactura>R1</sf:TipoFactura>");
    expect(r1Xml).toContain("<sf:FechaOperacion>07-09-2026</sf:FechaOperacion>");
    expect(r1Xml).toContain(`<sf:NumSerieFactura>${r1IssuedOriginal.body.fullNumber}</sf:NumSerieFactura>`);
    expect(r1Xml).toContain("<sf:ImporteTotal>-121.00</sf:ImporteTotal>");
    const r1SchemaCheck = spawnSync("xmllint", [
      "--noout", "--schema", join(__dirname, "../src/sif/xsd/SuministroLR.xsd"), "-",
    ], { input: r1Xml, encoding: "utf8" });
    expect(r1SchemaCheck.error).toBeUndefined();
    expect(r1SchemaCheck.status).toBe(0);

    const historicalDraft = await authed(accountA.accessToken, tenantA)
      .post("/v1/invoices")
      .send(invoice(r4Customer.body.id))
      .expect(201);
    await admin.invoice.update({ where: { id: historicalDraft.body.id }, data: { operationDate: null } });
    await authed(accountA.accessToken, tenantA)
      .post(`/v1/invoices/${historicalDraft.body.id}/issue`)
      .set("idempotency-key", "issue-r1-historical-a")
      .send({ sequenceId: sequence.body.id })
      .expect(200);
    const historicalR1Response = await authed(accountA.accessToken, tenantA)
      .post(`/v1/invoices/${historicalDraft.body.id}/rectifications`)
      .send({
        sifInvoiceType: "R1", kind: "TOTAL", impact: "DECREASE",
        reason: "Correction after delivery", issueDate: "2026-09-16",
      })
      .expect(409);
    expect(JSON.stringify(historicalR1Response.body)).toContain("R1 requires the original invoice operation date");
    for (const sifInvoiceType of ["R2", "R3"]) {
      const response = await authed(accountA.accessToken, tenantA)
        .post(`/v1/invoices/${historicalDraft.body.id}/rectifications`)
        .send({
          sifInvoiceType, kind: "DIFFERENCE", impact: "DECREASE",
          reason: "Correction after delivery", issueDate: "2026-09-16",
        })
        .expect(409);
      expect(JSON.stringify(response.body)).toContain(`${sifInvoiceType} requires the original invoice operation date`);
    }
    const historicalR4Draft = await authed(accountA.accessToken, tenantA)
      .post(`/v1/invoices/${historicalDraft.body.id}/rectifications`)
      .send({
        sifInvoiceType: "R4", kind: "TOTAL", impact: "DECREASE",
        reason: "Legacy draft before date validation", issueDate: "2026-09-16",
      })
      .expect(201);
    await admin.invoice.update({
      where: { id: historicalR4Draft.body.id }, data: { sifInvoiceType: "R2" },
    });
    const historicalR2Issue = await authed(accountA.accessToken, tenantA)
      .post(`/v1/invoices/${historicalR4Draft.body.id}/issue`)
      .set("idempotency-key", "issue-r2-historical-a")
      .send({ sequenceId: creditSequence.body.id })
      .expect(409);
    expect(JSON.stringify(historicalR2Issue.body)).toContain("R2/R3 issuance requires a documented fiscal review");

    const vatOnlyOriginal = await authed(accountA.accessToken, tenantA)
      .post("/v1/invoices")
      .send(invoice(r4Customer.body.id))
      .expect(201);
    await authed(accountA.accessToken, tenantA)
      .post(`/v1/invoices/${vatOnlyOriginal.body.id}/issue`)
      .set("idempotency-key", "issue-vat-only-original-a")
      .send({ sequenceId: sequence.body.id })
      .expect(200);
    const vatOnlyInput = {
      sifInvoiceType: "R3", kind: "DIFFERENCE", impact: "DECREASE",
      reason: "Unpaid customer debt under review", issueDate: "2026-09-16",
    };
    await authed(accountA.accessToken, tenantA)
      .post(`/v1/invoices/${vatOnlyOriginal.body.id}/rectifications`)
      .send({ ...vatOnlyInput, lines: [{ description: "Manual tax", quantity: 1, unitPrice: 21, taxRate: 21 }] })
      .expect(400);
    const vatOnlyDraft = await authed(accountA.accessToken, tenantA)
      .post(`/v1/invoices/${vatOnlyOriginal.body.id}/rectifications`)
      .send(vatOnlyInput)
      .expect(201);
    expect(vatOnlyDraft.body).toMatchObject({
      status: "DRAFT", sifInvoiceType: "R3", rectificationKind: "DIFFERENCE",
      rectificationImpact: "DECREASE", subtotal: "0", taxTotal: "21", total: "21",
    });
    expect(vatOnlyDraft.body.lines[0]).toMatchObject({ netAmount: "0", taxAmount: "21", totalAmount: "21" });
    expect(vatOnlyDraft.body.lines[0].taxLines[0]).toMatchObject({ taxableBase: "0", taxAmount: "21" });
    await authed(accountA.accessToken, tenantA)
      .post(`/v1/invoices/${vatOnlyOriginal.body.id}/rectifications`)
      .send(vatOnlyInput)
      .expect(409);
    const blockedVatOnlyIssue = await authed(accountA.accessToken, tenantA)
      .post(`/v1/invoices/${vatOnlyDraft.body.id}/issue`)
      .set("idempotency-key", "issue-vat-only-draft-a")
      .send({ sequenceId: creditSequence.body.id })
      .expect(409);
    expect(JSON.stringify(blockedVatOnlyIssue.body)).toContain("R2/R3 issuance requires a documented fiscal review");
    const issuedVatOnly = await authed(accountA.accessToken, tenantA)
      .post(`/v1/invoices/${vatOnlyDraft.body.id}/issue`)
      .set("idempotency-key", "issue-vat-only-draft-a")
      .send({ sequenceId: creditSequence.body.id, vatRecoveryReview: {
        fiscalReviewConfirmed: true,
        exclusionsReviewed: true,
        legalEventDate: "2026-09-10",
        legalEventReference: "Fiscal review file R3-2026-01",
        claimEvidenceReference: "Certified payment demand R3-2026-01",
      } })
      .expect(200);
    expect(issuedVatOnly.body).toMatchObject({
      status: "ISSUED", sifInvoiceType: "R3",
      vatRecoveryReview: {
        legalBasis: "LIVA_80_4", originalTaxAmount: "21.00",
        recoveredTaxAmount: "21.00", customerDeliveryStatus: "NOT_RECORDED",
        baseModificationCommunicationStatus: "NOT_RECORDED",
      },
    });
    const recoveredOriginal = await authed(accountA.accessToken, tenantA)
      .get(`/v1/invoices/${vatOnlyOriginal.body.id}`)
      .expect(200);
    expect(recoveredOriginal.body).toMatchObject({
      total: "121", amountPaid: "0", creditedAmount: "21", amountDue: "100",
    });
    expect(recoveredOriginal.body.installments[0].creditedAmount).toBe("21");
    const recoveryLedger = await authed(accountA.accessToken, tenantA)
      .get(`/v1/tax-ledger?invoiceId=${vatOnlyDraft.body.id}`)
      .expect(200);
    expect(recoveryLedger.body.data[0].amounts[0]).toMatchObject({
      taxableBase: "0", taxAmount: "-21",
    });
    const recoveryEntries = await authed(accountA.accessToken, tenantA)
      .get(`/v1/accounting/journal-entries?sourceType=SALES_INVOICE&sourceId=${vatOnlyDraft.body.id}`)
      .expect(200);
    expect(accountingAmounts(recoveryEntries.body.data[0])).toEqual({
      "430000": { debit: "0", credit: "21" },
      "477000": { debit: "21", credit: "0" },
    });
    const recoveryRecords = await authed(accountA.accessToken, tenantA)
      .get(`/v1/sif/records?invoiceId=${vatOnlyDraft.body.id}`)
      .expect(200);
    expect(recoveryRecords.body).toHaveLength(1);
    const recoveryXmlResponse = await authed(accountA.accessToken, tenantA)
      .get(`/v1/sif/records/${recoveryRecords.body[0].id}/xml`)
      .expect("content-type", /application\/xml/)
      .expect(200);
    const recoveryXml = recoveryXmlResponse.text ?? recoveryXmlResponse.body.toString("utf8");
    expect(recoveryXml).toContain("<sf:TipoFactura>R3</sf:TipoFactura>");
    expect(recoveryXml).toContain("<sf:TipoRectificativa>I</sf:TipoRectificativa>");
    expect(recoveryXml).toContain("<sf:BaseImponibleOimporteNoSujeto>0.00</sf:BaseImponibleOimporteNoSujeto>");
    expect(recoveryXml).toContain("<sf:CuotaRepercutida>-21.00</sf:CuotaRepercutida>");
    expect(recoveryXml).toContain("<sf:ImporteTotal>-21.00</sf:ImporteTotal>");
    const recoverySchemaCheck = spawnSync("xmllint", [
      "--noout", "--schema", join(__dirname, "../src/sif/xsd/SuministroLR.xsd"), "-",
    ], { input: recoveryXml, encoding: "utf8" });
    expect(recoverySchemaCheck.status).toBe(0);
    await authed(accountA.accessToken, tenantA)
      .get(`/v1/invoices/${vatOnlyDraft.body.id}/pdf`)
      .expect("content-type", /application\/pdf/)
      .expect(200);

    const r2Original = await authed(accountA.accessToken, tenantA)
      .post("/v1/invoices")
      .send(invoice(r4Customer.body.id))
      .expect(201);
    await authed(accountA.accessToken, tenantA)
      .post(`/v1/invoices/${r2Original.body.id}/issue`)
      .set("idempotency-key", "issue-r2-original-a")
      .send({ sequenceId: sequence.body.id })
      .expect(200);
    const r2Draft = await authed(accountA.accessToken, tenantA)
      .post(`/v1/invoices/${r2Original.body.id}/rectifications`)
      .send({ ...vatOnlyInput, sifInvoiceType: "R2" })
      .expect(201);
    await authed(accountA.accessToken, tenantA)
      .post(`/v1/invoices/${r2Draft.body.id}/issue`)
      .set("idempotency-key", "issue-r2-vat-only-a")
      .send({ sequenceId: creditSequence.body.id, vatRecoveryReview: {
        fiscalReviewConfirmed: true,
        exclusionsReviewed: true,
        legalEventDate: "2026-09-10",
        legalEventReference: "Published insolvency order R2-2026-01",
      } })
      .expect(200);
    const r2Records = await authed(accountA.accessToken, tenantA)
      .get(`/v1/sif/records?invoiceId=${r2Draft.body.id}`)
      .expect(200);
    const r2XmlResponse = await authed(accountA.accessToken, tenantA)
      .get(`/v1/sif/records/${r2Records.body[0].id}/xml`)
      .expect(200);
    const r2Xml = r2XmlResponse.text ?? r2XmlResponse.body.toString("utf8");
    expect(r2Xml).toContain("<sf:TipoFactura>R2</sf:TipoFactura>");
    expect(r2Xml).toContain("<sf:CuotaRepercutida>-21.00</sf:CuotaRepercutida>");

    const paymentBeforeReviewOriginal = await authed(accountA.accessToken, tenantA)
      .post("/v1/invoices")
      .send(invoice(r4Customer.body.id))
      .expect(201);
    await authed(accountA.accessToken, tenantA)
      .post(`/v1/invoices/${paymentBeforeReviewOriginal.body.id}/issue`)
      .set("idempotency-key", "issue-r3-paid-original-a")
      .send({ sequenceId: sequence.body.id })
      .expect(200);
    const paymentBeforeReviewDraft = await authed(accountA.accessToken, tenantA)
      .post(`/v1/invoices/${paymentBeforeReviewOriginal.body.id}/rectifications`)
      .send(vatOnlyInput)
      .expect(201);
    await authed(accountA.accessToken, tenantA)
      .post(`/v1/invoices/${paymentBeforeReviewOriginal.body.id}/payments`)
      .set("idempotency-key", "r3-paid-before-issue-a")
      .send({ amount: 10, paidAt: "2026-09-16T10:00:00.000Z", method: "BANK_TRANSFER" })
      .expect(201);
    const staleRecoveryIssue = await authed(accountA.accessToken, tenantA)
      .post(`/v1/invoices/${paymentBeforeReviewDraft.body.id}/issue`)
      .set("idempotency-key", "issue-r3-after-payment-a")
      .send({ sequenceId: creditSequence.body.id, vatRecoveryReview: {
        fiscalReviewConfirmed: true,
        exclusionsReviewed: true,
        legalEventDate: "2026-09-10",
        legalEventReference: "Fiscal review file R3-2026-02",
        claimEvidenceReference: "Certified payment demand R3-2026-02",
      } })
      .expect(409);
    expect(JSON.stringify(staleRecoveryIssue.body)).toContain("does not yet support paid or partially paid invoices");

    const erroneousDraft = await authed(accountA.accessToken, tenantA)
      .post("/v1/invoices")
      .send(invoice(contactA.body.id))
      .expect(201);
    const erroneousIssued = await authed(accountA.accessToken, tenantA)
      .post(`/v1/invoices/${erroneousDraft.body.id}/issue`)
      .set("idempotency-key", "issue-erroneous-a")
      .send({ sequenceId: sequence.body.id })
      .expect(200);
    const originalTaxPosting = await authed(accountA.accessToken, tenantA)
      .get(`/v1/tax-ledger?invoiceId=${erroneousDraft.body.id}`)
      .expect(200);
    expect(originalTaxPosting.body.data).toHaveLength(1);
    const originalJournalPosting = await authed(accountA.accessToken, tenantA)
      .get(
        `/v1/accounting/journal-entries?sourceType=SALES_INVOICE&sourceId=${erroneousDraft.body.id}`,
      )
      .expect(200);
    expect(originalJournalPosting.body.data).toHaveLength(1);
    const existingSifCancellation = await authed(accountA.accessToken, tenantA)
      .post(`/v1/sif/records/${erroneousDraft.body.id}/cancellation`)
      .expect(200);
    const pendingErroneousEmail = await authed(accountA.accessToken, tenantA)
      .post(`/v1/invoices/${erroneousDraft.body.id}/email`)
      .set("idempotency-key", "email-erroneous-a")
      .send({})
      .expect(202);
    expect(pendingErroneousEmail.body.status).toBe("PENDING");
    await authed(accountB.accessToken, tenantB)
      .post(`/v1/invoices/${erroneousDraft.body.id}/cancel-issued-in-error`)
      .send({
        reason: "The underlying operation never existed",
        operationDidNotExist: true,
      })
      .expect(404);
    await authed(accountA.accessToken, tenantA)
      .post(`/v1/invoices/${erroneousDraft.body.id}/cancel-issued-in-error`)
      .send({ reason: "Too short", operationDidNotExist: true })
      .expect(400);
    const cancelled = await authed(accountA.accessToken, tenantA)
      .post(`/v1/invoices/${erroneousDraft.body.id}/cancel-issued-in-error`)
      .send({
        reason: "The underlying operation never existed",
        operationDidNotExist: true,
      })
      .expect(200);
    expect(cancelled.body).toMatchObject({
      status: "CANCELLED",
      amountDue: "0",
      amountPaid: "0",
      fullNumber: erroneousIssued.body.fullNumber,
      cancellationReason: "The underlying operation never existed",
    });
    expect(cancelled.body.cancelledAt).toBeTruthy();
    await expect(admin.invoice.update({
      where: { id: erroneousDraft.body.id },
      data: { cancellationReason: "Changed after cancellation" },
    })).rejects.toThrow(/cancellation metadata requires a one-way invoice cancellation/);
    const cancellationRetry = await authed(accountA.accessToken, tenantA)
      .post(`/v1/invoices/${erroneousDraft.body.id}/cancel-issued-in-error`)
      .send({
        reason: "The underlying operation never existed",
        operationDidNotExist: true,
      })
      .expect(200);
    expect(cancellationRetry.body.status).toBe("CANCELLED");
    const cancelledDeliveries = await authed(accountA.accessToken, tenantA)
      .get(`/v1/invoices/${erroneousDraft.body.id}/email-deliveries`)
      .expect(200);
    expect(cancelledDeliveries.body[0]).toMatchObject({
      id: pendingErroneousEmail.body.id,
      status: "FAILED",
      lastError: "Invoice cancelled before delivery",
    });
    await authed(accountA.accessToken, tenantA)
      .post(`/v1/invoices/${erroneousDraft.body.id}/email`)
      .set("idempotency-key", "email-erroneous-after-cancellation-a")
      .send({})
      .expect(409);
    const finalSifRecords = await authed(accountA.accessToken, tenantA)
      .get(`/v1/sif/records?invoiceId=${erroneousDraft.body.id}`)
      .expect(200);
    expect(finalSifRecords.body).toHaveLength(2);
    expect(finalSifRecords.body[1].id).toBe(existingSifCancellation.body.id);
    const finalTaxPostings = await authed(accountA.accessToken, tenantA)
      .get(`/v1/tax-ledger?invoiceId=${erroneousDraft.body.id}`)
      .expect(200);
    expect(finalTaxPostings.body.data).toHaveLength(2);
    const taxCancellation = finalTaxPostings.body.data.find(
      ({ cancellationOfId }: { cancellationOfId: string | null }) =>
        !!cancellationOfId,
    );
    expect(taxCancellation).toMatchObject({
      cancellationOfId: originalTaxPosting.body.data[0].id,
      documentNumber: erroneousIssued.body.fullNumber,
    });
    expect(taxCancellation.amounts[0]).toMatchObject({
      taxableBase: "-100",
      taxAmount: "-21",
    });
    const journalReversals = await authed(accountA.accessToken, tenantA)
      .get(
        `/v1/accounting/journal-entries?sourceType=INVOICE_CANCELLATION&sourceId=${erroneousDraft.body.id}`,
      )
      .expect(200);
    expect(journalReversals.body.data).toHaveLength(1);
    expect(journalReversals.body.data[0].reversalOfId).toBe(
      originalJournalPosting.body.data[0].id,
    );
    expect(accountingAmounts(journalReversals.body.data[0])).toEqual({
      "430000": { debit: "0", credit: "121" },
      "477000": { debit: "21", credit: "0" },
      "701000": { debit: "100", credit: "0" },
    });
    await authed(accountA.accessToken, tenantA)
      .post(`/v1/invoices/${invoiceDraft.body.id}/cancel-issued-in-error`)
      .send({
        reason: "The underlying operation never existed",
        operationDidNotExist: true,
      })
      .expect(409);

    const refreshes = await Promise.all([
      request(app.getHttpServer())
        .post("/v1/identity/refresh")
        .send({ refreshToken: accountA.refreshToken }),
      request(app.getHttpServer())
        .post("/v1/identity/refresh")
        .send({ refreshToken: accountA.refreshToken }),
    ]);
    expect(refreshes.map(({ status }) => status).sort()).toEqual([200, 401]);
    const rotated = refreshes.find(({ status }) => status === 200)!.body;
    await request(app.getHttpServer())
      .post("/v1/identity/logout")
      .set("authorization", `Bearer ${rotated.accessToken}`)
      .expect(204);
    await authed(rotated.accessToken, tenantA).get("/v1/contacts").expect(401);

    await prisma.$transaction(async (db) => {
      await db.$queryRaw`SELECT set_config('app.organization_id', ${tenantA.organizationId}, true)`;
      expect(await db.contact.count({ where: { id: contactA.body.id } })).toBe(
        1,
      );
      expect(await db.contact.count({ where: { id: contactB.body.id } })).toBe(
        0,
      );
      expect(
        await db.auditEvent.count({ where: { entityId: contactA.body.id } }),
      ).toBeGreaterThan(0);
    });
  });

  it("keeps a professional invoice gross while retaining IRPF on partial supplier payments", async () => {
    const email = "withholding@example.com";
    const account = await app.get(IdentityService).register({
      email,
      password: "correct horse battery staple",
      organizationName: "Withholding Org",
      legalName: "Withholding SL",
      taxId: "B12345674",
    });
    const tenant = await tenantFor(email);
    const supplier = await authed(account.accessToken, tenant)
      .post("/v1/contacts")
      .send({ legalName: "Professional Supplier", taxId: "12345678Z", isCustomer: false, isSupplier: true })
      .expect(201);
    const rules = await authed(account.accessToken, tenant)
      .get("/v1/tax-rules?effectiveOn=2026-09-18")
      .expect(200);
    const general = rules.body.find(({ code }: { code: string }) => code === "ES_VAT_GENERAL_21");
    const sequence = await authed(account.accessToken, tenant)
      .post("/v1/document-sequences")
      .send({ documentType: "PURCHASE_INVOICE", series: "REC2026", padding: 5 })
      .expect(201);
    const draft = await authed(account.accessToken, tenant)
      .post("/v1/purchase-invoices")
      .send({
        supplierId: supplier.body.id, supplierInvoiceNumber: "PRO-2026-001",
        issueDate: "2026-09-18", receivedDate: "2026-09-18", currency: "EUR",
        withholdingRate: 15,
        lines: [{ description: "Professional service", quantity: 1, unitPrice: 200,
          taxRuleId: general.id, taxRate: 21, deductiblePct: 100 }],
      })
      .expect(201);
    expect(draft.body).toMatchObject({ total: "242", taxTotal: "42", withholdingAmount: "30" });
    const approved = await authed(account.accessToken, tenant)
      .post(`/v1/purchase-invoices/${draft.body.id}/approve`)
      .set("idempotency-key", "withheld-approval")
      .send({ sequenceId: sequence.body.id })
      .expect(200);
    expect(approved.body).toMatchObject({ amountDue: "212", total: "242" });
    expect(approved.body.installments[0].amount).toBe("212");
    const purchaseEntries = await authed(account.accessToken, tenant)
      .get("/v1/accounting/journal-entries?sourceType=PURCHASE_INVOICE")
      .expect(200);
    expect(accountingAmounts(purchaseEntries.body.data[0])).toEqual({
      "400000": { debit: "0", credit: "242" },
      "472000": { debit: "42", credit: "0" },
      "600000": { debit: "200", credit: "0" },
    });
    for (const [index, amount] of [100, 112].entries()) {
      await authed(account.accessToken, tenant)
        .post(`/v1/purchase-invoices/${draft.body.id}/payments`)
        .set("idempotency-key", `withheld-payment-${index}`)
        .send({ amount, paidAt: index === 0 ? "2026-09-30T12:00:00.000Z" : "2026-10-01T12:00:00.000Z", method: "BANK_TRANSFER" })
        .expect(201);
    }
    const payments = await authed(account.accessToken, tenant)
      .get(`/v1/purchase-invoices/${draft.body.id}/payments`)
      .expect(200);
    expect(payments.body.reduce((sum: number, item: { withholdingAmount: string }) => sum + Number(item.withholdingAmount), 0)).toBe(30);
    const report = await authed(account.accessToken, tenant)
      .get("/v1/purchase-invoices/withholdings?year=2026")
      .expect(200);
    expect(report.body.quarters[2].withheld).toBe("14.15");
    expect(report.body.quarters[3].withheld).toBe("15.85");
    expect(report.body.annualBySupplier[0]).toMatchObject({ base: "200.00", withheld: "30.00" });
    const paymentEntries = await authed(account.accessToken, tenant)
      .get("/v1/accounting/journal-entries?sourceType=SUPPLIER_PAYMENT")
      .expect(200);
    expect(paymentEntries.body.data).toHaveLength(2);
    const posted = paymentEntries.body.data.map(accountingAmounts);
    expect(posted.reduce((sum: number, entry: Record<string, { credit: string }>) => sum + Number(entry["475100"].credit), 0)).toBe(30);
    const paid = await authed(account.accessToken, tenant).get(`/v1/purchase-invoices/${draft.body.id}`).expect(200);
    expect(paid.body).toMatchObject({ total: "242", amountPaid: "212", amountDue: "0" });
  });

  async function register(
    email: string,
    organizationName: string,
    legalName: string,
    taxId: string,
  ) {
    const response = await request(app.getHttpServer())
      .post("/v1/identity/register")
      .send({
        email,
        password: "correct horse battery staple",
        organizationName,
        legalName,
        taxId,
      })
      .expect(201);
    return response.body as { accessToken: string; refreshToken: string };
  }
  async function tenantFor(email: string) {
    const membership = await prisma.membership.findFirstOrThrow({
      where: { user: { email } },
    });
    return {
      organizationId: membership.organizationId,
      companyId: membership.companyId!,
      userId: membership.userId,
    };
  }
  function authed(
    token: string,
    tenant: { organizationId: string; companyId: string },
  ) {
    const apply = <T extends SupertestTest>(call: T) =>
      call
        .set("authorization", `Bearer ${token}`)
        .set("x-organization-id", tenant.organizationId)
        .set("x-company-id", tenant.companyId);
    return {
      get: (path: string) => apply(request(app.getHttpServer()).get(path)),
      post: (path: string) => apply(request(app.getHttpServer()).post(path)),
      put: (path: string) => apply(request(app.getHttpServer()).put(path)),
      patch: (path: string) => apply(request(app.getHttpServer()).patch(path)),
      delete: (path: string) =>
        apply(request(app.getHttpServer()).delete(path)),
    };
  }
  function hashRecoveryToken(token: string) {
    return createHash("sha256").update(token).digest("hex");
  }
  function pngLogo(width: number, height: number) {
    const content = Buffer.alloc(24);
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]).copy(content, 0);
    content.writeUInt32BE(13, 8);
    content.write("IHDR", 12, "ascii");
    content.writeUInt32BE(width, 16);
    content.writeUInt32BE(height, 20);
    return content;
  }
  function quote(
    contactId: string,
    sequenceId: string,
    catalogItemId?: string,
  ) {
    return {
      contactId,
      sequenceId,
      issueDate: "2026-09-08",
      validUntil: "2026-10-08",
      currency: "EUR",
      lines: [
        {
          ...(catalogItemId ? { catalogItemId } : {}),
          description: "Consulting",
          quantity: 1,
          unitPrice: 100,
          taxRate: 21,
        },
      ],
    };
  }

  function accountingAmounts(entry: {
    lines: Array<{
      account: { code: string };
      debit: string;
      credit: string;
    }>;
  }) {
    return Object.fromEntries(
      entry.lines.map((line) => [
        line.account.code,
        { debit: line.debit, credit: line.credit },
      ]),
    );
  }
  function invoice(contactId: string) {
    return {
      contactId,
      issueDate: "2026-09-08",
      dueDate: "2026-10-08",
      currency: "EUR",
      lines: [
        {
          description: "Consulting",
          quantity: 1,
          unitPrice: 100,
          taxRate: 21,
        },
      ],
    };
  }
});
