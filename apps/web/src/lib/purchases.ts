import { z } from "zod";
import type { InvoiceTrace, Payment, PaymentInput } from "./invoices";

export const purchaseInputSchema = z.object({
  supplierId: z.uuid(),
  supplierInvoiceNumber: z.string().trim().min(1).max(100),
  issueDate: z.iso.date(),
  receivedDate: z.iso.date(),
  dueDate: z.union([z.iso.date(), z.literal("")]).optional(),
  currency: z.literal("EUR"),
  notes: z.string().trim().max(5_000).optional(),
  withholdingRate: z.number().min(0).max(100).multipleOf(0.01).optional(),
  lines: z
    .array(
      z.object({
        description: z.string().trim().min(1).max(2_000),
        quantity: z.number().positive().multipleOf(0.001),
        unitPrice: z.number().min(0).multipleOf(0.01),
        discountPct: z.number().min(0).max(100).multipleOf(0.01),
        taxRate: z.union([z.literal(21), z.literal(10), z.literal(4), z.literal(0)]),
        isDisbursement: z.boolean().optional(),
        isEuServiceReverseCharge: z.boolean().optional(),
        expenseAccountCode: z.enum(["600000", "623000", "629000"]).optional(),
        deductiblePct: z.number().min(0).max(100).multipleOf(0.01),
      }).refine((line) => line.isDisbursement ? line.taxRate === 0 && line.deductiblePct === 0 && !line.isEuServiceReverseCharge
        : line.isEuServiceReverseCharge ? line.taxRate === 21 && (line.expenseAccountCode === undefined || line.expenseAccountCode === "629000")
        : line.taxRate !== 0,
        "Comprueba el tipo fiscal y la cuenta de gasto de la línea"),
    )
    .min(1)
    .max(200),
});

export type PurchaseInput = z.infer<typeof purchaseInputSchema>;

export interface Purchase {
  id: string;
  supplierId: string;
  draftCode: string;
  supplierInvoiceNumber: string;
  receptionFullNumber: string | null;
  status: "DRAFT" | "PENDING_APPROVAL" | "APPROVED" | "CANCELLED";
  supplierLegalName: string;
  supplierTaxId: string | null;
  issueDate: string;
  receivedDate: string;
  dueDate: string | null;
  currency: string;
  subtotal: string;
  discountTotal: string;
  taxTotal: string;
  deductibleTaxTotal: string;
  total: string;
  withholdingRate: string;
  withholdingAmount: string;
  amountPaid: string;
  amountDue: string;
  notes: string | null;
  approvedAt: string | null;
  requiredApprovals: number;
  approvalCount: number;
  lines?: Array<{
    id: string;
    description: string;
    quantity: string;
    unitPrice: string;
    discountPct: string;
    isDisbursement: boolean;
    expenseAccountCode: "600000" | "623000" | "629000";
    netAmount: string;
    taxAmount: string;
    totalAmount: string;
    taxLines: Array<{ taxRate: string | null; deductiblePct: string; taxCode: string; reverseCharge: boolean; taxAmount: string }>;
  }>;
  approvals?: Array<{
    id: string;
    position: number;
    approvedAt: string;
    approvedBy: { id: string; email: string };
  }>;
}

export interface PurchasePage {
  data: Purchase[];
  nextCursor: string | null;
}

export interface PurchaseWithholdingSummary {
  year: number;
  basis: "paidAt";
  quarters: Array<{ quarter: number; payments: number; base: string; withheld: string }>;
  annualBySupplier: Array<{ supplierTaxId: string; supplierLegalName: string; payments: number; base: string; withheld: string }>;
  payments: Array<{
    paymentId: string;
    paidAt: string;
    supplierTaxId: string;
    supplierLegalName: string;
    supplierInvoiceNumber: string;
    rate: string;
    base: string;
    withheld: string;
    quarter: number;
  }>;
}

export type SupplierPayment = Payment;
export type SupplierPaymentInput = PaymentInput;
export type PurchaseTrace = InvoiceTrace;

export interface PurchaseAttachment {
  id: string;
  purchaseInvoiceId: string;
  originalName: string;
  mediaType: "application/pdf" | "image/png" | "image/jpeg";
  sizeBytes: number;
  sha256: string;
  createdAt: string;
}

export type PurchaseOcrStatus =
  "PENDING" | "PROCESSING" | "REVIEW_REQUIRED" | "REVIEWED" | "FAILED";

export interface PurchaseOcrJob {
  id: string;
  purchaseInvoiceId: string;
  attachmentId: string;
  status: PurchaseOcrStatus;
  engine: string;
  engineVersion: string;
  overallConfidence: string | null;
  attempts: number;
  lastError: string | null;
  rawText?: string | null;
  extractedFields?: Record<
    string,
    { value: string; confidence: number; evidence: string }
  > | null;
  reviewFields?: {
    fields: Record<string, string | null>;
    notes: string;
  } | null;
  reviewedAt: string | null;
  attachment?: Pick<PurchaseAttachment, "id" | "originalName" | "mediaType">;
}

export function purchaseStatusLabel(status: Purchase["status"]) {
  return {
    DRAFT: "Borrador",
    PENDING_APPROVAL: "Pendiente de aprobación",
    APPROVED: "Aprobada",
    CANCELLED: "Anulada",
  }[status];
}

export function approvalKey(purchaseId: string, existing?: string | null) {
  return existing ?? `approve-${purchaseId}-${crypto.randomUUID()}`;
}

export function supplierPaymentKey(
  purchaseId: string,
  existing?: string | null,
) {
  return existing ?? `supplier-payment-${purchaseId}-${crypto.randomUUID()}`;
}
