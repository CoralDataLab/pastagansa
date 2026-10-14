import { describe, expect, it } from "vitest";
import {
  bankAccountInputSchema,
  bankImportInputSchema,
  maskedIban,
  reconcileInputSchema,
  statementImportNotice,
  translateStatementError,
} from "./banking";

describe("banking helpers", () => {
  it("validates bank setup and normalized imports", () => {
    expect(
      bankAccountInputSchema.parse({
        accountId: "11111111-1111-4111-8111-111111111111",
        name: " Cuenta operativa ",
        iban: "ES91 2100 0418 4502 0005 1332",
        currency: "EUR",
      }).name,
    ).toBe("Cuenta operativa");
    expect(
      bankImportInputSchema.safeParse({
        bankAccountId: "11111111-1111-4111-8111-111111111111",
        transactions: [
          {
            externalId: "MOV-1",
            bookingDate: "2026-09-09",
            amount: -121,
            description: "Pago proveedor",
          },
        ],
      }).success,
    ).toBe(true);
  });

  it("rejects zero movements and invalid reconciliation identifiers", () => {
    expect(
      bankImportInputSchema.safeParse({
        bankAccountId: "11111111-1111-4111-8111-111111111111",
        transactions: [
          {
            externalId: "MOV-1",
            bookingDate: "2026-09-09",
            amount: 0,
            description: "Movimiento inválido",
          },
        ],
      }).success,
    ).toBe(false);
    expect(
      reconcileInputSchema.safeParse({ journalLineId: "no" }).success,
    ).toBe(false);
  });

  it("masks the middle of an IBAN", () => {
    expect(maskedIban("ES9121000418450200051332")).toBe("ES91 ···· 1332");
    expect(maskedIban(null)).toBe("Sin IBAN");
  });

  it("summarizes a statement import", () => {
    const result = { fileSha256: "", accounts: [] };
    expect(statementImportNotice({ ...result, imported: 1, duplicates: 0, skipped: 0 })).toBe(
      "1 movimiento importado.",
    );
    expect(statementImportNotice({ ...result, imported: 0, duplicates: 3, skipped: 1 })).toBe(
      "0 movimientos importados · 3 ya estaban importados · 1 omitido por importe cero.",
    );
  });

  it("explains Norma 43 errors in Spanish with their line", () => {
    expect(
      translateStatementError("Invalid Norma 43 file. Line 12: The debit total does not match record 33"),
    ).toBe("El fichero no es un Norma 43 válido (línea 12). El total de cargos no coincide con el registro 33.");
    expect(
      translateStatementError("Invalid Norma 43 file. Line 3: The value date is not a valid YYMMDD date"),
    ).toBe("El fichero no es un Norma 43 válido (línea 3). La fecha valor no es una fecha AAMMDD válida.");
    expect(translateStatementError("Invalid Norma 43 file. The file contains no account blocks")).toBe(
      "El fichero no es un Norma 43 válido. El fichero no contiene ninguna cuenta.",
    );
    expect(
      translateStatementError("Statement account ES9121000418450200059999 is not linked to an active bank account"),
    ).toMatch(/^La cuenta ES9121000418450200059999 del extracto no está vinculada/);
    expect(translateStatementError("The statement file differs from the previewed one")).toBe(
      "El fichero ha cambiado desde la vista previa. Revísalo de nuevo.",
    );
    expect(translateStatementError("Something else")).toBe("Something else");
  });
});
