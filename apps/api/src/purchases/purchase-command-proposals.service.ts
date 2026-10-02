import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  Logger,
  NotFoundException,
} from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { AuditService } from "../audit/audit.service";
import { CommandAuthorizationService } from "../commands/command-authorization.service";
import { commandHash, commandJson } from "../commands/command-json";
import { requireCommandId } from "../commands/command-executor.service";
import { validateCommandInput } from "../commands/validate-command-input";
import { TenantContextService } from "../tenancy/tenant-context.service";
import { TenantTransactionService } from "../tenancy/tenant-transaction.service";
import {
  AssignPurchaseCommandProposalDto,
  CreatePurchaseCommandProposalDto,
  ExecutePurchaseCommandProposalDto,
  ListPurchaseCommandProposalsDto,
  RejectPurchaseCommandProposalDto,
} from "./dto/purchase-command-proposal.dto";
import { proposalDocumentMetadata, proposalDocumentEvidence } from "./purchase-proposal-documents.service";
import { PurchaseCommandProposalEventsService } from "./purchase-command-proposal-events.service";
import { PurchaseProposalLearningService } from "./purchase-proposal-learning.service";
import { CreatePurchaseInvoiceDto } from "./dto/purchase-invoice.dto";
import {
  REGISTER_PURCHASE_COMMAND,
  REGISTER_PURCHASE_COMMAND_VERSION,
  RegisterPurchaseCommandService,
} from "./register-purchase-command.service";

function errorMessage(error: unknown) {
  const message = error instanceof Error ? error.message : String(error);
  return (message.trim() || "Unknown execution error").slice(0, 2000);
}

function errorCode(error: unknown) {
  if (error instanceof BadRequestException) return "VALIDATION_ERROR";
  if (error instanceof ConflictException) return "BUSINESS_RULE_CONFLICT";
  if (error instanceof ForbiddenException) return "AUTHORIZATION_ERROR";
  if (error instanceof NotFoundException) return "REFERENCE_NOT_FOUND";
  return "EXECUTION_ERROR";
}

function payloadChanges(
  before: unknown,
  after: unknown,
  path = "",
): Array<{ path: string; before: unknown; after: unknown }> {
  if (Object.is(before, after)) return [];
  if (
    before &&
    after &&
    typeof before === "object" &&
    typeof after === "object"
  ) {
    const a = before as Record<string, unknown>;
    const b = after as Record<string, unknown>;
    return [...new Set([...Object.keys(a), ...Object.keys(b)])]
      .sort()
      .flatMap((key) =>
        payloadChanges(a[key], b[key], path ? `${path}.${key}` : key),
      );
  }
  return [
    {
      path,
      before: before === undefined ? null : before,
      after: after === undefined ? null : after,
    },
  ];
}

@Injectable()
export class PurchaseCommandProposalsService {
  private readonly logger = new Logger(PurchaseCommandProposalsService.name);

  constructor(
    private readonly tenant: TenantContextService,
    private readonly transactions: TenantTransactionService,
    private readonly authorization: CommandAuthorizationService,
    private readonly commands: RegisterPurchaseCommandService,
    private readonly events: PurchaseCommandProposalEventsService,
    private readonly learning: PurchaseProposalLearningService,
    private readonly audit: AuditService,
    private readonly config: ConfigService,
  ) {}

  private run<T>(permissions: readonly string[], work: () => Promise<T>) {
    if (this.config.get<string>("AI_NATIVE_ENABLED") !== "true")
      throw new NotFoundException("Command proposal pilot is disabled");
    return this.transactions.run(this.tenant.required, async () => {
      await this.authorization.require(permissions);
      return work();
    });
  }

  create(input: CreatePurchaseCommandProposalDto) {
    return this.run(["command_proposal.create"], async () => {
      const normalized = await validateCommandInput(
        CreatePurchaseCommandProposalDto,
        input,
      );
      requireCommandId(normalized.commandId);
      const payload = await validateCommandInput(
        CreatePurchaseInvoiceDto,
        normalized.payload,
      );
      const scope = this.scope();
      const payloadHash = commandHash({
        name: REGISTER_PURCHASE_COMMAND,
        version: REGISTER_PURCHASE_COMMAND_VERSION,
        payload,
        evidence: normalized.evidence,
        provenance: normalized.provenance,
      });
      await this.tenant.db.$queryRaw`
        SELECT pg_advisory_xact_lock(hashtextextended(${`proposal:${scope.companyId}:${normalized.commandId}`}, 0))::text
      `;
      const existing = await this.tenant.db.commandProposal.findFirst({
        where: { ...scope, commandId: normalized.commandId },
      });
      if (existing) {
        if (existing.payloadHash !== payloadHash)
          throw new ConflictException(
            "commandId was already used for a different proposal",
          );
        return this.getRecord(existing.id);
      }
      const proposal = await this.tenant.db.commandProposal.create({
        data: {
          ...scope,
          commandId: normalized.commandId,
          name: REGISTER_PURCHASE_COMMAND,
          version: REGISTER_PURCHASE_COMMAND_VERSION,
          payloadHash,
          payload: commandJson(payload),
          evidence: commandJson(normalized.evidence),
          provenance: commandJson(normalized.provenance),
          proposedById: this.tenant.required.userId,
        },
      });
      await this.events.record(proposal.id, "command_proposal.created", {
        commandId: proposal.commandId,
        name: proposal.name,
        version: proposal.version,
        payloadHash,
      });
      await this.audit.record(
        "command_proposal.created",
        "command_proposal",
        proposal.id,
        { name: proposal.name, commandId: proposal.commandId },
      );
      return this.getRecord(proposal.id);
    });
  }

  list(query: ListPurchaseCommandProposalsDto) {
    return this.run(["command_proposal.read"], async () => {
      const input = await validateCommandInput(
        ListPurchaseCommandProposalsDto,
        query,
      );
      return this.tenant.db.commandProposal.findMany({
        where: {
          ...this.scope(),
          name: REGISTER_PURCHASE_COMMAND,
          ...(input.status ? { status: input.status } : {}),
        },
        orderBy: [{ createdAt: "desc" }, { id: "desc" }],
        take: input.limit,
        include: {
          review: true,
          revisions: { orderBy: [{ revisionNumber: "asc" }] },
          assignments: { orderBy: [{ assignedAt: "desc" }, { id: "desc" }] },
          attempts: { orderBy: [{ attemptedAt: "desc" }, { id: "desc" }] },
          events: { orderBy: [{ sequence: "asc" }] },
          documents: {
            select: proposalDocumentMetadata,
            orderBy: [{ createdAt: "asc" }, { id: "asc" }],
          },
        },
      });
    });
  }

  get(id: string) {
    return this.run(["command_proposal.read"], () => this.getRecord(id));
  }

  projection(id: string) {
    return this.run(["command_proposal.read"], async () => {
      const proposal = await this.getRecord(id);
      const events = proposal.events ?? [];
      let previousEventHash: string | null = null;
      let chainValid = true;
      const projected = {
        status: "PENDING_REVIEW",
        currentAssigneeId: null as string | null,
        correctionCount: 0,
        failedAttemptCount: 0,
        documentCount: 0,
        executionId: null as string | null,
      };
      for (const event of events) {
        const payloadHash = commandHash(event.payload);
        const eventHash = commandHash({
          proposalId: id,
          sequence: event.sequence,
          type: event.type,
          payload: event.payload,
          payloadHash,
          previousEventHash,
        });
        if (
          event.previousEventHash !== previousEventHash ||
          event.payloadHash !== payloadHash ||
          event.eventHash !== eventHash
        )
          chainValid = false;
        const payload = event.payload as Record<string, unknown>;
        if (event.type === "command_proposal.assigned")
          projected.currentAssigneeId = String(payload.assignedToId ?? "") || null;
        if (event.type === "command_proposal.corrected")
          projected.correctionCount += 1;
        if (event.type === "command_proposal.execution_failed")
          projected.failedAttemptCount += 1;
        if (event.type === "command_proposal.document_uploaded")
          projected.documentCount += 1;
        if (event.type === "command_proposal.executed") {
          projected.status = "EXECUTED";
          projected.executionId = String(payload.executionId ?? "") || null;
        }
        if (event.type === "command_proposal.rejected")
          projected.status = "REJECTED";
        previousEventHash = event.eventHash;
      }
      const actual = {
        status: proposal.status,
        currentAssigneeId: proposal.assignments?.[0]?.assignedToId ?? null,
        correctionCount: proposal.revisions?.length ?? 0,
        failedAttemptCount: proposal.attempts?.length ?? 0,
        executionId: proposal.executionId ?? null,
        documentCount: proposal.documents?.length ?? 0,
        reviewDecision: proposal.review?.decision ?? null,
        terminal: proposal.status !== "PENDING_REVIEW",
      };
      const [materializedRow] = await this.tenant.db.$queryRaw<
        Array<{
          status: string;
          current_assignee_id: string | null;
          correction_count: number;
          failed_attempt_count: number;
          document_count: number;
          execution_id: string | null;
          last_event_sequence: number;
          last_event_hash: string;
        }>
      >`
        SELECT "status", "current_assignee_id", "correction_count",
          "failed_attempt_count", "document_count", "execution_id",
          "last_event_sequence", "last_event_hash"
        FROM "command_proposal_projections"
        WHERE "proposal_id" = CAST(${id} AS uuid)
          AND "organization_id" = CAST(${this.scope().organizationId} AS uuid)
          AND "company_id" = CAST(${this.scope().companyId} AS uuid)
      `;
      const materialized = materializedRow
        ? {
            status: materializedRow.status,
            currentAssigneeId: materializedRow.current_assignee_id,
            correctionCount: materializedRow.correction_count,
            failedAttemptCount: materializedRow.failed_attempt_count,
            documentCount: materializedRow.document_count,
            executionId: materializedRow.execution_id,
            lastEventSequence: materializedRow.last_event_sequence,
            lastEventHash: materializedRow.last_event_hash,
          }
        : null;
      const lastEvent = events.at(-1);
      const materializedDiscrepancies = materialized
        ? [
            materialized.status === projected.status
              ? null
              : `materialized status: ${materialized.status}, projected ${projected.status}`,
            materialized.currentAssigneeId === projected.currentAssigneeId
              ? null
              : `materialized assignee: ${materialized.currentAssigneeId ?? "none"}, projected ${projected.currentAssigneeId ?? "none"}`,
            materialized.correctionCount === projected.correctionCount
              ? null
              : `materialized corrections: ${materialized.correctionCount}, projected ${projected.correctionCount}`,
            materialized.failedAttemptCount === projected.failedAttemptCount
              ? null
              : `materialized failed attempts: ${materialized.failedAttemptCount}, projected ${projected.failedAttemptCount}`,
            materialized.documentCount === projected.documentCount
              ? null
              : `materialized documents: ${materialized.documentCount}, projected ${projected.documentCount}`,
            materialized.executionId === projected.executionId
              ? null
              : `materialized execution: ${materialized.executionId ?? "none"}, projected ${projected.executionId ?? "none"}`,
            materialized.lastEventSequence === lastEvent?.sequence
              ? null
              : `materialized sequence: ${materialized.lastEventSequence}, last event ${lastEvent?.sequence ?? "none"}`,
            materialized.lastEventHash === previousEventHash
              ? null
              : `materialized hash: ${materialized.lastEventHash}, last event ${previousEventHash ?? "none"}`,
          ]
        : ["materialized projection: missing"];
      const discrepancies = [
        projected.status === actual.status
          ? null
          : `status: projected ${projected.status}, actual ${actual.status}`,
        projected.currentAssigneeId === actual.currentAssigneeId
          ? null
          : `assignee: projected ${projected.currentAssigneeId ?? "none"}, actual ${actual.currentAssigneeId ?? "none"}`,
        projected.correctionCount === actual.correctionCount
          ? null
          : `corrections: projected ${projected.correctionCount}, actual ${actual.correctionCount}`,
        projected.failedAttemptCount === actual.failedAttemptCount
          ? null
          : `failed attempts: projected ${projected.failedAttemptCount}, actual ${actual.failedAttemptCount}`,
        projected.executionId === actual.executionId
          ? null
          : `execution: projected ${projected.executionId ?? "none"}, actual ${actual.executionId ?? "none"}`,
        projected.documentCount === actual.documentCount
          ? null
          : `documents: projected ${projected.documentCount}, actual ${actual.documentCount}`,
        ...materializedDiscrepancies,
      ].filter((item): item is string => item !== null);
      return {
        chainValid,
        eventCount: events.length,
        projected,
        actual,
        materialized,
        discrepancies,
        matchesCurrentState: chainValid && discrepancies.length === 0,
      };
    });
  }

  assignees() {
    return this.run(["command_proposal.review"], async () =>
      this.tenant.db.membership.findMany({
        where: { ...this.scope(), status: "ACTIVE" },
        orderBy: [{ user: { email: "asc" } }],
        select: {
          user: { select: { id: true, email: true } },
          role: { select: { code: true, name: true } },
        },
      }).then((memberships) =>
        memberships.map((membership) => ({
          id: membership.user.id,
          email: membership.user.email,
          roleCode: membership.role.code,
          roleName: membership.role.name,
        })),
      ),
    );
  }

  execute(id: string, input: ExecutePurchaseCommandProposalDto) {
    let failedAttempt:
      | { payload: CreatePurchaseInvoiceDto; reason: string }
      | undefined;
    return this.run(
      ["command_proposal.review", "purchase_invoice.create"],
      async () => {
        const review = await validateCommandInput(
          ExecutePurchaseCommandProposalDto,
          input,
        );
        const proposal = await this.lock(id);
        const originalPayload = await validateCommandInput(
          CreatePurchaseInvoiceDto,
          proposal.payload,
        );
        const payload = await validateCommandInput(
          CreatePurchaseInvoiceDto,
          review.payload ?? originalPayload,
        );
        const reason = review.reason.trim();
        if (proposal.status === "EXECUTED") {
          if (
            proposal.review?.decision !== "EXECUTE" ||
            proposal.review.reason !== reason ||
            commandHash(proposal.review.acceptedPayload) !==
              commandHash(payload)
          )
            throw new ConflictException(
              "Proposal was already executed with a different review",
            );
          return proposal;
        }
        if (proposal.status !== "PENDING_REVIEW")
          throw new ConflictException("Only pending proposals can be executed");
        if (proposal.version !== REGISTER_PURCHASE_COMMAND_VERSION)
          throw new ConflictException("Unsupported proposal command version");
        const corrected = commandHash(payload) !== commandHash(originalPayload);
        failedAttempt = { payload, reason };
        const receipt = await this.commands.execute(
          this.tenant.required,
          `proposal:${id}:execute`,
          payload,
          [
            ...(proposal.evidence as unknown[]),
            ...proposalDocumentEvidence(proposal.documents),
          ],
          ["command_proposal.review"],
        );
        if (corrected) {
          const revision = await this.tenant.db.commandProposalRevision.create({
            data: {
              ...this.scope(),
              proposalId: id,
              revisionNumber: (proposal.revisions?.length ?? 0) + 1,
              previousPayload: commandJson(originalPayload),
              correctedPayload: commandJson(payload),
              changes: commandJson(payloadChanges(originalPayload, payload)),
              reason,
              createdById: this.tenant.required.userId,
            },
          });
          const changes = payloadChanges(originalPayload, payload);
          await this.events.record(id, "command_proposal.corrected", {
            revisionId: revision.id,
            changes,
          });
          await this.learning.recordFromRevision(revision.id, changes);
        }
        await this.tenant.db.commandReview.create({
          data: {
            ...this.scope(),
            proposalId: id,
            decision: "EXECUTE",
            acceptedPayload: commandJson(payload),
            reason,
            reviewedById: this.tenant.required.userId,
          },
        });
        await this.tenant.db.commandProposal.update({
          where: { id },
          data: { status: "EXECUTED", executionId: receipt.execution.id },
        });
        await this.events.record(id, "command_proposal.executed", {
          executionId: receipt.execution.id,
          corrected,
        });
        failedAttempt = undefined;
        await this.audit.record(
          "command_proposal.executed",
          "command_proposal",
          id,
          {
            executionId: receipt.execution.id,
            reason,
            corrected,
          },
        );
        return this.getRecord(id);
      },
    ).catch(async (error: unknown) => {
      if (failedAttempt)
        await this.recordFailedExecutionAttempt(
          id,
          failedAttempt.payload,
          failedAttempt.reason,
          error,
        );
      throw error;
    });
  }

  private async recordFailedExecutionAttempt(
    id: string,
    payload: CreatePurchaseInvoiceDto,
    reason: string,
    error: unknown,
  ) {
    try {
      await this.transactions.run(this.tenant.required, async () => {
        const proposal = await this.tenant.db.commandProposal.findFirst({
          where: { id, ...this.scope(), status: "PENDING_REVIEW" },
          select: { id: true },
        });
        if (!proposal) return;
        const attempt = await this.tenant.db.commandProposalAttempt.create({
          data: {
            ...this.scope(),
            proposalId: id,
            attemptedPayload: commandJson(payload),
            reason,
            errorCode: errorCode(error),
            errorMessage: errorMessage(error),
            attemptedById: this.tenant.required.userId,
          },
        });
        await this.events.record(id, "command_proposal.execution_failed", {
          attemptId: attempt.id,
          errorCode: errorCode(error),
        });
      });
    } catch (recordError) {
      this.logger.warn({
        message: "Could not record failed proposal execution attempt",
        proposalId: id,
        error: recordError,
      });
    }
  }

  assign(id: string, input: AssignPurchaseCommandProposalDto) {
    return this.run(["command_proposal.review"], async () => {
      const assignment = await validateCommandInput(
        AssignPurchaseCommandProposalDto,
        input,
      );
      const proposal = await this.lock(id);
      if (proposal.status !== "PENDING_REVIEW")
        throw new ConflictException("Only pending proposals can be assigned");
      const scope = this.scope();
      const membership = await this.tenant.db.membership.findFirst({
        where: {
          ...scope,
          userId: assignment.assignedToId,
          status: "ACTIVE",
        },
      });
      if (!membership)
        throw new ConflictException(
          "Assignee must be an active member of the proposal company",
        );
      const created = await this.tenant.db.commandProposalAssignment.create({
        data: {
          ...scope,
          proposalId: id,
          assignedToId: assignment.assignedToId,
          assignedById: this.tenant.required.userId,
          reason: assignment.reason.trim(),
        },
      });
      await this.events.record(id, "command_proposal.assigned", {
        assignmentId: created.id,
        assignedToId: assignment.assignedToId,
      });
      await this.audit.record(
        "command_proposal.assigned",
        "command_proposal",
        id,
        {
          assignedToId: assignment.assignedToId,
          reason: assignment.reason.trim(),
        },
      );
      return this.getRecord(id);
    });
  }

  reject(id: string, input: RejectPurchaseCommandProposalDto) {
    return this.run(["command_proposal.review"], async () => {
      const review = await validateCommandInput(
        RejectPurchaseCommandProposalDto,
        input,
      );
      const proposal = await this.lock(id);
      const reason = review.reason.trim();
      if (proposal.status === "REJECTED" && proposal.review?.reason === reason)
        return proposal;
      if (proposal.status !== "PENDING_REVIEW")
        throw new ConflictException("Only pending proposals can be rejected");
      await this.tenant.db.commandReview.create({
        data: {
          ...this.scope(),
          proposalId: id,
          decision: "REJECT",
          reason,
          reviewedById: this.tenant.required.userId,
        },
      });
      await this.tenant.db.commandProposal.update({
        where: { id },
        data: { status: "REJECTED" },
      });
      await this.events.record(id, "command_proposal.rejected", { reason });
      await this.audit.record(
        "command_proposal.rejected",
        "command_proposal",
        id,
        { reason },
      );
      return this.getRecord(id);
    });
  }

  private async lock(id: string) {
    const scope = this.scope();
    const rows = await this.tenant.db.$queryRaw<Array<{ id: string }>>`
      SELECT "id" FROM "command_proposals"
      WHERE "id" = CAST(${id} AS uuid)
        AND "organization_id" = CAST(${scope.organizationId} AS uuid)
        AND "company_id" = CAST(${scope.companyId} AS uuid)
      FOR UPDATE
    `;
    if (!rows.length) throw new NotFoundException("Command proposal not found");
    return this.getRecord(id);
  }

  private async getRecord(id: string) {
    const proposal = await this.tenant.db.commandProposal.findFirst({
      where: { id, ...this.scope(), name: REGISTER_PURCHASE_COMMAND },
      include: {
        review: true,
        execution: true,
        revisions: { orderBy: [{ revisionNumber: "asc" }] },
        assignments: { orderBy: [{ assignedAt: "desc" }, { id: "desc" }] },
        attempts: { orderBy: [{ attemptedAt: "desc" }, { id: "desc" }] },
        events: { orderBy: [{ sequence: "asc" }] },
        documents: {
          select: proposalDocumentMetadata,
          orderBy: [{ createdAt: "asc" }, { id: "asc" }],
        },
      },
    });
    if (!proposal) throw new NotFoundException("Command proposal not found");
    return proposal;
  }


  private scope() {
    const { organizationId, companyId } = this.tenant.required;
    if (!companyId) throw new ConflictException("Company context is required");
    return { organizationId, companyId };
  }
}
