export function vatRecoveryDescription(type: string): string {
  if (type === "R2") return "Ajuste de cuota IVA por concurso de acreedores";
  if (type === "R3") return "Ajuste de cuota IVA por crédito incobrable";
  throw new Error(`Unsupported VAT recovery invoice type: ${type}`);
}
