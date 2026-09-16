import { z } from "zod";

export const quoteLineInputSchema = z.object({
  catalogItemId: z.uuid().optional(),
  description: z.string().trim().min(1).max(2_000),
  quantity: z.number().positive().multipleOf(0.001),
  unitPrice: z.number().min(0).multipleOf(0.01),
  discountPct: z.number().min(0).max(100).multipleOf(0.01).optional(),
  taxRate: z.union([z.literal(21), z.literal(10), z.literal(4)]),
});

export const quoteInputSchema = z.object({
  sequenceId: z.uuid().optional(),
  newSeries: z
    .string()
    .trim()
    .min(1)
    .max(30)
    .regex(/^[A-Za-z0-9][A-Za-z0-9._/-]*$/)
    .optional(),
  contactId: z.uuid(),
  issueDate: z.iso.date(),
  validUntil: z.union([z.iso.date(), z.literal("")]).optional(),
  currency: z.literal("EUR"),
  notes: z.string().trim().max(5_000).optional(),
  lines: z.array(quoteLineInputSchema).min(1).max(200),
});

export type QuoteInput = z.infer<typeof quoteInputSchema>;

export const quoteEmailInputSchema = z.object({
  recipient: z.string().trim().email().max(320),
  subject: z.string().trim().min(1).max(300).optional(),
});
export type QuoteEmailInput = z.infer<typeof quoteEmailInputSchema>;
export interface QuoteEmailDelivery {
  id: string;
  idempotencyKey: string;
  recipient: string;
  subject: string;
  status: "PENDING" | "PROCESSING" | "SENT" | "FAILED";
  attempts: number;
  sentAt: string | null;
  lastError: string | null;
  createdAt: string;
  updatedAt: string;
}
export interface QuoteEmailCapability { enabled: boolean }
export function quoteEmailKey(quoteId: string, existing?: string | null) {
  return existing ?? `quote-email:${quoteId}:${crypto.randomUUID()}`;
}

export const quoteStatuses = [
  "DRAFT",
  "SENT",
  "ACCEPTED",
  "REJECTED",
  "EXPIRED",
  "CANCELLED",
  "CONVERTED",
] as const;

export type QuoteStatus = (typeof quoteStatuses)[number];

export interface Quote {
  id: string;
  contactId: string;
  code: string;
  sequenceId: string | null;
  series: string | null;
  number: string | null;
  status: QuoteStatus;
  customerLegalName: string;
  customerTaxId: string | null;
  customerEmail: string | null;
  issueDate: string;
  validUntil: string | null;
  currency: string;
  subtotal: string;
  discountTotal: string;
  taxTotal: string;
  total: string;
  notes: string | null;
  convertedInvoice: {
    id: string;
    draftCode: string;
    status: string;
  } | null;
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

export interface QuotePage {
  data: Quote[];
  nextCursor: string | null;
}

export function quoteStatusLabel(status: QuoteStatus) {
  return {
    DRAFT: "Borrador",
    SENT: "Enviado",
    ACCEPTED: "Aceptado",
    REJECTED: "Rechazado",
    EXPIRED: "Caducado",
    CANCELLED: "Cancelado",
    CONVERTED: "Convertido",
  }[status];
}

export function quoteCode(code: string) {
  const isUuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(code);
  const isCuid = /^c[a-z0-9]{20,}$/i.test(code);
  if (!isUuid && !isCuid) return code;
  return `PRE-${code.slice(-8).toUpperCase()}`;
}

export function defaultQuoteExpiry(issueDate: string) {
  const date = new Date(`${issueDate}T12:00:00Z`);
  date.setUTCDate(date.getUTCDate() + 30);
  return date.toISOString().slice(0, 10);
}
