import { ConfigService } from "@nestjs/config";
import { AuditService } from "../audit/audit.service";
import { CommandAuthorizationService } from "../commands/command-authorization.service";
import { TenantContextService } from "../tenancy/tenant-context.service";
import { TenantTransactionService } from "../tenancy/tenant-transaction.service";
import { PurchaseCommandProposalEventsService } from "./purchase-command-proposal-events.service";
import { PurchaseProposalLearningService } from "./purchase-proposal-learning.service";

function setup(enabled = true) {
  const row = {
    id: "candidate",
    proposal_id: "proposal",
    revision_id: "revision",
    command_name: "registrar_factura_recibida",
    command_version: 1,
    field_path: "supplierId",
    original_value: "old",
    corrected_value: "new",
    status: "PENDING_REVIEW",
    review_reason: null,
    reviewed_by_id: null,
    reviewed_at: null,
    created_by_id: "reviewer",
    created_at: new Date(),
  };
  const db = {
    $executeRaw: jest.fn().mockResolvedValue(1),
    $queryRaw: jest.fn().mockResolvedValue([row]),
    commandProposal: {
      findFirst: jest.fn(),
    },
  };
  const tenant = {
    required: { organizationId: "org", companyId: "company", userId: "reviewer" },
    db,
  };
  const transactions = {
    run: jest.fn(async (_: unknown, work: () => Promise<unknown>) => work()),
  };
  const authorization = { require: jest.fn() };
  const events = { record: jest.fn() };
  const audit = { record: jest.fn() };
  const config = { get: jest.fn().mockReturnValue(enabled ? "true" : "false") };
  const service = new PurchaseProposalLearningService(
    tenant as unknown as TenantContextService,
    transactions as unknown as TenantTransactionService,
    authorization as unknown as CommandAuthorizationService,
    events as unknown as PurchaseCommandProposalEventsService,
    audit as unknown as AuditService,
    config as unknown as ConfigService,
  );
  return { service, db, authorization, events, audit, transactions };
}

describe("purchase proposal learning candidates", () => {
  it("is disabled with the AI-native flag off", async () => {
    const { service, db, transactions } = setup(false);
    expect(() => service.list({ status: "PENDING_REVIEW" })).toThrow("disabled");
    expect(transactions.run).not.toHaveBeenCalled();
    expect(db.$queryRaw).not.toHaveBeenCalled();
  });

  it("records one pending candidate per corrected field without applying anything", async () => {
    const { service, db } = setup();
    await service.recordFromRevision("revision", [
      { path: "supplierId", before: "old", after: "new" },
      { path: "", before: "ignored", after: "ignored" },
    ]);
    expect(db.$executeRaw).toHaveBeenCalledTimes(1);
  });

  it("lists pending candidates for reviewers", async () => {
    const { service, authorization } = setup();
    await expect(service.list({ status: "PENDING_REVIEW" })).resolves.toEqual([
      expect.objectContaining({ id: "candidate", fieldPath: "supplierId" }),
    ]);
    expect(authorization.require).toHaveBeenCalledWith(["command_proposal.review"]);
  });

  it("summarizes candidate counts by review status", async () => {
    const { service, db } = setup();
    db.$queryRaw.mockResolvedValueOnce([
      { status: "PENDING_REVIEW", count: 2n },
      { status: "APPROVED", count: 1n },
    ]);
    await expect(service.summary()).resolves.toEqual({
      pendingReview: 2,
      approved: 1,
      rejected: 0,
    });
  });

  it("approves only through an explicit review decision", async () => {
    const { service, db, events, audit } = setup();
    await expect(service.approve("candidate", { reason: "Useful OCR hint" })).resolves.toEqual(
      expect.objectContaining({ id: "candidate" }),
    );
    expect(db.$queryRaw).toHaveBeenCalledTimes(1);
    expect(events.record).toHaveBeenCalledWith(
      "proposal",
      "command_learning_candidate.approved",
      expect.objectContaining({ candidateId: "candidate", fieldPath: "supplierId" }),
    );
    expect(audit.record).toHaveBeenCalledWith(
      "command_learning_candidate.approved",
      "command_learning_candidate",
      "candidate",
      expect.objectContaining({ fieldPath: "supplierId", reason: "Useful OCR hint" }),
    );
  });

  it("returns read-only hints only when approved original values match the proposal", async () => {
    const { service, db } = setup();
    db.commandProposal = {
      findFirst: jest.fn().mockResolvedValue({
        id: "proposal",
        name: "registrar_factura_recibida",
        version: 1,
        payload: { supplierId: "old", supplierInvoiceNumber: "INV-1" },
      }),
    };
    await expect(service.hintsForProposal("proposal")).resolves.toEqual([
      expect.objectContaining({
        fieldPath: "supplierId",
        currentValue: "old",
        suggestedValue: "new",
      }),
    ]);
  });
});
