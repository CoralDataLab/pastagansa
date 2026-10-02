import { ConflictException, Injectable, NotFoundException } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { AuditService } from "../audit/audit.service";
import { CommandAuthorizationService } from "../commands/command-authorization.service";
import { TenantContextService } from "../tenancy/tenant-context.service";
import { TenantTransactionService } from "../tenancy/tenant-transaction.service";
import { validateCommandInput } from "../commands/validate-command-input";
import {
  ListPurchaseProposalLearningCandidatesDto,
  ReviewPurchaseProposalLearningCandidateDto,
} from "./dto/purchase-proposal-learning.dto";
import {
  REGISTER_PURCHASE_COMMAND,
  REGISTER_PURCHASE_COMMAND_VERSION,
} from "./register-purchase-command.service";

type PayloadChange = { path: string; before: unknown; after: unknown };

type LearningCandidateRow = {
  id: string;
  proposal_id: string;
  revision_id: string;
  command_name: string;
  command_version: number;
  field_path: string;
  original_value: unknown;
  corrected_value: unknown;
  status: string;
  review_reason: string | null;
  reviewed_by_id: string | null;
  reviewed_at: Date | null;
  created_by_id: string;
  created_at: Date;
};

@Injectable()
export class PurchaseProposalLearningService {
  constructor(
    private readonly tenant: TenantContextService,
    private readonly transactions: TenantTransactionService,
    private readonly authorization: CommandAuthorizationService,
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

  async recordFromRevision(revisionId: string, changes: PayloadChange[]) {
    const scope = this.scope();
    for (const change of changes.filter((item) => item.path)) {
      await this.tenant.db.$executeRaw`
        INSERT INTO "command_learning_candidates" (
          "organization_id", "company_id", "proposal_id", "revision_id",
          "command_name", "command_version", "field_path",
          "original_value", "corrected_value", "created_by_id"
        )
        SELECT
          r."organization_id", r."company_id", r."proposal_id", r."id",
          ${REGISTER_PURCHASE_COMMAND}, ${REGISTER_PURCHASE_COMMAND_VERSION}, ${change.path},
          CAST(${JSON.stringify(change.before ?? null)} AS jsonb),
          CAST(${JSON.stringify(change.after ?? null)} AS jsonb),
          CAST(${this.tenant.required.userId} AS uuid)
        FROM "command_proposal_revisions" r
        WHERE r."id" = CAST(${revisionId} AS uuid)
          AND r."organization_id" = CAST(${scope.organizationId} AS uuid)
          AND r."company_id" = CAST(${scope.companyId} AS uuid)
        ON CONFLICT ("revision_id", "field_path") DO NOTHING
      `;
    }
  }

  summary() {
    return this.run(["command_proposal.review"], async () => {
      const scope = this.scope();
      const rows = await this.tenant.db.$queryRaw<
        Array<{ status: string; count: bigint | number }>
      >`
        SELECT "status", count(*) AS "count"
        FROM "command_learning_candidates"
        WHERE "organization_id" = CAST(${scope.organizationId} AS uuid)
          AND "company_id" = CAST(${scope.companyId} AS uuid)
        GROUP BY "status"
      `;
      const counts = { pendingReview: 0, approved: 0, rejected: 0 };
      for (const row of rows) {
        const count = Number(row.count);
        if (row.status === "PENDING_REVIEW") counts.pendingReview = count;
        if (row.status === "APPROVED") counts.approved = count;
        if (row.status === "REJECTED") counts.rejected = count;
      }
      return counts;
    });
  }

  list(query: ListPurchaseProposalLearningCandidatesDto) {
    return this.run(["command_proposal.review"], async () => {
      const input = await validateCommandInput(
        ListPurchaseProposalLearningCandidatesDto,
        query,
      );
      const scope = this.scope();
      const rows = await this.tenant.db.$queryRaw<LearningCandidateRow[]>`
        SELECT "id", "proposal_id", "revision_id", "command_name", "command_version",
          "field_path", "original_value", "corrected_value", "status", "review_reason",
          "reviewed_by_id", "reviewed_at", "created_by_id", "created_at"
        FROM "command_learning_candidates"
        WHERE "organization_id" = CAST(${scope.organizationId} AS uuid)
          AND "company_id" = CAST(${scope.companyId} AS uuid)
          AND "status" = CAST(${input.status} AS "CommandLearningCandidateStatus")
        ORDER BY "created_at" DESC, "id" DESC
        LIMIT 100
      `;
      return rows.map(toCandidate);
    });
  }

  approve(id: string, input: ReviewPurchaseProposalLearningCandidateDto) {
    return this.review(id, "APPROVED", input);
  }

  reject(id: string, input: ReviewPurchaseProposalLearningCandidateDto) {
    return this.review(id, "REJECTED", input);
  }

  hintsForProposal(proposalId: string) {
    return this.run(["command_proposal.read"], async () => {
      const scope = this.scope();
      const proposal = await this.tenant.db.commandProposal.findFirst({
        where: { id: proposalId, ...scope },
        select: { id: true, name: true, version: true, payload: true },
      });
      if (!proposal) throw new NotFoundException("Command proposal not found");
      const rows = await this.tenant.db.$queryRaw<LearningCandidateRow[]>`
        SELECT "id", "proposal_id", "revision_id", "command_name", "command_version",
          "field_path", "original_value", "corrected_value", "status", "review_reason",
          "reviewed_by_id", "reviewed_at", "created_by_id", "created_at"
        FROM "command_learning_candidates"
        WHERE "organization_id" = CAST(${scope.organizationId} AS uuid)
          AND "company_id" = CAST(${scope.companyId} AS uuid)
          AND "status" = 'APPROVED'
          AND "command_name" = ${proposal.name}
          AND "command_version" = ${proposal.version}
        ORDER BY "reviewed_at" DESC NULLS LAST, "created_at" DESC
        LIMIT 500
      `;
      return rows
        .filter((row) =>
          jsonEqual(valueAtPath(proposal.payload, row.field_path), row.original_value),
        )
        .slice(0, 50)
        .map((row) => ({
          candidate: toCandidate(row),
          fieldPath: row.field_path,
          currentValue: row.original_value,
          suggestedValue: row.corrected_value,
          reason: row.review_reason,
        }));
    });
  }

  private review(
    id: string,
    decision: "APPROVED" | "REJECTED",
    input: ReviewPurchaseProposalLearningCandidateDto,
  ) {
    return this.run(["command_proposal.review"], async () => {
      const review = await validateCommandInput(
        ReviewPurchaseProposalLearningCandidateDto,
        input,
      );
      const scope = this.scope();
      const rows = await this.tenant.db.$queryRaw<LearningCandidateRow[]>`
        UPDATE "command_learning_candidates"
        SET "status" = CAST(${decision} AS "CommandLearningCandidateStatus"),
          "review_reason" = ${review.reason.trim()},
          "reviewed_by_id" = CAST(${this.tenant.required.userId} AS uuid),
          "reviewed_at" = CURRENT_TIMESTAMP
        WHERE "id" = CAST(${id} AS uuid)
          AND "organization_id" = CAST(${scope.organizationId} AS uuid)
          AND "company_id" = CAST(${scope.companyId} AS uuid)
          AND "status" = 'PENDING_REVIEW'
        RETURNING "id", "proposal_id", "revision_id", "command_name", "command_version",
          "field_path", "original_value", "corrected_value", "status", "review_reason",
          "reviewed_by_id", "reviewed_at", "created_by_id", "created_at"
      `;
      if (!rows.length)
        throw new ConflictException("Learning candidate is not pending review");
      const candidate = toCandidate(rows[0]);
      await this.audit.record(
        decision === "APPROVED"
          ? "command_learning_candidate.approved"
          : "command_learning_candidate.rejected",
        "command_learning_candidate",
        candidate.id,
        {
          proposalId: candidate.proposalId,
          revisionId: candidate.revisionId,
          fieldPath: candidate.fieldPath,
          reason: review.reason.trim(),
        },
      );
      return candidate;
    });
  }

  private scope() {
    const { organizationId, companyId } = this.tenant.required;
    if (!companyId) throw new ConflictException("Company context is required");
    return { organizationId, companyId };
  }
}

function valueAtPath(value: unknown, path: string) {
  return path.split(".").reduce<unknown>((current, segment) => {
    if (current === null || current === undefined) return undefined;
    if (Array.isArray(current) && /^\d+$/.test(segment))
      return current[Number(segment)];
    if (typeof current === "object")
      return (current as Record<string, unknown>)[segment];
    return undefined;
  }, value);
}

function jsonEqual(left: unknown, right: unknown) {
  return JSON.stringify(left ?? null) === JSON.stringify(right ?? null);
}

function toCandidate(row: LearningCandidateRow) {
  return {
    id: row.id,
    proposalId: row.proposal_id,
    revisionId: row.revision_id,
    commandName: row.command_name,
    commandVersion: row.command_version,
    fieldPath: row.field_path,
    originalValue: row.original_value,
    correctedValue: row.corrected_value,
    status: row.status,
    reviewReason: row.review_reason,
    reviewedById: row.reviewed_by_id,
    reviewedAt: row.reviewed_at,
    createdById: row.created_by_id,
    createdAt: row.created_at,
  };
}
