import { z } from "zod";

export const manualEntrySchema = z.object({
  entryDate: z.iso.date(),
  description: z.string().trim().min(1).max(1000),
  lines: z.array(z.object({
    accountId: z.uuid(),
    debit: z.number().finite().min(0).multipleOf(0.01),
    credit: z.number().finite().min(0).multipleOf(0.01),
  })).min(2).max(500),
}).superRefine((entry, context) => {
  let debit = 0;
  let credit = 0;
  entry.lines.forEach((line, index) => {
    if ((line.debit > 0) === (line.credit > 0))
      context.addIssue({ code: "custom", path: ["lines", index], message: "Cada línea necesita un debe o un haber, no ambos" });
    debit += Math.round(line.debit * 100);
    credit += Math.round(line.credit * 100);
  });
  if (debit === 0 || debit !== credit)
    context.addIssue({ code: "custom", path: ["lines"], message: "El debe y el haber deben cuadrar y ser mayores que cero" });
});

export type ManualEntryInput = z.infer<typeof manualEntrySchema>;

// Accept either decimal separator and an optional euro sign, but never guess
// whether a separator is a thousands separator.
export function journalMoneyCents(input: string): number | null {
  if (!input.trim()) return 0;
  const match = /^\s*(\d{1,9})(?:[,.](\d{1,2}))?\s*€?\s*$/.exec(input);
  if (!match) return null;
  return Number(match[1]) * 100 + Number((match[2] ?? "").padEnd(2, "0"));
}

export interface Account {
  id: string;
  code: string;
  name: string;
  accountClass: string;
  isReconcilable: boolean;
  active: boolean;
}

export interface JournalEntry {
  id: string;
  entryNumber: string;
  entryDate: string;
  sourceType: string;
  description: string;
  lines: Array<{
    id: string;
    debit: string;
    credit: string;
    account: Account;
  }>;
}

export interface JournalPage {
  data: JournalEntry[];
  nextCursor: string | null;
}

export interface GeneralLedger {
  account: Account;
  from: string;
  to: string;
  openingBalance: string;
  totalDebit: string;
  totalCredit: string;
  closingBalance: string;
  lines: Array<{
    id: string;
    entryNumber: string;
    entryDate: string;
    description: string;
    debit: string;
    credit: string;
    runningBalance: string;
  }>;
}

export function journalSourceLabel(source: string) {
  return (
    (
      {
        SALES_INVOICE: "Venta",
        PURCHASE_INVOICE: "Compra",
        PAYMENT: "Cobro",
        CUSTOMER_PAYMENT: "Cobro",
        SUPPLIER_PAYMENT: "Pago",
        MANUAL: "Manual",
        REVERSAL: "Reversión",
      } as Record<string, string>
    )[source] ?? source
  );
}

export function accountingDescription(description: string) {
  const translations: Array<[RegExp, string]> = [
    [/^Sales invoice\b/i, "Factura de venta"],
    [/^Purchase invoice\b/i, "Factura de compra"],
    [/^Customer receipt\b/i, "Cobro de cliente"],
    [/^Supplier payment\b/i, "Pago a proveedor"],
    [/^Reversal:\s*/i, "Reversión: "],
  ];
  for (const [pattern, replacement] of translations)
    if (pattern.test(description))
      return description.replace(pattern, replacement);
  return description;
}
