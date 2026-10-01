import { z } from "zod";

const text = (max: number) =>
  z
    .string()
    .max(max)
    .refine((value) => value.trim().length > 0, "No puede estar vacío");
const date = z
  .string()
  .refine(
    (value) =>
      /^\d{4}-\d{2}-\d{2}(T.*)?$/.test(value) &&
      Number.isFinite(Date.parse(value)),
    "Fecha no válida",
  );
const percentage = z.number().min(0).max(100).multipleOf(0.01);
// Separate from the legacy EUR-only form: never strip fiscal fields from a proposal.
export const proposalPayloadSchema = z.strictObject({
  supplierId: z.uuid(),
  supplierInvoiceNumber: text(100),
  issueDate: date,
  operationDate: date.nullish(),
  receivedDate: date,
  deductionDate: date.nullish(),
  dueDate: date.nullish(),
  currency: z
    .string()
    .refine(
      (value) => Intl.supportedValuesOf("currency").includes(value),
      "Moneda no válida",
    )
    .nullish(),
  notes: z.string().max(5000).nullish(),
  withholdingRate: percentage.nullish(),
  lines: z
    .array(
      z.strictObject({
        catalogItemId: z.uuid().nullish(),
        taxRuleId: z.uuid().nullish(),
        isDisbursement: z.boolean().nullish(),
        isEuServiceReverseCharge: z.boolean().nullish(),
        expenseAccountCode: z.enum(["600000", "623000", "629000"]).nullish(),
        exemptionReason: z.string().max(100).nullish(),
        description: text(2000),
        quantity: z.number().min(0.001).multipleOf(0.001),
        unitPrice: z.number().min(0).multipleOf(0.01),
        discountPct: percentage.nullish(),
        taxRate: percentage.nullish(),
        deductiblePct: percentage.nullish(),
      }),
    )
    .min(1)
    .max(200),
});
export const createProposalSchema = z.strictObject({
  commandId: z.string().min(1).max(128).regex(/^[\x21-\x7e](?:[\x20-\x7e]*[\x21-\x7e])?$/),
  payload: proposalPayloadSchema,
  evidence: z.array(z.strictObject({
    reference: text(1000),
    sha256: z.string().regex(/^[0-9a-f]{64}$/).optional(),
    description: z.string().max(240).optional(),
  })).max(20).default([]),
  provenance: z.strictObject({
    channel: z.enum(["FRONTEND", "API", "EMAIL", "UPLOAD"]),
    agentId: text(120).optional(),
    agentVersion: text(120).optional(),
  }),
});
export const proposalReasonSchema = text(1000).transform((value) =>
  value.trim(),
);
export const executeProposalSchema = z.strictObject({
  reason: proposalReasonSchema,
  payload: proposalPayloadSchema.optional(),
});
export const rejectProposalSchema = z.strictObject({
  reason: proposalReasonSchema,
});
export const assignProposalSchema = z.strictObject({
  assignedToId: z.uuid(),
  reason: proposalReasonSchema,
});
export type ProposalPayload = z.infer<typeof proposalPayloadSchema>;
export type ProposalStatus = "PENDING_REVIEW" | "EXECUTED" | "REJECTED";
export interface PurchaseProposalDocument {
  id: string;
  proposalId: string;
  originalName: string;
  mediaType: string;
  sizeBytes: number;
  sha256: string;
  createdById: string;
  createdAt: string;
}
export interface PurchaseProposalAssignee {
  id: string;
  email: string;
  roleCode: string;
  roleName: string;
}
export interface PurchaseProposalAssignment {
  id: string;
  proposalId: string;
  assignedToId: string;
  assignedById: string;
  reason: string;
  assignedAt: string;
}
export interface PurchaseProposalProjectionState {
  status: ProposalStatus | "PENDING_REVIEW";
  currentAssigneeId: string | null;
  correctionCount: number;
  failedAttemptCount: number;
  executionId: string | null;
}
export interface PurchaseProposalProjection {
  chainValid: boolean;
  eventCount: number;
  matchesCurrentState: boolean;
  discrepancies: string[];
  projected: PurchaseProposalProjectionState;
  actual: PurchaseProposalProjectionState & {
    documentCount: number;
    reviewDecision: "EXECUTE" | "REJECT" | null;
    terminal: boolean;
  };
}
export interface PurchaseProposalEvent {
  id: string;
  proposalId: string;
  sequence: number;
  type: string;
  payload: unknown;
  payloadHash: string;
  previousEventHash: string | null;
  eventHash: string;
  actorUserId: string;
  occurredAt: string;
}
export interface PurchaseProposalAttempt {
  id: string;
  proposalId: string;
  attemptedPayload: ProposalPayload;
  reason: string;
  errorCode: string;
  errorMessage: string;
  attemptedById: string;
  attemptedAt: string;
}
export interface PurchaseProposalRevision {
  id: string;
  proposalId: string;
  revisionNumber: number;
  previousPayload: ProposalPayload;
  correctedPayload: ProposalPayload;
  changes: PayloadChange[];
  reason: string;
  createdById: string;
  createdAt: string;
}
export interface PurchaseProposal {
  id: string;
  commandId: string;
  name: string;
  version: number;
  status: ProposalStatus;
  payload: ProposalPayload;
  proposedById: string;
  createdAt: string;
  evidence: Array<{ reference: string; description?: string; sha256?: string }>;
  provenance: { channel: string; agentId?: string; agentVersion?: string };
  documents?: PurchaseProposalDocument[];
  revisions?: PurchaseProposalRevision[];
  assignments?: PurchaseProposalAssignment[];
  attempts?: PurchaseProposalAttempt[];
  events?: PurchaseProposalEvent[];
  review: null | {
    id: string;
    decision: "EXECUTE" | "REJECT";
    reason: string;
    reviewedById: string;
    reviewedAt: string;
    acceptedPayload: ProposalPayload | null;
  };
  execution?: null | {
    id: string;
    result: { id: string; status: string };
    executedAt: string;
  };
}
export function proposalStatusLabel(status: ProposalStatus) {
  return {
    PENDING_REVIEW: "Pendiente de revisión",
    EXECUTED: "Borrador creado",
    REJECTED: "Rechazada",
  }[status];
}
export interface PayloadChange {
  path: string;
  before: unknown;
  after: unknown;
}
export function payloadChanges(
  before: unknown,
  after: unknown,
  path = "",
): PayloadChange[] {
  if (Object.is(before, after)) return [];
  if (
    before &&
    after &&
    typeof before === "object" &&
    typeof after === "object"
  ) {
    const a = before as Record<string, unknown>,
      b = after as Record<string, unknown>;
    return [...new Set([...Object.keys(a), ...Object.keys(b)])]
      .sort()
      .flatMap((key) =>
        payloadChanges(a[key], b[key], path ? `${path}.${key}` : key),
      );
  }
  return [{ path, before, after }];
}
export function displayProposalValue(value: unknown) {
  return value === undefined ? "Sin valor" : JSON.stringify(value);
}
export class ProposalRequestError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
  }
}
export async function proposalRequest<T>(
  path: string,
  init?: RequestInit,
): Promise<T> {
  const response = await fetch(path, { ...init, cache: "no-store" });
  const body = await response.json().catch(() => undefined);
  if (!response.ok)
    throw new ProposalRequestError(
      body?.error ?? "No se pudo completar la solicitud.",
      response.status,
    );
  return body as T;
}
