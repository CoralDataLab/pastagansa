import { INestApplication, ValidationPipe } from "@nestjs/common";
import { Test } from "@nestjs/testing";
import { ConfigService } from "@nestjs/config";
import { PrismaClient } from "@prisma/client";
import { randomUUID } from "node:crypto";
import request = require("supertest");
import { RegisterPurchaseCommandService } from "../src/purchases/register-purchase-command.service";
import { AuditService } from "../src/audit/audit.service";

type Scope = { organizationId: string; companyId: string; userId: string };

// Requires a disposable PostgreSQL database with all migrations applied and an
// app-role DATABASE_URL (RLS must not be bypassed). Never run against production.
const hasIntegrationDatabase = Boolean(
  process.env.DATABASE_URL && process.env.DIRECT_DATABASE_URL,
);
const describeIntegration = hasIntegrationDatabase ? describe : describe.skip;

describeIntegration("command foundation (PostgreSQL)", () => {
  let app: INestApplication;
  let scope: Scope;
  let secondScope: Scope;
  let foreignScope: Scope;
  let ownerToken: string;
  let agentToken: string;
  let supplierId: string;
  const prisma = new PrismaClient();
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
    const owner = await register(`owner-${prefix}@example.com`);
    ownerToken = owner.token;
    scope = owner.scope;
    const agent = await register(`agent-${prefix}@example.com`);
    agentToken = agent.token;
    foreignScope = agent.scope;
    const role = await admin.role.create({
      data: {
        code: `proposal-agent-${prefix}`,
        name: "Proposal-only integration actor",
      },
    });
    const permissions = await admin.permission.findMany({
      where: {
        code: { in: ["command_proposal.create", "command_proposal.read"] },
      },
    });
    await admin.rolePermission.createMany({
      data: permissions.map((permission) => ({
        roleId: role.id,
        permissionId: permission.id,
      })),
    });
    await admin.membership.create({
      data: {
        organizationId: scope.organizationId,
        companyId: scope.companyId,
        userId: agent.scope.userId,
        roleId: role.id,
      },
    });
    const company = await admin.company.create({
      data: {
        organizationId: scope.organizationId,
        legalName: "Second Company",
        taxId: "B87654321",
      },
    });
    const ownerMembership = await admin.membership.findFirstOrThrow({
      where: { userId: scope.userId, companyId: scope.companyId },
    });
    await admin.membership.create({
      data: {
        organizationId: scope.organizationId,
        companyId: company.id,
        userId: scope.userId,
        roleId: ownerMembership.roleId,
      },
    });
    secondScope = { ...scope, companyId: company.id };
    const supplier = await call("post", "/v1/contacts")
      .send({ legalName: "Supplier", isSupplier: true, isCustomer: false })
      .expect(201);
    supplierId = supplier.body.id;
  });

  afterAll(async () => {
    if (previousEnabled === undefined) delete process.env.AI_NATIVE_ENABLED;
    else process.env.AI_NATIVE_ENABLED = previousEnabled;
    if (app) await app.close();
    await prisma.$disconnect();
    await admin.$disconnect();
  });

  function payload(number = randomUUID()) {
    return {
      supplierId,
      supplierInvoiceNumber: number,
      issueDate: "2026-09-01",
      receivedDate: "2026-09-02",
      currency: "EUR",
      lines: [
        {
          description: "Consulting",
          quantity: 1,
          unitPrice: 100,
          taxRate: 21,
          deductiblePct: 100,
        },
      ],
    };
  }
  function proposalInput(data = payload()) {
    return {
      commandId: randomUUID(),
      payload: data,
      evidence: [
        { reference: "document:external-reference", sha256: "a".repeat(64) },
      ],
      provenance: {
        channel: "UPLOAD",
        agentId: "test-agent",
        agentVersion: "1",
      },
    };
  }
  function call(
    method: "get" | "post",
    path: string,
    token = ownerToken,
    tenant = scope,
  ) {
    return request(app.getHttpServer())
      [method](path)
      .set("authorization", `Bearer ${token}`)
      .set("x-organization-id", tenant.organizationId)
      .set("x-company-id", tenant.companyId);
  }
  async function register(email: string) {
    const response = await request(app.getHttpServer())
      .post("/v1/identity/register")
      .send({
        email,
        password: "correct horse battery staple",
        organizationName: "Command Pilot",
        legalName: "Pilot Company",
        taxId: "B12345674",
      })
      .expect(201);
    const membership = await admin.membership.findFirstOrThrow({
      where: { user: { email } },
    });
    return {
      token: response.body.accessToken as string,
      scope: {
        organizationId: membership.organizationId,
        companyId: membership.companyId!,
        userId: membership.userId,
      },
    };
  }

  it("lets a proposal-only actor propose, but not create, execute or reject a purchase", async () => {
    const input = proposalInput();
    const proposed = await call(
      "post",
      "/v1/purchase-command-proposals",
      agentToken,
    )
      .send(input)
      .expect(201);
    expect(proposed.body.status).toBe("PENDING_REVIEW");
    expect(
      await admin.purchaseInvoice.count({
        where: {
          companyId: scope.companyId,
          supplierInvoiceNumber: input.payload.supplierInvoiceNumber,
        },
      }),
    ).toBe(0);
    await call("post", "/v1/purchase-invoices", agentToken)
      .send(input.payload)
      .expect(403);
    await call(
      "post",
      `/v1/purchase-command-proposals/${proposed.body.id}/execute`,
      agentToken,
    )
      .send({ reason: "Reviewed" })
      .expect(403);
    await call(
      "post",
      `/v1/purchase-command-proposals/${proposed.body.id}/reject`,
      agentToken,
    )
      .send({ reason: "Reviewed" })
      .expect(403);
    const retry = await call(
      "post",
      "/v1/purchase-command-proposals",
      agentToken,
    )
      .send(input)
      .expect(201);
    expect(retry.body.id).toBe(proposed.body.id);
    await call("post", "/v1/purchase-command-proposals", agentToken)
      .send({ ...input, payload: { ...input.payload, notes: "Changed" } })
      .expect(409);
  });

  it("executes a corrected review exactly once and preserves proposal, review and receipt", async () => {
    const input = proposalInput();
    const proposed = await call(
      "post",
      "/v1/purchase-command-proposals",
      agentToken,
    )
      .send(input)
      .expect(201);
    const review = {
      payload: { ...input.payload, notes: "Supplier document checked" },
      reason: "Corrected notes against original",
    };
    const results = await Promise.all(
      [1, 2].map(() =>
        call(
          "post",
          `/v1/purchase-command-proposals/${proposed.body.id}/execute`,
        )
          .send(review)
          .expect(200),
      ),
    );
    expect(results[0].body.executionId).toBe(results[1].body.executionId);
    expect(results[0].body.payload).toEqual(input.payload);
    expect(results[0].body.review.acceptedPayload.notes).toBe(
      review.payload.notes,
    );
    expect(results[0].body.review.reviewedById).toBe(scope.userId);
    const purchaseId = results[0].body.execution.result.id;
    expect(results[0].body.execution.result.status).toBe("DRAFT");
    expect(
      await admin.purchaseInvoice.count({
        where: {
          companyId: scope.companyId,
          supplierInvoiceNumber: input.payload.supplierInvoiceNumber,
        },
      }),
    ).toBe(1);
    expect(
      await admin.taxLedgerEntry.count({
        where: { purchaseInvoiceId: purchaseId },
      }),
    ).toBe(0);
    expect(
      await admin.journalEntry.count({ where: { sourceId: purchaseId } }),
    ).toBe(0);
    await call(
      "post",
      `/v1/purchase-command-proposals/${proposed.body.id}/execute`,
    )
      .send({ ...review, reason: "Different decision" })
      .expect(409);
    await expect(
      admin.commandReview.update({
        where: { id: results[0].body.review.id },
        data: { reason: "Overwrite" },
      }),
    ).rejects.toThrow();
    await expect(
      admin.commandExecution.delete({
        where: { id: results[0].body.executionId },
      }),
    ).rejects.toThrow();
    await expect(
      admin.commandProposal.update({
        where: { id: proposed.body.id },
        data: { payload: {} },
      }),
    ).rejects.toThrow();
  });

  it("rejects proposals without creating a purchase", async () => {
    const input = proposalInput();
    const proposed = await call(
      "post",
      "/v1/purchase-command-proposals",
      agentToken,
    )
      .send(input)
      .expect(201);
    const rejected = await call(
      "post",
      `/v1/purchase-command-proposals/${proposed.body.id}/reject`,
    )
      .send({ reason: "Duplicate source document" })
      .expect(200);
    expect(rejected.body).toMatchObject({
      status: "REJECTED",
      executionId: null,
      review: { decision: "REJECT" },
    });
    await call(
      "post",
      `/v1/purchase-command-proposals/${proposed.body.id}/reject`,
    )
      .send({ reason: "Duplicate source document" })
      .expect(200);
    await call(
      "post",
      `/v1/purchase-command-proposals/${proposed.body.id}/execute`,
    )
      .send({ reason: "Reviewed" })
      .expect(409);
    expect(
      await admin.purchaseInvoice.count({
        where: {
          companyId: scope.companyId,
          supplierInvoiceNumber: input.payload.supplierInvoiceNumber,
        },
      }),
    ).toBe(0);
  });

  it("rolls back execution, leaving a reviewable proposal when business rules fail", async () => {
    const supplier = await call(
      "post",
      "/v1/contacts",
      agentToken,
      foreignScope,
    )
      .send({
        legalName: "Foreign Supplier",
        isSupplier: true,
        isCustomer: false,
      })
      .expect(201);
    const input = proposalInput({ ...payload(), supplierId: supplier.body.id });
    const proposed = await call(
      "post",
      "/v1/purchase-command-proposals",
      agentToken,
    )
      .send(input)
      .expect(201);
    await call(
      "post",
      `/v1/purchase-command-proposals/${proposed.body.id}/execute`,
    )
      .send({ reason: "Reviewed" })
      .expect(400);
    const pending = await call(
      "get",
      `/v1/purchase-command-proposals/${proposed.body.id}`,
    ).expect(200);
    expect(pending.body).toMatchObject({
      status: "PENDING_REVIEW",
      review: null,
      executionId: null,
    });
    expect(
      await admin.commandExecution.count({
        where: {
          companyId: scope.companyId,
          commandId: `proposal:${proposed.body.id}:execute`,
        },
      }),
    ).toBe(0);
    await call(
      "post",
      `/v1/purchase-command-proposals/${proposed.body.id}/execute`,
    )
      .send({
        payload: { ...input.payload, supplierId },
        reason: "Corrected supplier",
      })
      .expect(200);
  });

  it("rolls back domain data, receipt and review together if a late step fails", async () => {
    const input = proposalInput();
    const proposed = await call("post", "/v1/purchase-command-proposals")
      .send(input)
      .expect(201);
    const audit = app.get(AuditService);
    const record = audit.record.bind(audit);
    const spy = jest.spyOn(audit, "record").mockImplementation((...args) => {
      if (args[0] === "command_proposal.executed")
        throw new Error("Simulated late persistence failure");
      return record(...args);
    });
    try {
      await call(
        "post",
        `/v1/purchase-command-proposals/${proposed.body.id}/execute`,
      )
        .send({ reason: "Reviewed" })
        .expect(500);
    } finally {
      spy.mockRestore();
    }
    expect(
      await admin.purchaseInvoice.count({
        where: {
          companyId: scope.companyId,
          supplierInvoiceNumber: input.payload.supplierInvoiceNumber,
        },
      }),
    ).toBe(0);
    expect(
      await admin.commandReview.count({
        where: { proposalId: proposed.body.id },
      }),
    ).toBe(0);
    expect(
      await admin.commandExecution.count({
        where: {
          companyId: scope.companyId,
          commandId: `proposal:${proposed.body.id}:execute`,
        },
      }),
    ).toBe(0);
    const pending = await call(
      "get",
      `/v1/purchase-command-proposals/${proposed.body.id}`,
    ).expect(200);
    expect(pending.body.status).toBe("PENDING_REVIEW");
  });

  it("isolates proposals between companies of the same organization, including RLS", async () => {
    const proposed = await call("post", "/v1/purchase-command-proposals")
      .send(proposalInput())
      .expect(201);
    await call(
      "get",
      `/v1/purchase-command-proposals/${proposed.body.id}`,
      ownerToken,
      secondScope,
    ).expect(404);
    await call(
      "post",
      `/v1/purchase-command-proposals/${proposed.body.id}/execute`,
      ownerToken,
      secondScope,
    )
      .send({ reason: "Reviewed" })
      .expect(404);
    await call(
      "get",
      `/v1/purchase-command-proposals/${proposed.body.id}`,
      agentToken,
      foreignScope,
    ).expect(404);
    await prisma.$transaction(async (db) => {
      await db.$queryRaw`SELECT set_config('app.organization_id', ${scope.organizationId}, true)`;
      await db.$queryRaw`SELECT set_config('app.company_id', ${secondScope.companyId}, true)`;
      expect(
        await db.commandProposal.findUnique({
          where: { id: proposed.body.id },
        }),
      ).toBeNull();
    });
  });

  it("advertises the API flag without enabling operations", async () => {
    const config = app.get(ConfigService);
    const enabled = config.get<string>("AI_NATIVE_ENABLED");
    const capability = await call(
      "get",
      "/v1/purchase-command-proposals/capabilities",
    ).expect(200);
    expect(capability.body).toEqual({ enabled: true });
    config.set("AI_NATIVE_ENABLED", "false");
    try {
      const disabled = await call(
        "get",
        "/v1/purchase-command-proposals/capabilities",
      ).expect(200);
      expect(disabled.body).toEqual({ enabled: false });
      await call("get", "/v1/purchase-command-proposals").expect(404);
      await call("post", "/v1/purchase-command-proposals")
        .send(proposalInput())
        .expect(404);
    } finally {
      config.set("AI_NATIVE_ENABLED", enabled);
    }
  });

  it("runs the same handler without HTTP and preserves direct API idempotency", async () => {
    const data = payload();
    const commandId = randomUUID();
    const result = await app
      .get(RegisterPurchaseCommandService)
      .execute({ ...scope, roleCodes: ["untrusted"] }, commandId, data);
    const retry = await call("post", "/v1/purchase-invoices")
      .set("idempotency-key", commandId)
      .send(data)
      .expect(201);
    expect(retry.body.id).toBe((result.execution.result as { id: string }).id);
    await call("post", "/v1/purchase-invoices")
      .set("idempotency-key", commandId)
      .send({ ...data, notes: "Changed" })
      .expect(409);
    await expect(
      app.get(RegisterPurchaseCommandService).execute(
        {
          ...scope,
          userId: foreignScope.userId,
          roleCodes: ["organization.owner"],
        },
        randomUUID(),
        payload(),
      ),
    ).rejects.toThrow("permission");
  });
});
