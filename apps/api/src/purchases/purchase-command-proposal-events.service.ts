import { ConflictException, Injectable } from "@nestjs/common";
import { commandHash, commandJson } from "../commands/command-json";
import { TenantContextService } from "../tenancy/tenant-context.service";

@Injectable()
export class PurchaseCommandProposalEventsService {
  constructor(private readonly tenant: TenantContextService) {}

  async record(proposalId: string, type: string, payload: unknown) {
    const scope = this.scope();
    await this.tenant.db.$queryRaw`
      SELECT pg_advisory_xact_lock(hashtextextended(${`proposal-events:${scope.companyId}:${proposalId}`}, 0))::text
    `;
    const [last] = await this.tenant.db.$queryRaw<
      Array<{ sequence: number; event_hash: string }>
    >`
      SELECT "sequence", "event_hash" FROM "command_proposal_events"
      WHERE "proposal_id" = CAST(${proposalId} AS uuid)
        AND "organization_id" = CAST(${scope.organizationId} AS uuid)
        AND "company_id" = CAST(${scope.companyId} AS uuid)
      ORDER BY "sequence" DESC
      LIMIT 1
      FOR UPDATE
    `;
    const previousEventHash =
      typeof last?.event_hash === "string" ? last.event_hash : null;
    const sequence = typeof last?.sequence === "number" ? last.sequence + 1 : 1;
    const normalizedPayload = commandJson(payload);
    const payloadHash = commandHash(normalizedPayload);
    const eventHash = commandHash({
      proposalId,
      sequence,
      type,
      payload: normalizedPayload,
      payloadHash,
      previousEventHash,
    });
    await this.tenant.db.commandProposalEvent.create({
      data: {
        ...scope,
        proposalId,
        sequence,
        type,
        payload: normalizedPayload,
        payloadHash,
        previousEventHash,
        eventHash,
        actorUserId: this.tenant.required.userId,
      },
    });
    await this.updateMaterializedProjection(
      proposalId,
      type,
      normalizedPayload as Record<string, unknown>,
      sequence,
      eventHash,
    );
  }

  private async updateMaterializedProjection(
    proposalId: string,
    type: string,
    payload: Record<string, unknown>,
    sequence: number,
    eventHash: string,
  ) {
    const scope = this.scope();
    const assignedToId =
      type === "command_proposal.assigned" && typeof payload.assignedToId === "string"
        ? payload.assignedToId
        : null;
    const executionId =
      type === "command_proposal.executed" && typeof payload.executionId === "string"
        ? payload.executionId
        : null;
    const status =
      type === "command_proposal.executed"
        ? "EXECUTED"
        : type === "command_proposal.rejected"
          ? "REJECTED"
          : "PENDING_REVIEW";
    await this.tenant.db.$executeRaw`
      INSERT INTO "command_proposal_projections" (
        "proposal_id", "organization_id", "company_id", "status", "current_assignee_id",
        "correction_count", "failed_attempt_count", "document_count", "execution_id",
        "last_event_sequence", "last_event_hash"
      ) VALUES (
        CAST(${proposalId} AS uuid), CAST(${scope.organizationId} AS uuid), CAST(${scope.companyId} AS uuid),
        CAST(${status} AS "CommandProposalStatus"), CAST(${assignedToId} AS uuid),
        ${type === "command_proposal.corrected" ? 1 : 0},
        ${type === "command_proposal.execution_failed" ? 1 : 0},
        ${type === "command_proposal.document_uploaded" ? 1 : 0},
        CAST(${executionId} AS uuid), ${sequence}, ${eventHash}
      )
      ON CONFLICT ("proposal_id") DO UPDATE SET
        "status" = CASE
          WHEN ${type} = 'command_proposal.executed' THEN 'EXECUTED'::"CommandProposalStatus"
          WHEN ${type} = 'command_proposal.rejected' THEN 'REJECTED'::"CommandProposalStatus"
          ELSE "command_proposal_projections"."status"
        END,
        "current_assignee_id" = CASE
          WHEN ${type} = 'command_proposal.assigned' THEN CAST(${assignedToId} AS uuid)
          ELSE "command_proposal_projections"."current_assignee_id"
        END,
        "correction_count" = "command_proposal_projections"."correction_count" + CASE WHEN ${type} = 'command_proposal.corrected' THEN 1 ELSE 0 END,
        "failed_attempt_count" = "command_proposal_projections"."failed_attempt_count" + CASE WHEN ${type} = 'command_proposal.execution_failed' THEN 1 ELSE 0 END,
        "document_count" = "command_proposal_projections"."document_count" + CASE WHEN ${type} = 'command_proposal.document_uploaded' THEN 1 ELSE 0 END,
        "execution_id" = CASE
          WHEN ${type} = 'command_proposal.executed' THEN CAST(${executionId} AS uuid)
          ELSE "command_proposal_projections"."execution_id"
        END,
        "last_event_sequence" = ${sequence},
        "last_event_hash" = ${eventHash},
        "updated_at" = CURRENT_TIMESTAMP
    `;
  }

  private scope() {
    const { organizationId, companyId } = this.tenant.required;
    if (!companyId) throw new ConflictException("Company context is required");
    return { organizationId, companyId };
  }
}
