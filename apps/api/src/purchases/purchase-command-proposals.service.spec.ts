import { ConfigService } from "@nestjs/config";
import { AuditService } from "../audit/audit.service";
import { CommandAuthorizationService } from "../commands/command-authorization.service";
import { TenantContextService } from "../tenancy/tenant-context.service";
import { TenantTransactionService } from "../tenancy/tenant-transaction.service";
import { commandHash } from "../commands/command-json";
import { validateCommandInput } from "../commands/validate-command-input";
import { RegisterPurchaseCommandService } from "./register-purchase-command.service";
import { PurchaseCommandProposalsService } from "./purchase-command-proposals.service";
import { PurchaseCommandProposalEventsService } from "./purchase-command-proposal-events.service";
import { PurchaseProposalLearningService } from "./purchase-proposal-learning.service";
import { CreatePurchaseCommandProposalDto } from "./dto/purchase-command-proposal.dto";

const payload = {
  supplierId: "11111111-1111-4111-8111-111111111111",
  supplierInvoiceNumber: "INV-1",
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

function setup(enabled = true) {
  const original = {
    id: "proposal",
    commandId: "p1",
    name: "registrar_factura_recibida",
    version: 1,
    status: "PENDING_REVIEW",
    payload,
    evidence: [],
    provenance: { channel: "UPLOAD" },
    review: null,
    revisions: [],
    assignments: [],
  };
  const db = {
    $queryRaw: jest.fn().mockResolvedValue([{ id: "proposal" }]),
    commandProposal: {
      findFirst: jest.fn().mockResolvedValue(original),
      update: jest.fn().mockResolvedValue({ ...original, status: "EXECUTED" }),
    },
    commandReview: { create: jest.fn().mockResolvedValue({ id: "review" }) },
    commandProposalRevision: {
      create: jest.fn().mockResolvedValue({ id: "revision" }),
    },
    commandProposalAssignment: {
      create: jest.fn().mockResolvedValue({ id: "assignment" }),
    },
    commandProposalAttempt: {
      create: jest.fn().mockResolvedValue({ id: "attempt" }),
    },
    commandProposalEvent: {
      create: jest.fn().mockResolvedValue({ id: "event" }),
    },
    membership: {
      findFirst: jest.fn().mockResolvedValue({ id: "membership" }),
      findMany: jest.fn().mockResolvedValue([
        {
          user: { id: "reviewer", email: "reviewer@example.com" },
          role: { code: "organization.owner", name: "Owner" },
        },
      ]),
    },
  };
  const commands = {
    execute: jest.fn().mockResolvedValue({ execution: { id: "receipt" } }),
  };
  const tenant = {
    required: {
      organizationId: "org",
      companyId: "company",
      userId: "reviewer",
      roleCodes: [],
    },
    db,
  };
  const authorization = {
    require: jest.fn().mockResolvedValue(tenant.required),
  };
  const transactions = {
    run: jest.fn(async (_: unknown, work: () => Promise<unknown>) => work()),
  };
  const events = { record: jest.fn() };
  const learning = { recordFromRevision: jest.fn() };
  const audit = { record: jest.fn() };
  const config = { get: jest.fn().mockReturnValue(enabled ? "true" : "false") };
  const service = new PurchaseCommandProposalsService(
    tenant as unknown as TenantContextService,
    transactions as unknown as TenantTransactionService,
    authorization as unknown as CommandAuthorizationService,
    commands as unknown as RegisterPurchaseCommandService,
    events as unknown as PurchaseCommandProposalEventsService,
    learning as unknown as PurchaseProposalLearningService,
    audit as unknown as AuditService,
    config as unknown as ConfigService,
  );
  return { service, db, commands, original, authorization, transactions };
}

describe("supervised purchase proposals", () => {
  it("is disabled by default and does not query new tables", async () => {
    const { service, db, transactions } = setup(false);
    expect(() => service.get("proposal")).toThrow("disabled");
    expect(transactions.run).not.toHaveBeenCalled();
    expect(db.commandProposal.findFirst).not.toHaveBeenCalled();
  });

  it("preserves the original proposal and stores the corrected payload and reviewer separately", async () => {
    const { service, db, commands, original, authorization } = setup();
    await service.execute("proposal", {
      payload: { ...payload, notes: "Corrected" },
      reason: "Checked original invoice",
    });
    expect(original.payload).toEqual(payload);
    expect(db.commandProposal.update).toHaveBeenCalledWith({
      where: { id: "proposal" },
      data: { status: "EXECUTED", executionId: "receipt" },
    });
    expect(db.commandProposalRevision.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        previousPayload: payload,
        correctedPayload: expect.objectContaining({ notes: "Corrected" }),
        changes: [{ path: "notes", before: null, after: "Corrected" }],
        createdById: "reviewer",
      }),
    });
    expect(db.commandReview.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        acceptedPayload: expect.objectContaining({ notes: "Corrected" }),
        reviewedById: "reviewer",
        decision: "EXECUTE",
        reason: "Checked original invoice",
      }),
    });
    expect(commands.execute).toHaveBeenCalledTimes(1);
    expect(authorization.require).toHaveBeenCalledWith([
      "command_proposal.review",
      "purchase_invoice.create",
    ]);
  });

  it("leaves the proposal pending with no decision when business validation fails", async () => {
    const { service, db, commands } = setup();
    commands.execute.mockRejectedValueOnce(
      new Error("Supplier must be active"),
    );
    await expect(
      service.execute("proposal", { reason: "Reviewed" }),
    ).rejects.toThrow("Supplier");
    expect(db.commandReview.create).not.toHaveBeenCalled();
    expect(db.commandProposal.update).not.toHaveBeenCalled();
    expect(db.commandProposalAttempt.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        proposalId: "proposal",
        attemptedPayload: expect.objectContaining({ supplierInvoiceNumber: "INV-1" }),
        reason: "Reviewed",
        errorCode: "EXECUTION_ERROR",
        errorMessage: "Supplier must be active",
        attemptedById: "reviewer",
      }),
    });
  });

  it("contrasts the event projection with current proposal state", async () => {
    const { service, db, original } = setup();
    const payload = {
      commandId: "p1",
      name: "registrar_factura_recibida",
      version: 1,
      payloadHash: "hash",
    };
    const payloadHash = commandHash(payload);
    const eventHash = commandHash({
      proposalId: "proposal",
      sequence: 1,
      type: "command_proposal.created",
      payload,
      payloadHash,
      previousEventHash: null,
    });
    db.$queryRaw.mockResolvedValueOnce([
      {
        status: "PENDING_REVIEW",
        current_assignee_id: null,
        correction_count: 0,
        failed_attempt_count: 0,
        document_count: 0,
        execution_id: null,
        last_event_sequence: 1,
        last_event_hash: eventHash,
      },
    ]);
    db.commandProposal.findFirst.mockResolvedValueOnce({
      ...original,
      events: [
        {
          id: "event",
          proposalId: "proposal",
          sequence: 1,
          type: "command_proposal.created",
          payload,
          payloadHash,
          previousEventHash: null,
          eventHash,
          actorUserId: "reviewer",
          occurredAt: new Date(),
        },
      ],
      assignments: [],
      attempts: [],
      revisions: [],
      documents: [],
      executionId: null,
    });
    await expect(service.projection("proposal")).resolves.toMatchObject({
      chainValid: true,
      matchesCurrentState: true,
      eventCount: 1,
    });
  });

  it("lists active company members assignable by reviewers", async () => {
    const { service, db } = setup();
    await expect(service.assignees()).resolves.toEqual([
      {
        id: "reviewer",
        email: "reviewer@example.com",
        roleCode: "organization.owner",
        roleName: "Owner",
      },
    ]);
    expect(db.membership.findMany).toHaveBeenCalledWith({
      where: expect.objectContaining({ status: "ACTIVE" }),
      orderBy: [{ user: { email: "asc" } }],
      select: expect.any(Object),
    });
  });

  it("assigns a pending proposal to an active company member without executing it", async () => {
    const { service, db, commands } = setup();
    await service.assign("proposal", {
      assignedToId: "22222222-2222-4222-8222-222222222222",
      reason: "Needs AP review",
    });
    expect(commands.execute).not.toHaveBeenCalled();
    expect(db.membership.findFirst).toHaveBeenCalledWith({
      where: expect.objectContaining({
        userId: "22222222-2222-4222-8222-222222222222",
        status: "ACTIVE",
      }),
    });
    expect(db.commandProposalAssignment.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        assignedToId: "22222222-2222-4222-8222-222222222222",
        assignedById: "reviewer",
        reason: "Needs AP review",
      }),
    });
  });

  it("rejects assignment to users outside the active company membership", async () => {
    const { service, db } = setup();
    db.membership.findFirst.mockResolvedValueOnce(null);
    await expect(
      service.assign("proposal", {
        assignedToId: "22222222-2222-4222-8222-222222222222",
        reason: "Needs AP review",
      }),
    ).rejects.toThrow("Assignee");
    expect(db.commandProposalAssignment.create).not.toHaveBeenCalled();
  });

  it("rejects without executing a purchase command", async () => {
    const { service, db, commands } = setup();
    await service.reject("proposal", { reason: "Duplicate document" });
    expect(commands.execute).not.toHaveBeenCalled();
    expect(db.commandReview.create).toHaveBeenCalledWith({
      data: expect.objectContaining({ decision: "REJECT" }),
    });
    expect(db.commandProposal.update).toHaveBeenCalledWith({
      where: { id: "proposal" },
      data: { status: "REJECTED" },
    });
  });

  it("does not execute rejected proposals", async () => {
    const { service, db, commands, original } = setup();
    db.commandProposal.findFirst.mockResolvedValueOnce({
      ...original,
      status: "REJECTED",
    });
    await expect(
      service.execute("proposal", { reason: "Reviewed" }),
    ).rejects.toThrow("pending");
    expect(commands.execute).not.toHaveBeenCalled();
  });
});

describe("proposal input validation outside HTTP", () => {
  it("requires both a structured payload and provenance", async () => {
    await expect(
      validateCommandInput(CreatePurchaseCommandProposalDto, {
        commandId: "p1",
      }),
    ).rejects.toThrow();
  });
  it("rejects unknown fields and invalid nested invoice data", async () => {
    for (const input of [
      {
        commandId: "p1",
        payload,
        provenance: { channel: "UPLOAD" },
        tenant: "other",
      },
      {
        commandId: "p1",
        payload: {
          ...payload,
          lines: [{ ...payload.lines[0], unitPrice: -1 }],
        },
        provenance: { channel: "UPLOAD" },
      },
      {
        commandId: "p1",
        payload,
        provenance: { channel: "UPLOAD", role: "owner" },
      },
    ])
      await expect(
        validateCommandInput(CreatePurchaseCommandProposalDto, input),
      ).rejects.toThrow();
  });
  it("normalizes defaults without applying business rules or creating domain data", async () => {
    const proposal = await validateCommandInput(
      CreatePurchaseCommandProposalDto,
      { commandId: "p1", payload, provenance: { channel: "UPLOAD" } },
    );
    expect(proposal.payload.lines[0].deductiblePct).toBe(100);
    expect(proposal.evidence).toEqual([]);
  });
});
