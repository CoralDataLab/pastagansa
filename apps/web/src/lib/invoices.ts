import { z } from "zod";

export const invoiceLineInputSchema = z.object({
  catalogItemId: z.uuid().optional(),
  description: z.string().trim().min(1).max(2_000),
  quantity: z.number().positive().multipleOf(0.001),
  unitPrice: z.number().min(0).multipleOf(0.01),
  discountPct: z.number().min(0).max(100).multipleOf(0.01).optional(),
  taxRate: z.union([z.literal(21), z.literal(10), z.literal(4)]),
});

export const invoiceInputSchema = z.object({
  contactId: z.uuid(),
  issueDate: z.iso.date(),
  operationDate: z.union([z.iso.date(), z.literal("")]).optional(),
  dueDate: z.union([z.iso.date(), z.literal("")]).optional(),
  currency: z.literal("EUR"),
  notes: z.string().trim().max(5_000).optional(),
  lines: z.array(invoiceLineInputSchema).min(1).max(200),
});

export type InvoiceInput = z.infer<typeof invoiceInputSchema>;

export interface Invoice {
  id: string;
  contactId: string;
  draftCode: string;
  fullNumber: string | null;
  status:
    | "DRAFT"
    | "ISSUED"
    | "SENT"
    | "PARTIALLY_PAID"
    | "PAID"
    | "SETTLED"
    | "OVERDUE"
    | "CANCELLED"
    | "RECTIFIED";
  documentType: "INVOICE" | "CREDIT_NOTE";
  sifMode: "DISABLED" | "NO_VERIFACTU" | "VERIFACTU";
  aeatEnvironment: "TEST" | "PRODUCTION";
  sifInvoiceType: "F1" | "R1" | "R2" | "R3" | "R4" | "R5";
  rectificationKind: "TOTAL" | "PARTIAL" | "DIFFERENCE" | null;
  rectificationImpact: "DECREASE" | "INCREASE" | null;
  rectificationReason: string | null;
  vatRecoveryReview?: {
    legalBasis: string;
    legalEventDate: string;
    legalEventReference: string;
    claimEvidenceReference?: string;
    reviewedAt: string;
    reviewedByUserId: string;
    originalTaxAmount: string;
    originalUnpaidAmount: string;
    recoveredTaxAmount: string;
    customerDeliveryStatus: "NOT_RECORDED";
    baseModificationCommunicationStatus: "NOT_RECORDED";
  } | null;
  originalInvoiceId: string | null;
  originalInvoice?: { id: string; fullNumber: string | null } | null;
  sourceQuote?: { id: string; code: string } | null;
  customerLegalName: string;
  customerTaxId: string | null;
  customerEmail: string | null;
  issueDate: string;
  operationDate: string | null;
  dueDate: string | null;
  currency: string;
  subtotal: string;
  discountTotal: string;
  taxTotal: string;
  total: string;
  amountPaid: string;
  creditedAmount: string;
  amountDue: string;
  notes: string | null;
  issuedAt: string | null;
  cancelledAt: string | null;
  cancellationReason: string | null;
  lines?: Array<{
    id: string;
    catalogItemId: string | null;
    description: string;
    quantity: string;
    unitPrice: string;
    discountPct: string;
    taxRate: string;
    netAmount: string;
    taxAmount: string;
    totalAmount: string;
  }>;
}

export const rectificationInputSchema = z.object({
  sifInvoiceType: z.enum(["R1", "R2", "R3", "R4"]),
  reason: z.string().trim().min(5).max(1_000),
  issueDate: z.iso.date(),
  dueDate: z.union([z.iso.date(), z.literal("")]).optional(),
  notes: z.string().trim().max(5_000).optional(),
});

export type RectificationInput = z.infer<typeof rectificationInputSchema>;

export const vatRecoveryReviewSchema = z.object({
  fiscalReviewConfirmed: z.literal(true),
  exclusionsReviewed: z.literal(true),
  legalEventDate: z.iso.date(),
  legalEventReference: z.string().trim().min(5).max(500),
  claimEvidenceReference: z.string().trim().min(5).max(500).optional(),
});

export type VatRecoveryReviewInput = z.infer<typeof vatRecoveryReviewSchema>;

export function sifInvoiceTypeLabel(type: Invoice["sifInvoiceType"]) {
  return {
    F1: "Factura completa",
    R1: "Error jurídico, devolución, descuento o cambio de precio",
    R2: "Concurso de acreedores",
    R3: "Crédito incobrable",
    R4: "Otra causa o dato no monetario",
    R5: "Rectificación de factura simplificada",
  }[type];
}

export const invoiceEmailInputSchema = z.object({
  recipient: z.email().max(320),
  subject: z.string().trim().min(1).max(300),
});

export type InvoiceEmailInput = z.infer<typeof invoiceEmailInputSchema>;

export interface InvoiceEmailDelivery {
  id: string;
  idempotencyKey: string;
  purpose?: "DOCUMENT_DELIVERY" | "PAYMENT_REMINDER";
  recipient: string;
  subject: string;
  status: "PENDING" | "PROCESSING" | "SENT" | "FAILED";
  attempts: number;
  sentAt: string | null;
  lastError: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface InvoiceEmailCapability {
  enabled: boolean;
}

export interface DocumentSequence {
  id: string;
  documentType: "INVOICE" | "CREDIT_NOTE" | "PURCHASE_INVOICE" | "QUOTE";
  series: string;
  nextNumber: string;
  padding: number;
  active: boolean;
}

export const paymentInputSchema = z.object({
  amount: z.number().positive().multipleOf(0.01),
  paidAt: z.iso.date(),
  method: z.enum(["BANK_TRANSFER", "DIRECT_DEBIT", "CASH", "CARD", "OTHER"]),
  reference: z.string().trim().max(240).optional(),
  notes: z.string().trim().max(1_000).optional(),
});

export type PaymentInput = z.infer<typeof paymentInputSchema>;

export interface Payment {
  id: string;
  amount: string;
  currency: string;
  paidAt: string;
  method: PaymentInput["method"];
  reference: string | null;
  notes: string | null;
  allocations: Array<{ id: string; amount: string }>;
}

export interface PaymentInstallment {
  id: string;
  position: number;
  dueDate: string;
  amount: string;
  paidAmount: string;
  creditedAmount: string;
  status: "PENDING" | "PARTIALLY_PAID" | "PAID";
}

export interface InvoiceTrace {
  taxCancellationEntry: InvoiceTrace["taxEntry"];
  journalReversalEntry: InvoiceTrace["journalEntry"];
  journalEntry: null | {
    id: string;
    entryNumber: string;
    entryDate: string;
    description: string;
    status: string;
    lines: Array<{
      id: string;
      debit: string;
      credit: string;
      account: { code: string; name: string };
    }>;
  };
  taxEntry: null | {
    id: string;
    documentNumber: string;
    taxPointDate: string;
    status: string;
    amounts: Array<{
      id: string;
      taxableBase: string;
      rate: string | null;
      taxAmount: string;
    }>;
  };
  sifRecord: null | {
    id: string;
    recordType: "REGISTRATION" | "CANCELLATION" | "SUBSANATION";
    chainPosition: string;
    invoiceType: string;
    generatedAt: string;
    previousRecordHash: string | null;
    recordHash: string;
    hashAlgorithm: string;
    specificationVersion: string;
  };
  sifRecords: Array<{
    id: string;
    recordType: "REGISTRATION" | "CANCELLATION" | "SUBSANATION";
    chainPosition: string;
    invoiceType: string;
    generatedAt: string;
    previousRecordHash: string | null;
    recordHash: string;
    hashAlgorithm: string;
    specificationVersion: string;
  }>;
  aeatSubmissions: Array<{
    recordId: string;
    submissions: Array<{
      id: string;
      status:
        | "PENDING"
        | "SENDING"
        | "RETRY"
        | "ACCEPTED"
        | "ACCEPTED_WITH_ERRORS"
        | "REJECTED"
        | "FAILED"
        | "UNKNOWN";
      attempts: number;
      recordStatus: string | null;
      csv: string | null;
      errorCode: string | null;
      errorDescription: string | null;
      lastError: string | null;
    }>;
  }>;
  sifVerification: {
    valid: boolean;
    recordsChecked: number;
    firstInvalid: {
      id: string;
      chainPosition: string;
      reason: string;
    } | null;
  };
}

export interface InvoicePage {
  data: Invoice[];
  nextCursor: string | null;
}

export function todayIso(now = new Date()) {
  const year = now.getFullYear();
  const month = String(now.getMonth() + 1).padStart(2, "0");
  const day = String(now.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

export function formatInvoiceDate(value: string | null) {
  if (!value) return "—";
  return new Intl.DateTimeFormat("es-ES", { timeZone: "UTC" }).format(
    new Date(value),
  );
}

export function invoiceStatusLabel(status: Invoice["status"]) {
  return {
    DRAFT: "Borrador",
    ISSUED: "Emitida",
    SENT: "Enviada",
    PARTIALLY_PAID: "Cobro parcial",
    PAID: "Cobrada",
    SETTLED: "Saldada",
    OVERDUE: "Vencida",
    CANCELLED: "Anulada",
    RECTIFIED: "Rectificada",
  }[status];
}

export function invoiceIssueKey(invoiceId: string, existing?: string | null) {
  if (existing) return existing;
  return `issue-${invoiceId}-${crypto.randomUUID()}`;
}

export function invoiceEmailKey(invoiceId: string, existing?: string | null) {
  if (existing) return existing;
  return `email-${invoiceId}-${crypto.randomUUID()}`;
}

export function paymentKey(invoiceId: string, existing?: string | null) {
  if (existing) return existing;
  return `payment-${invoiceId}-${crypto.randomUUID()}`;
}

export function paymentMethodLabel(method: PaymentInput["method"]) {
  return {
    BANK_TRANSFER: "Transferencia",
    DIRECT_DEBIT: "Domiciliación",
    CASH: "Efectivo",
    CARD: "Tarjeta",
    OTHER: "Otro",
  }[method];
}
