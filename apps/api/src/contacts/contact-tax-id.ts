import { isSpanishTaxId } from "../common/validation";

// This checks syntax only for non-Spanish IDs. It does not confirm VAT registration
// in VIES or entitlement to an intra-community VAT treatment.
export function validContactTaxId(taxId: string | null | undefined, taxCountry: string): boolean {
  if (!taxId) return true;
  const id = taxId.trim().toUpperCase();
  const country = taxCountry.toUpperCase();
  if (country === "ES") return isSpanishTaxId(id);
  return /^[A-Z0-9][A-Z0-9 .\-/]{1,39}$/.test(id) && id.replace(/[^A-Z0-9]/g, "").length >= 3;
}
