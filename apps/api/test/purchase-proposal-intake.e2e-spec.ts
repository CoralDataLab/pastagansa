import { INestApplication, ValidationPipe } from "@nestjs/common";
import { Test } from "@nestjs/testing";
import { ConfigService } from "@nestjs/config";
import { PrismaClient } from "@prisma/client";
import { createHash, randomUUID } from "node:crypto";
import { crc32, deflateSync } from "node:zlib";
import request = require("supertest");
import {
  ocrPreviewKey,
  signOcrPreview,
} from "../src/purchases/purchase-ocr-preview-signature";

type Scope = { organizationId: string; companyId: string; userId: string };

// Requires a disposable PostgreSQL database with all migrations applied and an
// app-role DATABASE_URL (RLS must not be bypassed). Never run against production.
const hasIntegrationDatabase = Boolean(
  process.env.DATABASE_URL && process.env.DIRECT_DATABASE_URL,
);
const describeIntegration = hasIntegrationDatabase ? describe : describe.skip;

// Blank grayscale PNG large enough for Tesseract to decode (a 1x1 image is rejected).
function blankPng(width: number, height: number) {
  const chunk = (type: string, data: Buffer) => {
    const body = Buffer.concat([Buffer.from(type, "ascii"), data]);
    const length = Buffer.alloc(4); length.writeUInt32BE(data.length);
    const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(body));
    return Buffer.concat([length, body, crc]);
  };
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width, 0); header.writeUInt32BE(height, 4);
  header[8] = 8; header[9] = 0;
  const row = Buffer.concat([Buffer.from([0]), Buffer.alloc(width, 255)]);
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", header),
    chunk("IDAT", deflateSync(Buffer.concat(Array.from({ length: height }, () => row)))),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}
const image = blankPng(200, 80);
const unreadableImage = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aEXcAAAAASUVORK5CYII=",
  "base64",
);
const imageSha256 = createHash("sha256").update(image).digest("hex");

describeIntegration("purchase proposal OCR intake (PostgreSQL)", () => {
  let app: INestApplication;
  let scope: Scope;
  let token: string;
  let supplierId: string;
  const admin = new PrismaClient({
    datasources: {
      db: {
        url:
          process.env.DIRECT_DATABASE_URL ??
          "postgresql://skip:skip@localhost:5432/skip",
      },
    },
  });
  const previousEnabled = process.env.AI_NATIVE_ENABLED;
  const prefix = randomUUID();

  beforeAll(async () => {
    process.env.AI_NATIVE_ENABLED = "true";
    const { AppModule } = await import("../src/app.module");
    const module = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();
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
    const email = `intake-${prefix}@example.com`;
    const registered = await request(app.getHttpServer())
      .post("/v1/identity/register")
      .send({
        email,
        password: "correct horse battery staple",
        organizationName: "Intake Pilot",
        legalName: "Intake Company",
        taxId: "B12345674",
      })
      .expect(201);
    token = registered.body.accessToken;
    const membership = await admin.membership.findFirstOrThrow({
      where: { user: { email } },
    });
    scope = {
      organizationId: membership.organizationId,
      companyId: membership.companyId!,
      userId: membership.userId,
    };
    const supplier = await call("/v1/contacts")
      .send({ legalName: "Supplier", isSupplier: true, isCustomer: false })
      .expect(201);
    supplierId = supplier.body.id;
  }, 60_000);

  afterAll(async () => {
    if (previousEnabled === undefined) delete process.env.AI_NATIVE_ENABLED;
    else process.env.AI_NATIVE_ENABLED = previousEnabled;
    if (app) await app.close();
    await admin.$disconnect();
  });

  function call(path: string) {
    return request(app.getHttpServer())
      .post(path)
      .set("authorization", `Bearer ${token}`)
      .set("x-organization-id", scope.organizationId)
      .set("x-company-id", scope.companyId);
  }
  function proposalInput(commandId = randomUUID()) {
    return {
      commandId,
      payload: {
        supplierId,
        supplierInvoiceNumber: randomUUID(),
        issueDate: "2026-10-01",
        receivedDate: "2026-10-02",
        lines: [
          { description: "Service", quantity: 1, unitPrice: 100, taxRate: 21, deductiblePct: 100 },
        ],
      },
      evidence: [],
      provenance: { channel: "UPLOAD", agentId: "tesseract-spa-local", agentVersion: "1" },
    };
  }
  function fromDocument(input: object, ocrPreview?: object) {
    const pending = call("/v1/purchase-command-proposals/from-document")
      .attach("file", image, { filename: "invoice.png", contentType: "image/png" })
      .field("proposal", JSON.stringify(input));
    return ocrPreview ? pending.field("ocrPreview", JSON.stringify(ocrPreview)) : pending;
  }
  function signedPreview(rawText: string) {
    const key = ocrPreviewKey(app.get(ConfigService).get<string>("JWT_SECRET")!);
    const content = {
      sha256: imageSha256,
      engine: "tesseract-spa-local",
      engineVersion: "1",
      confidence: 80,
      rawText,
      fields: {},
      issuedAt: new Date().toISOString(),
    };
    return { ...content, signature: signOcrPreview(key, scope, content) };
  }
  async function tenantCounts() {
    const where = { companyId: scope.companyId };
    const [proposals, documents, extractions, events, audits] = await Promise.all([
      admin.commandProposal.count({ where }),
      admin.purchaseProposalDocument.count({ where }),
      admin.purchaseProposalOcrExtraction.count({ where }),
      admin.commandProposalEvent.count({ where }),
      admin.auditEvent.count({ where }),
    ]);
    return { proposals, documents, extractions, events, audits };
  }

  it("stores the server-signed OCR preview with its document and event", async () => {
    const preview = await call("/v1/purchase-command-proposals/ocr-preview")
      .attach("file", image, { filename: "invoice.png", contentType: "image/png" })
      .expect(201);
    expect(preview.body.signature).toMatch(/^[0-9a-f]{64}$/);

    const created = await fromDocument(proposalInput(), preview.body).expect(201);
    expect(created.body.documents).toHaveLength(1);
    expect(created.body.ocrExtractions).toEqual([
      expect.objectContaining({
        documentId: created.body.documents[0].id,
        documentSha256: imageSha256,
        engine: "tesseract-spa-local",
        rawText: preview.body.rawText,
      }),
    ]);
    const events = await admin.commandProposalEvent.findMany({
      where: { proposalId: created.body.id },
      orderBy: { sequence: "asc" },
      select: { type: true },
    });
    expect(events.map((event) => event.type)).toEqual([
      "command_proposal.created",
      "command_proposal.document_uploaded",
      "command_proposal.ocr_extraction_stored",
    ]);
  }, 150_000);

  it("reports an image Tesseract cannot decode as a client error", async () => {
    await call("/v1/purchase-command-proposals/ocr-preview")
      .attach("file", unreadableImage, { filename: "tiny.png", contentType: "image/png" })
      .expect(400);
  }, 150_000);

  it("rejects a tampered preview without leaving any trace", async () => {
    const before = await tenantCounts();
    const preview = signedPreview("FACTURA F-1");
    await fromDocument(proposalInput(), { ...preview, rawText: "FACTURA F-999" }).expect(400);
    expect(await tenantCounts()).toEqual(before);
  });

  it("rolls back proposal, document, events and audit when the extraction cannot be stored", async () => {
    const marker = `rollback-${prefix}`;
    const fn = `test_fail_ocr_${prefix.replace(/-/g, "")}`;
    // Fault injection at the last write of the request; everything before it shares the transaction.
    await admin.$executeRawUnsafe(`
      CREATE FUNCTION ${fn}() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN
        IF NEW.raw_text = '${marker}' THEN RAISE EXCEPTION 'injected OCR extraction failure'; END IF;
        RETURN NEW;
      END;
      $$`);
    await admin.$executeRawUnsafe(
      `CREATE TRIGGER ${fn} BEFORE INSERT ON "purchase_proposal_ocr_extractions" FOR EACH ROW EXECUTE FUNCTION ${fn}()`,
    );
    try {
      const before = await tenantCounts();
      const commandId = randomUUID();
      const response = await fromDocument(proposalInput(commandId), signedPreview(marker));
      expect(response.status).toBeGreaterThanOrEqual(500);
      expect(await tenantCounts()).toEqual(before);
      expect(await admin.commandProposal.count({ where: { commandId } })).toBe(0);
    } finally {
      await admin.$executeRawUnsafe(`DROP TRIGGER ${fn} ON "purchase_proposal_ocr_extractions"`);
      await admin.$executeRawUnsafe(`DROP FUNCTION ${fn}()`);
    }
  });
});
