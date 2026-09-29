import { z } from "zod";

export const contactInputSchema = z
  .object({
    legalName: z.string().trim().min(1).max(240),
    tradeName: z.string().trim().max(240).optional(),
    taxId: z.string().trim().max(40).optional(),
    taxCountry: z.string().trim().regex(/^[A-Za-z]{2}$/).transform((country) => country.toUpperCase()),
    email: z.union([z.email(), z.literal("")]).optional(),
    phone: z.string().trim().max(40).optional(),
    paymentTermsDays: z.number().int().min(0).max(365).optional(),
    paymentMethod: z
      .enum(["BANK_TRANSFER", "DIRECT_DEBIT", "CASH", "CARD", "OTHER"])
      .optional(),
    isCustomer: z.boolean(),
    isSupplier: z.boolean(),
  })
  .refine(({ isCustomer, isSupplier }) => isCustomer || isSupplier, {
    message: "A contact must be a customer, a supplier, or both",
  });

export type ContactInput = z.infer<typeof contactInputSchema>;

export interface Contact {
  id: string;
  legalName: string;
  tradeName: string | null;
  taxId: string | null;
  taxCountry: string;
  email: string | null;
  phone: string | null;
  paymentTermsDays: number;
  paymentMethod: string;
  isCustomer: boolean;
  isSupplier: boolean;
}

export interface ContactPage {
  data: Contact[];
  nextCursor: string | null;
}

export function contactPayload(values: Record<string, FormDataEntryValue>) {
  const optional = (name: string) => {
    const value = String(values[name] ?? "").trim();
    return value || undefined;
  };
  return {
    legalName: String(values.legalName ?? "").trim(),
    tradeName: optional("tradeName"),
    taxId: optional("taxId"),
    taxCountry: String(values.taxCountry ?? "ES").trim().toUpperCase(),
    email: optional("email"),
    phone: optional("phone"),
    paymentTermsDays: Number(values.paymentTermsDays ?? 0),
    paymentMethod: String(values.paymentMethod ?? "BANK_TRANSFER"),
    isCustomer: values.isCustomer === "on",
    isSupplier: values.isSupplier === "on",
  };
}
